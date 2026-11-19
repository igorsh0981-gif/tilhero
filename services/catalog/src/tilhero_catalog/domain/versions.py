"""Жизненный цикл версий контента (INTERNAL_API §1.2, AT-26…29).

draft → submit (бизнес-правила, 422 CONTENT_INVALID) → in_review → review: approve (content.review, проверяющий не
правил версию — иначе 409 SELF_REVIEW; локализации RU/UZ checked) | return (→ draft) → approved → publish
(content.publish; повторная проверка целостности курса в режиме публикации; медиа — ещё и подтверждённые права,
сценарий — зелёный прогон этой версии) → published (прежняя published → archived, указатель обновлён).
archive — снять с публикации (указатель → null; 409 CONTENT_IN_USE, если на ключ ссылается опубликованное);
rollback {to_version} — опубликовать прежде опубликованную архивную версию (повторная проверка).
Правка опубликованного — новая версия-черновик (`new_version`), DRAFT_EXISTS — у ключа уже есть черновик или
версия на проверке. Конкурентные команды по одному ключу сериализуются advisory-блокировкой (kind, key).

Каждая команда — запись аудита admin.audit.recorded.v1 (outbox, та же транзакция); публикация, откат и снятие —
событие catalog.version.published.v1.
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any, Final

from sqlalchemy import and_, func, or_, select, text, update
from sqlalchemy.dialects.postgresql import distinct_on, insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_catalog.content import KEY_FIELDS, Band, payload_level, payload_title
from tilhero_catalog.domain.common import (
    VERSION_PUBLISHED,
    as_uuid_or_none,
    audit_payload,
    content_not_found,
    emit_audit,
    emit_event,
    iso_z,
    payload_hash,
    utcnow,
    version_not_found,
    version_object_id,
)
from tilhero_catalog.domain.scenario_test import run_test
from tilhero_catalog.domain.validation import (
    DOWN_REFS,
    Issue,
    Mode,
    Ref,
    RefContext,
    down_refs_of,
    locale_state,
    normalized,
    parse_schema,
    refs_of,
    validate,
)
from tilhero_catalog.models import ContentPointer, ContentVersion, LanguagePairRow, MediaBlob, ScenarioTestRunRow
from tilhero_common.errors import ApiError, conflict, unprocessable
from tilhero_common.internal_auth import Actor

LOCK_CLASS: Final = 811_001
GRAPH_LOCK_CLASS: Final = 811_003
OPEN_STATUSES: Final = ("draft", "in_review")
CV = ContentVersion


@dataclass(frozen=True)
class Policy:
    """Настройки, влияющие на проверку: «сегодня» по Ташкенту и флаг внешних источников медиа."""

    today: date
    external_sources: bool


def content_invalid(issues: Iterable[Issue]) -> ApiError:
    errors = [i.as_dict() for i in issues][:100]
    return unprocessable("CONTENT_INVALID", "Содержимое не прошло проверку — исправьте отмеченные поля",
                         {"errors": errors})


async def lock_graph(session: AsyncSession) -> None:
    """Общая блокировка графа опубликованного контента (транзакционная advisory, решение по ревью): публикация,
    снятие, откат, приостановка медиа и публикация пары проверяют ссылки (UNKNOWN_REF, CONTENT_IN_USE, готовность)
    и меняют опубликованное строго по очереди. Порядок взятия — сначала граф, потом ключ: без взаимоблокировок."""
    await session.execute(text("SELECT pg_advisory_xact_lock(:c, 0)"), {"c": GRAPH_LOCK_CLASS})


async def lock_key(session: AsyncSession, kind: str, key: str) -> None:
    await session.execute(text("SELECT pg_advisory_xact_lock(:c, hashtext(:k))"),
                          {"c": LOCK_CLASS, "k": f"{kind}:{key}"})


# ---------------------------------------------------------------- чтение версий


async def get_version(session: AsyncSession, kind: str, key: str, version: int, *,
                      for_update: bool = False) -> ContentVersion:
    stmt = select(CV).where(CV.kind == kind, CV.key == key, CV.version == version)
    if for_update:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    row = (await session.execute(stmt)).scalar_one_or_none()
    if row is None:
        if not await key_exists(session, kind, key):
            raise content_not_found(kind, key)
        raise version_not_found(kind, key, version)
    return row


async def key_exists(session: AsyncSession, kind: str, key: str) -> bool:
    found = await session.scalar(select(CV.id).where(CV.kind == kind, CV.key == key).limit(1))
    return found is not None


async def versions_of(session: AsyncSession, kind: str, key: str) -> list[ContentVersion]:
    rows = (await session.execute(select(CV).where(CV.kind == kind, CV.key == key)
                                  .order_by(CV.version.desc()))).scalars().all()
    if not rows:
        raise content_not_found(kind, key)
    return list(rows)


async def pointer_of(session: AsyncSession, kind: str, key: str, *, for_update: bool = False) -> ContentPointer:
    stmt = select(ContentPointer).where(ContentPointer.kind == kind, ContentPointer.key == key)
    if for_update:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    ptr = (await session.execute(stmt)).scalar_one_or_none()
    if ptr is None:
        raise content_not_found(kind, key)
    return ptr


def _group(refs: Iterable[Ref]) -> dict[str, set[str]]:
    out: dict[str, set[str]] = defaultdict(set)
    for kind, key in refs:
        out[kind].add(key)
    return out


async def latest_payloads(session: AsyncSession, refs: Iterable[Ref],
                          all_of: Iterable[str] = ()) -> dict[Ref, dict[str, Any]]:
    """Последняя версия (любой статус) каждого ключа: refs и все ключи видов all_of."""
    out: dict[Ref, tuple[int, dict[str, Any]]] = {}
    grouped = _group(refs)
    for kind in set(all_of):
        grouped.setdefault(kind, set())
    for kind, keys in grouped.items():
        stmt = select(CV.key, CV.version, CV.payload).where(CV.kind == kind)
        if kind not in set(all_of):
            stmt = stmt.where(CV.key.in_(sorted(keys)))
        for key, version, payload in (await session.execute(stmt)).all():
            cur = out.get((kind, key))
            if cur is None or version > cur[0]:
                out[(kind, key)] = (version, payload)
    return {ref: payload for ref, (_, payload) in out.items()}


async def published_rows(session: AsyncSession, kind: str,
                         keys: Iterable[str] | None = None) -> list[ContentVersion]:
    """Опубликованные версии вида — то, что видит ученик (по указателям)."""
    stmt = (select(CV).join(ContentPointer, and_(ContentPointer.kind == CV.kind, ContentPointer.key == CV.key,
                                                 ContentPointer.published_version == CV.version))
            .where(CV.kind == kind))
    if keys is not None:
        stmt = stmt.where(CV.key.in_(sorted(set(keys))))
    return list((await session.execute(stmt)).scalars().all())


async def published_payloads(session: AsyncSession, refs: Iterable[Ref],
                             all_of: Iterable[str] = ()) -> dict[Ref, dict[str, Any]]:
    out: dict[Ref, dict[str, Any]] = {}
    grouped = _group(refs)
    every = set(all_of)
    for kind in every:
        grouped.setdefault(kind, set())
    for kind, keys in grouped.items():
        for row in await published_rows(session, kind, None if kind in every else keys):
            out[(kind, row.key)] = row.payload
    return out


async def latest_test_run(session: AsyncSession, row: ContentVersion) -> dict[str, Any] | None:
    """Последний прогон этой версии, если он сделан по текущему телу (иначе устарел → null)."""
    if row.kind != "scenario":
        return None
    run = (await session.execute(
        select(ScenarioTestRunRow).where(ScenarioTestRunRow.key == row.key, ScenarioTestRunRow.version == row.version)
        .order_by(ScenarioTestRunRow.seq.desc()).limit(1))).scalar_one_or_none()
    if run is None or run.payload_hash != row.payload_hash:
        return None
    return run.result


async def load_context(session: AsyncSession, kind: str, payload: dict[str, Any], mode: Mode, policy: Policy,
                       row: ContentVersion | None = None) -> RefContext:
    refs = refs_of(kind, payload)
    all_of = ("skill",) if kind == "skill" else ()
    ctx = RefContext(mode=mode, today=policy.today, external_sources=policy.external_sources,
                     existing=await latest_payloads(session, refs, all_of),
                     published=await published_payloads(session, refs, all_of))
    if kind == "course":
        ctx.pairs = set((await session.execute(select(LanguagePairRow.pair_id))).scalars().all())
    blob = payload.get("audio_blob_id") if kind == "media_asset" else None
    if isinstance(blob, str):
        try:
            blob_uuid = uuid.UUID(blob)
        except ValueError:
            blob_uuid = None
        if blob_uuid is not None and await session.get(MediaBlob, blob_uuid) is not None:
            ctx.blobs = {blob}
    if mode == "publish" and row is not None:
        ctx.locale_checks = dict(row.locale_checks or {})
        ctx.rights_approved = row.rights_approved_at is not None
        run = await latest_test_run(session, row)
        ctx.test_run_ok = bool(run and run.get("ok"))
    return ctx


# ---------------------------------------------------------------- представления (admin.ts)


def version_meta(v: ContentVersion) -> dict[str, Any]:
    """ContentVersionMeta без имён сотрудников (*_name дополняет admin-bff по id)."""
    return {
        "version": v.version, "status": v.status,
        "author_id": v.author_id, "author_name": None,
        "created_at": iso_z(v.created_at), "submitted_at": iso_z(v.submitted_at),
        "reviewer_id": v.reviewer_id, "reviewer_name": None,
        "reviewed_at": iso_z(v.reviewed_at), "review_note": v.review_note,
        "locale_checks": {"ru": v.locale_checks.get("ru", "draft"), "uz": v.locale_checks.get("uz", "draft")},
        "rights_approved_by": v.rights_approved_by, "rights_approved_by_name": None,
        "rights_approved_at": iso_z(v.rights_approved_at),
        "published_by": v.published_by, "published_by_name": None, "published_at": iso_z(v.published_at),
        "archived_at": iso_z(v.archived_at), "suspended_at": iso_z(v.suspended_at),
        "suspend_reason": v.suspend_reason,
    }


async def version_view(session: AsyncSession, v: ContentVersion) -> dict[str, Any]:
    """ContentVersion: мета + тело, хеш и последний тестовый прогон (сценарий)."""
    return {**version_meta(v), "kind": v.kind, "key": v.key, "payload": v.payload, "payload_hash": v.payload_hash,
            "test_run": await latest_test_run(session, v)}


def rights_warning(kind: str, published_payload: dict[str, Any] | None, has_suspended: bool, today: date,
                   warning_days: int) -> str | None:
    if kind != "media_asset":
        return None
    if published_payload is None:
        return "expired" if has_suspended else None
    valid_to = ((published_payload.get("rights") or {}).get("valid_to"))
    if not valid_to:
        return None
    days = (date.fromisoformat(valid_to) - today).days
    if days < 0:
        return "expired"
    return "expiring" if days <= warning_days else None


def row_view(kind: str, key: str, latest: ContentVersion, published_version: int | None,
             published_payload: dict[str, Any] | None, has_suspended: bool, today: date,
             warning_days: int) -> dict[str, Any]:
    """ContentRow (admin.ts): заголовок и уровень — по последней версии; updated_by — id (имя дополняет admin-bff)."""
    return {
        "kind": kind, "key": key,
        "title": payload_title(kind, latest.payload),
        "published_version": published_version,
        "latest_version": latest.version,
        "latest_status": latest.status,
        "level": payload_level(kind, latest.payload),
        "updated_at": iso_z(max(t for t in (latest.updated_at, latest.reviewed_at, latest.published_at,
                                            latest.archived_at, latest.suspended_at) if t is not None)),
        "updated_by": latest.updated_by,
        "updated_by_name": None,
        "rights_warning": rights_warning(kind, published_payload, has_suspended, today, warning_days),
    }


async def rows_for(session: AsyncSession, kind: str, *, keys: Iterable[str] | None = None,
                   status: str | None = None, level: Band | None = None, q: str | None = None,
                   after: str | None = None, limit: int | None = None, today: date,
                   warning_days: int) -> list[dict[str, Any]]:
    """Строки списка вида: последняя версия ключа + опубликованная (указатель) + признак приостановки."""
    latest_sq = (select(CV.id, CV.key).where(CV.kind == kind).ext(distinct_on(CV.key))
                 .order_by(CV.key, CV.version.desc()).subquery("latest"))
    stmt = (select(CV, ContentPointer.published_version)
            .join(latest_sq, latest_sq.c.id == CV.id)
            .outerjoin(ContentPointer, and_(ContentPointer.kind == CV.kind, ContentPointer.key == CV.key)))
    if keys is not None:
        stmt = stmt.where(CV.key.in_(sorted(set(keys))))
    if status == "published":
        stmt = stmt.where(ContentPointer.published_version.is_not(None))
    elif status is not None:
        stmt = stmt.where(CV.status == status)
    if level is not None:
        stmt = stmt.where(func.coalesce(CV.payload["level"].astext, CV.payload["level_start"].astext) == level)
    if q:
        pattern = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        title = "instruction" if kind == "media_exercise" else "title"
        stmt = stmt.where(or_(CV.key.ilike(pattern, escape="\\"),
                              CV.payload[title]["ru"].astext.ilike(pattern, escape="\\"),
                              CV.payload[title]["uz"].astext.ilike(pattern, escape="\\")))
    if after is not None:
        stmt = stmt.where(CV.key > after)
    stmt = stmt.order_by(CV.key)
    if limit is not None:
        stmt = stmt.limit(limit)
    rows = (await session.execute(stmt)).all()
    if not rows:
        return []
    page_keys = [r[0].key for r in rows]
    published = {(kind, r.key): r.payload for r in await published_rows(session, kind, page_keys)}
    suspended: set[str] = set()
    if kind == "media_asset":
        suspended = set((await session.execute(
            select(CV.key).where(CV.kind == kind, CV.status == "suspended", CV.key.in_(page_keys)))).scalars().all())
    return [row_view(kind, latest.key, latest, ptr_version, published.get((kind, latest.key)),
                     latest.key in suspended, today, warning_days) for latest, ptr_version in rows]


# ---------------------------------------------------------------- команды


def _audit_version(actor: Actor | None, action: str, v: ContentVersion, *, before: dict[str, Any] | None = None,
                   after: dict[str, Any] | None = None, reason: str | None = None,
                   actor_type: str | None = None) -> dict[str, Any]:
    return audit_payload(actor, action, "content_version", version_object_id(v.kind, v.key, v.version),
                         before=before, after={"status": v.status, "payload_hash": v.payload_hash, **(after or {})},
                         reason=reason, actor_type=actor_type)


async def create(session: AsyncSession, kind: str, raw_payload: Any, actor: Actor) -> ContentVersion:
    model, issues = parse_schema(kind, raw_payload)
    if model is None:
        raise content_invalid(issues)
    payload = normalized(model)
    key = str(payload[KEY_FIELDS[kind]])
    await lock_key(session, kind, key)
    if await key_exists(session, kind, key):
        raise conflict("CONTENT_KEY_EXISTS", f"{kind} «{key}» уже существует — создайте новую версию",
                       {"kind": kind, "key": key})
    now = utcnow()
    row = CV(id=uuid.uuid4(), kind=kind, key=key, version=1, status="draft", payload=payload,
             payload_hash=payload_hash(payload), author_id=actor.id, editors=[actor.id], created_at=now,
             updated_by=actor.id, updated_at=now, locale_checks=locale_state(model))
    session.add(row)
    await session.execute(insert(ContentPointer).values(kind=kind, key=key, published_version=None,
                                                        previous_version=None)
                          .on_conflict_do_nothing(index_elements=["kind", "key"]))
    await session.flush()
    await emit_audit(session, _audit_version(actor, "content.version_created", row))
    return row


async def new_version(session: AsyncSession, kind: str, key: str, from_version: int, actor: Actor) -> ContentVersion:
    await lock_key(session, kind, key)
    src = await get_version(session, kind, key, from_version)
    open_version = await session.scalar(select(CV.version).where(CV.kind == kind, CV.key == key,
                                                                 CV.status.in_(OPEN_STATUSES)))
    if open_version is not None:
        raise conflict("DRAFT_EXISTS", f"У {kind} «{key}» уже есть черновик или версия на проверке",
                       {"version": open_version})
    max_version = int(await session.scalar(select(func.max(CV.version)).where(CV.kind == kind, CV.key == key)) or 0)
    model, _ = parse_schema(kind, src.payload)
    checks = locale_state(model) if model is not None else {"ru": "draft", "uz": "draft"}
    now = utcnow()
    row = CV(id=uuid.uuid4(), kind=kind, key=key, version=max_version + 1, status="draft", payload=dict(src.payload),
             payload_hash=src.payload_hash, author_id=actor.id, editors=[actor.id], created_at=now,
             updated_by=actor.id, updated_at=now, locale_checks=checks)
    session.add(row)
    await session.flush()
    await emit_audit(session, _audit_version(actor, "content.version_created", row,
                                             after={"from_version": from_version}))
    return row


async def update_draft(session: AsyncSession, kind: str, key: str, version: int, raw_payload: Any,
                       expected_hash: str, actor: Actor) -> ContentVersion:
    await lock_key(session, kind, key)
    row = await get_version(session, kind, key, version, for_update=True)
    if row.status != "draft":
        raise conflict("VERSION_NOT_DRAFT", "Править можно только черновик — создайте новую версию",
                       {"status": row.status})
    if expected_hash != row.payload_hash:
        raise conflict("VERSION_CONFLICT", "Черновик изменился — обновите страницу", {"payload_hash": row.payload_hash})
    model, issues = parse_schema(kind, raw_payload)
    if model is None:
        raise content_invalid(issues)
    payload = normalized(model)
    key_field = KEY_FIELDS[kind]
    if payload[key_field] != key:
        raise content_invalid([Issue(f"payload.{key_field}", "KEY_CHANGED", "Идентификатор менять нельзя")])
    new_hash = payload_hash(payload)
    if new_hash == row.payload_hash:
        return row
    before_hash, rights_reset = row.payload_hash, row.rights_approved_at is not None
    row.payload = payload
    row.payload_hash = new_hash
    row.locale_checks = locale_state(model)
    row.updated_by = actor.id
    row.updated_at = utcnow()
    if actor.id not in row.editors:
        row.editors = [*row.editors, actor.id]
    if rights_reset:  # одобрение прав относится к телу — правка его сбрасывает
        row.rights_approved_by = None
        row.rights_approved_at = None
        row.rights_note = None
    await session.flush()
    await emit_audit(session, _audit_version(actor, "content.version_updated", row,
                                             before={"payload_hash": before_hash},
                                             after={"rights_reset": rights_reset}))
    return row


async def check(session: AsyncSession, kind: str, key: str, version: int, policy: Policy,
                mode: Mode = "publish") -> list[Issue]:
    """Сухая проверка (validate): по умолчанию — в режиме публикации."""
    row = await get_version(session, kind, key, version)
    ctx = await load_context(session, kind, row.payload, mode, policy, row)
    return validate(kind, row.payload, ctx)


async def submit(session: AsyncSession, kind: str, key: str, version: int, actor: Actor,
                 policy: Policy) -> ContentVersion:
    await lock_key(session, kind, key)
    row = await get_version(session, kind, key, version, for_update=True)
    if row.status != "draft":
        raise conflict("VERSION_NOT_DRAFT", "На проверку отправляется только черновик", {"status": row.status})
    ctx = await load_context(session, kind, row.payload, "submit", policy, row)
    issues = validate(kind, row.payload, ctx)
    if issues:
        raise content_invalid(issues)
    row.status = "in_review"
    row.submitted_at = utcnow()
    await session.flush()
    await emit_audit(session, _audit_version(actor, "content.submitted", row))
    return row


async def review(session: AsyncSession, kind: str, key: str, version: int, *, decision: str, note: str,
                 locale_checks: dict[str, str], actor: Actor) -> ContentVersion:
    await lock_key(session, kind, key)
    row = await get_version(session, kind, key, version, for_update=True)
    if row.status != "in_review":
        raise conflict("VERSION_NOT_IN_REVIEW", "Версия не на проверке", {"status": row.status})
    if actor.id in (row.editors or []) or actor.id == row.author_id:
        raise conflict("SELF_REVIEW", "Автор не проверяет свою версию — нужен другой методист")
    if decision == "approve":
        missing = [Issue(f"locale_checks.{lang}", "LOCALE_NOT_CHECKED", f"Отметьте проверку {lang.upper()}")
                   for lang in ("ru", "uz") if locale_checks.get(lang) != "checked"]
        if missing:
            raise content_invalid(missing)
        row.status = "approved"
        row.locale_checks = {"ru": "checked", "uz": "checked"}
    else:
        row.status = "draft"
        row.locale_checks = {"ru": locale_checks.get("ru", "draft"), "uz": locale_checks.get("uz", "draft")}
    row.reviewer_id = actor.id
    row.reviewed_at = utcnow()
    row.review_note = note
    await session.flush()
    action = "content.reviewed" if decision == "approve" else "content.returned"
    await emit_audit(session, _audit_version(actor, action, row, after={"locale_checks": row.locale_checks}))
    return row


def _course_of(kind: str, payload: dict[str, Any]) -> str | None:
    """course_id события: у курса — свой ключ, у навыка/модуля/урока — их курс, у остальных — null."""
    value = payload.get("course_id") if kind in ("course", "skill", "module", "lesson") else None
    return value if isinstance(value, str) else None


async def _emit_published(session: AsyncSession, row: ContentVersion, action: str, version: int | None,
                          previous: int | None, actor: Actor, at: datetime) -> None:
    await emit_event(session, VERSION_PUBLISHED, {
        "kind": row.kind, "key": row.key, "version": version, "previous_version": previous, "action": action,
        "course_id": _course_of(row.kind, row.payload), "published_by": as_uuid_or_none(actor.id),
        "published_at": iso_z(at),
    })


async def _archive_version(session: AsyncSession, kind: str, key: str, version: int, at: datetime) -> None:
    await session.execute(update(CV).where(CV.kind == kind, CV.key == key, CV.version == version)
                          .values(status="archived", archived_at=at).execution_options(synchronize_session=False))


async def publish(session: AsyncSession, kind: str, key: str, version: int, reason: str, actor: Actor,
                  policy: Policy) -> tuple[ContentVersion, bool]:
    await lock_graph(session)
    await lock_key(session, kind, key)
    row = await get_version(session, kind, key, version, for_update=True)
    if row.status == "published":
        return row, False
    if row.status != "approved":
        raise conflict("VERSION_NOT_APPROVED", "Публикуется только версия, одобренная методистом",
                       {"status": row.status})
    ctx = await load_context(session, kind, row.payload, "publish", policy, row)
    issues = validate(kind, row.payload, ctx)
    if issues:
        raise content_invalid(issues)
    now = utcnow()
    ptr = await pointer_of(session, kind, key, for_update=True)
    previous = ptr.published_version
    if previous is not None:
        await _archive_version(session, kind, key, previous, now)
    # одобренные, но не опубликованные старые версии вытеснены этой публикацией
    await session.execute(update(CV).where(CV.kind == kind, CV.key == key, CV.status == "approved",
                                           CV.version < version)
                          .values(status="archived", archived_at=now).execution_options(synchronize_session=False))
    row.status = "published"
    row.published_by = actor.id
    row.published_at = now
    ptr.previous_version = previous
    ptr.published_version = version
    ptr.updated_at = now
    await session.flush()
    await _emit_published(session, row, "published", version, previous, actor, now)
    await emit_audit(session, _audit_version(actor, "content.published", row,
                                             before={"published_version": previous},
                                             after={"published_version": version}, reason=reason))
    return row, True


async def referencing_published(session: AsyncSession, kind: str, key: str) -> list[dict[str, str]]:
    """Опубликованные сущности, зависящие от ключа (CONTENT_IN_USE), и опубликованные пары курса."""
    refs: list[dict[str, str]] = []
    for other, downs in DOWN_REFS.items():
        if kind not in downs:
            continue
        for row in await published_rows(session, other):
            if (kind, key) in down_refs_of(other, row.payload) and not (other == kind and row.key == key):
                refs.append({"kind": other, "key": row.key})
    if kind == "course":
        pairs = (await session.execute(select(LanguagePairRow.pair_id).where(
            LanguagePairRow.course_id == key, LanguagePairRow.status.in_(("pilot", "published"))))).scalars().all()
        refs.extend({"kind": "language_pair", "key": p} for p in pairs)
    return sorted(refs, key=lambda r: (r["kind"], r["key"]))


async def archive(session: AsyncSession, kind: str, key: str, reason: str, actor: Actor) -> ContentVersion:
    await lock_graph(session)
    await lock_key(session, kind, key)
    ptr = await pointer_of(session, kind, key, for_update=True)
    current = ptr.published_version
    if current is None:
        raise conflict("CONTENT_NOT_PUBLISHED", f"{kind} «{key}» не опубликован")
    refs = await referencing_published(session, kind, key)
    if refs:
        raise conflict("CONTENT_IN_USE", "На эту сущность ссылается опубликованный контент — сначала снимите его",
                       {"refs": refs[:50]})
    now = utcnow()
    row = await get_version(session, kind, key, current, for_update=True)
    row.status = "archived"
    row.archived_at = now
    ptr.previous_version = current
    ptr.published_version = None
    ptr.updated_at = now
    await session.flush()
    await _emit_published(session, row, "archived", None, current, actor, now)
    await emit_audit(session, _audit_version(actor, "content.archived", row,
                                             before={"published_version": current},
                                             after={"published_version": None}, reason=reason))
    return row


async def rollback(session: AsyncSession, kind: str, key: str, to_version: int, reason: str, actor: Actor,
                   policy: Policy) -> ContentVersion:
    await lock_graph(session)
    await lock_key(session, kind, key)
    target = await get_version(session, kind, key, to_version, for_update=True)
    if target.status != "archived" or target.published_at is None:
        raise conflict("ROLLBACK_TARGET_INVALID", "Откатиться можно только к прежде опубликованной архивной версии",
                       {"status": target.status})
    ctx = await load_context(session, kind, target.payload, "publish", policy, target)
    issues = validate(kind, target.payload, ctx)
    if issues:
        raise content_invalid(issues)
    now = utcnow()
    ptr = await pointer_of(session, kind, key, for_update=True)
    current = ptr.published_version
    if current is not None:
        await _archive_version(session, kind, key, current, now)
    target.status = "published"
    target.published_by = actor.id
    target.published_at = now
    target.archived_at = None
    ptr.previous_version = current
    ptr.published_version = to_version
    ptr.updated_at = now
    await session.flush()
    await _emit_published(session, target, "rolled_back", to_version, current, actor, now)
    await emit_audit(session, _audit_version(actor, "content.rolled_back", target,
                                             before={"published_version": current},
                                             after={"published_version": to_version}, reason=reason))
    return target


async def rights_approve(session: AsyncSession, key: str, version: int, note: str, actor: Actor,
                         policy: Policy) -> ContentVersion:
    kind = "media_asset"
    await lock_key(session, kind, key)
    row = await get_version(session, kind, key, version, for_update=True)
    if row.status not in ("draft", "in_review", "approved"):
        raise conflict("VERSION_IMMUTABLE", "Права подтверждаются до публикации версии", {"status": row.status})
    ctx = await load_context(session, kind, row.payload, "submit", policy, row)
    issues = [i for i in validate(kind, row.payload, ctx)
              if i.code in ("RIGHTS_REQUIRED", "EXTERNAL_SOURCE_DISABLED", "SCHEMA_INVALID")]
    if issues:
        raise content_invalid(issues)
    row.rights_approved_by = actor.id
    row.rights_approved_at = utcnow()
    row.rights_note = note
    await session.flush()
    await emit_audit(session, _audit_version(actor, "content.rights_approved", row,
                                             after={"rights": {
                                                 "license_type": row.payload["rights"]["license_type"],
                                                 "valid_to": row.payload["rights"]["valid_to"]}}))
    return row


async def test_run(session: AsyncSession, key: str, version: int, actor: Actor) -> dict[str, Any]:
    row = await get_version(session, "scenario", key, version)
    model, issues = parse_schema("scenario", row.payload)
    if model is None:
        raise content_invalid(issues)
    now = utcnow()
    result = run_test(normalized(model), iso_z(now) or "")
    session.add(ScenarioTestRunRow(id=uuid.uuid4(), key=key, version=version, payload_hash=row.payload_hash,
                                   ok=bool(result["ok"]), result=result, run_by=actor.id, checked_at=now))
    await session.flush()
    await emit_audit(session, _audit_version(actor, "content.test_run", row,
                                             after={"ok": result["ok"], "issues": len(result["issues"])}))
    return result
