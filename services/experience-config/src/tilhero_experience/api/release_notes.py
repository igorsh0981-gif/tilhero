"""«Что нового» (доработка 9.4): staff API заметок о релизах (admin-bff) и лента опубликованных (telegram-bff).

Права — те же, что у конфигурации интерфейса: config.read — список и карточка, config.edit — черновик (создать,
изменить), config.publish — опубликовать и архивировать. Команды принимают Idempotency-Key (как активация версии).
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Header, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from tilhero_common.app import Runtime, get_runtime
from tilhero_common.errors import bad_request
from tilhero_common.internal_auth import InternalAuth, Principal
from tilhero_experience.api.common import idempotent
from tilhero_experience.domain import release_notes as rn
from tilhero_experience.models import ReleaseNote

staff_router = APIRouter(prefix="/admin/v1/release-notes", tags=["staff"])
internal_router = APIRouter(prefix="/internal/v1/release-notes", tags=["internal"])
staff = InternalAuth({"admin-bff"})
readers = InternalAuth({"telegram-bff"})

READ, EDIT, PUBLISH = "config.read", "config.edit", "config.publish"
IdempotencyKey = Header(default=None, alias="Idempotency-Key", min_length=8, max_length=128,
                        pattern=r"^[A-Za-z0-9_\-:.]+$")
_IN = ConfigDict(extra="forbid")


class UpdateIn(rn.NoteContent):
    expected_version: int = Field(ge=1)


class PublishIn(BaseModel):
    model_config = _IN

    expected_version: int = Field(ge=1)
    reason: str = Field(min_length=3, max_length=500)


class ArchiveIn(BaseModel):
    model_config = _IN

    reason: str = Field(min_length=3, max_length=500)


def _cursor(cursor: str | None) -> int | None:
    if cursor is None:
        return None
    try:
        return rn.decode_cursor(cursor)
    except Exception as exc:
        raise bad_request("INVALID_CURSOR", "Некорректный курсор") from exc


async def _load(rt: Runtime, note_id: uuid.UUID) -> ReleaseNote:
    async with rt.transaction() as session:
        note = await session.get(ReleaseNote, note_id)
    if note is None:
        raise rn.note_not_found()
    return note


# ---------------------------------------------------------------- staff


@staff_router.get("")
async def list_notes(principal: Principal = Depends(staff), rt: Runtime = Depends(get_runtime),
                     status: rn.Status | None = Query(default=None),
                     limit: int = Query(default=20, ge=1, le=100),
                     cursor: str | None = Query(default=None, max_length=64)) -> dict:
    principal.require_permission(READ)
    after = _cursor(cursor)
    stmt = select(ReleaseNote).order_by(ReleaseNote.seq.desc()).limit(limit + 1)
    if status is not None:
        stmt = stmt.where(ReleaseNote.status == status)
    if after is not None:
        stmt = stmt.where(ReleaseNote.seq < after)
    async with rt.transaction() as session:
        rows = (await session.execute(stmt)).scalars().all()
    next_cursor = rn.encode_cursor(rows[limit - 1].seq) if len(rows) > limit else None
    return {"items": [rn.staff_view(n) for n in rows[:limit]], "next_cursor": next_cursor}


@staff_router.get("/{note_id}")
async def get_note(note_id: uuid.UUID, principal: Principal = Depends(staff),
                   rt: Runtime = Depends(get_runtime)) -> dict:
    principal.require_permission(READ)
    return rn.staff_view(await _load(rt, note_id))


@staff_router.post("", status_code=201, responses={409: {"description": "RELEASE_NOTE_SLUG_EXISTS"}})
async def create_note(body: rn.NoteContent, principal: Principal = Depends(staff),
                      rt: Runtime = Depends(get_runtime),
                      idempotency_key: str | None = IdempotencyKey) -> JSONResponse:
    actor = principal.require_permission(EDIT)

    async def run() -> tuple[int, dict]:
        async with rt.transaction() as session:
            note = await rn.create(session, body, actor)
            out = rn.staff_view(note)
        return 201, out

    return await idempotent(rt, scope=f"{actor.id}:release-notes:create", key=idempotency_key,
                            request=body.model_dump(mode="json"), run=run)


@staff_router.put("/{note_id}", responses={409: {"description": "RELEASE_NOTE_NOT_DRAFT | VERSION_CONFLICT"}})
async def update_note(note_id: uuid.UUID, body: UpdateIn, principal: Principal = Depends(staff),
                      rt: Runtime = Depends(get_runtime)) -> dict:
    actor = principal.require_permission(EDIT)
    content = rn.NoteContent.model_validate(body.model_dump(exclude={"expected_version"}))
    async with rt.transaction() as session:
        note = await rn.update(session, note_id, body.expected_version, content, actor)
        return rn.staff_view(note)


@staff_router.post("/{note_id}/publish", status_code=201,
                   responses={200: {"description": "уже опубликована — no-op"},
                              409: {"description": "RELEASE_NOTE_NOT_DRAFT | RELEASE_NOTE_VERSION_CONFLICT"}})
async def publish_note(note_id: uuid.UUID, body: PublishIn, principal: Principal = Depends(staff),
                       rt: Runtime = Depends(get_runtime),
                       idempotency_key: str | None = IdempotencyKey) -> JSONResponse:
    actor = principal.require_permission(PUBLISH)

    async def run() -> tuple[int, dict]:
        async with rt.transaction() as session:
            note, changed = await rn.publish(session, note_id, body.expected_version, body.reason, actor)
            out = rn.staff_view(note)
        return (201 if changed else 200), out

    return await idempotent(rt, scope=f"{actor.id}:release-notes:publish:{note_id}", key=idempotency_key,
                            request=body.model_dump(), run=run)


@staff_router.post("/{note_id}/archive", status_code=201, responses={200: {"description": "уже в архиве — no-op"}})
async def archive_note(note_id: uuid.UUID, body: ArchiveIn, principal: Principal = Depends(staff),
                       rt: Runtime = Depends(get_runtime),
                       idempotency_key: str | None = IdempotencyKey) -> JSONResponse:
    actor = principal.require_permission(PUBLISH)

    async def run() -> tuple[int, dict]:
        async with rt.transaction() as session:
            note, changed = await rn.archive(session, note_id, body.reason, actor)
            out = rn.staff_view(note)
        return (201 if changed else 200), out

    return await idempotent(rt, scope=f"{actor.id}:release-notes:archive:{note_id}", key=idempotency_key,
                            request=body.model_dump(), run=run)


# ---------------------------------------------------------------- internal (telegram-bff)


@internal_router.get("/published")
async def published(_: Principal = Depends(readers), rt: Runtime = Depends(get_runtime),
                    limit: int = Query(default=10, ge=1, le=rn.PUBLISHED_FEED_MAX)) -> dict:
    """Опубликованные заметки, новые первыми (без сотрудников и черновиков). Отбор «непросмотренных» делает BFF."""
    stmt = (select(ReleaseNote).where(ReleaseNote.status == "published")
            .order_by(ReleaseNote.published_at.desc(), ReleaseNote.seq.desc()).limit(limit))
    async with rt.transaction() as session:
        rows = (await session.execute(stmt)).scalars().all()
    return {"items": [rn.public_view(n) for n in rows]}
