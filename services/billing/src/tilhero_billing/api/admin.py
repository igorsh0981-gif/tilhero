"""Админ-API billing (INTERNAL_API §1.17, admin.ts «Деньги»): только admin-bff с actor; права — в домене; step-up —
`X-Step-Up: ok` по списку §12; аудит каждой команды (admin.audit.recorded.v1 через outbox)."""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime, time, timedelta
from typing import Any, Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Header, Query, Request, Response
from fastapi.responses import JSONResponse

from tilhero_billing.api.common import (
    REPLAYED,
    idempotency_key,
    now,
    page_limit,
    recall,
    remember,
    require,
    require_any,
    settings_of,
    staff_auth,
    staff_once,
)
from tilhero_billing.domain import account, adjustments, admin_views, catalog, reconciliation, refunds, reports
from tilhero_billing.domain.common import (
    BILLING_APPROVE,
    BILLING_MANAGE,
    BILLING_PUBLISH,
    BILLING_READ,
    BILLING_REFUND,
    DASHBOARD_READ,
    REPORT_TZ,
    SUBSCRIPTIONS_OVERRIDE,
    emit_audit,
    is_deleted,
    order_not_found,
)
from tilhero_billing.models import FxRate, Order, StarRate
from tilhero_billing.schemas import (
    AdjustmentBody,
    ApproveBody,
    CatalogDraftBody,
    CommentBody,
    FxBody,
    GrantAllBody,
    NoteBody,
    RefundBody,
    ResolveBody,
    StarRateBody,
)
from tilhero_common.app import Runtime, get_runtime
from tilhero_common.errors import bad_request, conflict
from tilhero_common.internal_auth import Principal

router = APIRouter(prefix="/internal/v1/admin/billing", tags=["admin"])

Cursor = Query(default=None, max_length=200)
Limit = Query(default=20, ge=1, le=100)
IdemKey = Header(default=None, alias="Idempotency-Key")


# ---------------------------------------------------------------- каталог


