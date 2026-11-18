"""Staff API user-admin (вызывает только admin-bff; actor обязателен, права проверяются здесь же).

GET /admin/v1/users            users.read       Page<AdminUserRow>; спринт 7: access_level=, access_level_source=
GET /admin/v1/users/stats      dashboard.read   {total, new_in_period, onboarding_completed_pct, by_status,
                                                 active_in_period, active_today} (спринт 8)
GET /admin/v1/users/{id}       users.read       AdminUserCard без tickets/ai_conversations; перечитывает
                                                identity-consent, если данным > card_max_age_seconds
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Literal, cast

from fastapi import APIRouter, Depends, Query

from tilhero_common.app import Runtime, get_runtime
from tilhero_common.errors import not_found, unavailable
from tilhero_common.http_client import UpstreamError
from tilhero_common.internal_auth import InternalAuth, Principal
from tilhero_user_admin.domain import queries
from tilhero_user_admin.domain.projection import apply_snapshot
from tilhero_user_admin.domain.sync import IDENTITY_CLIENT
from tilhero_user_admin.models import UserSummary
from tilhero_user_admin.schemas import AdminUserCard, AdminUserPage, IdentitySnapshot, UserStats
from tilhero_user_admin.settings import Settings

log = logging.getLogger("tilhero.user_admin.api")
router = APIRouter(prefix="/admin/v1/users", tags=["staff"])
admin_bff = InternalAuth({"admin-bff"})


def _cfg(rt: Runtime) -> Settings:
    return cast(Settings, rt.settings)


def _user_not_found():
    return not_found("USER_NOT_FOUND", "Пользователь не найден")


@router.get("", response_model=AdminUserPage)
async def list_users(
    principal: Principal = Depends(admin_bff),
    rt: Runtime = Depends(get_runtime),
    q: str | None = Query(default=None, max_length=120),
    status: str | None = Query(default=None, max_length=80),
    # Формат — как у admin-bff; значения, которых нет в read-модели (сейчас только ru/en), дают пустой список
    locale: str | None = Query(default=None, min_length=2, max_length=16, pattern=r"^[A-Za-z_-]+$"),
    has_open_tickets: bool | None = None,
    # спринт 7: уровень доступа к AI (проекция ai-control) — коды через запятую и/или источник назначения
    access_level: str | None = Query(default=None, max_length=330),
    access_level_source: Literal["default", "manual"] | None = None,
    limit: int = Query(default=20, ge=1, le=100),
    cursor: str | None = Query(default=None, max_length=256),
) -> AdminUserPage:
    principal.require_permission("users.read")
    statuses = queries.parse_statuses(status)
    levels = queries.parse_access_levels(access_level)
    now = datetime.now(UTC)
    async with rt.transaction() as session:
        rows, nxt = await queries.list_users(session, q=q, statuses=statuses, locale=locale,
                                             has_open_tickets=has_open_tickets, limit=limit, cursor=cursor,
                                             access_levels=levels, access_level_source=access_level_source, now=now)
        return AdminUserPage(items=[queries.row_view(r, now) for r in rows], next_cursor=nxt)


@router.get("/stats", response_model=UserStats)
async def user_stats(
    principal: Principal = Depends(admin_bff),
    rt: Runtime = Depends(get_runtime),
    period: Literal["today", "7d", "30d"] = "today",
) -> UserStats:
    principal.require_permission("dashboard.read")
    at, tz = datetime.now(UTC), _cfg(rt).stats_timezone
    since = queries.period_start(period, at, tz)
    async with rt.transaction() as session:
        return await queries.stats(session, since=since, today=queries.period_start("today", at, tz))


async def _load(rt: Runtime, user_id: uuid.UUID) -> UserSummary | None:
    async with rt.transaction() as session:
        return await session.get(UserSummary, user_id)


@router.get("/{user_id}", response_model=AdminUserCard)
async def get_user(
    user_id: uuid.UUID, principal: Principal = Depends(admin_bff), rt: Runtime = Depends(get_runtime)
) -> AdminUserCard:
    principal.require_permission("users.read")
    row = await _load(rt, user_id)
    now = datetime.now(UTC)
    max_age = timedelta(seconds=_cfg(rt).card_max_age_seconds)
    if row is None or row.refreshed_at is None or now - row.refreshed_at > max_age:
        try:
            data = await rt.client(IDENTITY_CLIENT).get(f"/admin/v1/users/{user_id}")
            snap = IdentitySnapshot.model_validate(data)
            async with rt.transaction() as session:
                await apply_snapshot(session, snap, read_at=datetime.now(UTC))
            row = await _load(rt, user_id)
        except UpstreamError as exc:
            if exc.status == 404 and (row is None or not row.profile_known):
                # источник не знает пользователя, а у нас только следы событий других доменов — его нет
                raise _user_not_found() from exc
            # Источник недоступен — отдаём последние известные данные с прежним refreshed_at
            log.warning("identity refresh failed, serving stale card",
                        extra={"status": exc.status, "error_code": exc.code})
        except Exception as exc:
            log.warning("identity refresh failed, serving stale card", extra={"error_type": type(exc).__name__})
    if row is None:
        raise unavailable("UPSTREAM_UNAVAILABLE", "Сервис профилей недоступен", {"service": IDENTITY_CLIENT})
    if row.refreshed_at is None:
        # Строка известна только по событиям, authoritative-данных ещё не было — честно сообщаем о недоступности
        raise unavailable("UPSTREAM_UNAVAILABLE", "Сервис профилей недоступен", {"service": IDENTITY_CLIENT})
    return queries.card_view(row, row.refreshed_at)
