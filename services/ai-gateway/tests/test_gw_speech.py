"""Оценка произношения — `POST /internal/v1/speech/pronunciation` (спринт 5, INTERNAL_API §1.9, §3.2), провайдер fake.

fake: слова эталона 90, длинные (≥ 8 букв) — 55 и mispronunciation; тишина → insufficient_evidence. Советы ≤ 2 (RU/UZ,
дети — на «ты», без «акцента»), intelligibility; учёт в usage (pronunciation_coach, fake-speech, audio_ms, memory);
вызывающий — только memory; ученик меты = sub/lrn токена; 422 META/AUDIO; тело до 600 000 байт (больше общего
лимита 256 КиБ); идемпотентность request_id; ai_disabled / not_configured / budget_exceeded; аудио и эталон — не в
логах и БД; сага удаления; статус, провайдер и сводка затрат.
"""

from __future__ import annotations

import json
import logging
import uuid

import pytest
from gw_kit import ANALYST, OPERATIONS, PRICING, PUBLISHER, SPEECH_URL, meta_header, speech_meta

from tilhero_ai_gateway.contracts import PronunciationResult
from tilhero_ai_gateway.domain.speech import TIPS, make_tips
from tilhero_ai_gateway.domain.wav import make_wav
from tilhero_common.messaging import make_envelope

REF = "I'd like to book a restaurant table"  # restaurant — 10 букв → 55, mispronunciation
WAV = make_wav(2000)
RESULT_KEYS = {"status", "reason", "reference_text", "scores", "words", "intelligibility", "tips", "confidence",
               "audio_ms", "provider", "cost_usd", "latency_ms"}


async def test_fake_ok_words_tips_and_usage(env) -> None:
    learner = uuid.uuid4()
    meta = speech_meta(learner, reference_text=REF)
    r = await env.speech(WAV, meta)
    assert r.status_code == 200, r.text
    res = r.json()
    PronunciationResult.model_validate(res)
    assert set(res) == RESULT_KEYS
    assert (res["status"], res["reason"], res["provider"], res["audio_ms"], res["cost_usd"]) == (
        "ok", None, "fake_speech", 2000, 0)
    assert [(w["word"], w["accuracy"], w["error_type"]) for w in res["words"]] == [
        ("i'd", 90.0, "none"), ("like", 90.0, "none"), ("to", 90.0, "none"), ("book", 90.0, "none"),
        ("a", 90.0, "none"), ("restaurant", 55.0, "mispronunciation"), ("table", 90.0, "none")]
    assert res["scores"] == {"accuracy": 85.0, "fluency": 90.0, "completeness": 100.0, "pron": 89.0}
    assert res["intelligibility"] == "clear" and res["confidence"] == 0.95 and res["reference_text"] == REF
    assert res["tips"] == [{"word": "restaurant", "text": "Слово «restaurant» прозвучало неразборчиво. "
                                                          "Послушайте образец и повторите медленно."}]
    row = (await env.usage())[-1]
    assert (row["agent_id"], row["model_id"], row["provider"], row["status"], row["reason"], row["caller"],
            row["session_kind"], row["audio_ms"], row["user_id"], row["request_id"], row["version"]) == (
        "pronunciation_coach", "fake-speech", "fake_speech", "ok", None, "memory", "memory", 2000, learner,
        uuid.UUID(meta["request_id"]), None)
    assert (str(row["cost_usd"]), str(row["reserved_usd"]), row["attempts"], row["input_tokens"]) == (
        "0.000000", "0.000000", 1, 0)


async def test_fake_silence_is_insufficient(env) -> None:
    res = (await env.speech(make_wav(1500, amplitude=50))).json()
    assert (res["status"], res["reason"], res["scores"], res["words"], res["tips"], res["intelligibility"]) == (
        "insufficient_evidence", "not_recognized", None, [], [], None)
    PronunciationResult.model_validate(res)
    row = (await env.usage())[-1]
    assert (row["status"], row["reason"], row["audio_ms"]) == ("ok", "not_recognized", 1500)


@pytest.mark.parametrize(("locale", "audience", "claims", "fragment"), [
    ("ru", "kids", {}, "Давай ещё раз скажем слово «restaurant»: послушай"),
    ("ru", "adults", {"age_band": "6-9"}, "послушай образец"),  # ребёнок по claims токена — мягкий вариант
    ("uz", "adults", {}, "«restaurant» soʻzi aniq eshitilmadi. Namunani tinglang"),
    ("uz", "kids", {}, "Kel, «restaurant» soʻzini yana aytamiz"),
    ("ru", "teens", {}, "Послушайте образец"),
])
async def test_tips_locale_and_kids(env, locale, audience, claims, fragment) -> None:
    res = (await env.speech(WAV, speech_meta(reference_text=REF, locale=locale, audience=audience),
                            **claims)).json()
    assert res["status"] == "ok" and len(res["tips"]) == 1 and fragment in res["tips"][0]["text"]


