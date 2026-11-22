"""Операции с журналом (= центр уведомлений): приём с дедупликацией, захват к обработке, конечные статусы + события,
лимит дня, проекции (пропуски, семьи, рассылки), чтение центра, удаление и срок хранения."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any

from sqlalchemy import and_, delete, func, or_, select, text, tuple_, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.messaging import emit
from tilhero_notifications.domain.policy import INVITE_TEMPLATES, SENDER_COUNTED_INVITES
from tilhero_notifications.models import (
    Broadcast,
    CampaignRecipient,
    DeletedUser,
    FamilyOwner,
    InboxState,
    MissedState,
    Notification,
)

DELIVERED = "notification.delivered.v1"
DELIVERY_FAILED = "telegram.delivery.failed.v1"
DOMAIN_DELETED = "user.domain.deleted.v1"
LOCK_CLASS = 7_340_104  # advisory-lock'и notifications: (класс, hashtext(user_id))


def iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z")


async def lock_user(session: AsyncSession, user_id: uuid.UUID) -> None:
    """Сериализует по ученику: приём ↔ удаление (запись, ждущая блокировку, увидит отметку deleted_users) и
    решение «отправить» ↔ счёт дневного лимита (параллельные отправки не превысят лимит)."""
    await session.execute(
        text("SELECT pg_advisory_xact_lock(:c, hashtext(:u))"), {"c": LOCK_CLASS, "u": str(user_id)}
    )


async def is_deleted(session: AsyncSession, user_id: uuid.UUID) -> bool:
    return await session.get(DeletedUser, user_id) is not None


async def mark_deleted(session: AsyncSession, user_id: uuid.UUID, request_id: uuid.UUID, now: datetime) -> None:
    await session.execute(
        insert(DeletedUser)
        .values(user_id=user_id, request_id=request_id, deleted_at=now)
        .on_conflict_do_nothing(index_elements=[DeletedUser.user_id])
    )


# ---------------------------------------------------------------- приём


async def insert_notification(
    session: AsyncSession,
    *,
    notification_id: uuid.UUID,
    user_id: uuid.UUID,
    category: str,
    kind: str,
    template: str,
    params: dict[str, Any] | None,
    dedup_key: str,
    now: datetime,
    subject_user_id: uuid.UUID | None = None,
    center_only: bool = False,
    not_before: datetime | None = None,
    stale_after: datetime | None = None,
    source_event_id: str | None = None,
    telegram_status: str = "scheduled",
    reason: str | None = None,
    title: str | None = None,
    body: str | None = None,
    startapp: str | None = None,
) -> bool:
    """False — дубль (тот же dedup_key или notification_id): запись уже есть."""
    pending = telegram_status == "scheduled"
    stmt = (
        insert(Notification)
        .values(
            notification_id=notification_id,
            user_id=user_id,
            category=category,
            kind=kind,
            template=template,
            params=params if pending else None,
            subject_user_id=subject_user_id,
            title=title,
            body=body,
            startapp=startapp,
            dedup_key=dedup_key,
            telegram_status=telegram_status,
            reason=reason,
            center_only=center_only,
            not_before=not_before,
            stale_after=stale_after,
            scheduled_for=now if pending else None,
            attempts=0,
            source_event_id=uuid.UUID(source_event_id) if source_event_id else None,
            created_at=now,
            updated_at=now,
        )
        .on_conflict_do_nothing()
        .returning(Notification.notification_id)
    )
    return (await session.execute(stmt)).first() is not None


# ---------------------------------------------------------------- захват к обработке


@dataclass(frozen=True)
class Claimed:
    notification_id: uuid.UUID
    user_id: uuid.UUID
    category: str
    kind: str
    template: str
    params: dict[str, Any] | None
    subject_user_id: uuid.UUID | None
    title: str | None
    body: str | None
    startapp: str | None
    center_only: bool
    not_before: datetime | None
    stale_after: datetime | None
    attempts: int


_CLAIMED_COLUMNS = (
    Notification.notification_id,
    Notification.user_id,
    Notification.category,
    Notification.kind,
    Notification.template,
    Notification.params,
    Notification.subject_user_id,
    Notification.title,
    Notification.body,
    Notification.startapp,
    Notification.center_only,
    Notification.not_before,
    Notification.stale_after,
    Notification.attempts,
)


async def claim_due(session: AsyncSession, *, now: datetime, batch: int, lease_seconds: int) -> list[Claimed]:
    """Захват пачки (telegram_status=scheduled, scheduled_for ≤ now): scheduled_for сдвигается на время «аренды»
    (SKIP LOCKED — безопасно для реплик и параллельных вызовов dispatch). Если процесс упадёт посреди отправки,
    строка снова станет доступна после аренды; повтор не задвоит сообщение — bot-gateway идемпотентен по
    notification_id."""
    due = (
        select(Notification.notification_id)
        .where(Notification.telegram_status == "scheduled", Notification.scheduled_for <= now)
        .order_by(Notification.scheduled_for)
        .limit(batch)
        .with_for_update(skip_locked=True)
        .scalar_subquery()
    )
    rows = (
        await session.execute(
            update(Notification)
            .where(Notification.notification_id.in_(due))
            .values(scheduled_for=now + timedelta(seconds=lease_seconds), updated_at=now)
            .returning(*_CLAIMED_COLUMNS)
            .execution_options(synchronize_session=False)
        )
    ).all()
    return [Claimed(*row) for row in rows]


async def claim_one(
    session: AsyncSession, notification_id: uuid.UUID, *, now: datetime, lease_seconds: int
) -> Claimed | None:
    """Захват конкретной записи к немедленной обработке (транзакционные). None — уже взята (аренда) или конечна."""
    row = (
        await session.execute(
            update(Notification)
            .where(
                Notification.notification_id == notification_id,
                Notification.telegram_status == "scheduled",
                Notification.scheduled_for <= now,
            )
            .values(scheduled_for=now + timedelta(seconds=lease_seconds), updated_at=now)
            .returning(*_CLAIMED_COLUMNS)
            .execution_options(synchronize_session=False)
        )
    ).first()
    return Claimed(*row) if row is not None else None


async def find(
    session: AsyncSession, *, notification_id: uuid.UUID, dedup_key: str
) -> tuple[uuid.UUID, uuid.UUID, str, str | None] | None:
    """(notification_id, user_id, telegram_status, reason) по id или ключу дедупликации."""
    row = (
        await session.execute(
            select(
                Notification.notification_id, Notification.user_id, Notification.telegram_status, Notification.reason
            ).where((Notification.notification_id == notification_id) | (Notification.dedup_key == dedup_key))
        )
    ).first()
    return (row[0], row[1], row[2], row[3]) if row is not None else None


# ---------------------------------------------------------------- отрисовка и лимит


async def save_render(
    session: AsyncSession,
    notification_id: uuid.UUID,
    *,
    template: str,
    title: str | None,
    body: str | None,
    startapp: str | None,
    now: datetime,
) -> None:
    await session.execute(
        update(Notification)
        .where(Notification.notification_id == notification_id, Notification.telegram_status == "scheduled")
        .values(template=template, title=title, body=body, startapp=startapp, updated_at=now)
        .execution_options(synchronize_session=False)
    )


async def count_limit(session: AsyncSession, user_id: uuid.UUID, day: date, *, exclude: uuid.UUID) -> int:
    """Сообщения, засчитанные в лимит местных суток: отправленные и зарезервированные к отправке (в т.ч. ждущие
    повтора). Обрабатываемая запись (`exclude`) не считается — её повтор не упирается в собственный резерв.
    Приглашения (policy.INVITE_TEMPLATES) в общий лимит не входят — у них свой (count_invites)."""
    return int(
        (
            await session.execute(
                select(func.count())
                .select_from(Notification)
                .where(
                    Notification.user_id == user_id,
                    Notification.limit_day == day,
                    Notification.telegram_status.in_(("scheduled", "sent")),
                    Notification.notification_id != exclude,
                    Notification.template.notin_(INVITE_TEMPLATES),
                )
            )
        ).scalar_one()
    )


async def count_invites(session: AsyncSession, user_id: uuid.UUID, day: date, *, exclude: uuid.UUID,
                        sender: uuid.UUID | None = None) -> int:
    """Приглашения получателю, засчитанные в их лимит местных суток (отправленные и зарезервированные); с `sender` —
    только от этого отправителя (pair_invited, duel_challenged)."""
    conditions = [
        Notification.user_id == user_id,
        Notification.limit_day == day,
        Notification.telegram_status.in_(("scheduled", "sent")),
        Notification.notification_id != exclude,
        Notification.template.in_(INVITE_TEMPLATES),
    ]
    if sender is not None:
        conditions += [Notification.subject_user_id == sender, Notification.template.in_(SENDER_COUNTED_INVITES)]
    return int((await session.execute(select(func.count()).select_from(Notification).where(*conditions))).scalar_one())


async def reserve_limit(session: AsyncSession, notification_id: uuid.UUID, day: date) -> None:
    await session.execute(
        update(Notification)
        .where(Notification.notification_id == notification_id)
        .values(limit_day=day)
        .execution_options(synchronize_session=False)
    )


# ---------------------------------------------------------------- конечные статусы


async def _finish(session: AsyncSession, notification_id: uuid.UUID, values: dict[str, Any]) -> bool:
    result = await session.execute(
        update(Notification)
        .where(Notification.notification_id == notification_id, Notification.telegram_status == "scheduled")
        .values(**values)
        .execution_options(synchronize_session=False)
    )
    return bool(result.rowcount)  # type: ignore[attr-defined]


async def mark_sent(session: AsyncSession, c: Claimed, *, message_id: int, now: datetime, producer: str) -> None:
    if await _finish(
        session,
        c.notification_id,
        {
            "telegram_status": "sent",
            "sent_at": now,
            "telegram_message_id": message_id,
            "params": None,
            "scheduled_for": None,
            "attempts": c.attempts + 1,
            "reason": None,
            "updated_at": now,
        },
    ):
        await emit(
            session,
            DELIVERED,
            {
                "notification_id": str(c.notification_id),
                "user_id": str(c.user_id),
                "channel": "telegram",
                "delivered_at": iso(now),
            },
            producer=producer,
        )


async def mark_failed(
    session: AsyncSession,
    c: Claimed,
    *,
    reason: str,
    event_reason: str,
    now: datetime,
    producer: str,
    attempted: bool = True,
    status: str = "failed",
) -> None:
    """Доставка не удалась: failed (или in_app_only — бот заблокирован, запись остаётся в центре) + событие."""
    if await _finish(
        session,
        c.notification_id,
        {
            "telegram_status": status,
            "params": None,
            "scheduled_for": None,
            "reason": reason,
            "attempts": c.attempts + (1 if attempted else 0),
            "updated_at": now,
        },
    ):
        await emit(
            session,
            DELIVERY_FAILED,
            {"notification_id": str(c.notification_id), "user_id": str(c.user_id), "reason": event_reason},
            producer=producer,
        )


async def mark_final(session: AsyncSession, c: Claimed, *, status: str, reason: str, now: datetime) -> None:
    """in_app_only (только центр) или skipped (нигде не показывается) — без события."""
    await _finish(
        session,
        c.notification_id,
        {"telegram_status": status, "params": None, "scheduled_for": None, "reason": reason, "updated_at": now},
    )


async def mark_deferred(session: AsyncSession, c: Claimed, *, at: datetime, reason: str, now: datetime) -> None:
    await _finish(session, c.notification_id, {"scheduled_for": at, "reason": reason, "updated_at": now})


async def mark_retry(session: AsyncSession, c: Claimed, *, at: datetime, reason: str, now: datetime) -> None:
    await _finish(
        session,
        c.notification_id,
        {"scheduled_for": at, "attempts": c.attempts + 1, "reason": reason, "updated_at": now},
    )


# ---------------------------------------------------------------- пропуски, семьи


async def missed_last_date(session: AsyncSession, user_id: uuid.UUID) -> date | None:
    state = await session.get(MissedState, user_id, with_for_update=True)
    return state.last_notified_date if state is not None else None


async def set_missed_date(session: AsyncSession, user_id: uuid.UUID, day: date, now: datetime) -> None:
    stmt = insert(MissedState).values(user_id=user_id, last_notified_date=day, updated_at=now)
    await session.execute(
        stmt.on_conflict_do_update(
            index_elements=[MissedState.user_id],
            set_={"last_notified_date": func.greatest(MissedState.last_notified_date, day), "updated_at": now},
        )
    )


async def set_family_owner(session: AsyncSession, family_id: uuid.UUID, owner: uuid.UUID, now: datetime) -> None:
    stmt = insert(FamilyOwner).values(family_id=family_id, owner_user_id=owner, updated_at=now)
    await session.execute(
        stmt.on_conflict_do_update(
            index_elements=[FamilyOwner.family_id], set_={"owner_user_id": owner, "updated_at": now}
        )
    )


async def family_owner(session: AsyncSession, family_id: uuid.UUID) -> uuid.UUID | None:
    row = await session.get(FamilyOwner, family_id)
    return row.owner_user_id if row is not None else None


# ---------------------------------------------------------------- рассылки «Что нового» (только центр)


async def insert_broadcast(
    session: AsyncSession,
    *,
    broadcast_id: uuid.UUID,
    slug: str,
    audience: str,
    segments: dict[str, Any] | None,
    published_at: datetime,
    now: datetime,
) -> None:
    await session.execute(
        insert(Broadcast)
        .values(
            broadcast_id=broadcast_id,
            slug=slug,
            audience=audience,
            segments=segments,
            published_at=published_at,
            received_at=now,
        )
        .on_conflict_do_nothing()
    )


async def inbox_watermark(session: AsyncSession, user_id: uuid.UUID) -> datetime | None:
    row = await session.get(InboxState, user_id)
    return row.broadcasts_seen_at if row is not None else None


async def set_inbox_watermark(session: AsyncSession, user_id: uuid.UUID, at: datetime) -> None:
    stmt = insert(InboxState).values(user_id=user_id, broadcasts_seen_at=at)
    await session.execute(
        stmt.on_conflict_do_update(
            index_elements=[InboxState.user_id],
            set_={"broadcasts_seen_at": func.greatest(InboxState.broadcasts_seen_at, at)},
        )
    )


async def latest_broadcast_at(session: AsyncSession) -> datetime | None:
    return (await session.execute(select(func.max(Broadcast.received_at)))).scalar_one()


async def broadcasts_after(session: AsyncSession, after: datetime, *, not_older: datetime) -> list[Broadcast]:
    rows = await session.execute(
        select(Broadcast)
        .where(Broadcast.received_at > after, Broadcast.published_at >= not_older)
        .order_by(Broadcast.received_at, Broadcast.broadcast_id)
        .limit(100)
    )
    return list(rows.scalars().all())


# ---------------------------------------------------------------- центр уведомлений


def _visible(user_id: uuid.UUID, not_older: datetime) -> Any:
    return and_(
        Notification.user_id == user_id,
        Notification.title.is_not(None),
        Notification.telegram_status.not_in(("skipped", "cancelled")),
        Notification.created_at >= not_older,
    )


async def inbox_page(
    session: AsyncSession,
    user_id: uuid.UUID,
    *,
    limit: int,
    after: tuple[datetime, uuid.UUID] | None,
    not_older: datetime,
) -> list[Notification]:
    stmt = select(Notification).where(_visible(user_id, not_older))
    if after is not None:
        stmt = stmt.where(tuple_(Notification.created_at, Notification.notification_id) < tuple_(*after))
    stmt = stmt.order_by(Notification.created_at.desc(), Notification.notification_id.desc()).limit(limit + 1)
    return list((await session.execute(stmt)).scalars().all())


async def unread_count(session: AsyncSession, user_id: uuid.UUID, *, not_older: datetime) -> int:
    return int(
        (
            await session.execute(
                select(func.count())
                .select_from(Notification)
                .where(_visible(user_id, not_older), Notification.read_at.is_(None))
            )
        ).scalar_one()
    )


async def mark_read(
    session: AsyncSession,
    user_id: uuid.UUID,
    *,
    ids: list[uuid.UUID] | None,
    now: datetime,
    not_older: datetime,
) -> None:
    """ids=None — все. Чужие и невидимые id не меняются (и не раскрываются)."""
    cond = and_(_visible(user_id, not_older), Notification.read_at.is_(None))
    if ids is not None:
        cond = and_(cond, Notification.notification_id.in_(ids))
    await session.execute(
        update(Notification).where(cond).values(read_at=now).execution_options(synchronize_session=False)
    )


# ---------------------------------------------------------------- удаление и срок хранения


async def delete_user(session: AsyncSession, user_id: uuid.UUID) -> int:
    """Журнал и центр ученика, записи других учеников с его именем, состояния и проекции с его id, получатель
    рассылок (статистика рассылок уменьшится — данные ученика важнее)."""
    result = await session.execute(
        delete(Notification).where(or_(Notification.user_id == user_id, Notification.subject_user_id == user_id))
    )
    await session.execute(delete(CampaignRecipient).where(CampaignRecipient.user_id == user_id))
    await session.execute(delete(MissedState).where(MissedState.user_id == user_id))
    await session.execute(delete(InboxState).where(InboxState.user_id == user_id))
    await session.execute(delete(FamilyOwner).where(FamilyOwner.owner_user_id == user_id))
    return int(result.rowcount or 0)  # type: ignore[attr-defined]


async def purge_expired(session: AsyncSession, *, before: datetime, limit: int = 5000) -> int:
    ids = select(Notification.notification_id).where(Notification.created_at < before).limit(limit).scalar_subquery()
    result = await session.execute(delete(Notification).where(Notification.notification_id.in_(ids)))
    await session.execute(delete(Broadcast).where(Broadcast.received_at < before))
    return int(result.rowcount or 0)  # type: ignore[attr-defined]
