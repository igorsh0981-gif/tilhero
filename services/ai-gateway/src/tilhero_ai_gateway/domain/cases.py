"""Золотые кейсы агента — CRUD (admin.ts: GET|POST …/golden-cases, PATCH|DELETE /golden-cases/{case_id};
удаление = архив). Вход проверяется по контракту контекста агента (ai.ts), проверки — по GoldenCheck."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_ai_gateway.contracts import validate_golden
from tilhero_ai_gateway.domain.common import audit_payload, emit_audit, iso_z, sha256_hex
from tilhero_ai_gateway.domain.versions import get_agent, require_llm
from tilhero_ai_gateway.models import GoldenCaseRow
from tilhero_common.errors import conflict, not_found, unprocessable
from tilhero_common.internal_auth import Actor


def case_view(c: GoldenCaseRow) -> dict[str, Any]:
    """GoldenCase (ai.ts); created_by — id (имя дополняет admin-bff)."""
    return {"case_id": c.case_id, "agent_id": c.agent_id, "title": c.title, "input": c.input, "checks": c.checks,
            "mandatory": c.mandatory, "created_by": c.created_by, "created_at": iso_z(c.created_at),
            "archived_at": iso_z(c.archived_at)}


def _invalid(errors: list[dict[str, str]]) -> Exception:
    return unprocessable("GOLDEN_CASE_INVALID", "Золотой тест не прошёл проверку", {"errors": errors[:50]})


async def list_cases(session: AsyncSession, agent_id: str, *, include_archived: bool, after: str | None,
                     limit: int) -> tuple[list[GoldenCaseRow], bool]:
    await get_agent(session, agent_id)
    stmt = select(GoldenCaseRow).where(GoldenCaseRow.agent_id == agent_id)
    if not include_archived:
        stmt = stmt.where(GoldenCaseRow.archived_at.is_(None))
    if after is not None:
        stmt = stmt.where(GoldenCaseRow.case_id > after)
    rows = list((await session.execute(stmt.order_by(GoldenCaseRow.case_id).limit(limit + 1))).scalars().all())
    return rows[:limit], len(rows) > limit


async def get_case(session: AsyncSession, case_id: str, *, for_update: bool = False) -> GoldenCaseRow:
    stmt = select(GoldenCaseRow).where(GoldenCaseRow.case_id == case_id)
    if for_update:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    row = (await session.execute(stmt)).scalar_one_or_none()
    if row is None:
        raise not_found("GOLDEN_CASE_NOT_FOUND", "Золотой тест не найден")
    return row


def _fingerprint(c: GoldenCaseRow) -> str:
    return sha256_hex([c.title, c.input, c.checks, c.mandatory])


async def create_case(session: AsyncSession, agent_id: str, title: str, raw_input: Any, raw_checks: Any,
                      mandatory: bool, actor: Actor, now: datetime) -> GoldenCaseRow:
    agent = await get_agent(session, agent_id)
    require_llm(agent)
    norm_input, checks, errors = validate_golden(agent_id, raw_input, raw_checks)
    if errors or norm_input is None or checks is None:
        raise _invalid(errors)
    row = GoldenCaseRow(case_id=f"{agent_id.replace('_', '-')[:40]}-{uuid.uuid4().hex[:10]}", agent_id=agent_id,
                        title=title, input=norm_input, checks=checks, mandatory=mandatory, created_by=actor.id,
                        created_at=now)
    session.add(row)
    await session.flush()
    await emit_audit(session, audit_payload(actor, "ai.golden_case_created", "golden_case", row.case_id,
                                            after={"agent_id": agent_id, "mandatory": mandatory,
                                                   "hash": _fingerprint(row)}))
    return row


async def update_case(session: AsyncSession, case_id: str, changes: dict[str, Any], actor: Actor) -> GoldenCaseRow:
    row = await get_case(session, case_id, for_update=True)
    if row.archived_at is not None:
        raise conflict("GOLDEN_CASE_ARCHIVED", "Тест в архиве — создайте новый")
    raw_input = changes.get("input", row.input)
    raw_checks = changes.get("checks", row.checks)
    norm_input, checks, errors = validate_golden(row.agent_id, raw_input, raw_checks)
    if errors or norm_input is None or checks is None:
        raise _invalid(errors)
    before = _fingerprint(row)
    if "title" in changes:
        row.title = changes["title"]
    if "mandatory" in changes:
        row.mandatory = bool(changes["mandatory"])
    row.input = norm_input
    row.checks = checks
    if _fingerprint(row) == before:
        return row
    await session.flush()
    await emit_audit(session, audit_payload(actor, "ai.golden_case_updated", "golden_case", row.case_id,
                                            before={"hash": before},
                                            after={"hash": _fingerprint(row), "mandatory": row.mandatory,
                                                   "fields": sorted(changes)}))
    return row


async def archive_case(session: AsyncSession, case_id: str, actor: Actor, now: datetime) -> None:
    row = await get_case(session, case_id, for_update=True)
    if row.archived_at is not None:
        return
    row.archived_at = now
    await session.flush()
    await emit_audit(session, audit_payload(actor, "ai.golden_case_archived", "golden_case", row.case_id,
                                            before={"archived_at": None}, after={"archived_at": iso_z(now)}))
