"""API ученика и lessons над аккаунтом (INTERNAL_API §1.10, §1.11, §1.17): каталог и подписка по каналу, история
минут, пробный период, автопродление подписки Stars, удержания и доступ.

Анти-стиринг: канал miniapp не видит цен в сумах, фиатных провайдеров, заказов сайта, источника и цены периодов сайта
(только статус подписки и минуты); stars_subscription и пробный — только в miniapp."""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_billing import clients
from tilhero_billing.domain import adapters, catalog, learners, minutes, periods
from tilhero_billing.domain.catalog import Catalog
from tilhero_billing.domain.common import (
    FEATURES,
    STARS_SUB_CHANGED,
    cursor_int,
    emit_event,
    encode_cursor,
    is_deleted,
    iso,
    iso_req,
    lock_account,
    now_of,
    stars_subscription_not_found,
    stars_unavailable,
    trial_not_available,
    trial_used,
    user_deleted,
)
from tilhero_billing.domain.learners import Caller
from tilhero_billing.models import Learner, MinuteHold, MinuteLedger, Period, StarsSubscription
from tilhero_billing.providers.base import FIAT_PROVIDERS
from tilhero_billing.settings import Settings
from tilhero_common.app import Runtime
from tilhero_common.errors import conflict

log = logging.getLogger("tilhero.billing.account")


def sales_enabled(settings: Settings, channel: str) -> bool:
    if channel == "web":
        return settings.payments_enabled and any(settings.provider_enabled(p) for p in FIAT_PROVIDERS)
    return settings.provider_enabled("telegram_stars")


def _product_view(p: dict[str, Any], channel: str, price: int) -> dict[str, Any]:
    sub = p.get("kind") == "subscription"
    view = {"code": p["code"], "kind": p["kind"], "title": p.get("title") or {},
            "description": p.get("description") if isinstance(p.get("description"), dict) else None,
            "days": p.get("days") if sub else None, "minutes": p.get("minutes") if sub else None,
            "features": list(p.get("features") or []) if sub else [],
            "til": p.get("til") if not sub else None}
    if channel == "web":
        view["price"] = {"tiyin": price}
    else:
        view["price"] = {"stars": price, "mode": p.get("stars_mode") or "one_time"}
    return view


async def catalog_view(db: AsyncSession, caller: Caller, settings: Settings) -> dict[str, Any]:
    """GET /me/billing/catalog: miniapp — только товары с ценой в Stars и только Stars; web — только сумы и
    включённые Payme / Click / Uzum. Детский профиль — products: [], payer_required: true (без цен)."""
    cat = await catalog.active_catalog(db)
    info = await learners.payer_info(db, caller)
    web = caller.channel == "web"
    providers = [p for p in FIAT_PROVIDERS if settings.provider_enabled(p)] if web else (
        ["telegram_stars"] if settings.provider_enabled("telegram_stars") else [])
    products: list[dict[str, Any]] = []
    if cat is not None and not caller.child_profile:
        own = catalog.audience_of(await learners.effective_band(db, caller), False)
        for p in cat.products():
            price = catalog.channel_price(p, caller.channel)
            if p.get("status") != "on_sale" or price is None:
                continue
            audiences = p.get("audiences") or []
            if own not in audiences and not (p.get("kind") == "til_pack" and "kids" in audiences):
                continue
            products.append(_product_view(p, caller.channel, price))
    out: dict[str, Any] = {
        "sales_enabled": sales_enabled(settings, caller.channel), "providers": providers,
        "offer": cat.offer if cat is not None else {"version": "", "url": ""}, "products": products,
        "payer_required": info.payer_required, "can_pay": info.can_pay, "consent_required": info.consent_required}
    if not web:
        out["trial"] = None if caller.child_profile or cat is None else await _trial_view(db, caller, cat)
    return out


async def _trial_view(db: AsyncSession, caller: Caller, cat: Catalog) -> dict[str, Any]:
    trial = cat.trial
    return {"available": await _trial_available(db, caller.account_id, cat),
            "days": int(trial.get("days") or 0), "minutes": int(trial.get("minutes") or 0)}


async def _trial_available(db: AsyncSession, account_id: uuid.UUID, cat: Catalog | None) -> bool:
    if cat is None or not cat.trial.get("enabled"):
        return False
    st = await periods.account_state(db, account_id)
    return not st.trial_used and not st.paid_active


