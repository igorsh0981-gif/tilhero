"""Заявки учеников на песни и фильмы (APP-MEDIA-04, ADM-MEDIA-04, AT-30).

Это заявка контент-менеджеру: сервер НИКОГДА не открывает, не скачивает и не расшифровывает ссылку ученика — она
хранится как текст и показывается сотруднику. Создаёт только аккаунт (14+ или опекун): детский профиль — 403
KIDS_NOT_ALLOWED; не больше N заявок за скользящие сутки (по БД, под advisory-блокировкой ученика) — 429.
Решение (media.rights) — authored_alternative | licensed (со ссылкой на опубликованный media_asset) | rejected |
duplicate с заметкой, видимой ученику → catalog.media_request.decided.v1 (notifications). Похожие заявки — по
нормализованному названию (similar_count). Удаление ученика — обезличивание (user_id, link, comment → NULL).
"""

from __future__ import annotations

import re
import unicodedata
import uuid
from datetime import datetime, timedelta
from typing import Any, Final

from sqlalchemy import ColumnElement, func, or_, select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_catalog.domain.common import (
    DOMAIN_DELETED,
    PRODUCER,
    REQUEST_CREATED,
    REQUEST_DECIDED,
    audit_payload,
    decode_cursor,
    emit_audit,
    emit_event,
    encode_cursor,
    iso_z,
    utcnow,
)
from tilhero_catalog.domain.versions import published_rows
from tilhero_catalog.models import DeletedUser, MediaRequest
from tilhero_common.errors import ApiError, conflict, not_found, too_many, unprocessable
from tilhero_common.internal_auth import Actor

LOCK_CLASS: Final = 811_002
OPEN: Final = ("new", "in_review")
NEEDS_ASSET: Final = ("authored_alternative", "licensed")
WINDOW: Final = timedelta(hours=24)
OWN_LIST_LIMIT: Final = 100
_NON_WORD = re.compile(r"[^\w]+", re.UNICODE)


def normalize_title(title: str) -> str:
    """«Bohemian  Rhapsody!» и «bohemian rhapsody» — одно и то же: NFKC, регистр, только буквы и цифры."""
    value = unicodedata.normalize("NFKC", title).casefold().replace("ё", "е")
    return " ".join(_NON_WORD.sub(" ", value).replace("_", " ").split())[:200]


def request_not_found() -> ApiError:
    return not_found("MEDIA_REQUEST_NOT_FOUND", "Заявка не найдена")


def user_deleted() -> ApiError:
    return ApiError(410, "USER_DELETED", "Пользователь удалён")


async def lock_user(session: AsyncSession, user_id: uuid.UUID) -> None:
    await session.execute(text("SELECT pg_advisory_xact_lock(:c, hashtext(:u))"),
                          {"c": LOCK_CLASS, "u": str(user_id)})


# ---------------------------------------------------------------- представления


def learner_view(r: MediaRequest) -> dict[str, Any]:
    """MediaRequest (bff.ts)."""
    return {
        "request_id": str(r.request_id), "kind": r.kind, "title": r.title, "link": r.link, "comment": r.comment,
        "status": r.status, "decision_note": r.decision_note, "linked_asset_id": r.linked_asset_id,
        "created_at": iso_z(r.created_at), "decided_at": iso_z(r.decided_at),
    }


def service_view(r: MediaRequest) -> dict[str, Any]:
    """Для notifications: без ссылки и комментария ученика (PII), только user_id."""
    return {
        "request_id": str(r.request_id), "user_id": str(r.user_id) if r.user_id else None, "kind": r.kind,
        "title": r.title, "ui_locale": r.ui_locale, "status": r.status, "decision_note": r.decision_note,
        "linked_asset_id": r.linked_asset_id, "created_at": iso_z(r.created_at), "decided_at": iso_z(r.decided_at),
    }


def admin_view(r: MediaRequest, similar: int) -> dict[str, Any]:
    """AdminMediaRequest (admin.ts) без имени сотрудника (decided_by_name дополняет admin-bff)."""
    return {
        "request_id": str(r.request_id), "user_id": str(r.user_id) if r.user_id else None, "kind": r.kind,
        "title": r.title, "link": r.link, "comment": r.comment, "ui_locale": r.ui_locale, "status": r.status,
        "decision_note": r.decision_note, "linked_asset_id": r.linked_asset_id, "decided_by": r.decided_by,
        "decided_by_name": None, "decided_at": iso_z(r.decided_at), "created_at": iso_z(r.created_at),
        "similar_count": similar,
    }


