"""Шина событий: NATS JetStream в dev/test/prod и in-memory реализация для unit-тестов.

Гарантии:
- публикация с заголовком Nats-Msg-Id = event_id → JetStream отбрасывает дубли в окне duplicate_window;
- durable pull consumer, явный ack; при ошибке — nak с экспоненциальной задержкой;
- после max_deliver доставок сообщение уходит в DLQ и подтверждается.

Спринт 8 (docs/sprint8/INTERNAL_API.md §3.1):
- DLQ — отдельный стрим `TILHERO_DLQ` (subjects `tilherodlq.>`, 30 дней, ≤ 200 000 сообщений, discard old).
  Тело сообщения DLQ — **исходные байты** доставленного сообщения (конверт байт в байт), причина и счётчики — в
  заголовках `x-dlq-*` (без текстов ошибок: только класс). Прежние `tilhero.dlq.*` в стриме `TILHERO` (тело — JSON
  `{consumer, attempts, envelope}`) не переносятся: ops-monitor читает оба источника.
- Адресный повтор: у каждого durable в `filter_subjects` есть `tilhero.replay.<durable>` — сообщение, опубликованное
  туда (ops-monitor), получает только этот консьюмер; `event_id` прежний, inbox отбрасывает уже обработанное.
  Обновить фильтр существующего консьюмера не удалось (NATS < 2.10) — WARNING `replay_subject_unavailable`, консьюмер
  работает без адресного повтора (`replay_enabled[durable] = False`).
"""

from __future__ import annotations

import asyncio
import contextlib
import fnmatch
import logging
import re
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol

from tilhero_common import context
from tilhero_common.errors import TransientError
from tilhero_common.messaging.envelope import SUBJECT_PREFIX, Envelope

log = logging.getLogger("tilhero.bus")

Handler = Callable[[Envelope], Awaitable[None]]


@dataclass
class ConsumerSpec:
    """Подписка сервиса. `durable` уникален в системе: `<service>.<purpose>`."""

    durable: str
    event_types: list[str]
    handler: Handler
    # None — из настройки сервиса NATS_MAX_DELIVER (Runtime._subscribe_all); без Runtime — DEFAULT_MAX_DELIVER
    max_deliver: int | None = None
    ack_wait_seconds: float = 30.0
    batch: int = 10
    subjects: list[str] = field(init=False)

    def __post_init__(self) -> None:
        self.subjects = [f"{SUBJECT_PREFIX}.{t}" for t in self.event_types]


DEFAULT_MAX_DELIVER = 10
# TransientError: повтор без DLQ, но не вечно — после ~суток (288 доставок с задержкой до 5 мин) сообщение уходит в
# DLQ с ошибкой в логе: забытая настройка (например, адрес зависимости) не должна копить неподтверждённые сообщения.
TRANSIENT_MAX_DELIVER = 288


def delivery_limit(spec: ConsumerSpec) -> int:
    return spec.max_deliver or DEFAULT_MAX_DELIVER


def backoff_seconds(attempt: int) -> float:
    return float(min(2 ** max(attempt - 1, 0), 300))


def transient_delay(attempt: int, exc: TransientError) -> float:
    """Задержка повтора после TransientError: backoff, но не раньше retry_after зависимости (≤ 1 ч)."""
    retry_after = getattr(exc, "retry_after", None) or 0
    return max(backoff_seconds(attempt), min(float(retry_after), 3600.0))


DLQ_STREAM = "TILHERO_DLQ"
DLQ_SUBJECT_PREFIX = "tilherodlq"  # не пересекается с `tilhero.>` основного стрима (другой первый токен)
DLQ_MAX_MSGS = 200_000
REPLAY_SUBJECT_PREFIX = f"{SUBJECT_PREFIX}.replay"
# заголовки сообщения DLQ (§3.1): только ID, классы и числа — без текста ошибки и payload
H_CONSUMER, H_EVENT_ID, H_EVENT_TYPE, H_ORIGINAL_SUBJECT = "x-dlq-consumer", "x-event-id", "x-event-type", \
    "x-original-subject"
H_REASON, H_DELIVERIES, H_AT, H_REPLAYS = "x-dlq-reason", "x-dlq-deliveries", "x-dlq-at", "x-dlq-replays"
_CLASS_RE = re.compile(r"[^A-Za-z0-9_.]")


def durable_token(durable: str) -> str:
    """Имя durable в NATS и в subject (точки нельзя: они разделяют токены subject)."""
    return durable.replace(".", "_")


def dlq_subject(durable: str) -> str:
    """Subject DLQ консьюмера в стриме `TILHERO_DLQ` (спринт 8)."""
    return f"{DLQ_SUBJECT_PREFIX}.{durable_token(durable)}"