async def subscription_view(db: AsyncSession, caller: Caller, settings: Settings, now: datetime) -> dict[str, Any]:
    """SubscriptionView (bff.ts) / WebSubscriptionView (web.ts). Детскому профилю — статус семьи без цен."""
    cat = await catalog.active_catalog(db)
    info = await learners.payer_info(db, caller)
    st = await periods.account_state(db, caller.account_id)
    plan = None
    if st.active is not None:
        title = await _plan_title(db, st.active, cat)
        plan = {"code": st.active.product_code, "title": title}
    nxt = st.scheduled[0] if st.scheduled else None
    stars = st.stars
    expiring = bool(st.active is not None and st.active.ends_at is not None and not st.scheduled
                    and st.active.ends_at - now <= timedelta(days=(cat.limits["expiring_days"] if cat else 3))
                    and not (stars is not None and stars.status == "active"))
    out: dict[str, Any] = {
        "status": st.status, "plan": plan, "period": periods.period_view(st.active, st.balance),
        "next_period": {"days": int(nxt.days), "minutes_granted": int(nxt.minutes_granted), "starts_at": None}
        if nxt is not None else None,
        "features": st.features, "expiring": expiring,
        "minutes_exhausted": st.active is not None and st.minutes_left <= 0,
        "payer_required": info.payer_required, "can_pay": info.can_pay,
        "sales_enabled": sales_enabled(settings, caller.channel)}
    if caller.channel != "web":
        out["trial_available"] = not caller.child_profile and info.can_pay and await _trial_available(
            db, caller.account_id, cat)
        out["stars_subscription"] = None if caller.child_profile or stars is None else {
            "status": stars.status, "auto_renew": stars.status == "active", "expires_at": iso(stars.expires_at),
            "amount_stars": int(stars.amount_stars)}
    return out


async def _plan_title(db: AsyncSession, period: Period, cat: Catalog | None) -> dict[str, str]:
    if period.source == "trial":
        return {"ru": "Пробный период", "uz": "Sinov davri"}
    if period.source == "grant":
        return {"ru": "Подписка от поддержки", "uz": "Qoʻllab-quvvatlash obunasi"}
    if period.order_id is not None:
        from tilhero_billing.models import Order

        snap = await db.scalar(select(Order.product_snapshot).where(Order.order_id == period.order_id))
        title = (snap or {}).get("title") if isinstance(snap, dict) else None
        if isinstance(title, dict):
            code = period.product_code
            return {"ru": str(title.get("ru") or code), "uz": str(title.get("uz") or code)}
    product = cat.product(period.product_code) if cat is not None else None
    title = product.get("title") if product else None
    return dict(title) if isinstance(title, dict) else {"ru": period.product_code, "uz": period.product_code}


async def minutes_page(db: AsyncSession, caller: Caller, cursor: str | None, limit: int
                       ) -> tuple[list[dict[str, Any]], str | None]:
    """История минут аккаунта (новые сверху) без комментариев сотрудников: learner self | child | null."""
    stmt = select(MinuteLedger).where(MinuteLedger.account_id == caller.account_id)
    after = cursor_int(cursor)
    if after is not None:
        stmt = stmt.where(MinuteLedger.seq < after)
    rows = list((await db.execute(stmt.order_by(MinuteLedger.seq.desc()).limit(limit + 1))).scalars().all())
    items = []
    for r in rows[:limit]:
        who = None if r.learner_id is None else ("self" if r.learner_id == caller.learner_id else "child")
        items.append({"at": iso(r.created_at), "kind": r.kind, "minutes": int(r.minutes), "ref_kind": r.ref_kind,
                      "learner": who, "period_id": str(r.period_id)})
    nxt = encode_cursor(rows[limit - 1].seq) if len(rows) > limit else None
    return items, nxt


# ---------------------------------------------------------------- пробный период


async def grant_trial(db: AsyncSession, account_id: uuid.UUID, cat: Catalog, now: datetime, *,
                      reason: str = "trial") -> Period | None:
    """Пробный: один раз на аккаунт (uq_period_trial), без активного оплаченного/выданного периода."""
    await periods.ensure_current(db, account_id, now)
    st = await periods.account_state(db, account_id)
    if st.trial_used or st.paid_active:
        return None
    trial = cat.trial
    feats = [f for f in trial.get("features") or [] if f in FEATURES] or list(FEATURES)
    return await periods.add_period(db, account_id, source="trial", product_code="trial",
                                    catalog_version=cat.version, days=int(trial["days"]),
                                    minutes_granted=int(trial["minutes"]), features=feats, mode="now", now=now,
                                    reason=reason)


