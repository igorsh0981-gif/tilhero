"""Помощники тестов telegram-bot-gateway: фейковые Bot API и identity-consent (httpx.MockTransport)."""

from __future__ import annotations

import itertools
import json
from dataclasses import dataclass, field
from typing import Any

import httpx

from tilhero_botgw.settings import Settings
from tilhero_common.app import Runtime
from tilhero_common.testing import TEST_REDIS_URL

TOKEN = "123456789:AAH" + "x" * 32
SECRET = "s" * 40
MINIAPP = "https://app.tilhero.test/miniapp"


@dataclass
class FakeTelegram:
    """Bot API: запоминает вызовы; ответы — очередь (status, body) или исключение, по умолчанию ok."""

    calls: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    queue: list[Any] = field(default_factory=list)
    tokens_seen: set[str] = field(default_factory=set)
    _ids: Any = field(default_factory=lambda: itertools.count(501))

    def handler(self, request: httpx.Request) -> httpx.Response:
        _, bot, method = request.url.path.split("/", 2)
        self.tokens_seen.add(bot.removeprefix("bot"))
        body = json.loads(request.content or b"{}")
        self.calls.append((method, body))
        if self.queue:
            item = self.queue.pop(0)
            if isinstance(item, Exception):
                raise item
            status, payload = item
            return httpx.Response(status, json=payload)
        result: Any = {"message_id": next(self._ids)} if method == "sendMessage" else True
        return httpx.Response(200, json={"ok": True, "result": result})

    def sent(self, method: str = "sendMessage") -> list[dict[str, Any]]:
        return [body for m, body in self.calls if m == method]


@dataclass
class FakeIdentity:
    calls: list[tuple[str, dict[str, Any], dict[str, str]]] = field(default_factory=list)
    statuses: list[int] = field(default_factory=list)

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.calls.append((request.url.path, json.loads(request.content or b"{}"), dict(request.headers)))
        status = self.statuses.pop(0) if self.statuses else 204
        if status == 204:
            return httpx.Response(204)
        return httpx.Response(status, json={"code": "X", "message": "x", "trace_id": "t", "details": {}})


@dataclass
class GatewayEnv:
    settings: Settings
    client: httpx.AsyncClient
    runtime: Runtime
    telegram: FakeTelegram
    identity: FakeIdentity
    internal: httpx.AsyncClient
    _update_ids: Any = field(default_factory=lambda: itertools.count(1))

    def next_update_id(self) -> int:
        return next(self._update_ids)

    async def webhook(self, update: dict[str, Any], *, secret: str | None = SECRET) -> httpx.Response:
        headers = {"X-Telegram-Bot-Api-Secret-Token": secret} if secret is not None else {}
        return await self.client.post("/telegram/webhook", json=update, headers=headers)

    def message(
        self,
        text: str,
        *,
        lang: str | None = "ru",
        chat_type: str = "private",
        first_name: str = "Игорь",
        user_id: int = 918273645,
        is_bot: bool = False,
    ) -> dict[str, Any]:
        sender: dict[str, Any] = {"id": user_id, "is_bot": is_bot, "first_name": first_name}
        if lang is not None:
            sender["language_code"] = lang
        return {
            "update_id": self.next_update_id(),
            "message": {
                "message_id": 1,
                "date": 1_760_000_000,
                "text": text,
                "from": sender,
                "chat": {"id": user_id if chat_type == "private" else -100500, "type": chat_type},
            },
        }


def make_settings(prefix: str, **overrides) -> Settings:
    values = dict(
        env="test",
        redis_url=TEST_REDIS_URL,
        internal_jwt_secret="t" * 40,
        bot_token=TOKEN,
        telegram_webhook_secret=SECRET,
        miniapp_url=MINIAPP,
        telegram_api_base="https://tg.test",
        identity_consent_url="http://identity-consent.test",
        redis_key_prefix=prefix,
    )
    values.update(overrides)
    return Settings(**values)
