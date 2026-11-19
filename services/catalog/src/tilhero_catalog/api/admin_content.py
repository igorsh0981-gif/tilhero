"""Admin API контента (admin.ts «Контент и диагностика»): вызывающий — только admin-bff с actor; права — здесь, в
домене (step-up для publish / archive / rollback / rights-approve / decide проверяет admin-bff).

content.read — чтение и сухая проверка; content.edit — черновики, отправка, тестовый прогон, аудио; content.review —
проверка (не своих: 409 SELF_REVIEW); content.publish — публикация, снятие, откат; media.rights — права медиа и
решения по заявкам; dashboard.read | content.read — сводка. Имена сотрудников (*_name) дополняет admin-bff — здесь id.
"""

from __future__ import annotations

import re
import uuid
from typing import Any

from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from sqlalchemy import select

from tilhero_catalog.api.common import (
    IdempotencyKey,
    idempotent,
    policy_of,
    require_any,
    settings_of,
    staff_auth,
)
from tilhero_catalog.api.upload import STATE_KEY
from tilhero_catalog.content import CONTENT_KINDS, ID_PATTERN, Band, MediaRequestStatus, VersionStatus
from tilhero_catalog.domain import media_ops, requests, versions
from tilhero_catalog.domain.common import (
    CONTENT_EDIT,
    CONTENT_PUBLISH,
    CONTENT_READ,
    CONTENT_REVIEW,
    DASHBOARD_READ,
    MEDIA_RIGHTS,
    decode_cursor,
    encode_cursor,
)
from tilhero_catalog.models import ContentVersion as CV
from tilhero_catalog.schemas import (
    ArchiveIn,
    AudioUploadIn,
    ContentCreateIn,
    MediaRequestDecisionIn,
    NewVersionIn,
    PublishIn,
    ReviewIn,
    RightsApproveIn,
    RollbackIn,
    VersionUpdateIn,
)
from tilhero_common.app import Runtime, get_runtime
from tilhero_common.errors import not_found, unprocessable
from tilhero_common.internal_auth import Principal

router = APIRouter(prefix="/admin/v1/content", tags=["staff"])

_KEY_RE = re.compile(ID_PATTERN)


def _kind(kind: str) -> str:
    if kind not in CONTENT_KINDS:
        raise not_found("CONTENT_KIND_UNKNOWN", "Неизвестный вид контента")
    return kind


def _key(kind: str, key: str) -> str:
    if not _KEY_RE.match(key):
        raise not_found("CONTENT_NOT_FOUND", f"Нет сущности {kind} «{key[:64]}»")
    return key


def _only(kind: str, expected: str) -> None:
    if kind != expected:
        raise not_found("NOT_FOUND", f"Команда доступна только для {expected}")


# ---------------------------------------------------------------- сводка, очередь, аудио, заявки (до /{kind})


@router.get("/summary")
async def summary(principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)) -> dict:
    """ContentSummary для обзора (dashboard.read | content.read)."""
    require_any(principal, DASHBOARD_READ, CONTENT_READ)
    s = settings_of(rt)
    async with rt.transaction() as session:
        return await media_ops.summary(session, policy_of(rt).today, s.rights_warning_days)


@router.get("/review-queue")
async def review_queue(principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime),
                       kind: str | None = Query(default=None, max_length=32),
                       limit: int = Query(default=20, ge=1, le=100),
                       cursor: str | None = Query(default=None, max_length=200)) -> dict:
    """Page<ContentRow>: версии на проверке, которые сотрудник не правил (свои проверять нельзя)."""
    actor = principal.require_permission(CONTENT_REVIEW)
    if kind is not None:
        _kind(kind)
    after = decode_cursor(cursor, 1)
    stmt = (select(CV.seq, CV.kind, CV.key).where(CV.status == "in_review", ~CV.editors.contains([actor.id]),
                                                  CV.author_id != actor.id)
            .order_by(CV.seq).limit(limit + 1))
    if kind is not None:
        stmt = stmt.where(CV.kind == kind)
    if after is not None:
        stmt = stmt.where(CV.seq > int(after[0]))
    s = settings_of(rt)
    today = policy_of(rt).today
    async with rt.transaction() as session:
        found = (await session.execute(stmt)).all()
        page = found[:limit]
        items: list[dict[str, Any]] = []
        for _, k, key in page:
            items.extend(await versions.rows_for(session, k, keys=[key], today=today,
                                                 warning_days=s.rights_warning_days))
    next_cursor = encode_cursor(page[-1][0]) if len(found) > limit and page else None
    return {"items": items, "next_cursor": next_cursor}


