"""Словарь курса (INTERNAL_API §2.2, §2.3, §2.5; admin.ts «Память, словарь курса, чтение»; content.ts GlossaryEntry).

Статья — лемма, формы (уникальны в паре среди действующих статей: glossary_forms), перевод RU/UZ, пример, источник:
- course — из контента (domain/glossary_build.py при публикации); правится через версию контента, здесь — только
  `override` (перевод и пример поверх; null — снять);
- methodist — статья методиста (создание, правка, архив);
- ai — перевод teaching_coach (gloss_word) для слова из опубликованного контента: pending → решение методиста
  approve | correct (новый перевод, corrected) | reject (больше не выдаётся, форма остаётся занятой — ИИ не
  переводит её снова).
Все записи — под транзакционной advisory-блокировкой пары (как построение при публикации): гонок форм нет.
Каждая правка — glossary_history (неизменяема), команды сотрудников — аудит glossary.entry_* (outbox), каждое
изменение — catalog.glossary.changed.v1 (memory сбрасывает кеш перевода).

Поиск для memory (`lookup`): версия контента опубликована или бывшая опубликованной (черновик, приостановленная —
404 CONTENT_NOT_FOUND); текст ищется по границам слов в предложении `locator` или во всей версии (422
WORD_NOT_IN_CONTENT); статья — по ключу формы (слова через пробел). Отклонённая статья ИИ не выдаётся (`rejected`).
"""

from __future__ import annotations

import re
import uuid
from datetime import datetime, timedelta
from typing import Any, Final

from sqlalchemy import Select, Text, and_, cast, delete, func, or_, select, text, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_catalog.content import payload_title
from tilhero_catalog.domain.common import audit_payload, decode_cursor, emit_audit, encode_cursor, iso_z
from tilhero_catalog.domain.glossary_build import GLOSSARY_LOCK_CLASS, Change, content_items, emit_changes, with_ref
from tilhero_catalog.domain.text import contains, form_key, forms_of, normalize_form, split_alternatives
from tilhero_catalog.domain.versions import published_rows
from tilhero_catalog.models import (
    ContentVersion,
    GlossaryEntryRow,
    GlossaryFormRow,
    GlossaryHistoryRow,
    LanguagePairRow,
)
from tilhero_catalog.schemas import AiEntryIn, ContentRefIn, GlossaryCreateIn, GlossaryPatchIn, GlossaryReviewIn
from tilhero_common.errors import ApiError, conflict, not_found, unprocessable
from tilhero_common.internal_auth import Actor

E = GlossaryEntryRow
SENTENCE_MAX: Final = 300
HISTORY_LIMIT: Final = 100
_CYRILLIC: Final = re.compile("[Ѐ-ӿ]")
_BAD_OKINA: Final = re.compile("[oOgG]['‘’`]")
REJECTED_REPLACED: Final = "Отклонённый перевод ИИ заменён статьёй методиста"
AI_CREATED: Final = "Перевод ИИ (gloss_word) для слова из контента"


# ---------------------------------------------------------------- ошибки


def entry_not_found() -> ApiError:
    return not_found("GLOSSARY_ENTRY_NOT_FOUND", "Статья словаря не найдена")


def content_not_found() -> ApiError:
    return not_found("CONTENT_NOT_FOUND", "Версия контента не опубликована")


def word_not_in_content() -> ApiError:
    return unprocessable("WORD_NOT_IN_CONTENT", "Этого слова нет в тексте — переводятся только слова контента")


def glossary_invalid(errors: list[dict[str, str]]) -> ApiError:
    return unprocessable("GLOSSARY_INVALID", "Статья не прошла проверку — исправьте отмеченные поля",
                         {"errors": errors})


def _issue(path: str, code: str, message: str) -> dict[str, str]:
    return {"path": path, "code": code, "message": message}


# ---------------------------------------------------------------- представления


def effective_gloss(e: GlossaryEntryRow) -> dict[str, str]:
    return dict(e.override["gloss"]) if e.override else dict(e.gloss)


def effective_example(e: GlossaryEntryRow) -> str | None:
    """override заменяет перевод и пример целиком (пример null — без примера)."""
    return e.override.get("example_en") if e.override else e.example_en


