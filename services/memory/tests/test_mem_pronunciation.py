"""Произношение (INTERNAL_API §1.9, AT-58): согласие self / guardian / нет, речь недоступна, плохой WAV, эталон —
только сервер, попытка без аудио; аудио не попадает ни в логи, ни в БД."""

from __future__ import annotations

import logging
import uuid
from typing import Any

from mem_testkit import wav

from tilhero_common.internal_auth import HEADER


async def pron(env: Any, user: uuid.UUID, target: str, body: bytes, *, target_kind: str | None = None,
               ctype: str = "audio/wav", **hk: Any) -> Any:
    params = {"target": target}
    if target_kind:
        params["target_kind"] = target_kind
    return await env.c.post("/internal/v1/pronunciation", params=params, content=body,
                            headers={**env.h(user, **hk), "content-type": ctype})


async def first_card(env: Any, user: uuid.UUID, text: str = "Nice to meet you.") -> str:
    await env.lesson_done(user)
    [(cid,)] = await env.sql("SELECT card_id FROM cards WHERE user_id = :u AND text_en = :t", u=user, t=text)
    return str(cid)


async def test_card_with_own_consent(env, user: uuid.UUID, caplog) -> None:  # type: ignore[no-untyped-def]
    env.identity.set(user, voice=True)
    cid = await first_card(env, user)
    audio = wav(2.0)
    caplog.set_level(logging.DEBUG)
    r = await pron(env, user, cid, audio, target_kind="card")
    assert r.status_code == 200, r.text
    view = r.json()
    assert view["status"] == "ok" and view["reference_text"] == "Nice to meet you." and view["score"] == 87.5
    assert view["intelligibility"] == "clear" and view["message"] is None and view["attempt_id"]
    assert [w["word"] for w in view["words"]] == ["Nice", "to", "meet", "you"]
    assert set(view) == {"attempt_id", "status", "reference_text", "intelligibility", "score", "words", "tips",
                         "message"}
    [meta] = env.ai.speech
    assert meta["bytes"] == len(audio)
    assert meta["meta"]["reference_text"] == "Nice to meet you." and meta["meta"]["language"] == "en-US"
    assert meta["meta"]["user_id"] == str(user) and meta["meta"]["audience"] == "adults"
    # аудио нигде не сохранено: попытка — только баллы
    rows = await env.sql("SELECT * FROM pronunciation_attempts WHERE user_id = :u", u=user)
    assert len(rows) == 1 and all(not isinstance(v, bytes | bytearray | memoryview) for v in rows[0])
    [(audio_ms, target)] = await env.sql("SELECT audio_ms, target FROM pronunciation_attempts")
    assert audio_ms == 2000 and target == {"kind": "card", "ref": cid}
    sample = audio[44:60]
    for rec in caplog.records:
        text = rec.getMessage() + str(rec.__dict__)
        assert sample.hex() not in text and str(sample) not in text and "RIFF" not in text
    detail = await env.get(user, f"cards/{cid}")
    assert detail["last_pronunciation"]["intelligibility"] == "clear"
    # bff.ts форма цели: card:<id>
    assert (await pron(env, user, f"card:{cid}", audio)).status_code == 200


async def test_sentence_targets(env, user: uuid.UUID) -> None:  # type: ignore[no-untyped-def]
    env.identity.set(user, voice=True)
    ok = [("sentence:reading:r-a1-coffee:1:s3", "The barista is friendly and always smiles."),
          ("sentence:lesson:l-01-greetings:1:ex:1", "Hi, Aziz! I'm Emma. Nice to meet you."),
          ("sentence:lesson:l-01-greetings:1:kw:3", "My name is"),
          ("sentence:media_asset:m-own-coffee-order:1:0", None)]
    for target, ref in ok:
        r = await pron(env, user, target, wav(1.0))
        assert r.status_code == 200, (target, r.text)
        if ref:
            assert r.json()["reference_text"] == ref
    r = await pron(env, user, "reading:r-a1-coffee:1:s3", wav(1.0), target_kind="sentence")
    assert r.status_code == 200
    long = r.json()
    assert [t["word"] for t in long["tips"]] == ["friendly"]  # fake-речь: слово ≥ 8 букв — 55 и совет
    for target in ("sentence:reading:r-a1-coffee:1:s9", "sentence:reading:r-a1-coffee:5:s1",
                   "sentence:course:x:1:s1", "sentence:reading:r-a1-coffee:1"):
        r = await pron(env, user, target, wav(1.0))
        assert r.status_code == 404 and r.json()["code"] == "CONTENT_NOT_FOUND", target