async def similar_counts(session: AsyncSession, rows: list[MediaRequest]) -> dict[uuid.UUID, int]:
    norms = sorted({r.title_norm for r in rows})
    if not norms:
        return {}
    counts = dict((await session.execute(
        select(MediaRequest.title_norm, func.count()).where(MediaRequest.title_norm.in_(norms))
        .group_by(MediaRequest.title_norm))).all())
    return {r.request_id: max(int(counts.get(r.title_norm, 1)) - 1, 0) for r in rows}


# ---------------------------------------------------------------- ученик


async def create(session: AsyncSession, user_id: uuid.UUID, *, kind: str, title: str, link: str | None,
                 comment: str | None, ui_locale: str, idempotency_key: str | None,
                 per_day: int) -> tuple[MediaRequest, bool]:
    await lock_user(session, user_id)
    if await session.get(DeletedUser, user_id) is not None:
        raise user_deleted()
    if idempotency_key is not None:
        existing = (await session.execute(select(MediaRequest).where(
            MediaRequest.user_id == user_id, MediaRequest.idempotency_key == idempotency_key))).scalar_one_or_none()
        if existing is not None:
            return existing, False
    now = utcnow()
    recent = list((await session.execute(
        select(MediaRequest.created_at).where(MediaRequest.user_id == user_id, MediaRequest.created_at > now - WINDOW)
        .order_by(MediaRequest.created_at))).scalars().all())
    if len(recent) >= per_day:
        retry = int((recent[0] + WINDOW - now).total_seconds()) + 1
        raise too_many("MEDIA_REQUEST_LIMIT", f"Не больше {per_day} заявок в сутки — попробуйте позже",
                       retry_after=max(retry, 1))
    row = MediaRequest(request_id=uuid.uuid4(), user_id=user_id, kind=kind, title=title,
                       title_norm=normalize_title(title) or title.casefold()[:200], link=link, comment=comment,
                       ui_locale=ui_locale, status="new", idempotency_key=idempotency_key, created_at=now)
    session.add(row)
    await session.flush()
    await emit_event(session, REQUEST_CREATED, {"request_id": str(row.request_id), "user_id": str(user_id),
                                                "kind": kind, "created_at": iso_z(now)})
    return row, True


async def list_own(session: AsyncSession, user_id: uuid.UUID) -> list[dict[str, Any]]:
    if await session.get(DeletedUser, user_id) is not None:
        raise user_deleted()
    rows = (await session.execute(select(MediaRequest).where(MediaRequest.user_id == user_id)
                                  .order_by(MediaRequest.seq.desc()).limit(OWN_LIST_LIMIT))).scalars().all()
    return [learner_view(r) for r in rows]


async def get(session: AsyncSession, request_id: uuid.UUID, *, for_update: bool = False) -> MediaRequest:
    stmt = select(MediaRequest).where(MediaRequest.request_id == request_id)
    if for_update:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    row = (await session.execute(stmt)).scalar_one_or_none()
    if row is None:
        raise request_not_found()
    return row


# ---------------------------------------------------------------- сотрудники


async def admin_list(session: AsyncSession, *, status: str | None, q: str | None, cursor: str | None,
                     limit: int) -> dict[str, Any]:
    after = decode_cursor(cursor, 1)
    stmt = select(MediaRequest).order_by(MediaRequest.seq.desc()).limit(limit + 1)
    if status is not None:
        stmt = stmt.where(MediaRequest.status == status)
    if q:
        pattern = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        norm = normalize_title(q)
        conds: list[ColumnElement[bool]] = [MediaRequest.title.ilike(pattern, escape="\\")]
        if norm:
            conds.append(MediaRequest.title_norm.contains(norm, autoescape=True))
        stmt = stmt.where(or_(*conds))
    if after is not None:
        stmt = stmt.where(MediaRequest.seq < int(after[0]))
    rows = list((await session.execute(stmt)).scalars().all())
    page = rows[:limit]
    similar = await similar_counts(session, page)
    next_cursor = encode_cursor(page[-1].seq) if len(rows) > limit and page else None
    return {"items": [admin_view(r, similar.get(r.request_id, 0)) for r in page], "next_cursor": next_cursor}


async def admin_view_of(session: AsyncSession, row: MediaRequest) -> dict[str, Any]:
    return admin_view(row, (await similar_counts(session, [row])).get(row.request_id, 0))


