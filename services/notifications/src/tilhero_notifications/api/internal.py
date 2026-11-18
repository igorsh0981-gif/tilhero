"""Внутренние команды notifications.

- `POST /internal/v1/notifications/transactional` — синхронная доставка секретных транзакционных сообщений (код
  сброса PIN) мимо шины: код не попадает ни в outbox identity-consent, ни в JetStream. Вызывает только
  identity-consent. Запись в журнал (в центре не показывается) и немедленная отправка; временная ошибка → queued
  с повтором; конечный статус очищает params (CHECK в БД). Повтор с тем же notification_id/dedup_key не отправляет
  второй раз — возвращает текущий статус.
- `POST /internal/v1/notifications:dispatch` — n8n каждые 5 мин (`Authorization: Bearer <SCHEDULER_TOKEN>`):
  обработка записей с scheduled_for ≤ now (отложенные тихими часами, окном детей, слотом пропуска; повторы).
  Повтор вызова безопасен: захват SKIP LOCKED + аренда, bot-gateway идемпотентен по notification_id.
  Попутно — срок хранения журнала (90 дней).
"""

from __future__ import annotations

import asyncio
import hmac
import logging
from collections import Counter
from datetime import UTC, datetime, timedelta
from typing import cast

from fastapi import APIRouter, Depends, Request

from tilhero_common.app import Runtime, get_runtime
from tilhero_common.errors import unauthorized, unprocessable
from tilhero_common.internal_auth import HEADER, InternalAuth, Principal
from tilhero_notifications import store
from tilhero_notifications.schemas import DispatchOut, TransactionalIn, TransactionalOut
from tilhero_notifications.settings import Settings
from tilhero_notifications.templates import TEMPLATES, TemplateError

log = logging.getLogger("tilhero.notifications.api")
router = APIRouter(prefix="/internal/v1/notifications", tags=["internal"])
scheduler_router = APIRouter(tags=["internal"])
identity_only = InternalAuth({"identity-consent"})
no_service = InternalAuth(set())  # внутренний JWT любого сервиса → 403 CALLER_NOT_ALLOWED

# Статус журнала → ответ транзакционной отправки (контракт identity-consent: sent | queued | failed | skipped)
TX_STATUS = {"scheduled": "queued", "sent": "sent", "failed": "failed", "skipped": "skipped", "in_app_only": "failed"}


@router.post("/transactional", response_model=TransactionalOut)
async def transactional(
    body: TransactionalIn,
    request: Request,
    _: Principal = Depends(identity_only),
    rt: Runtime = Depends(get_runtime),
) -> TransactionalOut:
    settings = cast(Settings, rt.settings)
    try:
        TEMPLATES[body.template].validate(body.params)
    except TemplateError:
        raise unprocessable("NOTIFICATION_PARAMS_INVALID", "Некорректные параметры шаблона") from None
    accept = request.app.state.accept
    async with rt.transaction() as session:
        outcome = await accept(
            session,
            None,
            notification_id=body.notification_id,
            user_id=body.user_id,
            kind="transactional",
            template=body.template,
            params=body.params,
            dedup_key=body.dedup_key,
            direct=True,
        )
    if outcome == "skipped":
        return TransactionalOut(notification_id=body.notification_id, status="skipped", reason="user_deleted")
    if outcome == "scheduled":
        dispatcher = request.app.state.dispatcher
        try:
            await asyncio.wait_for(
                dispatcher.send_now(body.notification_id), timeout=settings.transactional_send_timeout_seconds
            )
        except TimeoutError:
            log.warning("transactional send timed out, left for dispatcher")
    async with rt.transaction() as session:
        found = await store.find(session, notification_id=body.notification_id, dedup_key=body.dedup_key)
    if found is None:  # удалено параллельной обработкой удаления пользователя
        return TransactionalOut(notification_id=body.notification_id, status="skipped", reason="user_deleted")
    nid, _user, status, reason = found
    return TransactionalOut(notification_id=nid, status=TX_STATUS[status], reason=reason)  # type: ignore[arg-type]


async def scheduler_only(request: Request) -> str:
    """`Authorization: Bearer <SCHEDULER_TOKEN>` (n8n): сравнение за постоянное время; пустой токен в настройках
    выключает вход. Внутренний JWT сервиса → 403 (вызывающий — только планировщик). Токен не логируется."""
    settings = cast(Settings, request.app.state.runtime.settings)
    expected = settings.scheduler_token.get_secret_value()
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
    log.warning(
        "scheduler auth rejected",
        extra={"reason": "SCHEDULER_TOKEN_INVALID" if expected else "SCHEDULER_AUTH_DISABLED"},
    )
    raise unauthorized("SCHEDULER_TOKEN_INVALID", "Неверный токен планировщика")


@scheduler_router.post("/internal/v1/notifications:dispatch", response_model=DispatchOut)
async def dispatch(
    request: Request, _: str = Depends(scheduler_only), rt: Runtime = Depends(get_runtime)
) -> DispatchOut:
    settings = cast(Settings, rt.settings)
    dispatcher = request.app.state.dispatcher
    totals: Counter[str] = Counter()
    for _batch in range(settings.dispatch_max_batches_per_call):
        outcomes = await dispatcher.run_once()
        totals.update(outcomes)
        if sum(outcomes.values()) < settings.dispatch_batch_size:
            break
    now = datetime.now(UTC)
    async with rt.transaction() as session:
        purged = await store.purge_expired(session, before=now - timedelta(days=settings.retention_days))
    if purged:
        log.info("notifications retention purge", extra={"purged": purged})
    return DispatchOut(
        sent=totals["sent"], scheduled=totals["scheduled"], in_app_only=totals["in_app_only"], failed=totals["failed"]
    )
