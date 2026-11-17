"""Потребители событий notifications (INTERNAL_API §4; inbox-дедупликация + outbox в одной транзакции).

Приём только создаёт запись журнала (telegram_status=scheduled) с ключом дедупликации; отрисовка на языке
ученика, политика и доставка — в момент отправки (dispatcher.py), чтобы настройки, тихие часы и блокировка бота
учитывались свежими.

Событие → шаблон → кому (ключ дедупликации):
- learning.reminder.due.v1 → lesson.reminder(.kid) → ученику, ребёнку — опекуну (reminder:<user>:<date>);
  позже слота + 3 ч — только центр;
- learning.session.missed.v1 → lesson.missed(.kid); consecutive_missed ≥ 4 — lesson.comeback(.kid) не чаще раза
  в 7 дней (missed:<user>:<date>); не раньше слота следующего дня, после 22:00 следующего дня — только центр;
- social.invite.accepted.v1 → invite.accepted → пригласившему (invite.accepted:<invite>:<invitee>; семья —
  family.joined:<inviter>:<invitee>, общий ключ с family.joined владельцу — без двойного сообщения);
- social.invite.declined.v1 → invite.declined → пригласившему, только центр (invite.declined:<invite>:<invitee>);
- social.invite.reminder_due.v1 → invite.pending → получателю (invite.pending:<invite>:<invitee>);
- social.family.member_added.v1 → family.joined → владельцу (family.joined:<owner>:<member>); role owner —
  проекция владельца семьи; role child — без сообщения (ребёнка добавляет сам родитель);
- support.ticket.replied.v1 / status.changed→RESOLVED → support.reply / support.resolved (как aievent);
- experience.release_note.published.v1 → broadcasts (запись центра — при чтении центра, broadcasts.py);
- user.deletion.requested.v1 → удаление → user.domain.deleted.v1 {domain: notifications};
- user.status.changed / consent.revoked / user.notification_settings.changed / user.profile.updated — сброс кэша
  адресации.

Код сброса PIN через шину не принимается: только синхронный HTTP (api/internal.py).
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, date, datetime, timedelta
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.app import Runtime
from tilhero_common.messaging import Envelope, emit
from tilhero_notifications import store
from tilhero_notifications.broadcasts import notification_id_for
from tilhero_notifications.delivery import forget
from tilhero_notifications.dispatcher import Dispatcher
from tilhero_notifications.domain.policy import at_local, zone
from tilhero_notifications.settings import Settings
from tilhero_notifications.templates import TEMPLATES, TemplateError

log = logging.getLogger("tilhero.notifications.consumers")

REMINDER_DUE = "learning.reminder.due.v1"
SESSION_MISSED = "learning.session.missed.v1"
INVITE_ACCEPTED = "social.invite.accepted.v1"
INVITE_DECLINED = "social.invite.declined.v1"
INVITE_REMINDER = "social.invite.reminder_due.v1"
MEMBER_ADDED = "social.family.member_added.v1"
TICKET_REPLIED = "support.ticket.replied.v1"
TICKET_STATUS_CHANGED = "support.ticket.status.changed.v1"
RELEASE_NOTE = "experience.release_note.published.v1"
DELETION_REQUESTED = "user.deletion.requested.v1"
CACHE_EVENTS = [
    "user.status.changed.v1",
    "consent.revoked.v1",
    "user.notification_settings.changed.v1",
    "user.profile.updated.v1",
]

Handler = Callable[[AsyncSession, Envelope], Awaitable[None]]
HHMM = Annotated[str, Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")]
InviteKind = Literal["family", "friend", "referral"]


class _Payload(BaseModel):
    """Терпимый читатель: обязательные поля проверяются строго, новые необязательные поля не ломают потребителя.
    Невалидный payload → DLQ."""

    model_config = ConfigDict(extra="ignore")


class ReminderDue(_Payload):
    user_id: uuid.UUID
    local_date: date
    slot_time: HHMM
    timezone: Annotated[str, Field(max_length=200)]
    duration_min: Literal[10, 15, 20, 30]
    streak_days: Annotated[int, Field(ge=0)] | None = None


class SessionMissed(_Payload):
    user_id: uuid.UUID
    local_date: date
    slot_time: HHMM
    timezone: Annotated[str, Field(max_length=200)]
    consecutive_missed: Annotated[int, Field(ge=1)]
    next_slot_date: date | None = None


class InviteEvent(_Payload):
    invite_id: uuid.UUID
    inviter_user_id: uuid.UUID
    invitee_user_id: uuid.UUID
    kind: InviteKind


class MemberAdded(_Payload):
    family_id: uuid.UUID
    user_id: uuid.UUID
    role: Literal["owner", "adult", "teen", "child"]
    owner_user_id: uuid.UUID


class TicketReplied(_Payload):
    ticket_id: uuid.UUID
    number: str
    user_id: uuid.UUID
    message_id: uuid.UUID


class TicketStatusChanged(_Payload):
    ticket_id: uuid.UUID
    number: str
    user_id: uuid.UUID | None = None
    to_status: str


class ReleaseNotePublished(_Payload):
    release_note_id: uuid.UUID
    slug: Annotated[str, Field(min_length=1, max_length=200)]
    audience: Literal["new", "existing", "all"]
    segments: dict[str, Any] | None = None
    published_at: datetime


class DeletionRequested(_Payload):
    user_id: uuid.UUID
    request_id: uuid.UUID


Accept = Callable[..., Awaitable[str]]


def build_handlers(runtime: Runtime, dispatcher: Dispatcher) -> tuple[Accept, dict[str, tuple[list[str], Handler]]]:
    """→ (accept — общий приём записи для потребителей и POST …/transactional, {durable: (события, обработчик)})."""
    settings: Settings = runtime.settings  # type: ignore[assignment]

    def wake_after_commit(session: AsyncSession) -> None:
        event.listen(session.sync_session, "after_commit", lambda _s: dispatcher.wake(), once=True)

    async def accept(
        session: AsyncSession,
        env: Envelope | None,
        *,
        user_id: uuid.UUID,
        template: str,
        params: dict[str, Any] | None,
        dedup_key: str,
        kind: str = "standard",
        subject_user_id: uuid.UUID | None = None,
        center_only: bool = False,
        not_before: datetime | None = None,
        stale_after: datetime | None = None,
        notification_id: uuid.UUID | None = None,
        direct: bool = False,
    ) -> str:
        """→ scheduled | failed | skipped (ученик удалён — без записи) | duplicate."""
        now = datetime.now(UTC)
        await store.lock_user(session, user_id)
        if await store.is_deleted(session, user_id):
            log.info("notification skipped: user deleted", extra={"template": template})
            return "skipped"
        spec = TEMPLATES.get(template)
        status, reason = "scheduled", None
        if spec is None:
            status, reason = "failed", "template_unknown"
        elif spec.direct_only and not direct:
            status, reason = "failed", "direct_only"  # секрет пришёл не тем путём — не храним и не отправляем
        else:
            try:
                spec.validate(params)
            except TemplateError:
                status, reason = "failed", "params_invalid"
        nid = notification_id or notification_id_for(dedup_key)
        inserted = await store.insert_notification(
            session,
            notification_id=nid,
            user_id=user_id,
            category=spec.category if spec is not None else "service",
            kind=kind,
            template=template,
            params=params,
            dedup_key=dedup_key,
            now=now,
            subject_user_id=subject_user_id,
            center_only=center_only,
            not_before=not_before,
            stale_after=stale_after,
            source_event_id=env.event_id if env is not None else None,
            telegram_status=status,
            reason=reason,
        )
        if not inserted:
            log.info("duplicate notification suppressed", extra={"template": template})
            return "duplicate"
        if status == "failed":
            log.error("notification rejected", extra={"template": template, "reason": reason})
            await emit(
                session,
                store.DELIVERY_FAILED,
                {"notification_id": str(nid), "user_id": str(user_id), "reason": "error"},
                producer=settings.service_name,
            )
            return "failed"
        if not direct:
            wake_after_commit(session)
        return "scheduled"

    # ---------------------------------------------------------------- learning-plan

    async def on_learning(session: AsyncSession, env: Envelope) -> None:
        if env.event_type == REMINDER_DUE:
            r = ReminderDue.model_validate(env.payload)
            slot = at_local(r.local_date, r.slot_time, zone(r.timezone, settings.default_timezone))
            await accept(
                session,
                env,
                user_id=r.user_id,
                template="lesson.reminder",
                params={
                    "local_date": r.local_date.isoformat(),
                    "slot_time": r.slot_time,
                    "duration_min": r.duration_min,
                    "streak_days": r.streak_days,
                },
                dedup_key=f"reminder:{r.user_id}:{r.local_date.isoformat()}",
                stale_after=slot + timedelta(hours=settings.reminder_stale_hours),
            )
            return
        m = SessionMissed.model_validate(env.payload)
        await on_missed(session, env, m)

    async def on_missed(session: AsyncSession, env: Envelope, m: SessionMissed) -> None:
        tz = zone(m.timezone, settings.default_timezone)
        next_day = m.local_date + timedelta(days=1)
        # Утром следующего дня — в слот-время (preferred_time); позже 22:00 следующего дня — только центр
        not_before = at_local(next_day, m.slot_time, tz)
        stale_after = max(at_local(next_day, settings.missed_stale_time, tz), not_before + timedelta(hours=1))
        await store.lock_user(session, m.user_id)
        if m.consecutive_missed <= 3:
            template = "lesson.missed"
            params: dict[str, Any] = {
                "local_date": m.local_date.isoformat(),
                "consecutive_missed": m.consecutive_missed,
                "next_slot_date": m.next_slot_date.isoformat() if m.next_slot_date else None,
            }
        else:
            last = await store.missed_last_date(session, m.user_id)
            if last is not None and (m.local_date - last).days < settings.comeback_min_days:
                log.info("comeback throttled", extra={"consecutive_missed": m.consecutive_missed})
                return
            template = "lesson.comeback"
            params = {"local_date": m.local_date.isoformat(), "consecutive_missed": m.consecutive_missed}
        outcome = await accept(
            session,
            env,
            user_id=m.user_id,
            template=template,
            params=params,
            dedup_key=f"missed:{m.user_id}:{m.local_date.isoformat()}",
            not_before=not_before,
            stale_after=stale_after,
        )
        if outcome == "scheduled":
            await store.set_missed_date(session, m.user_id, m.local_date, datetime.now(UTC))

    # ---------------------------------------------------------------- social

    async def on_social(session: AsyncSession, env: Envelope) -> None:
        if env.event_type == MEMBER_ADDED:
            await on_member_added(session, env, MemberAdded.model_validate(env.payload))
            return
        i = InviteEvent.model_validate(env.payload)
        if i.inviter_user_id == i.invitee_user_id:
            return  # самоприглашение social отклоняет; на всякий случай — без сообщений себе
        params = {"invite_id": str(i.invite_id), "kind": i.kind}
        if env.event_type == INVITE_ACCEPTED:
            # Семья: тот же ключ, что у family.joined владельцу — пригласивший-владелец получит одно сообщение
            dedup = (
                f"family.joined:{i.inviter_user_id}:{i.invitee_user_id}"
                if i.kind == "family"
                else f"invite.accepted:{i.invite_id}:{i.invitee_user_id}"
            )
            await accept(
                session,
                env,
                user_id=i.inviter_user_id,
                template="invite.accepted",
                params=params,
                dedup_key=dedup,
                subject_user_id=i.invitee_user_id,
            )
        elif env.event_type == INVITE_DECLINED:
            await accept(
                session,
                env,
                user_id=i.inviter_user_id,
                template="invite.declined",
                params=params,
                dedup_key=f"invite.declined:{i.invite_id}:{i.invitee_user_id}",
                center_only=True,
            )
        elif env.event_type == INVITE_REMINDER:
            await accept(
                session,
                env,
                user_id=i.invitee_user_id,
                template="invite.pending",
                params=params,
                dedup_key=f"invite.pending:{i.invite_id}:{i.invitee_user_id}",
                subject_user_id=i.inviter_user_id,
            )

    async def on_member_added(session: AsyncSession, env: Envelope, m: MemberAdded) -> None:
        now = datetime.now(UTC)
        if m.role == "owner":
            await store.set_family_owner(session, m.family_id, m.user_id, now)
            return
        await store.set_family_owner(session, m.family_id, m.owner_user_id, now)
        if m.role == "child":
            return  # ребёнка добавляет сам родитель — сообщать некому
        owner = m.owner_user_id
        if owner == m.user_id:
            return
        await accept(
            session,
            env,
            user_id=owner,
            template="family.joined",
            params={"family_id": str(m.family_id), "role": m.role},
            dedup_key=f"family.joined:{owner}:{m.user_id}",
            subject_user_id=m.user_id,
        )

    # ---------------------------------------------------------------- support

    async def on_support(session: AsyncSession, env: Envelope) -> None:
        if env.event_type == TICKET_REPLIED:
            t = TicketReplied.model_validate(env.payload)
            # Только номер обращения: текст ответа читается в Mini App (не уходит в Telegram)
            await accept(
                session,
                env,
                user_id=t.user_id,
                template="support.reply",
                params={"number": t.number},
                dedup_key=f"support.reply:{t.message_id}",
            )
            return
        s = TicketStatusChanged.model_validate(env.payload)
        if s.to_status == "RESOLVED" and s.user_id is not None:
            await accept(
                session,
                env,
                user_id=s.user_id,
                template="support.resolved",
                params={"number": s.number},
                dedup_key=f"support.resolved:{s.ticket_id}:{env.event_id}",
            )

    # ---------------------------------------------------------------- experience-config

    async def on_release_note(session: AsyncSession, env: Envelope) -> None:
        r = ReleaseNotePublished.model_validate(env.payload)
        await store.insert_broadcast(
            session,
            broadcast_id=r.release_note_id,
            slug=r.slug,
            audience=r.audience,
            segments=r.segments,
            published_at=r.published_at,
            now=datetime.now(UTC),
        )

    # ---------------------------------------------------------------- identity-consent

    async def on_user_deleted(session: AsyncSession, env: Envelope) -> None:
        d = DeletionRequested.model_validate(env.payload)
        await store.lock_user(session, d.user_id)
        await store.mark_deleted(session, d.user_id, d.request_id, datetime.now(UTC))
        await store.delete_user(session, d.user_id)
        await forget(runtime, prefix=settings.redis_key_prefix, user_id=d.user_id)
        await emit(
            session,
            store.DOMAIN_DELETED,
            {"user_id": str(d.user_id), "request_id": str(d.request_id), "domain": "notifications", "mode": "deleted"},
            producer=settings.service_name,
        )

    async def on_user_changed(session: AsyncSession, env: Envelope) -> None:
        """Настройки, статус, согласие, возраст/язык действуют сразу, а не через 5 мин TTL кэша адресации."""
        raw = env.payload.get("user_id")
        if raw:
            await forget(runtime, prefix=settings.redis_key_prefix, user_id=str(uuid.UUID(str(raw))))

    return accept, {
        "notifications.learning": ([REMINDER_DUE, SESSION_MISSED], on_learning),
        "notifications.social": ([INVITE_ACCEPTED, INVITE_DECLINED, INVITE_REMINDER, MEMBER_ADDED], on_social),
        "notifications.support": ([TICKET_REPLIED, TICKET_STATUS_CHANGED], on_support),
        "notifications.product": ([RELEASE_NOTE], on_release_note),
        "notifications.user_deleted": ([DELETION_REQUESTED], on_user_deleted),
        "notifications.delivery_cache": (CACHE_EVENTS, on_user_changed),
    }
