"""Синхронные вызовы billing (INTERNAL_API спринта 8 §0.3) — имена клиентов Runtime (aud внутреннего JWT).

- identity-consent: `GET /internal/v1/export/profiles` — начальная загрузка проекции learners (в фоне, повтор tick'ом);
- gamification: `GET /internal/v1/game/purchases/by-order/{order_id}` — пред-проверка возврата тилов (5 с);
- telegram-bot-gateway (внутренний порт 8108): `/internal/v1/stars/*` — ссылка на счёт, возврат, автопродление,
  выписка (5 с; недоступен → 503 STARS_UNAVAILABLE). Telegram ID в billing не попадает: bot-gateway сам переводит
  account_id ↔ Telegram ID через identity-consent.

Ядро (поток A) вызывает сам только `stars/subscriptions/edit` (автопродление из Mini App, отмена при возврате и в саге)
— ссылки на счёт, возвраты и выписку вызывает адаптер Stars (поток G). Вне транзакций БД; в логи — только тип ошибки и
статус (без тел, подписей и Telegram ID).
"""

from __future__ import annotations

import logging
import uuid
from typing import Any, Final

from tilhero_common.app import Runtime
from tilhero_common.http_client import UpstreamError

log = logging.getLogger("tilhero.billing.clients")

IDENTITY: Final = "identity-consent"
GAMIFICATION: Final = "gamification"
BOTGW: Final = "telegram-bot-gateway"


class StarsGatewayError(Exception):
    """bot-gateway недоступен или отказал; `code` — бизнес-код ответа (STARS_PAYER_UNKNOWN, TELEGRAM_ERROR, …)."""

    def __init__(self, code: str, status: int | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.status = status


async def edit_star_subscription(rt: Runtime, account_id: uuid.UUID, first_charge_id: str, *,
                                 is_canceled: bool) -> None:
    """bot-gateway `POST /internal/v1/stars/subscriptions/edit` → editUserStarSubscription (вкл./выкл. автопродления).
    Идемпотентно для Telegram (повтор — то же состояние); Idempotency-Key — по подписке и состоянию."""
    body = {"account_id": str(account_id), "telegram_payment_charge_id": first_charge_id,
            "is_canceled": is_canceled}
    try:
        await rt.client(BOTGW).post("/internal/v1/stars/subscriptions/edit", json=body,
                                    idempotency_key=f"stars-edit:{first_charge_id[:80]}:{int(is_canceled)}")
    except UpstreamError as exc:
        log.warning("bot-gateway stars edit failed", extra={"status": exc.status, "error_type": type(exc).__name__})
        raise StarsGatewayError(exc.code if exc.status < 500 else "STARS_UNAVAILABLE", exc.status) from None
    except Exception as exc:
        log.warning("bot-gateway stars edit failed", extra={"error_type": type(exc).__name__})
        raise StarsGatewayError("STARS_UNAVAILABLE") from None


async def purchase_by_order(rt: Runtime, order_id: uuid.UUID) -> dict[str, Any] | None:
    """gamification by-order → {order_id, credited, til, til_balance, status}; None — 404 PURCHASE_NOT_FOUND.
    Иной сбой — UpstreamError (вызывающий решает: 503 или force)."""
    try:
        data = await rt.client(GAMIFICATION).get(f"/internal/v1/game/purchases/by-order/{order_id}")
    except UpstreamError as exc:
        if exc.status == 404:
            return None
        raise
    if not isinstance(data, dict):
        raise UpstreamError(502, "UPSTREAM_ERROR", "gamification: malformed", service=GAMIFICATION)
    return data


async def export_profiles(rt: Runtime, cursor: str | None, limit: int) -> tuple[list[dict[str, Any]], str | None]:
    """Страница выгрузки identity-consent `profiles` (+ guardian_user_id). Сбой или неверная форма — исключение."""
    params: dict[str, Any] = {"limit": limit}
    if cursor:
        params["cursor"] = cursor
    data = await rt.client(IDENTITY).get("/internal/v1/export/profiles", params=params)
    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        raise ValueError("export profiles: malformed page")
    nxt = data.get("next_cursor")
    if nxt is not None and (not isinstance(nxt, str) or not nxt or len(nxt) > 500):
        raise ValueError("export profiles: malformed cursor")
    return [i for i in data["items"] if isinstance(i, dict)], nxt
