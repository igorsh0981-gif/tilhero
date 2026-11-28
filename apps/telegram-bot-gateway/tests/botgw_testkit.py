"""Помощники тестов telegram-bot-gateway: фейковые Bot API, identity-consent и billing (httpx.MockTransport)."""

from __future__ import annotations

import asyncio
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
APP_LINK = "https://t.me/TilHeroBot/app"


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
        result: Any = True
        if method.endswith("sendMessage"):
            result = {"message_id": next(self._ids)}
        elif method.endswith("createInvoiceLink"):
            result = f"https://t.me/$TEST_invoice_{next(self._ids)}"
        elif method.endswith("getStarTransactions"):
            result = {"transactions": []}
        return httpx.Response(200, json={"ok": True, "result": result})

    def sent(self, method: str = "sendMessage") -> list[dict[str, Any]]:
        return [body for m, body in self.calls if m == method]


ACCOUNT_ID = "6f1c2a52-8d3e-4b7a-9e0f-1a2b3c4d5e6f"
TG_USER = 918273645


@dataclass
class FakeIdentity:
    """POST bot-status (спринт 1) и спринт 8: GET telegram-users/{id}/account, accounts/{id}/telegram-user.
    lookup_statuses — очередь сбоев поиска (status | ("sleep", сек)); пусто — по словарю accounts."""

    calls: list[tuple[str, dict[str, Any], dict[str, str]]] = field(default_factory=list)
    statuses: list[int] = field(default_factory=list)
    accounts: dict[int, str] = field(default_factory=lambda: {TG_USER: ACCOUNT_ID})
    statuses_by_user: dict[int, str] = field(default_factory=dict)  # PublicStatus; нет — ACTIVE
    lookup_statuses: list[Any] = field(default_factory=list)
    lookups: list[str] = field(default_factory=list)

    async def handler(self, request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return await self._lookup(request)
        self.calls.append((request.url.path, json.loads(request.content or b"{}"), dict(request.headers)))
        status = self.statuses.pop(0) if self.statuses else 204
        if status == 204:
            return httpx.Response(204)
        return httpx.Response(status, json={"code": "X", "message": "x", "trace_id": "t", "details": {}})

    async def _lookup(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        self.lookups.append(path)
        if self.lookup_statuses:
            item = self.lookup_statuses.pop(0)
            if isinstance(item, tuple):
                await asyncio.sleep(item[1])
            elif item != 200:
                return error(item, "X")
        parts = path.strip("/").split("/")  # internal v1 telegram-users <id> account | accounts <id> telegram-user
        if parts[2] == "telegram-users" and parts[4] == "account":
            account = self.accounts.get(int(parts[3]))
            if account is None:
                return error(404, "USER_NOT_FOUND")
            return httpx.Response(200, json={"account_id": account, "age_band": "18+",
                                             "guardian_consent": "not_required",
                                             "status": self.statuses_by_user.get(int(parts[3]), "ACTIVE")})
        if parts[2] == "accounts" and parts[4] == "telegram-user":
            reverse = {v: k for k, v in self.accounts.items()}
            tg = reverse.get(parts[3])
            if tg is None:
                return error(404, "USER_NOT_FOUND")
            return httpx.Response(200, json={"telegram_user_id": tg})
        return error(404, "NOT_FOUND")


def error(status: int, code: str, **details: Any) -> httpx.Response:
    return httpx.Response(status, json={"code": code, "message": "x", "trace_id": "t", "details": details})


@dataclass
class FakeBilling:
    """billing /internal/v1/stars/*: запоминает вызовы; queue — ответы по порядку (status, body) | исключение |
    ("sleep", сек); иначе — как billing: платёж идемпотентен по charge id (credited — уникальные зачисления)."""

    calls: list[dict[str, Any]] = field(default_factory=list)
    queue: list[Any] = field(default_factory=list)
    pre_checkout: dict[str, Any] = field(default_factory=lambda: {"ok": True})
    credited: list[str] = field(default_factory=list)
    delay: float = 0.0

    async def handler(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content or b"null")
        self.calls.append({"path": request.url.path, "json": body, "headers": dict(request.headers)})
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.queue:
            item = self.queue.pop(0)
            if isinstance(item, Exception):
                raise item
            if isinstance(item, tuple) and item[0] == "sleep":
                await asyncio.sleep(item[1])
            else:
                status, payload = item
                return httpx.Response(status, json=payload)
        path = request.url.path
        if path.endswith("/pre-checkout"):
            return httpx.Response(200, json=self.pre_checkout)
        if path.endswith("/payments"):
            charge = body["telegram_payment_charge_id"]
            if charge not in self.credited:
                self.credited.append(charge)
        return httpx.Response(200, json={"ok": True})

    def paths(self) -> list[str]:
        return [c["path"] for c in self.calls]


@dataclass
class GatewayEnv:
    settings: Settings
    client: httpx.AsyncClient
    runtime: Runtime
    telegram: FakeTelegram
    identity: FakeIdentity
    internal: httpx.AsyncClient
    billing: FakeBilling = field(default_factory=FakeBilling)
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
        billing_url="http://billing.test",
        redis_key_prefix=prefix,
    )
    values.update(overrides)
    return Settings(**values)
