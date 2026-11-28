"""POST /telegram/webhook — вход Telegram (единственный публичный эндпоинт сервиса, INTERNAL_API §8).

Порядок: секрет (hmac.compare_digest, иначе 401) → размер/JSON → идемпотентность update_id
(Redis SET NX 48 ч) → маршрутизация → ответ методом Bot API в теле ответа.
Ответ ≤ 1 с: Redis с таймаутом, сеть — только фоном.

Спринт 8, Telegram Stars (INTERNAL_API спринта 8 §2) — платёжные обновления исключение из «≤ 1 с без исходящих»:
- `pre_checkout_query` — без отметки update_id: identity-consent → billing → `answerPreCheckoutQuery` в теле ответа
  (≤ 2 + 3 с; любая ошибка — `ok: false` с текстом);
- `successful_payment`, `refunded_payment`, `subscription` — ключ update_id сначала «в обработке» (SET NX, 60 с), после
  2xx billing — «готово» (48 ч); иначе ключ снимается и ответ 503 — Telegram повторит (≤ 9 с на обновление).
"""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
from typing import Any, cast

from fastapi import APIRouter, BackgroundTasks, Depends, Request
from fastapi.responses import JSONResponse

from tilhero_botgw import stars
from tilhero_botgw.bot import route_update
from tilhero_botgw.settings import Settings
from tilhero_common.app import Runtime, get_runtime
from tilhero_common.errors import ApiError, bad_request, unauthorized, unavailable
from tilhero_common.http_client import UpstreamError
from tilhero_common.redis_tools import rate_limit

log = logging.getLogger("tilhero.botgw.webhook")
router = APIRouter(tags=["telegram"])
SECRET_HEADER = "x-telegram-bot-api-secret-token"  # noqa: S105 - имя заголовка, не секрет


def _settings(rt: Runtime) -> Settings:
    return cast(Settings, rt.settings)


# Update Telegram — несколько уровней вложенности (message → reply_to_message → entities …); всё, что глубже, —
# испорченный или враждебный update (SEC9-04): дальше по коду его не обходим
MAX_UPDATE_DEPTH = 32


def _too_deep(value: Any, limit: int) -> bool:
    """Итеративно (без рекурсии): вложенность dict/list больше `limit`."""
    stack: list[tuple[Any, int]] = [(value, 1)]
    while stack:
        v, depth = stack.pop()
        if isinstance(v, dict | list):
            if depth > limit:
                return True
            stack.extend((x, depth + 1) for x in (v.values() if isinstance(v, dict) else v))
    return False


@router.post("/telegram/webhook")
async def webhook(
    request: Request, background: BackgroundTasks, rt: Runtime = Depends(get_runtime)
) -> JSONResponse:
    settings = _settings(rt)
    expected = settings.telegram_webhook_secret.get_secret_value()
    provided = request.headers.get(SECRET_HEADER, "")
    # Пустой секрет в настройках — закрыто для всех (fail closed)
    if not expected or not hmac.compare_digest(provided.encode(), expected.encode()):
        raise unauthorized("WEBHOOK_UNAUTHORIZED", "Неверный секрет webhook")

    raw = await request.body()
    if len(raw) > settings.max_update_bytes:
        raise ApiError(413, "WEBHOOK_PAYLOAD_TOO_LARGE", "Слишком большой update")
    try:
        update: Any = json.loads(raw)
    except (ValueError, RecursionError):  # SEC9-04: вложенность глубже стека разбора — 400, а не 500
        raise bad_request("WEBHOOK_INVALID", "Некорректный update") from None
    if _too_deep(update, MAX_UPDATE_DEPTH):
        raise bad_request("WEBHOOK_INVALID", "Некорректный update")
    if not isinstance(update, dict) or not isinstance(update.get("update_id"), int):
        raise bad_request("WEBHOOK_INVALID", "Некорректный update")

    kind = stars.classify(update)
    if kind == "pre_checkout":
        # ответ — в теле webhook; повтор доставки отвечается заново (billing хранит ответ по query_id)
        reply = await stars.answer_pre_checkout(rt, settings, update["pre_checkout_query"])
        return JSONResponse(reply if reply is not None else {"ok": True})

    if rt.redis is None:  # REDIS_URL обязателен (Settings); без дедупликации не обрабатываем
        raise unavailable("WEBHOOK_UNAVAILABLE", "Сервис временно недоступен")
    if kind is not None:
        return await _payment_update(rt, settings, update, kind)
    key = f"{settings.redis_key_prefix}:update:{update['update_id']}"
    try:
        fresh = await asyncio.wait_for(
            rt.redis.set(key, "1", nx=True, ex=settings.update_ttl_seconds), settings.redis_timeout_seconds
        )
    except Exception as exc:
        # Без дедупликации не обрабатываем: Telegram повторит доставку позже
        log.warning("update dedup unavailable", extra={"error_type": type(exc).__name__})
        raise unavailable("WEBHOOK_UNAVAILABLE", "Сервис временно недоступен") from None
    if not fresh:
        return JSONResponse({"ok": True})

    action = route_update(update, settings.miniapp_url, settings.telegram_app_link, settings.terms_url)
    if action.bot_status is not None:
        telegram_user_id, blocked = action.bot_status
        background.add_task(report_bot_status, rt, telegram_user_id, blocked)
    if action.reply is None:
        return JSONResponse({"ok": True})
    if action.chat_id is not None and not await _chat_allowed(rt, settings, action.chat_id):
        return JSONResponse({"ok": True})  # анти-спам: молча не отвечаем
    return JSONResponse(action.reply)


