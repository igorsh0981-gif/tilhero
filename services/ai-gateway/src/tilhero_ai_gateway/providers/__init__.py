"""Провайдеры ИИ: anthropic (prod) и fake (тесты, стенд). Выбор — AI_PROVIDER."""

from __future__ import annotations

import httpx

from tilhero_ai_gateway.providers.anthropic import AnthropicProvider
from tilhero_ai_gateway.providers.base import (
    Provider,
    ProviderError,
    ProviderName,
    ProviderRequest,
    ProviderResponse,
    ProviderTimeout,
)
from tilhero_ai_gateway.providers.fake import FakeProvider
from tilhero_ai_gateway.settings import Settings


def make_provider(settings: Settings, transport: httpx.AsyncBaseTransport | None = None) -> Provider:
    if settings.ai_provider == "fake":
        return FakeProvider()
    return AnthropicProvider(settings.api_key, settings.anthropic_base_url, transport=transport)


__all__ = [
    "AnthropicProvider",
    "FakeProvider",
    "Provider",
    "ProviderError",
    "ProviderName",
    "ProviderRequest",
    "ProviderResponse",
    "ProviderTimeout",
    "make_provider",
]
