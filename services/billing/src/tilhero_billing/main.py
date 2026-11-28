"""billing (8118, схема `billing`): каталог тарифов и товаров (версии; цены в сумах и в Stars — отдельными полями),
заказы по каналам (miniapp — только Telegram Stars, web — только Payme / Click / Uzum), платёжный контур с адаптерами,
фискальные данные, периоды подписки и подписки Stars, реестр минут с удержаниями, возвраты, корректировки «четыре
глаза», сверка, отчёты и курсы. Контракт — docs/sprint8/INTERNAL_API.md §0–§1; деньги — целые (ADR-0001).

Маршруты ядра (поток A): ученик `/internal/v1/me/billing/*`, lessons `/internal/v1/holds|access`, админка
`/internal/v1/admin/billing/*`, планировщик. Маршруты потоков B (`api/callbacks.py`) и G (`api/stars.py`) подключаются
автоматически, если модуль есть (экспортирует `router`), или передаются в `build_app(routers=...)`. Адаптеры —
`providers/<code>.py: build_adapter(rt)` (domain/adapters.py) или `build_app(adapters=...)` в тестах.
"""

from __future__ import annotations

import importlib
from collections.abc import Mapping

import httpx
from fastapi import APIRouter, FastAPI

from tilhero_billing import consumers
from tilhero_billing.api.admin import router as admin_router
from tilhero_billing.api.internal import router as internal_router
from tilhero_billing.api.learner import router as learner_router
from tilhero_billing.api.scheduler import router as scheduler_router
from tilhero_billing.clients import BOTGW, GAMIFICATION, IDENTITY
from tilhero_billing.domain import adapters as adapter_registry
from tilhero_billing.domain import bootstrap, stand
from tilhero_billing.domain.payments import PaymentService
from tilhero_billing.providers.base import ProviderAdapter
from tilhero_billing.settings import Settings, get_settings
from tilhero_common.app import Runtime, create_app

OPTIONAL_ROUTERS = ("tilhero_billing.api.callbacks", "tilhero_billing.api.stars")


def optional_routers() -> list[APIRouter]:
    """Маршруты потоков B и G, если модули уже есть (каждый экспортирует `router`)."""
    out: list[APIRouter] = []
    for name in OPTIONAL_ROUTERS:
        try:
            module = importlib.import_module(name)
        except ModuleNotFoundError as exc:
            if exc.name != name:
                raise
            continue
        router = getattr(module, "router", None)
        if isinstance(router, APIRouter):
            out.append(router)
    return out


def build_app(settings: Settings | None = None, runtime: Runtime | None = None, *,
              transports: dict[str, httpx.AsyncBaseTransport] | None = None,
              routers: list[APIRouter] | None = None,
              adapters: Mapping[str, ProviderAdapter] | None = None) -> FastAPI:
    """transports — заглушки соседей в тестах (httpx.MockTransport) по имени клиента: identity-consent, gamification,
    telegram-bot-gateway; routers — дополнительные маршруты (к ядру и найденным B/G); adapters — подмена адаптеров."""
    settings = settings or get_settings()
    runtime = runtime or Runtime(settings)
    tr = transports or {}

    def configure(rt: Runtime) -> None:
        rt.register_client(IDENTITY, settings.identity_consent_url, timeout=settings.identity_consent_timeout_seconds,
                           retries=1, transport=tr.get(IDENTITY))
        rt.register_client(GAMIFICATION, settings.gamification_url, timeout=settings.gamification_timeout_seconds,
                           retries=1, transport=tr.get(GAMIFICATION))
        # команды Bot API (счёт, возврат, автопродление) не повторяются без Idempotency-Key — решает вызывающий
        rt.register_client(BOTGW, settings.botgw_url, timeout=settings.botgw_timeout_seconds, retries=0,
                           transport=tr.get(BOTGW))
        rt.billing_adapters = adapter_registry.load(rt, adapters)  # type: ignore[attr-defined]
        consumers.register(rt)
        if settings.database_url:
            rt.on_startup(stand.on_start)
            if settings.projection_bootstrap_on_start:
                rt.on_startup(bootstrap.on_start)

    core = [learner_router, internal_router, admin_router, scheduler_router]
    extra: list[APIRouter] = []
    for r in [*optional_routers(), *(routers or [])]:
        if all(r is not x for x in extra):
            extra.append(r)
    app = create_app(settings, routers=[*core, *extra], runtime=runtime, configure=configure,
                     title="TilHero billing-service")
    # порт и адаптеры ядра — для api/callbacks.py (поток B) и api/stars.py (поток G): те же экземпляры, что у ядра
    app.state.payment_port = PaymentService(runtime)
    app.state.provider_adapters = adapter_registry.of(runtime).available()
    return app


app = build_app()
