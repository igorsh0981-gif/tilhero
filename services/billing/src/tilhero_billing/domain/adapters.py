"""Реестр адаптеров провайдеров (граница потоков A ↔ B/G, INTERNAL_API §1.4).

Соглашение для потоков B и G: модуль `tilhero_billing.providers.<code>` (telegram_stars, payme, click, uzum)
экспортирует фабрику `build_adapter(rt: Runtime) -> ProviderAdapter` — настройки (`rt.settings`) и клиенты
(`rt.client("telegram-bot-gateway")`) адаптер берёт из Runtime. Ядро вызывает фабрику один раз при сборке
приложения; модуля ещё нет (поток не сдан) — подставляется `UnavailableAdapter`: провайдер выключен, ссылки оплаты нет,
возврат через API невозможен (api_failed ADAPTER_MISSING), сверки нет. Тесты подменяют адаптеры аргументом
`build_app(adapters=...)`.
"""

from __future__ import annotations

import importlib
import logging
from collections.abc import Mapping
from datetime import datetime
from typing import TYPE_CHECKING, cast
from uuid import UUID

from tilhero_billing.providers.base import (
    PROVIDERS,
    Checkout,
    FiscalOutcome,
    InboundCall,
    OrderView,
    OutboundResponse,
    ProviderAdapter,
    ProviderCode,
    RefundOutcome,
    RemoteRecord,
    TxnView,
)
from tilhero_common.app import Runtime

if TYPE_CHECKING:
    from tilhero_billing.domain.ports import PaymentPort

log = logging.getLogger("tilhero.billing.adapters")

MODULES: Mapping[str, str] = {code: f"tilhero_billing.providers.{code}" for code in PROVIDERS}


class AdapterUnavailable(Exception):
    """Адаптер не может выполнить операцию (нет модуля, сбой сети соседа): ядро отвечает понятной ошибкой."""


class UnavailableAdapter:
    """Заглушка для провайдера без реализации: выключен; колбэк — HTTP 503 без тела провайдера."""

    def __init__(self, code: ProviderCode) -> None:
        self.code: ProviderCode = code

    def enabled(self) -> bool:
        return False

    async def checkout(self, order: OrderView, *, locale: str, return_url: str | None) -> Checkout:
        raise AdapterUnavailable(self.code)

    async def handle(self, call: InboundCall, payments: PaymentPort) -> OutboundResponse:
        return OutboundResponse(status_code=503, body={}, result_code="ADAPTER_MISSING")

    async def refund(self, txn: TxnView, *, account_id: UUID | None) -> RefundOutcome:
        return RefundOutcome(kind="api_failed", failure_code="ADAPTER_MISSING")

    async def fiscalize(self, txn: TxnView, order: OrderView) -> FiscalOutcome:
        return FiscalOutcome(kind="no_op")

    async def remote_status(self, since: datetime) -> list[RemoteRecord] | None:
        return None


class Adapters:
    def __init__(self, items: Mapping[str, ProviderAdapter]) -> None:
        self._items = dict(items)

    def get(self, code: str) -> ProviderAdapter:
        adapter = self._items.get(code)
        if adapter is None:
            return cast(ProviderAdapter, UnavailableAdapter(cast(ProviderCode, code)))
        return adapter

    def missing(self) -> list[str]:
        return [c for c, a in self._items.items() if isinstance(a, UnavailableAdapter)]

    def available(self) -> dict[str, ProviderAdapter]:
        """Реализованные адаптеры — для `app.state.provider_adapters` (api/callbacks.py, api/stars.py)."""
        return {c: a for c, a in self._items.items() if not isinstance(a, UnavailableAdapter)}


def _fiat_bundle(rt: Runtime) -> Mapping[str, ProviderAdapter]:
    """Поток B собирает фиатные адаптеры одной фабрикой `providers/common.build_fiat_adapters` (журнал исходящих —
    provider_calls, сверка Click — наши транзакции через PaymentService.statement)."""
    try:
        common = importlib.import_module("tilhero_billing.providers.common")
    except ModuleNotFoundError as exc:
        if exc.name != "tilhero_billing.providers.common":
            raise
        return {}
    factory = getattr(common, "build_fiat_adapters", None)
    if not callable(factory):
        return {}
    from tilhero_billing.domain.common import now_of
    from tilhero_billing.domain.payments import PaymentService

    async def click_statement(from_: datetime, to: datetime) -> list[TxnView]:
        return await PaymentService(rt).statement("click", from_, to)

    sink_cls = getattr(common, "DbProviderCallSink", None)
    return dict(factory(rt.settings, sink=sink_cls(rt) if sink_cls else None, click_statement=click_statement,
                        clock=lambda: now_of(rt)))


def load(rt: Runtime, overrides: Mapping[str, ProviderAdapter] | None = None) -> Adapters:
    """Адаптеры: overrides (тесты) → `providers/<code>.py: build_adapter(rt)` → для Payme / Click / Uzum —
    `providers/common.build_fiat_adapters` → иначе UnavailableAdapter."""
    items: dict[str, ProviderAdapter] = {}
    fiat: Mapping[str, ProviderAdapter] | None = None
    for code in PROVIDERS:
        if overrides is not None and code in overrides:
            items[code] = overrides[code]
            continue
        module_name = MODULES[code]
        try:
            module = importlib.import_module(module_name)
        except ModuleNotFoundError as exc:
            if exc.name != module_name:
                raise
            items[code] = cast(ProviderAdapter, UnavailableAdapter(code))
            continue
        factory = getattr(module, "build_adapter", None)
        if callable(factory):
            items[code] = factory(rt)
            continue
        if code != "telegram_stars":
            if fiat is None:
                fiat = _fiat_bundle(rt)
            if code in fiat:
                items[code] = fiat[code]
                continue
        log.warning("provider adapter factory not found", extra={"provider": code})
        items[code] = cast(ProviderAdapter, UnavailableAdapter(code))
    return Adapters(items)


def of(rt: Runtime) -> Adapters:
    registry = getattr(rt, "billing_adapters", None)
    if registry is None:
        registry = load(rt)
        rt.billing_adapters = registry  # type: ignore[attr-defined]
    return cast(Adapters, registry)


async def edit_star_subscription(rt: Runtime, account_id: UUID, first_charge_id: str, *, is_canceled: bool) -> None:
    """Автопродление подписки Stars (Mini App, возврат, сага) — через адаптер Stars (`edit_subscription`, поток G);
    адаптера без метода — прямой вызов bot-gateway (clients). Ошибки → `clients.StarsGatewayError`:
    `STARS_PAYER_UNKNOWN` (409 — Telegram ID аккаунта неизвестен) или `STARS_UNAVAILABLE` (503)."""
    from tilhero_billing import clients
    from tilhero_common.errors import ApiError

    edit = getattr(of(rt).get("telegram_stars"), "edit_subscription", None)
    if not callable(edit):
        await clients.edit_star_subscription(rt, account_id, first_charge_id, is_canceled=is_canceled)
        return
    try:
        await edit(account_id=account_id, first_charge_id=first_charge_id, is_canceled=is_canceled)
    except ApiError as exc:
        code = "STARS_PAYER_UNKNOWN" if exc.code == "STARS_PAYER_UNKNOWN" else "STARS_UNAVAILABLE"
        raise clients.StarsGatewayError(code, exc.status) from None
    except Exception as exc:
        log.warning("stars edit_subscription failed", extra={"error_type": type(exc).__name__})
        raise clients.StarsGatewayError("STARS_UNAVAILABLE") from None
