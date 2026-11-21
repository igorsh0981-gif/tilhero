"""Профиль сообщества (§1.1): создаётся лениво при первом обращении (ник null, новый код друга), ник с кулдауном,
смена кода друга (≤ 3 в сутки), скрытие игрового профиля. Изменения ника и скрытия → social.profile.updated.v1
(gamification, lessons). Запись — под advisory-блокировкой ученика, после проверки «удалён?»."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.errors import ApiError, conflict, unprocessable
from tilhero_social.domain import nicknames
from tilhero_social.domain.common import PROFILE_UPDATED, emit_event, iso
from tilhero_social.models import CommunityProfile, NicknameStop

_CODE_ATTEMPTS = 8


def nickname_taken() -> ApiError:
    return conflict("NICKNAME_TAKEN", "Такой ник уже занят")


async def get(session: AsyncSession, user_id: uuid.UUID, *, for_update: bool = False) -> CommunityProfile | None:
    stmt = select(CommunityProfile).where(CommunityProfile.user_id == user_id)
    if for_update:
        stmt = stmt.with_for_update()
    return (await session.execute(stmt.execution_options(populate_existing=True))).scalar_one_or_none()


async def ensure(session: AsyncSession, user_id: uuid.UUID, now: datetime) -> CommunityProfile:
    """Профиль ученика; нет — создаёт (ник null, новый уникальный код). Вызывать под блокировкой ученика и после
    проверки удаления. Коллизия кода — новая попытка (ON CONFLICT DO NOTHING)."""
    row = await get(session, user_id, for_update=True)
    if row is not None:
        return row
    for _ in range(_CODE_ATTEMPTS):
        inserted = await session.execute(insert(CommunityProfile).values(
            user_id=user_id, nickname=None, nickname_lc=None, friend_code=nicknames.new_friend_code(),
            game_profile_hidden=False, code_rotations=0, created_at=now, updated_at=now,
        ).on_conflict_do_nothing().returning(CommunityProfile.user_id))
        if inserted.first() is not None:
            break
        row = await get(session, user_id, for_update=True)
        if row is not None:
            return row
    row = await get(session, user_id, for_update=True)
    if row is None:  # pragma: no cover - 8 коллизий подряд из 2^40
        raise RuntimeError("friend code space exhausted")
    return row


async def nicknames_of(session: AsyncSession, user_ids: list[uuid.UUID]) -> dict[uuid.UUID, str | None]:
    if not user_ids:
        return {}
    rows = (await session.execute(select(CommunityProfile.user_id, CommunityProfile.nickname)
                                  .where(CommunityProfile.user_id.in_(user_ids)))).all()
    found = {u: n for u, n in rows}
    return {u: found.get(u) for u in user_ids}


def change_available_at(row: CommunityProfile | None, cooldown_days: int, now: datetime) -> datetime | None:
    """Когда можно сменить ник (None — сейчас): первый ник — сразу; после смены — через cooldown от смены; после
    сброса модератором — через cooldown от сброса (ревью спринта 7, п. 5: сброс — ограничение, а не повод сразу
    взять новый)."""
    if row is None:
        return None
    base = row.nickname_reset_at if row.nickname is None else row.nickname_changed_at
    if base is None:
        return None
    at = base + timedelta(days=cooldown_days)
    return at if at > now else None


def view(row: CommunityProfile | None, member_id: str, *, ban: tuple[bool, datetime | None], cooldown_days: int,
         now: datetime, friends_reason: str | None, friend_code: str) -> dict[str, Any]:
    """CommunityProfile (bff.ts)."""
    return {
        "member_id": member_id,
        "nickname": row.nickname if row is not None else None,
        "friend_code": friend_code,
        "game_profile_hidden": bool(row.game_profile_hidden) if row is not None else False,
        "restrictions": {"social_ban": ban[0], "social_ban_until": iso(ban[1]) if ban[0] else None},
        "nickname_change_available_at": iso(change_available_at(row, cooldown_days, now)),
        "friends_available": friends_reason is None,
        "friends_unavailable_reason": friends_reason,
    }


async def emit_updated(session: AsyncSession, row: CommunityProfile, member_id: str, now: datetime) -> None:
    await emit_event(session, PROFILE_UPDATED, {
        "user_id": str(row.user_id), "member_id": member_id, "nickname": row.nickname,
        "game_profile_hidden": bool(row.game_profile_hidden), "updated_at": iso(now)})


async def set_nickname(session: AsyncSession, row: CommunityProfile, raw: str, member_id: str, now: datetime,
                       cooldown_days: int) -> CommunityProfile:
    """422 NICKNAME_INVALID {reason}; 429 NICKNAME_COOLDOWN {until}; 409 NICKNAME_TAKEN; тот же ник — без смены."""
    nick, reason = nicknames.validate(raw)
    if reason is not None:
        raise unprocessable("NICKNAME_INVALID", "Ник не подходит", {"reason": reason})
    if row.nickname == nick:
        return row
    key = nicknames.unique_key(nick)
    if await session.get(NicknameStop, key) is not None:  # сброшен модератором — запрещён всем и навсегда
        raise unprocessable("NICKNAME_INVALID", "Ник не подходит", {"reason": "forbidden"})
    available = change_available_at(row, cooldown_days, now)
    if available is not None:
        raise ApiError(429, "NICKNAME_COOLDOWN", "Ник можно менять раз в 7 дней", {"until": iso(available)})
    if key != row.nickname_lc:
        owner = (await session.execute(select(CommunityProfile.user_id).where(CommunityProfile.nickname_lc == key))
                 ).scalar_one_or_none()
        if owner is not None and owner != row.user_id:
            raise nickname_taken()
    try:
        async with session.begin_nested():
            await session.execute(update(CommunityProfile).where(CommunityProfile.user_id == row.user_id).values(
                nickname=nick, nickname_lc=key, nickname_changed_at=now, nickname_reset_at=None, updated_at=now))
    except IntegrityError:  # тот же ник занят параллельно (UNIQUE nickname_lc)
        raise nickname_taken() from None
    fresh = await get(session, row.user_id)
    assert fresh is not None
    await emit_updated(session, fresh, member_id, now)
    return fresh


async def reset_nickname(session: AsyncSession, row: CommunityProfile, member_id: str, now: datetime,
                         sanction_id: uuid.UUID | None = None) -> None:
    """Сброс модератором (санкция nickname_reset): ник → null; его ключ — в глобальный стоп-лист (никто, включая
    ученика, не задаст его снова); новый ник — через cooldown от сброса."""
    if row.nickname is None:
        return
    if row.nickname_lc is not None:
        await session.execute(insert(NicknameStop).values(
            nickname_lc=row.nickname_lc, user_id=row.user_id, sanction_id=sanction_id, created_at=now,
        ).on_conflict_do_nothing())
    row.nickname, row.nickname_lc, row.nickname_reset_at, row.updated_at = None, None, now, now
    await session.flush()
    await emit_updated(session, row, member_id, now)


async def rotate_code(session: AsyncSession, row: CommunityProfile, now: datetime, per_day: int) -> CommunityProfile:
    """Новый код (прежний сразу не находится); ≤ per_day смен за 24 ч от первой смены окна → 429 FRIEND_CODE_LIMIT."""
    window_start = row.code_window_start
    rotations = row.code_rotations
    if window_start is None or now >= window_start + timedelta(hours=24):
        window_start, rotations = now, 0
    if rotations >= per_day:
        raise ApiError(429, "FRIEND_CODE_LIMIT", "Код можно менять не чаще 3 раз в сутки",
                       {"until": iso(window_start + timedelta(hours=24))})
    for _ in range(_CODE_ATTEMPTS):
        code = nicknames.new_friend_code()
        taken = (await session.execute(select(CommunityProfile.user_id).where(CommunityProfile.friend_code == code))
                 ).scalar_one_or_none()
        if taken is not None:
            continue
        try:
            async with session.begin_nested():
                await session.execute(update(CommunityProfile).where(CommunityProfile.user_id == row.user_id).values(
                    friend_code=code, code_window_start=window_start, code_rotations=rotations + 1, updated_at=now))
        except IntegrityError:
            continue
        break
    fresh = await get(session, row.user_id)
    assert fresh is not None
    return fresh


async def set_hidden(session: AsyncSession, row: CommunityProfile, hidden: bool, member_id: str,
                     now: datetime) -> CommunityProfile:
    if row.game_profile_hidden != hidden:
        row.game_profile_hidden, row.updated_at = hidden, now
        await session.flush()
        await emit_updated(session, row, member_id, now)
    return row


async def find_by_code(session: AsyncSession, code: str) -> CommunityProfile | None:
    return (await session.execute(select(CommunityProfile).where(CommunityProfile.friend_code == code))
            ).scalar_one_or_none()


async def find_by_nickname(session: AsyncSession, nickname: str) -> CommunityProfile | None:
    return (await session.execute(select(CommunityProfile).where(
        CommunityProfile.nickname_lc == nicknames.unique_key(nickname.strip())))).scalar_one_or_none()
