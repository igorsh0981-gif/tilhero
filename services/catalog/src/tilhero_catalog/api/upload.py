"""Тело ≤ 4,5 МБ только на маршруте загрузки аудио (POST /admin/v1/content/blobs).

Общий RequestContextMiddleware (tilhero_common.app) ограничивает тело всех запросов 256 КБ. Чтобы не расширять
лимит для остальных маршрутов и не трогать общий код, этот внешний middleware сам читает тело загрузки (≤ 4,5 МБ:
3 МБ аудио в base64 + JSON), кладёт его в `request.state.upload_body` и передаёт внутрь пустое тело с
Content-Length: 0. Остальные запросы проходят без изменений. Запрос к общему коду: лимит тела по маршруту.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Awaitable, Callable, MutableMapping
from typing import Any, Final

UPLOAD_PATH: Final = "/admin/v1/content/blobs"
UPLOAD_MAX_BYTES: Final = 4_500_000
STATE_KEY: Final = "upload_body"

Scope = MutableMapping[str, Any]
Message = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]


class UploadBodyMiddleware:
    def __init__(self, app: Callable[[Scope, Receive, Send], Awaitable[None]]) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope.get("type") != "http" or scope.get("method") != "POST" or scope.get("path") != UPLOAD_PATH:
            await self.app(scope, receive, send)
            return
        headers = [(k, v) for k, v in scope.get("headers", []) if k.lower() != b"content-length"]
        declared = next((v for k, v in scope.get("headers", []) if k.lower() == b"content-length"), b"")
        if declared.isdigit() and int(declared) > UPLOAD_MAX_BYTES:
            await _too_large(send)
            return
        body = bytearray()
        more = True
        while more:
            message = await receive()
            if message.get("type") == "http.disconnect":
                return
            body.extend(message.get("body", b""))
            if len(body) > UPLOAD_MAX_BYTES:
                await _too_large(send)
                return
            more = bool(message.get("more_body", False))
        inner = dict(scope)
        inner["headers"] = [*headers, (b"content-length", b"0")]
        state = dict(scope.get("state") or {})
        state[STATE_KEY] = bytes(body)
        inner["state"] = state
        delivered = False

        async def empty_receive() -> Message:
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": b"", "more_body": False}
            return await receive()

        await self.app(inner, empty_receive, send)


async def _too_large(send: Send) -> None:
    body = json.dumps({"code": "PAYLOAD_TOO_LARGE", "message": "Слишком большой файл", "trace_id": uuid.uuid4().hex,
                       "details": {}}, ensure_ascii=False).encode()
    await send({"type": "http.response.start", "status": 413, "headers": [(b"content-type", b"application/json")]})
    await send({"type": "http.response.body", "body": body})