def legacy_dlq_subject(durable: str) -> str:
    """Subject DLQ до спринта 8 (стрим `TILHERO`, 7 дней) — только для чтения старых сообщений."""
    return f"{SUBJECT_PREFIX}.dlq.{durable_token(durable)}"


def replay_subject(durable: str) -> str:
    """Адресный повтор: сообщение получает только этот консьюмер."""
    return f"{REPLAY_SUBJECT_PREFIX}.{durable_token(durable)}"


def dlq_reason(exc: BaseException | None = None, *, transient: bool = False, bad_envelope: bool = False) -> str:
    """Причина без текста: `handler_error:<ExceptionClass>` | `transient_exhausted` | `bad_envelope`."""
    if bad_envelope:
        return "bad_envelope"
    if transient:
        return "transient_exhausted"
    name = _CLASS_RE.sub("", type(exc).__name__ if exc is not None else "Exception")[:64] or "Exception"
    return f"handler_error:{name}"


class EventBus(Protocol):
    @property
    def is_connected(self) -> bool: ...

    async def connect(self) -> None: ...

    async def close(self) -> None: ...

    async def publish(self, envelope: Envelope) -> None: ...

    async def subscribe(self, spec: ConsumerSpec) -> None: ...


class NatsBus:
    def __init__(self, url: str, *, stream: str = "TILHERO", client_name: str = "tilhero",
                 dlq_stream: str = DLQ_STREAM, dlq_max_age_days: int = 30, dlq_max_msgs: int = DLQ_MAX_MSGS) -> None:
        self.url = url
        self.stream = stream
        self.client_name = client_name
        self.dlq_stream = dlq_stream
        self.dlq_max_age_days = dlq_max_age_days
        self.dlq_max_msgs = dlq_max_msgs
        # durable → есть ли адресный replay-subject в filter_subjects (ops-monitor: CONSUMER_REPLAY_UNAVAILABLE)
        self.replay_enabled: dict[str, bool] = {}
        self._nc: Any = None  # nats.aio.client.Client после connect()
        self._js: Any = None  # JetStreamContext
        self._tasks: list[asyncio.Task] = []
        self._subs: list = []
        self.heartbeats: dict[str, float] = {}
        self._closing = asyncio.Event()

    @property
    def is_connected(self) -> bool:
        return bool(self._nc and self._nc.is_connected)

    async def connect(self) -> None:
        import nats
        from nats.js.api import DiscardPolicy, StorageType, StreamConfig

        self._nc = await nats.connect(
            servers=[self.url], name=self.client_name, max_reconnect_attempts=-1, reconnect_time_wait=1
        )
        self._js = self._nc.jetstream()
        config = StreamConfig(
            name=self.stream,
            subjects=[f"{SUBJECT_PREFIX}.>"],
            storage=StorageType.FILE,
            duplicate_window=120.0,
            max_age=7 * 24 * 3600.0,
        )
        try:
            await self._js.add_stream(config)
        except Exception:  # поток уже есть — приводим конфиг к ожидаемому
            with contextlib.suppress(Exception):
                await self._js.update_stream(config)
        # спринт 8: отдельный стрим DLQ (дольше основного — 30 дней, ограничен по числу сообщений)
        dlq = StreamConfig(
            name=self.dlq_stream,
            subjects=[f"{DLQ_SUBJECT_PREFIX}.>"],
            storage=StorageType.FILE,
            duplicate_window=120.0,
            max_age=self.dlq_max_age_days * 86_400.0,
            max_msgs=self.dlq_max_msgs,
            discard=DiscardPolicy.OLD,
        )
        try:
            await self._js.add_stream(dlq)
        except Exception:
            try:
                await self._js.update_stream(dlq)
            except Exception:
                log.warning("dlq stream unavailable", extra={"stream": self.dlq_stream}, exc_info=True)

    async def close(self) -> None:
        self._closing.set()
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        for sub in self._subs:
            with contextlib.suppress(Exception):
                await sub.unsubscribe()
        if self._nc:
            try:
                await asyncio.wait_for(self._nc.drain(), timeout=5.0)
            except Exception:
                with contextlib.suppress(Exception):
                    await self._nc.close()

    async def publish(self, envelope: Envelope) -> None:
        if not self._js:
            raise RuntimeError("bus is not connected")
        await self._js.publish(
            envelope.subject,
            envelope.to_json().encode(),
            headers={"Nats-Msg-Id": envelope.event_id, "x-trace-id": envelope.correlation_id},
        )

    async def publish_raw(self, subject: str, data: bytes, headers: dict[str, str] | None = None) -> None:
        if not self._js:
            raise RuntimeError("bus is not connected")
        await self._js.publish(subject, data, headers=headers)

    async def subscribe(self, spec: ConsumerSpec) -> None:
        from nats.js.api import AckPolicy, ConsumerConfig, DeliverPolicy

        assert self._js is not None
        def config_for(subjects: list[str]) -> ConsumerConfig:
            return ConsumerConfig(
                durable_name=durable_token(spec.durable),
                ack_policy=AckPolicy.EXPLICIT,
                deliver_policy=DeliverPolicy.ALL,
                ack_wait=spec.ack_wait_seconds,
                max_deliver=-1,  # предел считаем сами, чтобы успеть отправить в DLQ
                filter_subjects=subjects,
            )

        durable = durable_token(spec.durable)
        # спринт 8: + адресный replay-subject (смена filter_subjects существующего durable — NATS ≥ 2.10)
        # CONSUMER.CREATE существующего durable с другим конфигом — обновление на месте (NATS ≥ 2.10; у nats-py
        # нет отдельного update_consumer). Отказ → WARNING и прежние subjects: консьюмер работает без повтора.
        config = config_for([*spec.subjects, replay_subject(spec.durable)])
        replay = True
        try:
            await self._js.add_consumer(self.stream, config)
        except Exception as exc:
            replay = False
            log.warning("replay_subject_unavailable", extra={"consumer": spec.durable,
                                                             "error_type": type(exc).__name__})
            with contextlib.suppress(Exception):  # хотя бы прежние subjects (консьюмер мог не существовать)
                await self._js.add_consumer(self.stream, config_for(spec.subjects))
        if replay:  # честно: адресный повтор есть, только если subject действительно в фильтре консьюмера
            try:
                info = await self._js.consumer_info(self.stream, durable)
                replay = replay_subject(spec.durable) in (info.config.filter_subjects or [])
            except Exception:
                replay = False
            if not replay:
                log.warning("replay_subject_unavailable", extra={"consumer": spec.durable,
                                                                 "error_type": "FilterNotApplied"})
        self.replay_enabled[spec.durable] = replay
        psub = await self._js.pull_subscribe_bind(durable=durable, stream=self.stream)
        self._subs.append(psub)
        self._tasks.append(asyncio.create_task(self._supervise(spec, psub), name=f"consumer:{spec.durable}"))

    async def _supervise(self, spec: ConsumerSpec, psub) -> None:
        while not self._closing.is_set():
            try:
                await self._pull_loop(spec, psub)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.error("consumer loop crashed, restarting", extra={"consumer": spec.durable}, exc_info=True)
                await asyncio.sleep(1.0)

    def stale_consumers(self, max_age: float = 30.0) -> list[str]:
        now = time.monotonic()
        return [name for name, ts in self.heartbeats.items() if now - ts > max_age]

    async def _pull_loop(self, spec: ConsumerSpec, psub) -> None:
        import nats.errors

        while not self._closing.is_set():
            self.heartbeats[spec.durable] = time.monotonic()
            try:
                msgs = await psub.fetch(batch=spec.batch, timeout=1.0)
            except (TimeoutError, nats.errors.TimeoutError):
                continue
            except asyncio.CancelledError:
                raise
            except Exception:
                log.warning("fetch failed", extra={"consumer": spec.durable}, exc_info=True)
                await asyncio.sleep(1.0)
                continue
            for msg in msgs:
                try:
                    await self._handle(spec, msg)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    # ack/nak/DLQ не удались (например, переподключение NATS) — сообщение будет доставлено
                    # повторно после ack_wait; цикл потребителя продолжает работу.
                    log.warning("message handling infrastructure failed", extra={"consumer": spec.durable},
                                exc_info=True)
            self.heartbeats[spec.durable] = time.monotonic()

    async def _to_dlq(self, spec: ConsumerSpec, msg, envelope: Envelope | None, reason: str, attempt: int) -> None:
        """Сообщение — в DLQ: тело — исходные байты (конверт байт в байт), причина и счётчики — в заголовках.
        `Nats-Msg-Id` = `dlq:<durable>:<event_id>:<replays>`: повторная отправка того же сообщения (ack не дошёл)
        не создаёт дубль в DLQ, а сообщение после повтора (replays + 1) — новая запись."""
        incoming = getattr(msg, "headers", None) or {}
        try:
            replays = max(0, int(incoming.get(H_REPLAYS, 0)))
        except (TypeError, ValueError):
            replays = 0
        if envelope is not None:
            event_id, event_type, original = envelope.event_id, envelope.event_type, envelope.subject
            msg_id = f"dlq:{durable_token(spec.durable)}:{event_id}:{replays}"
        else:
            seq = getattr(getattr(getattr(msg, "metadata", None), "sequence", None), "stream", None)
            event_id, event_type, original = "", "", str(getattr(msg, "subject", ""))[:200]
            msg_id = f"dlq:{durable_token(spec.durable)}:bad:{seq if seq is not None else uuid.uuid4().hex}"
        headers = {
            H_CONSUMER: spec.durable, H_EVENT_ID: event_id, H_EVENT_TYPE: event_type, H_ORIGINAL_SUBJECT: original,
            H_REASON: reason, H_DELIVERIES: str(attempt),
            H_AT: datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            H_REPLAYS: str(replays), "Nats-Msg-Id": msg_id,
        }
        await self.publish_raw(dlq_subject(spec.durable), msg.data, headers=headers)

    async def _handle(self, spec: ConsumerSpec, msg) -> None:
        attempt = msg.metadata.num_delivered if msg.metadata else 1
        try:
            envelope = Envelope.model_validate_json(msg.data)
        except Exception:
            log.error("poison message: invalid envelope", extra={"consumer": spec.durable, "subject": msg.subject})
            await self._to_dlq(spec, msg, None, dlq_reason(bad_envelope=True), attempt)
            await msg.ack()
            return
        context.bind(trace_id=envelope.correlation_id, correlation_id=envelope.correlation_id,
                     causation_id=envelope.event_id)
        try:
            await spec.handler(envelope)
        except TransientError as exc:
            # зависимость недоступна: повтор без DLQ (данные не теряем), не чаще раза в 5 минут после разгона;
            # после TRANSIENT_MAX_DELIVER (~сутки) — DLQ, чтобы не копить неподтверждённые сообщения бесконечно
            if attempt >= TRANSIENT_MAX_DELIVER:
                log.error("handler transient failure for too long, sent to DLQ",
                          extra={"consumer": spec.durable, "event_type": envelope.event_type, "attempt": attempt,
                                 "error_type": type(exc).__name__})
                await self._to_dlq(spec, msg, envelope, dlq_reason(transient=True), attempt)
                await msg.ack()
                return
            log.warning("handler transient failure, will retry",
                        extra={"consumer": spec.durable, "event_type": envelope.event_type, "attempt": attempt,
                               "error_type": type(exc).__name__})
            await msg.nak(delay=transient_delay(attempt, exc))
            return
        except Exception as exc:
            if attempt >= delivery_limit(spec):
                log.error(
                    "handler failed, sent to DLQ",
                    extra={"consumer": spec.durable, "event_type": envelope.event_type, "attempt": attempt},
                    exc_info=True,
                )
                await self._to_dlq(spec, msg, envelope, dlq_reason(exc), attempt)
                await msg.ack()
            else:
                log.warning(
                    "handler failed, will retry",
                    extra={"consumer": spec.durable, "event_type": envelope.event_type, "attempt": attempt},
                    exc_info=True,
                )
                await msg.nak(delay=backoff_seconds(attempt))
            return
        await msg.ack()


