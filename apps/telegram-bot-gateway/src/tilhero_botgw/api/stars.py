"""Внутренний API Telegram Stars для billing (INTERNAL_API спринта 8 §2) — только `INTERNAL_PORT`, внутренний JWT
`iss=billing` (notifications сюда не допускается: ей — только `/messages`). Токен бота остаётся здесь: billing вызывает
Bot API только через эти маршруты.

- `POST /internal/v1/stars/invoice-links` → `createInvoiceLink` (XTR, `provider_token: ""`, одна позиция;
  `subscription_period` 2592000 — только для подписки ≤ 10 000 Stars) → `{invoice_link}`; идемпотентность по
  `order_id` (Redis 24 ч);
- `POST /internal/v1/stars/refunds` → identity-consent (аккаунт → Telegram ID) → `refundStarPayment` → `{ok}`; уже
  возвращён — `{ok, already: true}`; нет Telegram ID — 409 `STARS_PAYER_UNKNOWN`;
- `POST /internal/v1/stars/subscriptions/edit` → identity-consent → `editUserStarSubscription` → `{ok}`; 409
  `STARS_PAYER_UNKNOWN`;
- `GET /internal/v1/stars/transactions?offset&limit` → `getStarTransactions` → `{items, count}` без данных
  пользователя; `count` — размер страницы Telegram до отбора (по нему billing листает выписку).

Ошибки Telegram: 502 `TELEGRAM_ERROR {permanent}` (400/403 — постоянная; 429, 5xx, сеть — временная), identity-consent
недоступен — 503 `UPSTREAM_UNAVAILABLE`. Telegram ID — только в памяти запроса; в логах — без Telegram ID и charge id.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request, Response
from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StrictBool, StrictInt, model_validator

from tilhero_botgw.settings import Settings
from tilhero_botgw.stars import charge_ref
from tilhero_botgw.telegram import (
    TelegramBadRequest,
    TelegramBlocked,
    TelegramClient,
    TelegramError,
    TelegramRateLimited,
)
from tilhero_common.app import Runtime, get_runtime
from tilhero_common.errors import ApiError, conflict, unavailable
from tilhero_common.http_client import UpstreamError
from tilhero_common.internal_auth import InternalAuth, Principal
from tilhero_common.redis_tools import IdempotencyStore, fingerprint

log = logging.getLogger("tilhero.botgw.stars.api")
router = APIRouter(prefix="/internal/v1/stars", tags=["stars"])
billing_only = InternalAuth({"billing"})

CURRENCY = "XTR"
SUBSCRIPTION_PERIOD = 2_592_000  # Bot API: сейчас единственное допустимое значение (30 дней)
SUBSCRIPTION_MAX_PRICE = 10_000  # Bot API: цена подписки ≤ 10 000 Stars
INVOICE_LINK_PREFIX = "https://t.me/"
# refundStarPayment повторно: Telegram отвечает 400 с этим описанием (практика; в документации Bot API не описано —
# §14, проверить в тестовой среде S5). Совпадение — «уже возвращён», ответ {ok, already}
ALREADY_REFUNDED_MARKERS = ("CHARGE_ALREADY_REFUNDED",)
IDENTITY_TELEGRAM_USER = "/internal/v1/accounts/{account_id}/telegram-user"


def _payload_bytes(value: str) -> str:
    if len(value.encode()) > 128:
        raise ValueError("payload длиннее 128 байт")
    return value


class _In(BaseModel):
    model_config = ConfigDict(extra="forbid")


class InvoiceLinkIn(_In):
    order_id: UUID
    title: Annotated[str, Field(min_length=1, max_length=32)]
    description: Annotated[str, Field(min_length=1, max_length=255)]
    payload: Annotated[str, Field(min_length=1, max_length=128), AfterValidator(_payload_bytes)]
    amount_stars: Annotated[StrictInt, Field(ge=1, le=100_000)]
    subscription_period: Annotated[StrictInt, Field(ge=SUBSCRIPTION_PERIOD, le=SUBSCRIPTION_PERIOD)] | None = None

    @model_validator(mode="after")
    def _subscription_price(self) -> InvoiceLinkIn:
        if self.subscription_period is not None and self.amount_stars > SUBSCRIPTION_MAX_PRICE:
            raise ValueError("цена подписки Stars — не больше 10 000")
        return self


class InvoiceLinkOut(BaseModel):
    invoice_link: str


ChargeId = Annotated[str, Field(min_length=1, max_length=128)]


class RefundIn(_In):
    account_id: UUID
    telegram_payment_charge_id: ChargeId


class SubscriptionEditIn(_In):
    account_id: UUID
    telegram_payment_charge_id: ChargeId
    is_canceled: StrictBool


class OkOut(BaseModel):
    ok: bool
    already: bool | None = None


def _settings(rt: Runtime) -> Settings:
    return cast(Settings, rt.settings)


def _telegram_error(exc: TelegramError) -> ApiError:
    """Ошибка Bot API → 502 TELEGRAM_ERROR {permanent}: 400/403 повтор не исправит; 429, 5xx, сеть — временные."""
    details: dict[str, Any] = {"telegram_status": exc.status}
    if isinstance(exc, TelegramBadRequest):
        details.update(permanent=True, reason=exc.reason)
    elif isinstance(exc, TelegramBlocked):
        details.update(permanent=True, reason="forbidden")
    elif isinstance(exc, TelegramRateLimited):
        details.update(permanent=False, retry_after=exc.retry_after)
    else:
        details.update(permanent=False)
    return ApiError(502, "TELEGRAM_ERROR", "Telegram отклонил запрос" if details["permanent"]
                    else "Telegram недоступен", details)


async def _telegram_user(rt: Runtime, account_id: UUID) -> int:
    """Аккаунт → Telegram ID (identity-consent, только bot-gateway). Нет (удалён) — 409 STARS_PAYER_UNKNOWN."""
    settings = _settings(rt)
    try:
        result = await asyncio.wait_for(
            rt.client("identity-consent").get(IDENTITY_TELEGRAM_USER.format(account_id=account_id)),
            settings.stars_identity_timeout_seconds)
    except UpstreamError as exc:
        if exc.status == 404:
            raise conflict("STARS_PAYER_UNKNOWN", "Плательщик Telegram Stars неизвестен") from None
        log.warning("identity-consent lookup failed", extra={"status": exc.status})
        raise unavailable("UPSTREAM_UNAVAILABLE", "identity-consent недоступен") from None
    except TimeoutError:
        raise unavailable("UPSTREAM_UNAVAILABLE", "identity-consent недоступен") from None
    user_id = result.get("telegram_user_id") if isinstance(result, dict) else None
    if not isinstance(user_id, int) or isinstance(user_id, bool) or user_id <= 0:
        raise unavailable("UPSTREAM_UNAVAILABLE", "identity-consent ответил не так")
    return user_id


def _telegram(request: Request) -> TelegramClient:
    return cast(TelegramClient, request.app.state.telegram)


# ---------------------------------------------------------------- счёт

@router.post("/invoice-links", response_model=InvoiceLinkOut)
async def create_invoice_link(
    body: InvoiceLinkIn,
    request: Request,
    response: Response,
    principal: Principal = Depends(billing_only),
    rt: Runtime = Depends(get_runtime),
) -> dict[str, Any]:
    settings = _settings(rt)
    if rt.redis is None:  # без идемпотентности не выпускаем (два счёта на заказ)
        raise unavailable("IDEMPOTENCY_UNAVAILABLE", "Сервис временно недоступен")
    store = IdempotencyStore(rt.redis, f"{settings.redis_key_prefix}:stars:invoice",
                             ttl_seconds=settings.stars_invoice_idempotency_ttl_seconds)
    key = str(body.order_id)
    request_fp = fingerprint(body.model_dump(mode="json"))
    try:
        stored = await store.begin(principal.issuer, key, request_fp)
    except ApiError:
        raise
    except Exception as exc:
        log.warning("idempotency store unavailable", extra={"error_type": type(exc).__name__})
        raise unavailable("IDEMPOTENCY_UNAVAILABLE", "Сервис временно недоступен") from None
    if stored is not None:
        response.headers["Idempotent-Replayed"] = "true"
        return stored
    payload: dict[str, Any] = {
        "title": body.title,
        "description": body.description,
        "payload": body.payload,
        "provider_token": "",  # Stars: пустая строка
        "currency": CURRENCY,
        "prices": [{"label": body.title, "amount": body.amount_stars}],  # Stars: ровно одна позиция
    }
    if body.subscription_period is not None:
        payload["subscription_period"] = body.subscription_period
    try:
        link = await _telegram(request).call("createInvoiceLink", payload)
    except TelegramError as exc:
        await store.abort(principal.issuer, key)
        log.warning("createInvoiceLink failed", extra={"telegram_status": exc.status})
        raise _telegram_error(exc) from None
    except BaseException:
        await store.abort(principal.issuer, key)
        raise
    if not isinstance(link, str) or not link.startswith(INVOICE_LINK_PREFIX) or any(ch.isspace() for ch in link):
        await store.abort(principal.issuer, key)
        raise ApiError(502, "TELEGRAM_ERROR", "Неожиданный ответ Telegram", {"permanent": False})
    out = {"invoice_link": link}
    await store.complete(principal.issuer, key, request_fp, out)
    log.info("stars invoice link created", extra={"subscription": body.subscription_period is not None})
    return out


# ---------------------------------------------------------------- возврат и автопродление

@router.post("/refunds", response_model=OkOut, response_model_exclude_none=True)
async def refund_star_payment(
    body: RefundIn,
    request: Request,
    _: Principal = Depends(billing_only),
    rt: Runtime = Depends(get_runtime),
) -> dict[str, Any]:
    user_id = await _telegram_user(rt, body.account_id)
    ref = charge_ref(body.telegram_payment_charge_id)
    try:
        await _telegram(request).call("refundStarPayment", {
            "user_id": user_id, "telegram_payment_charge_id": body.telegram_payment_charge_id})
    except TelegramBadRequest as exc:
        if any(marker in exc.description.upper() for marker in ALREADY_REFUNDED_MARKERS):
            log.info("stars refund already done", extra={"charge_ref": ref})
            return {"ok": True, "already": True}
        log.warning("refundStarPayment rejected", extra={"charge_ref": ref, "reason": exc.reason})
        raise _telegram_error(exc) from None
    except TelegramError as exc:
        log.warning("refundStarPayment failed", extra={"charge_ref": ref, "telegram_status": exc.status})
        raise _telegram_error(exc) from None
    log.info("stars refund done", extra={"charge_ref": ref})
    return {"ok": True}


@router.post("/subscriptions/edit", response_model=OkOut, response_model_exclude_none=True)
async def edit_star_subscription(
    body: SubscriptionEditIn,
    request: Request,
    _: Principal = Depends(billing_only),
    rt: Runtime = Depends(get_runtime),
) -> dict[str, Any]:
    """is_canceled=true — автопродление выключено (подписка живёт до конца периода); false — снова включено."""
    user_id = await _telegram_user(rt, body.account_id)
    ref = charge_ref(body.telegram_payment_charge_id)
    try:
        await _telegram(request).call("editUserStarSubscription", {
            "user_id": user_id, "telegram_payment_charge_id": body.telegram_payment_charge_id,
            "is_canceled": body.is_canceled})
    except TelegramError as exc:
        log.warning("editUserStarSubscription failed", extra={"charge_ref": ref, "telegram_status": exc.status})
        raise _telegram_error(exc) from None
    log.info("stars subscription edited", extra={"charge_ref": ref, "is_canceled": body.is_canceled})
    return {"ok": True}


# ---------------------------------------------------------------- выписка

def statement_item(tx: Any) -> dict[str, Any] | None:
    """StarTransaction → запись выписки **без данных пользователя** (user, affiliate, gift, paid_media отбрасываются).
    direction: `in` — есть source (оплата), `out` — есть receiver (возврат, вывод)."""
    if not isinstance(tx, dict):
        return None
    tx_id, amount, date = tx.get("id"), tx.get("amount"), tx.get("date")
    if not isinstance(tx_id, str) or not isinstance(amount, int) or isinstance(amount, bool) \
            or not isinstance(date, int) or isinstance(date, bool):
        return None
    source, receiver = tx.get("source"), tx.get("receiver")
    direction, partner = ("in", source) if isinstance(source, dict) else ("out", receiver)
    partner = partner if isinstance(partner, dict) else {}
    partner_type = partner.get("type") if isinstance(partner.get("type"), str) else None
    is_user = partner_type == "user"

    def _s(name: str) -> str | None:
        value = partner.get(name)
        return value if is_user and isinstance(value, str) else None

    nano = tx.get("nanostar_amount")
    period = partner.get("subscription_period")
    return {
        "id": tx_id,
        "amount": amount,
        "nanostar_amount": nano if isinstance(nano, int) and not isinstance(nano, bool) else None,
        "date": date,
        "direction": direction,
        "partner_type": partner_type,
        "transaction_type": _s("transaction_type"),
        "invoice_payload": _s("invoice_payload"),
        "subscription_period": period if is_user and isinstance(period, int) and not isinstance(period, bool)
        else None,
    }


@router.get("/transactions")
async def star_transactions(
    request: Request,
    offset: Annotated[int, Query(ge=0, le=10_000_000)] = 0,
    limit: Annotated[int, Query(ge=1, le=100)] = 100,
    _: Principal = Depends(billing_only),
) -> dict[str, Any]:
    try:
        result = await _telegram(request).call("getStarTransactions", {"offset": offset, "limit": limit})
    except TelegramError as exc:
        log.warning("getStarTransactions failed", extra={"telegram_status": exc.status})
        raise _telegram_error(exc) from None
    raw = result.get("transactions") if isinstance(result, dict) else None
    if not isinstance(raw, list):
        raise ApiError(502, "TELEGRAM_ERROR", "Неожиданный ответ Telegram", {"permanent": False})
    items = [item for item in (statement_item(tx) for tx in raw) if item is not None]
    # count — размер страницы Telegram до отбора: по нему billing листает выписку (offset += count)
    return {"items": items, "count": len(raw)}
