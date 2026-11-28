"""Отчёты и курсы (INTERNAL_API §1.15, ADM-DASH-04, AT-99). Все суммы целые: тийины и Stars раздельно (ADR-0001);
оценка Stars в тийинах — только здесь, по курсу финансов (`star_rates`, целочисленно), с пометкой «оценка». Дни и месяц
— Asia/Tashkent. Комиссии провайдеров и магазинов приложений не учитываются (данных нет)."""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any, cast

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_billing.domain.common import emit_audit, iso, local_day_start, report_zone, staff_ref
from tilhero_billing.models import FxRate, MinuteHold, MinuteLedger, Order, Period, Refund, StarRate, StarsSubscription
from tilhero_common.errors import ApiError, unprocessable
from tilhero_common.internal_auth import Actor

WEB_PROVIDERS = ("payme", "click", "uzum")
STARS_CHANNELS = ("miniapp", "renewal")
PAID = ("paid", "fulfilled", "refunded")


def fx_invalid(field: str) -> ApiError:
    del field
    return unprocessable("FX_INVALID", "Некорректный курс")


def bounds(period: str, now: datetime) -> tuple[datetime, datetime]:
    """Текущий день, неделя (с понедельника) или месяц по Ташкенту → [from, to) в UTC."""
    tz = report_zone()
    today = now.astimezone(tz).date()
    if period == "week":
        start = today - timedelta(days=today.weekday())
        end = start + timedelta(days=7)
    elif period == "month":
        start = today.replace(day=1)
        end = (start + timedelta(days=32)).replace(day=1)
    else:
        start, end = today, today + timedelta(days=1)
    return local_day_start(start, tz), local_day_start(end, tz)


def half_up(numerator: int, denominator: int) -> int:
    return (2 * numerator + denominator) // (2 * denominator) if numerator >= 0 else -half_up(-numerator, denominator)


async def _rate(db: AsyncSession, model: type[FxRate] | type[StarRate], at: date) -> Any:
    return await db.scalar(select(model).where(model.valid_from <= at).order_by(model.valid_from.desc()).limit(1))