def test_tip_rules() -> None:
    """≤ 2 совета: mispronunciation < 60 и omission, сначала самые низкие; одно слово — один совет; ≥ 60 и
    insertion — без совета; ни в одном шаблоне нет «акцента»."""
    words = [{"word": "table", "accuracy": 58.0, "error_type": "mispronunciation"},
             {"word": "book", "accuracy": 0.0, "error_type": "omission"},
             {"word": "really", "accuracy": None, "error_type": "insertion"},
             {"word": "like", "accuracy": 61.0, "error_type": "mispronunciation"},
             {"word": "Table", "accuracy": 20.0, "error_type": "mispronunciation"},
             {"word": "please", "accuracy": 40.0, "error_type": "mispronunciation"}]
    tips = make_tips(words, "ru", "adults")
    assert [t["word"] for t in tips] == ["book", "Table"]
    assert tips[0]["text"] == "Слово «book» не прозвучало — произнесите фразу целиком."
    assert make_tips([w for w in words if w["error_type"] in ("insertion",) or w["word"] == "like"], "uz",
                     "kids") == []
    for text in TIPS.values():
        assert not any(bad in text.lower() for bad in ("акцент", "aksent", "accent", "ошибк", "xato"))
        assert len(text.format(word="x" * 60)) <= 200


@pytest.mark.parametrize("caller", ["lessons", "assessment", "telegram-bff", "admin-bff"])
async def test_only_memory_may_call(env, caller) -> None:
    r = await env.speech(WAV, caller=caller)
    assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED"
    assert not await env.usage()


async def test_no_token_and_user_context(env) -> None:
    r = await env.c.post(SPEECH_URL, content=WAV, headers={"Content-Type": "audio/wav",
                                                           "X-Speech-Meta": meta_header(speech_meta())})
    assert r.status_code == 401 and r.json()["code"] == "INTERNAL_TOKEN_MISSING"
    meta = speech_meta()
    r = await env.c.post(SPEECH_URL, content=WAV, headers={**env.svc("memory", None), "Content-Type": "audio/wav",
                                                           "X-Speech-Meta": meta_header(meta)})
    assert r.status_code == 401 and r.json()["code"] == "USER_CONTEXT_REQUIRED"
    r = await env.speech(WAV, meta, subject=str(uuid.uuid4()))
    assert r.status_code == 403 and r.json()["code"] == "USER_CONTEXT_MISMATCH"
    # memory с claims ученика: sub — аккаунт, lrn — ученик меты (детский профиль) → допустимо, советы детские
    r = await env.speech(WAV, speech_meta(meta["user_id"], reference_text=REF), subject=str(uuid.uuid4()),
                         lrn=meta["user_id"])
    assert r.status_code == 200 and "послушай" in r.json()["tips"][0]["text"]
    assert len(await env.usage()) == 1


@pytest.mark.parametrize(("raw", "path"), [
    ("", "X-Speech-Meta"),
    ("%%%not-base64%%%", "X-Speech-Meta"),
    (meta_header({"a": 1}).replace("e", "!"), "X-Speech-Meta"),
    ("bm90IGpzb24", "X-Speech-Meta"),  # «not json»
    (None, "language"),
    (None, "reference_text"),
    (None, "extra"),
    (None, "request_id"),
    (None, "audience"),
])
async def test_meta_invalid(env, raw, path) -> None:
    meta = speech_meta()
    if raw is None:
        meta = {"language": {**meta, "language": "en-GB"}, "reference_text": {**meta, "reference_text": "x" * 201},
                "extra": {**meta, "extra": 1}, "request_id": {**meta, "request_id": "r-1"},
                "audience": {**meta, "audience": "babies"}}[path]
    r = await env.speech(WAV, meta, raw_meta=raw, subject=str(meta.get("user_id")))
    assert r.status_code == 422 and r.json()["code"] == "SPEECH_META_INVALID", r.text
    assert any(e["path"].startswith(path) for e in r.json()["details"]["errors"]), r.json()
    assert "x" * 50 not in r.text  # значения в ошибках не возвращаются


