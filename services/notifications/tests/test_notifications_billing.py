"""Спринт 8 (INTERNAL_API §8, PLAN решение 3, AT-100): уведомления об оплате и подписке.

- События billing.* (только издатель billing) → 9 шаблонов RU/UZ аккаунту-плательщику (детским профилям не
  адресуются); категория service (не выключается, вне лимита 3 сообщений, тихие часы — как у поддержки), запись —
  kind transactional; ключи дедупликации §8; кнопка «Подписка» (route_subscription).
- Шаблон оплаченного заказа выбирается по каналу: miniapp | renewal → payment_succeeded (звёзды), web →
  purchase_applied (нейтрально).
- Анти-стиринг каталога шаблонов: во всех шаблонах на всех вариантах параметров — нет URL, кроме startapp, нет
  названий Payme / Click / Uzum, адреса или упоминания сайта, «сум» / «soʻm» и сумм; у заказов сайта — ни суммы, ни
  способа оплаты, ни звёзд.
"""

from __future__ import annotations

import itertools
import logging
import re
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from notif_testkit import at, local_day, quiet_around_now

from tilhero_common.messaging import Envelope, make_envelope
from tilhero_notifications.consumers import order_paid_template
from tilhero_notifications.templates import BILLING_TEMPLATES, TEMPLATES, Context

DAY = local_day(1)
NOON = at(DAY, "12:00")
ROUTE = "route_subscription"


def iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z")


def titles(ru: str = "Плюс 30 дней", uz: str = "Plus 30 kun") -> dict[str, str]:
    return {"ru": ru, "uz": uz}


async def paid(env, account: uuid.UUID, *, channel: str = "miniapp", kind: str = "subscription",
               beneficiary: uuid.UUID | None = None, stars: int | None = 300, tiyin: int | None = None,
               til: int | None = None, ends_at: datetime | None = None, order_id: uuid.UUID | None = None,
               producer: str = "billing", provider: str | None = None, scheduled: bool = False) -> Envelope:
    fiat = channel == "web"
    payload: dict[str, Any] = {
        "order_id": str(order_id or uuid.uuid4()), "order_no": 100_123, "account_id": str(account),
        "beneficiary_user_id": str(beneficiary or account), "channel": channel, "product_kind": kind,
        "product_code": "plus_30" if kind == "subscription" else "til_550",
        "product_title": titles() if kind == "subscription" else titles("550 тилов", "550 til"),
        "currency": "UZS" if fiat else "XTR",
        "amount_tiyin": (tiyin or 4_900_000) if fiat else None, "amount_stars": None if fiat else stars,
        "provider": provider or ("payme" if fiat else "telegram_stars"), "til": til,
        "period": ({"starts_at": None, "ends_at": None} if scheduled else
                   {"starts_at": iso(NOON), "ends_at": iso(ends_at or NOON + timedelta(days=30))})
        if kind == "subscription" else None,
        "paid_at": iso(NOON)}
    return await env.publish("billing.order.paid.v1", payload, producer=producer)


async def refunded(env, account: uuid.UUID | None, *, channel: str = "miniapp", kind: str = "subscription",
                   order_id: uuid.UUID | None = None, stars: int = 300) -> Envelope:
    fiat = channel == "web"
    return await env.publish("billing.order.refunded.v1", {
        "order_id": str(order_id or uuid.uuid4()), "order_no": 100_124,
        "account_id": str(account) if account else None, "beneficiary_user_id": str(account) if account else None,
        "channel": channel, "product_kind": kind, "currency": "UZS" if fiat else "XTR",
        "amount_tiyin": 4_900_000 if fiat else None, "amount_stars": None if fiat else stars,
        "refund_id": str(uuid.uuid4()), "initiated_by": "staff", "refunded_at": iso(NOON)}, producer="billing")


def texts(env, user: uuid.UUID) -> list[str]:
    return [c["text"] for c in env.gateway.to(env.telegram_id(user))]


# ---------------------------------------------------------------- заказы и канал