def _audit(actor: Actor, action: str, row: MediaRequest, before: str, reason: str | None = None) -> dict[str, Any]:
    # без названия, ссылки и комментария ученика: журнал неизменяем, а заявку можно обезличить
    return audit_payload(actor, action, "media_request", str(row.request_id), before={"status": before},
                         after={"status": row.status, "linked_asset_id": row.linked_asset_id}, reason=reason)


async def take(session: AsyncSession, request_id: uuid.UUID, actor: Actor) -> MediaRequest:
    row = await get(session, request_id, for_update=True)
    if row.status == "in_review":
        return row
    if row.status != "new":
        raise conflict("MEDIA_REQUEST_DECIDED", "По заявке уже принято решение", {"status": row.status})
    row.status = "in_review"
    row.taken_by = actor.id
    row.taken_at = utcnow()
    await session.flush()
    await emit_audit(session, _audit(actor, "media_request.taken", row, "new"))
    return row


async def decide(session: AsyncSession, request_id: uuid.UUID, *, status: str, note: str,
                 linked_asset_id: str | None, actor: Actor) -> tuple[MediaRequest, bool]:
    row = await get(session, request_id, for_update=True)
    if row.status not in OPEN:
        if (row.status, row.decision_note, row.linked_asset_id) == (status, note, linked_asset_id):
            return row, False  # повтор того же решения
        raise conflict("MEDIA_REQUEST_DECIDED", "По заявке уже принято решение", {"status": row.status})
    if status in NEEDS_ASSET:
        if linked_asset_id is None:
            raise unprocessable("LINKED_ASSET_REQUIRED", "Укажите опубликованный материал, подобранный по заявке")
        if not await published_rows(session, "media_asset", [linked_asset_id]):
            raise unprocessable("LINKED_ASSET_NOT_PUBLISHED", "Материал не опубликован",
                                {"linked_asset_id": linked_asset_id})
    elif linked_asset_id is not None:
        raise unprocessable("LINKED_ASSET_NOT_ALLOWED", "Материал указывается только при подборе или лицензии")
    before = row.status
    now = utcnow()
    row.status = status
    row.decision_note = note
    row.linked_asset_id = linked_asset_id
    row.decided_by = actor.id
    row.decided_at = now
    await session.flush()
    if row.user_id is not None:  # обезличенной заявке уведомлять некого
        await emit_event(session, REQUEST_DECIDED, {
            "request_id": str(row.request_id), "user_id": str(row.user_id), "status": status, "title": row.title,
            "linked_asset_id": linked_asset_id, "decided_at": iso_z(now),
        })
    await emit_audit(session, _audit(actor, "media_request.decided", row, before, reason=note))
    return row, True


async def new_count(session: AsyncSession) -> int:
    return int(await session.scalar(select(func.count()).select_from(MediaRequest)
                                    .where(MediaRequest.status == "new")) or 0)


# ---------------------------------------------------------------- сага удаления


async def anonymize_user(session: AsyncSession, *, user_id: str, request_id: str,
                         now: datetime | None = None) -> int:
    """user.deletion.requested.v1 → заявки ученика обезличены (user_id, ссылка, комментарий, ключ → NULL),
    отметка deleted_users закрывает новые заявки → ACK user.domain.deleted.v1 {catalog, anonymized}.
    Название и решение остаются в реестре (не связаны с учеником). Повтор безопасен."""
    now = now or utcnow()
    count = 0
    try:
        uid: uuid.UUID | None = uuid.UUID(user_id)
    except ValueError:
        uid = None
    if uid is not None:
        try:
            request_uuid = uuid.UUID(request_id)
        except ValueError:
            request_uuid = uuid.UUID(int=0)
        await lock_user(session, uid)
        await session.execute(insert(DeletedUser).values(user_id=uid, request_id=request_uuid, deleted_at=now)
                              .on_conflict_do_nothing(index_elements=["user_id"]))
        rows = (await session.execute(select(MediaRequest).where(MediaRequest.user_id == uid)
                                      .with_for_update())).scalars().all()
        for r in rows:
            r.user_id = None
            r.link = None
            r.comment = None
            r.idempotency_key = None
            r.anonymized_at = now
            count += 1
        await session.flush()
    await emit_event(session, DOMAIN_DELETED,
                     {"user_id": user_id, "request_id": request_id, "domain": PRODUCER, "mode": "anonymized"})
    return count

