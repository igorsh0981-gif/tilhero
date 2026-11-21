"""Контрактные тесты спринта 7: вызовы коуча и распознавания принимает ai-gateway (модели ai.ts), запрос оценки
участника — модель assessment (kind scenario, без правильности), события — схемы packages/contracts."""

from __future__ import annotations

import base64
import json
import re
import uuid

import pytest
from conftest import Env
from ls_testkit import wav


async def test_coach_speech_and_evaluation_requests_match_contracts(env: Env) -> None:
    internal = pytest.importorskip("tilhero_ai_gateway.api.internal")
    contracts = pytest.importorskip("tilhero_ai_gateway.contracts")
    schemas = pytest.importorskip("tilhero_assessment.schemas")
    a, b = uuid.uuid4(), uuid.uuid4()
    env.identity.voice.add(a)
    rid = await env.started_room(a, b)
    rec = (await env.c.post(f"/internal/v1/me/pair-rooms/{rid}/audio", content=wav(1200),
                            headers={**env.h(a), "content-type": "audio/wav"})).json()
    await env.turn(a, rid, {"audio_id": rec["audio_id"]})
    await env.turn(b, rid, {"text": "Hello, I'm Bob. My phone is +998 90 123 45 67"})
    await env.pass_time(rid, 80, a, b)
    await env.state(b, rid)  # молчание A → trigger silence (фоном)
    await env.drain()
    await env.turn(a, rid, {"text": "Nice to meet you!"})
    st = await env.turn(b, rid, {"text": "Bye!"})
    assert st["status"] == "finished"
    await env.drain()
    triggers = []
    for req in env.ai.coach_calls():
        body = {k: v for k, v in req.items() if k != "agent"}
        internal.InvokeIn.model_validate(body)
        contracts.CooperativeCoachContext.model_validate(body["context"])
        # ревью 🟢14: коучу — только английский текст сценария (русского в *_en нет)
        assert not re.search("[А-Яа-яЁё]", json.dumps(body["context"]["scenario"], ensure_ascii=False))
        triggers.append(body["context"]["trigger"])
        out = env.ai._coach(body)  # заглушка отвечает по ai.ts
        contracts.CooperativeCoachOutput.model_validate(out)
    assert triggers[0] == "start" and "silence" in triggers and "turn" in triggers
    flags = [r["context"]["safety_flags"] for r in env.ai.coach_calls() if r["context"]["trigger"] == "turn"]
    assert ["personal_data"] in flags  # телефон в реплике — флаг для коуча
    [speech] = env.ai.speech_requests
    contracts.SpeechTranscribeMeta.model_validate({k: speech[k] for k in ("request_id", "user_id", "room_id",
                                                                          "audience", "language")})
    assert speech["content_type"] == "audio/wav" and speech["bytes"] == len(wav(1200))
    assert len(env.assessment.requests) == 2
    for req in env.assessment.requests:
        schemas.EvaluationRequestIn.model_validate(req)
        assert req["practice_only"] is False and req["answers"] == []
    voice_req = next(r for r in env.assessment.requests if r["user_id"] == str(a))
    assert [t["mode"] for t in voice_req["turns"] if t["speaker"] == "learner"] == ["text", "text"]  # голос → text
    for event_type in ("lesson.pair.invited.v1", "lesson.pair.completed.v1", "lesson.session.completed.v1"):
        assert await env.events(event_type)  # assert_event_conforms внутри


def test_wav_helper_matches_header_limits() -> None:
    data = wav(15_000)
    assert len(data) <= 600_000 and data[:4] == b"RIFF"
    raw = base64.urlsafe_b64encode(json.dumps({"x": 1}).encode()).decode().rstrip("=")
    assert json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4))) == {"x": 1}
