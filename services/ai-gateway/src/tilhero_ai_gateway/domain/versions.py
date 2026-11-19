"""Версии инструкций агентов (INTERNAL_API §1.1, §1.5; admin.ts «Агенты и скиллы», AT-49).

Черновик (создать из текущей опубликованной или указанной версии; один на агента — 409 DRAFT_EXISTS) → правка
(только черновик — 409 VERSION_NOT_DRAFT; If-Match: updated_at — 409 VERSION_CONFLICT; под канарейкой — 409
VERSION_IN_CANARY) → прогон золотых тестов → публикация или канарейка (нужен прогон **этой** версии с этим телом и
текущим набором обязательных кейсов, passed_mandatory, не старше 14 дней — иначе 422 TESTS_REQUIRED /
TESTS_FAILED {case_ids}) → откат к прежней опубликованной (409 NO_PREVIOUS_VERSION).

Канарейка — проверенный черновик, обслуживающий долю учеников 1..50 % (`sha256(user_id + agent_id) mod 100`);
под канарейкой черновик заморожен (триггер БД). Публикация канареечной делает её основной; откат снимает канарейку.
Команды по одному агенту сериализуются advisory-блокировкой; каждая — аудит admin.audit.recorded.v1 (outbox).
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Final

from sqlalchemy import and_, func, select, text, update
from sqlalchemy.dialects.postgresql import distinct_on
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_ai_gateway.contracts import AgentVersionBody, AgentVersionPatch
from tilhero_ai_gateway.domain import jsonschema_lite
from tilhero_ai_gateway.domain.common import (
    audit_payload,
    emit_audit,
    iso_z,
    local_day_start,
    sha256_hex,
    version_object_id,
)
from tilhero_ai_gateway.domain.golden import active_cases, cases_hash, run_summary
from tilhero_ai_gateway.models import AgentRollout, AgentRow, AgentVersion, ModelRow, TestRunRow, UsageRow
from tilhero_common.errors import ApiError, conflict, not_found, too_many, unprocessable
from tilhero_common.internal_auth import Actor

LOCK_CLASS: Final = 811_402
RUNS_LOCK: Final = 811_403  # счётчик золотых прогонов за день — общий на все агенты
BODY_FIELDS: Final = ("instructions", "rules", "output_schema", "schema_version", "model_id", "fallback_model_id",
                      "temperature", "max_output_tokens", "timeout_ms", "max_cost_usd", "notes")
NULLABLE: Final = frozenset({"fallback_model_id", "notes"})
AV = AgentVersion

# Шаблон первого черновика агента без версий (planned-агенты): тесты всё равно обязательны до публикации
BLANK: Final[dict[str, Any]] = {
    "instructions": "", "rules": "", "output_schema": {"type": "object"}, "model_id": "claude-haiku-5-5",
    "fallback_model_id": None, "temperature": 0.2, "max_output_tokens": 600, "timeout_ms": 10000,
    "max_cost_usd": 0.01, "notes": None,
}


async def lock_agent(session: AsyncSession, agent_id: str) -> None:
    await session.execute(text("SELECT pg_advisory_xact_lock(:c, hashtext(:k))"), {"c": LOCK_CLASS, "k": agent_id})


# ---------------------------------------------------------------- чтение


async def get_agent(session: AsyncSession, agent_id: str) -> AgentRow:
    agent = await session.get(AgentRow, agent_id)
    if agent is None:
        raise not_found("AGENT_NOT_FOUND", "Агент не найден")
    return agent


def require_llm(agent: AgentRow) -> None:
    if agent.implementation != "llm":
        raise conflict("AGENT_NOT_LLM", "У агента правил или кода нет версий инструкций",
                       {"implementation": agent.implementation})


async def get_version(session: AsyncSession, agent_id: str, version: int, *, for_update: bool = False) -> AgentVersion:
    stmt = select(AV).where(AV.agent_id == agent_id, AV.version == version)
    if for_update:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    row = (await session.execute(stmt)).scalar_one_or_none()
    if row is None:
        raise not_found("VERSION_NOT_FOUND", f"Нет версии {version} агента {agent_id}")
    return row


async def rollout_of(session: AsyncSession, agent_id: str, *, for_update: bool = False) -> AgentRollout:
    stmt = select(AgentRollout).where(AgentRollout.agent_id == agent_id)
    if for_update:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    row = (await session.execute(stmt)).scalar_one_or_none()
    if row is None:
        raise conflict("AGENT_NOT_LLM", "У агента нет маршрутизации версий")
    return row


async def last_run(session: AsyncSession, agent_id: str, version: int | None = None, *,
                   finished: bool = False, providers: tuple[str, ...] | None = None) -> TestRunRow | None:
    stmt = select(TestRunRow).where(TestRunRow.agent_id == agent_id)
    if version is not None:
        stmt = stmt.where(TestRunRow.version == version)
    if finished:
        stmt = stmt.where(TestRunRow.status == "finished")
    if providers is not None:
        stmt = stmt.where(TestRunRow.provider.in_(providers))
    return (await session.execute(stmt.order_by(TestRunRow.seq.desc()).limit(1))).scalar_one_or_none()


async def versions_of(session: AsyncSession, agent_id: str) -> list[AgentVersion]:
    return list((await session.execute(select(AV).where(AV.agent_id == agent_id)
                                       .order_by(AV.version.desc()))).scalars().all())


# ---------------------------------------------------------------- тело и хеш


def _temperature(value: float | Decimal) -> Decimal:
    return Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def _cost(value: float | Decimal) -> Decimal:
    return Decimal(str(value)).quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP)


def body_of(row: AgentVersion) -> dict[str, Any]:
    return {"instructions": row.instructions, "rules": row.rules, "output_schema": row.output_schema,
            "schema_version": row.schema_version, "model_id": row.model_id,
            "fallback_model_id": row.fallback_model_id, "temperature": float(row.temperature),
            "max_output_tokens": row.max_output_tokens, "timeout_ms": row.timeout_ms,
            "max_cost_usd": float(row.max_cost_usd), "notes": row.notes}


def body_hash(body: dict[str, Any]) -> str:
    """Хеш поведения версии (без notes): после правки черновика прогон золотых тестов устаревает."""
    return sha256_hex({k: (str(_temperature(v)) if k == "temperature" else str(_cost(v)) if k == "max_cost_usd"
                           else v) for k, v in body.items() if k != "notes"})


def apply_body(row: AgentVersion, body: dict[str, Any]) -> None:
    row.instructions = body["instructions"]
    row.rules = body["rules"]
    row.output_schema = body["output_schema"]
    row.schema_version = body["schema_version"]
    row.model_id = body["model_id"]
    row.fallback_model_id = body["fallback_model_id"]
    row.temperature = _temperature(body["temperature"])
    row.max_output_tokens = body["max_output_tokens"]
    row.timeout_ms = body["timeout_ms"]
    row.max_cost_usd = _cost(body["max_cost_usd"])
    row.notes = body["notes"]
    row.body_hash = body_hash(body)


def body_issues(body: dict[str, Any], models: dict[str, ModelRow]) -> list[dict[str, str]]:
    """Проверки тела, которых нет в схеме полей: схема вывода (подмножество JSON Schema), модели из таблицы."""
    issues = [{"path": "output_schema", "message": p} for p in jsonschema_lite.check_schema(body["output_schema"])]
    for name in ("model_id", "fallback_model_id"):
        value = body.get(name)
        if value is not None and value not in models:
            issues.append({"path": name, "message": f"неизвестная модель {value}"})
    if body.get("fallback_model_id") is not None and body["fallback_model_id"] == body["model_id"]:
        issues.append({"path": "fallback_model_id", "message": "резервная модель совпадает с основной"})
    return issues


def version_invalid(issues: list[dict[str, str]]) -> ApiError:
    return unprocessable("VERSION_INVALID", "Версия не прошла проверку — исправьте отмеченные поля",
                         {"errors": issues[:50]})


async def models_map(session: AsyncSession) -> dict[str, ModelRow]:
    return {m.model_id: m for m in (await session.execute(select(ModelRow))).scalars().all()}


# ---------------------------------------------------------------- представления (ai.ts / admin.ts, без *_name)


def rollout_view(r: AgentRollout) -> dict[str, Any]:
    return {"agent_id": r.agent_id, "published_version": r.published_version, "canary_version": r.canary_version,
            "canary_percent": r.canary_percent, "previous_version": r.previous_version}


def is_canary(row: AgentVersion, rollout: AgentRollout | None) -> bool:
    return rollout is not None and rollout.canary_version == row.version


def version_view(row: AgentVersion, rollout: AgentRollout | None, run: TestRunRow | None) -> dict[str, Any]:
    """AgentVersion (ai.ts) + updated_at (для If-Match) и canary; имена сотрудников дополняет admin-bff по *_id/_by."""
    return {
        "agent_id": row.agent_id, "version": row.version, "status": row.status, **body_of(row),
        "author_id": row.author_id, "created_at": iso_z(row.created_at), "updated_at": iso_z(row.updated_at),
        "published_by": row.published_by, "published_at": iso_z(row.published_at),
        "last_test_run": run_summary(run) if run else None, "canary": is_canary(row, rollout),
    }


def version_row_view(row: AgentVersion, rollout: AgentRollout | None, run: TestRunRow | None) -> dict[str, Any]:
    """AgentVersionRow (admin.ts) с author_id / published_by вместо имён."""
    return {"version": row.version, "status": row.status, "model_id": row.model_id, "author_id": row.author_id,
            "created_at": iso_z(row.created_at), "published_at": iso_z(row.published_at),
            "published_by": row.published_by, "last_test_run": run_summary(run) if run else None,
            "canary": is_canary(row, rollout)}


def agent_view(a: AgentRow) -> dict[str, Any]:
    return {"agent_id": a.agent_id, "title": a.title, "purpose": a.purpose, "owner_role": a.owner_role,
            "implementation": a.implementation, "availability": a.availability, "planned_sprint": a.planned_sprint,
            "free_text": a.free_text, "implemented_in": a.implemented_in}


async def agent_rows(session: AsyncSession, now: datetime, agent_id: str | None = None) -> list[dict[str, Any]]:
    """AgentRow (admin.ts): реестр + маршрутизация + опубликованная версия + черновик + последний прогон +
    вызовы и доля unavailable за 7 дней (без золотых прогонов)."""
    agents_q = select(AgentRow).order_by(AgentRow.agent_id)
    if agent_id is not None:
        agents_q = agents_q.where(AgentRow.agent_id == agent_id)
    agents = list((await session.execute(agents_q)).scalars().all())
    rollouts = {r.agent_id: r for r in (await session.execute(select(AgentRollout))).scalars().all()}
    published = {v.agent_id: v for v in (await session.execute(select(AV).where(AV.status == "published")))
                 .scalars().all()}
    drafts = {aid: ver for aid, ver in (await session.execute(select(AV.agent_id, AV.version)
                                                              .where(AV.status == "draft"))).all()}
    runs = {r.agent_id: r for r in (await session.execute(
        select(TestRunRow).ext(distinct_on(TestRunRow.agent_id))
        .order_by(TestRunRow.agent_id, TestRunRow.seq.desc()))).scalars().all()}
    since = now - timedelta(days=7)
    stats = {aid: (int(calls), int(unavailable)) for aid, calls, unavailable in (await session.execute(
        select(UsageRow.agent_id, func.count(), func.count().filter(UsageRow.status == "unavailable"))
        .where(UsageRow.created_at >= since, UsageRow.status != "pending",
               func.coalesce(UsageRow.session_kind, "") != "golden")
        .group_by(UsageRow.agent_id))).all()}
    out = []
    for a in agents:
        pub = published.get(a.agent_id)
        calls, unavailable = stats.get(a.agent_id, (0, 0))
        rollout = rollouts.get(a.agent_id)
        out.append({
            **agent_view(a),
            "rollout": rollout_view(rollout) if rollout is not None and a.implementation == "llm" else None,
            "published": {"version": pub.version, "model_id": pub.model_id, "published_at": iso_z(pub.published_at),
                          "published_by": pub.published_by} if pub else None,
            "draft_version": drafts.get(a.agent_id),
            "last_test_run": run_summary(runs[a.agent_id]) if a.agent_id in runs else None,
            "calls_7d": calls,
            "unavailable_pct_7d": round(unavailable * 100 / calls, 1) if calls else None,
        })
    return out


async def agent_row(session: AsyncSession, agent_id: str, now: datetime) -> dict[str, Any]:
    rows = await agent_rows(session, now, agent_id)
    if not rows:
        raise not_found("AGENT_NOT_FOUND", "Агент не найден")
    return rows[0]


async def agent_detail(session: AsyncSession, agent_id: str, now: datetime) -> dict[str, Any]:
    """AgentRow & {versions: AgentVersionRow[]} — версии от новых к старым."""
    row = await agent_row(session, agent_id, now)
    rollout = await session.get(AgentRollout, agent_id)
    runs = {(r.version): r for r in (await session.execute(
        select(TestRunRow).where(TestRunRow.agent_id == agent_id).ext(distinct_on(TestRunRow.version))
        .order_by(TestRunRow.version, TestRunRow.seq.desc()))).scalars().all()}
    return {**row, "versions": [version_row_view(v, rollout, runs.get(v.version))
                                for v in await versions_of(session, agent_id)]}


async def version_detail(session: AsyncSession, row: AgentVersion) -> dict[str, Any]:
    rollout = await session.get(AgentRollout, row.agent_id)
    return version_view(row, rollout, await last_run(session, row.agent_id, row.version))


# ---------------------------------------------------------------- проверка тестов перед публикацией и канарейкой


async def require_tests(session: AsyncSession, row: AgentVersion, now: datetime, max_age_days: int,
                        providers: tuple[str, ...]) -> None:
    """Последний завершённый прогон этой версии на допустимом провайдере (stage/prod — только anthropic; fake —
    при AI_ALLOW_FAKE_TEST_PUBLISH на dev/e2e-стенде), не старше max_age_days, по текущему телу и набору обязательных
    кейсов, passed_mandatory."""
    run = await last_run(session, row.agent_id, row.version, finished=True, providers=providers)
    if run is None and "fake" not in providers and await last_run(session, row.agent_id, row.version,
                                                                  finished=True) is not None:
        raise unprocessable("TESTS_REQUIRED", "Нужен прогон золотых тестов на настоящем провайдере (anthropic)",
                            {"reason": "real_provider_required"})
    if run is None or run.started_at < now - timedelta(days=max_age_days):
        raise unprocessable("TESTS_REQUIRED", f"Нужен прогон золотых тестов этой версии не старше {max_age_days} дней",
                            {"reason": "no_recent_run"})
    if run.body_hash != row.body_hash:
        raise unprocessable("TESTS_REQUIRED", "Версия изменилась после прогона — запустите тесты снова",
                            {"reason": "version_changed"})
    cases = await active_cases(session, row.agent_id)
    if not any(c.mandatory for c in cases):
        raise unprocessable("TESTS_REQUIRED", "У агента нет обязательных золотых тестов",
                            {"reason": "no_mandatory_cases"})
    if run.cases_hash != cases_hash(cases):
        raise unprocessable("TESTS_REQUIRED", "Обязательные золотые тесты изменились после прогона — запустите снова",
                            {"reason": "cases_changed"})
    if not run.passed_mandatory:
        failed = [r["case_id"] for r in run.results if r.get("mandatory") and not r.get("passed")]
        raise unprocessable("TESTS_FAILED", "Обязательные золотые тесты не пройдены", {"case_ids": failed})


async def require_active_models(session: AsyncSession, row: AgentVersion) -> None:
    models = await models_map(session)
    bad = [m for m in (row.model_id, row.fallback_model_id) if m is not None and not
           (m in models and models[m].active)]
    if bad:
        raise unprocessable("MODEL_INACTIVE", "Модель версии выключена или неизвестна", {"models": bad})


# ---------------------------------------------------------------- команды


def _audit(actor: Actor, action: str, agent_id: str, version: int | None, *, before: dict[str, Any] | None = None,
           after: dict[str, Any] | None = None, reason: str | None = None,
           object_type: str = "agent_version") -> dict[str, Any]:
    return audit_payload(actor, action, object_type, version_object_id(agent_id, version), before=before,
                         after=after, reason=reason)


async def create_draft(session: AsyncSession, agent_id: str, from_version: int | None, actor: Actor,
                       now: datetime) -> AgentVersion:
    agent = await get_agent(session, agent_id)
    require_llm(agent)
    await lock_agent(session, agent_id)
    existing = await session.scalar(select(AV.version).where(AV.agent_id == agent_id, AV.status == "draft"))
    if existing is not None:
        raise conflict("DRAFT_EXISTS", "У агента уже есть черновик", {"version": existing})
    rollout = await rollout_of(session, agent_id)
    source_no = from_version if from_version is not None else rollout.published_version
    if source_no is None:
        source_no = await session.scalar(select(func.max(AV.version)).where(AV.agent_id == agent_id))
    if source_no is not None:
        source = await get_version(session, agent_id, int(source_no))
        body = body_of(source)
    else:
        body = {**BLANK, "schema_version": f"{agent_id}.v1"}
    max_version = int(await session.scalar(select(func.max(AV.version)).where(AV.agent_id == agent_id)) or 0)
    row = AV(id=uuid.uuid4(), agent_id=agent_id, version=max_version + 1, status="draft", author_id=actor.id,
             created_at=now, updated_by=actor.id, updated_at=now)
    apply_body(row, body)
    session.add(row)
    await session.flush()
    await emit_audit(session, _audit(actor, "ai.version_created", agent_id, row.version,
                                     after={"status": "draft", "from_version": source_no,
                                            "body_hash": row.body_hash}))
    return row


def _if_match(value: str | None) -> str | None:
    if value is None:
        return None
    v = value.strip()
    if v.startswith("W/"):
        v = v[2:]
    return v.strip('"')


async def update_draft(session: AsyncSession, agent_id: str, version: int, patch: AgentVersionPatch,
                       if_match: str | None, actor: Actor, now: datetime) -> AgentVersion:
    await get_agent(session, agent_id)
    await lock_agent(session, agent_id)
    row = await get_version(session, agent_id, version, for_update=True)
    if row.status != "draft":
        raise conflict("VERSION_NOT_DRAFT", "Править можно только черновик — создайте новую версию",
                       {"status": row.status})
    rollout = await rollout_of(session, agent_id)
    if is_canary(row, rollout):
        raise conflict("VERSION_IN_CANARY", "Черновик обслуживает канарейку — снимите её перед правкой")
    expected = _if_match(if_match)
    if expected is None:
        raise ApiError(428, "IF_MATCH_REQUIRED", "Нужен заголовок If-Match с updated_at версии")
    if expected != iso_z(row.updated_at):
        raise conflict("VERSION_CONFLICT", "Черновик изменился — обновите страницу",
                       {"updated_at": iso_z(row.updated_at)})
    changes = {k: getattr(patch, k) for k in patch.model_fields_set}
    nulls = [k for k, v in changes.items() if v is None and k not in NULLABLE]
    if nulls:
        raise version_invalid([{"path": k, "message": "поле не может быть пустым"} for k in nulls])
    body = {**body_of(row), **changes}
    try:
        AgentVersionBody.model_validate(body)
    except Exception as exc:  # pragma: no cover — поля уже проверены моделью патча
        raise version_invalid([{"path": "body", "message": type(exc).__name__}]) from None
    issues = body_issues(body, await models_map(session))
    if issues:
        raise version_invalid(issues)
    new_hash = body_hash(body)
    if new_hash == row.body_hash and body.get("notes") == row.notes:
        return row
    before = row.body_hash
    changed = sorted(k for k in changes if body_of(row).get(k) != body.get(k))
    apply_body(row, body)
    row.updated_by = actor.id
    row.updated_at = now
    await session.flush()
    await emit_audit(session, _audit(actor, "ai.version_updated", agent_id, version, before={"body_hash": before},
                                     after={"body_hash": row.body_hash, "fields": changed}))
    return row


async def delete_draft(session: AsyncSession, agent_id: str, version: int, actor: Actor) -> None:
    await get_agent(session, agent_id)
    await lock_agent(session, agent_id)
    row = await get_version(session, agent_id, version, for_update=True)
    if row.status != "draft":
        raise conflict("VERSION_NOT_DRAFT", "Удалить можно только черновик", {"status": row.status})
    if is_canary(row, await rollout_of(session, agent_id)):
        raise conflict("VERSION_IN_CANARY", "Черновик обслуживает канарейку — снимите её перед удалением")
    await session.delete(row)
    await session.flush()
    await emit_audit(session, _audit(actor, "ai.version_deleted", agent_id, version,
                                     before={"status": "draft", "body_hash": row.body_hash}))


async def publish(session: AsyncSession, agent_id: str, version: int, reason: str, actor: Actor, now: datetime,
                  max_age_days: int, providers: tuple[str, ...]) -> bool:
    """→ True — опубликована сейчас; False — уже опубликована (повтор — без изменений)."""
    agent = await get_agent(session, agent_id)
    require_llm(agent)
    await lock_agent(session, agent_id)
    row = await get_version(session, agent_id, version, for_update=True)
    rollout = await rollout_of(session, agent_id, for_update=True)
    if row.status == "published" and rollout.published_version == version:
        return False
    if row.status != "draft":
        raise conflict("VERSION_NOT_DRAFT", "Публикуется проверенный черновик; к прежней версии — откат",
                       {"status": row.status})
    await require_tests(session, row, now, max_age_days, providers)
    await require_active_models(session, row)
    previous = rollout.published_version
    was_canary = rollout.canary_version
    rollout.canary_version = None
    rollout.canary_percent = 0
    await session.flush()  # канарейка снята до смены статуса (CHECK canary ≠ published)
    if previous is not None:
        old = await get_version(session, agent_id, previous, for_update=True)
        old.status = "archived"
        old.archived_at = now
        await session.flush()
    row.status = "published"
    row.published_by = actor.id
    row.published_at = now
    rollout.previous_version = previous
    rollout.published_version = version
    rollout.updated_by = actor.id
    rollout.updated_at = now
    await session.flush()
    await emit_audit(session, _audit(actor, "ai.version_published", agent_id, version,
                                     before={"published_version": previous, "canary_version": was_canary},
                                     after={"published_version": version, "body_hash": row.body_hash,
                                            "model_id": row.model_id}, reason=reason))
    return True


async def set_canary(session: AsyncSession, agent_id: str, version: int, percent: int, reason: str, actor: Actor,
                     now: datetime, max_age_days: int, providers: tuple[str, ...]) -> None:
    agent = await get_agent(session, agent_id)
    require_llm(agent)
    await lock_agent(session, agent_id)
    row = await get_version(session, agent_id, version, for_update=True)
    rollout = await rollout_of(session, agent_id, for_update=True)
    if row.status != "draft":
        raise conflict("VERSION_NOT_DRAFT", "Канарейка — для проверенного черновика (не опубликованной версии)",
                       {"status": row.status})
    if rollout.published_version is None:
        raise conflict("NO_PUBLISHED_VERSION", "Канарейке нужна опубликованная основная версия")
    await require_tests(session, row, now, max_age_days, providers)
    await require_active_models(session, row)
    before = {"canary_version": rollout.canary_version, "canary_percent": rollout.canary_percent}
    rollout.canary_version = version
    rollout.canary_percent = percent
    rollout.updated_by = actor.id
    rollout.updated_at = now
    await session.flush()
    await emit_audit(session, _audit(actor, "ai.canary_set", agent_id, version, before=before,
                                     after={"canary_version": version, "canary_percent": percent,
                                            "body_hash": row.body_hash}, reason=reason, object_type="agent_rollout"))


async def clear_canary(session: AsyncSession, agent_id: str, reason: str, actor: Actor, now: datetime) -> None:
    agent = await get_agent(session, agent_id)
    require_llm(agent)
    await lock_agent(session, agent_id)
    rollout = await rollout_of(session, agent_id, for_update=True)
    if rollout.canary_version is None:
        raise conflict("NO_CANARY", "Канарейка не установлена")
    before = {"canary_version": rollout.canary_version, "canary_percent": rollout.canary_percent}
    rollout.canary_version = None
    rollout.canary_percent = 0
    rollout.updated_by = actor.id
    rollout.updated_at = now
    await session.flush()
    await emit_audit(session, _audit(actor, "ai.canary_cleared", agent_id, before["canary_version"], before=before,
                                     after={"canary_version": None, "canary_percent": 0}, reason=reason,
                                     object_type="agent_rollout"))


async def rollback(session: AsyncSession, agent_id: str, reason: str, actor: Actor, now: datetime) -> None:
    agent = await get_agent(session, agent_id)
    require_llm(agent)
    await lock_agent(session, agent_id)
    rollout = await rollout_of(session, agent_id, for_update=True)
    target_no = rollout.previous_version
    target = None
    if target_no is not None:
        target = (await session.execute(select(AV).where(AV.agent_id == agent_id, AV.version == target_no)
                                        .with_for_update())).scalar_one_or_none()
    if target is None or target.status != "archived" or target.published_at is None:
        raise conflict("NO_PREVIOUS_VERSION", "Нет прежней опубликованной версии для отката")
    current = rollout.published_version
    canary = rollout.canary_version
    rollout.canary_version = None
    rollout.canary_percent = 0
    await session.flush()
    if current is not None:
        old = await get_version(session, agent_id, current, for_update=True)
        old.status = "archived"
        old.archived_at = now
        await session.flush()
    target.status = "published"
    target.published_by = actor.id
    target.published_at = now
    target.archived_at = None
    rollout.published_version = target.version
    rollout.previous_version = current
    rollout.updated_by = actor.id
    rollout.updated_at = now
    await session.flush()
    await emit_audit(session, _audit(actor, "ai.rolled_back", agent_id, target.version,
                                     before={"published_version": current, "canary_version": canary},
                                     after={"published_version": target.version, "canary_version": None},
                                     reason=reason))


async def start_test_run(session: AsyncSession, agent_id: str, version: int, actor: Actor, provider: str,
                         now: datetime, *, daily_limit: int, tz: str) -> TestRunRow:
    """Прогон золотых тестов. Не больше `daily_limit` прогонов в сутки (день — по `tz`, Asia/Tashkent) на все агенты и
    всех сотрудников → 429 TEST_RUNS_LIMIT {retry_after}: прогон на anthropic — реальные деньги (ревью R1-11)."""
    agent = await get_agent(session, agent_id)
    require_llm(agent)
    await lock_agent(session, agent_id)
    row = await get_version(session, agent_id, version)
    running = await session.scalar(select(TestRunRow.run_id).where(
        TestRunRow.agent_id == agent_id, TestRunRow.version == version, TestRunRow.status == "running"))
    if running is not None:
        raise conflict("TEST_RUN_IN_PROGRESS", "Прогон этой версии уже идёт", {"run_id": str(running)})
    cases = await active_cases(session, agent_id)
    if not cases:
        raise unprocessable("NO_GOLDEN_CASES", "У агента нет золотых тестов")
    await session.execute(text("SELECT pg_advisory_xact_lock(:c, 0)"), {"c": RUNS_LOCK})
    day_start = local_day_start(now, tz)
    today = await session.scalar(select(func.count()).select_from(TestRunRow).where(TestRunRow.started_at >= day_start))
    if int(today or 0) >= daily_limit:
        retry_after = max(1, int((day_start + timedelta(days=1) - now).total_seconds()))
        raise too_many("TEST_RUNS_LIMIT", f"Лимит золотых прогонов на сегодня исчерпан ({daily_limit} в сутки)",
                       retry_after)
    run = TestRunRow(run_id=uuid.uuid4(), agent_id=agent_id, version=version, status="running", provider=provider,
                     body_hash=row.body_hash, cases_hash=cases_hash(cases), started_by=actor.id, started_at=now,
                     results=[], passed=0, failed=0, passed_mandatory=False, cost_usd=Decimal(0))
    session.add(run)
    await session.flush()
    await emit_audit(session, _audit(actor, "ai.test_run", agent_id, version,
                                     after={"run_id": str(run.run_id), "provider": provider, "cases": len(cases),
                                            "body_hash": row.body_hash}))
    return run


async def get_run(session: AsyncSession, agent_id: str, version: int, run_id: uuid.UUID) -> TestRunRow:
    run = await session.get(TestRunRow, run_id)
    if run is None or run.agent_id != agent_id or run.version != version:
        raise not_found("TEST_RUN_NOT_FOUND", "Прогон не найден")
    return run


async def fail_stale_runs(session: AsyncSession, now: datetime, minutes: int) -> int:
    """Прогон, оставшийся running после рестарта процесса, помечается failed (иначе версия навсегда «в прогоне»)."""
    result = await session.execute(
        update(TestRunRow)
        .where(and_(TestRunRow.status == "running", TestRunRow.started_at < now - timedelta(minutes=minutes)))
        .values(status="failed", finished_at=now).execution_options(synchronize_session=False))
    return int(getattr(result, "rowcount", 0) or 0)