@router.post("/blobs", status_code=201, responses={422: {"description": "AUDIO_INVALID {reason}"}})
async def upload_blob(request: Request, principal: Principal = Depends(staff_auth),
                      rt: Runtime = Depends(get_runtime)) -> JSONResponse:
    """AudioUpload → AudioBlob. Тело читает UploadBodyMiddleware (≤ 4,5 МБ только здесь)."""
    actor = principal.require_permission(CONTENT_EDIT)
    raw = getattr(request.state, STATE_KEY, None)
    if raw is None:
        raw = await request.body()
    try:
        body = AudioUploadIn.model_validate_json(raw or b"{}")
    except ValidationError as exc:
        errors = [{"loc": ["body", *(str(p) for p in e["loc"])], "msg": e["msg"], "type": e["type"]}
                  for e in exc.errors()[:20]]
        raise unprocessable("VALIDATION_ERROR", "Некорректные данные запроса", {"errors": errors}) from None
    data = media_ops.decode_audio(body.content_type, body.data_base64)
    async with rt.transaction() as session:
        blob, created = await media_ops.store_blob(session, body.content_type, data, actor)
        out = media_ops.blob_view(blob)
    return JSONResponse(out, status_code=201 if created else 200)


@router.get("/blobs/{blob_id}")
async def get_blob(blob_id: uuid.UUID, principal: Principal = Depends(staff_auth),
                   rt: Runtime = Depends(get_runtime)) -> Response:
    """Аудио для предпросмотра в админке (content.read)."""
    principal.require_permission(CONTENT_READ)
    async with rt.transaction() as session:
        blob = await media_ops.get_blob(session, blob_id)
    return Response(blob.bytes, media_type=blob.content_type,
                    headers={"Cache-Control": "private, max-age=3600", "ETag": f'"{blob.sha256}"'})


@router.get("/media-requests")
async def list_requests(principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime),
                        status: MediaRequestStatus | None = Query(default=None),
                        q: str | None = Query(default=None, max_length=200),
                        limit: int = Query(default=20, ge=1, le=100),
                        cursor: str | None = Query(default=None, max_length=200)) -> dict:
    """Page<AdminMediaRequest> (media.rights — ссылка и комментарий ученика: минимизация доступа к ПД), новые первыми,
    similar_count — по нормализованному названию."""
    principal.require_permission(MEDIA_RIGHTS)
    async with rt.transaction() as session:
        return await requests.admin_list(session, status=status, q=q, cursor=cursor, limit=limit)


@router.get("/media-requests/{request_id}", responses={404: {"description": "MEDIA_REQUEST_NOT_FOUND"}})
async def get_request(request_id: uuid.UUID, principal: Principal = Depends(staff_auth),
                      rt: Runtime = Depends(get_runtime)) -> dict:
    """Карточка заявки (media.rights)."""
    principal.require_permission(MEDIA_RIGHTS)
    async with rt.transaction() as session:
        return await requests.admin_view_of(session, await requests.get(session, request_id))


@router.post("/media-requests/{request_id}/take")
async def take_request(request_id: uuid.UUID, principal: Principal = Depends(staff_auth),
                       rt: Runtime = Depends(get_runtime)) -> dict:
    actor = principal.require_permission(MEDIA_RIGHTS)
    async with rt.transaction() as session:
        row = await requests.take(session, request_id, actor)
        return await requests.admin_view_of(session, row)


@router.post("/media-requests/{request_id}/decide",
             responses={409: {"description": "MEDIA_REQUEST_DECIDED"},
                        422: {"description": "LINKED_ASSET_REQUIRED | LINKED_ASSET_NOT_PUBLISHED"}})