async def test_payment_succeeded_stars_and_renewal(env) -> None:
    user = env.add_user()
    order = uuid.uuid4()
    await paid(env, user, order_id=order, ends_at=at(DAY + timedelta(days=30), "12:00"))
    await paid(env, user, order_id=order)  # повтор события — без второго сообщения (payment:<order_id>)
    await paid(env, user, channel="renewal", stars=300)
    await env.dispatch(at(DAY, "12:01"))
    until = (DAY + timedelta(days=30)).strftime("%d.%m")
    sent = texts(env, user)
    assert sorted(sent) == sorted([
        f"<b>Оплата прошла</b>\n«Плюс 30 дней» — ⭐ 300. Подписка активна до {until}.",
        f"<b>Подписка продлена</b>\n«Плюс 30 дней» — ⭐ 300. Подписка активна до {until}."])
    rows = await env.rows(user)
    assert {(r.template, r.category, r.kind, r.dedup_key.split(":")[0]) for r in rows} == {
        ("payment_succeeded", "service", "transactional", "payment")}
    assert {c["buttons"][0][0]["startapp"] for c in env.gateway.to(env.telegram_id(user))} == {ROUTE}
    assert len(rows) == 2


async def test_purchase_applied_web_is_neutral(env) -> None:
    user = env.add_user(locale="uz")
    child = env.add_child(user)
    await paid(env, user, channel="web", ends_at=at(DAY + timedelta(days=90), "12:00"), provider="click")
    await paid(env, user, channel="web", kind="til_pack", til=550, beneficiary=child, provider="uzum")
    await paid(env, user, channel="web", scheduled=True)
    await env.dispatch(at(DAY, "12:01"))
    until = (DAY + timedelta(days=90)).strftime("%d.%m")
    assert sorted(texts(env, user)) == sorted([
        f"<b>Obuna faol</b>\nObuna {until} gacha faol: SI bilan darslar va juftlikda darslar ochiq.",
        "<b>Tillar qoʻshildi</b>\nBola profiliga: +550 til.",
        "<b>Obuna davom etadi</b>\nObunaning keyingi davri joriy davr tugashi bilan boshlanadi."])
    # адресат — аккаунт-плательщик, не детский профиль
    assert await env.rows(child) == []
    assert {r.template for r in await env.rows(user)} == {"purchase_applied"}
    joined = " ".join(texts(env, user)).lower()
    for word in ("payme", "click", "uzum", "soʻm", "49 000", "⭐", "100123", "100 123"):
        assert word not in joined


@pytest.mark.parametrize("channel,template", [("miniapp", "payment_succeeded"), ("renewal", "payment_succeeded"),
                                              ("web", "purchase_applied")])
def test_template_by_channel(channel: str, template: str) -> None:
    from tilhero_notifications.consumers import OrderPaid

    fiat = channel == "web"
    account = uuid.uuid4()
    op = OrderPaid.model_validate({
        "order_id": str(uuid.uuid4()), "order_no": 100_001, "account_id": str(account),
        "beneficiary_user_id": str(account), "channel": channel, "product_kind": "til_pack",
        "product_code": "til_100", "product_title": titles("100 тилов", "100 til"),
        "currency": "UZS" if fiat else "XTR", "amount_tiyin": 500_000 if fiat else None,
        "amount_stars": None if fiat else 50, "provider": "click" if fiat else "telegram_stars", "til": 100,
        "period": None, "paid_at": iso(NOON)})
    name, params = order_paid_template(op)
    assert name == template
    TEMPLATES[name].validate(params)
    # суммы в тийинах и провайдер в параметры записи не попадают ни в каком канале
    assert "amount_tiyin" not in params and "provider" not in params
    assert ("amount_stars" in params) == (not fiat)


async def test_refund_by_channel_and_anonymized(env) -> None:
    user = env.add_user()
    await refunded(env, user, channel="miniapp", stars=300)
    await refunded(env, user, channel="web", kind="til_pack")
    await refunded(env, None, channel="web")  # обезличенный заказ — сообщать некому
    await env.dispatch(at(DAY, "12:01"))
    assert sorted(texts(env, user)) == sorted([
        "<b>Возврат оформлен</b>\n⭐ 300 вернутся на баланс Telegram Stars. Период подписки по этому заказу завершён.",
        "<b>Возврат оформлен</b>\nДеньги вернутся тем же способом, которым была оплата."])
    assert len(await env.rows()) == 2


# ---------------------------------------------------------------- подписка, минуты, корректировки