@router.get("/catalog")
async def list_catalog(p: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    require(p, BILLING_READ)
    async with rt.transaction() as db:
        return {"items": await catalog.list_versions(db)}


@router.get("/catalog/{version}")
async def get_catalog(version: int, p: Principal = Depends(staff_auth),
                      rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    require(p, BILLING_READ)
    async with rt.transaction() as db:
        return await catalog.version_view(db, await catalog.get_version(db, version))


@router.put("/catalog/draft")
async def put_draft(body: CatalogDraftBody, request: Request, p: Principal = Depends(staff_auth),
                    rt: Runtime = Depends(get_runtime),
                    if_match: str | None = Header(default=None, alias="If-Match")) -> dict[str, Any]:
    actor = require(p, BILLING_MANAGE)
    async with rt.transaction() as db:
        draft = await catalog.put_draft(db, body.payload, body.comment, if_match, actor, now(request))
        return await catalog.version_view(db, draft)


@router.delete("/catalog/draft", status_code=204, response_class=Response)
async def delete_draft(p: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)) -> Response:
    require(p, BILLING_MANAGE)
    async with rt.transaction() as db:
        await catalog.delete_draft(db)
    return Response(status_code=204)


@router.post("/catalog/draft/validate")
async def validate_draft(request: Request, p: Principal = Depends(staff_auth),
                         rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    require(p, BILLING_MANAGE)
    async with rt.transaction() as db:
        return await catalog.validate_draft(db, settings_of(request))


@router.post("/catalog/draft/activate")
async def activate_draft(body: CommentBody, request: Request, p: Principal = Depends(staff_auth),
                         rt: Runtime = Depends(get_runtime),
        key: str | None = IdemKey) -> JSONResponse:
    actor = require(p, BILLING_PUBLISH, request, step_up=True)
    async with rt.transaction() as db:
        async def run() -> dict[str, Any]:
            v = await catalog.activate_draft(db, settings_of(request), body.comment, actor, now(request))
            return await catalog.version_view(db, v)

        return await staff_once(db, actor, "catalog_activate", key, body.model_dump(), run, now(request))


@router.post("/catalog/{version}/rollback")
async def rollback(version: int, body: CommentBody, request: Request, p: Principal = Depends(staff_auth),
                   rt: Runtime = Depends(get_runtime),
        key: str | None = IdemKey) -> JSONResponse:
    actor = require(p, BILLING_PUBLISH, request, step_up=True)
    async with rt.transaction() as db:
        async def run() -> dict[str, Any]:
            v = await catalog.rollback(db, settings_of(request), version, body.comment, actor, now(request))
            return await catalog.version_view(db, v)

        return await staff_once(db, actor, f"catalog_rollback:{version}", key, body.model_dump(), run, now(request))


# ---------------------------------------------------------------- заказы и возвраты


def _ts(value: str | None, name: str, *, end: bool = False) -> datetime | None:
    """Граница фильтра (как admin-bff `tashkentBound`): YYYY-MM-DD — начало дня Ташкента, для `to` — начало
    следующего дня («по» включительно); время с зоной — как есть; без зоны — UTC. Фильтр: from ≤ created_at < to."""
    if value is None:
        return None
    try:
        if len(value) == 10:
            day = date.fromisoformat(value) + (timedelta(days=1) if end else timedelta())
            return datetime.combine(day, time(0, 0), tzinfo=ZoneInfo(REPORT_TZ)).astimezone(UTC)
        ts = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise bad_request("VALIDATION_ERROR", "Некорректная дата", {"field": name}) from None
    return ts if ts.tzinfo else ts.replace(tzinfo=UTC)


@router.get("/orders")
async def list_orders(p: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime),
                      status: Literal["pending", "paid", "fulfilled", "expired", "cancelled", "refunded"] | None = None,
                      channel: Literal["miniapp", "web", "renewal"] | None = None,
                      provider: Literal["telegram_stars", "payme", "click", "uzum"] | None = None,
                      product_kind: Literal["subscription", "til_pack"] | None = None,
                      from_: str | None = Query(default=None, alias="from", max_length=40),
                      to: str | None = Query(default=None, max_length=40),
                      order_no: int | None = Query(default=None, ge=1),
                      provider_txn_id: str | None = Query(default=None, max_length=128),
                      account_id: uuid.UUID | None = None, cursor: str | None = Cursor,
                      limit: int = Limit) -> dict[str, Any]:
    require(p, BILLING_READ)
    filters = {"status": status, "channel": channel, "provider": provider, "product_kind": product_kind,
               "from": _ts(from_, "from"), "to": _ts(to, "to", end=True), "order_no": order_no,
               "provider_txn_id": provider_txn_id, "account_id": account_id}
    async with rt.transaction() as db:
        items, nxt = await admin_views.orders_page(db, filters, cursor, page_limit(limit))
    return {"items": items, "next_cursor": nxt}


@router.get("/orders/{order_id}")
async def get_order(order_id: uuid.UUID, p: Principal = Depends(staff_auth),
                    rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    require(p, BILLING_READ)
    async with rt.transaction() as db:
        order = await db.get(Order, order_id)
        if order is None:
            raise order_not_found()
        return await admin_views.order_card(db, order)


@router.post("/orders/{order_id}/refunds", status_code=201)
async def refund_order(order_id: uuid.UUID, body: RefundBody, request: Request, p: Principal = Depends(staff_auth),
                       rt: Runtime = Depends(get_runtime),
                       key: str | None = Header(default=None, alias="Idempotency-Key")) -> JSONResponse:
    actor = require(p, BILLING_REFUND, request, step_up=True)
    out, replayed = await refunds.request(rt, actor, order_id, body.reason, body.force, idempotency_key(key))
    return JSONResponse(out, status_code=201, headers=REPLAYED if replayed else None)


@router.post("/refunds/{refund_id}/fail")
async def fail_refund(refund_id: uuid.UUID, body: NoteBody, request: Request, p: Principal = Depends(staff_auth),
                      rt: Runtime = Depends(get_runtime),
        key: str | None = IdemKey) -> JSONResponse:
    actor = require(p, BILLING_REFUND, request, step_up=True)
    async with rt.transaction() as db:
        return await staff_once(db, actor, f"refund_fail:{refund_id}", key, body.model_dump(),
                                lambda: refunds.fail(db, actor, refund_id, body.note, now(request)), now(request))


@router.get("/refunds")
async def list_refunds(p: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime),
                       status: Literal["awaiting_provider", "completed", "failed"] | None = None,
                       cursor: str | None = Cursor, limit: int = Limit) -> dict[str, Any]:
    require(p, BILLING_READ)
    async with rt.transaction() as db:
        items, nxt = await admin_views.refunds_page(db, status, cursor, page_limit(limit))
    return {"items": items, "next_cursor": nxt}


# ---------------------------------------------------------------- аккаунт ученика и «четыре глаза»


@router.get("/accounts/{account_id}")
async def get_account(account_id: uuid.UUID, request: Request, p: Principal = Depends(staff_auth),
                      rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    require(p, BILLING_READ)
    async with rt.transaction() as db:
        if await is_deleted(db, account_id):
            raise adjustments.account_not_found()
        return await admin_views.account_view(db, account_id, now(request))


@router.get("/accounts/{account_id}/ledger")
async def get_ledger(account_id: uuid.UUID, p: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime),
                     cursor: str | None = Cursor, limit: int = Limit) -> dict[str, Any]:
    require(p, BILLING_READ)
    async with rt.transaction() as db:
        items, nxt = await admin_views.ledger_page(db, account_id, cursor, page_limit(limit))
    return {"items": items, "next_cursor": nxt}


@router.post("/accounts/{account_id}/adjustments", status_code=202)
async def request_adjustment(account_id: uuid.UUID, body: AdjustmentBody, request: Request,
                             p: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime),
                             key: str | None = Header(default=None, alias="Idempotency-Key")) -> JSONResponse:
    actor = require(p, SUBSCRIPTIONS_OVERRIDE, request, step_up=True)
    k = idempotency_key(key)
    async with rt.transaction() as db:
        adj, _ = await adjustments.request(db, actor, account_id, body.kind, body.minutes, body.days,
                                           body.period_id, body.reason, k, now(request))
        return JSONResponse(adjustments.view(adj, actor), status_code=202)


