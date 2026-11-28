"""Провайдер оценки произношения `whisper` (релиз 5.1, решение владельца 20.11.2026: свой сервер): запись → сервис tts
`POST /internal/v1/recognize` (подмена транспорта клиента tts), сравнение слов с эталоном, советы, insufficient,
ошибки tts (503 без повтора, сеть — повтор, таймаут, неверный ответ), стоимость 0 и бюджеты не тратятся, аварийная
остановка действует, статус и провайдер в админке, не настроено (нет TTS_URL)."""

from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any

import httpx
import jwt
import pytest
from conftest import make_env, make_settings
from gw_kit import ANALYST, OPERATIONS, PRICING, speech_meta

from tilhero_ai_gateway.contracts import PronunciationResult
from tilhero_ai_gateway.domain import speech as speech_domain
from tilhero_ai_gateway.domain.wav import make_wav
from tilhero_ai_gateway.settings import Settings

REF = "Good morning, I have a reservation"
WAV = make_wav(2400)


def recognized(*words: str | tuple[str, float]) -> dict[str, Any]:
    out, t = [], 0
    for w in words:
        word, prob = (w, 0.93) if isinstance(w, str) else w
        out.append({"word": word, "start_ms": t, "end_ms": t + 350, "probability": prob})
        t += 400
    return {"text": " ".join(x["word"] for x in out), "words": out, "duration_ms": 2400,
            "model": "faster-whisper-base.en"}


