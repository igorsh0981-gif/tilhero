"""Telegram Stars в webhook (INTERNAL_API спринта 8 §2): pre_checkout_query → identity-consent → billing →
answerPreCheckoutQuery в теле ответа (таймауты 2 + 3 с внутри 10 с), successful_payment / refunded_payment /
subscription → billing с отметкой update_id только после 2xx (иначе 503 и повтор Telegram без двойного зачисления),
команды /paysupport, /support, /terms (RU/UZ, без ссылок на сайт оплаты), логи без Telegram ID и charge id."""

from __future__ import annotations

import asyncio
import io
import logging
import time
from typing import Any

import httpx
import pytest
from botgw_testkit import ACCOUNT_ID, APP_LINK, MINIAPP, TG_USER, make_settings
from pydantic import ValidationError

from tilhero_botgw import texts
from tilhero_botgw.settings import Settings
from tilhero_common.internal_auth import verify_token
from tilhero_common.logging import JsonFormatter

PAYLOAD = "o:3f2b8c1e-6a4d-4e0b-9c71-2d5e8f1a7b90"
CHARGE = "stxTEST_charge_0001_secret"
UNAVAILABLE_RU = "Оплата временно недоступна. Попробуйте ещё раз через несколько минут."
UNAVAILABLE_UZ = "Toʻlov vaqtincha mavjud emas. Bir necha daqiqadan soʻng qayta urinib koʻring."


def user(uid: int = TG_USER, lang: str | None = "ru") -> dict[str, Any]:
    u: dict[str, Any] = {"id": uid, "is_bot": False, "first_name": "Игорь"}
    if lang:
        u["language_code"] = lang
    return u


def pre_checkout(gw, *, qid: str = "pcq-1", uid: int = TG_USER, lang: str | None = "ru", amount: Any = 250,
                 payload: Any = PAYLOAD, currency: Any = "XTR") -> dict[str, Any]:
    q: dict[str, Any] = {"id": qid, "from": user(uid, lang), "currency": currency, "total_amount": amount,
                         "invoice_payload": payload}
    return {"update_id": gw.next_update_id(), "pre_checkout_query": {k: v for k, v in q.items() if v is not None}}


def successful_payment(gw, *, charge: str = CHARGE, uid: int = TG_USER, recurring: bool = False,
                       first: bool = False, expires: int | None = None, update_id: int | None = None,
                       **sp_extra: Any) -> dict[str, Any]:
    sp: dict[str, Any] = {"currency": "XTR", "total_amount": 250, "invoice_payload": PAYLOAD,
                          "telegram_payment_charge_id": charge, "provider_payment_charge_id": "pp-1"}
    if recurring:
        sp["is_recurring"] = True
    if first:
        sp["is_first_recurring"] = True
    if expires is not None:
        sp["subscription_expiration_date"] = expires
    sp.update(sp_extra)
    return {"update_id": update_id or gw.next_update_id(),
            "message": {"message_id": 7, "date": 1_763_802_000, "from": user(uid),
                        "chat": {"id": uid, "type": "private"}, "successful_payment": sp}}


def refunded_payment(gw, *, charge: str = CHARGE) -> dict[str, Any]:
    return {"update_id": gw.next_update_id(),
            "message": {"message_id": 8, "date": 1_763_900_000, "from": user(), "chat": {"id": TG_USER,
                                                                                    "type": "private"},
                        "refunded_payment": {"currency": "XTR", "total_amount": 250, "invoice_payload": PAYLOAD,
                                             "telegram_payment_charge_id": charge}}}


def subscription_update(gw, state: str, *, uid: int = TG_USER) -> dict[str, Any]:
    return {"update_id": gw.next_update_id(),
            "subscription": {"user": user(uid), "invoice_payload": PAYLOAD, "state": state}}


# ---------------------------------------------------------------- pre_checkout_query