def entry_view(e: GlossaryEntryRow) -> dict[str, Any]:
    """GlossaryEntry (content.ts): действующий перевод и пример — с учётом override."""
    return {
        "entry_id": str(e.entry_id), "pair_id": e.pair_id, "lemma": e.lemma, "forms": list(e.forms),
        "part_of_speech": e.part_of_speech, "gloss": effective_gloss(e), "example_en": effective_example(e),
        "source": e.source, "review_status": e.review_status, "confidence": e.confidence,
        "agent_version": e.agent_version, "refs": [dict(r) for r in e.refs],
        "override": dict(e.override) if e.override else None, "corrected": e.corrected,
        "archived_at": iso_z(e.archived_at), "updated_by": e.updated_by, "updated_at": iso_z(e.updated_at),
    }


def row_view(e: GlossaryEntryRow) -> dict[str, Any]:
    """GlossaryRow (admin.ts) + updated_by (id — имя дополняет admin-bff)."""
    return {
        "entry_id": str(e.entry_id), "pair_id": e.pair_id, "lemma": e.lemma, "forms": list(e.forms),
        "part_of_speech": e.part_of_speech, "gloss": effective_gloss(e), "source": e.source,
        "review_status": e.review_status, "confidence": e.confidence, "refs_count": len(e.refs),
        "overridden": e.override is not None, "updated_at": iso_z(e.updated_at), "updated_by": e.updated_by,
        "updated_by_name": None,
    }


def _history_view(h: GlossaryHistoryRow) -> dict[str, Any]:
    return {"at": iso_z(h.at), "by": h.by, "by_name": None, "action": h.action, "before": h.before,
            "after": h.after, "reason": h.reason}


async def _released(session: AsyncSession, refs: list[tuple[str, str, int]]) -> dict[tuple[str, str, int],
                                                                                       dict[str, Any]]:
    """Тела версий, бывших опубликованными (published | archived с published_at), по (вид, ключ, версия)."""
    if not refs:
        return {}
    rows = (await session.execute(select(ContentVersion.kind, ContentVersion.key, ContentVersion.version,
                                         ContentVersion.payload).where(
        tuple_(ContentVersion.kind, ContentVersion.key, ContentVersion.version).in_(refs),
        ContentVersion.status.in_(("published", "archived")), ContentVersion.published_at.is_not(None)))).all()
    return {(r.kind, r.key, int(r.version)): dict(r.payload) for r in rows}


async def detail_view(session: AsyncSession, e: GlossaryEntryRow) -> dict[str, Any]:
    """GlossaryDetail: статья + названия мест в контенте (null — снято с публикации), история (новые первыми, до
    100), конфликты переводов (в другом месте контента перевод этой формы отличается от действующего)."""
    refs = [dict(r) for r in e.refs]
    titles: dict[tuple[str, str], dict[str, str]] = {}
    by_kind: dict[str, set[str]] = {}
    for r in refs:
        by_kind.setdefault(str(r["kind"]), set()).add(str(r["key"]))
    for kind, keys in by_kind.items():
        for row in await published_rows(session, kind, keys):
            titles[(kind, row.key)] = payload_title(kind, row.payload)
    released = await _released(session, [(str(r["kind"]), str(r["key"]), int(r["version"])) for r in refs])
    keys = {form_key(f) for f in e.forms}
    current = effective_gloss(e)
    conflicts: list[dict[str, Any]] = []
    for r in refs:
        payload = released.get((str(r["kind"]), str(r["key"]), int(r["version"])))
        if payload is None:
            continue
        for item in content_items(str(r["kind"]), payload):
            item_keys = {form_key(f) for f in forms_of(item.text)}
            gloss = {"ru": item.gloss.get("ru", ""), "uz": item.gloss.get("uz", "")}
            if item_keys & keys and gloss != current:
                conflicts.append({"ref": r, "gloss": gloss})
                break
    hist = (await session.execute(select(GlossaryHistoryRow).where(GlossaryHistoryRow.entry_id == e.entry_id)
                                  .order_by(GlossaryHistoryRow.seq.desc()).limit(HISTORY_LIMIT))).scalars().all()
    return {
        **entry_view(e), "updated_by_name": None,
        "refs_titles": [{**r, "title": titles.get((str(r["kind"]), str(r["key"])))} for r in refs],
        "history": [_history_view(h) for h in hist],
        "conflicts": conflicts,
    }


# ---------------------------------------------------------------- общее для записи


async def lock_pair(session: AsyncSession, pair_id: str) -> None:
    await session.execute(text("SELECT pg_advisory_xact_lock(:c, hashtext(:p))"),
                          {"c": GLOSSARY_LOCK_CLASS, "p": pair_id})


