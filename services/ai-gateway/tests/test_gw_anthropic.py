"""Провайдер Anthropic через подмену транспорта httpx (сеть к api.anthropic.com со стенда закрыта): заголовки и тело
Messages API, usage → стоимость, ошибки и таймаут, ключ — только переменная окружения и никогда не в логах и ответах."""

from __future__ import annotations

import json
import logging
from typing import Any

import httpx
import pytest
from conftest import make_env, make_settings
from gw_kit import ANALYST, CP_OK, tc_context

from tilhero_ai_gateway.providers import AnthropicProvider

KEY = "sk-ant-api03-TESTKEY-0123456789abcdefghijklmnopqrstuvwxyz"


class Recorder:
    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.reply: Any = None

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        reply = self.reply
        if isinstance(reply, Exception):
            raise reply
        if callable(reply):
            return reply(request)
        return reply or httpx.Response(200, json={
            "id": "msg_1", "type": "message", "role": "assistant", "model": "claude-haiku-5-5",
            "content": [{"type": "text", "text": CP_OK}], "stop_reason": "end_turn",
            "usage": {"input_tokens": 1200, "output_tokens": 80}})


@pytest.fixture
async def anth():
    recorder = Recorder()
    async for e in make_env(transport=httpx.MockTransport(recorder), ai_provider="anthropic", anthropic_api_key=KEY,
                            anthropic_base_url="https://anthropic.test"):
        e.recorder = recorder
        yield e


async def test_messages_api_request_and_cost(anth) -> None:
    res = await anth.ok()
    assert res["status"] == "ok" and res["model_id"] == "claude-haiku-5-5"
    assert res["cost_usd"] == pytest.approx(0.00016)  # 1200 × 0.10 / 1e6 + 80 × 0.50 / 1e6
    req = anth.recorder.requests[0]
    assert req.method == "POST" and str(req.url) == "https://anthropic.test/v1/messages"
    assert req.headers["x-api-key"] == KEY and req.headers["anthropic-version"] == "2023-06-01"
    assert req.headers["content-type"] == "application/json"
    body = json.loads(req.content)
    assert set(body) == {"model", "system", "messages", "max_tokens", "temperature"}
    assert body["model"] == "claude-haiku-5-5" and body["max_tokens"] == 300 and body["temperature"] == 0.3
    assert isinstance(body["system"], str) and "Правила шлюза" in body["system"]
    assert [m["role"] for m in body["messages"]] == ["user"]
    assert json.loads(body["messages"][0]["content"])["context"]["learner_turn"].startswith("Can I have")
    row = (await anth.usage())[0]
    assert (row["input_tokens"], row["output_tokens"], str(row["cost_usd"]), row["provider"]) == (
        1200, 80, "0.000160", "anthropic")


async def test_text_blocks_joined_and_bad_response(anth) -> None:
    anth.recorder.reply = httpx.Response(200, json={"content": [{"type": "text", "text": CP_OK[:10]},
                                                                {"type": "text", "text": CP_OK[10:]}],
                                                    "usage": {"input_tokens": 1, "output_tokens": 1}})
    assert (await anth.ok())["status"] == "ok"
    anth.recorder.reply = httpx.Response(200, content=b"<html>oops</html>")
    res = await anth.ok()
    assert (res["status"], res["reason"]) == ("unavailable", "provider_error")


