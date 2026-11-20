"""Проверки удержания навыка (INTERNAL_API §1.5, APP-MEM-05): 7 и 30 дней после «демонстрирует».

- Постановка — consumer `skills.state.changed.v1` (только от diagnostics): `→ demonstrated` — проверка d7 со сроком
  occurred_at + 7 дней (новая цепочка; прежняя незавершённая отменяется); выход из demonstrated — незавершённые
  проверки навыка отменяются.
- Задания — контрольные задания опубликованных уроков навыка (catalog `check-items`, с ключом — только в memory):
  3 при постановке в сессию, сначала из уроков, не встречавшихся в двух последних проверках навыка; меньше 2 —
  проверка отменяется (no_items), состояние навыка не меняется.
- Результат — после последнего задания блока: верно ≥ 2 из 3 → passed. d7 passed → d30 (demonstrated_at + 30 дней,
  не раньше чем через 7 дней); d30 passed → цепочка закончена (diagnostics → retained); провал: 1-й — та же стадия
  через 3 дня, 2-й подряд — цепочка закончена (diagnostics → learning). Каждый результат →
  `memory.retention.checked.v1`. XP и игровые события проверки не дают.
- Нет активности 14 дней — срок переносится на +1 день (tick), проверка не проваливается; первое повторение после
  возвращения её берёт.
"""

from __future__ import annotations

import math
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any, Final

from sqlalchemy import or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_memory.domain import learners
from tilhero_memory.domain.common import RETENTION_CHECKED, emit_event, iso, lock_user
from tilhero_memory.domain.tasks import valid_check_item
from tilhero_memory.models import DeletedUser, RetentionCheck

OPEN: Final = ("scheduled", "in_session")
D7_DAYS: Final = 7
D30_DAYS: Final = 30
RETRY_DAYS: Final = 3
PASS_SHARE: Final = 2 / 3


def _uuid(value: Any) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(value)) if value else None
    except ValueError:
        return None


async def _cancel_open(db: AsyncSession, user_id: uuid.UUID, pair_id: str, skill_id: str, reason: str,
                       now: datetime) -> None:
    await db.execute(update(RetentionCheck).where(
        RetentionCheck.user_id == user_id, RetentionCheck.pair_id == pair_id, RetentionCheck.skill_id == skill_id,
        RetentionCheck.status.in_(OPEN)).values(status="cancelled", cancel_reason=reason, updated_at=now))


async def on_skills_changed(db: AsyncSession, payload: dict[str, Any], occurred_at: datetime, now: datetime) -> None:
    user_id = uuid.UUID(str(payload["user_id"]))
    pair_id = str(payload["pair_id"])[:16]
    await lock_user(db, user_id)  # до проверки удаления: сага держит ту же блокировку
    if await db.get(DeletedUser, user_id) is not None:
        return
    at = occurred_at.astimezone(UTC)
    for ch in payload.get("changes") or []:
        if not isinstance(ch, dict) or not isinstance(ch.get("skill_id"), str):
            continue
        skill_id, frm, to = ch["skill_id"][:64], ch.get("from"), ch.get("to")
        if to in ("not_started", "learning", "demonstrated", "retained"):
            await learners.upsert_skill(db, user_id, pair_id, skill_id, str(to), at)
        if to == "demonstrated" and frm != "demonstrated":
            await _cancel_open(db, user_id, pair_id, skill_id, "restarted", now)
            await db.flush()
            db.add(RetentionCheck(check_id=uuid.uuid4(), user_id=user_id, pair_id=pair_id, skill_id=skill_id,
                                  chain_id=uuid.uuid4(), stage="d7", demonstrated_at=at,
                                  evidence_id=_uuid(ch.get("evidence_id")), due_at=at + timedelta(days=D7_DAYS),
                                  status="scheduled", attempt=1, consecutive_failures=0, postponed=0, items=[],
                                  created_at=now, updated_at=now))
            await db.flush()
        elif frm == "demonstrated" and to != "demonstrated":
            await _cancel_open(db, user_id, pair_id, skill_id, "state_changed", now)


async def due_checks(db: AsyncSession, user_id: uuid.UUID, pair_id: str, now: datetime,
                     limit: int) -> list[RetentionCheck]:
    """Проверки со сроком (или перенесённые из-за отсутствия активности — их берёт первое повторение)."""
    return list((await db.execute(select(RetentionCheck).where(
        RetentionCheck.user_id == user_id, RetentionCheck.pair_id == pair_id, RetentionCheck.status == "scheduled",
        or_(RetentionCheck.due_at <= now, RetentionCheck.postponed > 0),
    ).order_by(RetentionCheck.due_at, RetentionCheck.check_id).limit(limit))).scalars().all())