async def get_entry(session: AsyncSession, entry_id: uuid.UUID, *, for_update: bool = False) -> GlossaryEntryRow:
    stmt = select(E).where(E.entry_id == entry_id)
    if for_update:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    row = (await session.execute(stmt)).scalar_one_or_none()
    if row is None:
        raise entry_not_found()
    return row


async def _holders(session: AsyncSession, pair_id: str, keys: list[str]) -> dict[str, GlossaryEntryRow]:
    """Ключ формы → действующая статья, которая её занимает."""
    if not keys:
        return {}
    rows = (await session.execute(select(GlossaryFormRow.form_key, E).join(E, E.entry_id == GlossaryFormRow.entry_id)
                                  .where(GlossaryFormRow.pair_id == pair_id,
                                         GlossaryFormRow.form_key.in_(sorted(set(keys)))))).all()
    return {str(k): e for k, e in rows}


def _history(session: AsyncSession, entry_id: uuid.UUID, action: str, *, before: dict[str, Any] | None,
             after: dict[str, Any] | None, by: str | None, reason: str | None, at: datetime) -> None:
    session.add(GlossaryHistoryRow(history_id=uuid.uuid4(), entry_id=entry_id, action=action, before=before,
                                   after=after, by=by, reason=(reason or None) and reason[:500], at=at))


async def _set_forms(session: AsyncSession, e: GlossaryEntryRow, forms: list[str]) -> None:
    await session.execute(delete(GlossaryFormRow).where(GlossaryFormRow.entry_id == e.entry_id))
    session.add_all([GlossaryFormRow(pair_id=e.pair_id, form_key=form_key(f), form=f, entry_id=e.entry_id)
                     for f in forms])
    await session.flush()


async def _archive(session: AsyncSession, e: GlossaryEntryRow, *, by: str | None, reason: str,
                   at: datetime) -> Change:
    await session.execute(delete(GlossaryFormRow).where(GlossaryFormRow.entry_id == e.entry_id))
    e.archived_at = at
    e.updated_at = _bump(e.updated_at, at)
    e.updated_by = by
    _history(session, e.entry_id, "archived", before={"archived_at": None}, after={"archived_at": iso_z(at)},
             by=by, reason=reason, at=at)
    return Change(e.pair_id, str(e.entry_id), tuple(e.forms), "archived")


def _bump(previous: datetime | None, now: datetime) -> datetime:
    """updated_at строго растёт с шагом не меньше 1 мс (If-Match сравнивает значение с точностью до мс)."""
    if previous is not None and now <= previous + timedelta(milliseconds=1):
        return previous + timedelta(milliseconds=1)
    return now


def _gloss_issues(path: str, gloss: dict[str, str]) -> list[dict[str, str]]:
    out = []
    if _CYRILLIC.search(gloss["uz"]):
        out.append(_issue(f"{path}.uz", "LOCALE_SCRIPT", "Узбекский текст — только латиницей"))
    elif _BAD_OKINA.search(gloss["uz"]):
        out.append(_issue(f"{path}.uz", "LOCALE_SCRIPT", "oʻ и gʻ пишутся с ʻ (U+02BB), а не с апострофом"))
    return out


def _normalized_forms(forms: list[str], path: str = "forms") -> tuple[list[str], list[dict[str, str]]]:
    out: list[str] = []
    keys: set[str] = set()
    issues: list[dict[str, str]] = []
    for i, raw in enumerate(forms):
        form = normalize_form(raw)
        key = form_key(form)
        if not key:
            issues.append(_issue(f"{path}[{i}]", "VALUE_REQUIRED", "Форма — слово или выражение (EN)"))
            continue
        if _CYRILLIC.search(form):
            issues.append(_issue(f"{path}[{i}]", "LOCALE_SCRIPT", "Формы — на изучаемом языке (EN)"))
            continue
        if key in keys:
            continue
        keys.add(key)
        out.append(form)
    return out, issues


async def _pair_exists(session: AsyncSession, pair_id: str) -> bool:
    return await session.scalar(select(LanguagePairRow.pair_id).where(LanguagePairRow.pair_id == pair_id)) \
        is not None


def _entry_snapshot(e: GlossaryEntryRow, fields: list[str]) -> dict[str, Any]:
    return {f: (list(e.forms) if f == "forms" else getattr(e, f)) for f in fields}


# ---------------------------------------------------------------- поиск для memory (§2.3)