async def test_reference_text_with_control_chars_rejected(env) -> None:
    r = await env.speech(WAV, speech_meta(reference_text="Hello‮ world"))
    assert r.status_code == 422 and r.json()["code"] == "SPEECH_META_INVALID"


@pytest.mark.parametrize(("wav", "content_type", "reason"), [
    (b"OggS" + b"\0" * 200, "audio/wav", "format"),
    (make_wav(2000, channels=2), "audio/wav", "format"),
    (make_wav(2000, rate=44_100), "audio/wav", "format"),
    (make_wav(2000, bits=8), "audio/wav", "format"),
    (WAV, "audio/ogg", "format"),
    (WAV, "application/octet-stream", "format"),
    (b"", "audio/wav", "format"),
    (WAV[:44], "audio/wav", "too_short"),
    (make_wav(400), "audio/wav", "too_short"),
    (make_wav(15_200), "audio/wav", "too_long"),
    (make_wav(15_000) + b"\0" * 130_000, "audio/wav", "too_large"),  # > 600 000 байт
])
async def test_audio_invalid(env, wav: bytes, content_type: str, reason: str) -> None:
    r = await env.speech(wav, content_type=content_type)
    assert r.status_code == 422 and r.json()["code"] == "AUDIO_INVALID", r.text
    assert r.json()["details"] == {"reason": reason}
    assert not await env.usage()


async def test_streaming_wav_size_and_limits(env) -> None:
    """15 с (480 КБ — больше общего лимита тела 256 КиБ) принимается; потоковая запись с размером data 0xFFFFFFFF —
    по фактическим байтам; > 600 000 байт — 422 too_large (а не 413 общего лимита)."""
    long = make_wav(15_000)
    assert 256 * 1024 < len(long) <= 600_000
    res = (await env.speech(long, speech_meta(reference_text="Hello"))).json()
    assert res["status"] == "ok" and res["audio_ms"] == 15_000
    streamed = make_wav(1000, data_size_field=0xFFFFFFFF)
    assert (await env.speech(streamed)).json()["audio_ms"] == 1000
    r = await env.speech(long + b"\0" * 200_000)
    assert r.status_code == 422 and r.json()["details"]["reason"] == "too_large"
    # другие маршруты по-прежнему под общим лимитом 256 КиБ
    r = await env.c.post("/internal/v1/agents/teaching_coach/invoke", content=b"{" + b" " * 300_000 + b"}",
                         headers={**env.svc("lessons", str(uuid.uuid4())), "Content-Type": "application/json"})
    assert r.status_code == 413


async def test_idempotent_by_request_id(env) -> None:
    meta = speech_meta(reference_text=REF)
    first = await env.speech(WAV, meta)
    second = await env.speech(WAV, meta)
    assert first.status_code == second.status_code == 200
    assert second.headers.get("idempotent-replay") == "true" and second.json() == first.json()
    assert len(await env.usage()) == 1
    r = await env.speech(make_wav(2100), meta)  # другое аудио с тем же request_id
    assert r.status_code == 422 and r.json()["code"] == "IDEMPOTENCY_KEY_REUSED"
    r = await env.speech(WAV, {**meta, "reference_text": "Hello"})
    assert r.status_code == 422 and r.json()["code"] == "IDEMPOTENCY_KEY_REUSED"
    # результат в кеше — без аудио (только JSON результата)
    keys = [k async for k in env.runtime.redis.scan_iter(match=f"{env.settings.cache_namespace}:speech:*")]
    values = [await env.runtime.redis.get(k) for k in keys if ":user:" not in k]
    assert values and all("RIFF" not in v and json.loads(v)["state"] == "done" for v in values)


async def test_ai_disabled_and_not_configured(env) -> None:
    await env.c.post("/admin/v1/ai/emergency-stop", json={"enabled": True, "reason": "Авария"},
                     headers=env.h(OPERATIONS))
    res = (await env.speech(WAV)).json()
    assert (res["status"], res["reason"], res["provider"], res["cost_usd"], res["words"]) == (
        "unavailable", "ai_disabled", None, 0, [])
    status = (await env.c.get("/internal/v1/status", headers=env.svc("memory"))).json()
    assert status == {"ai_available": False, "speech_available": False}
    await env.c.post("/admin/v1/ai/emergency-stop", json={"enabled": False, "reason": "Снята"},
                     headers=env.h(OPERATIONS))
    # модель речи выключена в админке → not_configured, функция скрыта
    r = await env.c.put("/admin/v1/ai/models/fake-speech", json={
        "input_usd_per_mtok": 0, "output_usd_per_mtok": 0, "audio_usd_per_hour": 0, "active": False,
        "reason": "Выключить речь"}, headers=env.h(PRICING))
    assert r.status_code == 200, r.text
    res = (await env.speech(WAV)).json()
    assert (res["status"], res["reason"]) == ("unavailable", "not_configured")
    assert (await env.c.get("/internal/v1/status", headers=env.svc("memory"))).json()["speech_available"] is False
    rows = await env.usage()
    assert [(x["status"], x["reason"], x["attempts"]) for x in rows] == [
        ("unavailable", "ai_disabled", 0), ("unavailable", "not_configured", 0)]