async def start_trial(db: AsyncSession, caller: Caller, now: datetime) -> None:
    """POST /me/billing/trial (вызывающий держит блокировку аккаунта): плательщик, канал miniapp, пробный включён,
    не был у аккаунта (409 TRIAL_USED), нет активного оплаченного или выданного (409 TRIAL_NOT_AVAILABLE)."""
    if caller.channel != "miniapp":
        raise trial_not_available()
    if await is_deleted(db, caller.account_id):
        raise user_deleted()
    learners.require_payer(await learners.payer_info(db, caller))
    cat = await catalog.active_catalog(db)
    if cat is None or not cat.trial.get("enabled"):
        raise trial_not_available()
    await periods.ensure_current(db, caller.account_id, now)
    st = await periods.account_state(db, caller.account_id)
    if st.trial_used:
        raise trial_used()
    if st.paid_active:
        raise trial_not_available()
    await grant_trial(db, caller.account_id, cat, now)


async def grant_trials_all(rt: Runtime, batch: int) -> dict[str, int]:
    """Разовая выдача пробного всем активным 14+ (аккаунты проекции без пробного и без оплаченного периода)."""
    now = now_of(rt)
    granted = skipped = 0
    last: uuid.UUID | None = None
    while True:
        async with rt.transaction() as db:
            stmt = select(Learner.user_id).where(Learner.kind == "account",
                                                 Learner.age_band.in_(("14-17", "18+")))
            if last is not None:
                stmt = stmt.where(Learner.user_id > last)
            ids = list((await db.execute(stmt.order_by(Learner.user_id).limit(batch))).scalars().all())
            cat = await catalog.active_catalog(db)
        if not ids or cat is None:
            return {"granted": granted, "skipped": skipped}
        last = ids[-1]
        for account in ids:
            async with rt.transaction() as db:
                await lock_account(db, account)
                if await is_deleted(db, account):
                    skipped += 1
                    continue
                if await grant_trial(db, account, cat, now, reason="trial_grant") is None:
                    skipped += 1
                else:
                    granted += 1
        if len(ids) < batch:
            return {"granted": granted, "skipped": skipped}


# ---------------------------------------------------------------- автопродление подписки Stars


async def set_auto_renew(rt: Runtime, caller: Caller, auto_renew: bool) -> None:
    """Mini App: «Отключить/включить автопродление» → bot-gateway editUserStarSubscription → canceled | active."""
    if caller.channel != "miniapp":
        raise stars_subscription_not_found()
    async with rt.transaction() as db:
        if await is_deleted(db, caller.account_id):
            raise user_deleted()
        learners.require_payer(await learners.payer_info(db, caller))
        sub = await periods.live_stars(db, caller.account_id)
        if sub is None:
            raise stars_subscription_not_found()
        sub_id, charge = sub.subscription_id, sub.first_charge_id
    try:
        await adapters.edit_star_subscription(rt, caller.account_id, charge, is_canceled=not auto_renew)
    except clients.StarsGatewayError as exc:
        if exc.code == "STARS_PAYER_UNKNOWN":
            raise conflict("STARS_PAYER_UNKNOWN", "Плательщик неизвестен") from None
        raise stars_unavailable() from None
    now = now_of(rt)
    async with rt.transaction() as db:
        await lock_account(db, caller.account_id)
        sub_row = await db.get(StarsSubscription, sub_id, with_for_update=True, populate_existing=True)
        target = "active" if auto_renew else "canceled"
        if sub_row is None or sub_row.status not in periods.LIVE_STARS or sub_row.status == target:
            return
        sub_row.status, sub_row.updated_at = target, now
        await db.flush()
        await emit_event(db, STARS_SUB_CHANGED, {
            "account_id": str(caller.account_id), "subscription_id": str(sub_id), "status": target,
            "expires_at": iso_req(sub_row.expires_at), "changed_at": iso_req(now)})
        await periods.emit_access(db, caller.account_id, now)


# ---------------------------------------------------------------- удержания и доступ (lessons)


def _denied(reason: str) -> dict[str, Any]:
    return {"allowed": False, "reason": reason}