def segments(kind: str, p: dict[str, Any]) -> list[tuple[str, str]]:
    """(locator, текст) — английский текст версии, видимый ученику: reading — предложения (s_id), вопросы;
    media_asset — реплики транскрипта (индекс строкой), фразы (ph:<i>); lesson — примеры (ex:<i>), ключевые слова и
    их примеры (kw:<i>, сначала пример — контекст для перевода), задания (ci:<i>); scenario — реплики узлов (node_id)
    и образцы реплик ученика. Ключи ответов сюда не входят."""
    out: list[tuple[str, str]] = []
    if kind == "reading":
        out.extend((str(s["s_id"]), str(s["text_en"])) for para in p["paragraphs"] for s in para["sentences"])
        for q in p.get("questions") or []:
            out.append((f"q:{q['question_id']}", str(q["prompt_en"])))
            out.extend((f"q:{q['question_id']}", str(o)) for o in q.get("options") or [])
    elif kind == "media_asset":
        out.extend((str(i), str(t["text_en"])) for i, t in enumerate(p.get("transcript") or []))
        out.extend((f"ph:{i}", str(ph["en"])) for i, ph in enumerate(p.get("phrases") or []))
    elif kind == "lesson":
        out.extend((f"ex:{i}", str(ex["en"])) for i, ex in enumerate(p.get("examples") or []))
        for i, kw in enumerate(p.get("key_words") or []):
            if kw.get("example_en"):
                out.append((f"kw:{i}", str(kw["example_en"])))
            out.append((f"kw:{i}", str(kw["en"])))
        for i, item in enumerate(p.get("control_items") or []):
            out.append((f"ci:{i}", str(item["prompt_en"])))
            out.extend((f"ci:{i}", str(o)) for o in item.get("options") or [])
    elif kind == "scenario":
        for node_id, node in (p.get("nodes") or {}).items():
            out.append((str(node_id), str(node["line_en"])))
            for t in node.get("transitions") or []:
                out.extend((str(node_id), str(ex)) for ex in t.get("examples_en") or [])
    return out


async def _content_version(session: AsyncSession, ref: ContentRefIn) -> dict[str, Any]:
    payload = (await _released(session, [(ref.kind, ref.key, ref.version)])).get((ref.kind, ref.key, ref.version))
    if payload is None:
        raise content_not_found()
    return payload


def find_in_content(kind: str, payload: dict[str, Any], query: str, locator: str | None) -> tuple[str, str]:
    """(locator, предложение) первого места, где запрос встречается по границам слов; иначе 422."""
    if not form_key(query):
        raise word_not_in_content()
    for loc, sentence in segments(kind, payload):
        if locator is not None and loc != locator:
            continue
        if contains(sentence, query):
            return loc, sentence[:SENTENCE_MAX]
    raise word_not_in_content()


def _note(kind: str, payload: dict[str, Any], key: str) -> dict[str, str] | None:
    """Пояснение глоссария текста («фразовый глагол») для этого слова."""
    if kind != "reading":
        return None
    for item in payload.get("glossary") or []:
        if form_key(str(item["en"])) == key and item.get("note"):
            return dict(item["note"])
    return None


async def lookup(session: AsyncSession, pair_id: str, query: str, ref: ContentRefIn) -> dict[str, Any]:
    """{in_content, sentence_en, locator, entry: GlossaryEntry | null, rejected, note}."""
    payload = await _content_version(session, ref)
    locator, sentence = find_in_content(ref.kind, payload, query, ref.locator)
    key = form_key(query)
    entry = (await _holders(session, pair_id, [key])).get(key)
    rejected = entry is not None and entry.source == "ai" and entry.review_status == "rejected"
    return {
        "in_content": True, "sentence_en": sentence, "locator": locator,
        "entry": entry_view(entry) if entry is not None and not rejected else None,
        "rejected": rejected, "note": _note(ref.kind, payload, key),
    }