async def decide_request(request_id: uuid.UUID, body: MediaRequestDecisionIn,
                         principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime),
                         idempotency_key: str | None = IdempotencyKey) -> JSONResponse:
    """Решение по заявке (media.rights, step-up) → уведомление ученику (catalog.media_request.decided.v1).
    Ссылка ученика сервером не открывается и не скачивается."""
    actor = principal.require_permission(MEDIA_RIGHTS)

    async def run() -> tuple[int, Any]:
        async with rt.transaction() as session:
            row, _ = await requests.decide(session, request_id, status=body.status, note=body.note,
                                           linked_asset_id=body.linked_asset_id, actor=actor)
            return 200, await requests.admin_view_of(session, row)

    return await idempotent(rt, scope=f"{actor.id}:media-request:decide:{request_id}", key=idempotency_key,
                            request=body.model_dump(), run=run)


# ---------------------------------------------------------------- сущности контента


@router.get("/{kind}")
async def list_content(kind: str, principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime),
                       q: str | None = Query(default=None, max_length=200),
                       status: VersionStatus | None = Query(default=None),
                       level: Band | None = Query(default=None),
                       limit: int = Query(default=20, ge=1, le=100),
                       cursor: str | None = Query(default=None, max_length=200)) -> dict:
    """Page<ContentRow> по ключу; status=published — с опубликованной версией, иначе — статус последней версии."""
    principal.require_permission(CONTENT_READ)
    _kind(kind)
    after = decode_cursor(cursor, 1)
    s = settings_of(rt)
    async with rt.transaction() as session:
        rows = await versions.rows_for(session, kind, status=status, level=level, q=q,
                                       after=str(after[0]) if after else None, limit=limit + 1,
                                       today=policy_of(rt).today, warning_days=s.rights_warning_days)
    page = rows[:limit]
    next_cursor = encode_cursor(page[-1]["key"]) if len(rows) > limit and page else None
    return {"items": page, "next_cursor": next_cursor}


@router.post("/{kind}", status_code=201,
             responses={409: {"description": "CONTENT_KEY_EXISTS"},
                        422: {"description": "CONTENT_INVALID {errors} (только схема)"}})
async def create_content(kind: str, body: ContentCreateIn, principal: Principal = Depends(staff_auth),
                         rt: Runtime = Depends(get_runtime),
                         idempotency_key: str | None = IdempotencyKey) -> JSONResponse:
    actor = principal.require_permission(CONTENT_EDIT)
    _kind(kind)

    async def run() -> tuple[int, Any]:
        async with rt.transaction() as session:
            row = await versions.create(session, kind, body.payload, actor)
            return 201, await versions.version_view(session, row)

    return await idempotent(rt, scope=f"{actor.id}:content:create:{kind}", key=idempotency_key,
                            request=body.model_dump(mode="json"), run=run)


@router.get("/{kind}/{key}")
async def get_content(kind: str, key: str, principal: Principal = Depends(staff_auth),
                      rt: Runtime = Depends(get_runtime)) -> dict:
    """{row: ContentRow, versions: ContentVersionMeta[]} — версии от новых к старым."""
    principal.require_permission(CONTENT_READ)
    _key(_kind(kind), key)
    s = settings_of(rt)
    async with rt.transaction() as session:
        all_versions = await versions.versions_of(session, kind, key)
        rows = await versions.rows_for(session, kind, keys=[key], today=policy_of(rt).today,
                                       warning_days=s.rights_warning_days)
    return {"row": rows[0], "versions": [versions.version_meta(v) for v in all_versions]}


@router.post("/{kind}/{key}/versions", status_code=201, responses={409: {"description": "DRAFT_EXISTS {version}"}})
async def new_version(kind: str, key: str, body: NewVersionIn, principal: Principal = Depends(staff_auth),
                      rt: Runtime = Depends(get_runtime),
                      idempotency_key: str | None = IdempotencyKey) -> JSONResponse:
    """Правка опубликованного = новая версия-черновик из выбранной (from_version)."""
    actor = principal.require_permission(CONTENT_EDIT)
    _key(_kind(kind), key)

    async def run() -> tuple[int, Any]:
        async with rt.transaction() as session:
            row = await versions.new_version(session, kind, key, body.from_version, actor)
            return 201, await versions.version_view(session, row)

    return await idempotent(rt, scope=f"{actor.id}:content:new-version:{kind}:{key}", key=idempotency_key,
                            request=body.model_dump(), run=run)


