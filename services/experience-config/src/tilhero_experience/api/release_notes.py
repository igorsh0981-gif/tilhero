"""«Что нового»: staff API заметок (admin-bff, спринт 2) и ученический API (telegram-bff): for-me, seen, feed.

Права сотрудника (admin.ts, PLAN «Роли и права»; проверяются здесь, а не только в admin-bff):
- whatsnew.manage — список, карточка, черновик (создать, изменить), статистика показов;
- whatsnew.publish — опубликовать и снять (архив); step-up (повторный TOTP) проверяет admin-bff;
- dashboard.read — сводка для Обзора (summary).
Права конфигурации интерфейса (config.*) к заметкам отношения не имеют. Команды принимают Idempotency-Key.
Ученик — только из `sub` внутреннего токена (активный ученик, CONVENTIONS §8): чужие отметки недоступны по построению.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Header, Query, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from tilhero_common.app import Runtime, get_runtime
from tilhero_common.errors import bad_request, unauthorized
from tilhero_common.internal_auth import InternalAuth, Principal
from tilhero_experience.api.common import idempotent
from tilhero_experience.domain import release_notes as rn
from tilhero_experience.models import ReleaseNote
from tilhero_experience.schemas import (
    ReleaseNotesSummaryOut,
    ReleaseNoteStatsOut,
    SeenIn,
    WhatsNewOut,
    WhatsNewPage,
)

staff_router = APIRouter(prefix="/admin/v1/release-notes", tags=["staff"])
internal_router = APIRouter(prefix="/internal/v1/release-notes", tags=["internal"])
staff = InternalAuth({"admin-bff"})
learners = InternalAuth({"telegram-bff"})

MANAGE, PUBLISH, DASHBOARD = "whatsnew.manage", "whatsnew.publish", "dashboard.read"
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


def learner_id(principal: Principal) -> uuid.UUID:
    """Ученик — только из sub токена (защита от IDOR)."""
    try:
        return uuid.UUID(principal.user_id)
    except ValueError as exc:
        raise unauthorized("USER_CONTEXT_INVALID", "Некорректный контекст пользователя") from exc


# ---------------------------------------------------------------- staff


@staff_router.get("")
async def list_notes(principal: Principal = Depends(staff), rt: Runtime = Depends(get_runtime),
                     status: rn.Status | None = Query(default=None),
                     limit: int = Query(default=20, ge=1, le=100),
                     cursor: str | None = Query(default=None, max_length=64)) -> dict:
    """Page<StaffReleaseNote>, новые первыми; views_total — одним GROUP BY на страницу."""
    principal.require_permission(MANAGE)
    after = _cursor(cursor)
    stmt = select(ReleaseNote).order_by(ReleaseNote.seq.desc()).limit(limit + 1)
    if status is not None:
        stmt = stmt.where(ReleaseNote.status == status)
    if after is not None:
        stmt = stmt.where(ReleaseNote.seq < after)
    async with rt.transaction() as session:
        rows = (await session.execute(stmt)).scalars().all()
        items = await rn.staff_views(session, rows[:limit])
    next_cursor = rn.encode_cursor(rows[limit - 1].seq) if len(rows) > limit else None
    return {"items": items, "next_cursor": next_cursor}


@staff_router.get("/summary", response_model=ReleaseNotesSummaryOut)
async def summary(principal: Principal = Depends(staff), rt: Runtime = Depends(get_runtime)) -> dict:
    """DashboardWhatsNew для блока «Что нового» Обзора (dashboard.read). Объявлен до /{note_id}."""
    principal.require_permission(DASHBOARD)
    async with rt.transaction() as session:
        return await rn.summary(session)


@staff_router.get("/{note_id}")
async def get_note(note_id: uuid.UUID, principal: Principal = Depends(staff),
                   rt: Runtime = Depends(get_runtime)) -> dict:
    principal.require_permission(MANAGE)
    async with rt.transaction() as session:
        note = await session.get(ReleaseNote, note_id)
        if note is None:
            raise rn.note_not_found()
        return await rn.staff_view_of(session, note)


@staff_router.get("/{note_id}/stats", response_model=ReleaseNoteStatsOut,
                  responses={404: {"description": "RELEASE_NOTE_NOT_FOUND"}})
async def note_stats(note_id: uuid.UUID, principal: Principal = Depends(staff),
                     rt: Runtime = Depends(get_runtime)) -> dict:
    """ReleaseNoteStats: показы (уникальные ученики), разрезы по языку и возрасту на момент показа, первый и
    последний показ. У черновика — нули."""
    principal.require_permission(MANAGE)
    async with rt.transaction() as session:
        return await rn.stats(session, note_id)


@staff_router.post("", status_code=201,
                   responses={409: {"description": "RELEASE_NOTE_SLUG_EXISTS"},
                              422: {"description": "RELEASE_NOTE_TRANSLATION_MISSING {missing}"}})
async def create_note(body: rn.NoteContent, principal: Principal = Depends(staff),
                      rt: Runtime = Depends(get_runtime),
                      idempotency_key: str | None = IdempotencyKey) -> JSONResponse:
    actor = principal.require_permission(MANAGE)

    async def run() -> tuple[int, dict]:
        async with rt.transaction() as session:
            note = await rn.create(session, body, actor)
            out = rn.staff_view(note)  # черновик: показов нет
        return 201, out

    return await idempotent(rt, scope=f"{actor.id}:release-notes:create", key=idempotency_key,
                            request=body.model_dump(mode="json"), run=run)


@staff_router.put("/{note_id}", responses={409: {"description": "RELEASE_NOTE_NOT_DRAFT | VERSION_CONFLICT"}})
async def update_note(note_id: uuid.UUID, body: UpdateIn, principal: Principal = Depends(staff),
                      rt: Runtime = Depends(get_runtime)) -> dict:
    actor = principal.require_permission(MANAGE)
    # exclude_unset: поле, которого нет в теле (illustration у клиента до 6.1), не затирает значение черновика
    content = rn.NoteContent.model_validate(body.model_dump(exclude={"expected_version"}, exclude_unset=True))
    async with rt.transaction() as session:
        note = await rn.update(session, note_id, body.expected_version, content, actor)
        return rn.staff_view(note)  # правится только черновик: показов нет


@staff_router.post("/{note_id}/publish", status_code=201,
                   responses={200: {"description": "уже опубликована — no-op"},
                              409: {"description": "RELEASE_NOTE_NOT_DRAFT | RELEASE_NOTE_VERSION_CONFLICT"},
                              422: {"description": "RELEASE_NOTE_TRANSLATION_MISSING {missing}"}})
async def publish_note(note_id: uuid.UUID, body: PublishIn, principal: Principal = Depends(staff),
                       rt: Runtime = Depends(get_runtime),
                       idempotency_key: str | None = IdempotencyKey) -> JSONResponse:
    actor = principal.require_permission(PUBLISH)

    async def run() -> tuple[int, dict]:
        async with rt.transaction() as session:
            note, changed = await rn.publish(session, note_id, body.expected_version, body.reason, actor)
            out = await rn.staff_view_of(session, note)
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
            out = await rn.staff_view_of(session, note)
        return (201 if changed else 200), out

    return await idempotent(rt, scope=f"{actor.id}:release-notes:archive:{note_id}", key=idempotency_key,
                            request=body.model_dump(), run=run)


# ---------------------------------------------------------------- ученик (telegram-bff)


@internal_router.get("/for-me", response_model=WhatsNewOut, responses={410: {"description": "USER_DELETED"}})
async def for_me(principal: Principal = Depends(learners), rt: Runtime = Depends(get_runtime),
                 onboarded_at: datetime | None = Query(default=None, description="ISO-8601; нет — онбординг не прошёл"),
                 lang: rn.UiLang = Query(), age: rn.AgeSegment = Query()) -> dict:
    """WhatsNew: welcome (знакомство после первой регистрации) | updates (непросмотренное) | none."""
    user_id = learner_id(principal)
    if onboarded_at is not None and onboarded_at.tzinfo is None:
        onboarded_at = onboarded_at.replace(tzinfo=UTC)
    async with rt.transaction() as session:
        return await rn.for_me(session, user_id, onboarded_at=onboarded_at, lang=lang, age=age)


@internal_router.post("/seen", status_code=204, responses={410: {"description": "USER_DELETED"}})
async def seen(body: SeenIn, principal: Principal = Depends(learners), rt: Runtime = Depends(get_runtime),
               lang: rn.UiLang | None = Query(default=None, description="язык интерфейса ученика (как в for-me)"),
               age: rn.AgeSegment | None = Query(default=None, description="возраст ученика (как в for-me)"),
               ) -> Response:
    """Отметить показанные заметки просмотренными: идемпотентно, неизвестный id игнорируется. Необязательные lang/age
    — сегмент ученика на момент показа для разрезов статистики (нет — отметка учитывается только в views_total)."""
    user_id = learner_id(principal)
    async with rt.transaction() as session:
        await rn.mark_seen(session, user_id, body.release_note_ids, lang=lang, age=age)
    return Response(status_code=204)


@internal_router.get("/feed", response_model=WhatsNewPage)
async def feed(_: Principal = Depends(learners), rt: Runtime = Depends(get_runtime),
               lang: rn.UiLang = Query(), age: rn.AgeSegment = Query(),
               limit: int = Query(default=20, ge=1, le=100),
               cursor: str | None = Query(default=None, max_length=200)) -> dict:
    """Лента «Новости»: все опубликованные заметки для сегмента ученика (Page<WhatsNewNote>)."""
    async with rt.transaction() as session:
        return await rn.feed(session, lang=lang, age=age, limit=limit, cursor=cursor)
