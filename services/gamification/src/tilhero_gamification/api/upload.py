"""Сырое тело картинки для `POST /internal/v1/admin/game/assets` (до ASSET_MAX_BYTES = 300 КБ).

Общий RequestContextMiddleware ограничивает тело 256 КиБ (tilhero_common.app.MAX_BODY_BYTES) — меньше 300 КБ.
Обход (запрос к общему коду: лимит тела по маршруту), как у catalog и memory: этот внешний ASGI-слой только для
этого маршрута читает тело (не больше лимита + 1 байт), кладёт его в scope и передаёт внутрь пустое тело с
`content-length: 0`. Больше лимита — флаг too_large: обработчик ответит 413 ASSET_TOO_LARGE.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, MutableMapping
from typing import Any, Final

UPLOAD_PATH: Final = "/internal/v1/admin/game/assets"
SCOPE_KEY: Final = "tilhero.gamification.upload"

Scope = MutableMapping[str, Any]
Message = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]


class AssetBodyMiddleware:
    def __init__(self, app: Callable[[Scope, Receive, Send], Awaitable[None]], limit: int) -> None:
        self.app = app
        self.limit = limit

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope.get("type") != "http" or scope.get("method") != "POST" or scope.get("path") != UPLOAD_PATH:
            await self.app(scope, receive, send)
            return
        chunks: list[bytes] = []
        size = 0
        too_large = False
        declared = next((v for k, v in scope.get("headers", []) if k.lower() == b"content-length"), b"")
        if declared.isdigit() and int(declared) > self.limit:
            too_large = True
        while not too_large:
            message = await receive()
            if message.get("type") == "http.disconnect":
                return
            body = message.get("body", b"") or b""
            size += len(body)
            if size > self.limit:
                too_large = True
                break
            chunks.append(body)
            if not message.get("more_body"):
                break
        inner = dict(scope)
        inner["headers"] = [(k, v) for k, v in scope.get("headers", []) if k.lower() != b"content-length"] + [
            (b"content-length", b"0")]
        inner[SCOPE_KEY] = {"data": b"" if too_large else b"".join(chunks), "too_large": too_large}
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


def upload_of(scope: MutableMapping[str, Any]) -> tuple[bytes, bool]:
    state = scope.get(SCOPE_KEY)
    if not isinstance(state, dict):
        return b"", False
    return state.get("data") or b"", bool(state.get("too_large"))
