"""Спринт 7 (INTERNAL_API §4, ai.ts SpeechTranscribeMeta/Result): `POST /internal/v1/speech:transcribe` — голосовой
ход парной комнаты. Только lessons; детям — 403 KIDS_NOT_ALLOWED; WAV как у произношения (422 AUDIO_INVALID); tts
recognize (whisper, 0 $), fake на стенде; аварийная остановка, выключенная модель, недоступный tts → 503
SPEECH_UNAVAILABLE; тишина — пустой ответ; учёт без текста (агент коуча, session_kind pair, session_id = room_id);
идемпотентность request_id; сага удаления стирает кеш результатов."""

from __future__ import annotations

import uuid
from typing import Any

import httpx
import jwt
import pytest
from conftest import make_env
from gw_kit import OPERATIONS, PRICING, meta_header, transcribe_meta

from tilhero_ai_gateway.api.common import InvokeCache
from tilhero_ai_gateway.contracts import SpeechTranscribeResult
from tilhero_ai_gateway.domain.wav import make_wav

WAV = make_wav(2000)


def recognized(*words: str, text: str | None = None) -> dict[str, Any]:
    out, t = [], 0
    for w in words:
        out.append({"word": w, "start_ms": t, "end_ms": t + 350, "probability": 0.9})
        t += 400
    return {"text": text if text is not None else " ".join(words), "words": out, "duration_ms": 2000,
            "model": "faster-whisper-base.en"}


class Tts:
    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.replies: list[Any] = []

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        reply = self.replies.pop(0) if self.replies else recognized("I", "like", "chess.")
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
        e.tts = tts  # type: ignore[attr-defined]
        yield e


async def test_fake_transcribe_and_usage_without_text(env) -> None:
    meta = transcribe_meta()
    r = await env.transcribe(WAV, meta)
    assert r.status_code == 200, r.text
    res = r.json()
    SpeechTranscribeResult.model_validate(res)
    assert (res["text"], res["provider"], res["duration_ms"]) == ("Hello, nice to meet you.", "fake_speech", 2000)
    assert [w["word"] for w in res["words"]] == ["hello", "nice", "to", "meet", "you"]
    assert all(0 <= w["start_ms"] <= w["end_ms"] <= 2000 for w in res["words"])
    [row] = await env.usage()
    assert (row["agent_id"], row["session_kind"], str(row["session_id"]), str(row["user_id"]), row["provider"],
            row["model_id"], row["audio_ms"], row["cost_usd"], row["status"], row["caller"]) == (
        "cooperative_lesson_coach", "pair", meta["room_id"], meta["user_id"], "fake_speech", "fake-speech", 2000, 0,
        "ok", "lessons")
    # тишина — пустой ответ, не ошибка (lessons просит повторить или перейти на текст)
    r = await env.transcribe(make_wav(1500, amplitude=50))
    assert r.status_code == 200 and (r.json()["text"], r.json()["words"]) == ("", [])


async def test_callers_user_and_kids(env) -> None:
    for caller in ("memory", "assessment", "telegram-bff"):
        r = await env.transcribe(WAV, caller=caller)
        assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED", caller
    r = await env.transcribe(WAV, transcribe_meta(), subject=str(uuid.uuid4()))
    assert r.status_code == 403 and r.json()["code"] == "USER_CONTEXT_MISMATCH"
    r = await env.transcribe(WAV, transcribe_meta(audience="kids"))
    assert r.status_code == 403 and r.json()["code"] == "KIDS_NOT_ALLOWED"
    r = await env.transcribe(WAV, transcribe_meta(), age_band="6-9")  # детский профиль по claims токена
    assert r.status_code == 403 and r.json()["code"] == "KIDS_NOT_ALLOWED"
    assert await env.usage() == []


