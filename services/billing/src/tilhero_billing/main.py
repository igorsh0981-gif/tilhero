"""billing (8118, схема `billing`): каталог тарифов и товаров (версии; цены в сумах и в Stars — отдельными полями),
заказы по каналам (miniapp — только Telegram Stars, web — только Payme / Click / Uzum), платёжный контур с адаптерами,
фискальные данные, периоды подписки и подписки Stars, реестр минут с удержаниями, возвраты, корректировки «четыре
глаза», сверка, отчёты и курсы. Контракт — docs/sprint8/INTERNAL_API.md §0–§1; деньги — целые (ADR-0001).

Каркас потока 0: health (`/health/live`, `/health/ready`) и клиенты соседей; маршруты, потребители и tick добавляют
потоки A (ядро), B (`providers/{payme,click,uzum,common}.py`, `api/callbacks.py`) и G (`providers/telegram_stars.py`,
`api/stars.py`). Граница A ↔ B/G — `providers/base.py` (ProviderAdapter) и `domain/ports.py` (PaymentPort).
"""

from __future__ import annotations

import httpx
from fastapi import APIRouter, FastAPI

from tilhero_billing.clients import BOTGW, GAMIFICATION, IDENTITY
from tilhero_billing.settings import Settings, get_settings
from tilhero_common.app import Runtime, create_app


def build_app(settings: Settings | None = None, runtime: Runtime | None = None, *,
              transports: dict[str, httpx.AsyncBaseTransport] | None = None,
              routers: list[APIRouter] | None = None) -> FastAPI:
    """transports — заглушки соседей в тестах (httpx.MockTransport) по имени клиента: identity-consent, gamification,
    telegram-bot-gateway; routers — маршруты потоков (каркас — без маршрутов)."""
    settings = settings or get_settings()
    runtime = runtime or Runtime(settings)
    tr = transports or {}

    def configure(rt: Runtime) -> None:
        rt.register_client(IDENTITY, settings.identity_consent_url, timeout=settings.identity_consent_timeout_seconds,
                           retries=1, transport=tr.get(IDENTITY))
        rt.register_client(GAMIFICATION, settings.gamification_url, timeout=settings.gamification_timeout_seconds,
                           retries=1, transport=tr.get(GAMIFICATION))
        # команды Bot API (счёт, возврат, автопродление) не повторяются без Idempotency-Key — решает адаптер Stars
        rt.register_client(BOTGW, settings.botgw_url, timeout=settings.botgw_timeout_seconds, retries=0,
                           transport=tr.get(BOTGW))

    return create_app(settings, routers=routers or [], runtime=runtime, configure=configure,
                      title="TilHero billing-service")


app = build_app()