async def test_consent_self_guardian_and_child(env) -> None:  # type: ignore[no-untyped-def]
    adult, teen, child, parent = uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    target = "sentence:reading:r-a1-coffee:1:s1"
    env.identity.set(adult)
    r = await pron(env, adult, target, wav())
    assert r.status_code == 403 and r.json()["details"] == {"who": "self"}
    assert (await env.get(adult, "overview"))["pronunciation"] == "consent_self"
    env.identity.set(teen, age_band="14-17", guardian_consent="pending")
    r = await pron(env, teen, target, wav(), age_band="14-17")
    assert r.status_code == 403 and r.json()["details"] == {"who": "guardian"}
    assert (await env.get(teen, "overview", age_band="14-17"))["pronunciation"] == "consent_guardian"
    env.identity.set(child, age_band="6-9", kind="child")
    r = await pron(env, child, "sentence:reading:r-kids-cat:1:s1", wav(), account=parent)
    assert r.status_code == 403 and r.json()["code"] == "VOICE_CONSENT_REQUIRED" and r.json()["details"]["who"] == \
        "guardian"
    env.identity.set(child, age_band="6-9", kind="child", voice=True)  # родитель включил запись голоса ребёнку
    r = await pron(env, child, "sentence:reading:r-kids-cat:1:s2", wav(), account=parent)
    assert r.status_code == 200 and env.ai.speech[-1]["meta"]["audience"] == "kids"
    # детям — только детский контент: эталон из взрослого текста «не существует»
    r = await pron(env, child, target, wav(), account=parent)
    assert r.status_code == 404 and r.json()["code"] == "CONTENT_NOT_FOUND"
    assert (await env.get(child, "overview", account=parent))["pronunciation"] == "available"
    env.identity.down = True
    r = await pron(env, adult, target, wav())
    assert r.status_code == 503 and r.json()["code"] == "SPEECH_UNAVAILABLE"
    assert (await env.get(adult, "overview"))["pronunciation"] == "unavailable"
    assert len(env.ai.speech) == 1  # без согласия аудио дальше не уходит


async def test_speech_unavailable_and_results(env, user: uuid.UUID) -> None:  # type: ignore[no-untyped-def]
    env.identity.set(user, voice=True)
    target = "sentence:reading:r-a1-coffee:1:s1"
    env.ai.status["speech_available"] = False
    r = await pron(env, user, target, wav())
    assert r.status_code == 503 and r.json()["code"] == "SPEECH_UNAVAILABLE"
    assert (await env.get(user, "overview"))["pronunciation"] == "unavailable"
    env.ai.status["speech_available"] = True
    env.ai.status_down = True
    assert (await pron(env, user, target, wav())).status_code == 503
    env.ai.status_down = False
    quiet = await pron(env, user, target, wav(amplitude=50))
    assert quiet.status_code == 200 and quiet.json()["status"] == "insufficient_evidence"
    assert quiet.json()["score"] is None and quiet.json()["message"]["ru"].startswith("Не удалось оценить")
    env.ai.speech_mode = "unavailable"
    res = (await pron(env, user, target, wav())).json()
    assert res["status"] == "unavailable" and res["attempt_id"] is None and res["message"]["ru"] == "Сейчас недоступно"
    env.ai.speech_mode = "error"
    assert (await pron(env, user, target, wav())).json()["status"] == "unavailable"
    rows = await env.sql("SELECT status FROM pronunciation_attempts WHERE user_id = :u", u=user)
    assert rows == [("insufficient_evidence",)]
    env.ai.speech_mode = "ok"
    res = (await pron(env, user, "sentence:lesson:l-13-flight-check-in:1:ex:0", wav())).json()
    long_words = [w for w in res["words"] if w["error_type"] == "mispronunciation"]
    assert len(res["tips"]) == min(2, len(long_words))


async def test_bad_audio(env, user: uuid.UUID) -> None:  # type: ignore[no-untyped-def]
    env.identity.set(user, voice=True)
    target = "sentence:reading:r-a1-coffee:1:s1"
    cases = [(b"not a wav at all" * 10, "format"), (wav(rate=8000), "format"), (wav(channels=2), "format"),
             (wav(bits=8), "format"), (wav(fmt=3), "format"), (wav(0.3), "too_short"), (wav(15.5), "too_long"),
             (wav(1.0)[:30], "format")]
    for body, reason in cases:
        r = await pron(env, user, target, body)
        assert r.status_code == 422 and r.json()["code"] == "AUDIO_INVALID", reason
        assert r.json()["details"] == {"reason": reason}
    r = await pron(env, user, target, b"\0" * 600_001)
    assert r.status_code == 422 and r.json()["details"] == {"reason": "too_large"}
    r = await pron(env, user, target, wav(), ctype="audio/mpeg")
    assert r.status_code == 422 and r.json()["details"] == {"reason": "format"}
    assert (await pron(env, user, target, wav(14.9))).status_code == 200  # ~477 КБ — больше общего лимита 256 КиБ
    assert len(env.ai.speech) == 1


async def test_foreign_card_and_auth(env, user: uuid.UUID) -> None:  # type: ignore[no-untyped-def]
    env.identity.set(user, voice=True)
    cid = await first_card(env, user)
    intruder = uuid.uuid4()
    env.identity.set(intruder, voice=True)
    r = await pron(env, intruder, cid, wav(), target_kind="card")
    assert r.status_code == 404 and r.json()["code"] == "CARD_NOT_FOUND"
    r = await pron(env, user, "not-a-uuid", wav(), target_kind="card")
    assert r.status_code == 404
    r = await env.c.post("/internal/v1/pronunciation", params={"target": f"card:{cid}"}, content=wav(),
                         headers={"content-type": "audio/wav"})
    assert r.status_code == 401
    r = await env.c.post("/internal/v1/pronunciation", params={"target": f"card:{cid}"}, content=wav(),
                         headers={HEADER: env.h(user, issuer="admin-bff")[HEADER], "content-type": "audio/wav"})
    assert r.status_code == 403
    assert env.ai.speech == []