@pytest.mark.parametrize(("wav", "content_type", "reason"), [
    (make_wav(300), "audio/wav", "too_short"),
    (make_wav(16_000), "audio/wav", "too_long"),
    (b"RIFF" + b"\x00" * 600_001, "audio/wav", "too_large"),
    (make_wav(2000, rate=8000), "audio/wav", "format"),
    (WAV, "audio/ogg", "format"),
])
async def test_audio_invalid(env, wav: bytes, content_type: str, reason: str) -> None:
    r = await env.transcribe(wav, content_type=content_type)
    assert r.status_code == 422 and r.json()["code"] == "AUDIO_INVALID" and r.json()["details"]["reason"] == reason


@pytest.mark.parametrize("raw", ["", "!!!", meta_header({"request_id": "x"}),
                                 meta_header({**transcribe_meta(), "language": "ru-RU"}),
                                 meta_header({**transcribe_meta(), "text": "hi"})])
async def test_meta_invalid(env, raw: str) -> None:
    r = await env.transcribe(WAV, transcribe_meta(), raw_meta=raw, subject=str(uuid.uuid4()))
    assert r.status_code == 422 and r.json()["code"] == "SPEECH_META_INVALID", raw


async def test_idempotency(env) -> None:
    meta = transcribe_meta()
    first = await env.transcribe(WAV, meta)
    again = await env.transcribe(WAV, meta)
    assert again.status_code == 200 and again.headers.get("idempotent-replay") == "true"
    assert again.json() == first.json() and len(await env.usage()) == 1
    r = await env.transcribe(make_wav(2500), meta)  # тот же request_id, другая запись
    assert r.status_code == 422 and r.json()["code"] == "IDEMPOTENCY_KEY_REUSED"


async def test_emergency_stop_and_model_off_are_503(env) -> None:
    r = await env.c.post("/admin/v1/ai/emergency-stop", json={"enabled": True, "reason": "Авария провайдера"},
                         headers=env.h(OPERATIONS))
    assert r.status_code == 200
    meta = transcribe_meta()
    r = await env.transcribe(WAV, meta)
    assert r.status_code == 503 and r.json()["code"] == "SPEECH_UNAVAILABLE"
    await env.c.post("/admin/v1/ai/emergency-stop", json={"enabled": False, "reason": "Авария устранена"},
                     headers=env.h(OPERATIONS))
    again = await env.transcribe(WAV, meta)  # 503 не сохраняется — повтор распознаёт заново
    assert again.status_code == 200 and again.headers.get("idempotent-replay") is None
    r = await env.c.put("/admin/v1/ai/models/fake-speech", json={
        "input_usd_per_mtok": 0, "output_usd_per_mtok": 0, "audio_usd_per_hour": 0, "active": False,
        "reason": "Выключить распознавание"}, headers=env.h(PRICING))
    assert r.status_code == 200, r.text
    r = await env.transcribe(WAV)
    assert r.status_code == 503 and r.json()["code"] == "SPEECH_UNAVAILABLE"
    reasons = [(u["status"], u["reason"]) for u in await env.usage()]
    assert reasons == [("unavailable", "ai_disabled"), ("ok", None), ("unavailable", "not_configured")]


async def test_whisper_request_and_normalization(wh) -> None:
    learner = uuid.uuid4()
    long_word = "w" * 80
    wh.tts.replies.append({"text": "I like\x07 chess.\n" + "x " * 400, "words": [
        {"word": "I", "start_ms": 0, "end_ms": 200, "probability": 0.9},
        {"word": long_word, "start_ms": 300, "end_ms": 99_000, "probability": 0.9},
        {"word": "", "start_ms": 400, "end_ms": 500},
        {"word": "late", "start_ms": 5000, "end_ms": 4000}] + [
        {"word": "x", "start_ms": 10, "end_ms": 20}] * 200, "duration_ms": 2000})
    r = await wh.transcribe(WAV, transcribe_meta(learner))
    assert r.status_code == 200, r.text
    res = r.json()
    SpeechTranscribeResult.model_validate(res)
    req = wh.tts.requests[0]
    assert (req.method, str(req.url)) == ("POST", "http://tts.test/internal/v1/recognize")
    assert req.headers["content-type"] == "audio/wav" and req.content == WAV
    claims = jwt.decode(req.headers["x-internal-token"], options={"verify_signature": False})
    assert (claims["iss"], claims["aud"]) == ("ai-gateway", "tts") and "sub" not in claims  # tts не знает ученика
    assert res["provider"] == "whisper" and len(res["text"]) <= 600 and "\x07" not in res["text"]
    assert res["text"].startswith("I like chess.") and len(res["words"]) == 120
    assert res["words"][1] == {"word": "w" * 60, "start_ms": 300, "end_ms": 2000}
    assert res["words"][2] == {"word": "late", "start_ms": 2000, "end_ms": 2000}
    [row] = await wh.usage()
    assert (row["provider"], row["model_id"], row["cost_usd"], row["status"]) == ("whisper", "whisper-base-en", 0, "ok")


