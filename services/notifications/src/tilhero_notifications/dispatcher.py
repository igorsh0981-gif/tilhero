"""Обработка журнала (runtime.spawn + POST /internal/v1/notifications:dispatch): отрисовка для центра, политика
в момент отправки (domain/policy.py, порядок §4), лимит дня под блокировкой ученика, доставка через bot-gateway,
отложенные и повторы.

Цикл не умирает от ошибок; время только aware UTC; в журнал — тип ошибки без текста (там могут быть PII).
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import uuid
from collections import Counter
from datetime import UTC, datetime, timedelta
from typing import cast

from tilhero_common.app import Runtime
from tilhero_common.http_client import UpstreamError
from tilhero_notifications import store
from tilhero_notifications.delivery import DeliveryInfo, get_delivery, get_public
from tilhero_notifications.domain.policy import Item, Rules, decide, limit_applies, local_day, zone
from tilhero_notifications.settings import Settings
from tilhero_notifications.templates import TEMPLATES, Context, Rendered, TemplateError, TemplateSpec, clean_name

log = logging.getLogger("tilhero.notifications.dispatcher")

# Ответы bot-gateway, которые не исправит повтор (наша ошибка формата/контракта)
PERMANENT_STATUSES = frozenset({400, 404, 405, 409, 413, 422})
BASE_OF = {spec.kid_variant: name for name, spec in TEMPLATES.items() if spec.kid_variant}
NAME_STATUSES = frozenset({"ACTIVE", "DISABLED"})  # имя удаляемого/удалённого пользователя не показываем


class Dispatcher:
    def __init__(self, runtime: Runtime) -> None:
        self.rt = runtime
        self._wake = asyncio.Event()

    @property
    def settings(self) -> Settings:
        return cast(Settings, self.rt.settings)

    @property
    def rules(self) -> Rules:
        s = self.settings
        return Rules(default_tz=s.default_timezone, kid_window=(s.kid_window_start, s.kid_window_end))

    def wake(self) -> None:
        self._wake.set()

    async def run_forever(self) -> None:
        s = self.settings
        failures = 0
        while True:
            try:
                processed = sum((await self.run_once()).values())
                failures = 0
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                failures += 1
                processed = 0
                log.error(
                    "dispatcher iteration failed", extra={"error_type": type(exc).__name__, "attempt": failures}
                )
            if processed >= s.dispatch_batch_size:
                continue  # очередь не пуста — сразу следующая пачка
            delay = s.dispatch_interval_seconds * min(2**failures, 30)
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._wake.wait(), timeout=delay)
            self._wake.clear()

    async def run_once(self, now: datetime | None = None) -> Counter[str]:
        """Одна пачка: захват → отрисовка → политика → отправка → статус. → счётчики исходов
        (sent | scheduled | in_app_only | failed | skipped)."""
        s = self.settings
        now = now or datetime.now(UTC)
        async with self.rt.transaction() as session:
            claimed = await store.claim_due(
                session, now=now, batch=s.dispatch_batch_size, lease_seconds=s.lease_seconds
            )
        outcomes: Counter[str] = Counter()
        if not claimed:
            return outcomes
        semaphore = asyncio.Semaphore(max(1, s.dispatch_concurrency))

        async def one(c: store.Claimed) -> None:
            async with semaphore:
                try:
                    outcomes[await self._process(c, now)] += 1
                except Exception as exc:  # строка вернётся по истечении аренды
                    outcomes["scheduled"] += 1
                    log.error(
                        "notification processing failed",
                        extra={"error_type": type(exc).__name__, "notification_id": str(c.notification_id)},
                    )

        await asyncio.gather(*(one(c) for c in claimed))
        return outcomes

    async def send_now(self, notification_id: uuid.UUID, now: datetime | None = None) -> None:
        """Немедленная обработка одной записи (транзакционные, POST …/transactional). Временная ошибка оставляет её
        в очереди с повтором по общему расписанию; конечный статус очищает params."""
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

    # ---------------------------------------------------------------- обработка одной записи

    def _retry_at(self, c: store.Claimed, now: datetime, retry_after: int | None = None) -> datetime:
        if retry_after:
            return now + timedelta(seconds=max(1, min(int(retry_after), 3600)))
        delays = self.settings.retry_delays_seconds or (60,)
        return now + timedelta(seconds=delays[min(c.attempts, len(delays) - 1)])

    async def _retry_or_fail(
        self, c: store.Claimed, now: datetime, *, reason: str, event_reason: str, retry_after: int | None = None
    ) -> str:
        producer = self.settings.service_name
        async with self.rt.transaction() as session:
            if c.attempts + 1 >= self.settings.max_attempts:
                await store.mark_failed(
                    session, c, reason=reason, event_reason=event_reason, now=now, producer=producer
                )
                return "failed"
            await store.mark_retry(session, c, at=self._retry_at(c, now, retry_after), reason=reason, now=now)
            return "scheduled"

    async def _fail(self, c: store.Claimed, now: datetime, reason: str) -> str:
        async with self.rt.transaction() as session:
            await store.mark_failed(
                session,
                c,
                reason=reason,
                event_reason="error",
                now=now,
                producer=self.settings.service_name,
                attempted=False,
            )
        return "failed"

    async def _other_name(self, subject: uuid.UUID | None) -> str | None:
        """Имя другого пользователя для текста; удалённый/неизвестный — без имени. Сбой identity-consent — исключение
        (запись повторится)."""
        if subject is None:
            return None
        s = self.settings
        public = await get_public(self.rt, prefix=s.redis_key_prefix, ttl=s.delivery_cache_ttl_seconds, user_id=subject)
        if public is None or public.status not in NAME_STATUSES:
            return None
        return clean_name(public.display_name)

    async def _render(
        self, c: store.Claimed, delivery: DeliveryInfo
    ) -> tuple[TemplateSpec, Rendered]:
        base = BASE_OF.get(c.template, c.template)
        name = TEMPLATES[base].kid_variant if delivery.is_kid and TEMPLATES[base].kid_variant else base
        spec = TEMPLATES[name or base]
        ctx = Context(
            learner_name=clean_name(delivery.learner_display_name) if delivery.is_kid else None,
            other_name=await self._other_name(c.subject_user_id),
        )
        return spec, spec.render(delivery.locale, c.params, ctx)

    async def _process(self, c: store.Claimed, now: datetime) -> str:
        s = self.settings
        producer = s.service_name
        if c.template not in TEMPLATES:
            return await self._fail(c, now, "template_unknown")
        try:
            delivery = await get_delivery(
                self.rt, prefix=s.redis_key_prefix, ttl=s.delivery_cache_ttl_seconds, user_id=c.user_id
            )
        except Exception as exc:
            log.warning("delivery address unavailable", extra={"error_type": type(exc).__name__})
            return await self._retry_or_fail(c, now, reason="identity_unavailable", event_reason="error")
        if delivery is None:
            async with self.rt.transaction() as session:
                await store.mark_final(session, c, status="skipped", reason="user_not_found", now=now)
            return "skipped"
        try:
            spec, rendered = await self._render(c, delivery)
        except TemplateError:
            return await self._fail(c, now, "params_invalid")
        except Exception as exc:
            log.warning("public name unavailable", extra={"error_type": type(exc).__name__})
            return await self._retry_or_fail(c, now, reason="identity_unavailable", event_reason="error")

        item = Item(
            category=c.category,
            transactional=spec.transactional and c.kind == "transactional",
            gated=spec.gated,
            center_only=c.center_only,
            not_before=c.not_before,
            stale_after=c.stale_after,
        )
        decision = decide(item, delivery.recipient(), now, self.rules)
        async with self.rt.transaction() as session:
            await store.lock_user(session, c.user_id)
            if spec.in_app:
                await store.save_render(
                    session,
                    c.notification_id,
                    template=spec.name,
                    title=rendered.title,
                    body=rendered.body,
                    startapp=rendered.startapp,
                    now=now,
                )
            if decision.action == "skip":
                await store.mark_final(session, c, status="skipped", reason=decision.reason or "skipped", now=now)
                return "skipped"
            if decision.action == "in_app_only":
                status = "in_app_only" if spec.in_app else "skipped"
                await store.mark_final(session, c, status=status, reason=decision.reason or status, now=now)
                return status
            if decision.action == "defer":
                assert decision.at is not None
                await store.mark_deferred(session, c, at=decision.at, reason=decision.reason or "deferred", now=now)
                return "scheduled"
            # 5. лимит местных суток (reminders + missed + social); сама запись (повтор) не считается
            if limit_applies(c.category):
                day = local_day(now, zone(delivery.timezone, s.default_timezone))
                used = await store.count_limit(session, c.user_id, day, exclude=c.notification_id)
                if used >= s.daily_limit:
                    await store.mark_final(session, c, status="in_app_only", reason="daily_limit", now=now)
                    return "in_app_only"
                await store.reserve_limit(session, c.notification_id, day)

        body = {
            "telegram_user_id": delivery.recipient_telegram_user_id,
            "text": rendered.telegram_text(),
            "buttons": rendered.buttons() or None,
            "disable_notification": False,
            "idempotency_key": str(c.notification_id),
        }
        try:
            result = await self.rt.client("telegram-bot-gateway").post(
                "/internal/v1/messages", json=body, idempotency_key=str(c.notification_id)
            )
        except UpstreamError as exc:
            return await self._on_send_error(c, spec, now, exc)
        except Exception as exc:
            log.warning("bot gateway call failed", extra={"error_type": type(exc).__name__})
            return await self._retry_or_fail(c, now, reason="gateway_unavailable", event_reason="error")
        async with self.rt.transaction() as session:
            await store.mark_sent(session, c, message_id=int(result["message_id"]), now=now, producer=producer)
        return "sent"

    async def _on_send_error(self, c: store.Claimed, spec: TemplateSpec, now: datetime, exc: UpstreamError) -> str:
        producer = self.settings.service_name
        details = exc.details or {}
        if exc.code == "TELEGRAM_BLOCKED":
            # Бот заблокирован: запись остаётся в центре (AT-12), код PIN — failed (identity-consent ответит 409)
            status = "in_app_only" if spec.in_app else "failed"
            async with self.rt.transaction() as session:
                await store.mark_failed(
                    session, c, reason="blocked", event_reason="blocked", now=now, producer=producer, status=status
                )
            return status
        if exc.code == "IDEMPOTENCY_IN_PROGRESS":
            # Предыдущая попытка с тем же notification_id ещё отправляется (истекла аренда) — проверим позже
            return await self._retry_or_fail(c, now, reason="send_in_progress", event_reason="error", retry_after=30)
        if exc.status == 429:
            return await self._retry_or_fail(
                c, now, reason="rate_limited", event_reason="rate_limited", retry_after=details.get("retry_after")
            )
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
            return "failed"
        if exc.status in PERMANENT_STATUSES:
            log.error("bot gateway rejected notification", extra={"status": exc.status, "error_code": exc.code})
            async with self.rt.transaction() as session:
                await store.mark_failed(
                    session, c, reason="gateway_rejected", event_reason="error", now=now, producer=producer
                )
            return "failed"
        # 502 TELEGRAM_ERROR (временная) — сбой Telegram; сеть/503/circuit open — недоступен сам bot-gateway
        reason = "telegram_unavailable" if exc.code == "TELEGRAM_ERROR" else "gateway_unavailable"
        return await self._retry_or_fail(c, now, reason=reason, event_reason="error")
