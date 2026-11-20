"""HTTP-клиент для вызовов сервис → сервис.

- внутренний JWT (aud = целевой сервис, sub/actor — по месту вызова);
- проброс trace/correlation id;
- таймауты, retry с экспоненциальной задержкой только для идемпотентных запросов и сетевых сбоев/5xx;
- простой circuit breaker: после N подряд неудач — «открыт» на cooldown секунд;
- ошибки целевого сервиса приходят в едином формате и пробрасываются как UpstreamError.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import httpx

from tilhero_common import context
from tilhero_common.errors import ApiError
from tilhero_common.internal_auth import HEADER, Actor, issue_token, keyring_for
from tilhero_common.settings import ServiceSettings

log = logging.getLogger("tilhero.http")

IDEMPOTENT = {"GET", "HEAD", "OPTIONS"}  # PUT/DELETE повторяем только с явным Idempotency-Key


class UpstreamError(ApiError):
    def __init__(self, status: int, code: str, message: str, details: dict[str, Any] | None = None,
                 service: str = "") -> None:
        super().__init__(status, code, message, details)
        self.service = service


class CircuitOpen(UpstreamError):
    pass


class CircuitBreaker:
    def __init__(self, threshold: int = 5, cooldown: float = 30.0) -> None:
        self.threshold = threshold
        self.cooldown = cooldown
        self.failures = 0
        self.opened_at: float | None = None
        self._probe_at: float | None = None

    def allow(self) -> bool:
        if self.opened_at is None:
            return True
        now = time.monotonic()
        if now - self.opened_at < self.cooldown:
            return False
        # half-open: пропускаем ОДИН пробный запрос; следующий — только после его исхода (или таймаута пробы)
        if self._probe_at is not None and now - self._probe_at < self.cooldown:
            return False
        self._probe_at = now
        return True

    def success(self) -> None:
        self.failures = 0
        self.opened_at = None
        self._probe_at = None

    def failure(self) -> None:
        self.failures += 1
        self._probe_at = None
        if self.failures >= self.threshold:
            self.opened_at = time.monotonic()


class ServiceClient:
    def __init__(
        self,
        settings: ServiceSettings,
        *,
        target: str,
        base_url: str,
        timeout: float = 5.0,
        retries: int = 2,
        breaker: CircuitBreaker | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.settings = settings
        self.target = target
        self.retries = retries
        self.breaker = breaker or CircuitBreaker()
        self._client = httpx.AsyncClient(base_url=base_url.rstrip("/"), timeout=timeout, transport=transport)

    async def aclose(self) -> None:
        await self._client.aclose()

    def _headers(self, subject: str | None, actor: Actor | None, idempotency_key: str | None) -> dict[str, str]:
        headers = context.outgoing_headers()
        headers[HEADER] = issue_token(
            keyring_for(self.settings),
            issuer=self.settings.service_name,
            audience=self.target,
            subject=subject,
            actor=actor,
            ttl_seconds=self.settings.internal_jwt_ttl_seconds,
        )
        if idempotency_key:
            headers["idempotency-key"] = idempotency_key
        return headers

    async def request(
        self,
        method: str,
        path: str,
        *,
        subject: str | None = None,
        actor: Actor | None = None,
        json: Any = None,
        params: dict[str, Any] | None = None,
        idempotency_key: str | None = None,
        headers: dict[str, str] | None = None,
        raw: bool = False,
        content: bytes | None = None,
    ) -> Any:
        """raw=True → вернуть httpx.Response (2xx/3xx) без разбора тела: нужен для ETag/304.
        content — сырое тело (например audio/wav, спринт 5); вместе с json нельзя, Content-Type — в headers."""
        if content is not None and json is not None:
            raise ValueError("content и json взаимоисключающие")
        method = method.upper()
        if not self.breaker.allow():
            raise CircuitOpen(503, "UPSTREAM_UNAVAILABLE", f"{self.target} временно недоступен",
                              {"service": self.target}, service=self.target)
        can_retry = method in IDEMPOTENT or idempotency_key is not None
        attempts = (self.retries + 1) if can_retry else 1
        last_exc: Exception | None = None
        for attempt in range(1, attempts + 1):
            try:
                resp = await self._client.request(
                    method, path, json=json, params=params, content=content,
                    headers={**(headers or {}), **self._headers(subject, actor, idempotency_key)},
                )
            except httpx.TransportError as exc:
                last_exc = exc
                self.breaker.failure()
                if attempt < attempts:
                    await asyncio.sleep(0.2 * 2 ** (attempt - 1))
                    continue
                raise UpstreamError(503, "UPSTREAM_UNAVAILABLE", f"{self.target} недоступен",
                                    {"service": self.target}, service=self.target) from exc
            if resp.status_code >= 500 and attempt < attempts:
                self.breaker.failure()
                await asyncio.sleep(0.2 * 2 ** (attempt - 1))
                continue
            if resp.status_code >= 500:
                self.breaker.failure()
            else:
                self.breaker.success()
            if resp.status_code >= 400:
                raise _to_error(resp, self.target)
            if raw:
                return resp
            if resp.status_code == 204 or not resp.content:
                return None
            return resp.json()
        raise UpstreamError(503, "UPSTREAM_UNAVAILABLE", f"{self.target} недоступен", service=self.target) from last_exc

    async def get(self, path: str, **kw: Any) -> Any:
        return await self.request("GET", path, **kw)

    async def post(self, path: str, **kw: Any) -> Any:
        return await self.request("POST", path, **kw)

    async def put(self, path: str, **kw: Any) -> Any:
        return await self.request("PUT", path, **kw)

    async def patch(self, path: str, **kw: Any) -> Any:
        return await self.request("PATCH", path, **kw)

    async def delete(self, path: str, **kw: Any) -> Any:
        return await self.request("DELETE", path, **kw)


def _to_error(resp: httpx.Response, service: str) -> UpstreamError:
    try:
        body = resp.json()
        return UpstreamError(resp.status_code, body.get("code", "UPSTREAM_ERROR"), body.get("message", ""),
                             body.get("details") or {}, service=service)
    except Exception:
        return UpstreamError(resp.status_code, "UPSTREAM_ERROR", f"{service} ответил {resp.status_code}",
                             service=service)
