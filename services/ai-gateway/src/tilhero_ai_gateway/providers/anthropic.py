"""Anthropic Messages API через httpx (SDK провайдера не ставим): POST {base}/v1/messages, заголовки `x-api-key`,
`anthropic-version: 2023-06-01`; токены — из `usage` ответа (input_tokens, output_tokens).

Ключ берётся только из переменной окружения ANTHROPIC_API_KEY (Settings) и живёт лишь в заголовке запроса:
не логируется, не попадает в ответы и тексты ошибок (ProviderError несёт только код вида http_401).
Тесты подменяют транспорт (`httpx.MockTransport`) — сеть к api.anthropic.com со стенда закрыта.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from tilhero_ai_gateway.providers.base import (
    ProviderError,
    ProviderName,
    ProviderRequest,
    ProviderResponse,
    ProviderTimeout,
)

API_VERSION = "2023-06-01"
log = logging.getLogger("tilhero.ai_gateway.anthropic")


class AnthropicProvider:
    name: ProviderName = "anthropic"

    def __init__(self, api_key: str | None, base_url: str, *,
                 transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._key = api_key
        self._base_url = base_url.rstrip("/")
        self._transport = transport
        self._client: httpx.AsyncClient | None = None

    def ready(self) -> bool:
        return bool(self._key)

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(base_url=self._base_url, transport=self._transport,
                                             follow_redirects=False, trust_env=self._transport is None)
        return self._client

    async def complete(self, request: ProviderRequest) -> ProviderResponse:
        if not self._key:
            raise ProviderError("no_key")
        body: dict[str, Any] = {
            "model": request.model_id,
            "system": request.system,
            "messages": [{"role": "user", "content": request.user}],
            "max_tokens": request.max_tokens,
            "temperature": request.temperature,
        }
        headers = {"x-api-key": self._key, "anthropic-version": API_VERSION, "content-type": "application/json"}
        try:
            response = await self._http().post("/v1/messages", json=body, headers=headers,
                                               timeout=httpx.Timeout(request.timeout_s))
        except httpx.TimeoutException:
            raise ProviderTimeout() from None
        except httpx.HTTPError as exc:
            # текст исключения httpx может содержать URL и заголовки — только тип
            log.warning("anthropic request failed", extra={"error_type": type(exc).__name__})
            raise ProviderError("network") from None
        if response.status_code >= 400:
            log.warning("anthropic error status", extra={"status": response.status_code})
            raise ProviderError(f"http_{response.status_code}")
        try:
            data = response.json()
            blocks = data.get("content") or []
            text = "".join(b.get("text", "") for b in blocks if isinstance(b, dict) and b.get("type") == "text")
            usage = data.get("usage") or {}
            input_tokens = int(usage.get("input_tokens") or 0)
            output_tokens = int(usage.get("output_tokens") or 0)
        except (ValueError, TypeError, AttributeError):
            raise ProviderError("bad_response") from None
        if input_tokens < 0 or output_tokens < 0:
            raise ProviderError("bad_response")
        return ProviderResponse(text=text, input_tokens=input_tokens, output_tokens=output_tokens)

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    def __repr__(self) -> str:  # ключ не попадает в repr/логи ни при каких условиях
        return f"AnthropicProvider(base_url={self._base_url!r}, key_configured={bool(self._key)})"