async def summary(db: AsyncSession, period: str, now: datetime) -> dict[str, Any]:
    start, end = bounds(period, now)
    paid_in = (Order.paid_at >= start) & (Order.paid_at < end) & Order.status.in_(PAID)
    web_rev = func.coalesce(func.sum(Order.amount_tiyin), 0)
    by_provider: dict[str, dict[str, int]] = {p: {"orders": 0, "revenue_tiyin": 0} for p in WEB_PROVIDERS}
    for provider, n, rev in (await db.execute(select(Order.provider, func.count(), web_rev).where(
            paid_in, Order.channel == "web").group_by(Order.provider))).all():
        by_provider[str(provider)] = {"orders": int(n), "revenue_tiyin": int(rev or 0)}
    web_revenue = sum(v["revenue_tiyin"] for v in by_provider.values())
    web_orders = sum(v["orders"] for v in by_provider.values())
    refunded_in = (Refund.status == "completed") & (Refund.completed_at >= start) & (Refund.completed_at < end)
    web_refunds = int(await db.scalar(select(func.coalesce(func.sum(Refund.amount_tiyin), 0)).where(refunded_in))
                      or 0)
    stars_refunds = int(await db.scalar(select(func.coalesce(func.sum(Refund.amount_stars), 0)).where(refunded_in))
                        or 0)
    refunds_count = int(await db.scalar(select(func.count()).select_from(Refund).where(refunded_in)) or 0)
    stars_row = (await db.execute(select(
        func.count(), func.coalesce(func.sum(Order.amount_stars), 0),
        func.count().filter(Order.channel == "renewal")).where(paid_in, Order.channel.in_(STARS_CHANNELS)))).one()
    stars_orders, stars_revenue, renewals = int(stars_row[0]), int(stars_row[1] or 0), int(stars_row[2])
    by_product: dict[str, dict[str, int]] = {}
    for code, n, tiyin, stars in (await db.execute(select(
            Order.product_code, func.count(), func.coalesce(func.sum(Order.amount_tiyin), 0),
            func.coalesce(func.sum(Order.amount_stars), 0)).where(paid_in).group_by(Order.product_code))).all():
        by_product[str(code)] = {"orders": int(n), "revenue_tiyin": int(tiyin or 0), "revenue_stars": int(stars or 0)}
    today = now.astimezone(report_zone()).date()
    fx = await _rate(db, FxRate, today)
    star = await _rate(db, StarRate, today)
    net_stars = stars_revenue - stars_refunds
    trials = (Period.source == "trial") & (Period.created_at >= start) & (Period.created_at < end)
    trials_started = int(await db.scalar(select(func.count()).select_from(Period).where(trials)) or 0)
    trial_accounts = select(Period.account_id, Period.created_at).where(trials).subquery()
    converted = int(await db.scalar(select(func.count(func.distinct(trial_accounts.c.account_id))).select_from(
        trial_accounts).join(Order, (Order.account_id == trial_accounts.c.account_id)
                             & (Order.paid_at >= trial_accounts.c.created_at) & Order.status.in_(PAID))) or 0)
    return {
        "period": period, "from": iso(start), "to": iso(end),
        "web": {"revenue_tiyin": web_revenue, "refunds_tiyin": web_refunds, "net_tiyin": web_revenue - web_refunds,
                "orders_paid": web_orders, "by_provider": by_provider},
        "stars": {"revenue_stars": stars_revenue, "refunds_stars": stars_refunds, "net_stars": net_stars,
                  "orders_paid": stars_orders, "renewals": renewals,
                  "est_net_tiyin": net_stars * int(star.star_in_tiyin) if star is not None else None},
        "by_product": by_product, "refunds_count": refunds_count,
        "active_subscriptions": int(await db.scalar(select(func.count()).select_from(Period).where(
            Period.status == "active", Period.source != "trial")) or 0),
        "stars_subscriptions_live": int(await db.scalar(select(func.count()).select_from(StarsSubscription).where(
            StarsSubscription.status.in_(("active", "canceled", "failed")))) or 0),
        "trials_started": trials_started, "trials_converted": converted,
        "conversion_pct": half_up(converted * 100, trials_started) if trials_started else None,
        "minutes": await _minutes(db, start, end),
        "fx": {"usd_in_tiyin": int(fx.usd_in_tiyin), "valid_from": fx.valid_from.isoformat()} if fx else None,
        "star_rate": {"star_in_tiyin": int(star.star_in_tiyin), "valid_from": star.valid_from.isoformat()}
        if star else None,
    }


async def _minutes(db: AsyncSession, start: datetime, end: datetime) -> dict[str, int]:
    m = MinuteLedger.minutes
    row = (await db.execute(select(
        func.coalesce(func.sum(m).filter((MinuteLedger.kind == "grant") | ((MinuteLedger.kind == "adjust") & (m > 0))),
                      0),
        func.coalesce(func.sum(-m).filter(MinuteLedger.kind == "debit"), 0),
        func.coalesce(func.sum(-m).filter(MinuteLedger.kind == "expire"), 0),
        func.coalesce(func.sum(-m).filter(MinuteLedger.kind == "revoke"), 0),
    ).where(MinuteLedger.created_at >= start, MinuteLedger.created_at < end))).one()
    overage = await db.scalar(select(func.coalesce(func.sum(MinuteHold.overage), 0)).where(
        MinuteHold.settled_at >= start, MinuteHold.settled_at < end))
    return {"granted": int(row[0]), "spent": int(row[1]), "expired": int(row[2]), "revoked": int(row[3]),
            "overage": int(overage or 0)}


