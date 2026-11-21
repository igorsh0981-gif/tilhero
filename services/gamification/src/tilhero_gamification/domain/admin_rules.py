"""Правила игры в админке (§1.3, §1.11): черновик → проверка (валидатор) → активация со step-up и комментарием
≥ 10; откат — новая версия n+1 с payload архивной, сразу active. Проведённые операции не пересчитываются; задания
текущего дня доигрываются по своей версии. Одна draft и одна active (частичные UNIQUE), активная и архивные
неизменяемы (триггер)."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.errors import ApiError, conflict, not_found, unprocessable
from tilhero_common.internal_auth import Actor
from tilhero_gamification.domain import rules as rl
from tilhero_gamification.domain.common import RULES_ACTIVATED, emit_audit, emit_event, iso, staff_ref
from tilhero_gamification.models import RulesVersion


def version_not_found() -> ApiError:
    return not_found("RULES_VERSION_NOT_FOUND", "Версия правил не найдена")


def rules_invalid(errors: list[dict[str, str]]) -> ApiError:
    return unprocessable("RULES_INVALID", "Правила не прошли проверку", {"errors": errors})


def draft_conflict(updated_at: datetime | None) -> ApiError:
    return conflict("DRAFT_CONFLICT", "Черновик изменён другим сотрудником — обновите страницу",
                    {"updated_at": iso(updated_at)})


def summary(v: RulesVersion) -> dict[str, Any]:
    return {"version": v.version, "status": v.status, "comment": v.comment, "based_on": v.based_on,
            "created_by": staff_ref(v.created_by, v.created_by_name), "created_at": iso(v.created_at),
            "validated_at": iso(v.validated_at), "activated_by": staff_ref(v.activated_by, v.activated_by_name),
            "activated_at": iso(v.activated_at)}


async def _active(session: AsyncSession, *, lock: bool = False) -> RulesVersion:
    stmt = select(RulesVersion).where(RulesVersion.status == "active")
    if lock:
        stmt = stmt.with_for_update()
    return (await session.execute(stmt.execution_options(populate_existing=True))).scalar_one()


async def _draft(session: AsyncSession) -> RulesVersion | None:
    return (await session.execute(select(RulesVersion).where(RulesVersion.status == "draft").with_for_update()
                                  .execution_options(populate_existing=True))).scalar_one_or_none()


async def full(session: AsyncSession, v: RulesVersion) -> dict[str, Any]:
    active = v if v.status == "active" else await _active(session)
    return {**summary(v), "payload": v.payload, "diff": rl.diff(dict(active.payload), dict(v.payload)),
            "updated_at": iso(v.updated_at)}


async def list_versions(session: AsyncSession) -> dict[str, Any]:
    rows = (await session.execute(select(RulesVersion).order_by(RulesVersion.version.desc()))).scalars().all()
    return {"items": [summary(v) for v in rows]}


async def get_version(session: AsyncSession, version: int) -> dict[str, Any]:
    v = await session.get(RulesVersion, version)
    if v is None:
        raise version_not_found()
    return await full(session, v)


async def _lock_rules(session: AsyncSession) -> None:
    """Команды над версиями правил — по очереди (номер версии, одна draft/active)."""
    await session.execute(text("SELECT pg_advisory_xact_lock(:c, 0)"), {"c": 0x47414D52})  # 'GAMR'


async def _next_version(session: AsyncSession) -> int:
    return int(await session.scalar(select(func.coalesce(func.max(RulesVersion.version), 0))) or 0) + 1


async def put_draft(session: AsyncSession, actor: Actor, payload: Any, comment: str | None, based_on: int | None,
                    if_match: str | None, now: datetime) -> dict[str, Any]:
    """Создать или заменить черновик. Замена — только с If-Match = updated_at черновика (иначе DRAFT_CONFLICT);
    структурно неверный payload не сохраняется (422 RULES_INVALID)."""
    await _lock_rules(session)
    errors = rl.structural(rl.validate(payload))
    if errors:
        raise rules_invalid(errors)
    if based_on is not None and await session.get(RulesVersion, based_on) is None:
        raise version_not_found()
    draft = await _draft(session)
    if draft is None:
        if if_match:
            raise draft_conflict(None)
        draft = RulesVersion(version=await _next_version(session), status="draft", payload=payload,
                             comment=comment, based_on=based_on, created_by=actor.id[:64],
                             created_by_name=(actor.name or "")[:120], created_at=now, updated_at=now)
        session.add(draft)
        action = "game.rules.draft_created"
    else:
        if if_match is None or if_match.strip().strip('"') != iso(draft.updated_at):
            raise draft_conflict(draft.updated_at)
        draft.payload, draft.comment, draft.based_on = payload, comment, based_on
        draft.updated_at = now
        draft.validated_at = None
        action = "game.rules.draft_saved"
    await session.flush()
    await emit_audit(session, actor, action, "game_rules", str(draft.version),
                     after={"version": draft.version, "based_on": based_on})
    return await full(session, draft)


async def delete_draft(session: AsyncSession, actor: Actor) -> None:
    await _lock_rules(session)
    draft = await _draft(session)
    if draft is None:
        raise not_found("RULES_DRAFT_NOT_FOUND", "Черновика правил нет")
    version = draft.version
    await session.delete(draft)
    await emit_audit(session, actor, "game.rules.draft_deleted", "game_rules", str(version))


async def validate_draft(session: AsyncSession, actor: Actor, now: datetime) -> dict[str, Any]:
    """RulesValidation {ok, errors, warnings}; при ok ставит validated_at."""
    await _lock_rules(session)
    draft = await _draft(session)
    if draft is None:
        raise not_found("RULES_DRAFT_NOT_FOUND", "Черновика правил нет")
    errors = rl.validate(draft.payload)
    warns = rl.warnings(dict(draft.payload), dict((await _active(session)).payload)) if not errors else []
    if not errors:
        draft.validated_at = now
    await emit_audit(session, actor, "game.rules.validated", "game_rules", str(draft.version),
                     after={"ok": not errors, "errors": len(errors), "warnings": len(warns)})
    return {"ok": not errors, "errors": errors, "warnings": warns}


async def _activate(session: AsyncSession, actor: Actor, target: RulesVersion, comment: str, now: datetime,
                    action: str) -> dict[str, Any]:
    """Прежняя active → archived (первой: частичный UNIQUE на одну active), черновик → active."""
    active = await _active(session, lock=True)
    active.status = "archived"
    await session.flush()
    target.status = "active"
    target.comment = comment
    target.activated_by, target.activated_by_name, target.activated_at = actor.id[:64], (actor.name or "")[:120], now
    await session.flush()
    await emit_event(session, RULES_ACTIVATED, {"version": target.version, "based_on": target.based_on,
                                                "activated_by": actor.id, "activated_at": iso(now)})
    await emit_audit(session, actor, action, "game_rules", str(target.version),
                     before={"active_version": active.version},
                     after={"active_version": target.version, "based_on": target.based_on}, reason=comment)
    return await full(session, target)


async def activate_draft(session: AsyncSession, actor: Actor, comment: str, now: datetime) -> dict[str, Any]:
    await _lock_rules(session)
    draft = await _draft(session)
    if draft is None:
        raise not_found("RULES_DRAFT_NOT_FOUND", "Черновика правил нет")
    if draft.validated_at is None or draft.validated_at < draft.updated_at:
        raise conflict("RULES_NOT_VALIDATED", "Сначала проверьте черновик", {"updated_at": iso(draft.updated_at)})
    errors = rl.validate(draft.payload)
    if errors:
        raise rules_invalid(errors)
    return await _activate(session, actor, draft, comment, now, "game.rules.activated")


async def rollback(session: AsyncSession, actor: Actor, version: int, comment: str, now: datetime) -> dict[str, Any]:
    """Новая версия n+1 с payload архивной, based_on = version, сразу active. Есть черновик — 409 RULES_STATE
    {draft_version} (сначала удалить); payload архивной снова проходит валидатор (422 RULES_INVALID). Версия до
    спринта 7 (без league / duel / pair_lesson) дополняется этими разделами активной версии."""
    await _lock_rules(session)
    source = await session.get(RulesVersion, version)
    if source is None:
        raise version_not_found()
    if source.status != "archived":
        raise conflict("RULES_STATE", "Откатиться можно только на архивную версию", {"status": source.status})
    draft = await _draft(session)
    if draft is not None:
        raise conflict("RULES_STATE", "Сначала удалите черновик правил", {"draft_version": draft.version})
    active = await _active(session, lock=True)
    payload = rl.with_social_sections(dict(source.payload), dict(active.payload))
    errors = rl.validate(payload)
    if errors:
        raise rules_invalid(errors)
    active.status = "archived"
    await session.flush()
    target = RulesVersion(version=await _next_version(session), status="active", payload=payload,
                          comment=comment, based_on=version, created_by=actor.id[:64],
                          created_by_name=(actor.name or "")[:120], created_at=now, updated_at=now, validated_at=now,
                          activated_by=actor.id[:64], activated_by_name=(actor.name or "")[:120], activated_at=now)
    session.add(target)
    await session.flush()
    await emit_event(session, RULES_ACTIVATED, {"version": target.version, "based_on": version,
                                                "activated_by": actor.id, "activated_at": iso(now)})
    await emit_audit(session, actor, "game.rules.rolled_back", "game_rules", str(target.version),
                     before={"active_version": active.version},
                     after={"active_version": target.version, "based_on": version}, reason=comment)
    return await full(session, target)
