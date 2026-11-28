"""Сага удаления (§1.10, AT-72; спринт 7 — AT-82): consumer user.deletion.requested.v1 (только от identity-consent;
детские профили приходят отдельными запросами со своими user_id). Обезличенная daily_stats остаётся; под
`SET LOCAL tilhero.deletion = 'on'` физически удаляются реестр и значки (их триггеры иначе запрещают DELETE), кошелёк,
ученик, навыки, задания, владение, покупки, итоги занятий; рефералы спринта 6 — где ученик приглашённый или
пригласивший.

Спринт 7: удаляются проекции social (профиль сообщества, дружбы и блокировки в обе стороны, семья, санкции, полосы
уровня), участие в лигах и учёт парных уроков; итоги лиг (неизменяемы) обезличиваются (user_id → null в standings,
исключения без ученика); активные дуэли ученика отменяются, все его дуэли обезличиваются (challenger / opponent /
pair_key → null, счёт и результат остаются); реферальные награды обезличиваются. → ACK user.domain.deleted.v1 {domain:
gamification, mode: deleted}. Идемпотентна: повтор снова подтверждается. Сотрудники в assets.uploaded_by,
rules_versions, heroes, итогах и истории дуэлей не трогаются — это не данные учеников.

Спринт 8: пакеты тилов по заказам (til_orders) удаляются вместе с реестром; заказы и деньги хранит billing
(обезличенно)."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import delete, or_, select, text, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_gamification.domain.common import DOMAIN_DELETED, emit_event, lock_user
from tilhero_gamification.models import (
    Badge,
    Community,
    DeletedUser,
    Duel,
    EvidenceReward,
    FamilyMember,
    Idempotency,
    LeagueMember,
    LeagueResult,
    Learner,
    LearnerLevel,
    Ledger,
    Ownership,
    PairAward,
    Purchase,
    Quest,
    Referral,
    ReferralReward,
    Sanction,
    SessionReward,
    SkillState,
    SocialBlock,
    SocialFriend,
    TilOrder,
    Wallet,
)


async def delete_user_data(session: AsyncSession, user_id: uuid.UUID, request_id: uuid.UUID, now: datetime,
                           causation_id: str | None) -> None:
    await lock_user(session, user_id)
    await session.execute(text("SET LOCAL tilhero.deletion = 'on'"))
    for model in (Ledger, Badge, Wallet, Learner, SkillState, Quest, Ownership, Purchase, SessionReward,
                  EvidenceReward, Community, FamilyMember, Sanction, LearnerLevel, LeagueMember, PairAward,
                  TilOrder):
        await session.execute(delete(model).where(model.user_id == user_id))
    await session.execute(delete(Referral).where(or_(Referral.invitee_user_id == user_id,
                                                     Referral.inviter_user_id == user_id)))
    await session.execute(delete(SocialFriend).where(or_(SocialFriend.user_a == user_id,
                                                         SocialFriend.user_b == user_id)))
    await session.execute(delete(SocialBlock).where(or_(SocialBlock.blocker_user_id == user_id,
                                                        SocialBlock.blocked_user_id == user_id)))
    await _anonymize_results(session, user_id)
    # дуэли: активные — отменить (без событий: участник удалён), все — обезличить
    await session.execute(update(Duel).where(
        or_(Duel.challenger == user_id, Duel.opponent == user_id), Duel.status.in_(("challenged", "accepted")))
        .values(status="cancelled", updated_at=now))
    await session.execute(update(Duel).where(Duel.challenger == user_id)
                          .values(challenger=None, pair_key=None, updated_at=now))
    await session.execute(update(Duel).where(Duel.opponent == user_id)
                          .values(opponent=None, pair_key=None, updated_at=now))
    await session.execute(update(ReferralReward).where(ReferralReward.inviter_user_id == user_id)
                          .values(inviter_user_id=None))
    await session.execute(update(ReferralReward).where(ReferralReward.invitee_user_id == user_id)
                          .values(invitee_user_id=None))
    # ключи идемпотентности команд сотрудников над кошельком ученика (ответы содержат его операции)
    await session.execute(delete(Idempotency).where(Idempotency.scope == f"adjust:{user_id}"))
    await session.execute(text("SET LOCAL tilhero.deletion = 'off'"))
    await session.execute(insert(DeletedUser).values(user_id=user_id, request_id=request_id, deleted_at=now)
                          .on_conflict_do_nothing(index_elements=["user_id"]))
    await emit_event(session, DOMAIN_DELETED, {"user_id": str(user_id), "request_id": str(request_id),
                                               "domain": "gamification", "mode": "deleted"},
                     causation_id=causation_id)


async def _anonymize_results(session: AsyncSession, user_id: uuid.UUID) -> None:
    """Итоги лиг с учеником: user_id → null в standings, из исключённых — убрать (места и призы остаются)."""
    uid = str(user_id)
    rows = (await session.execute(select(LeagueResult).where(or_(
        LeagueResult.standings.contains([{"user_id": uid}]),
        LeagueResult.excluded_user_ids.contains([uid]))))).scalars().all()
    for r in rows:
        r.standings = [{**s, "user_id": None} if s.get("user_id") == uid else s for s in r.standings]
        r.excluded_user_ids = [u for u in r.excluded_user_ids if u != uid]
    await session.flush()
