"""Санкция social_ban (§0): активна, пока не снята и не истёк срок (until; null — бессрочно). Проверяется по времени
(не ждёт tick): истёкшая перестаёт действовать сразу, tick лишь публикует social.sanction.changed.v1 active=false."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_social.domain.common import social_restricted
from tilhero_social.models import Sanction


def ban_active(s: Sanction, now: datetime) -> bool:
    return (s.kind == "social_ban" and s.revoked_at is None and s.expired_at is None
            and (s.until is None or s.until > now))


async def active_ban(session: AsyncSession, user_id: uuid.UUID, now: datetime) -> tuple[bool, datetime | None]:
    """(действует ли запрет, его конец; None — бессрочно или запрета нет)."""
    rows = (await session.execute(select(Sanction.until).where(
        Sanction.user_id == user_id, Sanction.kind == "social_ban", Sanction.revoked_at.is_(None),
        Sanction.expired_at.is_(None), or_(Sanction.until.is_(None), Sanction.until > now)))).scalars().all()
    if not rows:
        return False, None
    if any(u is None for u in rows):
        return True, None
    return True, max(u for u in rows if u is not None)


async def require_not_banned(session: AsyncSession, user_id: uuid.UUID, now: datetime) -> None:
    active, until = await active_ban(session, user_id, now)
    if active:
        raise social_restricted(until)
