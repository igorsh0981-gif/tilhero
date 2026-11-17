"""POST /internal/v1/notifications/transactional — синхронная доставка секретных транзакционных сообщений
(код сброса PIN) в обход шины (ревью спринта 1, P2): код не попадает ни в outbox identity-consent, ни в JetStream.

Вызывает только identity-consent. Уведомление записывается в журнал и сразу отправляется; временная ошибка
доставки оставляет его в очереди с повтором (status=queued), конечный статус очищает params (CHECK в БД).
Повтор с тем же notification_id/dedup_key не отправляет второй раз — возвращает текущий статус.
"""

from __future__ import annotations

import asyncio
import hmac
import logging
import uuid
from typing import Annotated, Any, Literal, cast

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict, Field

from tilhero_common.app import Runtime, get_runtime
from tilhero_common.errors import unauthorized, unprocessable
from tilhero_common.internal_auth import HEADER, InternalAuth, Principal
from tilhero_notifications import store
from tilhero_notifications.settings import Settings
from tilhero_notifications.templates import DIRECT_TEMPLATES, TEMPLATES, TemplateError

log = logging.getLogger("tilhero.notifications.api")
router = APIRouter(prefix="/internal/v1/notifications", tags=["internal"])
scheduler_router = APIRouter(tags=["internal"])
identity_only = InternalAuth({"identity-consent"})
no_service = InternalAuth(set())  # внутренний JWT любого сервиса → 403 CALLER_NOT_ALLOWED


class TransactionalIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    notification_id: uuid.UUID
    user_id: uuid.UUID
    template: Literal["pin.reset_code"]
    params: dict[str, Any]
    dedup_key: Annotated[str, Field(min_length=1, max_length=200)]


class TransactionalOut(BaseModel):
    notification_id: uuid.UUID
    status: Literal["queued", "sent", "failed", "skipped"]
    reason: str | None = None


if set(TransactionalIn.model_fields["template"].annotation.__args__) != set(DIRECT_TEMPLATES):  # type: ignore[union-attr]
    raise RuntimeError("TransactionalIn.template must list exactly the direct-only templates")


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
    enqueue = request.app.state.enqueue
    async with rt.transaction() as session:
        outcome = await enqueue(
            session,
            None,
            notification_id=body.notification_id,
            user_id=body.user_id,
            kind="transactional",
            template=body.template,
            params=body.params,
            dedup_key=body.dedup_key,
            startapp=None,
            direct=True,
        )
    if outcome == "skipped":
        return TransactionalOut(notification_id=body.notification_id, status="skipped", reason="user_deleted")
    if outcome == "queued":
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
    status = "queued" if status == "scheduled" else status
    return TransactionalOut(notification_id=nid, status=status, reason=reason)  # type: ignore[arg-type]


# ---------------------------------------------------------------- дайджест (спринт 6, §5)


class DigestRunOut(BaseModel):
    users: int
    digests: int
    items: int
    postponed: int
    errors: int


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


@scheduler_router.post("/internal/v1/notifications:digest", response_model=DigestRunOut)
async def run_digest(request: Request, _: str = Depends(scheduler_only)) -> DigestRunOut:
    """Собрать дайджесты пользователей, у которых наступило digest_time (n8n каждые 15 мин). Идемпотентно:
    повтор в тот же локальный день не создаёт второго дайджеста."""
    result = await request.app.state.digest.run()
    return DigestRunOut(**vars(result))