async def recent_lessons(db: AsyncSession, check: RetentionCheck) -> set[str]:
    """Уроки заданий двух последних завершённых проверок этого навыка."""
    rows = (await db.execute(select(RetentionCheck.items).where(
        RetentionCheck.user_id == check.user_id, RetentionCheck.pair_id == check.pair_id,
        RetentionCheck.skill_id == check.skill_id, RetentionCheck.status.in_(("passed", "failed")),
    ).order_by(RetentionCheck.checked_at.desc()).limit(2))).scalars().all()
    return {str(i.get("lesson_id")) for items in rows for i in items or [] if isinstance(i, dict)}


def choose_items(data: dict[str, Any], seen_lessons: set[str], n: int, skill_id: str | None = None
                 ) -> list[dict[str, Any]]:
    """До n заданий: сначала уроки, не встречавшиеся в двух последних проверках; в уроке — сначала задания самого
    навыка (у урока навыку принадлежат не все задания); по урокам — по кругу."""
    valid = [x for x in data.get("items") or []
             if isinstance(x, dict) and isinstance(x.get("lesson_id"), str) and isinstance(x.get("version"), int)
             and valid_check_item(x.get("item"))]
    groups: dict[str, list[dict[str, Any]]] = {}
    for x in valid:
        groups.setdefault(x["lesson_id"], []).append(x)
    for lid in groups:
        groups[lid].sort(key=lambda x: x["item"].get("skill_id") != skill_id if skill_id else False)
    first = list(groups)
    ordered = sorted(groups, key=lambda lid: (lid in seen_lessons, first.index(lid)))
    out: list[dict[str, Any]] = []
    while len(out) < n and any(groups[lid] for lid in ordered):
        for lid in ordered:
            if groups[lid] and len(out) < n:
                out.append(groups[lid].pop(0))
    return out


def required_correct(total: int) -> int:
    return max(1, math.ceil(total * PASS_SHARE - 1e-9))


async def finalize(db: AsyncSession, check: RetentionCheck, correct: int, total: int, now: datetime) -> bool:
    """Итог блока проверки → статус, следующая стадия или повтор, событие. Отменённая (навык сменил состояние) —
    без итога (False)."""
    if check.status != "in_session":
        return False
    passed = correct >= required_correct(total)
    check.status = "passed" if passed else "failed"
    check.result = {"correct": correct, "total": total}
    check.checked_at = now
    check.updated_at = now
    failures = 0 if passed else min(check.consecutive_failures + 1, 2)
    check.consecutive_failures = failures
    await db.flush()
    nxt: RetentionCheck | None = None
    if passed and check.stage == "d7":
        due = max(check.demonstrated_at + timedelta(days=D30_DAYS), now + timedelta(days=D7_DAYS))
        nxt = RetentionCheck(check_id=uuid.uuid4(), user_id=check.user_id, pair_id=check.pair_id,
                             skill_id=check.skill_id, chain_id=check.chain_id, stage="d30",
                             demonstrated_at=check.demonstrated_at, evidence_id=check.evidence_id, due_at=due,
                             status="scheduled", attempt=1, consecutive_failures=0, postponed=0, items=[],
                             skill_title=check.skill_title, created_at=now, updated_at=now)
    elif not passed and failures == 1:
        nxt = RetentionCheck(check_id=uuid.uuid4(), user_id=check.user_id, pair_id=check.pair_id,
                             skill_id=check.skill_id, chain_id=check.chain_id, stage=check.stage,
                             demonstrated_at=check.demonstrated_at, evidence_id=check.evidence_id,
                             due_at=now + timedelta(days=RETRY_DAYS), status="scheduled",
                             attempt=check.attempt + 1, consecutive_failures=1, postponed=0, items=[],
                             skill_title=check.skill_title, created_at=now, updated_at=now)
    if nxt is not None:
        db.add(nxt)
    await emit_event(db, RETENTION_CHECKED, {
        "check_id": str(check.check_id), "user_id": str(check.user_id), "pair_id": check.pair_id,
        "skill_id": check.skill_id, "stage": check.stage, "passed": passed, "consecutive_failures": failures,
        "evidence_id": str(check.evidence_id) if check.evidence_id else None, "checked_at": iso(now)})
    return True


async def release(db: AsyncSession, session_id: uuid.UUID, now: datetime) -> None:
    """Сессия отменена или истекла посреди блока проверки → проверка снова ждёт следующего повторения."""
    await db.execute(update(RetentionCheck).where(
        RetentionCheck.session_id == session_id, RetentionCheck.status == "in_session",
    ).values(status="scheduled", session_id=None, updated_at=now))


def row_view(c: RetentionCheck) -> dict[str, Any]:
    """RetentionCheckRow (admin.ts)."""
    return {"check_id": str(c.check_id), "skill_id": c.skill_id, "skill_title": c.skill_title, "stage": c.stage,
            "status": c.status, "due_at": iso(c.due_at), "checked_at": iso(c.checked_at), "result": c.result,
            "consecutive_failures": c.consecutive_failures}
