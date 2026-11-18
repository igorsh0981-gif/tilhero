"""Staff API user-admin (вызывает только admin-bff; actor обязателен, права проверяются здесь же).

GET /admin/v1/learners          users.read       Page<AdminLearnerRow>
GET /admin/v1/learners/stats    dashboard.read   DashboardLearners
GET /admin/v1/learners/{id}     users.read       AdminLearnerCard без tickets (их добавляет admin-bff); перечитывает
                                                 identity-consent, недоступен — из проекции
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from typing import Literal, cast

from fastapi import APIRouter, Depends, Query

from tilhero_common.app import Runtime, get_runtime
from tilhero_common.errors import ApiError, not_found, unavailable
from tilhero_common.http_client import UpstreamError
from tilhero_common.internal_auth import InternalAuth, Principal
from tilhero_user_admin.domain import queries
from tilhero_user_admin.domain.projection import apply_snapshot
from tilhero_user_admin.domain.sync import IDENTITY_CLIENT
from tilhero_user_admin.models import LearnerSummary
from tilhero_user_admin.schemas import AdminLearnerCard, AdminLearnerPage, DashboardLearners, IdentitySnapshot
from tilhero_user_admin.settings import Settings

log = logging.getLogger("tilhero.user_admin.api")
router = APIRouter(prefix="/admin/v1/learners", tags=["staff"])
admin_bff = InternalAuth({"admin-bff"})


def _cfg(rt: Runtime) -> Settings:
    return cast(Settings, rt.settings)


def learner_not_found() -> ApiError:
    return not_found("LEARNER_NOT_FOUND", "Ученик не найден")


def _identity_unavailable() -> ApiError:
    return unavailable("UPSTREAM_UNAVAILABLE", "Сервис профилей недоступен", {"service": IDENTITY_CLIENT})


@router.get("", response_model=AdminLearnerPage)
async def list_learners(
    principal: Principal = Depends(admin_bff),
    rt: Runtime = Depends(get_runtime),
    q: str | None = Query(default=None, max_length=120),
    kind: Literal["account", "child"] | None = None,
    age_band: str | None = Query(default=None, max_length=40),
    status: str | None = Query(default=None, max_length=80),
    locale: Literal["ru", "uz"] | None = None,
    has_open_tickets: bool | None = None,
    limit: int = Query(default=20, ge=1, le=100),
    cursor: str | None = Query(default=None, max_length=256),
) -> AdminLearnerPage:
    actor = principal.require_permission("users.read")
    statuses = queries.parse_statuses(status)
    bands = queries.parse_age_bands(age_band)
    async with rt.transaction() as session:
        items, nxt = await queries.list_learners(
            session, q=q, kind=kind, age_bands=bands, statuses=statuses, locale=locale,
            has_open_tickets=has_open_tickets, limit=limit, cursor=cursor,
            can_search_tickets="support.read" in actor.permissions,
        )
    return AdminLearnerPage(items=items, next_cursor=nxt)


@router.get("/stats", response_model=DashboardLearners)
async def learner_stats(
    principal: Principal = Depends(admin_bff),
    rt: Runtime = Depends(get_runtime),
    period: Literal["today", "7d", "30d"] = "today",
) -> DashboardLearners:
    principal.require_permission("dashboard.read")
    since = queries.period_start(period, datetime.now(UTC), _cfg(rt).stats_timezone)
    async with rt.transaction() as session:
        return await queries.stats(session, since=since)


async def _load(rt: Runtime, user_id: uuid.UUID) -> LearnerSummary | None:
    async with rt.transaction() as session:
        return await session.get(LearnerSummary, user_id)


@router.get("/{user_id}", response_model=AdminLearnerCard)
async def get_learner(
    user_id: uuid.UUID, principal: Principal = Depends(admin_bff), rt: Runtime = Depends(get_runtime)
) -> AdminLearnerCard:
    """Карточка всегда перечитывается из identity-consent (`refreshed_at` — момент чтения). Источник недоступен —
    данные проекции, `refreshed_at` — момент последнего чтения или обновления проекции; ученик, которого проекция
    не знает, при недоступном источнике — 503, а не 404."""
    principal.require_permission("users.read")
    row = await _load(rt, user_id)
    try:
        data = await rt.client(IDENTITY_CLIENT).get(f"/admin/v1/users/{user_id}")
        snap = IdentitySnapshot.model_validate(data)
        if snap.user_id != user_id:
            raise ValueError("identity returned another learner")
        async with rt.transaction() as session:
            await apply_snapshot(session, snap, read_at=datetime.now(UTC))
        row = await _load(rt, user_id)
    except UpstreamError as exc:
        if exc.status == 404 and (row is None or not row.profile_known):
            # источник не знает ученика, а у нас только следы событий других доменов — его нет
            raise learner_not_found() from exc
        log.warning("identity refresh failed, serving projection", extra={"status": exc.status,
                                                                           "error_code": exc.code})
    except Exception as exc:
        log.warning("identity refresh failed, serving projection", extra={"error_type": type(exc).__name__})
    if row is None or not row.profile_known:
        raise _identity_unavailable()
    async with rt.transaction() as session:
        children, guardian = await queries.load_card_relations(session, row)
    return queries.card_view(row, children=children, guardian=guardian,
                             refreshed_at=row.refreshed_at or row.updated_at)