async def ai_entry(session: AsyncSession, body: AiEntryIn, now: datetime) -> tuple[dict[str, Any], bool]:
    """Перевод ИИ → статья ai pending (201). Любая форма уже занята действующей статьёй → она же (200, перевод не
    меняется; у статьи ai на проверке дописывается новое место в контенте — очередь методиста сортируется по числу
    мест). Слово должно быть в этой опубликованной версии контента (иначе 404 / 422) — произвольный текст в словарь
    не попадает."""
    payload = await _content_version(session, body.content_ref)
    find_in_content(body.content_ref.kind, payload, body.surface, body.content_ref.locator)
    if not await _pair_exists(session, body.pair_id):
        raise not_found("PAIR_NOT_FOUND", "Языковая пара не найдена")
    forms, _ = _normalized_forms([body.surface, body.lemma, *body.forms])
    forms = forms[:8]
    if not forms:
        raise word_not_in_content()
    await lock_pair(session, body.pair_id)
    held = await _holders(session, body.pair_id, [form_key(f) for f in forms])
    ref = {"kind": body.content_ref.kind, "key": body.content_ref.key, "version": body.content_ref.version}
    if held:
        existing = held.get(form_key(forms[0])) or next(iter(held.values()))
        if existing.source == "ai" and existing.review_status == "pending":
            # перевод не меняется; новое место в контенте поднимает слово в очереди методиста (сортировка по refs)
            refs = with_ref(list(existing.refs), ref)
            if refs is not None and len(refs) > len(existing.refs):
                existing.refs = refs
                await session.flush()
        return entry_view(existing), False
    gloss = body.gloss.model_dump()
    e = E(entry_id=uuid.uuid4(), pair_id=body.pair_id, lemma=body.lemma, forms=forms,
          part_of_speech=body.part_of_speech, gloss=gloss, example_en=None, source="ai", review_status="pending",
          confidence=round(float(body.confidence), 4), agent_version=body.agent_version, refs=[ref], override=None,
          corrected=False, created_by=None, created_at=now, updated_by=None, updated_at=now, archived_at=None)
    session.add(e)
    await session.flush()
    await _set_forms(session, e, forms)
    _history(session, e.entry_id, "created", before=None,
             after={"lemma": e.lemma, "forms": forms, "gloss": gloss, "source": "ai", "confidence": e.confidence,
                    "agent_version": e.agent_version, "refs": [ref]},
             by=None, reason=AI_CREATED, at=now)
    await session.flush()
    await emit_changes(session, [Change(e.pair_id, str(e.entry_id), tuple(forms), "created")], now)
    return entry_view(e), True


async def by_forms(session: AsyncSession, pair_id: str, forms: list[str]) -> dict[str, Any]:
    """{items: [{form, entry | null}]} — статьи по формам (варианты через « / » — каждая отдельно)."""
    wanted: list[tuple[str, list[str]]] = []
    for raw in forms:
        variants = [form_key(normalize_form(v)) for v in split_alternatives(raw)]
        wanted.append((raw, [k for k in variants if k]))
    held = await _holders(session, pair_id, [k for _, keys in wanted for k in keys])
    items = []
    for raw, keys in wanted:
        entry = next((held[k] for k in keys if k in held), None)
        items.append({"form": raw, "entry": entry_view(entry) if entry is not None else None})
    return {"items": items}


# ---------------------------------------------------------------- админка (§2.5)


def _list_stmt(pair_id: str | None, q: str | None, source: str | None, review_status: str | None,
               archived: bool) -> Select[Any]:
    stmt = select(E)
    stmt = stmt.where(E.archived_at.is_not(None) if archived else E.archived_at.is_(None))
    if pair_id:
        stmt = stmt.where(E.pair_id == pair_id)
    if source:
        stmt = stmt.where(E.source == source)
    if review_status:
        stmt = stmt.where(E.review_status == review_status)
    if q:
        pattern = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        stmt = stmt.where(or_(E.lemma.ilike(pattern, escape="\\"),
                              cast(E.forms, Text).ilike(pattern, escape="\\"),
                              E.gloss["ru"].astext.ilike(pattern, escape="\\"),
                              E.gloss["uz"].astext.ilike(pattern, escape="\\"),
                              E.override["gloss"]["ru"].astext.ilike(pattern, escape="\\"),
                              E.override["gloss"]["uz"].astext.ilike(pattern, escape="\\")))
    return stmt