class Tts:
    """Сервис tts: записывает запросы, отдаёт заданные ответы (dict → 200 JSON, Response, исключение, корутина)."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.replies: list[Any] = []

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        reply = self.replies.pop(0) if self.replies else recognized("Good", "morning,", "I", "have", "a",
                                                                      "reservation.")
        if callable(reply):
            reply = await reply()
        if isinstance(reply, Exception):
            raise reply
        if isinstance(reply, dict):
            return httpx.Response(200, json=reply)
        return reply


@pytest.fixture
async def wh():
    tts = Tts()
    async for e in make_env(speech_transport=httpx.MockTransport(tts), speech_provider="whisper",
                            tts_url="http://tts.test/"):
        e.tts = tts
        yield e


async def test_request_to_tts_and_ok(wh) -> None:
    learner = uuid.uuid4()
    r = await wh.speech(WAV, speech_meta(learner, reference_text=REF))
    assert r.status_code == 200, r.text
    res = r.json()
    PronunciationResult.model_validate(res)
    req = wh.tts.requests[0]
    assert (req.method, str(req.url)) == ("POST", "http://tts.test/internal/v1/recognize")
    assert req.headers["content-type"] == "audio/wav" and req.content == WAV
    claims = jwt.decode(req.headers["x-internal-token"], options={"verify_signature": False})
    assert (claims["iss"], claims["aud"]) == ("ai-gateway", "tts") and "sub" not in claims  # без ученика
    assert REF not in req.headers.get("x-speech-meta", "") and b"reservation" not in req.content  # эталон — не в tts
    assert (res["status"], res["reason"], res["provider"], res["cost_usd"], res["confidence"], res["audio_ms"]) == (
        "ok", None, "whisper", 0, 0.93, 2400)
    assert [(w["word"], w["accuracy"], w["error_type"]) for w in res["words"]] == [
        (w, 93.0, "none") for w in ("Good", "morning", "I", "have", "a", "reservation")]
    assert res["scores"] == {"accuracy": 93.0, "fluency": 100.0, "completeness": 100.0, "pron": 95.8}
    assert res["intelligibility"] == "clear" and res["tips"] == []
    row = (await wh.usage())[-1]
    assert (row["provider"], row["model_id"], row["status"], row["audio_ms"], row["user_id"], row["attempts"]) == (
        "whisper", "whisper-base-en", "ok", 2400, learner, 1)
    assert (str(row["cost_usd"]), str(row["reserved_usd"])) == ("0.000000", "0.000000")


async def test_errors_tips_kids_and_uz(wh) -> None:
    """Пропуск и неразборчивое слово → советы (сначала самые низкие); дети — на «ты»; uz."""
    reply = recognized("Good", ("morning", 0.38), "I", "a", "reservation", "please")
    wh.tts.replies = [reply, reply, reply]
    res = (await wh.speech(WAV, speech_meta(reference_text=REF))).json()
    assert [(w["word"], w["error_type"]) for w in res["words"]] == [
        ("Good", "none"), ("morning", "mispronunciation"), ("I", "none"), ("have", "omission"), ("a", "none"),
        ("reservation", "none"), ("please", "insertion")]
    assert [t["word"] for t in res["tips"]] == ["have", "morning"]
    assert res["tips"][0]["text"] == "Слово «have» не прозвучало — произнесите фразу целиком."
    kids = (await wh.speech(WAV, speech_meta(reference_text=REF, audience="kids"))).json()
    assert kids["tips"][1]["text"].startswith("Давай ещё раз скажем слово «morning»")
    uz = (await wh.speech(WAV, speech_meta(reference_text=REF, locale="uz"))).json()
    assert uz["tips"][0]["text"] == "«have» soʻzi aytilmadi — iborani toʻliq ayting."
    for r in (res, kids, uz):
        assert all("акцент" not in t["text"].lower() for t in r["tips"])


@pytest.mark.parametrize(("reply", "reason"), [
    ({"text": "", "words": [], "duration_ms": 2400, "model": "faster-whisper-base.en"}, "not_recognized"),
    (recognized(("Good", 0.2), ("morning", 0.3), ("I", 0.35), ("have", 0.3), ("a", 0.4), ("reservation", 0.3)),
     "low_confidence"),
    (recognized("Hello", "everybody"), "incomplete"),
])
async def test_insufficient_evidence(wh, reply, reason) -> None:
    wh.tts.replies = [reply]
    res = (await wh.speech(WAV, speech_meta(reference_text=REF))).json()
    assert (res["status"], res["reason"], res["scores"], res["words"], res["tips"]) == (
        "insufficient_evidence", reason, None, [], [])
    row = (await wh.usage())[-1]
    assert (row["status"], row["reason"], str(row["cost_usd"])) == ("ok", reason, "0.000000")


@pytest.mark.parametrize(("reply", "last_error"), [
    (httpx.Response(503, json={"code": "RECOGNITION_UNAVAILABLE", "message": "x", "details": {}}), "http_503"),
    (httpx.Response(422, json={"code": "AUDIO_INVALID", "message": "x", "details": {"reason": "format"}}), "http_422"),
    (httpx.Response(500, text="boom"), "http_500"),
    (httpx.Response(200, json={"text": "hi"}), "bad_response"),
    (httpx.Response(200, json={"words": ["hi"]}), "bad_response"),
])
async def test_tts_errors_without_retry(wh, reply, last_error) -> None:
    wh.tts.replies = [reply, recognized("Good")]
    res = (await wh.speech(WAV, speech_meta(reference_text=REF))).json()
    assert (res["status"], res["reason"], res["provider"], res["cost_usd"]) == (
        "unavailable", "provider_error", "whisper", 0)
    assert len(wh.tts.requests) == 1  # tts не перегружается повтором
    speech = (await wh.c.get("/admin/v1/ai/provider", headers=wh.h(ANALYST))).json()["speech"]
    assert speech["last_error"]["code"] == last_error


@pytest.mark.parametrize("first", [httpx.ConnectError("refused"), httpx.Response(502), httpx.Response(504)])
async def test_network_or_gateway_error_retried_once(wh, first) -> None:
    wh.tts.replies = [first, recognized("Good", "morning", "I", "have", "a", "reservation")]
    res = (await wh.speech(WAV, speech_meta(reference_text=REF))).json()
    assert res["status"] == "ok" and len(wh.tts.requests) == 2
    assert (await wh.usage())[-1]["attempts"] == 2


async def test_tts_down_twice_is_provider_error(wh) -> None:
    wh.tts.replies = [httpx.ConnectError("refused"), httpx.ConnectError("refused")]
    res = (await wh.speech(WAV)).json()
    assert (res["status"], res["reason"]) == ("unavailable", "provider_error") and len(wh.tts.requests) == 2


async def test_tts_timeout(wh, monkeypatch) -> None:
    monkeypatch.setattr(speech_domain, "ATTEMPT_TIMEOUT_S", 0.3)
    monkeypatch.setattr(speech_domain, "MIN_ATTEMPT_S", 0.1)

    async def slow() -> dict[str, Any]:
        await asyncio.sleep(2)
        return recognized("Good")

    wh.tts.replies = [slow]
    res = (await wh.speech(WAV)).json()
    assert (res["status"], res["reason"], res["cost_usd"]) == ("unavailable", "timeout", 0)
    assert len(wh.tts.requests) == 1


async def test_no_budget_spent_but_emergency_stop_applies(wh) -> None:
    """Свой сервер денег не стоит: исчерпанные подлимит речи и лимит ученика в день whisper не блокируют; аварийная
    остановка — блокирует. Спринт 8 (INTERNAL_API §7): из уровней деградации произношение выключает только off —
    в том числе авто-off по исчерпанному потолку месяца (economy и paid_only его не трогают)."""
    await wh.set_budget(monthly_cap_usd=20, speech_monthly_cap_usd=0, learner_daily_cap_usd=0)
    await wh.sql("INSERT INTO usage (call_id, request_id, caller, agent_id, provider, status, cost_usd, created_at, "
                 "finished_at) VALUES ($1, $2, 'lessons', 'conversation_partner', 'anthropic', 'ok', 19, $3, $3)",
                 uuid.uuid4(), uuid.uuid4(), wh.now)  # 95 % — paid_only
    assert (await wh.c.get("/internal/v1/status", headers=wh.svc("memory"))).json() == {
        "ai_available": True, "speech_available": True, "level": "paid_only", "free_available": False,
        "paid_available": True}
    assert (await wh.speech(WAV, speech_meta(reference_text=REF))).json()["status"] == "ok"
    await wh.sql("INSERT INTO usage (call_id, request_id, caller, agent_id, provider, status, cost_usd, created_at, "
                 "finished_at) VALUES ($1, $2, 'lessons', 'conversation_partner', 'anthropic', 'ok', 1, $3, $3)",
                 uuid.uuid4(), uuid.uuid4(), wh.now)  # 100 % — off
    res = (await wh.speech(WAV, speech_meta(reference_text=REF))).json()
    assert (res["status"], res["reason"], res["provider"]) == ("unavailable", "budget_exceeded", None)
    assert (await wh.c.get("/internal/v1/status", headers=wh.svc("memory"))).json()["speech_available"] is False
    await wh.c.post("/admin/v1/ai/emergency-stop", json={"enabled": True, "reason": "Авария"},
                    headers=wh.h(OPERATIONS))
    res = (await wh.speech(WAV)).json()
    assert (res["status"], res["reason"], res["provider"]) == ("unavailable", "ai_disabled", None)
    assert (await wh.c.get("/internal/v1/status", headers=wh.svc("memory"))).json() == {
        "ai_available": False, "speech_available": False, "level": "off", "free_available": False,
        "paid_available": False}
    assert len(wh.tts.requests) == 1


async def test_provider_status_summary_and_model(wh) -> None:
    await wh.speech(WAV, speech_meta(reference_text=REF))
    provider = (await wh.c.get("/admin/v1/ai/provider", headers=wh.h(ANALYST))).json()
    assert provider["speech"] == {"provider": "whisper", "key_configured": True, "region": None, "last_error": None}
    summary = (await wh.c.get("/admin/v1/ai/usage/summary", params={"period": "day"},
                              headers=wh.h(OPERATIONS))).json()
    assert summary["speech"] == {"calls": 1, "audio_minutes": 0.04, "spent_usd": 0.0, "speech_available": True,
                                 "cap_usd": 5.0}
    models = {m["model_id"]: m for m in (await wh.c.get("/admin/v1/ai/models", headers=wh.h(ANALYST))).json()["items"]}
    assert (models["whisper-base-en"]["provider"], models["whisper-base-en"]["audio_usd_per_hour"]) == ("whisper", 0.0)
    # свой сервер бесплатен: ненулевая цена часа отклоняется, цена остаётся 0
    r = await wh.c.put("/admin/v1/ai/models/whisper-base-en", json={
        "input_usd_per_mtok": 0, "output_usd_per_mtok": 0, "audio_usd_per_hour": 1.5, "active": True,
        "reason": "Попытка задать цену"}, headers=wh.h(PRICING))
    assert r.status_code == 422 and r.json()["code"] == "PRICE_NOT_APPLICABLE"
    assert r.json()["details"] == {"fields": ["audio_usd_per_hour"]}
    # модель выключена в админке (ai.publish) — функция скрыта (not_configured), как у Azure
    r = await wh.c.put("/admin/v1/ai/models/whisper-base-en", json={
        "input_usd_per_mtok": 0, "output_usd_per_mtok": 0, "audio_usd_per_hour": 0, "active": False,
        "reason": "Выключить речь"}, headers=wh.h(PRICING))
    assert r.status_code == 200 and r.json()["active"] is False
    res = (await wh.speech(WAV)).json()
    assert (res["status"], res["reason"]) == ("unavailable", "not_configured") and len(wh.tts.requests) == 1
    assert (await wh.c.get("/internal/v1/status", headers=wh.svc("memory"))).json()["speech_available"] is False


async def test_not_configured_without_tts_url() -> None:
    tts = Tts()
    async for e in make_env(speech_transport=httpx.MockTransport(tts), speech_provider="whisper", tts_url=None):
        res = (await e.speech(WAV)).json()
        assert (res["status"], res["reason"], res["provider"]) == ("unavailable", "not_configured", None)
        assert not tts.requests
        assert (await e.c.get("/internal/v1/status", headers=e.svc("memory"))).json()["speech_available"] is False
        speech = (await e.c.get("/admin/v1/ai/provider", headers=e.h(ANALYST))).json()["speech"]
        assert speech == {"provider": "whisper", "key_configured": False, "region": None, "last_error": None}


def test_settings() -> None:
    assert Settings.model_fields["speech_provider"].default == "whisper"
    assert make_settings(speech_provider="whisper", tts_url=" http://tts:8115/ ").tts_url == "http://tts:8115"
    assert make_settings(speech_provider="whisper", tts_url="").tts_url is None
    with pytest.raises(ValueError):
        make_settings(speech_provider="whisper", tts_url="tts:8115")
    prod = make_settings(env="prod", ai_provider="anthropic", speech_provider="whisper", tts_url="http://tts:8115",
                         internal_jwt_secret="p" * 40, internal_jwt_private_key="A" * 43,
                         ai_allow_fake_test_publish=False)
    assert prod.speech_provider == "whisper"
    assert json.dumps(prod.model_dump(mode="json")).count("tts:8115") == 1
