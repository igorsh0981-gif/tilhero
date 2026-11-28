"""Payme Merchant API — канал `web` (INTERNAL_API спринта 8 §1.6, §1.9; что не подтверждено — §14 P1–P6).

Колбэк: `POST /pay/payme` (payments-edge) → `POST /provider/v1/payme` (api/callbacks.py, X-Edge-Token уже проверен).
JSON-RPC 2.0, **ответ всегда HTTP 200** (иной статус Payme считает -32400): `{"jsonrpc", "id", "result" | "error"}`,
`error = {code, message: {ru, uz, en}, data?}`. Суммы — целые тийины, время — мс. Данные — только через
`PaymentPort`; заказ канала не `web` для Payme не существует (`OrderNotFound` → -31050).

Порядок проверок: не POST → -32300; не JSON → -32700; Basic (логин `PAYME_LOGIN`, пароль — ключ кассы `PAYME_KEY`,
постоянное время), IP (`PAYME_ALLOWED_CIDRS`, пусто — не проверяется), `PAYMENTS_ENABLED` / `PAYME_ENABLED` → -32504;
нет `method`/`params` → -32600; неизвестный метод (в т. ч. `ChangePassword`) → -32601; сбой БД → -32400.

Исходящие: Subscribe API `receipts.get_all` — только сверка и только при заданных `PAYME_SUBSCRIBE_URL` и
`PAYME_SUBSCRIBE_KEY` (§1.14, §14 P5). Возврат — в кабинете Payme Business (`manual`), завершение — `CancelTransaction`
по проведённой (state −2). Чек регистрирует Payme (`detail` в `CheckPerformTransaction`), данные чека приходят в
`SetFiscalData` — `fiscalize` здесь `no_op`.
"""

from __future__ import annotations

import base64
import logging
import re
from collections.abc import Awaitable, Callable, Mapping
from datetime import datetime
from typing import Any, Literal
from uuid import UUID

import httpx

