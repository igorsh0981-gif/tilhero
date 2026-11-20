"""Построение статей словаря курса source=course из опубликованного контента (INTERNAL_API §2.2).

Синхронный код на Connection (SQLAlchemy Core): тот же для миграций (0004 — по всему опубликованному, 0005 — сид
текстов) и для рантайма (публикация и откат версии вызывают его через `AsyncSession.run_sync` в той же транзакции).
Таблицы — снимок схемы (sa.table), как в сиде: модели могут измениться, миграции — нет.

Элементы контента: урок — `key_words`, медиа — `phrases` (только если `rights.allowed_uses ∋ dictionary`), текст —
`glossary`. Пары: урок — пара его курса; медиа и текст — пары с изучаемым языком материала (en), кроме архивных.
Формы элемента — варианты через « / » («Goodbye! / Bye!» → goodbye, bye), ключ формы — слова через пробел.

Правила для каждой формы (под транзакционной advisory-блокировкой пары — с ai-entries и правками нет гонок):
- форма свободна → войдёт в новую статью course (лемма, перевод и пример — из элемента; ref — эта версия);
- форма у статьи course или methodist → у неё дописывается ref (одна ссылка на ключ контента — номер версии
  обновляется), перевод не меняется: первая публикация главнее, расхождение — `conflicts` в карточке статьи. Исключение:
  статья course, построенная из этого же ключа контента (первый ref), берёт перевод и пример новой версии — статьи
  course «правятся через версию этого контента»;
- форма у статьи ai (любой статус проверки) → статья ai архивируется (course главнее), форма освобождается.
История: created / updated / archived (кто — опубликовавший, у миграции — система). Повтор той же версии — без
изменений. Возвращает изменения для события catalog.glossary.changed.v1 (его публикует вызывающий в рантайме).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Final

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql as pg
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_catalog.domain.common import GLOSSARY_CHANGED, emit_event, iso_z
from tilhero_catalog.domain.text import clean_lemma, contains, form_key, forms_of

GLOSSARY_LOCK_CLASS: Final = 811_005
MAX_REFS: Final = 50
MAX_LEMMA: Final = 60
MAX_EXAMPLE: Final = 200
BUILT_KINDS: Final = ("lesson", "media_asset", "reading")
MIGRATION_REASON: Final = "Словарь курса построен по опубликованному контенту (миграция)"
AI_REPLACED_REASON: Final = "Статья ИИ заменена статьёй из контента курса"

entries_t = sa.table(
    "glossary_entries",
    sa.column("entry_id", pg.UUID(as_uuid=True)), sa.column("pair_id", sa.String), sa.column("lemma", sa.String),
    sa.column("forms", pg.JSONB), sa.column("part_of_speech", sa.String), sa.column("gloss", pg.JSONB),
    sa.column("example_en", sa.String), sa.column("source", sa.String), sa.column("review_status", sa.String),
    sa.column("confidence", sa.Float), sa.column("agent_version", sa.String), sa.column("refs", pg.JSONB),
    sa.column("override", pg.JSONB(none_as_null=True)), sa.column("corrected", sa.Boolean),
    sa.column("created_by", sa.String),
    sa.column("created_at", sa.DateTime(timezone=True)), sa.column("updated_by", sa.String),
    sa.column("updated_at", sa.DateTime(timezone=True)), sa.column("archived_at", sa.DateTime(timezone=True)),
)
forms_t = sa.table(
    "glossary_forms",
    sa.column("pair_id", sa.String), sa.column("form_key", sa.String), sa.column("form", sa.String),
    sa.column("entry_id", pg.UUID(as_uuid=True)),
)
history_t = sa.table(
    "glossary_history",
    sa.column("history_id", pg.UUID(as_uuid=True)), sa.column("entry_id", pg.UUID(as_uuid=True)),
    sa.column("action", sa.String), sa.column("before", pg.JSONB(none_as_null=True)),
    sa.column("after", pg.JSONB(none_as_null=True)),
    sa.column("by", sa.String), sa.column("reason", sa.Text), sa.column("at", sa.DateTime(timezone=True)),
)


@dataclass(frozen=True)
class Item:
    """Слово или выражение контента для словаря: текст (EN), перевод, пример, пояснение (у глоссария текста)."""

    text: str
    gloss: dict[str, str]
    example_en: str | None
    note: dict[str, str] | None = None


@dataclass(frozen=True)
class Change:
    """Изменение статьи для события catalog.glossary.changed.v1."""

    pair_id: str
    entry_id: str
    forms: tuple[str, ...]
    change: str


async def emit_changes(session: AsyncSession, changes: list[Change], at: datetime) -> None:
    """catalog.glossary.changed.v1 (outbox, та же транзакция): memory сбрасывает кеш перевода по формам. Форм в
    событии не больше 8 — объединение старых и новых форм правки делится на несколько событий."""
    for c in changes:
        forms = list(dict.fromkeys(c.forms)) or [""]
        for i in range(0, len(forms), 8):
            await emit_event(session, GLOSSARY_CHANGED, {
                "pair_id": c.pair_id, "entry_id": c.entry_id, "forms": [f for f in forms[i:i + 8] if f],
                "change": c.change, "occurred_at": iso_z(at),
            })


def _first_containing(texts: list[str], phrase: str) -> str | None:
    for text in texts:
        if contains(text, phrase):
            return text if len(text) <= MAX_EXAMPLE else None
    return None


def content_items(kind: str, payload: dict[str, Any]) -> list[Item]:
    """Элементы версии контента, из которых строятся статьи course."""
    if kind == "lesson":
        return [Item(str(kw["en"]), dict(kw["gloss"]), (kw.get("example_en") or None)) for kw in payload["key_words"]]
    if kind == "media_asset":
        if "dictionary" not in ((payload.get("rights") or {}).get("allowed_uses") or []):
            return []
        lines = [str(t["text_en"]) for t in payload.get("transcript") or []]
        return [Item(str(ph["en"]), dict(ph["gloss"]), _first_containing(lines, str(ph["en"])))
                for ph in payload.get("phrases") or []]
    if kind == "reading":
        sentences = [str(s["text_en"]) for para in payload["paragraphs"] for s in para["sentences"]]
        return [Item(str(g["en"]), dict(g["gloss"]), _first_containing(sentences, str(g["en"])),
                     dict(g["note"]) if g.get("note") else None) for g in payload["glossary"]]
    return []


def pairs_for(conn: Connection, kind: str, payload: dict[str, Any]) -> list[str]:
    """Пары, в словарь которых попадает контент: урок — пара курса; медиа и текст — пары с изучаемым языком en."""
    if kind == "lesson":
        course_id = payload.get("course_id")
        pair = conn.execute(sa.text(
            "SELECT payload->>'pair_id' FROM content_versions WHERE kind = 'course' AND key = :c "
            "ORDER BY (status = 'published') DESC, version DESC LIMIT 1"), {"c": course_id}).scalar()
        if pair:
            return [str(pair)]
        return [str(p) for p in conn.execute(sa.text(
            "SELECT pair_id FROM language_pairs WHERE course_id = :c ORDER BY pair_id"), {"c": course_id}).scalars()]
    language = str(payload.get("language") or "en").split("-")[0] if kind == "media_asset" else "en"
    return [str(p) for p in conn.execute(sa.text(
        "SELECT pair_id FROM language_pairs WHERE target = :t AND status <> 'archived' ORDER BY pair_id"),
        {"t": language}).scalars()]


def lock_pair(conn: Connection, pair_id: str) -> None:
    conn.execute(sa.text("SELECT pg_advisory_xact_lock(:c, hashtext(:p))"), {"c": GLOSSARY_LOCK_CLASS, "p": pair_id})


def history(conn: Connection, entry_id: uuid.UUID, action: str, *, before: dict[str, Any] | None,
            after: dict[str, Any] | None, by: str | None, reason: str | None, at: datetime) -> None:
    conn.execute(history_t.insert().values(history_id=uuid.uuid4(), entry_id=entry_id, action=action, before=before,
                                           after=after, by=by, reason=(reason or None) and reason[:500], at=at))


def archive_entry(conn: Connection, entry_id: uuid.UUID, *, by: str | None, reason: str, at: datetime) -> None:
    """Архив статьи: формы освобождаются, запись истории archived."""
    conn.execute(forms_t.delete().where(forms_t.c.entry_id == entry_id))
    conn.execute(entries_t.update().where(entries_t.c.entry_id == entry_id)
                 .values(archived_at=at, updated_at=at, updated_by=by))
    history(conn, entry_id, "archived", before={"archived_at": None}, after={"archived_at": iso_z(at)}, by=by,
            reason=reason, at=at)


def with_ref(refs: list[dict[str, Any]], ref: dict[str, Any]) -> list[dict[str, Any]] | None:
    """refs с этой версией контента (по ключу — одна ссылка, номер версии обновляется); None — без изменений."""
    out = [dict(r) for r in refs]
    for r in out:
        if r.get("kind") == ref["kind"] and r.get("key") == ref["key"]:
            if r.get("version") == ref["version"]:
                return None
            r["version"] = ref["version"]
            return out
    if len(out) >= MAX_REFS:
        return None
    return [*out, ref]


def _apply_item(conn: Connection, pair_id: str, item: Item, ref: dict[str, Any], *, by: str | None, reason: str,
                now: datetime) -> list[Change]:
    forms = forms_of(item.text)
    lemma = clean_lemma(item.text)[:MAX_LEMMA].strip()
    if not forms or not lemma:
        return []
    keys = {form_key(f): f for f in forms}
    held = conn.execute(
        sa.select(forms_t.c.form_key, entries_t.c.entry_id, entries_t.c.source, entries_t.c.refs, entries_t.c.gloss,
                  entries_t.c.example_en, entries_t.c.forms)
        .select_from(forms_t.join(entries_t, entries_t.c.entry_id == forms_t.c.entry_id))
        .where(forms_t.c.pair_id == pair_id, forms_t.c.form_key.in_(sorted(keys)))).all()
    by_key = {r.form_key: r for r in held}
    changes: list[Change] = []
    free: list[str] = []
    touched: dict[uuid.UUID, Any] = {}
    archived: set[uuid.UUID] = set()
    for key, form in keys.items():
        row = by_key.get(key)
        if row is None or row.entry_id in archived:
            free.append(form)
        elif row.source == "ai":
            archive_entry(conn, row.entry_id, by=by, reason=AI_REPLACED_REASON, at=now)
            archived.add(row.entry_id)
            changes.append(Change(pair_id, str(row.entry_id), tuple(row.forms), "archived"))
            free.append(form)
        else:
            touched[row.entry_id] = row
    gloss = {"ru": item.gloss.get("ru", ""), "uz": item.gloss.get("uz", "")}
    example = item.example_en if item.example_en and len(item.example_en) <= MAX_EXAMPLE else None
    for entry_id, row in touched.items():
        refs = list(row.refs or [])
        new_refs = with_ref(refs, ref)
        values: dict[str, Any] = {}
        if new_refs is not None:
            values["refs"] = new_refs
        origin = refs[0] if refs else None
        same_origin = (row.source == "course" and origin is not None and origin.get("kind") == ref["kind"]
                       and origin.get("key") == ref["key"])
        if same_origin and (dict(row.gloss) != gloss or row.example_en != example):
            values.update(gloss=gloss, example_en=example, updated_at=now, updated_by=by)
            history(conn, entry_id, "updated", before={"gloss": dict(row.gloss), "example_en": row.example_en},
                    after={"gloss": gloss, "example_en": example}, by=by, reason=reason, at=now)
            changes.append(Change(pair_id, str(entry_id), tuple(row.forms), "updated"))
        if values:
            conn.execute(entries_t.update().where(entries_t.c.entry_id == entry_id).values(**values))
    if free:
        entry_id = uuid.uuid4()
        pos = "phrase" if any(" " in f for f in free) else None
        conn.execute(entries_t.insert().values(
            entry_id=entry_id, pair_id=pair_id, lemma=lemma, forms=free, part_of_speech=pos, gloss=gloss,
            example_en=example, source="course", review_status="not_required", confidence=None, agent_version=None,
            refs=[ref], override=None, corrected=False, created_by=by, created_at=now, updated_by=by,
            updated_at=now, archived_at=None))
        conn.execute(forms_t.insert(), [{"pair_id": pair_id, "form_key": form_key(f), "form": f,
                                         "entry_id": entry_id} for f in free])
        history(conn, entry_id, "created", before=None,
                after={"lemma": lemma, "forms": free, "gloss": gloss, "example_en": example, "source": "course",
                       "refs": [ref]}, by=by, reason=reason, at=now)
        changes.append(Change(pair_id, str(entry_id), tuple(free), "created"))
    return changes


def build_for_version(conn: Connection, kind: str, key: str, version: int, payload: dict[str, Any], *,
                      by: str | None, now: datetime, reason: str | None = None) -> list[Change]:
    """Статьи course из опубликованной версии (публикация, откат, сид)."""
    if kind not in BUILT_KINDS:
        return []
    items = content_items(kind, payload)
    if not items:
        return []
    ref = {"kind": kind, "key": key, "version": version}
    why = reason or f"Публикация {kind}:{key}@{version}"
    changes: list[Change] = []
    for pair_id in pairs_for(conn, kind, payload):
        lock_pair(conn, pair_id)
        for item in items:
            changes.extend(_apply_item(conn, pair_id, item, ref, by=by, reason=why, now=now))
    return changes


def build_all_published(conn: Connection, *, now: datetime, reason: str) -> list[Change]:
    """Все опубликованные версии уроков, медиа и текстов — в порядке публикации (первая публикация главнее)."""
    rows = conn.execute(sa.text(
        "SELECT v.kind, v.key, v.version, v.payload FROM content_versions v JOIN content_pointers p "
        "ON p.kind = v.kind AND p.key = v.key AND p.published_version = v.version "
        "WHERE v.kind IN ('lesson', 'media_asset', 'reading') "
        "ORDER BY v.published_at, CASE v.kind WHEN 'lesson' THEN 0 WHEN 'media_asset' THEN 1 ELSE 2 END, v.key"
    )).all()
    changes: list[Change] = []
    for r in rows:
        changes.extend(build_for_version(conn, str(r.kind), str(r.key), int(r.version), dict(r.payload), by=None,
                                         now=now, reason=reason))
    return changes
