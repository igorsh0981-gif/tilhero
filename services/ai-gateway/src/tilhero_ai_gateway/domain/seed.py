"""Сид версий v1 и золотых тестов (миграция 0002, PLAN поток G): файлы автора инструкций → опубликованные версии.

Формат каталога (`migrations/seed/`, путь — настройка SEED_DIR):
- `agents/<agent_id>.v<N>.json` — тело версии (ai.ts AgentVersion): instructions, rules, output_schema,
  schema_version, model_id, fallback_model_id, temperature, max_output_tokens, timeout_ms, max_cost_usd, notes;
- `golden/<agent_id>.json` — массив `{case_id, title, input: {audience, context}, checks: GoldenCheck[], mandatory}`.

Весь набор проверяется до записи: агент — LLM из реестра, тело — по полям и пределам, схема вывода — поддерживаемое
подмножество JSON Schema с корнем-объектом, модели — из таблицы models, контексты кейсов — по ai.ts агента, проверки —
GoldenCheck, case_id уникальны. Любая ошибка → SeedInvalid со списком, миграция падает и ничего не пишет.

Публикует системный автор seed (00000000-0000-4000-a000-000000005eed) с аудитом `ai.version_published` (outbox).
Повторный прогон с тем же содержимым ничего не меняет; изменённое тело — новая опубликованная версия (прежняя →
archived); тело, которое сид уже публиковал раньше, повторно не публикуется (поздняя миграция не откатывается ранней);
версии, опубликованные сотрудниками, сид не трогает. Откат 0002 удаляет только записи автора seed.

Изменения сида после 0002 — отдельные миграции с собственным каталогом-«накладкой» `<SEED_DIR>/<ревизия>/` в том же
формате (`agents/<agent_id>.v<N>.json`, `golden/<agent_id>.json` — только новые кейсы): опубликованная версия
неизменяема (триггер), поэтому новые параметры — новая версия (0003: `independent_evaluator` v2 и детский кейс).

Накладка может создавать версию **черновиком** (`apply_seed_drafts`, 0004: `teaching_coach` v2 с `gloss_word`):
публикация — после прогона золотых тестов (prod — сотрудник на anthropic; dev/e2e-стенд — автоматически на fake,
`domain/stand.py`). Черновик не создаётся, если у агента уже есть черновик (сотрудника) — предупреждение в лог
миграции; тело, уже записанное сидом раньше (в любом статусе), заново не создаётся.
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Final

import sqlalchemy as sa
from pydantic import ValidationError
from sqlalchemy.dialects import postgresql as pg
from sqlalchemy.engine import Connection

from tilhero_ai_gateway.contracts import AgentVersionBody, error_list, validate_golden
from tilhero_ai_gateway.domain import jsonschema_lite
from tilhero_ai_gateway.domain.common import AUDIT_EVENT, PRODUCER, SEED_ACTOR_ID, audit_payload, version_object_id
from tilhero_ai_gateway.domain.registry import LLM_AGENT_IDS
from tilhero_ai_gateway.domain.versions import _cost, _temperature, body_hash
from tilhero_common.messaging import make_envelope

VERSION_FILE: Final = re.compile(r"^(?P<agent>[a-z_]+)\.v(?P<n>[1-9][0-9]*)\.json$")
CASE_ID: Final = re.compile(r"^[a-z0-9][a-z0-9._-]{1,63}$")
SEED_REASON: Final = "Сид инструкций агентов спринта 4"
DRAFT_REASON: Final = "Сид: черновик новой версии — публикация после прогона золотых тестов"
log = logging.getLogger("tilhero.ai_gateway.seed")


class SeedInvalid(RuntimeError):
    def __init__(self, problems: list[str]) -> None:
        self.problems = problems
        head = "\n".join(problems[:60])
        more = f"\n… ещё {len(problems) - 60}" if len(problems) > 60 else ""
        super().__init__(f"Сид агентов не прошёл проверку ({len(problems)}):\n{head}{more}")


@dataclass
class Seed:
    versions: dict[str, dict[str, Any]] = field(default_factory=dict)  # agent_id → тело
    cases: list[dict[str, Any]] = field(default_factory=list)  # {case_id, agent_id, title, input, checks, mandatory}


def _read(path: Path, problems: list[str]) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        problems.append(f"{path.name}: не JSON ({type(exc).__name__})")
        return None


def load_seed_dir(directory: Path, models: set[str] | None = None) -> Seed:
    """Читает и проверяет каталог сида. Нет каталога — пустой сид. Ошибки — SeedInvalid."""
    seed = Seed()
    problems: list[str] = []
    agents_dir, golden_dir = directory / "agents", directory / "golden"
    if agents_dir.is_dir():
        for path in sorted(agents_dir.iterdir()):
            if not path.is_file() or path.suffix != ".json":
                continue
            m = VERSION_FILE.match(path.name)
            if m is None:
                problems.append(f"agents/{path.name}: имя файла — <agent_id>.v<N>.json")
                continue
            agent_id = m.group("agent")
            if agent_id not in LLM_AGENT_IDS:
                problems.append(f"agents/{path.name}: {agent_id} — не LLM-агент реестра")
                continue
            if agent_id in seed.versions:
                problems.append(f"agents/{path.name}: у агента {agent_id} больше одного файла версии")
                continue
            raw = _read(path, problems)
            if raw is None:
                continue
            body = _check_body(f"agents/{path.name}", raw, models, problems)
            if body is not None:
                seed.versions[agent_id] = body
    if golden_dir.is_dir():
        seen: set[str] = set()
        for path in sorted(golden_dir.iterdir()):
            if not path.is_file() or path.suffix != ".json":
                continue
            agent_id = path.stem
            if agent_id not in LLM_AGENT_IDS:
                problems.append(f"golden/{path.name}: {agent_id} — не LLM-агент реестра")
                continue
            raw = _read(path, problems)
            if raw is None:
                continue
            if not isinstance(raw, list):
                problems.append(f"golden/{path.name}: ожидается массив кейсов")
                continue
            for i, item in enumerate(raw):
                case = _check_case(f"golden/{path.name}[{i}]", agent_id, item, seen, problems)
                if case is not None:
                    seed.cases.append(case)
    if problems:
        raise SeedInvalid(problems)
    return seed


def _check_body(where: str, raw: Any, models: set[str] | None, problems: list[str]) -> dict[str, Any] | None:
    try:
        model = AgentVersionBody.model_validate(raw)
    except ValidationError as exc:
        problems.extend(f"{where}: {e['path']} {e['message']}" for e in error_list(exc))
        return None
    body = model.model_dump(mode="json")
    problems_before = len(problems)
    problems.extend(f"{where}: output_schema {p}" for p in jsonschema_lite.check_schema(body["output_schema"]))
    if models is not None:
        for name in ("model_id", "fallback_model_id"):
            if body.get(name) is not None and body[name] not in models:
                problems.append(f"{where}: {name} {body[name]} — нет в таблице models")
    if body.get("fallback_model_id") is not None and body["fallback_model_id"] == body["model_id"]:
        problems.append(f"{where}: fallback_model_id совпадает с model_id")
    return body if len(problems) == problems_before else None


def _check_case(where: str, agent_id: str, item: Any, seen: set[str], problems: list[str]) -> dict[str, Any] | None:
    if not isinstance(item, dict):
        problems.append(f"{where}: кейс — объект")
        return None
    extra = set(item) - {"case_id", "title", "input", "checks", "mandatory"}
    if extra:
        problems.append(f"{where}: лишние поля {sorted(extra)}")
    case_id, title, mandatory = item.get("case_id"), item.get("title"), item.get("mandatory")
    ok = not extra
    if not isinstance(case_id, str) or not CASE_ID.match(case_id):
        problems.append(f"{where}: case_id — [a-z0-9][a-z0-9._-]{{1,63}}")
        ok = False
    elif case_id in seen:
        problems.append(f"{where}: case_id {case_id} повторяется")
        ok = False
    else:
        seen.add(case_id)
    if not isinstance(title, str) or not 1 <= len(title.strip()) <= 200:
        problems.append(f"{where}: title — строка 1..200")
        ok = False
    if not isinstance(mandatory, bool):
        problems.append(f"{where}: mandatory — true/false")
        ok = False
    norm_input, checks, errors = validate_golden(agent_id, item.get("input"), item.get("checks"))
    problems.extend(f"{where} ({case_id}): {e['path']} {e['message']}" for e in errors)
    if not ok or errors or norm_input is None or checks is None:
        return None
    return {"case_id": case_id, "agent_id": agent_id, "title": str(title).strip(), "input": norm_input,
            "checks": checks, "mandatory": mandatory}


# ---------------------------------------------------------------- запись (снимок схемы на момент 0002)

_versions = sa.table(
    "agent_versions",
    sa.column("id", pg.UUID(as_uuid=True)), sa.column("agent_id", sa.String), sa.column("version", sa.Integer),
    sa.column("status", sa.String), sa.column("instructions", sa.Text), sa.column("rules", sa.Text),
    sa.column("output_schema", pg.JSONB), sa.column("schema_version", sa.String), sa.column("model_id", sa.String),
    sa.column("fallback_model_id", sa.String), sa.column("temperature", sa.Numeric),
    sa.column("max_output_tokens", sa.Integer), sa.column("timeout_ms", sa.Integer),
    sa.column("max_cost_usd", sa.Numeric), sa.column("notes", sa.Text), sa.column("body_hash", sa.String),
    sa.column("author_id", sa.String), sa.column("created_at", sa.DateTime(timezone=True)),
    sa.column("updated_by", sa.String), sa.column("updated_at", sa.DateTime(timezone=True)),
    sa.column("published_by", sa.String), sa.column("published_at", sa.DateTime(timezone=True)),
)
_cases = sa.table(
    "golden_cases",
    sa.column("case_id", sa.String), sa.column("agent_id", sa.String), sa.column("title", sa.String),
    sa.column("input", pg.JSONB), sa.column("checks", pg.JSONB), sa.column("mandatory", sa.Boolean),
    sa.column("created_by", sa.String), sa.column("created_at", sa.DateTime(timezone=True)),
    sa.column("archived_at", sa.DateTime(timezone=True)),
)
_outbox = sa.table("outbox", sa.column("id", pg.UUID(as_uuid=False)), sa.column("event_type", sa.String),
                   sa.column("envelope", pg.JSONB))


def _emit(conn: Connection, event_type: str, payload: dict[str, Any]) -> None:
    env = make_envelope(event_type, payload, producer=PRODUCER)
    conn.execute(_outbox.insert().values(id=env.event_id, event_type=env.event_type,
                                         envelope=env.model_dump(mode="json")))


def apply_seed(conn: Connection, seed: Seed, now: datetime) -> dict[str, int]:
    """Публикует версии и записывает кейсы. Возвращает счётчики (published, skipped, cases_written, cases_skipped)."""
    _check_models(conn, seed)
    counts = {"published": 0, "skipped": 0, "cases_written": 0, "cases_skipped": 0}
    for agent_id in sorted(seed.versions):
        body = seed.versions[agent_id]
        digest = body_hash(body)
        current = conn.execute(sa.text(
            "SELECT version, author_id, body_hash FROM agent_versions WHERE agent_id = :a AND status = 'published'"),
            {"a": agent_id}).first()
        # тело уже было опубликовано сидом (в т. ч. заменено более поздней миграцией или откатом сотрудника) — не
        # публикуем его заново: повтор ранней миграции не откатывает поздние
        seeded_before = conn.execute(sa.text(
            "SELECT 1 FROM agent_versions WHERE agent_id = :a AND author_id = :s AND body_hash = :h "
            "AND status <> 'draft'"), {"a": agent_id, "s": SEED_ACTOR_ID, "h": digest}).first()
        if (current is not None and current.author_id != SEED_ACTOR_ID) or seeded_before is not None:
            counts["skipped"] += 1
            continue
        _publish(conn, agent_id, body, digest, int(current.version) if current is not None else None, now)
        counts["published"] += 1
    _write_cases(conn, seed, now, counts)
    return counts


def _check_models(conn: Connection, seed: Seed) -> None:
    models = set(conn.execute(sa.text("SELECT model_id FROM models")).scalars().all())
    problems = []
    for agent_id, body in seed.versions.items():
        for name in ("model_id", "fallback_model_id"):
            if body.get(name) is not None and body[name] not in models:
                problems.append(f"agents/{agent_id}: {name} {body[name]} — нет в таблице models")
    if problems:
        raise SeedInvalid(problems)


def _write_cases(conn: Connection, seed: Seed, now: datetime, counts: dict[str, int]) -> None:
    for case in seed.cases:
        existing = conn.execute(sa.text(
            "SELECT agent_id, created_by, title, input, checks, mandatory, archived_at FROM golden_cases "
            "WHERE case_id = :c"), {"c": case["case_id"]}).first()
        if existing is None:
            conn.execute(_cases.insert().values(**case, created_by=SEED_ACTOR_ID, created_at=now, archived_at=None))
            counts["cases_written"] += 1
            continue
        if existing.agent_id != case["agent_id"]:
            raise SeedInvalid([f"golden: case_id {case['case_id']} уже есть у агента {existing.agent_id}"])
        same = (existing.title, existing.input, existing.checks, existing.mandatory, existing.archived_at) == (
            case["title"], case["input"], case["checks"], case["mandatory"], None)
        if existing.created_by != SEED_ACTOR_ID or same:
            counts["cases_skipped"] += 1
            continue
        conn.execute(_cases.update().where(_cases.c.case_id == case["case_id"]).values(
            title=case["title"], input=case["input"], checks=case["checks"], mandatory=case["mandatory"],
            archived_at=None))
        counts["cases_written"] += 1


def apply_seed_drafts(conn: Connection, seed: Seed, now: datetime) -> dict[str, int]:
    """Накладка-черновик: версии сида → **черновики** автора seed (публикация — после золотых тестов), кейсы — как в
    apply_seed. Пропуск: тело уже записано сидом (в любом статусе — повтор миграции ничего не меняет) или у агента
    есть черновик сотрудника (один черновик на агента; предупреждение — удалить черновик и повторить миграцию).
    Счётчики: drafted, skipped, blocked, cases_written, cases_skipped."""
    _check_models(conn, seed)
    counts = {"drafted": 0, "skipped": 0, "blocked": 0, "cases_written": 0, "cases_skipped": 0}
    for agent_id in sorted(seed.versions):
        body = seed.versions[agent_id]
        digest = body_hash(body)
        seeded_before = conn.execute(sa.text(
            "SELECT 1 FROM agent_versions WHERE agent_id = :a AND author_id = :s AND body_hash = :h"),
            {"a": agent_id, "s": SEED_ACTOR_ID, "h": digest}).first()
        if seeded_before is not None:
            counts["skipped"] += 1
            continue
        draft = conn.execute(sa.text("SELECT version FROM agent_versions WHERE agent_id = :a AND status = 'draft'"),
                             {"a": agent_id}).first()
        if draft is not None:
            log.warning("seed draft not created: agent already has a draft",
                        extra={"agent_id": agent_id, "agent_version": int(draft.version)})
            counts["blocked"] += 1
            continue
        max_version = conn.execute(sa.text("SELECT max(version) FROM agent_versions WHERE agent_id = :a"),
                                   {"a": agent_id}).scalar()
        version = int(max_version or 0) + 1
        conn.execute(_versions.insert().values(
            id=uuid.uuid4(), agent_id=agent_id, version=version, status="draft",
            instructions=body["instructions"], rules=body["rules"], output_schema=body["output_schema"],
            schema_version=body["schema_version"], model_id=body["model_id"],
            fallback_model_id=body.get("fallback_model_id"), temperature=_temperature(body["temperature"]),
            max_output_tokens=body["max_output_tokens"], timeout_ms=body["timeout_ms"],
            max_cost_usd=_cost(body["max_cost_usd"]), notes=body.get("notes"), body_hash=digest,
            author_id=SEED_ACTOR_ID, created_at=now, updated_by=SEED_ACTOR_ID, updated_at=now,
            published_by=None, published_at=None,
        ))
        audit = audit_payload(None, "ai.version_created", "agent_version", version_object_id(agent_id, version),
                              after={"status": "draft", "from_version": None, "body_hash": digest},
                              reason=DRAFT_REASON, actor_type="system", actor_id=SEED_ACTOR_ID)
        _emit(conn, AUDIT_EVENT, audit)
        counts["drafted"] += 1
    _write_cases(conn, seed, now, counts)
    return counts


def _publish(conn: Connection, agent_id: str, body: dict[str, Any], digest: str, previous: int | None,
             now: datetime) -> None:
    max_version = conn.execute(sa.text("SELECT max(version) FROM agent_versions WHERE agent_id = :a"),
                               {"a": agent_id}).scalar()
    version = int(max_version or 0) + 1
    if previous is not None:
        conn.execute(sa.text("UPDATE agent_rollout SET canary_version = NULL, canary_percent = 0 "
                             "WHERE agent_id = :a AND canary_version IS NOT NULL"), {"a": agent_id})
        conn.execute(sa.text("UPDATE agent_versions SET status = 'archived', archived_at = :now "
                             "WHERE agent_id = :a AND version = :v"), {"now": now, "a": agent_id, "v": previous})
    conn.execute(_versions.insert().values(
        id=uuid.uuid4(), agent_id=agent_id, version=version, status="published",
        instructions=body["instructions"], rules=body["rules"], output_schema=body["output_schema"],
        schema_version=body["schema_version"], model_id=body["model_id"],
        fallback_model_id=body.get("fallback_model_id"), temperature=_temperature(body["temperature"]),
        max_output_tokens=body["max_output_tokens"], timeout_ms=body["timeout_ms"],
        max_cost_usd=_cost(body["max_cost_usd"]), notes=body.get("notes"), body_hash=digest,
        author_id=SEED_ACTOR_ID, created_at=now, updated_by=SEED_ACTOR_ID, updated_at=now,
        published_by=SEED_ACTOR_ID, published_at=now,
    ))
    conn.execute(sa.text("UPDATE agent_rollout SET published_version = :v, previous_version = :p, updated_by = :s, "
                         "updated_at = :now WHERE agent_id = :a"),
                 {"v": version, "p": previous, "s": SEED_ACTOR_ID, "now": now, "a": agent_id})
    audit = audit_payload(None, "ai.version_published", "agent_version", version_object_id(agent_id, version),
                          before={"published_version": previous},
                          after={"published_version": version, "body_hash": digest, "model_id": body["model_id"]},
                          reason=SEED_REASON, actor_type="system", actor_id=SEED_ACTOR_ID)
    _emit(conn, AUDIT_EVENT, audit)


def remove_seed(conn: Connection) -> None:
    """Откат миграции 0002 (только владелец схемы: триггер неизменяемости снимается на время удаления)."""
    conn.execute(sa.text("ALTER TABLE agent_versions DISABLE TRIGGER agent_versions_guard"))
    seeded = "SELECT version FROM agent_versions v WHERE v.agent_id = r.agent_id AND v.author_id = :s"
    for column in ("published_version", "previous_version", "canary_version"):
        extra = ", canary_percent = 0" if column == "canary_version" else ""
        conn.execute(sa.text(f"UPDATE agent_rollout r SET {column} = NULL{extra} "  # noqa: S608 — имена колонок из кода
                             f"WHERE {column} IN ({seeded})"), {"s": SEED_ACTOR_ID})
    conn.execute(sa.text("DELETE FROM agent_versions WHERE author_id = :s"), {"s": SEED_ACTOR_ID})
    conn.execute(sa.text("DELETE FROM golden_cases WHERE created_by = :s"), {"s": SEED_ACTOR_ID})
    conn.execute(sa.text("ALTER TABLE agent_versions ENABLE TRIGGER agent_versions_guard"))


def revert_overlay(conn: Connection, seed: Seed) -> None:
    """Откат миграции-накладки (только владелец схемы): версии, опубликованные этой накладкой (автор seed, то же тело),
    удаляются, опубликованной снова становится прежняя версия; кейсы накладки (автор seed) удаляются."""
    conn.execute(sa.text("ALTER TABLE agent_versions DISABLE TRIGGER agent_versions_guard"))
    for agent_id, body in seed.versions.items():
        row = conn.execute(sa.text(
            "SELECT version, status FROM agent_versions WHERE agent_id = :a AND author_id = :s AND body_hash = :h"),
            {"a": agent_id, "s": SEED_ACTOR_ID, "h": body_hash(body)}).first()
        if row is None:
            continue
        rollout = conn.execute(sa.text("SELECT published_version, previous_version FROM agent_rollout "
                                       "WHERE agent_id = :a"), {"a": agent_id}).first()
        restore = rollout.previous_version if rollout is not None and rollout.published_version == row.version \
            else None
        conn.execute(sa.text("UPDATE agent_rollout SET "
                             "published_version = CASE WHEN published_version = :v THEN :p ELSE published_version END, "
                             "previous_version = CASE WHEN previous_version = :v OR published_version = :v THEN NULL "
                             "ELSE previous_version END, "
                             "canary_percent = CASE WHEN canary_version = :v THEN 0 ELSE canary_percent END, "
                             "canary_version = CASE WHEN canary_version = :v THEN NULL ELSE canary_version END "
                             "WHERE agent_id = :a"), {"a": agent_id, "v": row.version, "p": restore})
        conn.execute(sa.text("DELETE FROM agent_versions WHERE agent_id = :a AND version = :v"),
                     {"a": agent_id, "v": row.version})
        if restore is not None:  # прежняя версия снова опубликована (после удаления — индекс одной published)
            conn.execute(sa.text("UPDATE agent_versions SET status = 'published', archived_at = NULL "
                                 "WHERE agent_id = :a AND version = :v"), {"a": agent_id, "v": restore})
    conn.execute(sa.text("ALTER TABLE agent_versions ENABLE TRIGGER agent_versions_guard"))
    case_ids = [c["case_id"] for c in seed.cases]
    if case_ids:
        conn.execute(sa.text("DELETE FROM golden_cases WHERE created_by = :s AND case_id = ANY(:ids)"),
                     {"s": SEED_ACTOR_ID, "ids": case_ids})