@router.get("/adjustments")
async def list_adjustments(p: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime),
                           status: Literal["pending", "applied", "rejected", "expired", "cancelled"] | None = None,
                           account_id: uuid.UUID | None = None, cursor: str | None = Cursor,
                           limit: int = Limit) -> dict[str, Any]:
    actor = require(p, BILLING_READ)
    async with rt.transaction() as db:
        rows, nxt = await adjustments.page(db, status, cursor, page_limit(limit), account_id)
    return {"items": [adjustments.view(a, actor) for a in rows], "next_cursor": nxt}


@router.post("/adjustments/{adjustment_id}/approve")
async def approve(adjustment_id: uuid.UUID, body: ApproveBody, request: Request, p: Principal = Depends(staff_auth),
                  rt: Runtime = Depends(get_runtime),
        key: str | None = IdemKey) -> JSONResponse:
    actor = require(p, BILLING_APPROVE, request, step_up=True)
    async with rt.transaction() as db:
        async def run() -> dict[str, Any]:
            return adjustments.view(await adjustments.approve(db, actor, adjustment_id, body.note, now(request)), actor)

        return await staff_once(db, actor, f"adj_approve:{adjustment_id}", key, body.model_dump(), run, now(request))


@router.post("/adjustments/{adjustment_id}/reject")
async def reject(adjustment_id: uuid.UUID, body: NoteBody, request: Request, p: Principal = Depends(staff_auth),
                 rt: Runtime = Depends(get_runtime),
        key: str | None = IdemKey) -> JSONResponse:
    actor = require(p, BILLING_APPROVE, request, step_up=True)
    async with rt.transaction() as db:
        async def run() -> dict[str, Any]:
            return adjustments.view(await adjustments.reject(db, actor, adjustment_id, body.note, now(request)), actor)

        return await staff_once(db, actor, f"adj_reject:{adjustment_id}", key, body.model_dump(), run, now(request))


@router.post("/adjustments/{adjustment_id}/cancel")
async def cancel_adjustment(adjustment_id: uuid.UUID, request: Request, p: Principal = Depends(staff_auth),
                            rt: Runtime = Depends(get_runtime),
        key: str | None = IdemKey) -> JSONResponse:
    """Отзыв заявки — автор с subscriptions.override (как у admin-bff; не автор — 404)."""
    actor = require(p, SUBSCRIPTIONS_OVERRIDE)
    async with rt.transaction() as db:
        async def run() -> dict[str, Any]:
            return adjustments.view(await adjustments.cancel(db, actor, adjustment_id, now(request)), actor)

        return await staff_once(db, actor, f"adj_cancel:{adjustment_id}", key, {}, run, now(request))


# ---------------------------------------------------------------- сверка


@router.get("/reconciliation/items")
async def list_recon(p: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime),
                     status: Literal["open", "resolved", "ignored"] | None = None,
                     kind: str | None = Query(default=None, max_length=40), cursor: str | None = Cursor,
                     limit: int = Limit) -> dict[str, Any]:
    require(p, BILLING_READ)
    async with rt.transaction() as db:
        items, nxt = await reconciliation.items_page(db, status, kind, cursor, page_limit(limit))
    return {"items": items, "next_cursor": nxt}


@router.post("/reconciliation/runs")
async def run_recon(request: Request, p: Principal = Depends(staff_auth),
                    rt: Runtime = Depends(get_runtime),
        key: str | None = IdemKey) -> JSONResponse:
    actor = require(p, BILLING_MANAGE)
    async with rt.transaction() as db:
        replay = await recall(db, actor, "recon_run", key, {})
    if replay is not None:
        return replay
    run = await reconciliation.run(rt, "manual")
    async with rt.transaction() as db:
        await emit_audit(db, actor, "billing.recon_run", "billing_recon_run", str(run.run_id),
                         after={"found": int(run.found)}, at=now(request))
        return remember(db, actor, "recon_run", key, {}, 200, reconciliation.run_view(run), now(request))