async def _resolve(db: AsyncSession, user_id: uuid.UUID) -> tuple[uuid.UUID, Learner | None]:
    account, row = await learners.account_of(db, user_id)
    return account, row


async def hold(rt: Runtime, user_id: uuid.UUID, feature: str, ref_kind: str, ref_id: uuid.UUID,
               minutes_planned: int) -> dict[str, Any]:
    """POST /internal/v1/holds: под блокировкой аккаунта — ensure_current → активный период с функцией → доступно ≥
    min_start_minutes (ai_lessons) / pair_min_minutes (pair_lessons) → удержание min(доступно, план). Повтор по
    (ref_kind, ref_id) — тот же ответ. Не зависит от флагов продаж."""
    now = now_of(rt)
    async with rt.transaction() as db:
        account, row = await _resolve(db, user_id)
        if learners.is_kids(row):
            return _denied("kids")
        await lock_account(db, account)
        if await is_deleted(db, account) or await is_deleted(db, user_id):
            return _denied("no_subscription")
        existing = await minutes.hold_by_ref(db, ref_kind, ref_id)
        if existing is not None:
            bal = await db.get(periods.PeriodBalance, existing.period_id, populate_existing=True)
            period = await db.get(Period, existing.period_id)
            return minutes.hold_view(existing, minutes.available(bal), period.ends_at if period else None)
        cat = await catalog.active_catalog(db)
        active = await periods.ensure_current(db, account, now)
        if active is None:
            return _denied("no_subscription")
        if feature not in active.features:
            return _denied("feature_not_in_plan")
        bal = await minutes.balance(db, active.period_id)
        free = minutes.available(bal)
        limits = cat.limits if cat is not None else {"min_start_minutes": 1, "pair_min_minutes": 10,
                                                      "hold_ttl_hours": 80}
        need = limits["pair_min_minutes"] if feature == "pair_lessons" else limits["min_start_minutes"]
        if bal is None or free < need or free <= 0:
            return _denied("minutes_exhausted")
        h = await minutes.create_hold(db, active, bal, learner_id=user_id, feature=feature, ref_kind=ref_kind,
                                      ref_id=ref_id, minutes=min(free, minutes_planned),
                                      expires_at=now + timedelta(hours=limits["hold_ttl_hours"]), at=now)
        return minutes.hold_view(h, minutes.available(bal), active.ends_at)


async def access(rt: Runtime, user_id: uuid.UUID, feature: str) -> dict[str, Any]:
    """GET /internal/v1/access/{user_id}?feature= → {allowed, reason, minutes_left} (приглашение в урок вдвоём)."""
    now = now_of(rt)
    async with rt.transaction() as db:
        account, row = await _resolve(db, user_id)
        if learners.is_kids(row):
            return {"allowed": False, "reason": "kids", "minutes_left": 0}
        await lock_account(db, account)
        if await is_deleted(db, account):
            return {"allowed": False, "reason": "no_subscription", "minutes_left": 0}
        active = await periods.ensure_current(db, account, now)
        if active is None:
            return {"allowed": False, "reason": "no_subscription", "minutes_left": 0}
        bal = await db.get(periods.PeriodBalance, active.period_id, populate_existing=True)
        left = minutes.available(bal)
        if feature not in active.features:
            return {"allowed": False, "reason": "feature_not_in_plan", "minutes_left": left}
        cat = await catalog.active_catalog(db)
        need = (cat.limits["pair_min_minutes"] if feature == "pair_lessons" else cat.limits["min_start_minutes"]) \
            if cat is not None else 1
        if left < need or left <= 0:
            return {"allowed": False, "reason": "minutes_exhausted", "minutes_left": left}
        return {"allowed": True, "reason": None, "minutes_left": left}


async def settle_event(db: AsyncSession, hold_id: uuid.UUID, billable: int, now: datetime, *,
                       causation_id: str | None) -> None:
    """Списание по событию завершения занятия (consumer): под блокировкой аккаунта удержания."""
    row = await db.get(MinuteHold, hold_id)
    if row is None:
        log.info("hold not found for settlement", extra={"code": "HOLD_NOT_FOUND"})
        return
    await lock_account(db, row.account_id)
    row = await db.get(MinuteHold, hold_id, with_for_update=True, populate_existing=True)
    assert row is not None
    cat = await catalog.active_catalog(db)
    await minutes.settle(db, row, billable, low_percent=cat.limits["low_minutes_percent"] if cat else 10, at=now,
                         causation_id=causation_id)

