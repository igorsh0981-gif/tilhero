"""Расписание n8n: POST /internal/v1/reconcile — внеочередная сверка с identity-consent и learning-plan.

Вход только по `Authorization: Bearer <SCHEDULER_TOKEN>` (сравнение за постоянное время; пустой токен в настройках
выключает вход). Внутренний JWT любого сервиса → 403 CALLER_NOT_ALLOWED. Токен не логируется.
Ответ: 200 ReconcileOut, если оба источника сверены; иначе 503 RECONCILE_FAILED {failed, applied} (n8n видит сбой).
"""

from __future__ import annotations

import hmac
import logging
from typing import cast

from fastapi import APIRouter, Depends, Request

from tilhero_common.errors import unauthorized, unavailable
from tilhero_common.internal_auth import HEADER, InternalAuth
from tilhero_user_admin.domain.sync import Reconciler
from tilhero_user_admin.schemas import ReconcileOut, ReconcileSourceOut
from tilhero_user_admin.settings import Settings

log = logging.getLogger("tilhero.user_admin.internal")
router = APIRouter(prefix="/internal/v1", tags=["scheduler"])
no_service = InternalAuth(set())  # внутренний JWT любого сервиса на входе планировщика → 403 CALLER_NOT_ALLOWED


async def scheduler_only(request: Request) -> str:
    expected = cast(Settings, request.app.state.runtime.settings).scheduler_token.get_secret_value()
    scheme, _, presented = (request.headers.get("authorization") or "").partition(" ")
    presented = presented.strip()
    if (
        expected
        and presented
        and scheme.lower() == "bearer"
        and hmac.compare_digest(presented.encode("utf-8"), expected.encode("utf-8"))
    ):
        return "scheduler"
    if request.headers.get(HEADER) is not None and not request.headers.get("authorization"):
        await no_service(request)
    log.warning("scheduler auth rejected",
                extra={"reason": "SCHEDULER_TOKEN_INVALID" if expected else "SCHEDULER_AUTH_DISABLED"})
    raise unauthorized("SCHEDULER_TOKEN_INVALID", "Неверный токен планировщика")


@router.post("/reconcile", response_model=ReconcileOut)
async def reconcile(request: Request, _: str = Depends(scheduler_only)) -> ReconcileOut:
    """Повтор безопасен: снимки применяются по версиям, прогоны одного источника сериализуются."""
    reconciler = cast(Reconciler, request.app.state.reconciler)
    results = await reconciler.run_all()
    out = ReconcileOut(**{name: ReconcileSourceOut(ok=error is None, applied=applied, error=error)
                          for name, (applied, error) in results.items()})
    failed = [name for name, (_, error) in results.items() if error is not None]
    if failed:
        raise unavailable("RECONCILE_FAILED", "Сверка с источником не выполнена",
                          {"failed": failed, "applied": {name: applied for name, (applied, _) in results.items()}})
    return out
