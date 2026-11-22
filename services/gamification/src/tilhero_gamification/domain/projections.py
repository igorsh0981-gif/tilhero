"""Проекции social, diagnostics и identity-consent (INTERNAL_API спринта 7 §2.1). Издатель проверяется в
consumers.py; каждый обработчик — под advisory-блокировкой затронутых учеников (в одном порядке), отметка удаления
проверяется ПОСЛЕ блокировки (сага держит ту же блокировку): событие удалённого ученика данных не создаёт.
Запоздавшее событие не откатывает более новое (по времени события). Тексты учеников сюда не приходят (ник — публичный).

seed=True — разовая загрузка из выгрузки источника (bootstrap.py): элемент — payload того же события, но строка
только вставляется, если её нет (более свежее состояние из событий не перетирается; снятая дружба не возвращается)."""

from __future__ import annotations

import logging
import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import or_, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_gamification.domain.common import AGE_BANDS, lock_users, parse_ts
from tilhero_gamification.domain.engine import ensure_learner, is_deleted
from tilhero_gamification.domain.members import (
    BAND_OF_LEVEL,
    DEFAULT_BAND,
    MEMBER_RE,
    member_of,
    ordered_pair,
    pair_key,
)
from tilhero_gamification.models import (
    GUARDIAN_CONSENTS,
    Community,
    Duel,
    FamilyMember,
    LearnerLevel,
    Sanction,
    SocialBlock,
    SocialFriend,
)
from tilhero_gamification.settings import Settings

log = logging.getLogger("tilhero.gamification.projections")


def _uuid(value: object) -> uuid.UUID:
    return uuid.UUID(str(value))


async def _alive(session: AsyncSession, *users: uuid.UUID) -> bool:
    """Блокировка учеников и проверка удаления после неё."""
    await lock_users(session, *users)
    for u in users:
        if await is_deleted(session, u):
            return False
    return True


async def on_profile(session: AsyncSession, settings: Settings, payload: dict[str, Any], now: datetime) -> None:
    """social.profile.updated.v1 → community (member_id, ник, скрытие). member_id social не совпал с вычисленным —
    MEMBER_ID_KEY различается (ошибка конфигурации): предупреждение в лог без идентификаторов."""
    user = _uuid(payload["user_id"])
    mid = str(payload.get("member_id") or "")
    if not MEMBER_RE.match(mid) or not await _alive(session, user):
        return
    if member_of(settings, user) != mid:
        log.warning("MEMBER_ID_KEY mismatch with social", extra={"code": "MEMBER_ID_KEY_MISMATCH"})
    at = parse_ts(payload.get("updated_at"), now)
    nickname = payload.get("nickname")
    values = {"member_id": mid, "nickname": str(nickname)[:20] if isinstance(nickname, str) else None,
              "hidden": payload.get("game_profile_hidden") is True, "updated_at": at}
    stmt = insert(Community).values(user_id=user, **values)
    await session.execute(stmt.on_conflict_do_update(index_elements=["user_id"], set_=values,
                                                     where=Community.updated_at <= at))


async def on_friendship(session: AsyncSession, payload: dict[str, Any], now: datetime, *, seed: bool = False) -> None:
    """social.friendship.changed.v1 → social_friends (added | removed)."""
    a, b = ordered_pair(_uuid(payload["user_a"]), _uuid(payload["user_b"]))
    status = payload.get("status")
    if a == b or status not in ("added", "removed") or (seed and status != "added"):
        return
    if not await _alive(session, a, b):
        return
    at = parse_ts(payload.get("at"), now)
    stmt = insert(SocialFriend).values(user_a=a, user_b=b, status=status, changed_at=at)
    if seed:
        await session.execute(stmt.on_conflict_do_nothing(index_elements=["user_a", "user_b"]))
        return
    await session.execute(stmt.on_conflict_do_update(
        index_elements=["user_a", "user_b"], set_={"status": status, "changed_at": at},
        where=SocialFriend.changed_at <= at))


async def on_block(session: AsyncSession, payload: dict[str, Any], now: datetime) -> None:
    """social.block.changed.v1 → social_blocks; блокировка отменяет вызовы на дуэль между учениками (challenged →
    cancelled) в обе стороны. Принятая дуэль доигрывается."""
    blocker, blocked = _uuid(payload["blocker_user_id"]), _uuid(payload["blocked_user_id"])
    status = payload.get("status")
    if blocker == blocked or status not in ("added", "removed") or not await _alive(session, blocker, blocked):
        return
    at = parse_ts(payload.get("at"), now)
    stmt = insert(SocialBlock).values(blocker_user_id=blocker, blocked_user_id=blocked, status=status, changed_at=at)
    applied = (await session.execute(stmt.on_conflict_do_update(
        index_elements=["blocker_user_id", "blocked_user_id"], set_={"status": status, "changed_at": at},
        where=SocialBlock.changed_at <= at).returning(SocialBlock.status))).scalar()
    if applied == "added":
        await session.execute(update(Duel).where(
            Duel.pair_key == pair_key(blocker, blocked), Duel.status == "challenged",
        ).values(status="cancelled", result=None, updated_at=now))


