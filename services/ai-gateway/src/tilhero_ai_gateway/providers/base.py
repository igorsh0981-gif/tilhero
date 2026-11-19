"""Провайдер ИИ: один запрос к модели → текст ответа и токены (usage). Ошибки — типизированные, без деталей."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol

ProviderName = Literal["anthropic", "fake"]


@dataclass(frozen=True)
class ProviderRequest:
    agent_id: str
    model_id: str
    system: str
    user: str
    max_tokens: int
    temperature: float
    timeout_s: float


@dataclass(frozen=True)
class ProviderResponse:
    text: str
    input_tokens: int
    output_tokens: int


class ProviderError(Exception):
    """Ошибка провайдера. code — короткий код без деталей ответа (http_401, http_529, network, bad_response):
    тело ответа и заголовки не сохраняются — в них может оказаться эхо ключа или данных."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class ProviderTimeout(ProviderError):
    def __init__(self) -> None:
        super().__init__("timeout")


class Provider(Protocol):
    name: ProviderName

    def ready(self) -> bool:
        """Можно ли вызывать (у anthropic — задан ключ). False → unavailable: ai_disabled."""
        ...

    async def complete(self, request: ProviderRequest) -> ProviderResponse: ...

    async def aclose(self) -> None: ...
