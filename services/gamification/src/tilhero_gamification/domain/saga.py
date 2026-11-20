"""Сага удаления (§1.10, AT-72): consumer user.deletion.requested.v1 (только от identity-consent; детские профили
приходят отдельными запросами со своими user_id). Обезличенная daily_stats остаётся; под
`SET LOCAL tilhero.deletion = 'on'` физически удаляются реестр и значки (их триггеры иначе запрещают DELETE), кошелёк,
ученик, навыки, задания, владение, покупки, итоги занятий; рефералы — где ученик приглашённый или пригласивший →
ACK user.domain.deleted.v1 {domain: gamification, mode: deleted}. Идемпотентна: повтор снова подтверждается.
Сотрудники в assets.uploaded_by, rules_versions и heroes не трогаются — это не данные учеников."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import delete, or_, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_gamification.domain.common import DOMAIN_DELETED, emit_event, lock_user
from tilhero_gamification.models import (
    Badge,
    DeletedUser,
    EvidenceReward,
    Idempotency,
    Learner,
    Ledger,
    Ownership,
    Purchase,
    Quest,
    Referral,
    SessionReward,
    SkillState,
    Wallet,
)


async def delete_user_data(session: AsyncSession, user_id: uuid.UUID, request_id: uuid.UUID, now: datetime,
                           causation_id: str | None) -> None:
    await lock_user(session, user_id)
    await session.execute(text("SET LOCAL tilhero.deletion = 'on'"))
    for model in (Ledger, Badge, Wallet, Learner, SkillState, Quest, Ownership, Purchase, SessionReward,
                  EvidenceReward):
        await session.execute(delete(model).where(model.user_id == user_id))
    await session.execute(delete(Referral).where(or_(Referral.invitee_user_id == user_id,
                                                     Referral.inviter_user_id == user_id)))
    # ключи идемпотентности команд сотрудников над кошельком ученика (ответы содержат его операции)
    await session.execute(delete(Idempotency).where(Idempotency.scope == f"adjust:{user_id}"))
    await session.execute(text("SET LOCAL tilhero.deletion = 'off'"))
    await session.execute(insert(DeletedUser).values(user_id=user_id, request_id=request_id, deleted_at=now)
                          .on_conflict_do_nothing(index_elements=["user_id"]))
    await emit_event(session, DOMAIN_DELETED, {"user_id": str(user_id), "request_id": str(request_id),
                                               "domain": "gamification", "mode": "deleted"},
                     causation_id=causation_id)