async def test_budget_by_audio_duration(env) -> None:
    """Стоимость — по длительности: fake-speech за 36 $/ч (0,01 $/с): 2 с = 0,02 $; лимит ученика 0,05 $/день —
    третья запись не помещается (budget_exceeded до вызова провайдера); месячный потолок — speech_available."""
    r = await env.c.put("/admin/v1/ai/models/fake-speech", json={
        "input_usd_per_mtok": 0, "output_usd_per_mtok": 0, "audio_usd_per_hour": 36, "active": True,
        "reason": "Цена в тесте"}, headers=env.h(PRICING))
    assert r.status_code == 200 and r.json()["audio_usd_per_hour"] == 36.0
    learner = uuid.uuid4()
    for _ in range(2):
        res = (await env.speech(WAV, speech_meta(learner))).json()
        assert res["status"] == "ok" and res["cost_usd"] == pytest.approx(0.02)
    res = (await env.speech(WAV, speech_meta(learner))).json()
    assert (res["status"], res["reason"], res["cost_usd"], res["provider"]) == (
        "unavailable", "budget_exceeded", 0, None)
    assert (await env.speech(WAV, speech_meta())).json()["status"] == "ok"  # другой ученик
    rows = await env.usage()
    assert [str(x["cost_usd"]) for x in rows] == ["0.020000", "0.020000", "0.000000", "0.020000"]
    await env.set_budget(monthly_cap_usd=0.06)
    assert (await env.c.get("/internal/v1/status", headers=env.svc("memory"))).json() == {
        "ai_available": True, "speech_available": False}
    assert (await env.speech(WAV, speech_meta())).json()["reason"] == "budget_exceeded"


async def test_speech_prices_rules(env) -> None:
    url = "/admin/v1/ai/models/azure-speech-pa"
    body = {"input_usd_per_mtok": 0, "output_usd_per_mtok": 0, "audio_usd_per_hour": 1.32, "active": True,
            "reason": "Прайс Azure"}
    r = await env.c.put(url, json={**body, "audio_usd_per_hour": 1.0}, headers=env.h(PUBLISHER))
    assert r.status_code == 403 and r.json()["details"]["permission"] == "costs.manage"  # снижение
    r = await env.c.put(url, json={**body, "audio_usd_per_hour": 1.5}, headers=env.h(PUBLISHER))
    assert r.status_code == 200 and r.json()["audio_usd_per_hour"] == 1.5  # повышение — ai.publish
    r = await env.c.put(url, json={**body, "audio_usd_per_hour": 0}, headers=env.h(PRICING))
    assert r.status_code == 422 and r.json()["code"] == "PRICE_REQUIRED"
    r = await env.c.put(url, json={**body, "audio_usd_per_hour": None}, headers=env.h(PRICING))
    assert r.status_code == 422 and r.json()["code"] == "PRICE_REQUIRED"
    r = await env.c.put(url, json={**body, "input_usd_per_mtok": 0.1}, headers=env.h(PRICING))
    assert r.status_code == 422 and r.json()["code"] == "PRICE_NOT_APPLICABLE"
    r = await env.c.put("/admin/v1/ai/models/claude-haiku-5-5", json={
        "input_usd_per_mtok": 0.1, "output_usd_per_mtok": 0.5, "audio_usd_per_hour": 1, "active": True,
        "reason": "Прайс"}, headers=env.h(PRICING))
    assert r.status_code == 422 and r.json()["code"] == "PRICE_NOT_APPLICABLE"
    r = await env.c.put(url, json={k: v for k, v in body.items() if k != "audio_usd_per_hour"},
                        headers=env.h(PRICING))
    assert r.status_code == 200 and r.json()["audio_usd_per_hour"] == 1.5  # не передана — прежняя
    audit = await env.audit("ai.model_updated")
    assert audit[0]["before"]["audio_usd_per_hour"] == "1.3200" and audit[0]["after"]["audio_usd_per_hour"] == "1.5000"


