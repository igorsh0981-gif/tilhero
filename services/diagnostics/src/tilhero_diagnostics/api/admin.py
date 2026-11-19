"""Admin API diagnostics (только admin-bff, права сотрудника из actor проверяются здесь — защита в глубину):
content.read — тесты и версии с ключами; content.publish — публикация версии (step-up — в admin-bff);
dashboard.read — статистика прохождений."""

from __future__ import annotations

from datetime import UTC, timedelta
from typing import Any, Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Path, Request

from tilhero_common.app import Runtime, get_runtime
from tilhero_common.internal_auth import Principal
from tilhero_diagnostics.api.common import clock_of, settings_of, staff_auth
from tilhero_diagnostics.domain import admin as svc
from tilhero_diagnostics.schemas import (
    DiagnosticStatsOut,
    DiagnosticTestListOut,
    DiagnosticTestRowOut,
    DiagnosticTestVersionOut,
    PairLearnersListOut,
    PublishIn,
)

router = APIRouter(prefix="/admin/v1/diagnostics", tags=["staff"])

READ, PUBLISH, DASHBOARD = "content.read", "content.publish", "dashboard.read"
TestId = Path(min_length=2, max_length=64, pattern=r"^[a-z0-9][a-z0-9._-]{1,63}$")
Version = Path(ge=1, le=10_000)


@router.get("/tests", response_model=DiagnosticTestListOut)
async def list_tests(principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    principal.require_permission(READ)
    async with rt.transaction() as session:
        return {"items": await svc.list_tests(session)}


@router.get("/tests/{test_id}/versions/{version}", response_model=DiagnosticTestVersionOut,
            responses={404: {"description": "DIAGNOSTIC_TEST_NOT_FOUND"}})
async def get_version(test_id: str = TestId, version: int = Version, principal: Principal = Depends(staff_auth),
                      rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    principal.require_permission(READ)
    async with rt.transaction() as session:
        return await svc.get_version(session, test_id, version)


@router.post("/tests/{test_id}/versions/{version}/publish", response_model=DiagnosticTestRowOut,
             responses={404: {"description": "DIAGNOSTIC_TEST_NOT_FOUND"},
                        422: {"description": "TEST_INVALID {errors: [{path, code, message}]}"}})
async def publish(request: Request, body: PublishIn, test_id: str = TestId, version: int = Version,
                  principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    actor = principal.require_permission(PUBLISH)
    async with rt.transaction() as session:
        row, _ = await svc.publish(session, test_id=test_id, version=version, actor=actor, reason=body.reason,
                                   now=clock_of(request)())
    return row


@router.get("/pairs", response_model=PairLearnersListOut)
async def pairs(principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """Ученики с результатом диагностики по паре (для карточки пары и блока «Контент» обзора admin-bff)."""
    principal.require_permission(READ)
    async with rt.transaction() as session:
        return {"items": await svc.pair_learners(session)}


@router.get("/stats", response_model=DiagnosticStatsOut)
async def stats(request: Request, period: Literal["today", "7d", "30d"] = "today",
                principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    principal.require_permission(DASHBOARD)
    now = clock_of(request)()
    if period == "today":
        tz = ZoneInfo(settings_of(request).stats_timezone)
        since = now.astimezone(tz).replace(hour=0, minute=0, second=0, microsecond=0).astimezone(UTC)
    else:
        since = now - timedelta(days=7 if period == "7d" else 30)
    async with rt.transaction() as session:
        return await svc.stats(session, period=period, since=since)