@router.post("/reconciliation/items/{item_id}/resolve")
async def resolve_recon(item_id: uuid.UUID, body: ResolveBody, request: Request, p: Principal = Depends(staff_auth),
                        rt: Runtime = Depends(get_runtime),
        key: str | None = IdemKey) -> JSONResponse:
    actor = require(p, BILLING_MANAGE)
    async with rt.transaction() as db:
        return await staff_once(
            db, actor, f"recon_resolve:{item_id}", key, body.model_dump(),
            lambda: reconciliation.resolve(db, actor, item_id, body.status, body.note, now(request)), now(request))


# ---------------------------------------------------------------- отчёты, курсы, провайдеры, пробный


@router.get("/reports/summary")
async def summary(request: Request, p: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime),
                  period: Literal["day", "week", "month"] = "day") -> dict[str, Any]:
    require_any(p, BILLING_READ, DASHBOARD_READ)
    async with rt.transaction() as db:
        out = await reports.summary(db, period, now(request))
        out["recon_open"] = await reconciliation.open_count(db)
        return out


@router.get("/reports/daily")
async def daily(p: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime),
                from_: date = Query(alias="from"), to: date = Query()) -> dict[str, Any]:
    require_any(p, BILLING_READ, DASHBOARD_READ)
    if to < from_ or (to - from_) > timedelta(days=91):
        raise bad_request("VALIDATION_ERROR", "Период — не больше 92 дней", {"field": "to"})
    async with rt.transaction() as db:
        return {"items": await reports.daily(db, from_, to)}


@router.get("/fx")
async def get_fx(p: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    require(p, BILLING_READ)
    async with rt.transaction() as db:
        return {"items": await reports.rates(db, FxRate)}


@router.put("/fx")
async def put_fx(body: FxBody, request: Request, p: Principal = Depends(staff_auth),
                 rt: Runtime = Depends(get_runtime),
        key: str | None = IdemKey) -> JSONResponse:
    actor = require(p, BILLING_MANAGE)
    async with rt.transaction() as db:
        return await staff_once(db, actor, "fx", key, body.model_dump(mode="json"), lambda: reports.put_rate(
            db, actor, FxRate, body.usd_in_tiyin, body.valid_from, body.reason, now(request)), now(request))


@router.get("/star-rate")
async def get_star_rate(p: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    require(p, BILLING_READ)
    async with rt.transaction() as db:
        return {"items": await reports.rates(db, StarRate)}


@router.put("/star-rate")
async def put_star_rate(body: StarRateBody, request: Request, p: Principal = Depends(staff_auth),
                        rt: Runtime = Depends(get_runtime),
        key: str | None = IdemKey) -> JSONResponse:
    actor = require(p, BILLING_MANAGE)
    async with rt.transaction() as db:
        return await staff_once(db, actor, "star_rate", key, body.model_dump(mode="json"), lambda: reports.put_rate(
            db, actor, StarRate, body.star_in_tiyin, body.valid_from, body.reason, now(request)), now(request))


@router.get("/providers")
async def providers(request: Request, p: Principal = Depends(staff_auth),
                    rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    require(p, BILLING_READ)
    async with rt.transaction() as db:
        return {"items": await admin_views.providers_view(db, settings_of(request))}


@router.post("/trials:grant-all")
async def grant_all(body: GrantAllBody, request: Request, p: Principal = Depends(staff_auth),
                    rt: Runtime = Depends(get_runtime),
        key: str | None = IdemKey) -> JSONResponse:
    """Разовая выдача пробного всем активным 14+ при включении пэйвола (только TRIAL_ON_ENFORCEMENT=true)."""
    actor = require(p, BILLING_PUBLISH, request, step_up=True)
    settings = settings_of(request)
    if not settings.trial_on_enforcement:
        raise conflict("TRIAL_GRANT_DISABLED", "Массовая выдача пробного выключена (TRIAL_ON_ENFORCEMENT)")
    async with rt.transaction() as db:
        replay = await recall(db, actor, "trials_grant_all", key, body.model_dump())
    if replay is not None:
        return replay
    out = await account.grant_trials_all(rt, settings.tick_batch_size)
    async with rt.transaction() as db:
        await emit_audit(db, actor, "billing.trials_granted", "billing_trials", "all", after=out, reason=body.reason,
                         at=now(request))
        return remember(db, actor, "trials_grant_all", key, body.model_dump(), 200, out, now(request))

