"""member_id (§0): `"mb_" + base64url(HMAC-SHA256(MEMBER_ID_KEY, str(user_id))[:16])` без `=` — 25 символов.
Одинаков в social, gamification и lessons; telegram-bff его не расшифровывает. Обратного вычисления нет: social ведёт
реестр member_id → user_id (member_ids) — строка появляется, когда social впервые отдаёт member_id ученика (профиль,
семья, друзья, заявки, связь) или узнаёт ученика (проекция профилей)."""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import uuid
from collections.abc import Iterable
from typing import Final

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_social.domain import family as fam
from tilhero_social.models import DeletedUser, MemberId

MEMBER_RE: Final = re.compile(r"^mb_[A-Za-z0-9_-]{22}$")


def member_id_of(key: bytes, user_id: uuid.UUID) -> str:
    digest = hmac.new(key, str(user_id).encode("utf-8"), hashlib.sha256).digest()[:16]
    return "mb_" + base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


async def register(session: AsyncSession, key: bytes, user_ids: Iterable[uuid.UUID]) -> dict[uuid.UUID, str]:
    """member_id учеников + строка реестра (повтор — без изменений). Удалённых не регистрирует (их member_id всё
    равно вычисляется — для ответа, но в реестре его нет: resolve → None). Уже зарегистрированные — без блокировок
    (чтение списков не конкурирует с командами, ревью Н9). Новые строки — под advisory-блокировкой этих учеников с
    проверкой «удалён?» (сага держит ту же): строка не появится после саги. Блокировки — одним вызовом в порядке uuid:
    вызывать до блокировок других учеников (или только для уже заблокированных)."""
    ids = list(dict.fromkeys(user_ids))
    out = {u: member_id_of(key, u) for u in ids}
    if not ids:
        return out
    known = set((await session.execute(select(MemberId.user_id).where(MemberId.user_id.in_(ids)))).scalars().all())
    ids = [u for u in ids if u not in known]
    if not ids:
        return out
    await fam.lock_users(session, ids)
    deleted = set((await session.execute(select(DeletedUser.user_id).where(DeletedUser.user_id.in_(ids))))
                  .scalars().all())
    rows = [{"user_id": u, "member_id": out[u]} for u in ids if u not in deleted]
    if rows:
        await session.execute(insert(MemberId).values(rows).on_conflict_do_nothing())
    return out


async def resolve(session: AsyncSession, member_id: str) -> uuid.UUID | None:
    """member_id → user_id; None — неизвестен, некорректен или ученик удалён (неотличимо)."""
    if not MEMBER_RE.match(member_id or ""):
        return None
    user_id = (await session.execute(select(MemberId.user_id).where(MemberId.member_id == member_id))
               ).scalar_one_or_none()
    if user_id is None or await session.get(DeletedUser, user_id) is not None:
        return None
    return user_id
