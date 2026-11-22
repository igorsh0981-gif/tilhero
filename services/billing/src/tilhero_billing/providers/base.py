"""Протокол адаптера провайдера — граница потоков спринта 8 (INTERNAL_API §1.4).

Адаптеры: `telegram_stars.py` (поток G, канал `miniapp`), `payme.py`, `click.py`, `uzum.py` + `common.py` (поток B,
канал `web`). Ядро (поток A) выбирает адаптер по `ProviderCode` и работает с ним только через этот протокол; адаптер
меняет данные только через `PaymentPort` (domain/ports.py) — сам в БД не ходит.

Правила для всех адаптеров:
- деньги — целые (ADR-0001): `amount_tiyin` (сумы × 100, UZS) у Payme / Click / Uzum, `amount_stars` (XTR) у Stars;
  ровно одно из них не None; float и Decimal не используются; сумма заказа — только из каталога (снимок в заказе);
- секреты (ключ кассы, секрет Click, пароль Uzum, X-Edge-Token) — только из настроек (`SecretStr`), сравнение за
  постоянное время (`hmac.compare_digest`); тела колбэков, подписи и учётные данные не пишутся в лог, БД, события и
  ответы; в `provider_calls` — только метаданные (метод, код результата, время ответа, IP);
- Telegram ID в billing не попадает: bot-gateway передаёт `account_id`;
- коды, поля и URL провайдера — в одной таблице констант адаптера; неподтверждённое документацией (§14) — константа
  или настройка и пометка в отчёте.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING, Any, Literal, Protocol, runtime_checkable
from uuid import UUID

if TYPE_CHECKING:
    from tilhero_billing.domain.ports import PaymentPort

ProviderCode = Literal["telegram_stars", "payme", "click", "uzum"]
FIAT_PROVIDERS: tuple[ProviderCode, ...] = ("payme", "click", "uzum")
PROVIDERS: tuple[ProviderCode, ...] = ("telegram_stars", *FIAT_PROVIDERS)
# канал продаж — claim `chn` внутреннего токена telegram-bff (renewal — продление подписки Stars, создаёт billing)
Channel = Literal["miniapp", "web", "renewal"]
# пара «канал — провайдер» (§0.2): иначе 422 PROVIDER_NOT_ALLOWED
CHANNEL_PROVIDERS: Mapping[str, tuple[ProviderCode, ...]] = {
    "miniapp": ("telegram_stars",),
    "renewal": ("telegram_stars",),
    "web": FIAT_PROVIDERS,
}
Currency = Literal["UZS", "XTR"]
ProductKind = Literal["subscription", "til_pack"]
StarsMode = Literal["one_time", "subscription"]
OrderStatus = Literal["pending", "paid", "fulfilled", "expired", "cancelled", "refunded"]
# машина состояний транзакции (§1.4, триггер txn_guard): [*] → created → performed → refunded; created → cancelled;
# Stars — сразу [*] → performed. Payme: created = 1, performed = 2, cancelled = −1, refunded = −2
TxnState = Literal["created", "performed", "cancelled", "refunded"]
CancelReason = Literal["receivers_not_found", "debit_error", "execution_error", "timeout", "refund", "unknown",
                       "provider_error", "order_closed"]
Locale = Literal["ru", "uz"]
# подписка Stars: обновление `subscription` (BotSubscriptionUpdated)
StarsSubscriptionState = Literal["canceled", "active", "failed"]
# Stars: subscription_period — сейчас единственное допустимое значение Bot API (30 дней), цена подписки ≤ 10 000
STARS_SUBSCRIPTION_PERIOD_SECONDS = 2_592_000
STARS_SUBSCRIPTION_MAX_PRICE = 10_000


@dataclass(frozen=True, slots=True)
class FiscalItem:
    """Позиция фискального чека сайта (§1.9) из снимка товара; у Stars чеков нет (решение 17, О3)."""

    title: str  # receipt_title, 1..63
    price_tiyin: int  # = amount_tiyin заказа
    count: int  # 1
    ikpu: str  # ИКПУ (SPIC), ^[0-9]{1,17}$
    package_code: str  # ^[0-9]{1,20}$
    vat_percent: int  # 0..100
    units: int | None
    tin: str  # merchant.tin (ИНН комитента) — ^[0-9]{9}$ или ПИНФЛ ^[0-9]{14}$


@dataclass(frozen=True, slots=True)
class OrderView:
    """Заказ глазами адаптера: снимок товара и сумма — из каталога на момент заказа. Без плательщика: account_id
    адаптеру не нужен (кроме возврата Stars — передаётся отдельно)."""

    order_id: UUID
    order_no: int  # ≥ 100001: account.order_id (Payme), merchant_trans_id (Click), params.order_id (Uzum)
    channel: Channel
    status: OrderStatus
    product_code: str
    product_kind: ProductKind
    title: Mapping[str, str]  # {"ru", "uz"} — название товара (1..60)
    description: Mapping[str, str] | None  # описание товара (≤ 300) — description счёта Stars
    stars_title: Mapping[str, str] | None  # title счёта Stars (1..32); у товаров сайта — None
    provider: ProviderCode
    currency: Currency
    amount_tiyin: int | None
    amount_stars: int | None
    stars_mode: StarsMode | None
    invoice_link: str | None  # Stars: https://t.me/… (хранится в заказе)
    locale: Locale
    expires_at: datetime
    created_at: datetime
    # позиции чека сайта (Payme detail, Click submit_items); у Stars — пусто
    fiscal_items: tuple[FiscalItem, ...] = ()


@dataclass(frozen=True, slots=True)
class TxnView:
    """Транзакция провайдера (§1.1 provider_transactions). У Stars — подтверждённый платёж."""

    txn_id: UUID
    seq: int  # transaction (Payme, строкой), merchant_prepare_id / merchant_confirm_id (Click)
    provider: ProviderCode
    provider_txn_id: str  # Stars: telegram_payment_charge_id; Payme: id; Click: click_trans_id; Uzum: transId
    order_id: UUID
    order_no: int
    amount_tiyin: int | None
    amount_stars: int | None
    state: TxnState
    cancel_reason: CancelReason | None
    provider_reason: int | None  # Payme reason как пришёл (1, 2, 3, 4, 5, 10)
    provider_time: datetime | None  # Payme params.time, Click sign_time, Uzum timestamp, Stars message.date
    provider_meta: Mapping[str, Any]  # click_paydoc_id, payment_id, paymentSource, is_recurring; без карт и секретов
    created_at: datetime
    performed_at: datetime | None
    cancelled_at: datetime | None


@dataclass(frozen=True, slots=True)
class Checkout:
    """Куда отправить покупателя: Stars — ссылка на счёт (`openInvoice` в Mini App), сайт — страница провайдера
    (`location.assign`). `return_url` сайта — `{WEB_PAY_ORIGIN}/orders/{order_no}`."""

    kind: Literal["invoice_link", "redirect"]
    url: str  # https


@dataclass(frozen=True, slots=True)
class InboundCall:
    """Входящий вызов: колбэк провайдера после payments-edge (X-Edge-Token уже проверен в api/callbacks.py) или
    платёжное обновление Telegram от bot-gateway (api/stars.py; Telegram ID уже заменён на account_id).

    operation: payme — `rpc`; click — `prepare` | `complete`; uzum — `check` | `create` | `confirm` | `reverse` |
    `status`; telegram_stars — `pre_checkout` | `payment` | `refund_received` | `subscription_update`."""

    provider: ProviderCode
    operation: str
    method: str  # HTTP-метод (Payme: не POST → -32300)
    headers: Mapping[str, str]  # имена в нижнем регистре; authorization — только для проверки, в лог не пишется
    body: bytes  # сырое тело: подпись Click считается по полям «как пришли»
    content_type: str
    client_ip: str | None  # из X-Forwarded-For (доверенный payments-edge); проверка CIDR — если список задан
    received_at: datetime


@dataclass(frozen=True, slots=True)
class OutboundResponse:
    """Ответ в формате провайдера. Payme — всегда HTTP 200 (иначе Payme считает -32400); Click — JSON, HTTP 200."""

    status_code: int
    body: Mapping[str, Any]
    result_code: str  # для provider_calls: "0", "-31050", "OK", "FAILED:10007", "ok", "ok:false"
    provider_txn_id: str | None = None
    order_no: int | None = None


@dataclass(frozen=True, slots=True)
class RefundOutcome:
    """api_ok — возврат выполнен сразу (Stars refundStarPayment, Click reversal) → completed; api_failed — провайдер
    отказал (failure_code) → failed; manual — возврат в кабинете провайдера (Payme, Uzum) → awaiting_provider с
    инструкцией {provider, provider_txn_id, amount_tiyin}, завершение — по CancelTransaction state 2 / reverse."""

    kind: Literal["api_ok", "api_failed", "manual"]
    failure_code: str | None = None
    instruction: Mapping[str, Any] | None = None


@dataclass(frozen=True, slots=True)
class FiscalOutcome:
    """Фискализация продажи или возврата (§1.9): Click — submit_items после проведения (повторы — tick); Payme — чек
    приходит в SetFiscalData (no_op здесь); Uzum — до сверки no_op; Stars — no_op (чеков нет)."""

    kind: Literal["registered", "pending", "failed", "no_op"]
    provider_receipt_id: str | None = None
    fiscal_receipt_id: str | None = None
    terminal_id: str | None = None
    fiscal_sign: str | None = None
    qr_code_url: str | None = None  # только https
    status_code: int | None = None
    message: str | None = None  # ≤ 500, без ПДн
    retry_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class RemoteRecord:
    """Запись у провайдера для сверки (§1.14): Click status_by_mti, Payme receipts.get_all, Stars getStarTransactions
    (без данных пользователя). Сопоставление с нашей транзакцией — по provider_txn_id, иначе по order_ref и сумме."""

    provider: ProviderCode
    provider_txn_id: str | None
    order_ref: str | None  # order_no строкой или invoice_payload Stars ("o:<order_id>")
    amount_tiyin: int | None
    amount_stars: int | None
    state: Literal["created", "performed", "cancelled", "refunded", "unknown"]
    at: datetime
    direction: Literal["in", "out"] = "in"  # out — возврат (Stars)
    meta: Mapping[str, Any] = field(default_factory=dict)


@runtime_checkable
class ProviderAdapter(Protocol):
    """Адаптер провайдера (§1.4). Методы не бросают исключений наружу для ожидаемых ошибок провайдера: `handle` всегда
    возвращает ответ в формате провайдера (ошибки домена `PaymentError` переводятся в коды провайдера)."""

    code: ProviderCode

    def enabled(self) -> bool:
        """PAYMENTS_ENABLED и флаг провайдера (STARS_ENABLED / PAYME_ENABLED / CLICK_ENABLED / UZUM_ENABLED)."""
        ...

    async def checkout(self, order: OrderView, *, locale: str, return_url: str | None) -> Checkout:
        """URL страницы провайдера (сайт) или ссылка на счёт Stars (через bot-gateway createInvoiceLink)."""
        ...

    async def handle(self, call: InboundCall, payments: PaymentPort) -> OutboundResponse:
        """Колбэк провайдера / платёжное обновление Telegram → операции PaymentPort → ответ провайдеру."""
        ...

    async def refund(self, txn: TxnView, *, account_id: UUID | None) -> RefundOutcome:
        """Полный возврат проведённой транзакции (§1.12). account_id нужен только Stars (bot-gateway находит
        Telegram-пользователя); None у Stars — 409 STARS_PAYER_UNKNOWN решает ядро до вызова."""
        ...

    async def fiscalize(self, txn: TxnView, order: OrderView) -> FiscalOutcome:
        """Click — submit_items; Payme, Uzum (до сверки), Stars — no_op."""
        ...

    async def remote_status(self, since: datetime) -> list[RemoteRecord] | None:
        """Записи провайдера с `since` для сверки; None — провайдер не умеет (или ключ не задан)."""
        ...