@router.get("/{kind}/{key}/versions/{version}")
async def get_version(kind: str, key: str, version: int, principal: Principal = Depends(staff_auth),
                      rt: Runtime = Depends(get_runtime)) -> dict:
    principal.require_permission(CONTENT_READ)
    _key(_kind(kind), key)
    async with rt.transaction() as session:
        row = await versions.get_version(session, kind, key, version)
        return await versions.version_view(session, row)


@router.put("/{kind}/{key}/versions/{version}",
            responses={409: {"description": "VERSION_NOT_DRAFT | VERSION_CONFLICT {payload_hash}"},
                       422: {"description": "CONTENT_INVALID (схема, KEY_CHANGED)"}})
async def update_version(kind: str, key: str, version: int, body: VersionUpdateIn,
                         principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)) -> dict:
    actor = principal.require_permission(CONTENT_EDIT)
    _key(_kind(kind), key)
    async with rt.transaction() as session:
        row = await versions.update_draft(session, kind, key, version, body.payload, body.expected_hash, actor)
        return await versions.version_view(session, row)


@router.post("/{kind}/{key}/versions/{version}/validate")
async def validate_version(kind: str, key: str, version: int, principal: Principal = Depends(staff_auth),
                           rt: Runtime = Depends(get_runtime)) -> dict:
    """Сухая проверка в режиме публикации: {ok, errors}."""
    principal.require_permission(CONTENT_READ)
    _key(_kind(kind), key)
    async with rt.transaction() as session:
        issues = await versions.check(session, kind, key, version, policy_of(rt))
    return {"ok": not issues, "errors": [i.as_dict() for i in issues]}


@router.post("/{kind}/{key}/versions/{version}/submit",
             responses={409: {"description": "VERSION_NOT_DRAFT"}, 422: {"description": "CONTENT_INVALID"}})
async def submit_version(kind: str, key: str, version: int, principal: Principal = Depends(staff_auth),
                         rt: Runtime = Depends(get_runtime)) -> dict:
    actor = principal.require_permission(CONTENT_EDIT)
    _key(_kind(kind), key)
    async with rt.transaction() as session:
        row = await versions.submit(session, kind, key, version, actor, policy_of(rt))
        return await versions.version_view(session, row)


@router.post("/{kind}/{key}/versions/{version}/review",
             responses={409: {"description": "SELF_REVIEW | VERSION_NOT_IN_REVIEW"}})
async def review_version(kind: str, key: str, version: int, body: ReviewIn,
                         principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)) -> dict:
    actor = principal.require_permission(CONTENT_REVIEW)
    _key(_kind(kind), key)
    async with rt.transaction() as session:
        row = await versions.review(session, kind, key, version, decision=body.decision, note=body.note,
                                    locale_checks=body.locale_checks.model_dump(), actor=actor)
        return await versions.version_view(session, row)


@router.post("/{kind}/{key}/versions/{version}/publish",
             responses={200: {"description": "уже опубликована — no-op"},
                        409: {"description": "VERSION_NOT_APPROVED"}, 422: {"description": "CONTENT_INVALID"}})
async def publish_version(kind: str, key: str, version: int, body: PublishIn,
                          principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime),
                          idempotency_key: str | None = IdempotencyKey) -> JSONResponse:
    actor = principal.require_permission(CONTENT_PUBLISH)
    _key(_kind(kind), key)

    async def run() -> tuple[int, Any]:
        async with rt.transaction() as session:
            row, _ = await versions.publish(session, kind, key, version, body.reason, actor, policy_of(rt))
            return 200, await versions.version_view(session, row)

    return await idempotent(rt, scope=f"{actor.id}:content:publish:{kind}:{key}:{version}", key=idempotency_key,
                            request=body.model_dump(), run=run)