async def on_family(session: AsyncSession, payload: dict[str, Any], now: datetime, *, seed: bool = False) -> None:
    """social.family.member_added.v1 → family_members: участник (роль из события) и владелец (owner)."""
    family = _uuid(payload["family_id"])
    owner, user = _uuid(payload["owner_user_id"]), _uuid(payload["user_id"])
    role = payload.get("role")
    if role not in ("owner", "adult", "teen", "child") or not await _alive(session, owner, user):
        return
    at = parse_ts(payload.get("added_at"), now)
    await session.execute(insert(FamilyMember).values(user_id=owner, family_id=family, role="owner", added_at=at)
                          .on_conflict_do_nothing(index_elements=["user_id"]))
    if user != owner:
        stmt = insert(FamilyMember).values(user_id=user, family_id=family, role=role, added_at=at)
        if seed:
            await session.execute(stmt.on_conflict_do_nothing(index_elements=["user_id"]))
            return
        await session.execute(stmt.on_conflict_do_update(
            index_elements=["user_id"], set_={"family_id": family, "role": role, "added_at": at},
            where=FamilyMember.added_at <= at))


async def on_sanction(session: AsyncSession, payload: dict[str, Any], now: datetime) -> None:
    """social.sanction.changed.v1 → sanctions (без основания). Действующий social_ban отменяет неотвеченные вызовы на
    дуэль ученика (в обе стороны); принятая дуэль доигрывается."""
    user = _uuid(payload["user_id"])
    kind = payload.get("kind")
    if kind not in ("warning", "social_ban", "nickname_reset") or not await _alive(session, user):
        return
    at = parse_ts(payload.get("changed_at"), now)
    until = parse_ts(payload["until"], now) if payload.get("until") else None
    active = payload.get("active") is True
    values = {"user_id": user, "kind": kind, "until": until, "active": active, "changed_at": at}
    stmt = insert(Sanction).values(sanction_id=_uuid(payload["sanction_id"]), **values)
    applied = (await session.execute(stmt.on_conflict_do_update(
        index_elements=["sanction_id"], set_=values, where=Sanction.changed_at <= at)
        .returning(Sanction.sanction_id))).scalar()
    if applied is not None and kind == "social_ban" and active and (until is None or until > now):
        await session.execute(update(Duel).where(
            or_(Duel.challenger == user, Duel.opponent == user), Duel.status == "challenged",
        ).values(status="cancelled", pair_key=None, updated_at=now))


async def on_identity_profile(session: AsyncSession, payload: dict[str, Any], occurred_at: datetime,
                              now: datetime) -> None:
    """user.profile.updated.v1 (identity-consent) → learners.age_band, guardian_consent (доступ 14–17 к общей лиге).
    Запоздавшее событие не откатывает более новое; неизвестные значения не стирают известные."""
    user = _uuid(payload["user_id"])
    if not await _alive(session, user):
        return
    learner = await ensure_learner(session, user, now)
    if learner.profile_updated_at is not None and occurred_at < learner.profile_updated_at:
        return
    band = payload.get("age_band")
    if band in AGE_BANDS and learner.kind != "child":
        learner.age_band = str(band)
    consent = payload.get("guardian_consent")
    if consent in GUARDIAN_CONSENTS:
        learner.guardian_consent = str(consent)
    learner.profile_updated_at = occurred_at
    learner.updated_at = now


async def on_profile_export(session: AsyncSession, item: dict[str, Any], now: datetime, *,
                            seed: bool = True) -> None:
    """Начальная загрузка (повторное ревью, 🔴 Н1): элемент выгрузки identity-consent `profiles` {user_id, kind,
    age_band, guardian_consent, updated_at} → learners.age_band, guardian_consent. Согласие родителя, полученное
    раньше окна стрима (7 дней), иначе не дошло бы никогда. Поле заполняется, если пусто, либо если выгрузка новее
    profile_updated_at (событие user.profile.updated новее выгрузки не перетирается); неизвестные значения и null
    известное не стирают. Удалённые пропускаются (после блокировки); элемент без известных значений — тоже. Строка
    ученика создаётся (как событием профиля): иначе подросток, впервые открывший игру после загрузки, остался бы без
    согласия."""
    del seed  # только режим загрузки
    user = _uuid(item["user_id"])
    band, consent = item.get("age_band"), item.get("guardian_consent")
    band = band if band in AGE_BANDS else None
    consent = consent if consent in GUARDIAN_CONSENTS else None
    if (band is None and consent is None) or not await _alive(session, user):
        return
    at = parse_ts(item.get("updated_at"), now)
    learner = await ensure_learner(session, user, now)
    newer = learner.profile_updated_at is None or learner.profile_updated_at < at
    changed = False
    if band is not None and learner.kind != "child" and (learner.age_band is None or newer):
        changed = changed or learner.age_band != band
        learner.age_band = band
    if consent is not None and (learner.guardian_consent is None or newer):
        changed = changed or learner.guardian_consent != consent
        learner.guardian_consent = consent
    if newer:
        learner.profile_updated_at = at
    if changed or newer:
        learner.updated_at = now


async def on_diagnostics(session: AsyncSession, payload: dict[str, Any], now: datetime, *,
                         seed: bool = False) -> None:
    """diagnostics.completed.v1 → learner_levels: полоса лиги по provisional_level (без уровня — A0-A1)."""
    user = _uuid(payload["user_id"])
    pair = str(payload.get("pair_id") or "")[:16]
    if not pair or not await _alive(session, user):
        return
    at = parse_ts(payload.get("completed_at"), now)
    band = BAND_OF_LEVEL.get(str(payload.get("provisional_level")), DEFAULT_BAND)
    values = {"level_band": band, "result_id": _uuid(payload["result_id"]), "completed_at": at}
    stmt = insert(LearnerLevel).values(user_id=user, pair_id=pair, **values)
    if seed:
        await session.execute(stmt.on_conflict_do_nothing(index_elements=["user_id", "pair_id"]))
        return
    await session.execute(stmt.on_conflict_do_update(index_elements=["user_id", "pair_id"], set_=values,
                                                     where=LearnerLevel.completed_at <= at))

