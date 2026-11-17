"""invites:tick (n8n, каждый час): истёкшие → expired; открытые ≥ 24 ч назад без ответа → одно напоминание
получателю (social.invite.reminder_due.v1, AT-10).

Идемпотентность: reminded_at ставится в той же транзакции, что и событие в outbox; строки берутся
FOR UPDATE SKIP LOCKED — параллельные запуски не напоминают дважды. Открытые раньше REMINDER_MAX_AGE_DAYS
не напоминаются (после простоя или для старых реферальных ссылок без срока).
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.messaging import emit
from tilhero_social.models import Invite, InviteRedemption

REMINDER_DUE = "social.invite.reminder_due.v1"


@dataclass
class TickResult:
    reminders: int = 0
    expired: int = 0


async def run_tick(session: AsyncSession, *, clock: Callable[[], datetime], producer: str,
                   remind_after: timedelta, max_age: timedelta, batch_size: int) -> TickResult:
    now = clock()
    result = TickResult()
    expired = await session.execute(
        update(Invite)
        .where(Invite.status == "active", Invite.expires_at.is_not(None), Invite.expires_at <= now)
        .values(status="expired", updated_at=now)
        .returning(Invite.invite_id)
    )
    result.expired = len(expired.all())

    r, i = InviteRedemption, Invite
    rows = (await session.execute(
        select(r, i.inviter_user_id, i.kind)
        .join(i, i.invite_id == r.invite_id)
        .where(r.accepted_at.is_(None), r.declined_at.is_(None), r.reminded_at.is_(None),
               r.opened_at <= now - remind_after, r.opened_at > now - max_age,
               i.status == "active", or_(i.expires_at.is_(None), i.expires_at > now))
        .order_by(r.opened_at)
        .limit(batch_size)
        .with_for_update(of=r, skip_locked=True)
    )).all()
    for red, inviter, kind in rows:
        red.reminded_at = now
        await emit(session, REMINDER_DUE, {
            "invite_id": str(red.invite_id), "inviter_user_id": str(inviter),
            "invitee_user_id": str(red.invitee_user_id), "kind": kind,
        }, producer=producer)
        result.reminders += 1
    await session.flush()
    return result
