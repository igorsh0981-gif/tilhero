"""Расписание n8n: `billing-tick` (каждые 5 мин) — POST /internal/v1/billing:tick; `billing-reconcile` (23:15 UTC) —
POST /internal/v1/billing:reconcile; ручная начальная загрузка проекции — POST /internal/v1/projections/bootstrap.
Вход — только `Authorization: Bearer <SCHEDULER_TOKEN>`; повтор безопасен."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query, Request

from tilhero_billing.api.common import now, scheduler_only, settings_of
from tilhero_billing.domain import bootstrap, reconciliation, tick
from tilhero_common.app import Runtime, get_runtime

router = APIRouter(prefix="/internal/v1", tags=["scheduler"])


@router.post("/billing:tick")
async def billing_tick(request: Request, _: str = Depends(scheduler_only),
                       rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """Счётчики шагов; `skipped: true` — идёт предыдущий tick."""
    return await tick.run(rt, settings_of(request), now(request))


@router.post("/billing:reconcile")
async def billing_reconcile(_: str = Depends(scheduler_only), rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    run = await reconciliation.run(rt, "daily")
    return reconciliation.run_view(run)


@router.post("/projections/bootstrap")
async def projections_bootstrap(request: Request, force: bool = Query(default=False),
                                _: str = Depends(scheduler_only), rt: Runtime = Depends(get_runtime)
                                ) -> dict[str, Any]:
    return await bootstrap.run(rt, now(request), force=force)