UPDATE_PROCESSING = "processing"
UPDATE_DONE = "1"  # как у прочих обновлений


async def _payment_update(rt: Runtime, settings: Settings, update: dict[str, Any], kind: stars.UpdateKind
                          ) -> JSONResponse:
    """successful_payment / refunded_payment / subscription: отметка update_id — только после 2xx billing (R4)."""
    assert rt.redis is not None
    redis = rt.redis
    key = f"{settings.redis_key_prefix}:update:{update['update_id']}"
    timeout = settings.redis_timeout_seconds
    try:
        claimed = await asyncio.wait_for(
            redis.set(key, UPDATE_PROCESSING, nx=True, ex=settings.stars_processing_ttl_seconds), timeout)
        state = None if claimed else await asyncio.wait_for(redis.get(key), timeout)
    except Exception as exc:
        log.warning("update dedup unavailable", extra={"error_type": type(exc).__name__})
        raise unavailable("WEBHOOK_UNAVAILABLE", "Сервис временно недоступен") from None
    if not claimed:
        if state == UPDATE_DONE:
            return JSONResponse({"ok": True})  # уже передано billing
        # параллельная доставка ещё обрабатывается (или ключ только что истёк) — Telegram повторит
        raise unavailable("WEBHOOK_UNAVAILABLE", "Обновление обрабатывается")
    try:
        delivered = await stars.forward_update(rt, settings, kind, update)
    except Exception as exc:
        log.error("stars update failed", extra={"update_kind": kind, "error_type": type(exc).__name__})
        delivered = False
    if delivered:
        try:
            await asyncio.wait_for(redis.set(key, UPDATE_DONE, ex=settings.update_ttl_seconds), timeout)
        except Exception as exc:  # billing идемпотентен по charge id: повтор без отметки не зачислит дважды
            log.warning("update mark failed", extra={"error_type": type(exc).__name__})
        return JSONResponse({"ok": True})
    try:
        await asyncio.wait_for(redis.delete(key), timeout)
    except Exception as exc:  # ключ «в обработке» истечёт сам (STARS_PROCESSING_TTL_SECONDS)
        log.warning("update unmark failed", extra={"error_type": type(exc).__name__})
    raise unavailable("WEBHOOK_UNAVAILABLE", "Сервис временно недоступен")


async def _chat_allowed(rt: Runtime, settings: Settings, chat_id: int) -> bool:
    if rt.redis is None:
        return True
    try:
        result = await asyncio.wait_for(
            rate_limit(
                rt.redis, f"{settings.redis_key_prefix}:chat:{chat_id}", settings.chat_replies_per_minute, 60
            ),
            settings.redis_timeout_seconds,
        )
    except Exception:
        return True  # лимит — защита от спама, не повод молчать при деградации Redis
    return result.allowed


async def report_bot_status(rt: Runtime, telegram_user_id: int, blocked: bool, attempts: int = 3) -> None:
    """Блокировка бота выключает уведомления (identity-consent). Повтор безопасен — операция идемпотентна."""
    client = rt.client("identity-consent")
    for attempt in range(1, attempts + 1):
        try:
            await client.post(
                f"/internal/v1/telegram-users/{telegram_user_id}/bot-status", json={"blocked": blocked}
            )
            return
        except UpstreamError as exc:
            if 400 <= exc.status < 500 and exc.status not in (408, 429):
                log.warning("bot status rejected", extra={"status": exc.status, "error_code": exc.code})
                return
            if attempt < attempts:
                await asyncio.sleep(0.5 * 2 ** (attempt - 1))
    log.error("bot status report failed", extra={"blocked": blocked})
