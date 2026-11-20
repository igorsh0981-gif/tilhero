"""Сырое тело WAV для `POST /internal/v1/pronunciation` (до 600 000 байт).

Общий RequestContextMiddleware ограничивает тело 256 КиБ (tilhero_common.app.MAX_BODY_BYTES), а запись 15 с —
~480 КиБ. Обход (запрос к общему коду: лимит тела по маршруту — README): этот внешний ASGI-слой только для этого
маршрута читает тело целиком в память процесса (не больше AUDIO_LIMIT + 1 байт), кладёт его в scope запроса и
передаёт внутрь пустое тело с `content-length: 0`. Больше лимита — флаг too_large (обработчик ответит 422
AUDIO_INVALID {reason: too_large}). Аудио не пишется на диск, в логи и метрики; scope живёт только до конца запроса.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, MutableMapping
from typing import Any, Final

AUDIO_PATH: Final = "/internal/v1/pronunciation"
AUDIO_LIMIT: Final = 600_000
SCOPE_KEY: Final = "tilhero.memory.audio"

Scope = MutableMapping[str, Any]
Message = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]


class AudioBodyMiddleware:
    def __init__(self, app: Callable[[Scope, Receive, Send], Awaitable[None]], limit: int = AUDIO_LIMIT) -> None:
        self.app = app
        self.limit = limit

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope.get("type") != "http" or scope.get("method") != "POST" or scope.get("path") != AUDIO_PATH:
            await self.app(scope, receive, send)
            return
        chunks: list[bytes] = []
        size = 0
        too_large = False
        while True:
            message = await receive()
            if message.get("type") == "http.disconnect":
                return
            body = message.get("body", b"") or b""
            size += len(body)
            if size > self.limit:
                too_large = True
                chunks.clear()
                break
            chunks.append(body)
            if not message.get("more_body"):
                break
        inner = dict(scope)
        inner["headers"] = [(k, v) for k, v in scope.get("headers", []) if k.lower() != b"content-length"] + [
            (b"content-length", b"0")]
        inner[SCOPE_KEY] = {"audio": b"".join(chunks), "too_large": too_large}
        chunks.clear()
        sent = False

        async def empty_receive() -> Message:
            nonlocal sent
            if not sent:
                sent = True
                return {"type": "http.request", "body": b"", "more_body": False}
            return await receive()

        try:
            await self.app(inner, empty_receive, send)
        finally:
            inner.pop(SCOPE_KEY, None)


def audio_of(scope: MutableMapping[str, Any]) -> tuple[bytes, bool]:
    state = scope.get(SCOPE_KEY)
    if not isinstance(state, dict):
        return b"", False
    return state.get("audio") or b"", bool(state.get("too_large"))
