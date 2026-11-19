"""Расписание n8n `catalog-tick` (каждый час): POST /internal/v1/catalog:tick — вход только по SCHEDULER_TOKEN.

Медиа с истёкшими правами (valid_to < сегодня по Ташкенту) приостанавливаются; ответ — сколько приостановлено и
сколько истекает в ближайшие RIGHTS_WARNING_DAYS дней (предупреждение на обзоре админки). Повтор безопасен.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from tilhero_catalog.api.common import now_of, policy_of, scheduler_only, settings_of
from tilhero_catalog.domain import media_ops
from tilhero_common.app import Runtime, get_runtime

router = APIRouter(prefix="/internal/v1", tags=["scheduler"])


@router.post("/catalog:tick")
async def catalog_tick(_: str = Depends(scheduler_only), rt: Runtime = Depends(get_runtime)) -> dict:
    today = policy_of(rt).today
    async with rt.transaction() as session:
        suspended = await media_ops.suspend_expired(session, today, now_of(rt))
        expiring = await media_ops.rights_expiring(session, today, settings_of(rt).rights_warning_days)
    return {"suspended": suspended, "expiring": len(expiring), "today": today.isoformat()}
