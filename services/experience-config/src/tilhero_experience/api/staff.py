"""Staff API (только admin-bff, права сотрудника из токена): config.read / config.edit / config.publish."""

from __future__ import annotations

import re

from fastapi import APIRouter, Depends, Header, Query
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.app import Runtime, get_runtime
from tilhero_common.errors import bad_request, unprocessable
from tilhero_common.internal_auth import InternalAuth, Principal
from tilhero_experience.api.common import app_param, cache_of, dumps, idempotent
from tilhero_experience.domain import service
from tilhero_experience.domain.payload import SEMVER, ConfigInvalid
from tilhero_experience.models import Activation, ConfigVersion
from tilhero_experience.schemas import (
    ActivateIn,
    ActivationOut,
    ActivationPage,
    RollbackIn,
    StateOut,
    VersionCreateIn,
    VersionDetail,
    VersionPage,
)

router = APIRouter(prefix="/admin/v1/experience", tags=["staff"])
staff = InternalAuth({"admin-bff"})

READ, EDIT, PUBLISH = "config.read", "config.edit", "config.publish"
IdempotencyKey = Header(default=None, alias="Idempotency-Key", min_length=8, max_length=128,
                        pattern=r"^[A-Za-z0-9_\-:.]+$")


def _cursor(cursor: str | None) -> int | None:
    if cursor is None:
        return None
    try:
        return service.decode_cursor(cursor)
    except Exception as exc:
        raise bad_request("INVALID_CURSOR", "Некорректный курсор") from exc


async def _fresh_config(session: AsyncSession, app: str) -> tuple[int, str] | None:
    """Конфигурация после активации — читается в той же транзакции, в кэш кладётся после commit.

    Отдельный запрос после commit мог бы упасть и вернуть 500 на уже выполненную команду
    (а повтор с тем же Idempotency-Key выполнил бы откат второй раз).
    """
    state = await service.current_config(session, app)
    return (state[0], dumps(state[1])) if state is not None else None


async def _refresh_cache(rt: Runtime, app: str, fresh: tuple[int, str] | None) -> None:
    """Инвалидация 60-секундного кэша: новая конфигурация видна сразу после commit."""
    cache = cache_of(rt)
    if fresh is None:
        await cache.invalidate(app)
    else:
        await cache.put(app, *fresh)


@router.get("/{app}/versions", response_model=VersionPage)
async def list_versions(principal: Principal = Depends(staff), app: str = Depends(app_param),
                        rt: Runtime = Depends(get_runtime), limit: int = Query(default=20, ge=1, le=100),
                        cursor: str | None = Query(default=None, max_length=64)) -> VersionPage:
    principal.require_permission(READ)
    after = _cursor(cursor)
    stmt = (select(ConfigVersion).where(ConfigVersion.app == app)
            .order_by(ConfigVersion.seq.desc()).limit(limit + 1))
    if after is not None:
        stmt = stmt.where(ConfigVersion.seq < after)
    async with rt.transaction() as session:
        rows = (await session.execute(stmt)).scalars().all()
        cur = await service.current_activation(session, app)
    status: dict[str, service.Status] = {}
    if cur is not None:
        status[cur.version] = "current"
        if cur.previous_version:
            status[cur.previous_version] = "previous"
    items = [service.version_summary(v, status.get(v.version)) for v in rows[:limit]]
    next_cursor = service.encode_cursor(rows[limit - 1].seq) if len(rows) > limit else None
    return VersionPage(items=items, next_cursor=next_cursor)


@router.get("/{app}/versions/{version}", response_model=VersionDetail)
async def get_version(version: str, principal: Principal = Depends(staff), app: str = Depends(app_param),
                      rt: Runtime = Depends(get_runtime)) -> VersionDetail:
    principal.require_permission(READ)
    if not re.fullmatch(SEMVER, version):
        raise service.version_not_found(version[:32])
    async with rt.transaction() as session:
        v = await service.get_version(session, app, version)
        cur = await service.current_activation(session, app)
    if v is None:
        raise service.version_not_found(version)
    status: service.Status = None
    if cur is not None:
        if cur.version == version:
            status = "current"
        elif cur.previous_version == version:
            status = "previous"
    return service.version_detail(v, status)


@router.post("/{app}/versions", response_model=VersionDetail, status_code=201,
             responses={409: {"description": "EXPERIENCE_VERSION_EXISTS"},
                        422: {"description": "EXPERIENCE_CONFIG_INVALID {path, reason, errors}"}})
