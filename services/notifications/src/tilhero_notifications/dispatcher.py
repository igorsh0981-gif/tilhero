"""Планировщик доставки внутри сервиса (runtime.spawn): очередь, отложенные (тихие часы) и повторы.

Цикл не умирает от ошибок (как глобальный обработчик nbu-question-bot), но без его дефектов:
время только aware UTC, в журнал — тип ошибки без текста (там могут быть PII/SQL-параметры),
никаких Markdown-сообщений с текстом исключения.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import cast

from tilhero_common.app import Runtime
from tilhero_common.http_client import UpstreamError
from tilhero_notifications import store
from tilhero_notifications.delivery import get_delivery
from tilhero_notifications.policy import decide
from tilhero_notifications.settings import Settings
from tilhero_notifications.templates import TEMPLATES, TemplateError

log = logging.getLogger("tilhero.notifications.dispatcher")

# Ответы bot-gateway, которые не исправит повтор (наша ошибка формата/контракта)
PERMANENT_STATUSES = frozenset({400, 404, 405, 409, 413, 422})


class Dispatcher:
    def __init__(self, runtime: Runtime) -> None:
        self.rt = runtime
        self._wake = asyncio.Event()

    @property
    def settings(self) -> Settings:
        return cast(Settings, self.rt.settings)

    def wake(self) -> None:
        self._wake.set()

    async def run_forever(self) -> None:
        s = self.settings
        failures = 0
        while True:
            try:
                processed = await self.run_once()
                failures = 0
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                failures += 1
                processed = 0
                log.error(
                    "dispatcher iteration failed",
                    extra={"error_type": type(exc).__name__, "attempt": failures},
                )
            if processed >= s.dispatch_batch_size:
                continue  # очередь не пуста — сразу следующая пачка
            delay = s.dispatch_interval_seconds * min(2**failures, 30)
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._wake.wait(), timeout=delay)
            self._wake.clear()

    async def run_once(self, now: datetime | None = None) -> int:
        """Одна пачка: захват → политика → отправка → конечный статус. Возвращает число обработанных."""
        s = self.settings
        now = now or datetime.now(UTC)
        async with self.rt.transaction() as session:
            claimed = await store.claim_due(
                session, now=now, batch=s.dispatch_batch_size, lease_seconds=s.lease_seconds
            )
        if not claimed:
            return 0
        semaphore = asyncio.Semaphore(max(1, s.dispatch_concurrency))

        async def one(c: store.Claimed) -> None:
            async with semaphore:
                try:
                    await self._process(c, now)
                except Exception as exc:  # строка вернётся по истечении аренды
                    log.error(
                        "notification processing failed",
                        extra={"error_type": type(exc).__name__, "notification_id": str(c.notification_id)},
                    )

        await asyncio.gather(*(one(c) for c in claimed))
        return len(claimed)

    async def send_now(self, notification_id: uuid.UUID, now: datetime | None = None) -> None:
        """Немедленная отправка одного уведомления (транзакционные, POST …/transactional). Временная ошибка
        оставляет его в очереди с повтором по общему расписанию; конечный статус очищает params."""
        s = self.settings
        now = now or datetime.now(UTC)
        async with self.rt.transaction() as session:
            claimed = await store.claim_one(session, notification_id, now=now, lease_seconds=s.lease_seconds)
        if claimed is None:
            return
        try:
            await self._process(claimed, now)
        except Exception as exc:  # строка вернётся планировщику по истечении аренды
            log.error(
                "notification processing failed",
                extra={"error_type": type(exc).__name__, "notification_id": str(notification_id)},
            )

    def _retry_at(self, c: store.Claimed, now: datetime, retry_after: int | None = None) -> datetime:
        if retry_after:
            return now + timedelta(seconds=max(1, min(int(retry_after), 3600)))
        delays = self.settings.retry_delays_seconds or [60]
        return now + timedelta(seconds=delays[min(c.attempts, len(delays) - 1)])

    async def _retry_or_fail(
        self,
        c: store.Claimed,
        now: datetime,
        *,
        reason: str,
        event_reason: str,
        retry_after: int | None = None,
    ) -> None:
        producer = self.settings.service_name
        async with self.rt.transaction() as session:
            if c.attempts + 1 >= self.settings.max_attempts:
                await store.mark_failed(
                    session, c, reason=reason, event_reason=event_reason, now=now, producer=producer
                )
            else:
                await store.mark_retry(
                    session, c, at=self._retry_at(c, now, retry_after), reason=reason, now=now
                )

    async def _process(self, c: store.Claimed, now: datetime) -> None:
        s = self.settings
        producer = s.service_name
        spec = TEMPLATES.get(c.template)
        if spec is None:
            async with self.rt.transaction() as session:
                await store.mark_failed(
                    session,
                    c,
                    reason="template_unknown",
                    event_reason="error",
                    now=now,
                    producer=producer,
                    attempted=False,
                )
            return
        try:
            delivery = await get_delivery(
                self.rt, prefix=s.redis_key_prefix, ttl=s.delivery_cache_ttl_seconds, user_id=c.user_id
            )
        except Exception as exc:
            log.warning("delivery address unavailable", extra={"error_type": type(exc).__name__})
            await self._retry_or_fail(c, now, reason="identity_unavailable", event_reason="error")
            return
        if delivery is None:
            async with self.rt.transaction() as session:
                await store.mark_skipped(session, c, reason="user_not_found", now=now)
            return

        decision = decide(c.kind, spec, delivery, now, s.default_timezone)
        if decision.action == "skip":
            async with self.rt.transaction() as session:
                await store.mark_skipped(session, c, reason=decision.reason or "skipped", now=now)
            return
        if decision.action == "defer":
            assert decision.at is not None
            async with self.rt.transaction() as session:
                await store.mark_deferred(session, c, at=decision.at, now=now)
            return

        try:
            rendered = spec.render(delivery.locale, c.params, c.startapp)
        except TemplateError:
            async with self.rt.transaction() as session:
                await store.mark_failed(
                    session,
                    c,
                    reason="params_invalid",
                    event_reason="error",
                    now=now,
                    producer=producer,
                    attempted=False,
                )
            return

        body = {
            "telegram_user_id": delivery.telegram_user_id,
            "text": rendered.text,
            "buttons": rendered.buttons or None,
            "disable_notification": False,
            "idempotency_key": str(c.notification_id),
        }
        try:
            result = await self.rt.client("telegram-bot-gateway").post(
                "/internal/v1/messages", json=body, idempotency_key=str(c.notification_id)
            )
        except UpstreamError as exc:
            await self._on_send_error(c, now, exc)
            return
        except Exception as exc:
            log.warning("bot gateway call failed", extra={"error_type": type(exc).__name__})
            await self._retry_or_fail(c, now, reason="gateway_unavailable", event_reason="error")
            return
        async with self.rt.transaction() as session:
            await store.mark_sent(
                session, c, message_id=int(result["message_id"]), now=now, producer=producer
            )

    async def _on_send_error(self, c: store.Claimed, now: datetime, exc: UpstreamError) -> None:
        producer = self.settings.service_name
        details = exc.details or {}
        if exc.code == "TELEGRAM_BLOCKED":
            async with self.rt.transaction() as session:
                await store.mark_failed(
                    session, c, reason="blocked", event_reason="blocked", now=now, producer=producer
                )
            return
        if exc.code == "IDEMPOTENCY_IN_PROGRESS":
            # Предыдущая попытка с тем же notification_id ещё отправляется (истекла аренда) — проверим позже
            await self._retry_or_fail(c, now, reason="send_in_progress", event_reason="error", retry_after=30)
            return
        if exc.status == 429:
            await self._retry_or_fail(
                c,
                now,
                reason="rate_limited",
                event_reason="rate_limited",
                retry_after=details.get("retry_after"),
            )
            return
        if exc.code == "TELEGRAM_ERROR" and details.get("permanent"):
            chat = details.get("reason") == "chat_not_found"
            async with self.rt.transaction() as session:
                await store.mark_failed(
                    session,
                    c,
                    reason="invalid_chat" if chat else "telegram_rejected",
                    event_reason="invalid_chat" if chat else "error",
                    now=now,
                    producer=producer,
                )
            return
        if exc.status in PERMANENT_STATUSES:
            log.error(
                "bot gateway rejected notification", extra={"status": exc.status, "error_code": exc.code}
            )
            async with self.rt.transaction() as session:
                await store.mark_failed(
                    session, c, reason="gateway_rejected", event_reason="error", now=now, producer=producer
                )
            return
        # 502 TELEGRAM_ERROR (временная) — сбой Telegram; сеть/503/circuit open — недоступен сам bot-gateway
        reason = "telegram_unavailable" if exc.code == "TELEGRAM_ERROR" else "gateway_unavailable"
        await self._retry_or_fail(c, now, reason=reason, event_reason="error")
