"""Платёжные обновления Telegram Stars в webhook (INTERNAL_API спринта 8 §2): bot-gateway без БД и outbox передаёт их
billing синхронно, повтор — через Telegram.

- `pre_checkout_query` → identity-consent (Telegram ID → `account_id`, 2 с) → billing `stars/pre-checkout` (3 с) →
  **ответ методом в теле webhook** `answerPreCheckoutQuery` — без отдельного исходящего вызова, в пределах 10 с Bot API.
  Любая ошибка или таймаут — `ok: false` с понятным текстом RU/UZ (`texts.PRE_CHECKOUT_ERRORS`), без упоминания других
  способов оплаты. Отметка `update_id` не ставится: повтор доставки получает ответ заново (billing хранит ответ по
  `query_id`).
- `message.successful_payment`, `message.refunded_payment`, `subscription` (BotSubscriptionUpdated) → billing
  (`stars/payments`, `stars/refunds-received`, `stars/subscription-updates`; 5 с на попытку, один повтор на сеть/5xx,
  всё — ≤ 9 с). Webhook отмечает `update_id` только после 2xx billing (см. api/webhook.py), иначе 503 — Telegram
  повторит; billing идемпотентен по `telegram_payment_charge_id`.

Telegram ID живёт только в памяти запроса: в billing уходит `account_id`, в логи — ни Telegram ID, ни payload, ни
charge id (только `charge_ref` — хеш-префикс).
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import time
from datetime import UTC, datetime
from typing import Any, Literal
from uuid import UUID

from tilhero_botgw.settings import Settings
from tilhero_botgw.texts import lang_of, pre_checkout_error_text
from tilhero_common.app import Runtime
from tilhero_common.http_client import UpstreamError

log = logging.getLogger("tilhero.botgw.stars")

UpdateKind = Literal["pre_checkout", "payment", "refund", "subscription"]
BILLING_PRE_CHECKOUT = "/internal/v1/stars/pre-checkout"
BILLING_PAYMENTS = "/internal/v1/stars/payments"
BILLING_REFUNDS_RECEIVED = "/internal/v1/stars/refunds-received"
BILLING_SUBSCRIPTION_UPDATES = "/internal/v1/stars/subscription-updates"
IDENTITY_ACCOUNT = "/internal/v1/telegram-users/{telegram_user_id}/account"
SUBSCRIPTION_STATES = frozenset({"canceled", "active", "failed"})
CHARGE_ID_MAX = 128
PAYLOAD_MAX_BYTES = 128
MIN_ATTEMPT_SECONDS = 0.2  # меньше — повтор к billing не начинаем (бюджет обновления исчерпан)


def charge_ref(charge_id: str) -> str:
    """Хеш-префикс charge id для логов (§2: charge id целиком в лог не пишется)."""
    return hashlib.sha256(charge_id.encode()).hexdigest()[:12]


def classify(update: dict[str, Any]) -> UpdateKind | None:
    """Платёжное ли обновление; None — обычное (сообщение, callback, my_chat_member)."""
    if isinstance(update.get("pre_checkout_query"), dict):
        return "pre_checkout"
    if isinstance(update.get("subscription"), dict):
        return "subscription"
    msg = update.get("message")
    if isinstance(msg, dict):
        if isinstance(msg.get("successful_payment"), dict):
            return "payment"
        if isinstance(msg.get("refunded_payment"), dict):
            return "refund"
    return None


class LookupFailed(Exception):
    """identity-consent недоступен или ответил не так: платёжное обновление повторит Telegram."""


class Malformed(Exception):
    """Обновление Telegram без обязательных полей: повтор не поможет — подтверждаем без обработки."""


def _int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _str(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _user_id(user: Any) -> int | None:
    uid = _int(_dict(user).get("id"))
    return uid if uid is not None and uid > 0 else None


def _iso(unix: int | None) -> str | None:
    return datetime.fromtimestamp(unix, UTC).isoformat() if unix is not None and unix > 0 else None


def _payload(value: Any) -> str:
    payload = _str(value)
    if payload is None or len(payload.encode()) > PAYLOAD_MAX_BYTES:
        raise Malformed("invoice_payload")
    return payload


def _charge(value: Any) -> str:
    charge = _str(value)
    if not charge or len(charge) > CHARGE_ID_MAX:
        raise Malformed("telegram_payment_charge_id")
    return charge


def _amount(value: Any) -> int:
    amount = _int(value)
    if amount is None or amount < 0:
        raise Malformed("total_amount")
    return amount


# identity-consent `status` аккаунта: удаляемый — pre-checkout отказывает сам (billing не вызывается); платёж и
# обновления подписки по удаляемому аккаунту всё равно уходят в billing (пункт сверки paid_after_deletion)
STATUS_DELETION_REQUESTED = "DELETION_REQUESTED"


async def account_for(rt: Runtime, settings: Settings, telegram_user_id: int | None) -> str | None:
    """Telegram ID → `account_id` (identity-consent, 2 с). Нет аккаунта или удалён (404) — None (billing решает:
    pre-checkout — отказ `payer_mismatch`, платёж — пункт сверки). Иная ошибка или таймаут — LookupFailed."""
    account, _status = await account_with_status(rt, settings, telegram_user_id)
    return account


async def account_with_status(rt: Runtime, settings: Settings, telegram_user_id: int | None
                              ) -> tuple[str | None, str | None]:
    """→ (`account_id`, `status` identity-consent: ACTIVE | DISABLED | DELETION_REQUESTED); 404 — (None, None)."""
    if telegram_user_id is None:
        return None, None
    path = IDENTITY_ACCOUNT.format(telegram_user_id=telegram_user_id)
    try:
        result = await asyncio.wait_for(rt.client("identity-consent").get(path),
                                        settings.stars_identity_timeout_seconds)
    except UpstreamError as exc:
        if exc.status == 404:
            return None, None
        raise LookupFailed(f"identity-consent {exc.status}") from None
    except TimeoutError:
        raise LookupFailed("identity-consent timeout") from None
    data = _dict(result)
    try:
        account = str(UUID(str(data.get("account_id"))))
    except ValueError:
        raise LookupFailed("identity-consent bad response") from None
    return account, _str(data.get("status"))


# ---------------------------------------------------------------- pre_checkout_query

async def answer_pre_checkout(rt: Runtime, settings: Settings, query: dict[str, Any]) -> dict[str, Any] | None:
    """Метод `answerPreCheckoutQuery` для тела ответа webhook. None — у запроса нет id (ответить нечем)."""
    query_id = _str(query.get("id"))
    if not query_id or len(query_id) > 128:
        return None
    sender = _dict(query.get("from"))
    lang = lang_of(_str(sender.get("language_code")) or None)
    started = time.perf_counter()
    ok, reason = False, "unavailable"
    try:
        currency = _str(query.get("currency"))
        if not currency or len(currency) > 8:
            raise Malformed("currency")
        body: dict[str, Any] = {"query_id": query_id, "currency": currency,
                                "total_amount": _amount(query.get("total_amount")),
                                "invoice_payload": _payload(query.get("invoice_payload"))}
        account, status = await account_with_status(rt, settings, _user_id(sender))
        if status == STATUS_DELETION_REQUESTED:  # аккаунт удаляется — новых покупок нет
            reason = "order_closed"
        else:
            body["account_id"] = account
            result = await asyncio.wait_for(rt.client("billing").post(BILLING_PRE_CHECKOUT, json=body),
                                            settings.stars_pre_checkout_timeout_seconds)
            data = _dict(result)
            ok = data.get("ok") is True
            reason = "ok" if ok else (_str(data.get("error")) or "unavailable")
    except Malformed:
        reason = "malformed"
    except LookupFailed:
        reason = "identity_unavailable"
    except TimeoutError:
        reason = "billing_timeout"
    except UpstreamError as exc:
        reason = f"billing_{exc.status}"
    except Exception as exc:  # ответ Telegram важнее: любая ошибка — отказ с понятным текстом
        log.error("stars pre-checkout failed", extra={"error_type": type(exc).__name__})
        reason = "error"
    log.info("stars pre-checkout answered", extra={
        "ok": ok, "reason": reason, "duration_ms": round((time.perf_counter() - started) * 1000, 1)})
    reply: dict[str, Any] = {"method": "answerPreCheckoutQuery", "pre_checkout_query_id": query_id, "ok": ok}
    if not ok:
        reply["error_message"] = pre_checkout_error_text(lang, reason)
    return reply


# ---------------------------------------------------------------- successful_payment, refunded_payment, subscription

async def forward_update(rt: Runtime, settings: Settings, kind: UpdateKind, update: dict[str, Any]) -> bool:
    """Платёжное обновление → billing. True — billing ответил 2xx (или обновление непригодно: подтверждаем, повтор не
    поможет, сверка выписки найдёт расхождение); False — не обработано, webhook отвечает 503 и Telegram повторит."""
    deadline = time.monotonic() + settings.stars_update_deadline_seconds
    try:
        path, body, ref = await _billing_request(rt, settings, kind, update)
    except Malformed as exc:
        log.warning("stars update malformed", extra={"update_kind": kind, "field": str(exc)})
        return True
    except LookupFailed:
        log.warning("stars update postponed: identity-consent unavailable", extra={"update_kind": kind})
        return False
    if path is None:
        return True
    return await _post_billing(rt, settings, path, body, deadline, kind=kind, ref=ref)


async def _billing_request(rt: Runtime, settings: Settings, kind: UpdateKind, update: dict[str, Any]
                           ) -> tuple[str | None, dict[str, Any], str | None]:
    if kind == "payment":
        msg = _dict(update.get("message"))
        sp = _dict(msg.get("successful_payment"))
        charge = _charge(sp.get("telegram_payment_charge_id"))
        currency = _str(sp.get("currency"))
        if not currency or len(currency) > 8:
            raise Malformed("currency")
        body: dict[str, Any] = {
            "telegram_payment_charge_id": charge,
            "currency": currency,
            "total_amount": _amount(sp.get("total_amount")),
            "invoice_payload": _payload(sp.get("invoice_payload")),
            "is_recurring": sp.get("is_recurring") is True,
            "is_first_recurring": sp.get("is_first_recurring") is True,
            "subscription_expiration_date": _iso(_int(sp.get("subscription_expiration_date"))),
            "paid_at": _iso(_int(msg.get("date"))) or datetime.now(UTC).isoformat(),
        }
        sender = _user_id(msg.get("from"))
        if sender is None and _dict(msg.get("chat")).get("type") == "private":
            sender = _user_id(msg.get("chat"))
        body["account_id"] = await account_for(rt, settings, sender)
        return BILLING_PAYMENTS, body, charge
    if kind == "refund":
        rp = _dict(_dict(update.get("message")).get("refunded_payment"))
        charge = _charge(rp.get("telegram_payment_charge_id"))
        return BILLING_REFUNDS_RECEIVED, {"telegram_payment_charge_id": charge,
                                          "total_amount": _amount(rp.get("total_amount")),
                                          "invoice_payload": _payload(rp.get("invoice_payload"))}, charge
    if kind == "subscription":
        sub = _dict(update.get("subscription"))
        state = _str(sub.get("state"))
        payload = _payload(sub.get("invoice_payload"))
        if state not in SUBSCRIPTION_STATES:  # новое состояние Bot API — не наше дело, подтверждаем
            log.warning("stars subscription state unknown", extra={"state": (state or "")[:20]})
            return None, {}, None
        account = await account_for(rt, settings, _user_id(sub.get("user")))
        return BILLING_SUBSCRIPTION_UPDATES, {"account_id": account, "invoice_payload": payload, "state": state}, None
    raise Malformed("kind")


async def _post_billing(rt: Runtime, settings: Settings, path: str, body: dict[str, Any], deadline: float, *,
                        kind: str, ref: str | None) -> bool:
    client = rt.client("billing")
    extra: dict[str, Any] = {"update_kind": kind}
    if ref:
        extra["charge_ref"] = charge_ref(ref)
    for attempt in (1, 2):
        remaining = deadline - time.monotonic()
        if remaining < MIN_ATTEMPT_SECONDS:
            break
        try:
            await asyncio.wait_for(client.post(path, json=body),
                                   min(settings.stars_billing_timeout_seconds, remaining))
        except UpstreamError as exc:
            log.warning("billing rejected stars update", extra={**extra, "status": exc.status, "error_code": exc.code,
                                                                 "attempt": attempt})
            if exc.status < 500:
                return False  # 4xx: повтор сразу не поможет — Telegram повторит обновление позже
            continue
        except TimeoutError:
            log.warning("billing stars update timeout", extra={**extra, "attempt": attempt})
            continue
        log.info("stars update delivered", extra={**extra, "attempt": attempt})
        return True
    return False