async def test_pre_checkout_ok_is_answered_in_webhook_body(gw) -> None:
    t0 = time.perf_counter()
    r = await gw.webhook(pre_checkout(gw))
    assert time.perf_counter() - t0 < 10
    assert r.status_code == 200
    assert r.json() == {"method": "answerPreCheckoutQuery", "pre_checkout_query_id": "pcq-1", "ok": True}
    assert gw.telegram.calls == []  # ответ — в теле webhook, без отдельного исходящего вызова
    assert gw.identity.lookups == [f"/internal/v1/telegram-users/{TG_USER}/account"]
    [call] = gw.billing.calls
    assert call["path"] == "/internal/v1/stars/pre-checkout"
    assert call["json"] == {"query_id": "pcq-1", "account_id": ACCOUNT_ID, "currency": "XTR", "total_amount": 250,
                            "invoice_payload": PAYLOAD}
    assert str(TG_USER) not in str(call["json"])  # Telegram ID в billing не попадает
    principal = verify_token(call["headers"]["x-internal-token"], "t" * 40, audience="billing")
    assert principal.issuer == "telegram-bot-gateway"


@pytest.mark.parametrize(("error", "lang", "text"), [
    ("order_not_found", "ru", "Счёт устарел или отменён. Откройте TilHero и оформите покупку заново."),
    ("order_closed", "uz", "Hisob eskirgan yoki bekor qilingan. TilHeroʼni oching va xaridni qaytadan "
                           "rasmiylashtiring."),
    ("amount_mismatch", "ru", "Стоимость в счёте не совпадает с заказом. Оформите покупку заново в TilHero."),
    ("payer_mismatch", "ru", "Этот счёт оформлен в другом аккаунте TilHero. Откройте TilHero и оформите покупку в "
                             "своём профиле."),
    ("already_paid", "uz", "Bu hisob allaqachon toʻlangan — xarid TilHeroʼda koʻrinadi."),
    ("subscription_exists", "ru", "Подписка TilHero Плюс уже активна. Управлять ею можно в TilHero → «Подписка»."),
    ("payments_disabled", "uz", "TilHeroʼda xaridlar hozir mavjud emas. Keyinroq urinib koʻring."),
    ("something_new", "ru", UNAVAILABLE_RU),
])
async def test_pre_checkout_rejection_texts(gw, error: str, lang: str, text: str) -> None:
    gw.billing.pre_checkout = {"ok": False, "error": error}
    reply = (await gw.webhook(pre_checkout(gw, lang=lang))).json()
    assert reply == {"method": "answerPreCheckoutQuery", "pre_checkout_query_id": "pcq-1", "ok": False,
                     "error_message": text}


async def test_pre_checkout_account_being_deleted_is_refused(gw) -> None:
    """identity-consent status DELETION_REQUESTED: новых покупок нет — отказ без обращения к billing; платёж по уже
    одобренному счёту всё равно уходит в billing (пункт сверки paid_after_deletion)."""
    gw.identity.statuses_by_user[TG_USER] = "DELETION_REQUESTED"
    reply = (await gw.webhook(pre_checkout(gw))).json()
    assert reply["ok"] is False and reply["error_message"] == texts.PRE_CHECKOUT_ERRORS["ru"]["order_closed"]
    assert gw.billing.calls == []
    assert (await gw.webhook(successful_payment(gw))).status_code == 200
    assert gw.billing.calls[0]["json"]["account_id"] == ACCOUNT_ID


async def test_pre_checkout_unknown_telegram_user_goes_as_null_account(gw) -> None:
    gw.billing.pre_checkout = {"ok": False, "error": "payer_mismatch"}
    reply = (await gw.webhook(pre_checkout(gw, uid=111))).json()
    assert reply["ok"] is False and gw.billing.calls[0]["json"]["account_id"] is None


@pytest.mark.parametrize("setup", ["identity_500", "billing_503", "billing_network", "malformed_amount",
                                   "malformed_payload", "bool_amount"])
