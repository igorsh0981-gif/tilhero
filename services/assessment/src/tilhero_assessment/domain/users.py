"""Ученик в assessment: отметка удаления и сага удаления (TG-FR-006)."""

from __future__ import annotations

import uuid

from sqlalchemy import delete
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_assessment.domain.common import DOMAIN_DELETED, emit_event, lock_user, user_deleted
from tilhero_assessment.models import Appeal, DeletedUser, Evaluation, Flag


async def ensure_not_deleted(session: AsyncSession, user_id: uuid.UUID) -> None:
    if await session.get(DeletedUser, user_id) is not None:
        raise user_deleted()


async def delete_user_data(session: AsyncSession, user_id: uuid.UUID, request_id: uuid.UUID,
                           causation_id: str | None) -> None:
    """Физическое удаление апелляций, QA-флагов и всех оценок ученика (с цепочками переоценок) + ACK саге
    `user.domain.deleted.v1 {domain: assessment, mode: deleted}`. Агрегаты статистики не хранятся — удалять
    обезличенные копии не нужно. Повтор саги снова подтверждается."""
    await lock_user(session, user_id)
    await session.execute(delete(Appeal).where(Appeal.user_id == user_id))
    await session.execute(delete(Flag).where(Flag.user_id == user_id))
    # одна инструкция: самоссылки supersedes внутри цепочек ученика проверяются в конце инструкции
    await session.execute(delete(Evaluation).where(Evaluation.user_id == user_id))
    await session.execute(
        insert(DeletedUser).values(user_id=user_id, request_id=request_id).on_conflict_do_nothing(
            index_elements=["user_id"])
    )
    await emit_event(session, DOMAIN_DELETED,
                     {"user_id": str(user_id), "request_id": str(request_id), "domain": "assessment",
                      "mode": "deleted"}, causation_id=causation_id)
