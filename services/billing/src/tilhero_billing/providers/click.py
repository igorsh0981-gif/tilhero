"""Click SHOP API и Merchant API — канал `web` (INTERNAL_API спринта 8 §1.7, §1.9; не подтверждено — §14 C1–C4).

Колбэки: `POST /pay/click/prepare|complete` (payments-edge) → `POST /provider/v1/click/prepare|complete`;
`application/x-www-form-urlencoded`, ответ — JSON, HTTP 200. Сумма приходит строкой в сумах (`"15000.00"`) —
разбирается в целые тийины без float (ADR-0001); подпись MD5 считается по полям **как пришли** (строки после
URL-декодирования, без переформатирования суммы), сравнение — за постоянное время.

Prepare: нет полей → -8; подпись, `service_id` ≠ `CLICK_SERVICE_ID`, IP вне `CLICK_ALLOWED_CIDRS` → -1;
`PAYMENTS_ENABLED`/`CLICK_ENABLED` выключены → -9; `action` ≠ 0 → -3; заказ не найден или не `web` → -5; оплачен → -4;
закрыт → -9; сумма → -2; повтор `click_trans_id` → тот же `merchant_prepare_id` (идемпотентность PaymentPort).
Complete: нет полей → -8; подпись → -1; `action` ≠ 1 → -3; транзакции по `merchant_prepare_id` нет или другой
`click_trans_id` → -6; `error < 0` от Click → отмена (`provider_error`) и -9; проведена → -4; отменена → -9; сумма →
-2; заказ оплачен другой попыткой → -4; иначе проведение (+ выдача). Complete по созданной транзакции обрабатывается и
при выключенной оплате. Сбой БД → -7.

Merchant API (исходящие, база `CLICK_API_URL`, заголовок `Auth: {merchant_user_id}:{sha1(timestamp + secret)}:
{timestamp}`): возврат — `reversal` (только текущий отчётный месяц — проверяет ядро), фискализация — `submit_items`
+ ссылка на чек `ofd_data`, сверка — `status_by_mti` по нашим транзакциям за период. Таймаут 10 с, повтор чтения на
сеть/5xx, команды повторяются только если запрос не ушёл, circuit breaker.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping, Sequence
from datetime import UTC, datetime
from typing import Any, Literal, cast
from urllib.parse import parse_qs, quote, urlencode
from uuid import UUID
from zoneinfo import ZoneInfo

import httpx

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
    Checkout,
    FiscalItem,
    FiscalOutcome,
    InboundCall,
    OrderView,
    OutboundResponse,
    ProviderCode,
    RefundOutcome,
    RemoteRecord,
    TxnView,
)
from tilhero_billing.providers.common import (
    CheckoutUnavailable,
    HttpResult,
    ProviderCallSink,
    ProviderHttp,
    ProviderUnavailable,
    StatementSource,
    as_int,
    digits,
    dt_to_ms,
    format_sum,
    ip_allowed,
    md5_hex,
    parse_sum_string,
    return_url_for,
    runtime_parts,
    secret_equals,
    sha1_hex,
    utcnow,
    vat_inside,
)
from tilhero_billing.settings import Settings
from tilhero_common.app import Runtime

log = logging.getLogger("tilhero.billing.providers.click")

# ================================================================ таблица констант Click
PROVIDER: ProviderCode = "click"
OPERATIONS = ("prepare", "complete")
ACTION_PREPARE = 0
ACTION_COMPLETE = 1
# коды ответа мерчанта (SHOP API)
E_SUCCESS = 0
E_SIGN = -1  # подпись, service_id, IP
E_AMOUNT = -2
E_ACTION = -3
E_ALREADY_PAID = -4
E_ORDER_NOT_FOUND = -5
E_TXN_NOT_FOUND = -6
E_UPDATE = -7  # сбой БД
E_REQUEST = -8  # нет полей / не тот формат
E_CANCELLED = -9
NOTES: Mapping[int, str] = {
    E_SUCCESS: "Success",
    E_SIGN: "SIGN CHECK FAILED!",
    E_AMOUNT: "Incorrect parameter amount",
    E_ACTION: "Action not found",
    E_ALREADY_PAID: "Already paid",
    E_ORDER_NOT_FOUND: "User does not exist",
    E_TXN_NOT_FOUND: "Transaction does not exist",
    E_UPDATE: "Failed to update user",
    E_REQUEST: "Error in request from click",
    E_CANCELLED: "Transaction cancelled",
}
PREPARE_FIELDS = ("click_trans_id", "service_id", "merchant_trans_id", "amount", "action", "sign_time",
                  "sign_string")
COMPLETE_FIELDS = (*PREPARE_FIELDS, "merchant_prepare_id", "error")
SIGN_TIME_FORMAT = "%Y-%m-%d %H:%M:%S"
SIGN_TIME_ZONE = "Asia/Tashkent"  # §14 C4: пояс sign_time — сверить при договоре (храним UTC)
MAX_FORM_FIELDS = 32
# Merchant API (§14 C1: база CLICK_API_URL — по практике https://api.click.uz/v2/merchant; пути и методы — по
# практике, сверить при договоре)
API_STATUS_BY_MTI = "/payment/status_by_mti/{service_id}/{merchant_trans_id}/{payment_date}"  # GET
API_REVERSAL = "/payment/reversal/{service_id}/{payment_id}"  # DELETE
API_SUBMIT_ITEMS = "/payment/ofd_data/submit_items"  # POST
API_OFD_DATA = "/payment/ofd_data/{service_id}/{payment_id}"  # GET — путь не опубликован, сверить
# §14 C2: payment_id Merchant API ↔ click_paydoc_id («Payment ID in CLICK system») — сверить в тест-утилите; иначе —
# поиск по status_by_mti
PAYMENT_ID_META_KEYS = ("payment_id", "click_paydoc_id")
# payment_status Merchant API → наши состояния (сверить при договоре): 2 — оплачен, 0/1 — в обработке, < 0 — отменён
PaymentState = Literal["created", "performed", "cancelled", "refunded", "unknown"]
PAYMENT_STATUS: Mapping[int, PaymentState] = {2: "performed", 1: "created", 0: "created"}
RECONCILE_MAX_ORDERS = 200
# чек возврата Click не описан (§14 C4) — фискализация возврата: no_op и пункт сверки ядра
FISCALIZE_REFUNDS = False
# ================================================================

Form = dict[str, str]


def _parse_form(body: bytes) -> Form | None:
    """Форма Click: значения после URL-декодирования «как пришли»; повтор поля или не UTF-8 — None (-8)."""
    try:
        parsed = parse_qs(body.decode("utf-8"), keep_blank_values=True, strict_parsing=False,
                          max_num_fields=MAX_FORM_FIELDS)
    except (UnicodeDecodeError, ValueError):
        return None
    form: Form = {}
    for name, values in parsed.items():
        if len(values) != 1:
            return None
        form[name] = values[0]
    return form


def _signed_int(value: str) -> int | None:
    text = value.strip()
    if text.startswith("-"):
        rest = digits(text[1:], 9)
        return -int(rest) if rest is not None else None
    plain = digits(text, 9)
    return int(plain) if plain is not None else None


def unavailable_response(operation: str, body: bytes) -> OutboundResponse:
    """Временный отказ в формате Click (лимит вызовов, непредвиденный сбой): -7, HTTP 200."""
    return _reply(_parse_form(body) or {}, operation, E_UPDATE)


def _reply(form: Mapping[str, str], operation: str, error: int, seq: int | None = None) -> OutboundResponse:
    trans = digits(form.get("click_trans_id"), 20)
    body: dict[str, Any] = {
        "click_trans_id": int(trans) if trans is not None else None,
        "merchant_trans_id": form.get("merchant_trans_id"),
        "merchant_confirm_id" if operation == "complete" else "merchant_prepare_id": seq,
        "error": error,
        "error_note": NOTES[error],
    }
    order = digits(form.get("merchant_trans_id"))
    return OutboundResponse(status_code=200, body=body, result_code=str(error), provider_txn_id=trans,
                            order_no=int(order) if order is not None else None)


def _api_error_code(res: HttpResult) -> int | None:
    body = res.body if isinstance(res.body, dict) else {}
    return as_int(body.get("error_code"))


def _api_result_code(res: HttpResult) -> str:
    code = _api_error_code(res)
    return str(code) if code is not None else f"HTTP_{res.status_code}"


def _payment_state(status: int | None, local: str) -> PaymentState:
    """payment_status Click → наше состояние; отменённый у Click проведённый платёж — возврат (`refunded`), чтобы
    сверка ядра не видела расхождения «refunded ≠ cancelled» после нашего же возврата."""
    if status is None:
        return "unknown"
    if status < 0:
        return "refunded" if local in ("performed", "refunded") else "cancelled"
    return PAYMENT_STATUS.get(status, "unknown")


class ClickAdapter:
    """Адаптер Click (`ProviderAdapter`)."""

    code: ProviderCode = PROVIDER

    def __init__(self, settings: Settings, *, transport: httpx.AsyncBaseTransport | None = None,
                 sink: ProviderCallSink | None = None, statement: StatementSource | None = None,
                 clock: Callable[[], datetime] = utcnow) -> None:
        self.settings = settings
        self.clock = clock
        self.statement = statement
        self.http = ProviderHttp(PROVIDER, settings.click_api_url, timeout=settings.provider_timeout_seconds,
                                 transport=transport, sink=sink)

    def enabled(self) -> bool:
        return self.settings.provider_enabled(PROVIDER)

    # ------------------------------------------------------------ колбэки

    def _signature_ok(self, form: Form, operation: str) -> bool:
        secret = self.settings.click_secret_key.get_secret_value()
        if not secret:
            return False
        parts = [form["click_trans_id"], form["service_id"], secret, form["merchant_trans_id"]]
        if operation == "complete":
            parts.append(form["merchant_prepare_id"])
        parts += [form["amount"], form["action"], form["sign_time"]]
        return secret_equals(form["sign_string"].strip().lower(), md5_hex("".join(parts)))

    def _authentic(self, form: Form, operation: str, call: InboundCall) -> bool:
        signature = self._signature_ok(form, operation)
        service = bool(self.settings.click_service_id) and form["service_id"] == self.settings.click_service_id
        return signature and service and ip_allowed(call.client_ip, self.settings.allowed_cidrs(PROVIDER))

    def _sign_time(self, value: str) -> datetime | None:
        try:
            local = datetime.strptime(value, SIGN_TIME_FORMAT)
        except ValueError:
            return None
        return local.replace(tzinfo=ZoneInfo(SIGN_TIME_ZONE)).astimezone(UTC)

    async def handle(self, call: InboundCall, payments: PaymentPort) -> OutboundResponse:
        operation = call.operation
        if operation not in OPERATIONS:
            return _reply({}, "prepare", E_ACTION)
        form = _parse_form(call.body)
        if form is None:
            return _reply({}, operation, E_REQUEST)
        required = PREPARE_FIELDS if operation == "prepare" else COMPLETE_FIELDS
        if any(not form.get(name) for name in required):
            return _reply(form, operation, E_REQUEST)
        if not self._authentic(form, operation, call):
            return _reply(form, operation, E_SIGN)
        try:
            if operation == "prepare":
                return await self._prepare(form, payments)
            return await self._complete(form, payments)
        except Exception as exc:  # сбой БД и прочее — -7, Click повторит
            log.error("click handler failed", extra={"op": operation, "error_type": type(exc).__name__})
            return _reply(form, operation, E_UPDATE)

    async def _prepare(self, form: Form, payments: PaymentPort) -> OutboundResponse:
        op = "prepare"
        if not self.enabled():
            return _reply(form, op, E_CANCELLED)
        if _signed_int(form["action"]) != ACTION_PREPARE:
            return _reply(form, op, E_ACTION)
        trans_id = digits(form["click_trans_id"], 20)
        if trans_id is None:
            return _reply(form, op, E_REQUEST)
        amount = parse_sum_string(form["amount"])
        if amount is None:
            return _reply(form, op, E_AMOUNT)
        meta: dict[str, Any] = {}
        paydoc = digits(form.get("click_paydoc_id"), 20)
        if paydoc is not None:
            meta["click_paydoc_id"] = paydoc
        try:
            txn = await payments.create(PROVIDER, trans_id, form["merchant_trans_id"], amount,
                                        self._sign_time(form["sign_time"]), meta)
        except OrderNotFound:
            return _reply(form, op, E_ORDER_NOT_FOUND)
        except AlreadyPaid:
            return _reply(form, op, E_ALREADY_PAID)
        except AmountMismatch:
            return _reply(form, op, E_AMOUNT)
        except (OrderClosed, PaymentsDisabled, InvalidState, OrderBusy, TxnTimedOut):
            return _reply(form, op, E_CANCELLED)
        if str(txn.order_no) != form["merchant_trans_id"]:  # click_trans_id другого заказа
            return _reply(form, op, E_REQUEST)
        if txn.state == "created":
            return _reply(form, op, E_SUCCESS, txn.seq)
        return _reply(form, op, E_ALREADY_PAID if txn.state == "performed" else E_CANCELLED)

    async def _complete(self, form: Form, payments: PaymentPort) -> OutboundResponse:
        op = "complete"
        if _signed_int(form["action"]) != ACTION_COMPLETE:
            return _reply(form, op, E_ACTION)
        trans_id = digits(form["click_trans_id"], 20)
        click_error = _signed_int(form["error"])
        if trans_id is None or click_error is None:
            return _reply(form, op, E_REQUEST)
        prepare_id = digits(form["merchant_prepare_id"], 20)
        try:
            txn = await payments.get(PROVIDER, trans_id)
        except TxnNotFound:
            return _reply(form, op, E_TXN_NOT_FOUND)
        if prepare_id is None or txn.seq != int(prepare_id) or str(txn.order_no) != form["merchant_trans_id"]:
            return _reply(form, op, E_TXN_NOT_FOUND)
        if click_error < 0:
            # Click не списал деньги: отмена попытки. Проведённую не трогаем (её отмена — только возврат §1.12)
            if txn.state == "performed":
                return _reply(form, op, E_ALREADY_PAID)
            if txn.state == "created":
                await payments.cancel(PROVIDER, trans_id, "provider_error", None)
            return _reply(form, op, E_CANCELLED)
        if txn.state == "performed":
            return _reply(form, op, E_ALREADY_PAID)
        if txn.state in ("cancelled", "refunded"):
            return _reply(form, op, await self._closed_code(form, payments, txn))
        amount = parse_sum_string(form["amount"])
        if amount is None or amount != txn.amount_tiyin:
            return _reply(form, op, E_AMOUNT)
        try:
            txn = await payments.perform(PROVIDER, trans_id)
        except AlreadyPaid:  # заказ оплачен другой попыткой
            return _reply(form, op, E_ALREADY_PAID)
        except TxnNotFound:
            return _reply(form, op, E_TXN_NOT_FOUND)
        except (InvalidState, OrderClosed, TxnTimedOut, PaymentsDisabled):
            txn = await payments.get(PROVIDER, trans_id)
            if txn.state == "performed":
                return _reply(form, op, E_ALREADY_PAID)
            return _reply(form, op, await self._closed_code(form, payments, txn))
        except PaymentError as exc:
            log.error("click: unexpected domain error", extra={"error_type": type(exc).__name__})
            return _reply(form, op, E_UPDATE)
        if txn.state != "performed":
            return _reply(form, op, E_CANCELLED)
        return _reply(form, op, E_SUCCESS, txn.seq)

    async def _closed_code(self, form: Form, payments: PaymentPort, txn: TxnView) -> int:
        """Попытка закрыта: заказ оплачен другой попыткой (ядро закрывает прочие попытки `order_closed`) → -4,
        иначе → -9. Оплачен ли заказ — чтением `check` (AlreadyPaid), без изменений."""
        if txn.state == "cancelled" and txn.cancel_reason == "order_closed":
            try:
                await payments.check(PROVIDER, form["merchant_trans_id"], txn.amount_tiyin or 0)
            except AlreadyPaid:
                return E_ALREADY_PAID
            except PaymentError:
                return E_CANCELLED
        return E_CANCELLED

    # ------------------------------------------------------------ ссылка оплаты

    async def checkout(self, order: OrderView, *, locale: str, return_url: str | None) -> Checkout:
        """Кнопка оплаты: `{CLICK_PAY_URL}?service_id&merchant_id&amount=N.NN&transaction_param=<order_no>&
        return_url` (§14 C3: формат суммы `N.NN` — сверить)."""
        if order.provider != PROVIDER or order.channel != "web" or order.currency != "UZS" \
                or order.amount_tiyin is None:
            raise CheckoutUnavailable("ORDER_NOT_CLICK")
        service, merchant = self.settings.click_service_id.strip(), self.settings.click_merchant_id.strip()
        if not (digits(service) and digits(merchant)):
            raise CheckoutUnavailable("CLICK_NOT_CONFIGURED")
        query = urlencode({
            "service_id": service,
            "merchant_id": merchant,
            "amount": format_sum(order.amount_tiyin),
            "transaction_param": str(order.order_no),
            "return_url": return_url or return_url_for(self.settings, order.order_no),
        }, quote_via=quote)
        return Checkout(kind="redirect", url=f"{self.settings.click_pay_url.rstrip('?')}?{query}")

    # ------------------------------------------------------------ Merchant API

    def _configured(self) -> bool:
        s = self.settings
        return bool(digits(s.click_service_id) and s.click_merchant_user_id.strip()
                    and s.click_secret_key.get_secret_value() and s.click_api_url)

    def _auth_headers(self) -> dict[str, str]:
        timestamp = str(dt_to_ms(self.clock()) // 1000)  # 10 цифр, UNIX-секунды
        digest = sha1_hex(timestamp + self.settings.click_secret_key.get_secret_value())
        return {"Auth": f"{self.settings.click_merchant_user_id.strip()}:{digest}:{timestamp}",
                "Accept": "application/json", "Content-Type": "application/json"}

    def _payment_date(self, txn: TxnView) -> str:
        at = txn.performed_at or txn.provider_time or txn.created_at
        return at.astimezone(ZoneInfo(self.settings.timezone)).date().isoformat()

    async def _status_by_mti(self, order_no: int, payment_date: str,
                             provider_txn_id: str | None = None) -> HttpResult:
        path = API_STATUS_BY_MTI.format(service_id=self.settings.click_service_id.strip(),
                                        merchant_trans_id=order_no, payment_date=payment_date)
        return await self.http.request("GET", path, op="status_by_mti", headers=self._auth_headers(),
                                       order_no=order_no, provider_txn_id=provider_txn_id,
                                       result_code=_api_result_code)

    async def _payment_id(self, txn: TxnView) -> str | None:
        for key in PAYMENT_ID_META_KEYS:
            value = digits(txn.provider_meta.get(key), 20)
            if value is not None:
                return value
        res = await self._status_by_mti(txn.order_no, self._payment_date(txn), txn.provider_txn_id)
        body = res.body if isinstance(res.body, dict) else {}
        if _api_error_code(res) != 0:
            return None
        return digits(body.get("payment_id"), 20)

    async def refund(self, txn: TxnView, *, account_id: UUID | None) -> RefundOutcome:
        """`DELETE reversal` → api_ok | api_failed(код). Окно «текущий месяц» проверяет ядро до вызова. Повтор —
        только если соединение не установлено: повторная отмена после потерянного ответа не отправляется."""
        if txn.provider != PROVIDER or txn.state != "performed":
            return RefundOutcome(kind="api_failed", failure_code="TXN_NOT_PERFORMED")
        if not self._configured():
            return RefundOutcome(kind="api_failed", failure_code="CLICK_NOT_CONFIGURED")
        try:
            payment_id = await self._payment_id(txn)
            if payment_id is None:
                return RefundOutcome(kind="api_failed", failure_code="CLICK_PAYMENT_ID_UNKNOWN")
            path = API_REVERSAL.format(service_id=self.settings.click_service_id.strip(), payment_id=payment_id)
            res = await self.http.request("DELETE", path, op="reversal", headers=self._auth_headers(),
                                          retry="connect", order_no=txn.order_no,
                                          provider_txn_id=txn.provider_txn_id, result_code=_api_result_code)
        except ProviderUnavailable as exc:
            return RefundOutcome(kind="api_failed", failure_code=f"CLICK_UNAVAILABLE_{exc.code}"[:40])
        code = _api_error_code(res)
        if res.status_code == 200 and code == 0:
            return RefundOutcome(kind="api_ok")
        return RefundOutcome(kind="api_failed", failure_code=f"CLICK_{_api_result_code(res)}"[:40])

    def _item(self, item: FiscalItem) -> dict[str, Any]:
        line_total = item.price_tiyin * item.count
        out: dict[str, Any] = {
            "Name": item.title[:63],
            "SPIC": item.ikpu,
            "PackageCode": item.package_code,
            "Price": line_total,
            "Amount": item.count,
            "VAT": vat_inside(line_total, item.vat_percent),
            "VATPercent": item.vat_percent,
            "CommissionInfo": {"PINFL": item.tin} if len(item.tin) == 14 else {"TIN": item.tin},
        }
        if item.units is not None:  # обязателен у Click; без него Click откажет — пункт fiscal_missing
            out["Units"] = item.units
        return out

    async def _receipt_url(self, payment_id: str, order_no: int) -> tuple[bool, str | None]:
        """(есть чек у Click, ссылка https | None)."""
        path = API_OFD_DATA.format(service_id=self.settings.click_service_id.strip(), payment_id=payment_id)
        try:
            res = await self.http.request("GET", path, op="ofd_data", headers=self._auth_headers(),
                                          order_no=order_no, result_code=_api_result_code)
        except ProviderUnavailable:
            return False, None
        body = res.body if isinstance(res.body, dict) else {}
        url = body.get("qrCodeURL")
        if res.status_code == 200 and isinstance(url, str) and url.startswith("https://") and len(url) <= 500:
            return True, url
        return False, None

    async def fiscalize(self, txn: TxnView, order: OrderView) -> FiscalOutcome:
        """`submit_items` после проведения (§1.9). Повторы — tick ядра (`pending`); перед повторной отправкой
        проверяется, нет ли уже чека (`ofd_data`), — второй чек на тот же платёж не отправляется."""
        if txn.state == "refunded" and not FISCALIZE_REFUNDS:
            return FiscalOutcome(kind="no_op")
        if txn.state != "performed":
            return FiscalOutcome(kind="failed", message="TXN_NOT_PERFORMED")
        if not order.fiscal_items:  # dev/test без реквизитов; в stage/prod товар без них не активируется
            return FiscalOutcome(kind="no_op")
        if not self._configured():
            return FiscalOutcome(kind="failed", message="CLICK_NOT_CONFIGURED")
        try:
            payment_id = await self._payment_id(txn)
        except ProviderUnavailable as exc:
            return FiscalOutcome(kind="pending", message=f"CLICK_UNAVAILABLE_{exc.code}")
        if payment_id is None:
            return FiscalOutcome(kind="pending", message="CLICK_PAYMENT_ID_UNKNOWN")
        exists, url = await self._receipt_url(payment_id, txn.order_no)
        if exists:
            return FiscalOutcome(kind="registered", provider_receipt_id=payment_id, qr_code_url=url, status_code=0)
        body = {
            "service_id": int(self.settings.click_service_id.strip()),
            "payment_id": int(payment_id),
            "items": [self._item(item) for item in order.fiscal_items],
            "received_ecash": 0,
            "received_cash": 0,
            "received_card": txn.amount_tiyin or 0,
        }
        try:
            res = await self.http.request("POST", API_SUBMIT_ITEMS, op="submit_items", headers=self._auth_headers(),
                                          json_body=body, retry="connect", order_no=txn.order_no,
                                          provider_txn_id=txn.provider_txn_id, result_code=_api_result_code)
        except ProviderUnavailable as exc:
            return FiscalOutcome(kind="pending", message=f"CLICK_UNAVAILABLE_{exc.code}")
        code = _api_error_code(res)
        if res.status_code != 200 or code != 0:
            note = res.body.get("error_note") if isinstance(res.body, dict) else None
            message = note[:500] if isinstance(note, str) else f"CLICK_{_api_result_code(res)}"
            # код Click не классифицирован (§14 C4): повтор — tick ядра, через 24 ч — failed и fiscal_missing
            return FiscalOutcome(kind="pending", status_code=code, message=message)
        _, url = await self._receipt_url(payment_id, txn.order_no)
        return FiscalOutcome(kind="registered", provider_receipt_id=payment_id, qr_code_url=url, status_code=0)

    async def remote_status(self, since: datetime) -> list[RemoteRecord] | None:
        """`status_by_mti` по нашим транзакциям Click за период (источник — `statement`, обычно
        `PaymentPort.statement("click", …)`); запись — на нашу попытку заказа (`provider_txn_id`); без источника или
        ключей — None; сбой сети — None (ядро не делает выводов по неполной выписке)."""
        if self.statement is None or not self._configured():
            return None
        now = self.clock()
        txns: Sequence[TxnView] = await self.statement(since, now)
        by_order: dict[int, TxnView] = {}
        for txn in txns:  # по заказу — проведённая попытка, иначе последняя
            current = by_order.get(txn.order_no)
            if current is None or txn.state == "performed" or (current.state != "performed"
                                                               and txn.created_at >= current.created_at):
                by_order[txn.order_no] = txn
        records: list[RemoteRecord] = []
        for order_no, txn in list(by_order.items())[:RECONCILE_MAX_ORDERS]:
            try:
                res = await self._status_by_mti(order_no, self._payment_date(txn), txn.provider_txn_id)
            except ProviderUnavailable:
                return None
            body = res.body if isinstance(res.body, dict) else {}
            code = _api_error_code(res)
            status = as_int(body.get("payment_status"))
            # сопоставление ядра — по provider_txn_id: статус платежа заказа относим к нашей попытке (проведённой,
            # иначе последней); «платёж не найден» у Click — unknown (код ответа — в meta; сверить при договоре)
            records.append(RemoteRecord(
                provider=PROVIDER, provider_txn_id=txn.provider_txn_id, order_ref=str(order_no),
                amount_tiyin=txn.amount_tiyin, amount_stars=None,
                state=_payment_state(status, txn.state) if code == 0 else "unknown", at=now,
                meta={"error_code": code, "payment_status": status, "payment_id": digits(body.get("payment_id"), 20)}))
        if len(by_order) > RECONCILE_MAX_ORDERS:
            log.warning("click reconcile truncated", extra={"orders": len(by_order), "limit": RECONCILE_MAX_ORDERS})
        return records


def build_adapter(rt: Runtime) -> ClickAdapter:
    """Фабрика по соглашению ядра (`domain/adapters.py`): настройки, часы и журнал — из Runtime; наши транзакции Click
    для сверки `status_by_mti` — `PaymentService.statement("click", …)` ядра (нет ядра — сверки нет)."""
    settings, sink, clock, port = runtime_parts(rt)
    async def statement(from_: datetime, to: datetime) -> Sequence[TxnView]:
        assert port is not None
        return cast(Sequence[TxnView], await port.statement(PROVIDER, from_, to))

    return ClickAdapter(settings, sink=sink, statement=statement if port is not None else None, clock=clock)
