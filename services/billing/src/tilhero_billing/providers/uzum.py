"""Uzum Bank Merchant API — канал `web`, **за флагом `UZUM_ENABLED`** до сверки спецификации (INTERNAL_API спринта 8
§1.8; §14 U1, О7).

⚠ Официальная документация (developer.uzumbank.uz: merchant, checkout, fiscalization) не загрузилась; подключение —
через менеджера Uzum. Всё ниже — по сторонним описаниям (§15: Go-пакет tergeoo/payment-providers-go/uzum, пример
вебхуков John5813/Edu#263). Каждое неподтверждённое место помечено «сверить при договоре»; боевое включение — только
после сверки и контрактных тестов на реальной спецификации.

Колбэки: `POST /pay/uzum/{check|create|confirm|reverse|status}` (payments-edge) → `/provider/v1/uzum/{op}`; JSON;
Basic (`UZUM_LOGIN`/`UZUM_PASSWORD`, постоянное время), IP (`UZUM_ALLOWED_CIDRS`); `serviceId` = `UZUM_SERVICE_ID`;
счёт — `params.<UZUM_ACCOUNT_FIELD>` (`order_id`, номер заказа); `amount` — тийины, `timestamp` — мс. Выключенная
оплата → `check`/`create` — 99999; `confirm`/`reverse`/`status` по уже созданной транзакции обрабатываются.

Возврат — через Uzum (`manual`, кабинет/менеджер), подтверждение — `reverse` по проведённой. Фискализация —
`no_op` до сверки (ядро заводит `fiscal_missing`). Сверки нет (`remote_status` → None).
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping
from datetime import datetime
from typing import Any
from urllib.parse import quote
from uuid import UUID

from tilhero_billing.domain.ports import (
    AlreadyPaid,
    AmountMismatch,
    InvalidState,
    OrderBusy,
    OrderClosed,
    OrderNotFound,
    PaymentError,
    PaymentPort,
    PaymentsDisabled,
    TxnNotFound,
    TxnTimedOut,
)
from tilhero_billing.providers.base import (
    CancelReason,
    Checkout,
    FiscalOutcome,
    InboundCall,
    OrderView,
    OutboundResponse,
    ProviderCode,
    RefundOutcome,
    RemoteRecord,
    TxnState,
    TxnView,
)
from tilhero_billing.providers.common import (
    BadJson,
    CheckoutUnavailable,
    as_int,
    basic_auth_ok,
    digits,
    dt_to_ms,
    ip_allowed,
    ms_to_dt,
    parse_json,
    return_url_for,
    runtime_parts,
    utcnow,
)
from tilhero_billing.settings import Settings
from tilhero_common.app import Runtime

log = logging.getLogger("tilhero.billing.providers.uzum")

# ================================================================ таблица констант Uzum (всё — сверить при договоре)
PROVIDER: ProviderCode = "uzum"
OPERATIONS = ("check", "create", "confirm", "reverse", "status")
# статусы ответа
ST_OK = "OK"
ST_CREATED = "CREATED"
ST_CONFIRMED = "CONFIRMED"
ST_REVERSED = "REVERSED"
ST_FAILED = "FAILED"
TXN_STATUS: Mapping[TxnState, str] = {"created": ST_CREATED, "performed": ST_CONFIRMED, "cancelled": ST_REVERSED,
                                      "refunded": ST_REVERSED}
# коды ошибок (имена — по константам сторонних SDK)
E_ACCESS_DENIED = 10001
E_JSON = 10002
E_OPERATION = 10003
E_PARAMS = 10005
E_SERVICE_ID = 10006
E_ORDER_NOT_FOUND = 10007
E_ALREADY_PROCESSED = 10008
E_PAYMENT_CANCELLED = 10009
E_TRANS_EXISTS = 10010
E_AMOUNT = 10011
E_AMOUNT_TOO_LOW = 10012
E_AMOUNT_TOO_HIGH = 10013
E_TXN_NOT_FOUND = 10014
E_TXN_CANCELLED = 10015
E_ALREADY_CONFIRMED = 10016
E_CANNOT_REVERSE = 10017
E_ALREADY_REVERSED = 10018
E_UNAVAILABLE = 99999
NOTES: Mapping[int, str] = {
    E_ACCESS_DENIED: "Access denied", E_JSON: "JSON parsing error", E_OPERATION: "Invalid operation",
    E_PARAMS: "Required parameters are missing", E_SERVICE_ID: "Invalid serviceId",
    E_ORDER_NOT_FOUND: "Account not found",
    E_ALREADY_PROCESSED: "Payment already processed", E_PAYMENT_CANCELLED: "Payment cancelled",
    E_TRANS_EXISTS: "Transaction already exists", E_AMOUNT: "Invalid amount", E_AMOUNT_TOO_LOW: "Amount too low",
    E_AMOUNT_TOO_HIGH: "Amount too high", E_TXN_NOT_FOUND: "Transaction not found",
    E_TXN_CANCELLED: "Transaction cancelled", E_ALREADY_CONFIRMED: "Transaction already confirmed",
    E_CANNOT_REVERSE: "Transaction cannot be reversed", E_ALREADY_REVERSED: "Transaction already reversed",
    E_UNAVAILABLE: "Service unavailable",
}
# HTTP-статус ответа с ошибкой: по стороннему примеру — 400 (сверить при договоре; §1.8 «HTTP-статус ошибки — сверить»)
ERROR_HTTP_STATUS = 400
# повтор операции по той же транзакции — ошибка, а не тот же ответ (по сторонним реализациям: create → 10010,
# confirm → 10016, reverse → 10018; деньги второй раз не зачисляются в любом случае) — сверить при договоре
# ключ `data` ответа: {"account": {"value": "<order_no>"}} (по Go-пакету) — сверить при договоре
DATA_ACCOUNT_KEY = "account"
AMOUNT_MIN = 100  # 1 сум — как CHECK orders.amount_tiyin
AMOUNT_MAX = 100_000_000_000
TRANS_ID_MAX = 128
# ================================================================


def _now_ms(clock: Callable[[], datetime]) -> int:
    return dt_to_ms(clock())


class _UzumError(Exception):
    def __init__(self, code: int, *, txn_id: str | None = None, order_no: int | None = None) -> None:
        super().__init__(str(code))
        self.code = code
        self.txn_id = txn_id
        self.order_no = order_no


def _service_id_value(settings: Settings) -> int | str:
    value = settings.uzum_service_id.strip()
    return int(value) if digits(value) else value


def _failed(settings: Settings, code: int, now_ms: int, *, txn_id: str | None = None,
            order_no: int | None = None) -> OutboundResponse:
    body = {"serviceId": _service_id_value(settings), "timestamp": now_ms, "status": ST_FAILED, "errorCode": code,
            "errorNote": NOTES[code]}
    return OutboundResponse(status_code=ERROR_HTTP_STATUS, body=body, result_code=f"{ST_FAILED}:{code}",
                            provider_txn_id=txn_id, order_no=order_no)


def unavailable_response(settings: Settings) -> OutboundResponse:
    """Временный отказ в формате Uzum (лимит вызовов, непредвиденный сбой): 99999."""
    return _failed(settings, E_UNAVAILABLE, dt_to_ms(utcnow()))


def _domain_error(exc: PaymentError, order_no: int | None = None) -> _UzumError:
    if isinstance(exc, OrderNotFound):
        return _UzumError(E_ORDER_NOT_FOUND, order_no=order_no)
    if isinstance(exc, AlreadyPaid | OrderBusy):
        return _UzumError(E_ALREADY_PROCESSED, order_no=order_no)
    if isinstance(exc, OrderClosed):
        return _UzumError(E_PAYMENT_CANCELLED, order_no=order_no)
    if isinstance(exc, AmountMismatch):
        return _UzumError(E_AMOUNT, order_no=order_no)
    if isinstance(exc, PaymentsDisabled):
        return _UzumError(E_UNAVAILABLE, order_no=order_no)
    if isinstance(exc, TxnNotFound):
        return _UzumError(E_TXN_NOT_FOUND)
    if isinstance(exc, InvalidState | TxnTimedOut):
        return _UzumError(E_TXN_CANCELLED, order_no=order_no)
    log.error("uzum: unexpected domain error", extra={"error_type": type(exc).__name__})
    return _UzumError(E_UNAVAILABLE, order_no=order_no)


def _trans_id(req: Mapping[str, Any]) -> str:
    value = req.get("transId")
    if isinstance(value, int) and not isinstance(value, bool):
        value = str(value)
    if not isinstance(value, str) or not 1 <= len(value) <= TRANS_ID_MAX:
        raise _UzumError(E_PARAMS)
    return value


class UzumAdapter:
    """Адаптер Uzum (`ProviderAdapter`); включается только флагом `UZUM_ENABLED`."""

    code: ProviderCode = PROVIDER

    def __init__(self, settings: Settings, *, clock: Callable[[], datetime] = utcnow) -> None:
        self.settings = settings
        self.clock = clock

    def enabled(self) -> bool:
        return self.settings.provider_enabled(PROVIDER)

    def _order_ref(self, req: Mapping[str, Any]) -> str:
        params = req.get("params")
        if not isinstance(params, dict):
            raise _UzumError(E_PARAMS)
        raw = params.get(self.settings.uzum_account_field)
        if isinstance(raw, dict):  # {"value": …} — по Go-пакету; скаляр — по примеру вебхуков (сверить)
            raw = raw.get("value")
        if raw is None:
            raise _UzumError(E_PARAMS)
        ref = digits(raw)
        if ref is None:
            raise _UzumError(E_ORDER_NOT_FOUND)
        return ref

    def _ok(self, body: dict[str, Any], *, txn_id: str | None = None, order_no: int | None = None) -> OutboundResponse:
        body = {"serviceId": _service_id_value(self.settings), **body}
        return OutboundResponse(status_code=200, body=body, result_code=str(body["status"]), provider_txn_id=txn_id,
                                order_no=order_no)

    @staticmethod
    def _data(order_no: int | str) -> dict[str, Any]:
        return {DATA_ACCOUNT_KEY: {"value": str(order_no)}}

    def _txn_body(self, txn: TxnView, status: str) -> dict[str, Any]:
        return {"transId": txn.provider_txn_id, "status": status, "transTime": dt_to_ms(txn.created_at),
                "confirmTime": dt_to_ms(txn.performed_at) if txn.performed_at else None,
                "reverseTime": dt_to_ms(txn.cancelled_at) if txn.cancelled_at else None,
                "data": self._data(txn.order_no), "amount": txn.amount_tiyin}

    async def handle(self, call: InboundCall, payments: PaymentPort) -> OutboundResponse:
        now_ms = dt_to_ms(call.received_at)
        op = call.operation
        if op not in OPERATIONS:
            return _failed(self.settings, E_OPERATION, now_ms)
        auth_ok = basic_auth_ok(call.headers.get("authorization"), self.settings.uzum_login,
                                self.settings.uzum_password.get_secret_value())
        if not auth_ok or not ip_allowed(call.client_ip, self.settings.allowed_cidrs(PROVIDER)):
            return _failed(self.settings, E_ACCESS_DENIED, now_ms)
        try:
            req = parse_json(call.body)
        except BadJson:
            return _failed(self.settings, E_JSON, now_ms)
        if not isinstance(req, dict):
            return _failed(self.settings, E_JSON, now_ms)
        try:
            service = req.get("serviceId")
            if service is None or as_int(req.get("timestamp")) is None:
                raise _UzumError(E_PARAMS)
            if not self.settings.uzum_service_id or digits(service) != self.settings.uzum_service_id.strip():
                raise _UzumError(E_SERVICE_ID)
            if op in ("check", "create") and not self.enabled():
                raise _UzumError(E_UNAVAILABLE)
            if op == "check":
                return await self._check(req, payments)
            if op == "create":
                return await self._create(req, payments)
            if op == "confirm":
                return await self._confirm(req, payments)
            if op == "reverse":
                return await self._reverse(req, payments)
            return await self._status(req, payments)
        except _UzumError as exc:
            return _failed(self.settings, exc.code, now_ms, txn_id=exc.txn_id, order_no=exc.order_no)
        except PaymentError as exc:
            err = _domain_error(exc)
            return _failed(self.settings, err.code, now_ms)
        except Exception as exc:  # сбой БД — 99999, Uzum повторит
            log.error("uzum handler failed", extra={"op": op, "error_type": type(exc).__name__})
            return _failed(self.settings, E_UNAVAILABLE, now_ms)

    async def _check(self, req: Mapping[str, Any], payments: PaymentPort) -> OutboundResponse:
        order_ref = self._order_ref(req)
        amount = as_int(req.get("amount"))
        try:
            # сумма в check может не прийти (§14 U1): ядро тогда проверяет заказ без суммы (amount=None)
            await payments.check(PROVIDER, order_ref, amount)
        except AmountMismatch as exc:
            raise _UzumError(E_AMOUNT, order_no=int(order_ref)) from exc
        except PaymentError as exc:
            raise _domain_error(exc, int(order_ref)) from exc
        return self._ok({"timestamp": _now_ms(self.clock), "status": ST_OK, "data": self._data(order_ref)},
                        order_no=int(order_ref))

    async def _create(self, req: Mapping[str, Any], payments: PaymentPort) -> OutboundResponse:
        trans_id = _trans_id(req)
        amount = as_int(req.get("amount"))
        if amount is None:
            raise _UzumError(E_PARAMS, txn_id=trans_id)
        order_ref = self._order_ref(req)
        if amount < AMOUNT_MIN:
            raise _UzumError(E_AMOUNT_TOO_LOW, txn_id=trans_id, order_no=int(order_ref))
        if amount > AMOUNT_MAX:
            raise _UzumError(E_AMOUNT_TOO_HIGH, txn_id=trans_id, order_no=int(order_ref))
        try:
            existing = await payments.get(PROVIDER, trans_id)
        except TxnNotFound:
            existing = None
        if existing is not None:
            raise _UzumError(E_TRANS_EXISTS, txn_id=trans_id, order_no=existing.order_no)
        try:
            txn = await payments.create(PROVIDER, trans_id, order_ref, amount, ms_to_dt(int(req["timestamp"])), {})
        except PaymentError as exc:
            err = _domain_error(exc, int(order_ref))
            raise _UzumError(err.code, txn_id=trans_id, order_no=int(order_ref)) from exc
        if txn.state != "created":  # гонка повторов: транзакция уже ушла дальше
            raise _UzumError(E_TRANS_EXISTS, txn_id=trans_id, order_no=txn.order_no)
        return self._ok({"transId": trans_id, "status": ST_CREATED, "transTime": dt_to_ms(txn.created_at),
                         "data": self._data(txn.order_no), "amount": txn.amount_tiyin},
                        txn_id=trans_id, order_no=txn.order_no)

    async def _get(self, payments: PaymentPort, trans_id: str) -> TxnView:
        try:
            return await payments.get(PROVIDER, trans_id)
        except TxnNotFound as exc:
            raise _UzumError(E_TXN_NOT_FOUND, txn_id=trans_id) from exc

    async def _confirm(self, req: Mapping[str, Any], payments: PaymentPort) -> OutboundResponse:
        trans_id = _trans_id(req)
        txn = await self._get(payments, trans_id)
        if txn.state == "performed":
            raise _UzumError(E_ALREADY_CONFIRMED, txn_id=trans_id, order_no=txn.order_no)
        if txn.state in ("cancelled", "refunded"):
            raise _UzumError(E_TXN_CANCELLED, txn_id=trans_id, order_no=txn.order_no)
        source = req.get("paymentSource")
        try:
            txn = await payments.perform(PROVIDER, trans_id,
                                         {"paymentSource": source[:40]} if isinstance(source, str) else None)
        except PaymentError as exc:
            err = _domain_error(exc, txn.order_no)
            raise _UzumError(err.code, txn_id=trans_id, order_no=txn.order_no) from exc
        if txn.state != "performed":
            raise _UzumError(E_TXN_CANCELLED, txn_id=trans_id, order_no=txn.order_no)
        return self._ok({"transId": trans_id, "status": ST_CONFIRMED,
                         "confirmTime": dt_to_ms(txn.performed_at or txn.created_at),
                         "data": self._data(txn.order_no), "amount": txn.amount_tiyin},
                        txn_id=trans_id, order_no=txn.order_no)

    async def _reverse(self, req: Mapping[str, Any], payments: PaymentPort) -> OutboundResponse:
        trans_id = _trans_id(req)
        txn = await self._get(payments, trans_id)
        if txn.state in ("cancelled", "refunded"):
            raise _UzumError(E_ALREADY_REVERSED, txn_id=trans_id, order_no=txn.order_no)
        # до confirm — отмена попытки; после — возврат по инициативе Uzum или подтверждение нашего (§1.12)
        reason: CancelReason = "refund" if txn.state == "performed" else "provider_error"
        try:
            txn = await payments.cancel(PROVIDER, trans_id, reason, None)
        except (InvalidState, TxnTimedOut) as exc:
            raise _UzumError(E_CANNOT_REVERSE, txn_id=trans_id, order_no=txn.order_no) from exc
        if txn.state not in ("cancelled", "refunded"):
            raise _UzumError(E_CANNOT_REVERSE, txn_id=trans_id, order_no=txn.order_no)
        return self._ok({"transId": trans_id, "status": ST_REVERSED,
                         "reverseTime": dt_to_ms(txn.cancelled_at or txn.created_at),
                         "data": self._data(txn.order_no), "amount": txn.amount_tiyin},
                        txn_id=trans_id, order_no=txn.order_no)

    async def _status(self, req: Mapping[str, Any], payments: PaymentPort) -> OutboundResponse:
        trans_id = _trans_id(req)
        txn = await self._get(payments, trans_id)
        return self._ok(self._txn_body(txn, TXN_STATUS[txn.state]), txn_id=trans_id, order_no=txn.order_no)

    # ------------------------------------------------------------ ссылка, возврат, фискализация, сверка

    async def checkout(self, order: OrderView, *, locale: str, return_url: str | None) -> Checkout:
        """Ссылка по шаблону `UZUM_CHECKOUT_URL_TEMPLATE` (`{service_id}`, `{order_no}`, `{amount_tiyin}`,
        `{return_url}` — URL-кодированный, `{locale}`) — до сверки формата ссылки (§14 U1)."""
        if order.provider != PROVIDER or order.channel != "web" or order.currency != "UZS" \
                or order.amount_tiyin is None:
            raise CheckoutUnavailable("ORDER_NOT_UZUM")
        template = self.settings.uzum_checkout_url_template.strip()
        if not template:
            raise CheckoutUnavailable("UZUM_NOT_CONFIGURED")
        values = {
            "{service_id}": quote(self.settings.uzum_service_id.strip(), safe=""),
            "{order_no}": str(order.order_no),
            "{amount_tiyin}": str(order.amount_tiyin),
            "{return_url}": quote(return_url or return_url_for(self.settings, order.order_no), safe=""),
            "{locale}": locale if locale in ("ru", "uz") else order.locale,
        }
        url = template
        for placeholder, value in values.items():
            url = url.replace(placeholder, value)
        allowed = ("https://",) if self.settings.is_secure_env else ("https://", "http://")
        if not url.startswith(allowed):
            raise CheckoutUnavailable("UZUM_CHECKOUT_URL_INVALID")
        return Checkout(kind="redirect", url=url)

    async def refund(self, txn: TxnView, *, account_id: UUID | None) -> RefundOutcome:
        """Возврат — через Uzum (кабинет/менеджер); завершит его `reverse` по проведённой."""
        return RefundOutcome(kind="manual", instruction={"provider": PROVIDER, "provider_txn_id": txn.provider_txn_id,
                                                         "amount_tiyin": txn.amount_tiyin})

    async def fiscalize(self, txn: TxnView, order: OrderView) -> FiscalOutcome:
        """Fiscalization API Uzum не подтверждён — до сверки no_op (ядро: пункт fiscal_missing)."""
        return FiscalOutcome(kind="no_op")

    async def remote_status(self, since: datetime) -> list[RemoteRecord] | None:
        return None


def build_adapter(rt: Runtime) -> UzumAdapter:
    """Фабрика по соглашению ядра (`domain/adapters.py`); включается только флагом `UZUM_ENABLED`."""
    settings, _, clock, _ = runtime_parts(rt)
    return UzumAdapter(settings, clock=clock)
