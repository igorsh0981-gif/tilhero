"""API ученика и сайта (INTERNAL_API §1.17): только telegram-bff; sub — аккаунт, lrn — профиль, age_band, chn —
канал. miniapp — только Stars; web — только сумы и Payme / Click / Uzum. Чужой заказ или заказ другого канала — 404."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Header, Query, Request
from fastapi.responses import JSONResponse

from tilhero_billing.api.common import current_caller, idempotency_key, locale_of, now, page_limit, settings_of
from tilhero_billing.domain import account, orders
from tilhero_billing.domain.common import (
    idempotency_reused,
    is_deleted,
    lock_account,
    request_hash,
    stars_unavailable,
    user_deleted,
)
from tilhero_billing.domain.learners import Caller
from tilhero_billing.models import Idempotency
from tilhero_billing.schemas import OrderBody, StarsSubscriptionBody
from tilhero_common.app import Runtime, get_runtime

router = APIRouter(prefix="/internal/v1/me/billing", tags=["learner"])


@router.get("/catalog")
async def get_catalog(request: Request, caller: Caller = Depends(current_caller),
                      rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    async with rt.transaction() as db:
        return await account.catalog_view(db, caller, settings_of(request))


@router.get("/subscription")
async def get_subscription(request: Request, caller: Caller = Depends(current_caller),
                           rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    at = now(request)
    async with rt.transaction() as db:
        await lock_account(db, caller.account_id)
        if await is_deleted(db, caller.account_id):
            raise user_deleted()
        await account.periods.ensure_current(db, caller.account_id, at)
        return await account.subscription_view(db, caller, settings_of(request), at)


@router.get("/minutes")
async def get_minutes(caller: Caller = Depends(current_caller), rt: Runtime = Depends(get_runtime),
                      cursor: str | None = Query(default=None, max_length=200),
                      limit: int = Query(default=20, ge=1, le=100)) -> dict[str, Any]:
    async with rt.transaction() as db:
        items, nxt = await account.minutes_page(db, caller, cursor, page_limit(limit))
    return {"items": items, "next_cursor": nxt}


@router.post("/trial", status_code=201)
async def start_trial(request: Request, caller: Caller = Depends(current_caller), rt: Runtime = Depends(get_runtime),
                      key: str | None = Header(default=None, alias="Idempotency-Key")) -> JSONResponse:
    """Пробный период (miniapp, плательщик) → 201 SubscriptionView; повтор ключа — тот же ответ."""
    k = idempotency_key(key)
    at = now(request)
    async with rt.transaction() as db:
        await lock_account(db, caller.account_id)
        prior = await db.get(Idempotency, ("trial", str(caller.account_id), k))
        if prior is not None:
            if prior.request_hash != request_hash({"trial": True}):
                raise idempotency_reused()
            return JSONResponse(prior.response, status_code=prior.status_code)
        await account.start_trial(db, caller, at)
        view = await account.subscription_view(db, caller, settings_of(request), at)
        db.add(Idempotency(scope="trial", actor=str(caller.account_id), key=k, request_hash=request_hash(
            {"trial": True}), status_code=201, response=view, created_at=at))
    return JSONResponse(view, status_code=201)


async def _view(rt: Runtime, order: Any, request: Request) -> dict[str, Any]:
    checkout = await orders.web_checkout(rt, order) if order.channel == "web" else None
    async with rt.transaction() as db:
        return await orders.learner_view(db, order, now(request), checkout_url=checkout)


@router.post("/orders")
async def create_order(body: OrderBody, request: Request, caller: Caller = Depends(current_caller),
                       rt: Runtime = Depends(get_runtime),
                       key: str | None = Header(default=None, alias="Idempotency-Key")) -> JSONResponse:
    """Заказ (§1.3): 201 — создан; 200 — тот же (повтор ключа или незавершённый того же товара). Stars — ссылка на
    счёт через bot-gateway; недоступен — 503 STARS_UNAVAILABLE {order_no} (заказ pending, повторить чтение)."""
    k = idempotency_key(key)
    req = orders.OrderRequest(product_code=body.product_code, provider=body.provider, start_mode=body.start_mode,
                              confirm_forfeit=body.confirm_forfeit, beneficiary_id=body.beneficiary_id,
                              offer_version=body.offer_version, locale=locale_of(request))
    order, created = await orders.create(rt, caller, req, k)
    if order.provider == "telegram_stars" and order.status == "pending" and order.invoice_link is None:
        if await orders.ensure_invoice_link(rt, order) is None and order.expires_at > now(request):
            raise stars_unavailable()
    return JSONResponse(await _view(rt, order, request), status_code=201 if created else 200)


@router.get("/orders")
async def list_orders(request: Request, caller: Caller = Depends(current_caller), rt: Runtime = Depends(get_runtime),
                      cursor: str | None = Query(default=None, max_length=200),
                      limit: int = Query(default=20, ge=1, le=100)) -> dict[str, Any]:
    async with rt.transaction() as db:
        rows, nxt = await orders.page(db, caller, cursor, page_limit(limit))
        items = [await orders.learner_view(db, o, now(request)) for o in rows]
    return {"items": items, "next_cursor": nxt}


@router.get("/orders/{order_no}")
async def get_order(order_no: int, request: Request, caller: Caller = Depends(current_caller),
                    rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    async with rt.transaction() as db:
        order = await orders.find(db, caller, order_no)
    if order.provider == "telegram_stars" and order.status == "pending" and order.invoice_link is None:
        await orders.ensure_invoice_link(rt, order)
    return await _view(rt, order, request)


@router.post("/orders/{order_no}/cancel")
async def cancel_order(order_no: int, request: Request, caller: Caller = Depends(current_caller),
                       rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    order = await orders.cancel(rt, caller, order_no)
    return await _view(rt, order, request)


@router.post("/stars-subscription")
async def stars_subscription(body: StarsSubscriptionBody, request: Request,
                             caller: Caller = Depends(current_caller),
                             rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """Автопродление подписки Stars (miniapp, плательщик) → SubscriptionView; нет живой — 404
    STARS_SUBSCRIPTION_NOT_FOUND; bot-gateway недоступен — 503 STARS_UNAVAILABLE."""
    await account.set_auto_renew(rt, caller, body.auto_renew)
    async with rt.transaction() as db:
        return await account.subscription_view(db, caller, settings_of(request), now(request))