async def test_whisper_errors_are_503(wh) -> None:
    wh.tts.replies += [httpx.Response(503, json={"code": "RECOGNITION_UNAVAILABLE", "message": "busy"})]
    r = await wh.transcribe(WAV)
    assert r.status_code == 503 and r.json()["code"] == "SPEECH_UNAVAILABLE" and len(wh.tts.requests) == 1
    # сеть — один повтор
    wh.tts.replies += [httpx.ConnectError("down"), recognized("Hello")]
    r = await wh.transcribe(WAV)
    assert r.status_code == 200 and r.json()["text"] == "Hello" and len(wh.tts.requests) == 3
    wh.tts.replies += [{"text": "x", "words": "nope"}]
    r = await wh.transcribe(WAV)
    assert r.status_code == 503
    provider = (await wh.c.get("/admin/v1/ai/provider", headers=wh.h(OPERATIONS))).json()
    assert provider["speech"]["last_error"]["code"] == "bad_response"
    statuses = [(u["status"], u["reason"], u["attempts"]) for u in await wh.usage()]
    assert statuses == [("unavailable", "provider_error", 1), ("ok", None, 2), ("unavailable", "provider_error", 1)]


async def test_whisper_not_configured() -> None:
    async for e in make_env(speech_provider="whisper", tts_url=None):
        r = await e.transcribe(WAV)
        assert r.status_code == 503 and r.json()["code"] == "SPEECH_UNAVAILABLE"
        assert [(u["status"], u["reason"]) for u in await e.usage()] == [("unavailable", "not_configured")]


async def test_azure_pronunciation_keeps_tts_for_room_voice() -> None:
    """SPEECH_PROVIDER=azure (запасной провайдер оценки): голосовой ход комнаты всё равно распознаёт tts."""
    tts = Tts()
    async for e in make_env(speech_transport=httpx.MockTransport(tts), speech_provider="azure",
                            tts_url="http://tts.test", azure_speech_key="k" * 32, azure_speech_region="westeurope"):
        r = await e.transcribe(WAV)
        assert r.status_code == 200 and r.json()["provider"] == "whisper" and len(tts.requests) == 1


async def test_deletion_saga_purges_transcribe_cache(env) -> None:
    learner = uuid.uuid4()
    meta = transcribe_meta(learner)
    assert (await env.transcribe(WAV, meta)).status_code == 200
    assert "transcribe" in InvokeCache.KINDS
    cache = InvokeCache(env.runtime.redis, env.settings.cache_namespace, 60, 60, kind="transcribe")
    assert await env.runtime.redis.exists(cache.key("lessons", meta["request_id"]))
    from tilhero_common.messaging import make_envelope
    ev = make_envelope("user.deletion.requested.v1", {"user_id": str(learner), "request_id": str(uuid.uuid4()),
                                                      "requested_at": "2026-11-21T09:00:00Z"},
                       producer="identity-consent")
    from tilhero_ai_gateway.consumers import deletion_handler
    async with env.runtime.transaction() as s:
        await deletion_handler(env.runtime)(s, ev)
    assert not await env.runtime.redis.exists(cache.key("lessons", meta["request_id"]))
    [row] = await env.usage()
    assert row["user_id"] is None