class InMemoryBus:
    """Синхронная шина для unit-тестов: publish сразу вызывает подходящие обработчики."""

    def __init__(self) -> None:
        self.published: list[Envelope] = []
        self.specs: list[ConsumerSpec] = []
        self.dlq: list[tuple[str, Envelope]] = []
        self.transient: list[tuple[str, Envelope]] = []  # не обработаны из-за TransientError (не DLQ)
        self._connected = False

    @property
    def is_connected(self) -> bool:
        return self._connected

    async def connect(self) -> None:
        self._connected = True

    async def close(self) -> None:
        self._connected = False

    async def publish(self, envelope: Envelope) -> None:
        if any(e.event_id == envelope.event_id for e in self.published):
            return  # дедупликация как у JetStream
        self.published.append(envelope)
        for spec in self.specs:
            if any(fnmatch.fnmatchcase(envelope.subject, s.replace(">", "*")) for s in spec.subjects):
                limit = delivery_limit(spec)
                for attempt in range(1, limit + 1):
                    try:
                        await spec.handler(envelope)
                        break
                    except TransientError:
                        if attempt == limit:
                            self.transient.append((spec.durable, envelope))  # в NATS — повтор без DLQ
                    except Exception:
                        if attempt == limit:
                            self.dlq.append((spec.durable, envelope))

    async def subscribe(self, spec: ConsumerSpec) -> None:
        self.specs.append(spec)

    def of_type(self, event_type: str) -> list[Envelope]:
        return [e for e in self.published if e.event_type == event_type]