async def test_pre_checkout_failures_answer_unavailable(gw, setup: str) -> None:
    update = pre_checkout(gw, lang="uz")
    if setup == "identity_500":
        gw.identity.lookup_statuses = [500, 500, 500]
    elif setup == "billing_503":
        gw.billing.queue = [(503, {"code": "BILLING_NOT_READY", "message": "x", "trace_id": "t", "details": {}})]
    elif setup == "billing_network":
        gw.billing.queue = [httpx.ConnectError("down")]
    elif setup == "malformed_amount":
        update = pre_checkout(gw, lang="uz", amount=None)
    elif setup == "malformed_payload":
        update = pre_checkout(gw, lang="uz", payload="я" * 70)
    else:
        update = pre_checkout(gw, lang="uz", amount=True)
    reply = (await gw.webhook(update)).json()
    assert reply == {"method": "answerPreCheckoutQuery", "pre_checkout_query_id": "pcq-1", "ok": False,
                     "error_message": UNAVAILABLE_UZ}
    if setup in ("identity_500", "malformed_amount", "malformed_payload", "bool_amount"):
        assert gw.billing.calls == []


async def test_pre_checkout_timeouts_fit_bot_api_limit(fast_gw) -> None:
    """Таймауты identity-consent и billing срабатывают — ответ всё равно уходит (в пропорции 2 + 3 из 10 с)."""
    gw = fast_gw
    gw.billing.queue = [("sleep", 2.0)]
    t0 = time.perf_counter()
    reply = (await gw.webhook(pre_checkout(gw))).json()
    elapsed = time.perf_counter() - t0
    assert reply["ok"] is False and reply["error_message"] == UNAVAILABLE_RU
    assert elapsed < 0.2 + 0.3 + 0.3
    gw.identity.lookup_statuses = [("sleep", 2.0)]
    t0 = time.perf_counter()
    reply = (await gw.webhook(pre_checkout(gw, qid="pcq-2"))).json()
    assert reply["ok"] is False and time.perf_counter() - t0 < 0.2 + 0.3
    assert len(gw.billing.calls) == 1  # без аккаунта billing не вызывается


def test_pre_checkout_default_budget_within_ten_seconds() -> None:
    s = make_settings("t_stars_budget")
    assert (s.stars_identity_timeout_seconds, s.stars_pre_checkout_timeout_seconds) == (2.0, 3.0)
    assert s.stars_identity_timeout_seconds + s.stars_pre_checkout_timeout_seconds <= 9 < 10
    assert s.stars_update_deadline_seconds <= 9
    with pytest.raises(ValidationError):
        make_settings("t_stars_budget", stars_identity_timeout_seconds=5, stars_pre_checkout_timeout_seconds=5)


async def test_pre_checkout_redelivery_is_answered_again(gw) -> None:
    """update_id у pre_checkout_query не отмечается: повтор доставки (ответ потерялся) снова получает ответ."""
    update = pre_checkout(gw)
    first, second = await gw.webhook(update), await gw.webhook(update)
    assert first.json() == second.json() and first.json()["ok"] is True
    assert len(gw.billing.calls) == 2  # billing отвечает тем же по query_id


async def test_pre_checkout_without_id_is_ignored(gw) -> None:
    update = pre_checkout(gw)
    del update["pre_checkout_query"]["id"]
    assert (await gw.webhook(update)).json() == {"ok": True} and gw.billing.calls == []


# ---------------------------------------------------------------- successful_payment

async def test_successful_payment_forwarded_and_marked(gw) -> None:
    update = successful_payment(gw)
    r = await gw.webhook(update)
    assert r.status_code == 200 and r.json() == {"ok": True}  # без ответа пользователю: сообщение — сервисное
    [call] = gw.billing.calls
    assert call["path"] == "/internal/v1/stars/payments"
    assert call["json"] == {
        "telegram_payment_charge_id": CHARGE, "currency": "XTR", "total_amount": 250, "invoice_payload": PAYLOAD,
        "is_recurring": False, "is_first_recurring": False, "subscription_expiration_date": None,
        "paid_at": "2025-11-22T09:00:00+00:00", "account_id": ACCOUNT_ID}
    assert "provider_payment_charge_id" not in call["json"] and str(TG_USER) not in str(call["json"])
    again = await gw.webhook(update)  # повтор того же update_id — billing не вызывается
    assert again.status_code == 200 and len(gw.billing.calls) == 1 and gw.telegram.calls == []