async def daily(db: AsyncSession, start: date, end: date) -> list[dict[str, Any]]:
    tz = report_zone()
    out: list[dict[str, Any]] = []
    d = start
    while d <= end:
        a, b = local_day_start(d, tz), local_day_start(d + timedelta(days=1), tz)
        paid_in = (Order.paid_at >= a) & (Order.paid_at < b) & Order.status.in_(PAID)
        web, stars, n = (await db.execute(select(
            func.coalesce(func.sum(Order.amount_tiyin), 0), func.coalesce(func.sum(Order.amount_stars), 0),
            func.count()).where(paid_in))).one()
        refunded = (Refund.status == "completed") & (Refund.completed_at >= a) & (Refund.completed_at < b)
        rt, rs = (await db.execute(select(func.coalesce(func.sum(Refund.amount_tiyin), 0),
                                          func.coalesce(func.sum(Refund.amount_stars), 0)).where(refunded))).one()
        trials = await db.scalar(select(func.count()).select_from(Period).where(
            Period.source == "trial", Period.created_at >= a, Period.created_at < b))
        spent = await db.scalar(select(func.coalesce(func.sum(-MinuteLedger.minutes), 0)).where(
            MinuteLedger.kind == "debit", MinuteLedger.created_at >= a, MinuteLedger.created_at < b))
        out.append({"date": d.isoformat(), "web_revenue_tiyin": int(web or 0), "web_refunds_tiyin": int(rt or 0),
                    "stars_revenue_stars": int(stars or 0), "stars_refunds_stars": int(rs or 0), "orders_paid": int(n),
                    "trials_started": int(trials or 0), "minutes_spent": int(spent or 0)})
        d += timedelta(days=1)
    return out


def _rate_view(r: FxRate | StarRate) -> dict[str, Any]:
    base: dict[str, Any] = {"valid_from": r.valid_from.isoformat(), "set_by": staff_ref(r.set_by, r.set_by_name),
                            "reason": r.reason, "created_at": iso(r.created_at)}
    if isinstance(r, FxRate):
        base["usd_in_tiyin"] = int(r.usd_in_tiyin)
    else:
        base["star_in_tiyin"] = int(r.star_in_tiyin)
    return base


async def rates(db: AsyncSession, model: type[FxRate] | type[StarRate]) -> list[dict[str, Any]]:
    rows = (await db.execute(select(model).order_by(model.valid_from.desc()).limit(100))).scalars().all()
    return [_rate_view(cast(FxRate | StarRate, r)) for r in rows]


async def put_rate(db: AsyncSession, actor: Actor, model: type[FxRate] | type[StarRate], value: int,
                   valid_from: date, reason: str, now: datetime) -> dict[str, Any]:
    """Курс на дату (повтор даты — замена); аудит fx_updated / star_rate_updated."""
    lo, hi, field = (100_000, 100_000_000, "usd_in_tiyin") if model is FxRate else (1, 10_000_000, "star_in_tiyin")
    if not lo <= value <= hi:
        raise fx_invalid(field)
    if not 10 <= len(reason.strip()) <= 500:
        raise fx_invalid("reason")
    row = cast(FxRate | StarRate | None, await db.get(model, valid_from, with_for_update=True))
    before = _rate_view(row) if row is not None else None
    if row is None:
        row = model(valid_from=valid_from, set_by=actor.id[:80], set_by_name=(actor.name or "")[:120] or None,
                    reason=reason, created_at=now, **{field: value})
        db.add(row)
    else:
        setattr(row, field, value)
        row.set_by, row.set_by_name, row.reason, row.created_at = actor.id[:80], (actor.name or "")[:120] or None, \
            reason, now
    await db.flush()
    action = "billing.fx_updated" if model is FxRate else "billing.star_rate_updated"
    await emit_audit(db, actor, action, "billing_rate", valid_from.isoformat(), before=before,
                     after={field: value}, reason=reason, at=now)
    return _rate_view(row)