async def admin_list(session: AsyncSession, *, pair_id: str | None, q: str | None, source: str | None,
                     review_status: str | None, archived: bool, cursor: str | None, limit: int) -> dict[str, Any]:
    """Page<GlossaryRow>: очередь ИИ (review_status=pending) — по числу мест в контенте (больше — выше), остальное —
    по лемме. Архивные — только с archived=true."""
    stmt = _list_stmt(pair_id, q, source, review_status, archived)
    after = decode_cursor(cursor, 2)
    refs_count = func.jsonb_array_length(E.refs)
    lemma = func.lower(E.lemma).collate("C")  # порядок и курсор не зависят от локали БД
    by_refs = review_status == "pending"
    if by_refs:
        if after is not None:
            n, seq = int(after[0]), int(after[1])
            stmt = stmt.where(or_(refs_count < n, and_(refs_count == n, E.seq > seq)))
        stmt = stmt.order_by(refs_count.desc(), E.seq)
    else:
        if after is not None:
            stmt = stmt.where(or_(lemma > str(after[0]), and_(lemma == str(after[0]), E.seq > int(after[1]))))
        stmt = stmt.order_by(lemma, E.seq)
    rows = list((await session.execute(stmt.limit(limit + 1))).scalars().all())
    page = rows[:limit]
    next_cursor = None
    if len(rows) > limit and page:
        last = page[-1]
        next_cursor = encode_cursor(len(last.refs), last.seq) if by_refs else encode_cursor(last.lemma.lower(),
                                                                                             last.seq)
    return {"items": [row_view(e) for e in page], "next_cursor": next_cursor}


async def stats(session: AsyncSession, pair_id: str | None) -> dict[str, Any]:
    """Счётчики для обзора и очереди: ai_glosses_pending (MemoryStats в admin.ts — из catalog)."""
    stmt = (select(E.source, E.review_status, func.count(), func.count(E.override))
            .where(E.archived_at.is_(None)).group_by(E.source, E.review_status))
    if pair_id:
        stmt = stmt.where(E.pair_id == pair_id)
    entries = {"course": 0, "methodist": 0, "ai": 0}
    ai = {"pending": 0, "approved": 0, "rejected": 0}
    overridden = 0
    for source, status, n, n_override in (await session.execute(stmt)).all():
        entries[str(source)] += int(n)
        overridden += int(n_override)
        if source == "ai":
            ai[str(status)] = int(n)
    return {"pair_id": pair_id, "ai_glosses_pending": ai["pending"], "ai_approved": ai["approved"],
            "ai_rejected": ai["rejected"], "entries": entries, "overridden": overridden}


async def _take_forms(session: AsyncSession, pair_id: str, forms: list[str], *, own: uuid.UUID | None, by: str,
                      at: datetime) -> list[Change]:
    """Формы свободны или заняты этой статьёй; отклонённая статья ИИ уступает форму методисту (архив); иначе 409
    FORM_TAKEN {entry_id}."""
    held = await _holders(session, pair_id, [form_key(f) for f in forms])
    changes: list[Change] = []
    replaced: set[uuid.UUID] = set()
    for key, other in held.items():
        if other.entry_id == own or other.entry_id in replaced:
            continue
        if other.source == "ai" and other.review_status == "rejected":
            changes.append(await _archive(session, other, by=by, reason=REJECTED_REPLACED, at=at))
            replaced.add(other.entry_id)
            continue
        raise conflict("FORM_TAKEN", "Эта форма уже есть в другой статье словаря",
                       {"entry_id": str(other.entry_id), "form": key})
    if changes:
        await session.flush()
    return changes


async def create(session: AsyncSession, body: GlossaryCreateIn, actor: Actor, now: datetime) -> GlossaryEntryRow:
    issues: list[dict[str, str]] = []
    if not await _pair_exists(session, body.pair_id):
        issues.append(_issue("pair_id", "UNKNOWN_REF", f"Языковая пара «{body.pair_id}» не существует"))
    forms, form_issues = _normalized_forms(body.forms)
    issues.extend(form_issues)
    gloss = body.gloss.model_dump()
    issues.extend(_gloss_issues("gloss", gloss))
    if issues:
        raise glossary_invalid(issues)
    await lock_pair(session, body.pair_id)
    changes = await _take_forms(session, body.pair_id, forms, own=None, by=actor.id, at=now)
    e = E(entry_id=uuid.uuid4(), pair_id=body.pair_id, lemma=body.lemma, forms=forms,
          part_of_speech=body.part_of_speech, gloss=gloss, example_en=body.example_en, source="methodist",
          review_status="not_required", confidence=None, agent_version=None, refs=[], override=None, corrected=False,
          created_by=actor.id, created_at=now, updated_by=actor.id, updated_at=now, archived_at=None)
    session.add(e)
    await session.flush()
    await _set_forms(session, e, forms)
    _history(session, e.entry_id, "created", before=None,
             after={"lemma": e.lemma, "forms": forms, "part_of_speech": e.part_of_speech, "gloss": gloss,
                    "example_en": e.example_en, "source": "methodist"},
             by=actor.id, reason=body.reason, at=now)
    await session.flush()
    await emit_audit(session, audit_payload(actor, "glossary.entry_created", "glossary_entry", str(e.entry_id),
                                            after={"pair_id": e.pair_id, "source": "methodist", "forms": forms},
                                            reason=body.reason))
    await emit_changes(session, [*changes, Change(e.pair_id, str(e.entry_id), tuple(forms), "created")], now)
    return e