async def test_subscription_payments_first_and_renewal(gw) -> None:
    await gw.webhook(successful_payment(gw, charge="stxTEST-first", recurring=True, first=True,
                                        expires=1_766_394_000))
    await gw.webhook(successful_payment(gw, charge="stxTEST-renew", recurring=True, expires=1_768_986_000))
    first, renewal = (c["json"] for c in gw.billing.calls)
    assert (first["is_recurring"], first["is_first_recurring"]) == (True, True)
    assert first["subscription_expiration_date"] == "2025-12-22T09:00:00+00:00"
    assert (renewal["is_recurring"], renewal["is_first_recurring"]) == (True, False)
    assert gw.billing.credited == ["stxTEST-first", "stxTEST-renew"]


async def test_billing_5xx_gives_503_and_redelivery_credits_once(gw) -> None:
    update = successful_payment(gw)
    err = (500, {"code": "INTERNAL_ERROR", "message": "x", "trace_id": "t", "details": {}})
    gw.billing.queue = [err, err]  # попытка и один повтор — обе 5xx
    r = await gw.webhook(update)
    assert r.status_code == 503 and r.json()["code"] == "WEBHOOK_UNAVAILABLE"
    assert len(gw.billing.calls) == 2 and gw.billing.credited == []
    redelivery = await gw.webhook(update)  # Telegram повторил — billing ответил 2xx
    assert redelivery.status_code == 200 and gw.billing.credited == [CHARGE]
    third = await gw.webhook(update)  # дубль после отметки
    assert third.status_code == 200 and len(gw.billing.calls) == 3 and gw.billing.credited == [CHARGE]


async def test_billing_network_error_is_retried_once(gw) -> None:
    gw.billing.queue = [httpx.ConnectError("blip")]
    r = await gw.webhook(successful_payment(gw))
    assert r.status_code == 200 and len(gw.billing.calls) == 2 and gw.billing.credited == [CHARGE]


async def test_billing_4xx_is_not_retried_but_not_marked(gw) -> None:
    update = successful_payment(gw)
    gw.billing.queue = [(409, {"code": "INVALID_STATE", "message": "x", "trace_id": "t", "details": {}})]
    assert (await gw.webhook(update)).status_code == 503 and len(gw.billing.calls) == 1
    assert (await gw.webhook(update)).status_code == 200 and gw.billing.credited == [CHARGE]


async def test_identity_unavailable_postpones_payment(gw) -> None:
    update = successful_payment(gw)
    gw.identity.lookup_statuses = [503, 503, 503]
    assert (await gw.webhook(update)).status_code == 503 and gw.billing.calls == []
    assert (await gw.webhook(update)).status_code == 200 and gw.billing.credited == [CHARGE]


async def test_unknown_payer_payment_still_forwarded(gw) -> None:
    """Деньги получены: Telegram-пользователь без аккаунта — billing получает account_id null (пункт сверки)."""
    await gw.webhook(successful_payment(gw, uid=555))
    assert gw.billing.calls[0]["json"]["account_id"] is None and gw.billing.credited == [CHARGE]


async def test_parallel_duplicate_delivery_processed_once(gw) -> None:
    update = successful_payment(gw)
    gw.billing.delay = 0.2
    results = await asyncio.gather(gw.webhook(update), gw.webhook(update), gw.webhook(update))
    assert sorted(r.status_code for r in results) == [200, 503, 503]
    assert len(gw.billing.calls) == 1
    assert (await gw.webhook(update)).status_code == 200 and len(gw.billing.calls) == 1


