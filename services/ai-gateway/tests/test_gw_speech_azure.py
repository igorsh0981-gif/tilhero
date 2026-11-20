"""Azure AI Speech (REST для короткого аудио, Pronunciation Assessment) через подмену транспорта httpx — сеть стенда к
Azure закрыта (INTERNAL_API §3.2): URL, заголовки и base64 JSON `Pronunciation-Assessment`, тело — WAV как есть;
разбор NBest[0] (формат REST — баллы в элементе, формат SDK — в `PronunciationAssessment`); низкая уверенность,
NoMatch, неполнота → insufficient_evidence; 5xx/сеть — один повтор при запасе ≥ 4 с; таймаут и 4xx — без повтора;
неверный JSON; стоимость = audio_ms / 3 600 000 × 1.32; ключ и регион не заданы → not_configured; ключ — никогда в
логах, ответах и БД."""

from __future__ import annotations

import base64
import json
import logging
import uuid
from typing import Any

import httpx
import pytest
from conftest import make_env, make_settings
from gw_kit import ANALYST, OPERATIONS, speech_meta

from tilhero_ai_gateway.contracts import PronunciationResult
from tilhero_ai_gateway.domain import speech as speech_domain
from tilhero_ai_gateway.domain.wav import make_wav

KEY = "azkey-TEST-0123456789abcdef0123456789abcdef"
REF = "Good morning, I have a reservation"
WAV = make_wav(2500)
COST = 2500 / 3_600_000 * 1.32


def words(*items: tuple[str, float, str]) -> list[dict[str, Any]]:
    return [{"Word": w, "Offset": 0, "Duration": 1, "Confidence": 0.0, "AccuracyScore": a, "ErrorType": e}
            for w, a, e in items]