async def test_subscription_lifecycle_messages(env) -> None:
    user = env.add_user()
    period, stars_sub = uuid.uuid4(), uuid.uuid4()
    ends = at(DAY + timedelta(days=3), "23:00")
    for days_left in (3, 3, 0):  # повтор дня — без дубля; день окончания — отдельное
        await env.publish("billing.subscription.expiring.v1", {
            "account_id": str(user), "period_id": str(period), "ends_at": iso(ends), "days_left": days_left,
            "minutes_left": 45}, producer="billing")
    await env.publish("billing.subscription.changed.v1", {
        "account_id": str(user), "status": "expired", "reason": "ended", "period_id": str(period),
        "product_code": "plus_30", "starts_at": iso(NOON), "ends_at": iso(ends), "minutes_granted": 300,
        "changed_at": iso(NOON)}, producer="billing")
    # активация и прочие изменения — без сообщения
    await env.publish("billing.subscription.changed.v1", {
        "account_id": str(user), "status": "active", "reason": "purchase", "period_id": str(uuid.uuid4()),
        "product_code": "plus_30", "starts_at": iso(NOON), "ends_at": iso(ends), "minutes_granted": 300,
        "changed_at": iso(NOON)}, producer="billing")
    for status in ("failed", "failed", "canceled", "active"):
        await env.publish("billing.stars_subscription.changed.v1", {
            "account_id": str(user), "subscription_id": str(stars_sub), "status": status, "expires_at": iso(ends),
            "changed_at": iso(NOON)}, producer="billing")
    await env.publish("billing.minutes.low.v1", {"account_id": str(user), "period_id": str(period),
                                                 "minutes_left": 21, "minutes_granted": 300}, producer="billing")
    await env.publish("billing.minutes.low.v1", {"account_id": str(user), "period_id": str(period),
                                                 "minutes_left": 5, "minutes_granted": 300}, producer="billing")
    await env.dispatch(at(DAY, "12:01"))
    until = (DAY + timedelta(days=3)).strftime("%d.%m")  # 23:00 по Ташкенту — тот же местный день
    assert sorted(texts(env, user)) == sorted([
        f"<b>Подписка закончится через 3 дня</b>\nДействует до {until}. Осталось 45 минут уроков с ИИ — остаток на "
        "следующий период не переносится.",
        f"<b>Подписка заканчивается сегодня</b>\nДействует до {until}. Осталось 45 минут уроков с ИИ — остаток на "
        "следующий период не переносится.",
        "<b>Подписка закончилась</b>\nБазовый курс, повторения, чтение и игра доступны как обычно. Уроки с ИИ и "
        "уроки вдвоём — снова с подпиской.",
        f"<b>Не удалось продлить подписку</b>\nНа балансе не хватило Stars. Подписка действует до {until}.",
        "<b>Минуты заканчиваются</b>\nОсталось 21 минуту из 300 для уроков с ИИ. Начатый урок всегда можно "
        "закончить."])
    keys = sorted(r.dedup_key for r in await env.rows(user))
    assert keys == sorted([f"expiring:{period}:3", f"expiring:{period}:0", f"expired:{period}",
                           f"renewal_failed:{stars_sub}:{ends.isoformat()}", f"minutes_low:{period}"])


async def test_trial_center_only_and_adjustments(env) -> None:
    user = env.add_user(locale="uz")
    period = uuid.uuid4()
    await env.publish("billing.subscription.changed.v1", {
        "account_id": str(user), "status": "trial", "reason": "trial", "period_id": str(period),
        "product_code": None, "starts_at": iso(NOON), "ends_at": iso(NOON + timedelta(days=7)),
        "minutes_granted": 60, "changed_at": iso(NOON)}, producer="billing")
    for kind, minutes, days in (("minutes", 30, None), ("minutes", -10, None), ("grant_period", None, 7),
                                ("revoke_period", None, None)):
        await env.publish("billing.adjustment.applied.v1", {
            "adjustment_id": str(uuid.uuid4()), "account_id": str(user), "kind": kind, "minutes": minutes,
            "days": days, "period_id": None, "applied_at": iso(NOON)}, producer="billing")
    await env.dispatch(at(DAY, "12:01"))
    # пробный — только центр (§8); списание минут и отзыв — без сообщения
    assert sorted(texts(env, user)) == sorted([
        "<b>Daqiqalar qoʻshildi</b>\nSI bilan darslar uchun sizga 30 daqiqa qoʻshildi.",
        "<b>Obuna ulandi</b>\nSizga obuna davri ulandi: 7 kun."])
    rows = {r.template: r for r in await env.rows(user)}
    assert set(rows) == {"trial_started", "minutes_adjusted"} and len(await env.rows(user)) == 3
    assert (rows["trial_started"].telegram_status, rows["trial_started"].reason) == ("in_app_only", "center_only")
    items = (await env.inbox(user))["items"]
    trial = next(i for i in items if i["title"] == "Sinov davri boshlandi")
    until = (NOON + timedelta(days=7)).astimezone(ZoneInfo("Asia/Tashkent")).strftime("%d.%m")
    assert trial["body"] == f"{until} gacha: SI bilan darslar uchun 60 daqiqa va juftlikda darslar."
    assert trial["category"] == "service"