async def test_payment_update_deadline(fast_gw) -> None:
    gw = fast_gw
    gw.billing.queue = [("sleep", 2.0), ("sleep", 2.0)]
    t0 = time.perf_counter()
    r = await gw.webhook(successful_payment(gw))
    assert r.status_code == 503 and time.perf_counter() - t0 < 0.5 + 0.3


async def test_malformed_payment_update_is_acknowledged(gw) -> None:
    for broken in ({"telegram_payment_charge_id": ""}, {"telegram_payment_charge_id": "x" * 129},
                   {"total_amount": "250"}, {"currency": None}, {"invoice_payload": "я" * 70}):
        update = successful_payment(gw, **broken)
        assert (await gw.webhook(update)).json() == {"ok": True}
    assert gw.billing.calls == []


# ---------------------------------------------------------------- refunded_payment и subscription

async def test_refunded_payment_forwarded(gw) -> None:
    r = await gw.webhook(refunded_payment(gw))
    assert r.json() == {"ok": True}
    [call] = gw.billing.calls
    assert call["path"] == "/internal/v1/stars/refunds-received"
    assert call["json"] == {"telegram_payment_charge_id": CHARGE, "total_amount": 250, "invoice_payload": PAYLOAD}
    assert gw.identity.lookups == []  # плательщик для возврата не нужен
    gw.billing.queue = [(409, {"code": "STARS_TXN_NOT_FOUND", "message": "x", "trace_id": "t", "details": {}})]
    assert (await gw.webhook(refunded_payment(gw, charge="stxTEST-early"))).status_code == 503  # Telegram повторит


@pytest.mark.parametrize("state", ["canceled", "active", "failed"])
async def test_subscription_update_forwarded(gw, state: str) -> None:
    r = await gw.webhook(subscription_update(gw, state))
    assert r.json() == {"ok": True}
    [call] = gw.billing.calls
    assert call["path"] == "/internal/v1/stars/subscription-updates"
    assert call["json"] == {"account_id": ACCOUNT_ID, "invoice_payload": PAYLOAD, "state": state}


async def test_subscription_update_edge_cases(gw) -> None:
    assert (await gw.webhook(subscription_update(gw, "expired"))).json() == {"ok": True}  # неизвестное — подтверждаем
    assert gw.billing.calls == []
    await gw.webhook(subscription_update(gw, "canceled", uid=777))  # нет аккаунта — null, решает billing
    assert gw.billing.calls[0]["json"]["account_id"] is None


async def test_payment_message_does_not_trigger_hint_reply(gw) -> None:
    for update in (successful_payment(gw), refunded_payment(gw)):
        reply = (await gw.webhook(update)).json()
        assert reply == {"ok": True}
    assert gw.telegram.calls == []


# ---------------------------------------------------------------- команды

def button(reply: dict) -> dict:
    [[only]] = reply["reply_markup"]["inline_keyboard"]
    return only


@pytest.mark.parametrize("command", ["/paysupport", "/support", "/paysupport@TilHeroBot"])
async def test_paysupport_and_support(gw, link_gw, command: str) -> None:
    ru = (await gw.webhook(gw.message(command))).json()
    assert ru["method"] == "sendMessage" and ru["text"] == texts.TEXTS["ru"]["paysupport"]
    assert "Поддержка Telegram не помогает с покупками" in ru["text"]
    assert button(ru) == {"text": "Написать в поддержку", "web_app": {"url": f"{MINIAPP}?startapp=route_support"}}
    uz = (await gw.webhook(gw.message(command, lang="uz"))).json()
    assert uz["text"] == texts.TEXTS["uz"]["paysupport"] and button(uz)["text"] == "Qoʻllab-quvvatlashga yozish"
    direct = (await link_gw.webhook(link_gw.message(command))).json()
    assert button(direct) == {"text": "Написать в поддержку", "url": f"{APP_LINK}?startapp=route_support"}


