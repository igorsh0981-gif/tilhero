"""POST /internal/v1/ops-messages — оповещение в чат операторов (спринт 8, INTERNAL_API §6).

Вызывает только notifications.

Чат — только из env `OPS_ALERT_CHAT_ID`, вызывающий его не выбирает. Текст — обычный (без parse_mode: разметка
не интерпретируется, экранировать нечего). Кнопка — https-ссылка только на домен `ADMIN_WEB_URL`.
Идемпотентность по `dedup_key` (Redis 24 ч): повтор возвращает тот же message_id, Telegram не вызывается.
Спринт 9 (Q10): Redis недоступен → дедупликация и лимит в памяти процесса (`local_guard.py`), отправка не блокируется.
Ошибки: чат не задан → 409 OPS_CHAT_NOT_CONFIGURED; сверх OPS_MESSAGES_PER_MINUTE → 429 RATE_LIMITED;
бот исключён / чат не найден → 409 OPS_CHAT_UNAVAILABLE + WARNING; 429 Telegram → 429 TELEGRAM_RATE_LIMITED;
прочее → 502 TELEGRAM_ERROR. В логах — только коды и статусы, ни текста, ни id чата.
"""

from __future__ import annotations

import logging
from typing import Any, cast
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, Request, Response

from tilhero_botgw.local_guard import OpsLocalGuard
from tilhero_botgw.schemas import OpsMessageIn, SendMessageOut
from tilhero_botgw.settings import Settings
from tilhero_botgw.telegram import (
    TelegramBadRequest,
    TelegramBlocked,
    TelegramClient,
    TelegramError,
    TelegramRateLimited,
)
from tilhero_common.app import Runtime, get_runtime
from tilhero_common.errors import ApiError, conflict, too_many, unprocessable
from tilhero_common.internal_auth import InternalAuth, Principal
from tilhero_common.links import runbook_url_allowed
from tilhero_common.redis_tools import IdempotencyStore, fingerprint, rate_limit

log = logging.getLogger("tilhero.botgw.ops")
router = APIRouter(prefix="/internal/v1", tags=["internal"])
notifications_only = InternalAuth({"notifications"})


def _chat_unavailable(exc: TelegramError) -> bool:
    """Бот исключён из группы (403), чат не найден или группа стала супергруппой (новый id):
    нужен новый OPS_ALERT_CHAT_ID или вернуть бота."""
    if isinstance(exc, TelegramBlocked):
        return True
    if isinstance(exc, TelegramBadRequest):
        return exc.reason == "chat_not_found" or "upgraded" in exc.description.lower()
    return False


def build_ops_payload(
    chat_id: int, body: OpsMessageIn, with_button: bool, with_runbook: bool = False
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "chat_id": chat_id,
        "text": body.text,
        "link_preview_options": {"is_disabled": True},
    }
    row = []
    if with_button and body.button is not None:
        row.append({"text": body.button.text, "url": body.button.url})
    if with_runbook and body.runbook_button is not None:
        row.append({"text": body.runbook_button.text, "url": body.runbook_button.url})
    if row:
        payload["reply_markup"] = {"inline_keyboard": [row]}
    return payload


def _local_guard(request: Request, settings: Settings) -> OpsLocalGuard:
    guard: OpsLocalGuard | None = getattr(request.app.state, "ops_local_guard", None)
    if guard is None:
        guard = OpsLocalGuard(settings.message_idempotency_ttl_seconds, settings.ops_messages_per_minute)
        request.app.state.ops_local_guard = guard
    return guard