def _if_match(value: str | None) -> str | None:
    if value is None:
        return None
    v = value.strip()
    if v.startswith("W/"):
        v = v[2:]
    return v.strip('"') or None


def _check_version(e: GlossaryEntryRow, if_match: str | None) -> None:
    expected = _if_match(if_match)
    if expected is None:
        raise ApiError(428, "IF_MATCH_REQUIRED", "Нужен заголовок If-Match с updated_at статьи")
    if expected != iso_z(e.updated_at):
        raise conflict("VERSION_CONFLICT", "Статья изменилась — обновите страницу",
                       {"updated_at": iso_z(e.updated_at)})


def _not_archived(e: GlossaryEntryRow) -> None:
    if e.archived_at is not None:
        raise conflict("ENTRY_ARCHIVED", "Статья в архиве — её не правят")


async def patch(session: AsyncSession, entry_id: uuid.UUID, body: GlossaryPatchIn, if_match: str | None,
                actor: Actor, now: datetime) -> GlossaryEntryRow:
    e = await get_entry(session, entry_id)
    await lock_pair(session, e.pair_id)
    e = await get_entry(session, entry_id, for_update=True)
    _check_version(e, if_match)
    _not_archived(e)
    given = body.model_fields_set - {"reason"}
    if e.source == "course":
        return await _patch_course(session, e, body, given, actor, now)
    issues: list[dict[str, str]] = []
    if "override" in given:
        issues.append(_issue("override", "OVERRIDE_COURSE_ONLY",
                             "Правка поверх контента — только у статей из контента курса; здесь правьте поля"))
    for name in ("lemma", "forms", "gloss"):
        if name in given and getattr(body, name) is None:
            issues.append(_issue(name, "VALUE_REQUIRED", "Поле не может быть пустым"))
    forms: list[str] | None = None
    if body.forms is not None:
        forms, form_issues = _normalized_forms(body.forms)
        issues.extend(form_issues)
    if body.gloss is not None:
        issues.extend(_gloss_issues("gloss", body.gloss.model_dump()))
    if issues:
        raise glossary_invalid(issues)
    new: dict[str, Any] = {}
    if body.lemma is not None:
        new["lemma"] = body.lemma
    if forms is not None:
        new["forms"] = forms
    if "part_of_speech" in given:
        new["part_of_speech"] = body.part_of_speech
    if body.gloss is not None:
        new["gloss"] = body.gloss.model_dump()
    if "example_en" in given:
        new["example_en"] = body.example_en
    changed = sorted(k for k, v in new.items() if (list(e.forms) if k == "forms" else getattr(e, k)) != v)
    if not changed:
        return e
    changes: list[Change] = []
    old_forms = list(e.forms)
    if "forms" in changed and forms is not None:
        changes = await _take_forms(session, e.pair_id, forms, own=e.entry_id, by=actor.id, at=now)
    before = _entry_snapshot(e, changed)
    for k in changed:
        setattr(e, k, new[k])
    if "forms" in changed and forms is not None:
        await _set_forms(session, e, forms)
    e.updated_by = actor.id
    e.updated_at = _bump(e.updated_at, now)
    _history(session, e.entry_id, "updated", before=before, after=_entry_snapshot(e, changed), by=actor.id,
             reason=body.reason, at=now)
    await session.flush()
    await emit_audit(session, audit_payload(actor, "glossary.entry_updated", "glossary_entry", str(e.entry_id),
                                            before={"forms": old_forms} if "forms" in changed else None,
                                            after={"fields": changed, "source": e.source, "forms": list(e.forms)},
                                            reason=body.reason))
    union = tuple(dict.fromkeys([*old_forms, *e.forms]))
    await emit_changes(session, [*changes, Change(e.pair_id, str(e.entry_id), union, "updated")], now)
    return e


