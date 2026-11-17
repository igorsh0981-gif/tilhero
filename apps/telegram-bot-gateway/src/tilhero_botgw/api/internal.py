"""POST /internal/v1/messages — доставка сообщения в Telegram (вызывает только notifications).

Идемпотентность по idempotency_key (Redis 24 ч): повтор возвращает тот же message_id, Telegram не вызывается.
Ошибки Telegram: 429 → 429 TELEGRAM_RATE_LIMITED {retry_after}; 403 → 409 TELEGRAM_BLOCKED;
400 → 502 TELEGRAM_ERROR {permanent: true, reason}; прочее → 502 TELEGRAM_ERROR {permanent: false}.
"""

from __future__ import annotations

import logging
from typing import Any, cast

from fastapi import APIRouter, Depends, Request, Response

from tilhero_botgw.schemas import SendMessageIn, SendMessageOut
from tilhero_botgw.settings import Settings
from tilhero_botgw.telegram import (
    TelegramBadRequest,
    TelegramBlocked,
    TelegramClient,
    TelegramError,
    TelegramRateLimited,
)
from tilhero_botgw.texts import webapp_url
from tilhero_common.app import Runtime, get_runtime
from tilhero_common.errors import ApiError, conflict, too_many, unavailable
from tilhero_common.internal_auth import InternalAuth, Principal
from tilhero_common.redis_tools import IdempotencyStore, fingerprint

log = logging.getLogger("tilhero.botgw.messages")
router = APIRouter(prefix="/internal/v1", tags=["internal"])
notifications_only = InternalAuth({"notifications"})


def build_payload(body: SendMessageIn, miniapp_url: str) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "chat_id": body.telegram_user_id,
        "text": body.text,
        "parse_mode": "HTML",
        "disable_notification": body.disable_notification,
        "link_preview_options": {"is_disabled": True},
    }
    if body.buttons:
        payload["reply_markup"] = {
            "inline_keyboard": [
                [
                    {"text": b.text, "web_app": {"url": webapp_url(miniapp_url, b.startapp)}}
                    if b.startapp
                    else {"text": b.text, "url": b.url}
                    for b in row
                ]
                for row in body.buttons
            ]
        }
    return payload


@router.post("/messages", response_model=SendMessageOut)
async def send_message(
    body: SendMessageIn,
    request: Request,
    response: Response,
    principal: Principal = Depends(notifications_only),
    rt: Runtime = Depends(get_runtime),
) -> dict[str, Any]:
    settings = cast(Settings, rt.settings)
    telegram: TelegramClient = request.app.state.telegram
    if rt.redis is None:  # без хранилища идемпотентности не отправляем (возможен дубль сообщения)
        raise unavailable("IDEMPOTENCY_UNAVAILABLE", "Сервис временно недоступен")
    store = IdempotencyStore(
        rt.redis,
        f"{settings.redis_key_prefix}:messages",
        ttl_seconds=settings.message_idempotency_ttl_seconds,
    )
    request_fp = fingerprint(body.model_dump(mode="json", exclude={"idempotency_key"}))
    try:
        stored = await store.begin(principal.issuer, body.idempotency_key, request_fp)
    except ApiError:
        raise
    except Exception as exc:
        log.warning("idempotency store unavailable", extra={"error_type": type(exc).__name__})
        raise unavailable("IDEMPOTENCY_UNAVAILABLE", "Сервис временно недоступен") from None
    if stored is not None:
        response.headers["Idempotent-Replayed"] = "true"
        return stored

    try:
        result = await telegram.call("sendMessage", build_payload(body, settings.miniapp_url))
    except TelegramError as exc:
        await store.abort(principal.issuer, body.idempotency_key)
        log.info(
            "telegram send failed", extra={"telegram_status": exc.status, "error_type": type(exc).__name__}
        )
        if isinstance(exc, TelegramRateLimited):
            raise too_many(
                "TELEGRAM_RATE_LIMITED", "Telegram ограничил частоту отправки", exc.retry_after
            ) from None
        if isinstance(exc, TelegramBlocked):
            raise conflict("TELEGRAM_BLOCKED", "Пользователь заблокировал бота") from None
        if isinstance(exc, TelegramBadRequest):
            raise ApiError(
                502,
                "TELEGRAM_ERROR",
                "Telegram отклонил сообщение",
                {"telegram_status": 400, "reason": exc.reason, "permanent": True},
            ) from None
        raise ApiError(
            502, "TELEGRAM_ERROR", "Telegram недоступен", {"telegram_status": exc.status, "permanent": False}
        ) from None
    except BaseException:
        await store.abort(principal.issuer, body.idempotency_key)
        raise
    try:
        out = {"message_id": int(result["message_id"])}
    except (TypeError, KeyError, ValueError):
        await store.abort(principal.issuer, body.idempotency_key)
        raise ApiError(502, "TELEGRAM_ERROR", "Неожиданный ответ Telegram", {"permanent": False}) from None
    await store.complete(principal.issuer, body.idempotency_key, request_fp, out)
    return out