@router.post("/{kind}/{key}/archive", responses={409: {"description": "CONTENT_IN_USE {refs} | CONTENT_NOT_PUBLISHED"}})
async def archive_content(kind: str, key: str, body: ArchiveIn, principal: Principal = Depends(staff_auth),
                          rt: Runtime = Depends(get_runtime),
                          idempotency_key: str | None = IdempotencyKey) -> JSONResponse:
    """Снять с публикации → {row}."""
    actor = principal.require_permission(CONTENT_PUBLISH)
    _key(_kind(kind), key)
    s = settings_of(rt)

    async def run() -> tuple[int, Any]:
        async with rt.transaction() as session:
            await versions.archive(session, kind, key, body.reason, actor)
            rows = await versions.rows_for(session, kind, keys=[key], today=policy_of(rt).today,
                                           warning_days=s.rights_warning_days)
            return 200, {"row": rows[0]}

    return await idempotent(rt, scope=f"{actor.id}:content:archive:{kind}:{key}", key=idempotency_key,
                            request=body.model_dump(), run=run)


@router.post("/{kind}/{key}/rollback",
             responses={409: {"description": "ROLLBACK_TARGET_INVALID"}, 422: {"description": "CONTENT_INVALID"}})
async def rollback_content(kind: str, key: str, body: RollbackIn, principal: Principal = Depends(staff_auth),
                           rt: Runtime = Depends(get_runtime),
                           idempotency_key: str | None = IdempotencyKey) -> JSONResponse:
    actor = principal.require_permission(CONTENT_PUBLISH)
    _key(_kind(kind), key)

    async def run() -> tuple[int, Any]:
        async with rt.transaction() as session:
            row = await versions.rollback(session, kind, key, body.to_version, body.reason, actor, policy_of(rt))
            return 200, await versions.version_view(session, row)

    return await idempotent(rt, scope=f"{actor.id}:content:rollback:{kind}:{key}", key=idempotency_key,
                            request=body.model_dump(), run=run)


@router.post("/{kind}/{key}/versions/{version}/test-run")
async def test_run(kind: str, key: str, version: int, principal: Principal = Depends(staff_auth),
                   rt: Runtime = Depends(get_runtime)) -> dict:
    """ScenarioTestRun (content.edit): сохраняется с хешем тела — после правки черновика прогон устаревает."""
    actor = principal.require_permission(CONTENT_EDIT)
    _key(_kind(kind), key)
    _only(kind, "scenario")
    async with rt.transaction() as session:
        return await versions.test_run(session, key, version, actor)


async def _rights_approve(kind: str, key: str, version: int, body: RightsApproveIn, principal: Principal,
                          rt: Runtime, idempotency_key: str | None) -> JSONResponse:
    actor = principal.require_permission(MEDIA_RIGHTS)
    _key(_kind(kind), key)
    _only(kind, "media_asset")

    async def run() -> tuple[int, Any]:
        async with rt.transaction() as session:
            row = await versions.rights_approve(session, key, version, body.note, actor, policy_of(rt))
            return 200, await versions.version_view(session, row)

    return await idempotent(rt, scope=f"{actor.id}:content:rights:{key}:{version}", key=idempotency_key,
                            request=body.model_dump(), run=run)


@router.post("/{kind}/{key}/versions/{version}/rights-approve",
             responses={409: {"description": "VERSION_IMMUTABLE"}, 422: {"description": "CONTENT_INVALID"}})
async def rights_approve(kind: str, key: str, version: int, body: RightsApproveIn,
                         principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime),
                         idempotency_key: str | None = IdempotencyKey) -> JSONResponse:
    """Подтверждение прав медиа (media.rights, step-up): сбрасывается правкой черновика."""
    return await _rights_approve(kind, key, version, body, principal, rt, idempotency_key)


@router.post("/{kind}/{key}/versions/{version}/rights:approve", include_in_schema=False)
async def rights_approve_alias(kind: str, key: str, version: int, body: RightsApproveIn,
                               principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime),
                               idempotency_key: str | None = IdempotencyKey) -> JSONResponse:
    """Написание из INTERNAL_API §1.2 (`rights:approve`) — то же, что rights-approve (admin.ts)."""
    return await _rights_approve(kind, key, version, body, principal, rt, idempotency_key)