def azure_ok(confidence: float = 0.91, completeness: float = 92.0, pron: float = 71.4,
             items: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Ответ REST short audio (детальный формат, баллы прямо в NBest[0] и словах)."""
    return {"RecognitionStatus": "Success", "Offset": 700000, "Duration": 24000000, "DisplayText": "Good morning.",
            "NBest": [{"Confidence": confidence, "Lexical": "good morning i have a reservation",
                       "AccuracyScore": 78.3, "FluencyScore": 64.0, "CompletenessScore": completeness,
                       "PronScore": pron,
                       "Words": items if items is not None else words(
                           ("good", 95.0, "None"), ("morning", 41.0, "Mispronunciation"), ("i", 0.0, "Omission"),
                           ("have", 88.0, "None"), ("a", 90.0, "None"), ("reservation", 52.0, "Mispronunciation"),
                           ("really", 0.0, "Insertion"))}]}


class Azure:
    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.replies: list[Any] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        reply = self.replies.pop(0) if self.replies else httpx.Response(200, json=azure_ok())
        if isinstance(reply, Exception):
            raise reply
        if isinstance(reply, dict):
            return httpx.Response(200, json=reply)
        return reply


@pytest.fixture
async def az():
    azure = Azure()
    async for e in make_env(speech_transport=httpx.MockTransport(azure), speech_provider="azure",
                            azure_speech_key=KEY, azure_speech_region="westeurope"):
        e.azure = azure
        yield e


async def test_request_and_success(az) -> None:
    learner = uuid.uuid4()
    r = await az.speech(WAV, speech_meta(learner, reference_text=REF))
    assert r.status_code == 200, r.text
    res = r.json()
    PronunciationResult.model_validate(res)
    req = az.azure.requests[0]
    assert req.method == "POST"
    assert str(req.url) == ("https://westeurope.stt.speech.microsoft.com/speech/recognition/conversation/"
                            "cognitiveservices/v1?language=en-US&format=detailed")
    assert req.headers["Ocp-Apim-Subscription-Key"] == KEY
    assert req.headers["Content-Type"] == "audio/wav; codecs=audio/pcm; samplerate=16000"
    assert req.headers["Accept"] == "application/json"
    params = json.loads(base64.b64decode(req.headers["Pronunciation-Assessment"]))
    assert params == {"ReferenceText": REF, "GradingSystem": "HundredMark", "Granularity": "Word",
                      "Dimension": "Comprehensive", "EnableMiscue": True}
    assert req.content == WAV
    assert (res["status"], res["reason"], res["provider"], res["confidence"], res["audio_ms"]) == (
        "ok", None, "azure_speech", 0.91, 2500)
    assert res["scores"] == {"accuracy": 78.3, "fluency": 64.0, "completeness": 92.0, "pron": 71.4}
    assert res["intelligibility"] == "mostly_clear"
    assert [(w["word"], w["accuracy"], w["error_type"]) for w in res["words"]] == [
        ("good", 95.0, "none"), ("morning", 41.0, "mispronunciation"), ("i", 0.0, "omission"),
        ("have", 88.0, "none"), ("a", 90.0, "none"), ("reservation", 52.0, "mispronunciation"),
        ("really", 0.0, "insertion")]
    # ≤ 2 совета: сначала самые низкие — пропуск «i» (0), затем «morning» (41); «reservation» (52) — третий
    assert [(t["word"], t["text"]) for t in res["tips"]] == [
        ("i", "Слово «i» не прозвучало — произнесите фразу целиком."),
        ("morning", "Слово «morning» прозвучало неразборчиво. Послушайте образец и повторите медленно.")]
    assert res["cost_usd"] == pytest.approx(COST, abs=1e-6)
    row = (await az.usage())[-1]
    assert (row["provider"], row["model_id"], row["status"], row["attempts"], row["audio_ms"], row["user_id"]) == (
        "azure_speech", "azure-speech-pa", "ok", 1, 2500, learner)
    assert float(row["cost_usd"]) == pytest.approx(COST, abs=1e-6) and row["reserved_usd"] == 0


async def test_sdk_nested_format_and_intelligibility(az) -> None:
    az.azure.replies = [{"RecognitionStatus": "Success", "NBest": [{
        "Confidence": "0.88", "PronunciationAssessment": {"AccuracyScore": 92, "FluencyScore": 85,
                                                          "CompletenessScore": 100, "PronScore": 90.26},
        "Words": [{"Word": "good", "PronunciationAssessment": {"AccuracyScore": 92, "ErrorType": "None"}},
                  {"Word": "morning", "PronunciationAssessment": {"AccuracyScore": 59.9,
                                                                  "ErrorType": "Mispronunciation"}}]}]}]
    res = (await az.speech(WAV, speech_meta(reference_text="Good morning", locale="uz"))).json()
    assert res["scores"] == {"accuracy": 92.0, "fluency": 85.0, "completeness": 100.0, "pron": 90.3}
    assert res["intelligibility"] == "clear" and res["confidence"] == 0.88
    assert res["tips"] == [{"word": "morning",
                            "text": "«morning» soʻzi aniq eshitilmadi. Namunani tinglang va sekin takrorlang."}]


@pytest.mark.parametrize(("reply", "reason", "confidence"), [
    (azure_ok(confidence=0.39), "low_confidence", 0.39),
    ({"RecognitionStatus": "NoMatch", "Offset": 0, "Duration": 0}, "not_recognized", None),
    ({"RecognitionStatus": "InitialSilenceTimeout"}, "not_recognized", None),
    ({"RecognitionStatus": "Success", "NBest": []}, "not_recognized", None),
    (azure_ok(completeness=29.9), "incomplete", 0.91),
    (azure_ok(confidence=None), "low_confidence", None),  # type: ignore[arg-type]
])
async def test_insufficient_evidence(az, reply, reason, confidence) -> None:
    az.azure.replies = [reply]
    res = (await az.speech(WAV)).json()
    assert (res["status"], res["reason"], res["scores"], res["words"], res["tips"], res["intelligibility"],
            res["confidence"]) == ("insufficient_evidence", reason, None, [], [], None, confidence)
    PronunciationResult.model_validate(res)
    assert res["cost_usd"] == pytest.approx(COST, abs=1e-6)  # провайдер обработал запись — оплачено
    row = (await az.usage())[-1]
    assert (row["status"], row["reason"]) == ("ok", reason)


@pytest.mark.parametrize("first", [httpx.Response(503, text="busy"), httpx.ConnectError("boom"),
                                   httpx.Response(500, json={"error": "x"})])
async def test_retry_once_on_5xx_or_network(az, first) -> None:
    az.azure.replies = [first, azure_ok()]
    res = (await az.speech(WAV)).json()
    assert res["status"] == "ok" and len(az.azure.requests) == 2
    assert res["cost_usd"] == pytest.approx(COST, abs=1e-6)  # одна оплаченная попытка
    row = (await az.usage())[-1]
    assert row["attempts"] == 2


async def test_two_failures_unavailable_with_last_error(az) -> None:
    az.azure.replies = [httpx.Response(503), httpx.Response(502)]
    res = (await az.speech(WAV)).json()
    assert (res["status"], res["reason"], res["provider"], res["cost_usd"]) == (
        "unavailable", "provider_error", "azure_speech", 0)
    assert len(az.azure.requests) == 2
    status = (await az.c.get("/admin/v1/ai/provider", headers=az.h(ANALYST))).json()
    assert status["speech"] == {"provider": "azure_speech", "key_configured": True, "region": "westeurope",
                                "last_error": {"code": "http_502", "at": "2026-11-19T07:00:00.000Z"}}
    assert status["last_error"] is None  # ошибка речи не смешивается с ошибкой LLM


async def test_no_retry_when_deadline_close(az, monkeypatch) -> None:
    monkeypatch.setattr(speech_domain, "DEADLINE_S", 3.9)
    az.azure.replies = [httpx.Response(503), azure_ok()]
    res = (await az.speech(WAV)).json()
    assert (res["status"], res["reason"]) == ("unavailable", "provider_error") and len(az.azure.requests) == 1


@pytest.mark.parametrize(("reply", "reason", "billed"), [
    (httpx.ReadTimeout("slow"), "timeout", True),
    (httpx.Response(401, json={"error": {"message": f"invalid key {KEY}"}}), "provider_error", False),
    (httpx.Response(400, text="bad audio"), "provider_error", False),
    (httpx.Response(429, text="throttled"), "provider_error", False),
    (httpx.Response(200, content=b"<html>not json</html>"), "provider_error", True),
    (httpx.Response(200, json=["not", "an", "object"]), "provider_error", True),
    (httpx.Response(200, json={"RecognitionStatus": "Success", "NBest": [{"Confidence": 0.9, "Words": []}]}),
     "provider_error", True),  # нет баллов — формат провайдера изменился
])
async def test_no_retry_errors(az, reply, reason, billed) -> None:
    az.azure.replies = [reply, azure_ok()]
    res = (await az.speech(WAV)).json()
    assert (res["status"], res["reason"]) == ("unavailable", reason)
    assert len(az.azure.requests) == 1
    assert res["cost_usd"] == (pytest.approx(COST, abs=1e-6) if billed else 0)
    assert KEY not in json.dumps(res)


async def test_budget_exceeded_before_provider(az) -> None:
    await az.set_budget(learner_daily_cap_usd=0.0005)  # меньше стоимости 2,5 с (≈ 0,00092 $)
    res = (await az.speech(WAV)).json()
    assert (res["status"], res["reason"], res["provider"]) == ("unavailable", "budget_exceeded", None)
    assert not az.azure.requests
    row = (await az.usage())[-1]
    assert (row["status"], row["reason"], row["reserved_usd"], row["cost_usd"]) == (
        "unavailable", "budget_exceeded", 0, 0)


@pytest.mark.parametrize(("key", "region"), [(None, "westeurope"), (KEY, None), (KEY, "West Europe!"), ("  ", "")])
async def test_not_configured(key, region) -> None:
    azure = Azure()
    async for e in make_env(speech_transport=httpx.MockTransport(azure), speech_provider="azure",
                            azure_speech_key=key, azure_speech_region=region):
        res = (await e.speech(WAV)).json()
        assert (res["status"], res["reason"], res["provider"], res["cost_usd"]) == (
            "unavailable", "not_configured", None, 0)
        assert not azure.requests
        assert (await e.c.get("/internal/v1/status", headers=e.svc("memory"))).json() == {
            "ai_available": True, "speech_available": False}
        speech = (await e.c.get("/admin/v1/ai/provider", headers=e.h(ANALYST))).json()["speech"]
        assert speech["provider"] == "azure_speech" and speech["key_configured"] is bool(key and key.strip())
        summary = (await e.c.get("/admin/v1/ai/usage/summary", headers=e.h(OPERATIONS))).json()
        assert summary["speech"]["speech_available"] is False and summary["speech"]["calls"] == 1


async def test_key_never_in_logs_responses_or_db(az, caplog, capfd) -> None:
    caplog.set_level(logging.DEBUG)
    az.azure.replies = [httpx.Response(401, json={"error": f"bad key {KEY}"}),
                        httpx.ConnectError(f"connect failed with header Ocp-Apim-Subscription-Key={KEY}"),
                        httpx.Response(503), azure_ok()]
    for _ in range(3):
        r = await az.speech(WAV)
        assert KEY not in r.text
    for path in ("/admin/v1/ai/provider", "/admin/v1/ai/models", "/admin/v1/ai/usage/summary"):
        assert KEY not in (await az.c.get(path, headers=az.h(OPERATIONS if "usage" in path else ANALYST))).text
    out, err = capfd.readouterr()
    assert KEY not in caplog.text and KEY not in out and KEY not in err
    assert all(KEY not in str(getattr(rec, "__dict__", "")) for rec in caplog.records)
    for table in ("usage", "models", "outbox"):
        blob = await az.sql(f"SELECT coalesce(string_agg(row_to_json(t)::text, ' '), '') AS s "  # noqa: S608
                            f"FROM {table} t")  # имена таблиц — константы теста
        assert KEY not in blob[0]["s"], table
    assert "key_configured=True" in repr(az.app.state.speech) and KEY not in repr(az.app.state.speech)


def test_settings_guards() -> None:
    with pytest.raises(ValueError):
        make_settings(env="prod", ai_provider="anthropic", speech_provider="fake", internal_jwt_secret="p" * 40,
                      internal_jwt_private_key="A" * 43)
    ok = make_settings(env="prod", ai_provider="anthropic", speech_provider="azure", azure_speech_key=f" {KEY} ",
                       azure_speech_region=" WestEurope ", internal_jwt_secret="p" * 40,
                       internal_jwt_private_key="A" * 43, ai_allow_fake_test_publish=False)
    assert ok.speech_key == KEY and ok.speech_region == "westeurope" and KEY not in repr(ok)
    empty = make_settings(speech_provider="azure", azure_speech_key="", azure_speech_region="")
    assert empty.speech_key is None and empty.speech_region is None
    assert make_settings(speech_provider="azure", azure_speech_region="west europe").speech_region is None
