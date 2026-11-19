"""Сид контента (миграция данных 0003, PLAN «Решения»): JSON методистов → опубликованные версии.

Файлы `migrations/seed/` (формат — content.ts): `course.json`, `skills.json`, `modules.json`, `lessons.json`,
`rubrics.json`, `scenarios.json`, `media.json`, `media_exercises.json` (допустимы и множественные/единственные
имена: courses.json, skill.json, media_assets.json…). В файле — объект или массив объектов; вместо файла может быть
каталог с тем же именем и файлами `*.json` внутри.

Весь набор проверяется **как опубликованный** (режим публикации, полная валидация: схема, локализации, ссылки на
сид и уже опубликованное, циклы предпосылок, графы сценариев, права медиа) — при любой ошибке миграция падает со
списком ошибок. Автор и проверяющий — системный seed-UUID; локализации — «проверено: сид» (нужна вычитка UZ
носителем — её можно отозвать новой версией); медиа — права подтверждены сидом; сценарии — тестовый прогон
сохраняется. Каждая публикация — аудит `content.published` от system и событие catalog.version.published.v1.
Повтор с тем же содержимым ничего не меняет; изменённое тело публикуется новой версией (прежняя → archived).
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Iterable
from datetime import date, datetime
from pathlib import Path
from typing import Any, Final

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql as pg
from sqlalchemy.engine import Connection

from tilhero_catalog.content import KEY_FIELDS
from tilhero_catalog.domain.common import (
    AUDIT_EVENT,
    PRODUCER,
    SEED_ACTOR_ID,
    VERSION_PUBLISHED,
    audit_payload,
    iso_z,
    payload_hash,
    version_object_id,
)
from tilhero_catalog.domain.scenario_test import run_test
from tilhero_catalog.domain.validation import Issue, RefContext, normalized, parse_schema, validate
from tilhero_common.messaging import make_envelope

FILE_KINDS: Final[dict[str, str]] = {
    "course": "course", "courses": "course",
    "skill": "skill", "skills": "skill",
    "module": "module", "modules": "module",
    "lesson": "lesson", "lessons": "lesson",
    "rubric": "rubric", "rubrics": "rubric",
    "scenario": "scenario", "scenarios": "scenario",
    "media": "media_asset", "media_asset": "media_asset", "media_assets": "media_asset",
    "media_exercise": "media_exercise", "media_exercises": "media_exercise",
}
# порядок публикации: зависимости раньше зависящих
PUBLISH_ORDER: Final = ("rubric", "skill", "scenario", "media_asset", "media_exercise", "lesson", "module", "course")
SEED_NOTE: Final = "Сид контента спринта 3 (проверено: сид — нужна вычитка UZ носителем)"
RIGHTS_NOTE: Final = "Авторский материал TilHero (сид)"
SEED_REASON: Final = "Сид контента спринта 3"


class SeedInvalid(RuntimeError):
    def __init__(self, problems: list[str]) -> None:
        self.problems = problems
        head = "\n".join(problems[:60])
        more = f"\n… ещё {len(problems) - 60}" if len(problems) > 60 else ""
        super().__init__(f"Сид контента не прошёл проверку ({len(problems)}):\n{head}{more}")


Entry = tuple[str, dict[str, Any]]


def _read(path: Path) -> list[Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    return data if isinstance(data, list) else [data]


def load_seed_dir(directory: Path) -> list[Entry]:
    entries: list[Entry] = []
    if not directory.is_dir():
        return entries
    for item in sorted(directory.iterdir()):
        kind = FILE_KINDS.get(item.stem if item.is_file() else item.name)
        if kind is None:
            continue
        if item.is_file() and item.suffix == ".json":
            files = [item]
        elif item.is_dir():
            files = sorted(p for p in item.glob("*.json") if p.is_file())
        else:
            continue
        for path in files:
            entries.extend((kind, obj) for obj in _read(path))
    return entries


# ---------------------------------------------------------------- таблицы (снимок схемы на момент 0003)

_versions = sa.table(
    "content_versions",
    sa.column("id", pg.UUID(as_uuid=True)), sa.column("kind", sa.String), sa.column("key", sa.String),
    sa.column("version", sa.Integer), sa.column("status", sa.String), sa.column("payload", pg.JSONB),
    sa.column("payload_hash", sa.String), sa.column("author_id", sa.String), sa.column("editors", pg.JSONB),
    sa.column("created_at", sa.DateTime(timezone=True)), sa.column("updated_by", sa.String),
    sa.column("updated_at", sa.DateTime(timezone=True)), sa.column("submitted_at", sa.DateTime(timezone=True)),
    sa.column("reviewer_id", sa.String), sa.column("reviewed_at", sa.DateTime(timezone=True)),
    sa.column("review_note", sa.Text), sa.column("locale_checks", pg.JSONB),
    sa.column("rights_approved_by", sa.String), sa.column("rights_approved_at", sa.DateTime(timezone=True)),
    sa.column("rights_note", sa.Text), sa.column("published_by", sa.String),
    sa.column("published_at", sa.DateTime(timezone=True)), sa.column("archived_at", sa.DateTime(timezone=True)),
)
_pointers = sa.table(
    "content_pointers",
    sa.column("kind", sa.String), sa.column("key", sa.String), sa.column("published_version", sa.Integer),
    sa.column("previous_version", sa.Integer), sa.column("updated_at", sa.DateTime(timezone=True)),
)
_runs = sa.table(
    "scenario_test_runs",
    sa.column("id", pg.UUID(as_uuid=True)), sa.column("key", sa.String), sa.column("version", sa.Integer),
    sa.column("payload_hash", sa.String), sa.column("ok", sa.Boolean), sa.column("result", pg.JSONB),
    sa.column("run_by", sa.String), sa.column("checked_at", sa.DateTime(timezone=True)),
)
_outbox_table = sa.table(
    "outbox", sa.column("id", pg.UUID(as_uuid=False)), sa.column("event_type", sa.String),
    sa.column("envelope", pg.JSONB),
)


def _published_in_db(conn: Connection) -> dict[tuple[str, str], tuple[int, str, dict[str, Any]]]:
    rows = conn.execute(sa.text(
        "SELECT v.kind, v.key, v.version, v.payload_hash, v.payload FROM content_versions v "
        "JOIN content_pointers p ON p.kind = v.kind AND p.key = v.key AND p.published_version = v.version")).all()
    return {(r.kind, r.key): (int(r.version), str(r.payload_hash), dict(r.payload)) for r in rows}


def check_seed(entries: Iterable[Entry], *, published: dict[tuple[str, str], dict[str, Any]], pairs: set[str],
               blobs: set[str], today: date, external_sources: bool) -> list[Entry]:
    """Нормализует и проверяет набор как опубликованный. Возвращает нормализованные записи или SeedInvalid."""
    problems: list[str] = []
    normalized_entries: list[Entry] = []
    seen: set[tuple[str, str]] = set()
    for kind, raw in entries:
        model, issues = parse_schema(kind, raw)
        key = raw.get(KEY_FIELDS[kind]) if isinstance(raw, dict) else None
        if model is None:
            problems.extend(f"{kind}:{key}: {i.path} {i.code} {i.message}" for i in issues)
            continue
        payload = normalized(model)
        ref = (kind, str(payload[KEY_FIELDS[kind]]))
        if ref in seen:
            problems.append(f"{kind}:{ref[1]}: DUPLICATE_ID ключ повторяется в сиде")
            continue
        seen.add(ref)
        normalized_entries.append((kind, payload))
    view = dict(published)
    view.update({(kind, str(p[KEY_FIELDS[kind]])): p for kind, p in normalized_entries})
    for kind, payload in normalized_entries:
        ctx = RefContext(mode="publish", today=today, external_sources=external_sources, existing=view,
                         published=view, pairs=pairs, blobs=blobs, locale_checks={"ru": "checked", "uz": "checked"},
                         rights_approved=True, test_run_ok=bool(run_test(payload, "")["ok"]) if kind == "scenario"
                         else False)
        issues = validate(kind, payload, ctx)
        problems.extend(_fmt(kind, payload, i) for i in issues)
    if problems:
        raise SeedInvalid(problems)
    return normalized_entries


def _fmt(kind: str, payload: dict[str, Any], issue: Issue) -> str:
    return f"{kind}:{payload.get(KEY_FIELDS[kind])}: {issue.path} {issue.code} {issue.message}"


def _outbox(conn: Connection, event_type: str, payload: dict[str, Any]) -> None:
    env = make_envelope(event_type, payload, producer=PRODUCER)
    conn.execute(_outbox_table.insert().values(id=env.event_id, event_type=env.event_type,
                                         envelope=env.model_dump(mode="json")))


def apply_seed(conn: Connection, entries: list[Entry], *, today: date, external_sources: bool,
               now: datetime) -> dict[str, int]:
    """Проверяет и публикует сид. Возвращает число опубликованных и пропущенных (без изменений) записей."""
    in_db = _published_in_db(conn)
    pairs = set(conn.execute(sa.text("SELECT pair_id FROM language_pairs")).scalars().all())
    blobs = {str(b) for b in conn.execute(sa.text("SELECT blob_id FROM media_blobs")).scalars().all()}
    checked = check_seed(entries, published={ref: p for ref, (_, _, p) in in_db.items()}, pairs=pairs, blobs=blobs,
                         today=today, external_sources=external_sources)
    order = {k: i for i, k in enumerate(PUBLISH_ORDER)}
    published, skipped = 0, 0
    for kind, payload in sorted(checked, key=lambda e: (order[e[0]], str(e[1][KEY_FIELDS[e[0]]]))):
        key = str(payload[KEY_FIELDS[kind]])
        digest = payload_hash(payload)
        current = in_db.get((kind, key))
        if current is not None and current[1] == digest:
            skipped += 1
            continue
        _publish_one(conn, kind, key, payload, digest, current[0] if current else None, now)
        published += 1
    return {"published": published, "skipped": skipped}


def _publish_one(conn: Connection, kind: str, key: str, payload: dict[str, Any], digest: str,
                 previous: int | None, now: datetime) -> None:
    max_version = conn.execute(sa.text("SELECT max(version) FROM content_versions WHERE kind = :k AND key = :key"),
                               {"k": kind, "key": key}).scalar()
    version = int(max_version or 0) + 1
    if previous is not None:
        conn.execute(sa.text("UPDATE content_versions SET status = 'archived', archived_at = :now "
                             "WHERE kind = :k AND key = :key AND version = :v"),
                     {"now": now, "k": kind, "key": key, "v": previous})
    media = kind == "media_asset"
    conn.execute(_versions.insert().values(
        id=uuid.uuid4(), kind=kind, key=key, version=version, status="published", payload=payload,
        payload_hash=digest, author_id=SEED_ACTOR_ID, editors=[SEED_ACTOR_ID], created_at=now,
        updated_by=SEED_ACTOR_ID, updated_at=now, submitted_at=now, reviewer_id=SEED_ACTOR_ID, reviewed_at=now,
        review_note=SEED_NOTE, locale_checks={"ru": "checked", "uz": "checked"},
        rights_approved_by=SEED_ACTOR_ID if media else None, rights_approved_at=now if media else None,
        rights_note=RIGHTS_NOTE if media else None, published_by=SEED_ACTOR_ID, published_at=now, archived_at=None,
    ))
    exists = conn.execute(sa.text("SELECT 1 FROM content_pointers WHERE kind = :k AND key = :key"),
                          {"k": kind, "key": key}).first()
    if exists:
        conn.execute(sa.text("UPDATE content_pointers SET published_version = :v, previous_version = :p, "
                             "updated_at = :now WHERE kind = :k AND key = :key"),
                     {"v": version, "p": previous, "now": now, "k": kind, "key": key})
    else:
        conn.execute(_pointers.insert().values(kind=kind, key=key, published_version=version,
                                               previous_version=previous, updated_at=now))
    if kind == "scenario":
        result = run_test(payload, iso_z(now) or "")
        conn.execute(_runs.insert().values(id=uuid.uuid4(), key=key, version=version, payload_hash=digest,
                                           ok=bool(result["ok"]), result=result, run_by=SEED_ACTOR_ID,
                                           checked_at=now))
    course_id = payload.get("course_id") if kind in ("course", "skill", "module", "lesson") else None
    _outbox(conn, VERSION_PUBLISHED, {
        "kind": kind, "key": key, "version": version, "previous_version": previous, "action": "published",
        "course_id": course_id, "published_by": SEED_ACTOR_ID, "published_at": iso_z(now),
    })
    audit = audit_payload(None, "content.published", "content_version", version_object_id(kind, key, version),
                          before={"published_version": previous},
                          after={"status": "published", "payload_hash": digest, "published_version": version},
                          reason=SEED_REASON, actor_type="system")
    audit["actor_id"] = SEED_ACTOR_ID
    _outbox(conn, AUDIT_EVENT, audit)


def remove_seed(conn: Connection) -> None:
    """Откат миграции (только владелец схемы: снимает триггер неизменяемости на время удаления)."""
    conn.execute(sa.text("ALTER TABLE content_versions DISABLE TRIGGER content_versions_guard"))
    conn.execute(sa.text("ALTER TABLE scenario_test_runs DISABLE TRIGGER scenario_test_runs_append_only"))
    conn.execute(sa.text("DELETE FROM scenario_test_runs WHERE run_by = :a"), {"a": SEED_ACTOR_ID})
    conn.execute(sa.text("DELETE FROM content_versions WHERE author_id = :a"), {"a": SEED_ACTOR_ID})
    conn.execute(sa.text(
        "DELETE FROM content_pointers p WHERE NOT EXISTS "
        "(SELECT 1 FROM content_versions v WHERE v.kind = p.kind AND v.key = p.key)"))
    conn.execute(sa.text(
        "UPDATE content_pointers p SET published_version = NULL WHERE published_version IS NOT NULL AND NOT EXISTS "
        "(SELECT 1 FROM content_versions v WHERE v.kind = p.kind AND v.key = p.key "
        "AND v.version = p.published_version AND v.status = 'published')"))
    conn.execute(sa.text("ALTER TABLE scenario_test_runs ENABLE TRIGGER scenario_test_runs_append_only"))
    conn.execute(sa.text("ALTER TABLE content_versions ENABLE TRIGGER content_versions_guard"))