# ---------------------------------------------------------------- политика: service, лимит, тихие часы


async def test_service_category_quiet_hours_and_outside_daily_limit(env) -> None:
    # категория service не выключается настройкой категорий; тихие часы — как у ответов поддержки
    user = env.add_user(categories=("support",), quiet=quiet_around_now())
    await paid(env, user)
    await env.dispatch()
    [row] = await env.rows(user)
    assert (row.telegram_status, row.reason) == ("scheduled", "quiet_hours")
    assert texts(env, user) == []
    # вне лимита 3 сообщений в сутки: 5 сообщений оплаты уходят все
    busy = env.add_user()
    for _ in range(5):
        await paid(env, busy, channel="renewal")
    await env.dispatch(at(DAY, "12:01"))
    assert len(texts(env, busy)) == 5
    assert all(r.limit_day is None for r in await env.rows(busy))
    # выключенная доставка Telegram — только центр (транзакционный обход — только у кода PIN)
    off = env.add_user(enabled=False)
    await paid(env, off)
    await env.dispatch(at(DAY, "12:02"))
    [row] = await env.rows(off)
    assert (row.telegram_status, row.reason) == ("in_app_only", "notifications_disabled")


async def test_foreign_producer_deleted_account_and_dlq(env, caplog) -> None:
    caplog.set_level(logging.WARNING, logger="tilhero.notifications.consumers")
    user = env.add_user()
    await paid(env, user, producer="gamification")
    await env.publish("billing.minutes.low.v1", {"account_id": str(user), "period_id": str(uuid.uuid4()),
                                                 "minutes_left": 1, "minutes_granted": 60}, producer="lessons")
    assert await env.rows(user) == []
    warned = [r for r in caplog.records if r.getMessage() == "billing event from unexpected producer ignored"]
    assert len(warned) == 2 and all(str(user) not in str(r.__dict__) for r in warned)
    await env.delete(user)
    await paid(env, user)
    assert await env.rows(user) == []
    bad = make_envelope("billing.order.paid.v1", {"order_id": str(uuid.uuid4())}, producer="billing")
    await env.bus.publish(bad)
    assert [e.event_id for _, e in env.bus.dlq] == [bad.event_id]


async def test_staff_templates_do_not_list_billing(env) -> None:
    from test_notifications_staff_templates import MANAGE

    r = await env.client.get("/admin/v1/notifications/templates", headers=env.staff(MANAGE))
    assert r.status_code == 200
    assert not set(BILLING_TEMPLATES) & {i["key"] for i in r.json()["items"]}
    r = await env.client.get("/admin/v1/notifications/templates/payment_succeeded", headers=env.staff(MANAGE))
    assert r.status_code == 404 and r.json()["code"] == "TEMPLATE_NOT_FOUND"


# ---------------------------------------------------------------- анти-стиринг каталога шаблонов (AT-100)

URL = re.compile(r"(https?://|www\.|t\.me/|tg://|\b[a-z0-9-]+\.(uz|com|ru|org|net|app|io|me|dev)\b)", re.I)
FIAT = re.compile(r"payme|paycom|click|uzum|apelsin|humo|uzcard", re.I)
SITE = re.compile(r"сайт|веб|web|internet|интернет|sayt|brauzer|браузер|другим способом|дешевле|arzon|boshqa usul",
                  re.I)
SOUM = re.compile(r"\bсум|soʻm|so'm|so‘m|som\b|uzs|тийин|tiyin", re.I)
STARS = re.compile(r"⭐|stars", re.I)

