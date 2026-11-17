"""Потребители событий notifications (inbox-дедупликация + outbox в одной транзакции).

- notification.requested.v1 — универсальный запрос от watch/news: kind critical — сразу; kind digest —
  в digest_queue (спринт 6 §5, digest.py);
- support.ticket.replied.v1 → support.reply (без текста ответа); support.ticket.status.changed.v1 → RESOLVED →
  support.resolved (support-notification из ТЗ Admin реализован здесь);
- user.deletion.requested.v1 → удаление журнала пользователя + отметка deleted_users → user.domain.deleted.v1
  {domain: notifications}. Запоздавшие запросы для удалённого пользователя → skipped без записи (ревью P3);
- ops.alert.raised.v1 → оповещение операторам в Telegram (спринт 8 §6, ops_alerts.py).

Шаблоны с секретом (pin.reset_code) через шину не принимаются: только синхронный HTTP (api.py, ревью P2).
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.app import Runtime
from tilhero_common.messaging import Envelope, emit
from tilhero_notifications import store
from tilhero_notifications.delivery import forget_delivery
from tilhero_notifications.dispatcher import Dispatcher
from tilhero_notifications.ops_alerts import OPS_ALERT_RAISED, build_ops_handler
from tilhero_notifications.templates import STARTAPP_PATTERN, TEMPLATES, TemplateError, TemplateSpec

log = logging.getLogger("tilhero.notifications.consumers")

REQUESTED = "notification.requested.v1"
TICKET_REPLIED = "support.ticket.replied.v1"
TICKET_STATUS_CHANGED = "support.ticket.status.changed.v1"
DELETION_REQUESTED = "user.deletion.requested.v1"
STATUS_CHANGED = "user.status.changed.v1"
CONSENT_REVOKED = "consent.revoked.v1"

Handler = Callable[[AsyncSession, Envelope], Awaitable[None]]


class NotificationRequested(BaseModel):
    """Payload notification.requested.v1 (packages/contracts/events) — строго, лишнее поле → в DLQ."""

    model_config = ConfigDict(extra="forbid")

    notification_id: uuid.UUID
    user_id: uuid.UUID
    kind: Literal["critical", "transactional", "digest"]
    template: Annotated[str, Field(pattern=r"^[a-z][a-z0-9_.]*$", max_length=64)]
    params: dict[str, Any] | None = None
    dedup_key: Annotated[str, Field(min_length=1, max_length=200)]
    startapp: Annotated[str, Field(pattern=STARTAPP_PATTERN)] | None = None


Enqueue = Callable[..., Awaitable[str]]


def build_handlers(
    runtime: Runtime, dispatcher: Dispatcher
) -> tuple[Enqueue, dict[str, tuple[list[str], Handler]]]:
    """→ (enqueue — общий приём уведомления для потребителей и POST …/transactional,
    {durable: (события, обработчик)})."""
    def producer() -> str:
        return runtime.settings.service_name

    def wake_after_commit(session: AsyncSession) -> None:
        event.listen(session.sync_session, "after_commit", lambda _s: dispatcher.wake(), once=True)

    async def enqueue(
        session: AsyncSession,
        env: Envelope | None,
        *,
        notification_id: uuid.UUID,
        user_id: uuid.UUID,
        kind: str,
        template: str,
        params: dict[str, Any] | None,
        dedup_key: str,
        startapp: str | None,
        direct: bool = False,
    ) -> str:
        """→ queued | digest | failed | skipped | duplicate."""
        now = datetime.now(UTC)
        await store.lock_user(session, user_id)
        if await store.is_deleted(session, user_id):
            # Пользователь удалён (сага подтверждена): не сохраняем ни строки, ни user_id
            log.info("notification skipped: user deleted", extra={"template": template})
            return "skipped"
        spec: TemplateSpec | None = TEMPLATES.get(template)
        status, reason = "queued", None
        if spec is None:
            status, reason = "failed", "template_unknown"
        elif spec.direct_only and not direct:
            status, reason = "failed", "direct_only"  # секрет пришёл через шину — не храним и не отправляем
        elif spec.internal_only:
            status, reason = "failed", "internal_only"  # digest.daily собирает только сам сервис
        else:
            try:
                spec.validate(params)
            except TemplateError:
                status, reason = "failed", "params_invalid"
        if status == "queued" and kind == "digest":
            assert spec is not None
            if spec.digest_section is None:
                status, reason = "failed", "digest_unsupported"
            else:
                # Спринт 6 §5: копится до digest_time пользователя, уходит одним digest.daily
                added = await store.insert_digest_item(
                    session,
                    item_id=notification_id,
                    user_id=user_id,
                    section=spec.digest_section,
                    template=template,
                    params=params,
                    dedup_key=dedup_key,
                    source_event_id=env.event_id if env is not None else None,
                    now=now,
                )
                if not added:
                    log.info("duplicate digest item suppressed", extra={"template": template})
                    return "duplicate"
                return "digest"
        inserted = await store.insert_notification(
            session,
            notification_id=notification_id,
            user_id=user_id,
            kind=kind,
            template=template,
            params=params,
            startapp=startapp,
            dedup_key=dedup_key,
            source_event_id=env.event_id if env is not None else None,
            now=now,
            status=status,
            failure_reason=reason,
        )
        if not inserted:
            log.info("duplicate notification suppressed", extra={"template": template})
            return "duplicate"
        if status == "failed":
            log.error("notification rejected", extra={"template": template, "reason": reason})
            await emit(
                session,
                store.DELIVERY_FAILED,
                {"notification_id": str(notification_id), "user_id": str(user_id), "reason": "error"},
                producer=producer(),
            )
            return "failed"
        if not direct:
            wake_after_commit(session)
        return "queued"

    async def on_requested(session: AsyncSession, env: Envelope) -> None:
        req = NotificationRequested.model_validate(env.payload)
        await enqueue(
            session,
            env,
            notification_id=req.notification_id,
            user_id=req.user_id,
            kind=req.kind,
            template=req.template,
            params=req.params,
            dedup_key=req.dedup_key,
            startapp=req.startapp,
        )

    async def on_support(session: AsyncSession, env: Envelope) -> None:
        p = env.payload
        if env.event_type == TICKET_REPLIED:
            # Только номер обращения: текст ответа читается в Mini App (не уходит в Telegram-уведомление)
            dedup = f"support.reply:{p['message_id']}"
            await enqueue(
                session,
                env,
                notification_id=uuid.uuid5(uuid.NAMESPACE_URL, f"tilhero:{dedup}"),
                user_id=uuid.UUID(p["user_id"]),
                kind="standard",
                template="support.reply",
                params={"number": p["number"]},
                dedup_key=dedup,
                startapp=None,
            )
        elif (
            env.event_type == TICKET_STATUS_CHANGED and p.get("to_status") == "RESOLVED" and p.get("user_id")
        ):
            dedup = f"support.resolved:{p['ticket_id']}:{env.event_id}"
            await enqueue(
                session,
                env,
                notification_id=uuid.uuid5(uuid.NAMESPACE_URL, f"tilhero:{dedup}"),
                user_id=uuid.UUID(p["user_id"]),
                kind="standard",
                template="support.resolved",
                params={"number": p["number"]},
                dedup_key=dedup,
                startapp=None,
            )

    async def on_user_deleted(session: AsyncSession, env: Envelope) -> None:
        p = env.payload
        user_id = uuid.UUID(p["user_id"])
        await store.lock_user(session, user_id)
        await store.mark_deleted(session, user_id, uuid.UUID(str(p["request_id"])), datetime.now(UTC))
        await store.delete_user(session, user_id)
        await forget_delivery(
            runtime,
            prefix=runtime.settings.redis_key_prefix,  # type: ignore[attr-defined]
            user_id=user_id,
        )
        await emit(
            session,
            store.DOMAIN_DELETED,
            {
                "user_id": str(user_id),
                "request_id": p["request_id"],
                "domain": "notifications",
                "mode": "deleted",
            },
            producer=producer(),
        )

    async def on_user_changed(session: AsyncSession, env: Envelope) -> None:
        """Отключение TilHero / отзыв согласия действуют сразу: кэш адресации (5 мин) сбрасывается (ревью #17)."""
        raw = env.payload.get("user_id")
        if raw:
            await forget_delivery(
                runtime,
                prefix=runtime.settings.redis_key_prefix,  # type: ignore[attr-defined]
                user_id=str(raw),
            )

    return enqueue, {
        "notifications.requests": ([REQUESTED], on_requested),
        "notifications.delivery_cache": ([STATUS_CHANGED, CONSENT_REVOKED], on_user_changed),
        "notifications.support": ([TICKET_REPLIED, TICKET_STATUS_CHANGED], on_support),
        "notifications.user_deleted": ([DELETION_REQUESTED], on_user_deleted),
        "notifications.ops_alerts": ([OPS_ALERT_RAISED], build_ops_handler(runtime)),
    }