async def test_terms(gw) -> None:
    ru = (await gw.webhook(gw.message("/terms"))).json()
    assert ru["text"] == texts.TEXTS["ru"]["terms"]
    assert button(ru) == {"text": "Открыть оферту", "url": "https://app.tilhero.test/legal/offer"}
    uz = (await gw.webhook(gw.message("/terms", lang="uz"))).json()
    assert button(uz) == {"text": "Ofertani ochish", "url": "https://app.tilhero.test/legal/offer"}


def test_terms_url_only_on_mini_app_domain() -> None:
    s = make_settings("t_terms", terms_url=" https://app.tilhero.test/docs/offer-1.0 ")
    assert s.terms_url == "https://app.tilhero.test/docs/offer-1.0"
    assert make_settings("t_terms", terms_url="").terms_url == "https://app.tilhero.test/legal/offer"
    for bad in ("https://pay.tilhero.test/offer", "http://app.tilhero.test/offer", "https://evil.test/x",
                "https://app.tilhero.test/of fer"):
        with pytest.raises(ValidationError):
            make_settings("t_terms", terms_url=bad)
    assert Settings(env="test").terms_url == "https://localhost:5173/legal/offer"


FORBIDDEN = ("payme", "click", "uzum", "сум", "soʻm", "so'm", "som ", "сайт", "sayt", "http", "www.", ".uz",
             "дешевле", "другим способ", "другой способ", "arzon", "boshqa usul", "карт", "karta")


def test_bot_texts_have_no_steering() -> None:
    """Анти-стиринг (решение В1, AT-100): тексты бота, команды, описания и отказы pre-checkout — без сайта оплаты,
    ссылок, названий Payme/Click/Uzum, цен в сумах и «других способов»."""
    corpus: list[str] = []
    for lang in ("ru", "uz"):
        corpus += texts.TEXTS[lang].values()
        corpus += texts.PRE_CHECKOUT_ERRORS[lang].values()
        corpus += [c["description"] for c in texts.BOT_COMMANDS[lang]]
        corpus += texts.DESCRIPTIONS[lang].values()
    assert corpus
    for text in corpus:
        low = text.lower()
        assert not any(word in low for word in FORBIDDEN), text
    for lang in ("ru", "uz"):  # одинаковые ключи и непустые тексты на обоих языках
        assert set(texts.PRE_CHECKOUT_ERRORS[lang]) == set(texts.PRE_CHECKOUT_ERRORS["ru"])
        assert all(len(v) <= 200 for v in texts.PRE_CHECKOUT_ERRORS[lang].values())
    assert "'" not in "".join(texts.PRE_CHECKOUT_ERRORS["uz"].values())  # узбекская латиница — U+02BB / U+02BC


# ---------------------------------------------------------------- логи

async def test_logs_have_no_telegram_id_payload_or_charge_id(gw) -> None:
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonFormatter("telegram-bot-gateway"))
    root = logging.getLogger()
    root.addHandler(handler)
    old = root.level
    root.setLevel(logging.DEBUG)
    try:
        gw.billing.pre_checkout = {"ok": False, "error": "payer_mismatch"}
        await gw.webhook(pre_checkout(gw))
        await gw.webhook(successful_payment(gw))
        gw.billing.queue = [(500, {"code": "X", "message": "x", "trace_id": "t", "details": {}})] * 2
        await gw.webhook(successful_payment(gw, charge="stxTEST_other_secret"))
        await gw.webhook(refunded_payment(gw))
        await gw.webhook(subscription_update(gw, "canceled"))
        await gw.webhook(successful_payment(gw, total_amount="bad"))
    finally:
        root.removeHandler(handler)
        root.setLevel(old)
    logs = stream.getvalue()
    assert "stars update delivered" in logs and "stars pre-checkout answered" in logs
    for secret in (str(TG_USER), CHARGE, "stxTEST_other_secret", PAYLOAD, ACCOUNT_ID):
        assert secret not in logs, secret