VARIANTS: dict[str, list[dict[str, Any]]] = {
    "payment_succeeded": [
        {"order_no": 100_042, "product_kind": kind, "product_title": titles(), "amount_stars": stars,
         "renewal": renewal, "ends_at": ends, "til": til, "for_child": child}
        for kind, stars, renewal, ends, til, child in itertools.product(
            ("subscription", "til_pack"), (1, 10_000), (False, True), (None, "2026-12-22T19:00:00Z"), (None, 550),
            (False, True))],
    "purchase_applied": [
        {"order_id": str(uuid.uuid4()), "product_kind": kind, "ends_at": ends, "til": til, "for_child": child}
        for kind, ends, til, child in itertools.product(
            ("subscription", "til_pack"), (None, "2027-02-20T19:00:00Z"), (None, 1, 100_000), (False, True))],
    "refund_completed": [
        {"order_id": str(uuid.uuid4()), "stars": stars, "product_kind": kind, "amount_stars": amount}
        for stars, kind, amount in itertools.product((False, True), ("subscription", "til_pack"), (None, 300))],
    "subscription_expiring": [
        {"period_id": str(uuid.uuid4()), "ends_at": "2026-12-22T19:00:00Z", "days_left": d, "minutes_left": m}
        for d, m in itertools.product((0, 1, 3, 30), (0, 1, 299))],
    "subscription_expired": [{"period_id": str(uuid.uuid4())}],
    "stars_renewal_failed": [{"subscription_id": str(uuid.uuid4()), "expires_at": "2026-12-22T19:00:00Z"}],
    "minutes_low": [{"period_id": str(uuid.uuid4()), "minutes_left": m, "minutes_granted": 300} for m in (0, 21, 30)],
    "minutes_adjusted": [{"adjustment_id": str(uuid.uuid4()), "kind": "minutes", "minutes": 30},
                         {"adjustment_id": str(uuid.uuid4()), "kind": "grant_period", "days": 7}],
    "trial_started": [{"period_id": str(uuid.uuid4()), "ends_at": "2026-11-29T19:00:00Z", "minutes_granted": 60}],
}


def _all_renders(name: str) -> list[tuple[str, Any, dict[str, Any]]]:
    spec = TEMPLATES[name]
    params_list = VARIANTS.get(name) or [spec.sample]
    out = []
    for params in params_list:
        for locale in ("ru", "uz"):
            out.append((locale, spec.render(locale, params, Context(timezone="Asia/Tashkent")), params))
    return out


def test_billing_variants_cover_all_templates() -> None:
    assert set(VARIANTS) == set(BILLING_TEMPLATES)


@pytest.mark.parametrize("name", sorted(TEMPLATES))
def test_catalog_has_no_links_fiat_providers_site_or_soum(name: str) -> None:
    """Весь каталог шаблонов (не только оплата): ни ссылок, кроме кнопки startapp, ни Payme/Click/Uzum, ни сайта, ни
    сумов — ни в title/body/кнопке, ни в HTML Telegram, ни в startapp."""
    spec = TEMPLATES[name]
    for locale, r, _ in _all_renders(name) if name in VARIANTS else [
            (loc, spec.render(loc, spec.sample or _fixture(name), Context(timezone="Asia/Tashkent")), {})
            for loc in ("ru", "uz")]:
        text = " ".join([r.title, r.body, r.button, r.telegram_text()])
        assert not URL.search(text), (name, locale, text)
        assert not FIAT.search(text), (name, locale, text)
        assert not SOUM.search(text), (name, locale, text)
        if r.startapp is not None:
            assert re.fullmatch(r"[A-Za-z0-9_-]{1,64}", r.startapp), (name, r.startapp)
            assert not URL.search(r.startapp)
        for row in r.buttons():
            for button in row:
                assert set(button) == {"text", "startapp"}, (name, button)  # только startapp, без url
        if name in BILLING_TEMPLATES:
            assert not SITE.search(text), (name, locale, text)
            assert r.startapp == ROUTE and r.button in ("Открыть подписку", "Obunani ochish")


@pytest.mark.parametrize("variant", VARIANTS["purchase_applied"] + [
    v for v in VARIANTS["refund_completed"] if not v["stars"]])
def test_web_orders_are_neutral(variant: dict[str, Any]) -> None:
    """Заказ сайта (purchase_applied, refund_completed web): без суммы, способа оплаты и звёзд."""
    name = "purchase_applied" if "stars" not in variant else "refund_completed"
    for locale in ("ru", "uz"):
        r = TEMPLATES[name].render(locale, variant, Context(timezone="Asia/Tashkent"))
        text = f"{r.title} {r.body}"
        assert not STARS.search(text) and not FIAT.search(text) and not SOUM.search(text), text
        # ни сумм, ни номера заказа: из чисел — только «+N тилов» и дата периода
        rest = re.sub(r"\+\d+ (тил\w*|til)|\d{2}\.\d{2}", "", text)
        assert not re.search(r"\d", rest), text


def _fixture(name: str) -> dict[str, Any]:
    from test_notifications_templates import PARAMS

    return PARAMS[name]