async def create_version(body: VersionCreateIn, principal: Principal = Depends(staff),
                         app: str = Depends(app_param), rt: Runtime = Depends(get_runtime),
                         idempotency_key: str | None = IdempotencyKey) -> JSONResponse:
    actor = principal.require_permission(EDIT)

    async def run() -> tuple[int, dict]:
        try:
            async with rt.transaction() as session:
                v, _ = await service.create_version(session, app, body.version, body.payload,
                                                    body.change_note, actor)
                cur = await service.current_activation(session, app)
        except ConfigInvalid as exc:
            raise unprocessable("EXPERIENCE_CONFIG_INVALID", "Конфигурация не прошла проверку",
                                {"path": exc.path, "reason": exc.reason, "errors": exc.errors}) from None
        status: service.Status = "current" if cur is not None and cur.version == v.version else None
        return 201, service.version_detail(v, status).model_dump(mode="json")

    return await idempotent(rt, scope=f"{actor.id}:{app}:create", key=idempotency_key,
                            request=body.model_dump(), run=run)


@router.get("/{app}/activations", response_model=ActivationPage)
async def list_activations(principal: Principal = Depends(staff), app: str = Depends(app_param),
                           rt: Runtime = Depends(get_runtime), limit: int = Query(default=20, ge=1, le=100),
                           cursor: str | None = Query(default=None, max_length=64)) -> ActivationPage:
    principal.require_permission(READ)
    after = _cursor(cursor)
    stmt = select(Activation).where(Activation.app == app).order_by(Activation.seq.desc()).limit(limit + 1)
    if after is not None:
        stmt = stmt.where(Activation.seq < after)
    async with rt.transaction() as session:
        rows = (await session.execute(stmt)).scalars().all()
    next_cursor = service.encode_cursor(rows[limit - 1].seq) if len(rows) > limit else None
    return ActivationPage(items=[service.activation_out(a) for a in rows[:limit]], next_cursor=next_cursor)


@router.get("/{app}/state", response_model=StateOut)
async def get_state(principal: Principal = Depends(staff), app: str = Depends(app_param),
                    rt: Runtime = Depends(get_runtime)) -> StateOut:
    principal.require_permission(READ)
    async with rt.transaction() as session:
        cur = await service.current_activation(session, app)
    return StateOut(app=app, current=service.activation_out(cur) if cur else None,
                    previous_version=cur.previous_version if cur else None)


@router.post("/{app}/activate", response_model=ActivationOut, status_code=201,
             responses={200: {"description": "версия уже текущая — no-op"},
                        404: {"description": "EXPERIENCE_VERSION_NOT_FOUND"}})
async def activate(body: ActivateIn, principal: Principal = Depends(staff), app: str = Depends(app_param),
                   rt: Runtime = Depends(get_runtime),
                   idempotency_key: str | None = IdempotencyKey) -> JSONResponse:
    actor = principal.require_permission(PUBLISH)

    async def run() -> tuple[int, dict]:
        async with rt.transaction() as session:
            act, created = await service.activate(session, app, body.version, body.reason, actor)
            out = service.activation_out(act).model_dump(mode="json")
            fresh = await _fresh_config(session, app) if created else None
        if created:
            await _refresh_cache(rt, app, fresh)
        return (201 if created else 200), out

    return await idempotent(rt, scope=f"{actor.id}:{app}:activate", key=idempotency_key,
                            request=body.model_dump(), run=run)


@router.post("/{app}/rollback", response_model=ActivationOut, status_code=201,
             responses={404: {"description": "EXPERIENCE_CONFIG_NOT_FOUND"},
                        409: {"description": "EXPERIENCE_NO_PREVIOUS"}})
async def rollback(body: RollbackIn, principal: Principal = Depends(staff), app: str = Depends(app_param),
                   rt: Runtime = Depends(get_runtime),
                   idempotency_key: str | None = IdempotencyKey) -> JSONResponse:
    actor = principal.require_permission(PUBLISH)

    async def run() -> tuple[int, dict]:
        async with rt.transaction() as session:
            act = await service.rollback(session, app, body.reason, actor)
            out = service.activation_out(act).model_dump(mode="json")
            fresh = await _fresh_config(session, app)
        await _refresh_cache(rt, app, fresh)
        return 201, out

    return await idempotent(rt, scope=f"{actor.id}:{app}:rollback", key=idempotency_key,
                            request=body.model_dump(), run=run)
