"""Клиент Telegram Bot API.

Токен бота живёт только в base_url httpx-клиента: логгеры httpx/httpcore отключены (они пишут URL запроса),
тексты ошибок проходят scrub(), исключения httpx наружу не пробрасываются и в логи не попадают.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

log = logging.getLogger("tilhero.botgw.telegram")


def silence_http_logging() -> None:
    for name in ("httpx", "httpcore"):
        lg = logging.getLogger(name)
        lg.setLevel(logging.CRITICAL)
        lg.disabled = True
        lg.propagate = False


class TelegramError(Exception):
    def __init__(self, status: int, description: str = "") -> None:
        super().__init__(f"telegram error {status}")
        self.status = status
        self.description = description


class TelegramRateLimited(TelegramError):
    def __init__(self, retry_after: int, description: str = "") -> None:
        super().__init__(429, description)
        self.retry_after = retry_after


class TelegramBlocked(TelegramError):
    """403: пользователь заблокировал бота или удалил аккаунт."""


class TelegramBadRequest(TelegramError):
    """400: постоянная ошибка (chat not found, неверная разметка) — повтор не поможет."""

    def __init__(self, reason: str, description: str = "") -> None:
        super().__init__(400, description)
        self.reason = reason


class TelegramUnavailable(TelegramError):
    """Сеть, таймаут или 5xx — можно повторить позже."""


class TelegramClient:
    def __init__(
        self,
        token: str,
        *,
        api_base: str,
        timeout: float = 5.0,
        transport: httpx.AsyncBaseTransport | None = None,
        test_env: bool = False,
    ) -> None:
        self._token = token
        # тестовая среда Telegram (TELEGRAM_TEST_ENV): https://api.telegram.org/bot<token>/test/<METHOD>
        suffix = "test/" if test_env else ""
        self._client = httpx.AsyncClient(
            base_url=f"{api_base.rstrip('/')}/bot{token}/{suffix}",
            timeout=timeout,
            transport=transport,
            follow_redirects=False,
        )

    def scrub(self, text: str) -> str:
        return text.replace(self._token, "[redacted]") if self._token else text

    async def aclose(self) -> None:
        await self._client.aclose()

    async def call(self, method: str, payload: dict[str, Any] | None = None) -> Any:
        if not self._token:
            raise TelegramError(401, "bot token is not configured")
        try:
            resp = await self._client.post(method, json=payload or {})
        except httpx.TimeoutException:
            # from None: контекст исключения httpx (с объектом запроса и URL) не попадает в трассировки
            raise TelegramUnavailable(504, "timeout") from None
        except httpx.HTTPError:
            raise TelegramUnavailable(503, "network error") from None
        try:
            data = resp.json()
        except ValueError:
            data = {}
        if not isinstance(data, dict):
            data = {}
        if resp.status_code == 200 and data.get("ok") is True:
            return data.get("result")
        code = int(data.get("error_code") or resp.status_code)
        description = self.scrub(str(data.get("description") or ""))[:200]
        if code == 429:
            params = _dict(data.get("parameters"))
            retry_after = int(params.get("retry_after") or resp.headers.get("retry-after") or 1)
            raise TelegramRateLimited(max(1, min(retry_after, 3600)), description)
        if code == 403:
            raise TelegramBlocked(403, description)
        if code == 400:
            reason = "chat_not_found" if "chat not found" in description.lower() else "bad_request"
            raise TelegramBadRequest(reason, description)
        if code >= 500:
            raise TelegramUnavailable(code, description)
        raise TelegramError(code, description)


def _dict(value: Any) -> dict[str, Any]:
    """JSON-объект Telegram или пустой словарь (сужение типа для проверки mypy; поведение прежнее)."""
    return value if isinstance(value, dict) else {}


def _str(value: Any) -> str:
    return value if isinstance(value, str) else ""