from tilhero_billing.domain.ports import (
    AlreadyPaid,
    AmountMismatch,
    FiscalKind,
    InvalidState,
    OrderBusy,
    OrderClosed,
    OrderNotFound,
    PaymentError,
    PaymentPort,
    PaymentsDisabled,
    ReceiptTxnNotFound,
    TxnNotFound,
    TxnTimedOut,
)
from tilhero_billing.providers.base import (
    CancelReason,
    Checkout,
    FiscalItem,
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
    HttpResult,
    ProviderCallSink,
    ProviderHttp,
    ProviderUnavailable,
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

log = logging.getLogger("tilhero.billing.providers.payme")

# ================================================================ таблица констант Payme
PROVIDER: ProviderCode = "payme"
ACCOUNT_FIELD = "order_id"  # поле Account — задаётся в кабинете кассы; значение — order_no
TIMEOUT_MS = 43_200_000  # 12 ч: транзакция в ожидании старше — отмена с reason 4 (CreateTransaction, Perform)
REASON_TIMEOUT = 4
RECEIPT_TYPE_SALE = 0  # detail.receipt_type: 0 — продажа
CHECKOUT_LANGS = ("ru", "uz")  # параметр `l` ссылки (Payme умеет ещё `en`)
# состояния транзакции Payme ↔ наши (§1.4)
STATE_CODES: Mapping[TxnState, int] = {"created": 1, "performed": 2, "cancelled": -1, "refunded": -2}

# коды ошибок Merchant API
E_TRANSPORT = -32300  # метод запроса не POST
E_PARSE = -32700  # тело не JSON
E_INVALID_REQUEST = -32600  # нет обязательных полей или не тот тип
E_METHOD_NOT_FOUND = -32601
E_AUTH = -32504  # недостаточно привилегий: Basic, IP, оплата выключена
E_SYSTEM = -32400  # системная ошибка (сбой БД)
E_INVALID_PARAMS = -32602  # SetFiscalData: неверные параметры
E_RECEIPT_NOT_FOUND = -32001  # SetFiscalData: транзакция чека не найдена — сверить при договоре (§14 P4)
E_AMOUNT = -31001
E_TXN_NOT_FOUND = -31003
E_CANNOT_PERFORM = -31008
E_ORDER = -31050  # -31050…-31099 — ошибки поля account (`data` — имя поля)
# у заказа уже есть транзакция в ожидании: песочница ждёт -31008, практика — -31050…-31099 (§14 P2) —
# сверить при договоре; -31007 («отменить нельзя») не возвращается: возврат инициирует мерчант в кабинете
E_ORDER_BUSY = -31008

# reason отмены Payme → наш cancel_reason (как пришёл — ещё и в provider_reason)
CANCEL_REASONS: Mapping[int, CancelReason] = {1: "receivers_not_found", 2: "debit_error", 3: "execution_error",
                                              4: "timeout", 5: "refund", 10: "unknown"}
# CheckTransaction / GetStatement: reason для отмен с нашей стороны (provider_reason нет) — сверить при договоре
REASON_FOR_PAYME: Mapping[CancelReason, int] = {"receivers_not_found": 1, "debit_error": 2, "execution_error": 3,
                                                "timeout": 4, "refund": 5, "unknown": 10, "provider_error": 10,
                                                "order_closed": 3}
METHODS = ("CheckPerformTransaction", "CreateTransaction", "PerformTransaction", "CancelTransaction",
           "CheckTransaction", "GetStatement", "SetFiscalData")
FISCAL_TYPES: Mapping[str, FiscalKind] = {"PERFORM": "sale", "CANCEL": "refund"}
# поля fiscal_data SetFiscalData, которые сохраняем (без ПДн; ссылка — только https)
FISCAL_STR_FIELDS = ("terminal_id", "fiscal_sign", "message", "date")

# Subscribe API (только сверка; §14 P5 — видны ли checkout-чеки в receipts.get_all, сверить)
SUBSCRIBE_METHOD = "receipts.get_all"
SUBSCRIBE_PAGE = 50
SUBSCRIBE_MAX_PAGES = 40
# состояния чека Subscribe API → наши: 4 — оплачен, 50 — отменён, прочие — в процессе (сверить при договоре)
RemoteState = Literal["created", "performed", "cancelled", "refunded", "unknown"]
RECEIPT_STATES: Mapping[int, RemoteState] = {0: "created", 1: "created", 2: "created", 3: "created", 4: "performed",
                                     5: "created", 6: "created", 20: "created", 21: "created", 30: "created",
                                     50: "cancelled"}

# тексты ошибок {ru, uz, en}; узбекский — латиница, `oʻ`/`gʻ` — U+02BB
MESSAGES: Mapping[str, Mapping[str, str]] = {
    "transport": {"ru": "Метод запроса должен быть POST", "uz": "Soʻrov usuli POST boʻlishi kerak",
                  "en": "Request method must be POST"},
    "parse": {"ru": "Ошибка разбора JSON", "uz": "JSON tahlil qilishda xatolik", "en": "JSON parse error"},
    "invalid_request": {"ru": "Неверный запрос: нет обязательных полей или неверный тип",
                        "uz": "Notoʻgʻri soʻrov: majburiy maydonlar yoʻq yoki turi notoʻgʻri",
                        "en": "Invalid request: missing fields or wrong type"},
    "method": {"ru": "Метод не найден", "uz": "Usul topilmadi", "en": "Method not found"},
    "auth": {"ru": "Недостаточно привилегий для выполнения метода", "uz": "Usulni bajarish uchun huquq yetarli emas",
             "en": "Insufficient privileges to perform this method"},
    "system": {"ru": "Системная ошибка", "uz": "Tizim xatosi", "en": "System error"},
    "invalid_params": {"ru": "Неверные параметры", "uz": "Notoʻgʻri parametrlar", "en": "Invalid parameters"},
    "receipt_not_found": {"ru": "Транзакция чека не найдена", "uz": "Chek tranzaksiyasi topilmadi",
                          "en": "Receipt transaction not found"},
    "amount": {"ru": "Неверная сумма", "uz": "Notoʻgʻri summa", "en": "Incorrect amount"},
    "txn_not_found": {"ru": "Транзакция не найдена", "uz": "Tranzaksiya topilmadi", "en": "Transaction not found"},
    "cannot_perform": {"ru": "Невозможно выполнить операцию", "uz": "Amalni bajarib boʻlmaydi",
                       "en": "Unable to perform operation"},
    "timeout": {"ru": "Время ожидания транзакции истекло", "uz": "Tranzaksiyani kutish vaqti tugadi",
                "en": "Transaction timed out"},
    "order_not_found": {"ru": "Заказ не найден", "uz": "Buyurtma topilmadi", "en": "Order not found"},
    "order_closed": {"ru": "Заказ недоступен для оплаты", "uz": "Buyurtmani toʻlab boʻlmaydi",
                     "en": "Order is not available for payment"},
    "order_paid": {"ru": "Заказ уже оплачен", "uz": "Buyurtma allaqachon toʻlangan", "en": "Order is already paid"},
    "order_busy": {"ru": "Заказ ожидает оплаты по другой транзакции",
                   "uz": "Buyurtma boshqa tranzaksiya boʻyicha toʻlovni kutmoqda",
                   "en": "Order is awaiting payment by another transaction"},
}
# ================================================================


class _RpcError(Exception):
    def __init__(self, code: int, key: str, data: str | None = None, *, txn_id: str | None = None,
                 order_no: int | None = None) -> None:
        super().__init__(key)
        self.code = code
        self.key = key
        self.data = data
        self.txn_id = txn_id
        self.order_no = order_no


def _rpc_id(req: Any) -> int | str | None:
    if not isinstance(req, dict):
        return None
    value = req.get("id")
    if isinstance(value, bool):
        return None
    if isinstance(value, int) or (isinstance(value, str) and len(value) <= 64):
        return value
    return None


def _error(rpc_id: int | str | None, code: int, key: str, data: str | None = None, *, txn_id: str | None = None,
           order_no: int | None = None) -> OutboundResponse:
    err: dict[str, Any] = {"code": code, "message": dict(MESSAGES[key])}
    if data is not None:
        err["data"] = data
    return OutboundResponse(status_code=200, body={"jsonrpc": "2.0", "id": rpc_id, "error": err},
                            result_code=str(code), provider_txn_id=txn_id, order_no=order_no)


def _result(rpc_id: int | str | None, result: Mapping[str, Any], *, txn_id: str | None = None,
            order_no: int | None = None) -> OutboundResponse:
    return OutboundResponse(status_code=200, body={"jsonrpc": "2.0", "id": rpc_id, "result": dict(result)},
                            result_code="0", provider_txn_id=txn_id, order_no=order_no)


def unavailable_response(body: bytes) -> OutboundResponse:
    """Системная ошибка в формате Payme (HTTP 200, -32400): лимит вызовов или непредвиденный сбой."""
    try:
        rpc_id = _rpc_id(parse_json(body))
    except BadJson:
        rpc_id = None
    return _error(rpc_id, E_SYSTEM, "system")


def rpc_method_label(body: bytes) -> str:
    """Имя метода для `provider_calls.method`: только известные методы, иначе `rpc`."""
    try:
        req = parse_json(body)
    except BadJson:
        return "rpc"
    method = req.get("method") if isinstance(req, dict) else None
    return method if method in METHODS else "rpc"


def _domain_error(exc: PaymentError, order_no: int | None = None) -> _RpcError:
    """Ошибка PaymentPort → код Payme (таблица §1.6)."""
    if isinstance(exc, OrderNotFound):
        return _RpcError(E_ORDER, "order_not_found", ACCOUNT_FIELD, order_no=order_no)
    if isinstance(exc, OrderClosed):
        return _RpcError(E_ORDER, "order_closed", ACCOUNT_FIELD, order_no=order_no)
    if isinstance(exc, AlreadyPaid):
        return _RpcError(E_ORDER, "order_paid", ACCOUNT_FIELD, order_no=order_no)
    if isinstance(exc, AmountMismatch):
        return _RpcError(E_AMOUNT, "amount", order_no=order_no)
    if isinstance(exc, OrderBusy):
        data = ACCOUNT_FIELD if -31099 <= E_ORDER_BUSY <= -31050 else None
        return _RpcError(E_ORDER_BUSY, "order_busy", data, order_no=order_no)
    if isinstance(exc, PaymentsDisabled):
        return _RpcError(E_AUTH, "auth")
    if isinstance(exc, TxnNotFound):
        return _RpcError(E_TXN_NOT_FOUND, "txn_not_found")
    if isinstance(exc, TxnTimedOut):
        return _RpcError(E_CANNOT_PERFORM, "timeout")
    if isinstance(exc, InvalidState):
        return _RpcError(E_CANNOT_PERFORM, "cannot_perform")
    if isinstance(exc, ReceiptTxnNotFound):
        return _RpcError(E_RECEIPT_NOT_FOUND, "receipt_not_found")
    log.error("payme: unexpected domain error", extra={"error_type": type(exc).__name__})
    return _RpcError(E_SYSTEM, "system")


# ---------------------------------------------------------------- разбор параметров

def _amount(params: Mapping[str, Any]) -> int:
    amount = as_int(params.get("amount"))
    if amount is None or amount <= 0:
        raise _RpcError(E_INVALID_REQUEST, "invalid_request")
    return amount


def _order_ref(params: Mapping[str, Any]) -> str:
    account = params.get("account")
    if not isinstance(account, dict):
        raise _RpcError(E_INVALID_REQUEST, "invalid_request")
    ref = digits(account.get(ACCOUNT_FIELD))
    if ref is None:  # нет поля или номер не число — «заказ не найден»
        raise _RpcError(E_ORDER, "order_not_found", ACCOUNT_FIELD)
    return ref


def _txn_id(params: Mapping[str, Any]) -> str:
    value = params.get("id")
    if not isinstance(value, str) or not 1 <= len(value) <= 128:
        raise _RpcError(E_INVALID_REQUEST, "invalid_request")
    return value


def _ms(params: Mapping[str, Any], name: str) -> int:
    value = as_int(params.get(name))
    if value is None or value < 0:
        raise _RpcError(E_INVALID_REQUEST, "invalid_request")
    return value


def _opt_ms(dt: datetime | None) -> int:
    return dt_to_ms(dt) if dt is not None else 0


def _payme_reason(txn: TxnView) -> int | None:
    if txn.state not in ("cancelled", "refunded"):
        return None
    if txn.provider_reason is not None:
        return txn.provider_reason
    return REASON_FOR_PAYME.get(txn.cancel_reason, 10) if txn.cancel_reason else None


def _detail_item(item: FiscalItem) -> dict[str, Any]:
    out: dict[str, Any] = {"title": item.title, "price": item.price_tiyin, "count": item.count, "code": item.ikpu,
                           "package_code": item.package_code, "vat_percent": item.vat_percent}
    if item.units is not None:
        out["units"] = item.units
    return out


def _fiscal_data(raw: Mapping[str, Any]) -> dict[str, Any]:
    """Только известные поля чека; ссылка — https, строки ограничены; иное отбрасывается."""
    data: dict[str, Any] = {}
    receipt_id = raw.get("receipt_id")
    if isinstance(receipt_id, int | str) and not isinstance(receipt_id, bool) and str(receipt_id):
        data["receipt_id"] = str(receipt_id)[:64]
    status = as_int(raw.get("status_code"))
    if status is not None:
        data["status_code"] = status
    for name in FISCAL_STR_FIELDS:
        value = raw.get(name)
        if isinstance(value, int) and not isinstance(value, bool):
            value = str(value)
        if isinstance(value, str) and value:
            data[name] = value[:500] if name == "message" else value[:64]
    qr = raw.get("qr_code_url")
    if isinstance(qr, str) and qr.startswith("https://") and len(qr) <= 500:
        data["qr_code_url"] = qr
    return data


Handler = Callable[[int | str | None, Mapping[str, Any], InboundCall, PaymentPort], Awaitable[OutboundResponse]]


class PaymeAdapter:
    """Адаптер Payme (`ProviderAdapter`)."""

    code: ProviderCode = PROVIDER

    def __init__(self, settings: Settings, *, transport: httpx.AsyncBaseTransport | None = None,
                 sink: ProviderCallSink | None = None, clock: Callable[[], datetime] = utcnow) -> None:
        self.settings = settings
        self.clock = clock
        self.http = ProviderHttp(PROVIDER, "", timeout=settings.provider_timeout_seconds, transport=transport,
                                 sink=sink)
        self._handlers: dict[str, Handler] = {
            "CheckPerformTransaction": self._check_perform,
            "CreateTransaction": self._create,
            "PerformTransaction": self._perform,
            "CancelTransaction": self._cancel,
            "CheckTransaction": self._check_txn,
            "GetStatement": self._statement,
            "SetFiscalData": self._set_fiscal_data,
        }

    def enabled(self) -> bool:
        return self.settings.provider_enabled(PROVIDER)

    # ------------------------------------------------------------ колбэк

    def _authorized(self, call: InboundCall) -> bool:
        key = self.settings.payme_key.get_secret_value()
        auth_ok = basic_auth_ok(call.headers.get("authorization"), self.settings.payme_login, key)
        return auth_ok and ip_allowed(call.client_ip, self.settings.allowed_cidrs(PROVIDER))

    async def handle(self, call: InboundCall, payments: PaymentPort) -> OutboundResponse:
        if call.method.upper() != "POST":
            return _error(None, E_TRANSPORT, "transport")
        try:
            req = parse_json(call.body)
        except BadJson:
            return _error(None, E_PARSE, "parse")
        rpc_id = _rpc_id(req)
        if not self._authorized(call) or not self.enabled():
            return _error(rpc_id, E_AUTH, "auth")
        if not isinstance(req, dict) or not isinstance(req.get("method"), str) or not isinstance(req.get("params"),
                                                                                                    dict):
            return _error(rpc_id, E_INVALID_REQUEST, "invalid_request")
        handler = self._handlers.get(req["method"])
        if handler is None:
            return _error(rpc_id, E_METHOD_NOT_FOUND, "method")
        try:
            return await handler(rpc_id, req["params"], call, payments)
        except _RpcError as exc:
            return _error(rpc_id, exc.code, exc.key, exc.data, txn_id=exc.txn_id, order_no=exc.order_no)
        except PaymentError as exc:
            err = _domain_error(exc)
            return _error(rpc_id, err.code, err.key, err.data)
        except Exception as exc:  # сбой БД и прочее — -32400, Payme повторит
            log.error("payme handler failed", extra={"rpc_method": req["method"], "error_type": type(exc).__name__})
            return _error(rpc_id, E_SYSTEM, "system")

    async def _check_perform(self, rpc_id: int | str | None, params: Mapping[str, Any], call: InboundCall,
                             payments: PaymentPort) -> OutboundResponse:
        amount = _amount(params)
        order_ref = _order_ref(params)
        try:
            ok = await payments.check(PROVIDER, order_ref, amount)
        except PaymentError as exc:
            raise _domain_error(exc, int(order_ref)) from exc
        if ok.order.channel != "web":  # защита в глубину: ядро и так отвечает OrderNotFound
            raise _RpcError(E_ORDER, "order_not_found", ACCOUNT_FIELD, order_no=int(order_ref))
        result: dict[str, Any] = {"allow": True}
        if ok.fiscal_items:
            result["detail"] = {"receipt_type": RECEIPT_TYPE_SALE,
                                "items": [_detail_item(item) for item in ok.fiscal_items]}
        return _result(rpc_id, result, order_no=ok.order.order_no)

    def _timed_out(self, txn: TxnView, now: datetime) -> bool:
        started = txn.provider_time or txn.created_at
        return dt_to_ms(now) - dt_to_ms(started) > TIMEOUT_MS

    async def _cancel_timed_out(self, payments: PaymentPort, txn: TxnView) -> None:
        await payments.cancel(PROVIDER, txn.provider_txn_id, "timeout", REASON_TIMEOUT)

    async def _create(self, rpc_id: int | str | None, params: Mapping[str, Any], call: InboundCall,
                      payments: PaymentPort) -> OutboundResponse:
        txn_id = _txn_id(params)
        time_ms = _ms(params, "time")
        amount = _amount(params)
        order_ref = _order_ref(params)
        try:
            txn = await payments.get(PROVIDER, txn_id)
        except TxnNotFound:
            try:
                txn = await payments.create(PROVIDER, txn_id, order_ref, amount, ms_to_dt(time_ms), {})
            except PaymentError as exc:
                raise _domain_error(exc, int(order_ref)) from exc
        else:  # повтор id: created — тот же ответ; просрочена — отмена (reason 4) и -31008; иначе -31008
            if txn.state == "created" and self._timed_out(txn, call.received_at):
                await self._cancel_timed_out(payments, txn)
                raise _RpcError(E_CANNOT_PERFORM, "timeout", txn_id=txn_id, order_no=txn.order_no)
        if txn.state != "created":
            raise _RpcError(E_CANNOT_PERFORM, "cannot_perform", txn_id=txn_id, order_no=txn.order_no)
        return _result(rpc_id, {"create_time": dt_to_ms(txn.created_at), "transaction": str(txn.seq),
                                "state": STATE_CODES["created"]}, txn_id=txn_id, order_no=txn.order_no)

    async def _get(self, payments: PaymentPort, txn_id: str) -> TxnView:
        try:
            return await payments.get(PROVIDER, txn_id)
        except TxnNotFound as exc:
            raise _RpcError(E_TXN_NOT_FOUND, "txn_not_found", txn_id=txn_id) from exc

    async def _perform(self, rpc_id: int | str | None, params: Mapping[str, Any], call: InboundCall,
                       payments: PaymentPort) -> OutboundResponse:
        txn_id = _txn_id(params)
        txn = await self._get(payments, txn_id)
        if txn.state == "created":
            if self._timed_out(txn, call.received_at):
                await self._cancel_timed_out(payments, txn)
                raise _RpcError(E_CANNOT_PERFORM, "timeout", txn_id=txn_id, order_no=txn.order_no)
            try:
                txn = await payments.perform(PROVIDER, txn_id)
            except PaymentError as exc:
                if isinstance(exc, TxnNotFound):
                    raise _RpcError(E_TXN_NOT_FOUND, "txn_not_found", txn_id=txn_id) from exc
                if isinstance(exc, PaymentsDisabled):
                    raise _RpcError(E_AUTH, "auth", txn_id=txn_id) from exc
                if isinstance(exc, TxnTimedOut):
                    raise _RpcError(E_CANNOT_PERFORM, "timeout", txn_id=txn_id, order_no=txn.order_no) from exc
                if isinstance(exc, InvalidState | AlreadyPaid | OrderClosed):
                    raise _RpcError(E_CANNOT_PERFORM, "cannot_perform", txn_id=txn_id, order_no=txn.order_no) from exc
                raise
        if txn.state != "performed":
            raise _RpcError(E_CANNOT_PERFORM, "cannot_perform", txn_id=txn_id, order_no=txn.order_no)
        return _result(rpc_id, {"transaction": str(txn.seq), "perform_time": _opt_ms(txn.performed_at),
                                "state": STATE_CODES["performed"]}, txn_id=txn_id, order_no=txn.order_no)

    async def _cancel(self, rpc_id: int | str | None, params: Mapping[str, Any], call: InboundCall,
                      payments: PaymentPort) -> OutboundResponse:
        txn_id = _txn_id(params)
        reason = as_int(params.get("reason"))
        if reason is None:
            raise _RpcError(E_INVALID_REQUEST, "invalid_request")
        txn = await self._get(payments, txn_id)
        if txn.state in ("created", "performed"):
            # created → cancelled; performed → возврат (§1.12: подтверждение нашего или по инициативе Payme)
            try:
                txn = await payments.cancel(PROVIDER, txn_id, CANCEL_REASONS.get(reason, "unknown"), reason)
            except InvalidState as exc:
                raise _RpcError(E_CANNOT_PERFORM, "cannot_perform", txn_id=txn_id, order_no=txn.order_no) from exc
        if txn.state not in ("cancelled", "refunded"):
            raise _RpcError(E_CANNOT_PERFORM, "cannot_perform", txn_id=txn_id, order_no=txn.order_no)
        return _result(rpc_id, {"transaction": str(txn.seq), "cancel_time": _opt_ms(txn.cancelled_at),
                                "state": STATE_CODES[txn.state]}, txn_id=txn_id, order_no=txn.order_no)

    async def _check_txn(self, rpc_id: int | str | None, params: Mapping[str, Any], call: InboundCall,
                         payments: PaymentPort) -> OutboundResponse:
        txn_id = _txn_id(params)
        txn = await self._get(payments, txn_id)
        return _result(rpc_id, {"create_time": dt_to_ms(txn.created_at), "perform_time": _opt_ms(txn.performed_at),
                                "cancel_time": _opt_ms(txn.cancelled_at), "transaction": str(txn.seq),
                                "state": STATE_CODES[txn.state], "reason": _payme_reason(txn)},
                       txn_id=txn_id, order_no=txn.order_no)

    async def _statement(self, rpc_id: int | str | None, params: Mapping[str, Any], call: InboundCall,
                         payments: PaymentPort) -> OutboundResponse:
        from_ms, to_ms = _ms(params, "from"), _ms(params, "to")
        if from_ms > to_ms:
            raise _RpcError(E_INVALID_REQUEST, "invalid_request")
        txns = await payments.statement(PROVIDER, ms_to_dt(from_ms), ms_to_dt(to_ms))
        items = [{
            "id": t.provider_txn_id,
            "time": _opt_ms(t.provider_time),
            "amount": t.amount_tiyin,
            "account": {ACCOUNT_FIELD: str(t.order_no)},
            "create_time": dt_to_ms(t.created_at),
            "perform_time": _opt_ms(t.performed_at),
            "cancel_time": _opt_ms(t.cancelled_at),
            "transaction": str(t.seq),
            "state": STATE_CODES[t.state],
            "reason": _payme_reason(t),
            "receivers": None,
        } for t in txns]
        return _result(rpc_id, {"transactions": items})

    async def _set_fiscal_data(self, rpc_id: int | str | None, params: Mapping[str, Any], call: InboundCall,
                               payments: PaymentPort) -> OutboundResponse:
        receipt_ref = params.get("id")
        fiscal_type = params.get("type")
        kind = FISCAL_TYPES.get(fiscal_type) if isinstance(fiscal_type, str) else None
        raw = params.get("fiscal_data")
        if not isinstance(receipt_ref, str) or not 1 <= len(receipt_ref) <= 128 or kind is None \
                or not isinstance(raw, dict):
            raise _RpcError(E_INVALID_PARAMS, "invalid_params")
        try:
            await payments.store_fiscal(PROVIDER, receipt_ref, kind, _fiscal_data(raw))
        except ReceiptTxnNotFound as exc:
            raise _RpcError(E_RECEIPT_NOT_FOUND, "receipt_not_found", txn_id=receipt_ref) from exc
        return _result(rpc_id, {"success": True}, txn_id=receipt_ref)

    # ------------------------------------------------------------ ссылка, возврат, фискализация, сверка

    async def checkout(self, order: OrderView, *, locale: str, return_url: str | None) -> Checkout:
        """GET-ссылка: `{PAYME_CHECKOUT_URL}/base64(m=…;ac.order_id=…;a=…;l=…;c=…)` (§1.6; адрес тестовой
        среды — переменной, §14 P6). `detail` чека Payme получает в ответе CheckPerformTransaction."""
        if order.provider != PROVIDER or order.channel != "web" or order.currency != "UZS" \
                or order.amount_tiyin is None:
            raise CheckoutUnavailable("ORDER_NOT_PAYME")
        merchant = self.settings.payme_merchant_id.strip()
        if not merchant or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", merchant):
            raise CheckoutUnavailable("PAYME_NOT_CONFIGURED")
        url = return_url or return_url_for(self.settings, order.order_no)
        if ";" in url or not url.startswith(("https://", "http://")):
            raise CheckoutUnavailable("RETURN_URL_INVALID")
        lang = locale if locale in CHECKOUT_LANGS else order.locale
        params = f"m={merchant};ac.{ACCOUNT_FIELD}={order.order_no};a={order.amount_tiyin};l={lang};c={url}"
        encoded = base64.b64encode(params.encode("utf-8")).decode("ascii")
        return Checkout(kind="redirect", url=f"{self.settings.payme_checkout_url.rstrip('/')}/{encoded}")

    async def refund(self, txn: TxnView, *, account_id: UUID | None) -> RefundOutcome:
        """Возврат — в кабинете Payme Business; завершит его CancelTransaction по проведённой (state −2)."""
        return RefundOutcome(kind="manual", instruction={"provider": PROVIDER, "provider_txn_id": txn.provider_txn_id,
                                                         "amount_tiyin": txn.amount_tiyin})

    async def fiscalize(self, txn: TxnView, order: OrderView) -> FiscalOutcome:
        """Чек регистрирует Payme по `detail`; данные приходят в SetFiscalData."""
        return FiscalOutcome(kind="no_op")

    async def remote_status(self, since: datetime) -> list[RemoteRecord] | None:
        """Subscribe API `receipts.get_all` (если заданы URL и ключ); сбой — None (ядро не делает выводов)."""
        url = self.settings.payme_subscribe_url.strip()
        key = self.settings.payme_subscribe_key.get_secret_value()
        merchant = self.settings.payme_merchant_id.strip()
        if not (url and key and merchant):
            return None
        until = self.clock()
        headers = {"X-Auth": f"{merchant}:{key}", "Content-Type": "application/json"}
        records: list[RemoteRecord] = []
        for page in range(SUBSCRIBE_MAX_PAGES):
            body = {"id": page + 1, "method": SUBSCRIBE_METHOD,
                    "params": {"count": SUBSCRIBE_PAGE, "from": dt_to_ms(since), "to": dt_to_ms(until),
                               "offset": page * SUBSCRIBE_PAGE}}
            try:
                res = await self.http.request("POST", url, op=SUBSCRIBE_METHOD, headers=headers, json_body=body,
                                              result_code=_subscribe_code)
            except ProviderUnavailable:
                return None
            payload = res.body if isinstance(res.body, dict) else {}
            receipts = payload.get("result")
            if res.status_code != 200 or "error" in payload or not isinstance(receipts, list):
                log.warning("payme receipts.get_all failed", extra={"status": res.status_code})
                return None
            records.extend(r for r in (_receipt_record(x) for x in receipts) if r is not None)
            if len(receipts) < SUBSCRIBE_PAGE:
                return records
        return records


def _subscribe_code(res: HttpResult) -> str:
    body = res.body if isinstance(res.body, dict) else {}
    err = body.get("error")
    if isinstance(err, dict) and as_int(err.get("code")) is not None:
        return str(err["code"])
    return "0" if res.status_code == 200 else f"HTTP_{res.status_code}"


def _receipt_record(raw: Any) -> RemoteRecord | None:
    if not isinstance(raw, dict) or not isinstance(raw.get("_id"), str):
        return None
    state_code = as_int(raw.get("state"))
    account = raw.get("account")
    order_ref: str | None = None
    if isinstance(account, list):
        for entry in account:
            if isinstance(entry, dict) and entry.get("name") == ACCOUNT_FIELD:
                order_ref = digits(entry.get("value"))
    elif isinstance(account, dict):
        order_ref = digits(account.get(ACCOUNT_FIELD))
    state: RemoteState = RECEIPT_STATES.get(state_code, "unknown") if state_code is not None else "unknown"
    if state == "cancelled" and (as_int(raw.get("pay_time")) or 0) > 0:
        state = "refunded"  # оплаченный и отменённый чек — возврат (наша транзакция в этом случае refunded)
    return RemoteRecord(provider=PROVIDER, provider_txn_id=raw["_id"][:128], order_ref=order_ref,
                        amount_tiyin=as_int(raw.get("amount")), amount_stars=None, state=state,
                        at=ms_to_dt(as_int(raw.get("create_time")) or 0), meta={"receipt_state": state_code})


def build_adapter(rt: Runtime) -> PaymeAdapter:
    """Фабрика по соглашению ядра (`domain/adapters.py`): настройки, часы и журнал `provider_calls` — из Runtime."""
    settings, sink, clock, _ = runtime_parts(rt)
    return PaymeAdapter(settings, sink=sink, clock=clock)