async def _patch_course(session: AsyncSession, e: GlossaryEntryRow, body: GlossaryPatchIn, given: set[str],
                        actor: Actor, now: datetime) -> GlossaryEntryRow:
    """Статья course: только override (перевод и пример поверх контента), null — снять."""
    locked = sorted(given - {"override"})
    if locked:
        raise glossary_invalid([_issue(name, "COURSE_ENTRY_LOCKED",
                                       "Статья из контента правится через версию контента — здесь только override")
                                for name in locked])
    if "override" not in given:
        return e
    if body.override is None:
        if e.override is None:
            return e
        new_override = None
    else:
        gloss = body.override.gloss.model_dump()
        issues = _gloss_issues("override.gloss", gloss)
        if issues:
            raise glossary_invalid(issues)
        new_override = {"gloss": gloss, "example_en": body.override.example_en, "by": actor.id, "at": iso_z(now)}
        if e.override is not None and e.override.get("gloss") == gloss and \
                e.override.get("example_en") == body.override.example_en:
            return e
    before = {"override": e.override}
    e.override = new_override
    e.updated_by = actor.id
    e.updated_at = _bump(e.updated_at, now)
    _history(session, e.entry_id, "overridden", before=before, after={"override": new_override}, by=actor.id,
             reason=body.reason, at=now)
    await session.flush()
    await emit_audit(session, audit_payload(actor, "glossary.entry_updated", "glossary_entry", str(e.entry_id),
                                            before={"overridden": before["override"] is not None},
                                            after={"fields": ["override"], "source": "course",
                                                   "overridden": new_override is not None},
                                            reason=body.reason))
    await emit_changes(session, [Change(e.pair_id, str(e.entry_id), tuple(e.forms), "updated")], now)
    return e


async def review(session: AsyncSession, entry_id: uuid.UUID, body: GlossaryReviewIn, actor: Actor,
                 now: datetime) -> GlossaryEntryRow:
    """Решение по переводу ИИ: approve | correct (новый перевод → corrected) | reject. Не ai, уже решённая или в
    архиве → 409 NOT_PENDING."""
    e = await get_entry(session, entry_id)
    await lock_pair(session, e.pair_id)
    e = await get_entry(session, entry_id, for_update=True)
    if e.source != "ai" or e.review_status != "pending" or e.archived_at is not None:
        raise conflict("NOT_PENDING", "Решение принимается только по переводу ИИ на проверке",
                       {"source": e.source, "review_status": e.review_status,
                        "archived": e.archived_at is not None})
    if body.decision == "correct":
        if body.gloss is None:
            raise glossary_invalid([_issue("gloss", "VALUE_REQUIRED", "Укажите исправленный перевод")])
        issues = _gloss_issues("gloss", body.gloss.model_dump())
        if issues:
            raise glossary_invalid(issues)
    before = {"review_status": e.review_status, "gloss": dict(e.gloss), "corrected": e.corrected}
    if body.decision == "correct" and body.gloss is not None:
        e.gloss = body.gloss.model_dump()
        e.corrected = True
    e.review_status = "rejected" if body.decision == "reject" else "approved"
    e.updated_by = actor.id
    e.updated_at = _bump(e.updated_at, now)
    _history(session, e.entry_id, "reviewed", before=before,
             after={"review_status": e.review_status, "gloss": dict(e.gloss), "corrected": e.corrected},
             by=actor.id, reason=body.note, at=now)
    await session.flush()
    await emit_audit(session, audit_payload(actor, "glossary.entry_reviewed", "glossary_entry", str(e.entry_id),
                                            before={"review_status": "pending"},
                                            after={"decision": body.decision, "review_status": e.review_status,
                                                   "forms": list(e.forms)},
                                            reason=body.note))
    await emit_changes(session, [Change(e.pair_id, str(e.entry_id), tuple(e.forms), "reviewed")], now)
    return e


async def archive(session: AsyncSession, entry_id: uuid.UUID, reason: str, actor: Actor, now: datetime) -> None:
    """Архив — только статьи методиста (course правится через контент, ai — решением по переводу); повтор — no-op."""
    e = await get_entry(session, entry_id)
    await lock_pair(session, e.pair_id)
    e = await get_entry(session, entry_id, for_update=True)
    if e.source != "methodist":
        raise conflict("ARCHIVE_NOT_ALLOWED", "В архив отправляются только статьи методиста", {"source": e.source})
    if e.archived_at is not None:
        return
    change = await _archive(session, e, by=actor.id, reason=reason, at=now)
    await session.flush()
    await emit_audit(session, audit_payload(actor, "glossary.entry_archived", "glossary_entry", str(e.entry_id),
                                            before={"archived": False},
                                            after={"archived": True, "forms": list(e.forms)}, reason=reason))
    await emit_changes(session, [change], now)
