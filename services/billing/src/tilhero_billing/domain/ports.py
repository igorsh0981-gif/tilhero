"""Порт платежей — единственный путь адаптера к данным billing (INTERNAL_API §1.4). Реализация — поток A (день 1).

Каждая операция — одна транзакция БД под advisory-блокировками **аккаунта, затем заказа** (всегда в этом порядке;
проверка «аккаунт удалён?» — после захвата блокировки), идемпотентна по `(provider, provider_txn_id)`: повтор с тем же
id возвращает тот же `TxnView`. Проведение подписки и выдача периода с минутами — в той же транзакции; пакет тилов —
заказ `paid` и событие `billing.order.paid.v1` (gamification подтверждает `game.til_pack.credited.v1`).

`order_ref` — ссылка на заказ из колбэка как пришла: Payme `account.order_id`, Click `merchant_trans_id`, Uzum
`params.<UZUM_ACCOUNT_FIELD>` — номер заказа (`order_no`) строкой; Stars — `invoice_payload` (`o:<order_id>`).
Нечисловой номер, чужой канал (заказ не `web` у фиатного провайдера, не `miniapp`/`renewal` у Stars) —
`OrderNotFound`.
`amount` — целое: тийины у Payme / Click / Uzum, звёзды у telegram_stars (ADR-0001).

Ошибки — подклассы `PaymentError`; адаптер переводит их в коды провайдера (таблицы §1.5–1.8).
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal, Protocol, runtime_checkable
from uuid import UUID

from tilhero_billing.providers.base import (
    CancelReason,
    FiscalItem,
    OrderView,
    ProviderCode,
    StarsSubscriptionState,
    TxnView,
)

# ---------------------------------------------------------------- ошибки домена (§1.4)

class PaymentError(Exception):
    """Ошибка платёжного контура; `code` — устойчивое имя для логов и ответов адаптера (без сумм и ПДн)."""

    code = "PAYMENT_ERROR"

    def __init__(self, detail: str = "") -> None:
        super().__init__(detail or self.code)
        self.detail = detail


class OrderNotFound(PaymentError):
    code = "ORDER_NOT_FOUND"


class OrderClosed(PaymentError):
    """Заказ cancelled / expired (без живой транзакции) / refunded: новых транзакций нет."""

    code = "ORDER_CLOSED"


class AlreadyPaid(PaymentError):
    code = "ALREADY_PAID"


class AmountMismatch(PaymentError):
    code = "AMOUNT_MISMATCH"


class OrderBusy(PaymentError):
    """Только Payme: у заказа уже есть транзакция в ожидании (код — §14 P2)."""

    code = "ORDER_BUSY"


class PayerMismatch(PaymentError):
    """Только Stars: account_id плательщика ≠ плательщику заказа или право платить больше не действует."""

    code = "PAYER_MISMATCH"


class PaymentsDisabled(PaymentError):
    """PAYMENTS_ENABLED=false или флаг провайдера выключен."""

    code = "PAYMENTS_DISABLED"


class SubscriptionExists(PaymentError):
    """Stars: у аккаунта уже есть живая подписка Stars (pre-checkout `subscription_exists`)."""

    code = "SUBSCRIPTION_EXISTS"


class TxnNotFound(PaymentError):
    code = "TXN_NOT_FOUND"


class TxnTimedOut(PaymentError):
    """Payme: транзакция `created` старше 43 200 000 мс — отменена (reason 4), провести нельзя."""

    code = "TXN_TIMED_OUT"


class InvalidState(PaymentError):
    """Переход вне машины состояний §1.4 (провести отменённую, отменить возвращённую и т. п.)."""

    code = "INVALID_STATE"


class SubscriptionNotFound(PaymentError):
    code = "SUBSCRIPTION_NOT_FOUND"


class ReceiptTxnNotFound(PaymentError):
    code = "RECEIPT_TXN_NOT_FOUND"


# ---------------------------------------------------------------- значения

@dataclass(frozen=True, slots=True)
class CheckOk:
    """Заказ можно оплатить: снимок заказа и позиции чека (Payme `detail` в CheckPerformTransaction)."""

    order: OrderView
    fiscal_items: tuple[FiscalItem, ...]


@dataclass(frozen=True, slots=True)
class StarsRecurrence:
    """Признаки платежа Stars (SuccessfulPayment): первый платёж — не recurring или is_first_recurring; продление —
    is_recurring и не is_first_recurring (новый заказ channel renewal). expiration — subscription_expiration_date."""

    is_recurring: bool
    is_first_recurring: bool
    subscription_expiration_date: datetime | None


FiscalKind = Literal["sale", "refund"]


@runtime_checkable
class PaymentPort(Protocol):
    async def check(self, provider: ProviderCode, order_ref: str, amount: int | None, *,
                    payer_account_id: UUID | None = None) -> CheckOk:
        """Можно ли оплатить: заказ найден (канал провайдера), pending и не истёк, сумма совпадает, флаги включены;
        Payme — нет транзакции в ожидании (OrderBusy); Stars — плательщик (PayerMismatch), нет живой подписки.
        amount None — сумма не пришла (Uzum check): проверяется заказ без суммы. Stars: payload первого заказа живой
        подписки того же плательщика — возможный pre-checkout продления (§14 S2) — CheckOk и при STARS_ENABLED=false.
        Ошибки: OrderNotFound, OrderClosed, AlreadyPaid, AmountMismatch, OrderBusy, PayerMismatch,
        SubscriptionExists, PaymentsDisabled."""
        ...

    async def create(self, provider: ProviderCode, provider_txn_id: str, order_ref: str, amount: int,
                     provider_time: datetime | None, meta: Mapping[str, Any]) -> TxnView:
        """Транзакция `created` (Payme CreateTransaction, Click Prepare, Uzum create). Повтор id → тот же TxnView.
        Ошибки — как check."""
        ...

    async def perform(self, provider: ProviderCode, provider_txn_id: str,
                      meta: Mapping[str, Any] | None = None) -> TxnView:
        """created → performed + выдача (подписка — период и минуты; тилы — заказ paid и событие). Повтор
        `performed` → тот же TxnView. meta — дополнение provider_meta (Uzum paymentSource; без карт и секретов).
        Ошибки: TxnNotFound, TxnTimedOut, InvalidState, AlreadyPaid (заказ оплачен другой попыткой — Click)."""
        ...

    async def paid(self, provider: ProviderCode, provider_txn_id: str, order_ref: str, amount: int, *,
                   payer_account_id: UUID | None, recurring: StarsRecurrence | None,
                   provider_time: datetime | None, meta: Mapping[str, Any]) -> TxnView:
        """Stars: платёж уже получен — транзакция сразу `performed` (первый платёж) или новый заказ renewal
        (продление). Несоответствия не отвергаются: заказ не найден, сумма, плательщик, аккаунт удалён → транзакция
        записывается, выдачи нет, пункт сверки (payer_mismatch, paid_after_deletion, unmatched_settlement). Повтор
        charge id → тот же TxnView."""
        ...

    async def cancel(self, provider: ProviderCode, provider_txn_id: str, reason: CancelReason,
                     provider_reason: int | None) -> TxnView:
        """created → cancelled; уже отменена → тот же TxnView. Для `performed` — возврат по инициативе провайдера
        (§1.12: refunded + пункт refund_without_request, если заявки не было). Ошибка: TxnNotFound."""
        ...

    async def refunded(self, provider: ProviderCode, provider_txn_id: str) -> TxnView:
        """Возврат подтверждён провайдером (наш — completed) или пришёл по его инициативе (refunded_payment Stars,
        reverse Uzum после confirm). Повтор — без изменений. Ошибка: TxnNotFound."""
        ...

    async def stars_subscription_state(self, order_ref: str, payer_account_id: UUID | None,
                                       state: StarsSubscriptionState) -> None:
        """Обновление `subscription` Telegram: canceled / active / failed автопродления. Подписка не найдена —
        SubscriptionNotFound (ядро заводит пункт сверки stars_subscription_desync)."""
        ...

    async def get(self, provider: ProviderCode, provider_txn_id: str) -> TxnView:
        """Ошибка: TxnNotFound."""
        ...

    async def statement(self, provider: ProviderCode, from_: datetime, to: datetime) -> list[TxnView]:
        """Транзакции провайдера с provider_time в [from_, to] по возрастанию (Payme GetStatement)."""
        ...

    async def store_fiscal(self, provider: ProviderCode, provider_receipt_ref: str, kind: FiscalKind,
                           data: Mapping[str, Any]) -> None:
        """Фискальные данные чека (Payme SetFiscalData: PERFORM → sale, CANCEL → refund — отдельные записи).
        Ошибка: ReceiptTxnNotFound."""
        ...


# ---------------------------------------------------------------- сверх PaymentPort (реализует PaymentService ядра)

@runtime_checkable
class PreCheckoutJournal(Protocol):
    """Журнал ответов на `pre_checkout_query` (таблица `stars_pre_checkouts`, 30 дней): повтор `query_id` — тот же
    ответ (§1.5). Реализация — `domain/payments.PaymentService`."""

    async def recall_pre_checkout(self, query_id: str) -> tuple[bool, str | None] | None:
        """Сохранённый ответ `(ok, error_code)` или None."""
        ...

    async def remember_pre_checkout(self, query_id: str, order_ref: str | None, ok: bool,
                                    error_code: str | None) -> tuple[bool, str | None]:
        """Записать ответ (первый выигрывает) → сохранённый `(ok, error_code)`."""
        ...


@runtime_checkable
class ProviderCallJournal(Protocol):
    """Журнал `provider_calls` (только метаданные, 90 дней): входящие колбэки и обновления, исходящие вызовы.
    Реализация — `PaymentService.record_call` (ошибки журнала поглощает сама и на ответ не влияют); то же
    именованными аргументами — `record_provider_call`."""

    async def record_call(self, provider: str, direction: str, method: str, result_code: str, latency_ms: int, *,
                          provider_txn_id: str | None = None, order_no: int | None = None,
                          client_ip: str | None = None) -> None:
        ...