async def test_key_never_in_logs_or_responses_on_provider_error(anth, caplog, capfd) -> None:
    caplog.set_level(logging.DEBUG)
    anth.recorder.reply = httpx.Response(401, json={"type": "error", "error": {
        "type": "authentication_error", "message": f"invalid x-api-key: {KEY}"}})
    r = await anth.invoke()
    assert r.status_code == 200 and KEY not in r.text
    assert (r.json()["status"], r.json()["reason"]) == ("unavailable", "provider_error")
    assert [q.url.path for q in anth.recorder.requests] == ["/v1/messages", "/v1/messages"]  # + резервная модель
    status = await anth.c.get("/admin/v1/ai/provider", headers=anth.h(ANALYST))
    assert status.json() == {"provider": "anthropic", "key_configured": True, "ai_enabled": True,
                             "last_error": {"code": "http_401", "at": "2026-11-19T07:00:00.000Z"}}
    assert KEY not in status.text
    anth.recorder.reply = httpx.ConnectError(f"connect failed with header x-api-key={KEY}")
    assert (await anth.ok())["reason"] == "provider_error"
    for path in ("/admin/v1/ai/agents", "/admin/v1/ai/models", "/admin/v1/ai/agents/conversation_partner/versions/1"):
        assert KEY not in (await anth.c.get(path, headers=anth.h(ANALYST))).text
    out, err = capfd.readouterr()
    assert KEY not in caplog.text and KEY not in out and KEY not in err
    assert "sk-ant" not in caplog.text
    assert KEY not in repr(AnthropicProvider(KEY, "https://x")) and KEY not in repr(anth.settings)
    assert KEY not in str(anth.settings.model_dump())


async def test_timeout_and_network_error(anth) -> None:
    anth.recorder.reply = httpx.ReadTimeout("timed out")
    res = await anth.ok()
    assert (res["status"], res["reason"]) == ("unavailable", "timeout")
    anth.recorder.reply = httpx.ConnectError("refused")
    res = await anth.ok("teaching_coach", tc_context())
    assert (res["status"], res["reason"]) == ("unavailable", "provider_error")
    last = (await anth.c.get("/admin/v1/ai/provider", headers=anth.h(ANALYST))).json()["last_error"]
    assert last["code"] == "network"


async def test_overloaded_then_fallback_model(anth) -> None:
    def reply(request: httpx.Request) -> httpx.Response:
        if json.loads(request.content)["model"] == "claude-haiku-5-5":
            return httpx.Response(529, json={"type": "error", "error": {"type": "overloaded_error"}})
        return httpx.Response(200, json={"content": [{"type": "text", "text": CP_OK}],
                                         "usage": {"input_tokens": 1000, "output_tokens": 100}})

    anth.recorder.reply = reply
    res = await anth.ok()
    assert res["status"] == "ok" and res["model_id"] == "claude-sonnet-5-5"
    assert res["cost_usd"] == pytest.approx(0.003)  # sonnet: 1000 × 2 / 1e6 + 100 × 10 / 1e6


async def test_no_key_means_ai_disabled() -> None:
    recorder = Recorder()
    async for env in make_env(transport=httpx.MockTransport(recorder), ai_provider="anthropic",
                              anthropic_api_key="   "):
        res = await env.ok()
        assert (res["status"], res["reason"]) == ("unavailable", "ai_disabled")
        assert not recorder.requests
        status = (await env.c.get("/admin/v1/ai/provider", headers=env.h(ANALYST))).json()
        assert status == {"provider": "anthropic", "key_configured": False, "last_error": None, "ai_enabled": True}


def test_settings_guards() -> None:
    with pytest.raises(ValueError):
        make_settings(env="prod", ai_provider="fake", internal_jwt_secret="p" * 40,
                      internal_jwt_private_key="A" * 43)
    with pytest.raises(ValueError):
        make_settings(env="stage", ai_provider="anthropic", anthropic_base_url="http://plain",
                      internal_jwt_secret="p" * 40, internal_jwt_private_key="A" * 43)
    with pytest.raises(ValueError):
        make_settings(env="prod", ai_provider="anthropic", ai_allow_fake_test_publish=True,
                      internal_jwt_secret="p" * 40, internal_jwt_private_key="A" * 43)
    with pytest.raises(ValueError) as exc:
        make_settings(env="prod", ai_provider="fake", anthropic_api_key=KEY, internal_jwt_secret="p" * 40,
                      internal_jwt_private_key="A" * 43)
    assert KEY not in str(exc.value)
    ok = make_settings(env="prod", ai_provider="anthropic", anthropic_api_key=KEY, internal_jwt_secret="p" * 40,
                       internal_jwt_private_key="A" * 43, ai_allow_fake_test_publish=False)
    assert ok.publish_providers == ("anthropic",) and ok.api_key == KEY
    assert make_settings(ai_allow_fake_test_publish=True).publish_providers == ("anthropic", "fake")
