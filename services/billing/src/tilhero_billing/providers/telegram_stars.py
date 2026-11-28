"""Адаптер Telegram Stars (поток G) — INTERNAL_API спринта 8 §1.5 (billing) и §2 (telegram-bot-gateway).

Канал `miniapp` (и `renewal` — продления подписки): цены только в Stars (XTR), один провайдер `telegram_stars`.
**Bot API billing не вызывает и токена бота не знает**: все вызовы — внутренний API bot-gateway (`BOTGW_URL`, порт
8108, внутренний JWT `iss=billing`); платёжные обновления Telegram bot-gateway присылает в `api/stars.py` уже с
`account_id` вместо Telegram ID (Telegram ID в billing не попадает).

- `checkout` — ссылка на счёт: bot-gateway `POST /internal/v1/stars/invoice-links` → `createInvoiceLink` (XTR, одна
  позиция, пустой `provider_token`, `subscription_period` 2592000 — только для `stars_mode: subscription`);
- `handle` — обновления от bot-gateway (`pre_checkout` | `payment` | `refund_received` | `subscription_update`) →
  операции `PaymentPort` → ответ bot-gateway (2xx — обновление обработано и отмечается; иначе Telegram повторит);
- `refund` — `refundStarPayment` (уже возвращён — тоже `api_ok`); отмена подписки при возврате — отдельно
  `edit_subscription(is_canceled=True)` (ядро знает `first_charge_id`);
- `edit_subscription` — автопродление из Mini App, отмена при возврате и в саге (`editUserStarSubscription`);
- `remote_status` — выписка `getStarTransactions` для сверки (без данных пользователя);
- `fiscalize` — no_op: по Stars чеков нет (решение 17, О3).

Что не подтверждено документацией (§14) и как закрыто: S2 — приходит ли `pre_checkout_query` на автопродление
(решает `PaymentPort.check`: payload первого заказа живой подписки того же плательщика — ок); S4 — `StarTransaction.id`
= `telegram_payment_charge_id` (по описанию Bot API — да, у возврата — id исходного платежа; сверка по id, иначе ядро
сопоставляет по `order_ref` и сумме). Логи — без Telegram ID, payload и charge id (только `charge_ref` — хеш-префикс).
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, Any, Final, Literal, cast
from uuid import UUID

from pydantic import (
    AfterValidator,
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    ValidationError,
)

from tilhero_billing.domain.ports import (
    AlreadyPaid,
    AmountMismatch,
    OrderBusy,
    OrderClosed,
    OrderNotFound,
    PayerMismatch,
    PaymentError,
    PaymentPort,
    PaymentsDisabled,
    PreCheckoutJournal,
    ProviderCallJournal,
    StarsRecurrence,
    SubscriptionExists,
    SubscriptionNotFound,
    TxnNotFound,
)
from tilhero_billing.providers.base import (
    STARS_SUBSCRIPTION_MAX_PRICE,
    STARS_SUBSCRIPTION_PERIOD_SECONDS,
    Checkout,
    FiscalOutcome,
    InboundCall,
    OrderView,
    OutboundResponse,
    ProviderCode,
    RefundOutcome,
    RemoteRecord,
    StarsSubscriptionState,
    TxnView,
)
from tilhero_billing.settings import Settings
from tilhero_common.errors import ApiError, error_body
from tilhero_common.http_client import ServiceClient, UpstreamError

log = logging.getLogger("tilhero.billing.stars")

# ---------------------------------------------------------------- константы провайдера (одна таблица, §1.5, §2, §14)

CODE: Final[ProviderCode] = "telegram_stars"
CURRENCY: Final = "XTR"
# payload счёта — `o:<order_id>` (≤ 128 байт, пользователю не показывается); по нему bot-gateway и billing находят заказ
PAYLOAD_PREFIX: Final = "o:"
PAYLOAD_RE: Final = re.compile(r"o:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
PAYLOAD_MAX_BYTES: Final = 128
TITLE_MAX: Final = 32  # createInvoiceLink.title 1..32
DESCRIPTION_MAX: Final = 255  # createInvoiceLink.description 1..255
CHARGE_ID_MAX: Final = 128  # provider_transactions.provider_txn_id 1..128
AMOUNT_STARS_MAX: Final = 100_000  # orders.amount_stars 1..100 000; подписка ≤ 10 000 (Bot API)
INVOICE_LINK_PREFIX: Final = "https://t.me/"  # orders.invoice_link CHECK '^https://t\.me/'

# внутренний API bot-gateway (§2)
BOTGW_INVOICE_LINKS: Final = "/internal/v1/stars/invoice-links"
BOTGW_REFUNDS: Final = "/internal/v1/stars/refunds"
BOTGW_SUBSCRIPTION_EDIT: Final = "/internal/v1/stars/subscriptions/edit"
BOTGW_TRANSACTIONS: Final = "/internal/v1/stars/transactions"
STATEMENT_PAGE: Final = 100  # getStarTransactions limit 1..100
STATEMENT_MAX_PAGES: Final = 50  # не больше 5 000 записей за прогон сверки; дальше — предупреждение в лог
# в сверку — только оплаты счетов пользователями и возвраты им (выводы через Fragment, реклама и пр. — не наши заказы)
STATEMENT_PARTNER_TYPE: Final = "user"
STATEMENT_TRANSACTION_TYPES: Final = frozenset({"invoice_payment"})

# операции InboundCall.operation (api/stars.py)
OP_PRE_CHECKOUT: Final = "pre_checkout"
OP_PAYMENT: Final = "payment"
OP_REFUND_RECEIVED: Final = "refund_received"
OP_SUBSCRIPTION_UPDATE: Final = "subscription_update"
OPERATIONS: Final = (OP_PRE_CHECKOUT, OP_PAYMENT, OP_REFUND_RECEIVED, OP_SUBSCRIPTION_UPDATE)

# ответ pre-checkout (§1.5): `{ok: false, error}` — коды, которые bot-gateway переводит в текст RU/UZ
PreCheckoutError = Literal["order_not_found", "order_closed", "amount_mismatch", "payer_mismatch", "already_paid",
                           "subscription_exists", "payments_disabled"]
PRE_CHECKOUT_ERRORS: Final[tuple[PreCheckoutError, ...]] = (
    "order_not_found", "order_closed", "amount_mismatch", "payer_mismatch", "already_paid", "subscription_exists",
    "payments_disabled")
_PRE_CHECKOUT_ERROR_BY_EXC: Final[tuple[tuple[type[PaymentError], PreCheckoutError], ...]] = (
    (PaymentsDisabled, "payments_disabled"),
    (OrderNotFound, "order_not_found"),
    (OrderClosed, "order_closed"),
    (OrderBusy, "order_closed"),  # только Payme; у Stars не ожидается
    (AlreadyPaid, "already_paid"),
    (AmountMismatch, "amount_mismatch"),
    (PayerMismatch, "payer_mismatch"),
    (SubscriptionExists, "subscription_exists"),
)
# pre-checkout в billing — не дольше этого (bot-gateway ждёт 3 с, Telegram — 10 с): иначе 503 и bot-gateway отвечает
# «Оплата временно недоступна», журнал ответа не пишется
PRE_CHECKOUT_BUDGET_SECONDS: Final = 2.5
SUBSCRIPTION_STATES: Final[tuple[StarsSubscriptionState, ...]] = ("canceled", "active", "failed")
# `PaymentPort.paid` ядра поднимает их ПОСЛЕ фиксации пункта сверки (domain/payments.py): для bot-gateway — 2xx
DEFERRED_PAYMENT_ERRORS: Final = (OrderNotFound, AlreadyPaid, SubscriptionNotFound)


def charge_ref(charge_id: str) -> str:
    """Хеш-префикс charge id для логов (§2: charge id целиком в лог не пишется)."""
    return hashlib.sha256(charge_id.encode()).hexdigest()[:12]


def order_payload(order_id: UUID) -> str:
    """`invoice_payload` счёта: `o:<order_id>` (38 байт ≤ 128)."""
    return f"{PAYLOAD_PREFIX}{order_id}"


# ---------------------------------------------------------------- ошибки адаптера

class StarsGatewayError(ApiError):
    """bot-gateway или Telegram недоступны / отказали: 503 `STARS_UNAVAILABLE {permanent}`. Ядро отвечает ученику 503
    (заказ остаётся `pending`, ссылка запрашивается при следующем чтении), сверка пишет ошибку прогона."""

    def __init__(self, *, permanent: bool = False, reason: str = "unavailable") -> None:
        super().__init__(503, "STARS_UNAVAILABLE", "Оплата Telegram Stars временно недоступна",
                         {"permanent": permanent})
        self.permanent = permanent
        self.reason = reason


class StarsPayerUnknown(ApiError):
    """bot-gateway не знает Telegram-пользователя аккаунта (аккаунт удалён): 409 `STARS_PAYER_UNKNOWN`."""

    def __init__(self) -> None:
        super().__init__(409, "STARS_PAYER_UNKNOWN", "Плательщик Telegram Stars неизвестен")


def _gateway_error(exc: UpstreamError) -> ApiError:
    if exc.status == 409 and exc.code == "STARS_PAYER_UNKNOWN":
        return StarsPayerUnknown()
    permanent = exc.code == "TELEGRAM_ERROR" and exc.details.get("permanent") is True
    return StarsGatewayError(permanent=permanent, reason=exc.code.lower())


# ---------------------------------------------------------------- расширения порта (реализует ядро, поток A)

@dataclass(frozen=True, slots=True)
class PreCheckoutAnswer:
    ok: bool
    error: PreCheckoutError | None = None


def known_pre_checkout_error(code: str | None) -> PreCheckoutError:
    """Код из журнала ядра → известный код ответа pre-checkout; иное — `order_closed` (оплатить нельзя)."""
    for known in PRE_CHECKOUT_ERRORS:
        if code == known:
            return known
    return "order_closed"


# ---------------------------------------------------------------- тела обновлений от bot-gateway (§1.5)

def _payload_bytes(value: str) -> str:
    if len(value.encode()) > PAYLOAD_MAX_BYTES:
        raise ValueError("invoice_payload длиннее 128 байт")
    return value


InvoicePayload = Annotated[str, Field(max_length=PAYLOAD_MAX_BYTES), AfterValidator(_payload_bytes)]
ChargeId = Annotated[str, Field(min_length=1, max_length=CHARGE_ID_MAX)]
Amount = Annotated[StrictInt, Field(ge=0, le=1_000_000_000)]


class _Body(BaseModel):
    # extra=forbid: Telegram ID и прочие поля Telegram в billing не принимаются (422)
    model_config = ConfigDict(extra="forbid", frozen=True)


class PreCheckoutIn(_Body):
    query_id: Annotated[str, Field(min_length=1, max_length=128)]
    account_id: UUID | None
    currency: Annotated[str, Field(min_length=1, max_length=8)]
    total_amount: Amount
    invoice_payload: InvoicePayload


class PaymentIn(_Body):
    telegram_payment_charge_id: ChargeId
    provider_payment_charge_id: Annotated[str, Field(max_length=256)] | None = None  # не хранится
    account_id: UUID | None
    currency: Annotated[str, Field(min_length=1, max_length=8)]
    total_amount: Amount
    invoice_payload: InvoicePayload
    is_recurring: StrictBool = False
    is_first_recurring: StrictBool = False
    subscription_expiration_date: AwareDatetime | None = None
    paid_at: AwareDatetime


class RefundReceivedIn(_Body):
    telegram_payment_charge_id: ChargeId
    total_amount: Amount
    invoice_payload: InvoicePayload


class SubscriptionUpdateIn(_Body):
    account_id: UUID | None
    invoice_payload: InvoicePayload
    state: Literal["canceled", "active", "failed"]


_BODY_MODELS: Final[dict[str, type[_Body]]] = {
    OP_PRE_CHECKOUT: PreCheckoutIn,
    OP_PAYMENT: PaymentIn,
    OP_REFUND_RECEIVED: RefundReceivedIn,
    OP_SUBSCRIPTION_UPDATE: SubscriptionUpdateIn,
}


def _response(status: int, body: Mapping[str, Any], result_code: str, *, txn: str | None = None,
              order_no: int | None = None) -> OutboundResponse:
    return OutboundResponse(status_code=status, body=body, result_code=result_code, provider_txn_id=txn,
                            order_no=order_no)


def _error(status: int, code: str, message: str, details: dict[str, Any] | None = None, *,
           txn: str | None = None) -> OutboundResponse:
    return _response(status, error_body(code, message, details), code, txn=txn)


def pre_checkout_error_for(exc: PaymentError) -> PreCheckoutError:
    """Ошибка домена → код ответа pre-checkout; неизвестные ошибки домена — `order_closed` (оплатить нельзя)."""
    for cls, code in _PRE_CHECKOUT_ERROR_BY_EXC:
        if isinstance(exc, cls):
            return code
    return "order_closed"


# ---------------------------------------------------------------- счёт (createInvoiceLink через bot-gateway)

def _localized(values: Mapping[str, str] | None, locale: str) -> str:
    if not values:
        return ""
    for key in (locale, "ru", "uz"):
        text = values.get(key)
        if isinstance(text, str) and text.strip():
            return text.strip()
    return ""


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def invoice_request(order: OrderView, locale: str) -> dict[str, Any]:
    """Тело `POST /internal/v1/stars/invoice-links` (§1.5): title — `stars_title` по `locale` (1..32), description —
    описание товара (1..255; нет — название), payload `o:<order_id>`, сумма — **только из заказа** (снимок каталога),
    `subscription_period` — только для `stars_mode: subscription` (2 592 000, цена ≤ 10 000)."""
    if order.provider != CODE or order.currency != CURRENCY or order.stars_mode is None:
        raise ValueError("заказ не Telegram Stars")
    amount = order.amount_stars
    if amount is None or isinstance(amount, bool) or not 1 <= amount <= AMOUNT_STARS_MAX:
        raise ValueError("сумма заказа Stars вне 1..100 000")
    period: int | None = None
    if order.stars_mode == "subscription":
        if order.product_kind != "subscription" or amount > STARS_SUBSCRIPTION_MAX_PRICE:
            raise ValueError("подписка Stars: только подписка и цена ≤ 10 000")
        period = STARS_SUBSCRIPTION_PERIOD_SECONDS
    title = _clip(_localized(order.stars_title, locale) or _localized(order.title, locale), TITLE_MAX)
    description = _clip(_localized(order.description, locale) or _localized(order.title, locale), DESCRIPTION_MAX)
    if not title or not description:
        raise ValueError("у товара нет названия счёта")
    return {"order_id": str(order.order_id), "title": title, "description": description,
            "payload": order_payload(order.order_id), "amount_stars": amount, "subscription_period": period}


# ---------------------------------------------------------------- адаптер

class TelegramStarsAdapter:
    """`ProviderAdapter` для `telegram_stars`. `botgw` — клиент внутреннего API bot-gateway (`Runtime.client(BOTGW)`)
    или фабрика (клиенты Runtime создаются при старте). Сам в БД не ходит — только через `PaymentPort`."""

    code: ProviderCode = CODE

    def __init__(self, settings: Settings, botgw: ServiceClient | Callable[[], ServiceClient], *,
                 journal: ProviderCallJournal | None = None) -> None:
        self._settings = settings
        self._botgw = botgw
        self._journal = journal

    def _client(self) -> ServiceClient:
        return self._botgw if isinstance(self._botgw, ServiceClient) else self._botgw()

    def enabled(self) -> bool:
        return self._settings.provider_enabled(CODE)

    # ---------- счёт
    async def checkout(self, order: OrderView, *, locale: str, return_url: str | None) -> Checkout:
        """Ссылка на счёт для `Telegram.WebApp.openInvoice` (return_url у Stars не используется). Уже выпущенная
        ссылка (в заказе) не запрашивается повторно; bot-gateway сам идемпотентен по `order_id` (Redis 24 ч)."""
        if order.invoice_link:
            return Checkout(kind="invoice_link", url=order.invoice_link)
        body = invoice_request(order, locale)
        result = await self._call("createInvoiceLink", "POST", BOTGW_INVOICE_LINKS, json=body, order_no=order.order_no)
        link = result.get("invoice_link") if isinstance(result, dict) else None
        if not isinstance(link, str) or not link.startswith(INVOICE_LINK_PREFIX) or len(link) > 512 \
                or any(ch.isspace() for ch in link):
            log.warning("stars invoice link rejected", extra={"order_no": order.order_no})
            raise StarsGatewayError(permanent=False, reason="bad_response")
        return Checkout(kind="invoice_link", url=link)

    # ---------- обновления Telegram от bot-gateway
    async def handle(self, call: InboundCall, payments: PaymentPort) -> OutboundResponse:
        model = _BODY_MODELS.get(call.operation)
        if call.provider != CODE or model is None:
            return _error(404, "STARS_OPERATION_UNKNOWN", "Операция Telegram Stars не найдена")
        try:
            raw = json.loads(call.body) if call.body else None
        except ValueError:
            return _error(400, "STARS_BODY_INVALID", "Тело запроса — не JSON")
        try:
            body = model.model_validate(raw)
        except ValidationError as exc:
            # без значений полей (input): в теле могли оказаться данные пользователя
            errors = [{"loc": [str(p) for p in e.get("loc", ())], "type": e.get("type")} for e in exc.errors()]
            return _error(422, "VALIDATION_ERROR", "Некорректные данные запроса", {"errors": errors})
        if isinstance(body, PreCheckoutIn):
            return await self._pre_checkout(body, payments)
        if isinstance(body, PaymentIn):
            return await self._payment(body, payments)
        if isinstance(body, RefundReceivedIn):
            return await self._refund_received(body, payments)
        assert isinstance(body, SubscriptionUpdateIn)
        return await self._subscription_update(body, payments)

    async def _pre_checkout(self, q: PreCheckoutIn, payments: PaymentPort) -> OutboundResponse:
        journal = payments if isinstance(payments, PreCheckoutJournal) else None
        if journal is not None:
            stored = await journal.recall_pre_checkout(q.query_id)
            if stored is not None:
                ok, code = stored
                return self._pre_checkout_response(
                    PreCheckoutAnswer(ok, None if ok else known_pre_checkout_error(code)), replay=True)
        answer = await self._decide(q, payments)
        if journal is not None:
            try:
                ok, code = await journal.remember_pre_checkout(q.query_id, q.invoice_payload, answer.ok, answer.error)
                answer = PreCheckoutAnswer(ok, None if ok else known_pre_checkout_error(code))
            except Exception as exc:  # журнал — не повод не ответить Telegram (ответ уже вычислен)
                log.warning("stars pre-checkout journal failed", extra={"error_type": type(exc).__name__})
        return self._pre_checkout_response(answer, replay=False)

    async def _decide(self, q: PreCheckoutIn, payments: PaymentPort) -> PreCheckoutAnswer:
        """Проверки §1.5: XTR; заказ по payload в `pending` и не истёк; сумма; плательщик и право платить; для
        подписки — нет живой подписки Stars. Флаги (`PAYMENTS_ENABLED`, `STARS_ENABLED`) проверяет `PaymentPort.check`
        (`PaymentsDisabled`): ядро же решает §14 S2 — pre-checkout продления живой подписки при выключенных продажах."""
        if q.currency != CURRENCY:
            return PreCheckoutAnswer(False, "amount_mismatch")
        if not PAYLOAD_RE.fullmatch(q.invoice_payload):
            return PreCheckoutAnswer(False, "order_not_found")
        if q.account_id is None:  # Telegram-пользователь без аккаунта TilHero (или удалён)
            return PreCheckoutAnswer(False, "payer_mismatch")
        try:
            await payments.check(CODE, q.invoice_payload, q.total_amount, payer_account_id=q.account_id)
        except PaymentError as exc:
            return PreCheckoutAnswer(False, pre_checkout_error_for(exc))
        return PreCheckoutAnswer(True)

    @staticmethod
    def _pre_checkout_response(answer: PreCheckoutAnswer, *, replay: bool) -> OutboundResponse:
        body: dict[str, Any] = {"ok": answer.ok}
        if not answer.ok:
            body["error"] = answer.error or "order_closed"
        if replay:
            body["replayed"] = True
        return _response(200, body, "ok" if answer.ok else f"ok:false:{body['error']}")

    async def _payment(self, p: PaymentIn, payments: PaymentPort) -> OutboundResponse:
        """Деньги уже получены: несоответствия не отвергаются (ядро записывает транзакцию и пункт сверки). 200 —
        только после фиксации; любая ошибка — не 2xx, bot-gateway отвечает Telegram 503 и обновление придёт снова."""
        charge = p.telegram_payment_charge_id
        meta: dict[str, Any] = {"is_recurring": p.is_recurring, "is_first_recurring": p.is_first_recurring}
        if p.currency != CURRENCY:
            meta["currency"] = p.currency
        recurrence = StarsRecurrence(is_recurring=p.is_recurring, is_first_recurring=p.is_first_recurring,
                                     subscription_expiration_date=p.subscription_expiration_date)
        try:
            txn = await payments.paid(CODE, charge, p.invoice_payload, p.total_amount,
                                      payer_account_id=p.account_id, recurring=recurrence, provider_time=p.paid_at,
                                      meta=meta)
        except DEFERRED_PAYMENT_ERRORS as exc:
            # ядро уже зафиксировало пункт сверки (заказ не найден, второй платёж по оплаченному заказу, продление без
            # подписки) и подняло ошибку после фиксации: обновление обработано, Telegram повторять не должен
            log.warning("stars payment to reconciliation", extra={"error_code": exc.code,
                                                                   "charge_ref": charge_ref(charge)})
            return _response(200, {"ok": True, "reconciliation": exc.code}, f"ok:{exc.code}", txn=charge)
        except PaymentError as exc:
            log.error("stars payment not recorded", extra={"error_code": exc.code, "charge_ref": charge_ref(charge)})
            return _error(409, exc.code, "Платёж не записан", txn=charge)
        log.info("stars payment recorded", extra={"charge_ref": charge_ref(charge), "order_no": txn.order_no,
                                                  "renewal": p.is_recurring and not p.is_first_recurring})
        return _response(200, {"ok": True}, "ok", txn=charge, order_no=txn.order_no)

    async def _refund_received(self, r: RefundReceivedIn, payments: PaymentPort) -> OutboundResponse:
        """`refunded_payment`: подтверждение нашего возврата или возврат по инициативе Telegram (§1.12; повтор — без
        изменений). Неизвестный charge id — 409: платёж мог ещё не дойти (Telegram повторит), иначе — сверка выписки."""
        charge = r.telegram_payment_charge_id
        try:
            txn = await payments.refunded(CODE, charge)
        except TxnNotFound:
            log.warning("stars refund for unknown payment", extra={"charge_ref": charge_ref(charge)})
            return _error(409, "STARS_TXN_NOT_FOUND", "Платёж Telegram Stars не найден", txn=charge)
        except PaymentError as exc:
            log.error("stars refund not recorded", extra={"error_code": exc.code, "charge_ref": charge_ref(charge)})
            return _error(409, exc.code, "Возврат не записан", txn=charge)
        return _response(200, {"ok": True}, "ok", txn=charge, order_no=txn.order_no)

    async def _subscription_update(self, s: SubscriptionUpdateIn, payments: PaymentPort) -> OutboundResponse:
        """`subscription` (BotSubscriptionUpdated): canceled / active / failed автопродления. Подписка не найдена —
        ядро заводит пункт `stars_subscription_desync`; обновление считается обработанным (повтор не поможет)."""
        try:
            await payments.stars_subscription_state(s.invoice_payload, s.account_id, s.state)
        except SubscriptionNotFound:
            log.warning("stars subscription update without subscription", extra={"state": s.state})
            return _response(200, {"ok": True, "matched": False}, "ok:unmatched")
        except PaymentError as exc:
            log.error("stars subscription update not recorded", extra={"error_code": exc.code})
            return _error(409, exc.code, "Состояние подписки не записано")
        return _response(200, {"ok": True, "matched": True}, "ok")

    # ---------- возврат и подписка
    async def refund(self, txn: TxnView, *, account_id: UUID | None) -> RefundOutcome:
        """`refundStarPayment` через bot-gateway (Telegram-пользователя находит bot-gateway по `account_id`). Уже
        возвращён — `{ok, already}` → тоже `api_ok`. Отказ или недоступность — `api_failed` (возврат `failed`;
        повтор сотрудником безопасен — «уже возвращён» идемпотентен)."""
        if txn.provider != CODE:
            raise ValueError("транзакция не Telegram Stars")
        if account_id is None:
            return RefundOutcome(kind="api_failed", failure_code="STARS_PAYER_UNKNOWN")
        body = {"account_id": str(account_id), "telegram_payment_charge_id": txn.provider_txn_id}
        try:
            result = await self._call("refundStarPayment", "POST", BOTGW_REFUNDS, json=body, txn=txn.provider_txn_id,
                                      order_no=txn.order_no)
        except StarsPayerUnknown:
            return RefundOutcome(kind="api_failed", failure_code="STARS_PAYER_UNKNOWN")
        except StarsGatewayError as exc:
            return RefundOutcome(kind="api_failed", failure_code="TELEGRAM_ERROR" if exc.permanent
                                 else "STARS_UNAVAILABLE")
        if not (isinstance(result, dict) and result.get("ok") is True):
            return RefundOutcome(kind="api_failed", failure_code="STARS_UNAVAILABLE")
        log.info("stars refund done", extra={"charge_ref": charge_ref(txn.provider_txn_id),
                                             "already": result.get("already") is True})
        return RefundOutcome(kind="api_ok")

    async def edit_subscription(self, *, account_id: UUID | None, first_charge_id: str, is_canceled: bool) -> None:
        """`editUserStarSubscription` (по charge id **первого** платежа — `stars_subscriptions.first_charge_id`):
        `is_canceled=True` — автопродление выключено (подписка живёт до конца периода), `False` — снова включено.
        Ошибки: `StarsPayerUnknown` (409), `StarsGatewayError` (503 `STARS_UNAVAILABLE`)."""
        if account_id is None:
            raise StarsPayerUnknown()
        body = {"account_id": str(account_id), "telegram_payment_charge_id": first_charge_id,
                "is_canceled": is_canceled}
        await self._call("editUserStarSubscription", "POST", BOTGW_SUBSCRIPTION_EDIT, json=body, txn=first_charge_id)

    async def fiscalize(self, txn: TxnView, order: OrderView) -> FiscalOutcome:
        return FiscalOutcome(kind="no_op")  # решение 17, О3: чеков по Stars нет

    # ---------- выписка для сверки
    async def remote_status(self, since: datetime) -> list[RemoteRecord] | None:
        """Выписка `getStarTransactions` (страницы по 100) с `since`: оплаты счетов (`in`, состояние `performed`) и
        возвраты (`out`, `refunded`; id возврата = id исходного платежа). Без данных пользователя. bot-gateway
        недоступен — `StarsGatewayError` (ядро пишет ошибку прогона, пункты «нет у провайдера» не заводит)."""
        if since.tzinfo is None:
            since = since.replace(tzinfo=UTC)
        records: list[RemoteRecord] = []
        offset = 0
        for _page in range(STATEMENT_MAX_PAGES):
            result = await self._call("getStarTransactions", "GET", BOTGW_TRANSACTIONS,
                                      params={"offset": offset, "limit": STATEMENT_PAGE})
            items = result.get("items") if isinstance(result, dict) else None
            if not isinstance(items, list):
                raise StarsGatewayError(permanent=False, reason="bad_response")
            # count — размер страницы Telegram до отбора в bot-gateway (нет — по числу записей)
            count = result.get("count")
            page_size = count if isinstance(count, int) and not isinstance(count, bool) and count >= len(items) \
                else len(items)
            dates: list[datetime] = []
            for item in items:
                record = statement_record(item)
                if record is None:
                    continue
                dates.append(record.at)
                if record.at >= since:
                    records.append(record)
            if page_size < STATEMENT_PAGE:
                break
            offset += page_size
            # выписка от новых к старым (порядок в документации не указан): дальше только старше `since`
            if dates and dates[0] >= dates[-1] and dates[-1] < since:
                break
        else:
            log.warning("stars statement truncated", extra={"pages": STATEMENT_MAX_PAGES})
        return records

    # ---------- вызов bot-gateway
    async def _call(self, method: str, http_method: str, path: str, *, json: Any = None,
                    params: dict[str, Any] | None = None, txn: str | None = None, order_no: int | None = None) -> Any:
        started = datetime.now(UTC)
        result_code = "ok"
        try:
            return await self._client().request(http_method, path, json=json, params=params)
        except UpstreamError as exc:
            result_code = exc.code
            log.warning("bot-gateway stars call failed", extra={"stars_method": method, "status": exc.status,
                                                                 "error_code": exc.code})
            raise _gateway_error(exc) from None
        finally:
            if self._journal is not None:
                latency = int((datetime.now(UTC) - started).total_seconds() * 1000)
                try:
                    await self._journal.record_call(CODE, "out", method, result_code, max(latency, 0),
                                                    provider_txn_id=txn, order_no=order_no)
                except Exception as exc:  # журнал — только метаданные; ошибка не меняет исход вызова
                    log.warning("provider call journal failed", extra={"error_type": type(exc).__name__})


def statement_record(item: Any) -> RemoteRecord | None:
    """Запись выписки bot-gateway → RemoteRecord; не оплата счёта пользователем (вывод, реклама, подарки) — None."""
    if not isinstance(item, dict):
        return None
    tx_id, amount, date = item.get("id"), item.get("amount"), item.get("date")
    direction = item.get("direction")
    if not isinstance(tx_id, str) or not tx_id or len(tx_id) > CHARGE_ID_MAX:
        return None
    if not isinstance(amount, int) or isinstance(amount, bool) or amount < 0:
        return None
    if not isinstance(date, int) or isinstance(date, bool) or date <= 0 or direction not in ("in", "out"):
        return None
    if item.get("partner_type") != STATEMENT_PARTNER_TYPE \
            or item.get("transaction_type") not in STATEMENT_TRANSACTION_TYPES:
        return None
    payload = item.get("invoice_payload")
    period = item.get("subscription_period")
    meta: dict[str, Any] = {"transaction_type": item.get("transaction_type")}
    if isinstance(period, int) and not isinstance(period, bool):
        meta["subscription_period"] = period
    return RemoteRecord(
        provider=CODE,
        provider_txn_id=tx_id,
        order_ref=payload if isinstance(payload, str) and payload else None,
        amount_tiyin=None,
        amount_stars=amount,
        state="performed" if direction == "in" else "refunded",
        at=datetime.fromtimestamp(date, UTC),
        direction=direction,
        meta=meta,
    )


def build_stars_adapter(settings: Settings, runtime: Any, *, journal: ProviderCallJournal | None = None
                        ) -> TelegramStarsAdapter:
    """Адаптер на клиенте bot-gateway из Runtime billing (`clients.BOTGW`; клиент создаётся при старте Runtime)."""
    from tilhero_billing.clients import BOTGW

    return TelegramStarsAdapter(settings, lambda: runtime.client(BOTGW), journal=journal)


def build_adapter(rt: Any) -> TelegramStarsAdapter:
    """Фабрика по соглашению ядра (`domain/adapters.py`: `providers/<code>.py: build_adapter(rt)`): настройки и клиент
    bot-gateway — из Runtime; журнал исходящих вызовов — `PaymentService.record_call` ядра (если он есть)."""
    journal: ProviderCallJournal | None = None
    try:
        from tilhero_billing.domain.payments import PaymentService

        service = PaymentService(rt)
        journal = service if isinstance(service, ProviderCallJournal) else None
    except ImportError:  # ядро ещё не сдано — без журнала
        journal = None
    return build_stars_adapter(cast(Settings, rt.settings), rt, journal=journal)