@router.post("/ops-messages", response_model=SendMessageOut)
async def send_ops_message(
    body: OpsMessageIn,
    request: Request,
    response: Response,
    principal: Principal = Depends(notifications_only),
    rt: Runtime = Depends(get_runtime),
) -> dict[str, Any]:
    settings = cast(Settings, rt.settings)
    chat_id = settings.ops_alert_chat_id
    if chat_id is None:
        raise conflict("OPS_CHAT_NOT_CONFIGURED", "Чат операторов не настроен (OPS_ALERT_CHAT_ID)")
    with_button = body.button is not None
    if body.button is not None:
        host = settings.admin_web_host
        if host is None:
            # ADMIN_WEB_URL не задан (или не https): оповещение важнее кнопки — отправляем без неё
            log.warning("ops button dropped: ADMIN_WEB_URL is not configured")
            with_button = False
        elif (urlsplit(body.button.url).hostname or "").lower() != host:
            raise unprocessable("VALIDATION_ERROR", "Кнопка: ссылка только на домен ADMIN_WEB_URL")
    with_runbook = False
    if body.runbook_button is not None:
        base = settings.runbook_base_url
        # SEC9-06: разбор URL (схема, хост, нормализованный путь внутри раздела), а не префикс строки
        if not runbook_url_allowed(body.runbook_button.url, base):
            raise unprocessable("VALIDATION_ERROR", "Кнопка Runbook: ссылка только на раздел RUNBOOK_BASE_URL")
        with_runbook = True
    request_fp = fingerprint(body.model_dump(mode="json", exclude={"dedup_key"}))
    local = _local_guard(request, settings)
    # отправлено в память во время простоя Redis — повтор того же оповещения не дублирует сообщение
    stored = local.idem.done(principal.issuer, body.dedup_key, request_fp)
    if stored is not None:
        response.headers["Idempotent-Replayed"] = "true"
        return stored
    store = IdempotencyStore(
        rt.redis, f"{settings.redis_key_prefix}:ops-messages", ttl_seconds=settings.message_idempotency_ttl_seconds
    ) if rt.redis is not None else None
    in_memory = store is None
    if store is not None:
        try:
            stored = await store.begin(principal.issuer, body.dedup_key, request_fp)
        except ApiError:
            raise
        except Exception as exc:
            log.warning("idempotency store unavailable, in-process dedup", extra={"error_type": type(exc).__name__})
            in_memory = True
    if in_memory:
        stored = local.idem.begin(principal.issuer, body.dedup_key, request_fp)
    if stored is not None:
        response.headers["Idempotent-Replayed"] = "true"
        return stored

    async def abort() -> None:
        if in_memory or store is None:
            local.idem.abort(principal.issuer, body.dedup_key)
            return
        try:
            await store.abort(principal.issuer, body.dedup_key)
        except Exception as exc:  # Redis пропал посреди запроса: ключ истечёт сам (60 с)
            log.warning("idempotency abort failed", extra={"error_type": type(exc).__name__})

    allowed, reset = True, 1
    if not in_memory and rt.redis is not None:
        try:
            limit = await rate_limit(
                rt.redis, f"{settings.redis_key_prefix}:ops:minute", settings.ops_messages_per_minute, 60
            )
            allowed, reset = limit.allowed, limit.reset_seconds
        except Exception as exc:  # лимит защищает от бана Telegram — без Redis считаем в памяти процесса
            log.warning("ops rate limit unavailable, in-process limit", extra={"error_type": type(exc).__name__})
            allowed, reset = local.limit.hit()
    else:
        allowed, reset = local.limit.hit()
    if not allowed:
        await abort()
        raise too_many("RATE_LIMITED", "Слишком много оповещений в минуту", max(reset, 1))

    telegram: TelegramClient = request.app.state.telegram
    try:
        result = await telegram.call("sendMessage", build_ops_payload(chat_id, body, with_button, with_runbook))
    except TelegramError as exc:
        await abort()
        if _chat_unavailable(exc):
            log.warning(
                "ops chat unavailable: check OPS_ALERT_CHAT_ID and bot membership",
                extra={"telegram_status": exc.status, "error_type": type(exc).__name__},
            )
            raise conflict("OPS_CHAT_UNAVAILABLE", "Чат операторов недоступен для бота") from None
        log.info("ops send failed", extra={"telegram_status": exc.status, "error_type": type(exc).__name__})
        if isinstance(exc, TelegramRateLimited):
            raise too_many(
                "TELEGRAM_RATE_LIMITED", "Telegram ограничил частоту отправки", exc.retry_after
            ) from None
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
        await abort()
        raise
    try:
        out = {"message_id": int(result["message_id"])}
    except (TypeError, KeyError, ValueError):
        await abort()
        raise ApiError(502, "TELEGRAM_ERROR", "Неожиданный ответ Telegram", {"permanent": False}) from None
    if in_memory or store is None:
        local.idem.complete(principal.issuer, body.dedup_key, request_fp, out)
        return out
    try:
        await store.complete(principal.issuer, body.dedup_key, request_fp, out)
    except Exception as exc:  # сообщение уже ушло — запоминаем в памяти, чтобы повтор его не продублировал
        log.warning("idempotency complete failed, kept in process", extra={"error_type": type(exc).__name__})
        local.idem.complete(principal.issuer, body.dedup_key, request_fp, out)
    return out