async def test_audio_and_reference_not_in_logs_or_db(env, caplog) -> None:
    caplog.set_level(logging.DEBUG)
    secret_ref = "Zebracorn marmalade sentence"
    wav = make_wav(1200, amplitude=4321)
    res = (await env.speech(wav, speech_meta(reference_text=secret_ref))).json()
    assert res["status"] == "ok"
    text = caplog.text + " ".join(str(getattr(r, "__dict__", "")) for r in caplog.records)
    assert "zebracorn" not in text.lower() and "marmalade" not in text.lower()
    assert "RIFF" not in text and wav[44:80].hex() not in text
    assert any(getattr(r, "audio_ms", None) == 1200 and getattr(r, "status", None) == "ok" for r in caplog.records)
    dump = await env.sql("SELECT string_agg(row_to_json(t)::text, ' ') AS s FROM (SELECT * FROM usage) t")
    outbox = await env.sql("SELECT coalesce(string_agg(envelope::text, ' '), '') AS s FROM outbox")
    for blob in (dump[0]["s"], outbox[0]["s"]):
        assert "zebracorn" not in blob.lower() and "RIFF" not in blob


async def test_deletion_anonymizes_speech_usage_and_cache(env) -> None:
    learner = uuid.uuid4()
    meta = speech_meta(learner, reference_text=REF)
    await env.speech(WAV, meta)
    redis = env.runtime.redis
    assert [k async for k in redis.scan_iter(match=f"{env.settings.cache_namespace}:speech:*{meta['request_id']}")]
    event = make_envelope("user.deletion.requested.v1", {"user_id": str(learner), "request_id": str(uuid.uuid4()),
                                                         "requested_at": "2026-11-19T07:00:00Z"},
                          producer="identity-consent")
    await env.bus.publish(event)
    assert not env.bus.dlq
    assert [r["user_id"] for r in await env.usage()] == [None]
    assert not [k async for k in redis.scan_iter(match=f"{env.settings.cache_namespace}:speech:*")]
    await env.flush()
    assert env.events("user.domain.deleted.v1")[0].payload["domain"] == "ai-gateway"
    # повтор после удаления — новый вызов без идентификатора ученика
    r = await env.speech(WAV, meta)
    assert r.headers.get("idempotent-replay") is None and (await env.usage())[-1]["user_id"] is None


async def test_summary_provider_and_registry(env) -> None:
    r = await env.c.put("/admin/v1/ai/models/fake-speech", json={
        "input_usd_per_mtok": 0, "output_usd_per_mtok": 0, "audio_usd_per_hour": 1.32, "active": True,
        "reason": "Цена в тесте"}, headers=env.h(PRICING))
    assert r.status_code == 200
    await env.speech(make_wav(3000))
    await env.speech(make_wav(1500, amplitude=10))  # insufficient — оплачено, минуты считаются
    await env.ok()
    summary = (await env.c.get("/admin/v1/ai/usage/summary", params={"period": "day"},
                               headers=env.h(OPERATIONS))).json()
    assert summary["speech"] == {"calls": 2, "audio_minutes": round(4500 / 60_000, 2),
                                 "spent_usd": pytest.approx(0.00165), "speech_available": True}
    assert summary["spent_usd"] == pytest.approx(0.00165) and summary["calls"] == 3
    assert {a["agent_id"] for a in summary["by_agent"]} == {"pronunciation_coach", "conversation_partner"}
    assert "fake-speech" in {m["model_id"] for m in summary["by_model"]}
    provider = (await env.c.get("/admin/v1/ai/provider", headers=env.h(ANALYST))).json()
    assert provider["speech"] == {"provider": "fake_speech", "key_configured": False, "region": None,
                                  "last_error": None}
    agents = {a["agent_id"]: a for a in (await env.c.get("/admin/v1/ai/agents", headers=env.h(ANALYST))).json()[
        "items"]}
    assert (agents["pronunciation_coach"]["implementation"], agents["pronunciation_coach"]["availability"],
            agents["pronunciation_coach"]["implemented_in"], agents["pronunciation_coach"]["rollout"],
            agents["pronunciation_coach"]["calls_7d"]) == ("code", "active", "ai-gateway", None, 2)
    assert (agents["spaced_repetition_coach"]["implementation"], agents["spaced_repetition_coach"]["implemented_in"],
            agents["evening_review_coach"]["availability"]) == ("code", "memory", "planned")
