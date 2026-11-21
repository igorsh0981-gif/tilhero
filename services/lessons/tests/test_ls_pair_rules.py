"""Парный урок — правила (INTERNAL_API спринта 7 §0, §3.2, §4): блокировки и санкции (события social), дети — только
семья и выбор реплик, без голоса; коуч недоступен или бюджет комнаты исчерпан — сценарий с выбором; голос — по
согласию; social недоступен — понятная ошибка."""

from __future__ import annotations

import uuid
from datetime import timedelta

from conftest import Env
from ls_testkit import wav


async def test_block_during_invitation_cancels_and_forbids(env: Env) -> None:
    a, b, c = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    env.friends(a, b)
    env.friends(c, b)
    invited = await env.invite(a, b)
    await env.block(b, a)  # заблокировал приглашённый
    assert (await env.c.get(f"/internal/v1/me/pair-rooms/{invited['room_id']}", headers=env.h(a))).json()[
        "status"] == "cancelled"
    assert (await env.room(b, invited["room_id"], "accept", expect=409))["details"]["status"] == "cancelled"
    # новые приглашения — 403 BLOCKED в обе стороны (кто заблокировал — не раскрывается)
    assert (await env.invite(a, b, expect=403))["code"] == "BLOCKED"
    assert (await env.invite(b, a, expect=403))["code"] == "BLOCKED"
    # принятая (waiting) комната тоже отменяется
    waiting = await env.invite(c, b)
    await env.room(b, waiting["room_id"], "accept")
    await env.block(c, b)
    assert (await env.c.get(f"/internal/v1/me/pair-rooms/{waiting['room_id']}", headers=env.h(b))).json()[
        "status"] == "cancelled"
    # снятие блокировки (и устаревшее событие не откатывает новое)
    await env.block(b, a, status="removed")
    room = await env.invite(a, b)
    assert room["status"] == "invited"
    # блокировку видит только social (проекция ещё не пришла) — тоже 403
    d = uuid.uuid4()
    env.friends(d, b)
    env.social.blocks.add((d, b))
    assert (await env.invite(d, b, expect=403))["code"] == "BLOCKED"
    # чужой издатель события блокировки — игнор
    await env.publish("social.block.changed.v1", {"blocker_user_id": str(b), "blocked_user_id": str(a),
                                                  "status": "added", "at": env.now.isoformat()}, "gamification")
    assert (await env.c.get(f"/internal/v1/me/pair-rooms/{room['room_id']}", headers=env.h(a))).json()[
        "status"] == "invited"


async def test_sanction_restricts_invites(env: Env) -> None:
    a, b, c = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    env.friends(a, b)
    env.friends(c, a)
    pending = await env.invite(c, a)  # входящее приглашение санкционированному
    until = env.now + timedelta(days=3)
    sid = await env.ban(a, until)
    r = await env.invite(a, b, expect=403)
    assert r["code"] == "SOCIAL_RESTRICTED" and r["details"]["until"].startswith(until.strftime("%Y-%m-%dT%H:%M"))
    # неотвеченные приглашения ученика отменены; позвать санкционированного — PARTNER_NOT_ALLOWED
    assert (await env.c.get(f"/internal/v1/me/pair-rooms/{pending['room_id']}", headers=env.h(c))).json()[
        "status"] == "cancelled"
    assert (await env.invite(b, a, expect=403))["code"] == "PARTNER_NOT_ALLOWED"
    # бессрочная санкция — until null; снята — можно
    await env.ban(a, None, sanction_id=sid)
    assert (await env.invite(a, b, expect=403))["details"]["until"] is None
    await env.ban(a, None, active=False, sanction_id=sid)
    room = await env.invite(a, b)
    # санкция после приглашения: принять нельзя; идущая комната доигрывается
    await env.ban(b, env.now + timedelta(days=1))
    assert (await env.room(b, room["room_id"], "accept", expect=409))["details"]["status"] == "cancelled"
    e, f = uuid.uuid4(), uuid.uuid4()
    rid = await env.started_room(e, f)
    await env.ban(e, None)
    st = await env.turn(e, rid, {"text": "Hello!"})
    assert st["status"] == "in_progress"
    # санкцию знает только social (relations) — тоже 403 SOCIAL_RESTRICTED
    g = uuid.uuid4()
    env.friends(g, b)
    env.social.restricted[g] = (env.now + timedelta(days=2)).isoformat().replace("+00:00", "Z")
    r = await env.invite(g, b, expect=403)
    assert r["code"] == "SOCIAL_RESTRICTED" and r["details"]["until"].startswith(
        (env.now + timedelta(days=2)).strftime("%Y-%m-%dT%H:%M"))


async def test_teen_without_guardian_consent_only_family(env: Env) -> None:
    """relations *_social_allowed: подросток без согласия родителя — с другом нельзя (403 FRIENDS_NOT_ALLOWED
    {reason: guardian_consent}), с семьёй — можно; партнёр без доступа к друзьям — PARTNER_NOT_ALLOWED."""
    teen, friend, parent = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    env.age[str(teen)] = "14-17"
    env.social.audience[teen] = "teens"
    env.social.social_off.add(teen)
    env.friends(teen, friend)
    env.family(teen, parent)
    r = await env.invite(teen, friend, expect=403)
    assert r["code"] == "FRIENDS_NOT_ALLOWED" and r["details"] == {"reason": "guardian_consent"}
    assert (await env.invite(friend, teen, expect=403))["code"] == "PARTNER_NOT_ALLOWED"
    room = await env.invite(teen, parent)
    assert room["mode"] == "free"


async def test_kids_only_family_only_choices_no_voice(env: Env) -> None:
    kid, parent, friend = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    env.kid(kid)
    env.family(kid, parent)
    env.friends(kid, friend)  # даже если social считает их друзьями — детям только семья
    assert (await env.invite(kid, friend, expect=403))["code"] == "PARTNER_NOT_ALLOWED"
    assert (await env.invite(friend, kid, expect=403))["code"] == "PARTNER_NOT_ALLOWED"
    # сценарий не для детей — 404
    assert (await env.invite(kid, parent, scenario="sc-restaurant-order", expect=404))["code"] == \
        "LESSON_NOT_AVAILABLE"
    room = await env.invite(kid, parent)
    rid = room["room_id"]
    assert room["mode"] == "choices"
    await env.room(parent, rid, "accept")
    env.identity.voice.update({kid, parent})
    await env.room(kid, rid, "join")
    st = await env.room(parent, rid, "join")
    assert st["status"] == "in_progress" and st["ai_degraded"] is False and st["voice_available"] is False
    assert env.ai.coach_calls() == []  # коуча с ребёнком не зовут
    st = await env.state(kid, rid)
    assert st["next_speaker"] == "A" and st["my_role"] == "A" and st["options"]
    assert st["prompt"] and st["prompt_gloss"]
    assert (await env.turn(kid, rid, {"text": "Hello"}, expect=403))["code"] == "KIDS_NOT_ALLOWED"
    r = await env.c.post(f"/internal/v1/me/pair-rooms/{rid}/audio", content=wav(1500),
                         headers={**env.h(kid), "content-type": "audio/wav"})
    assert r.status_code == 403 and r.json()["code"] == "KIDS_NOT_ALLOWED"
    assert env.ai.speech_requests == []
    assert (await env.turn(kid, rid, {"choice_id": "c9"}, expect=422))["code"] == "ANSWER_INVALID"
    while st["status"] == "in_progress":
        speaker = kid if st["next_speaker"] == st["my_role"] else parent
        cur = await env.state(speaker, rid)
        if speaker == parent:
            assert (await env.turn(parent, rid, {"text": "Hi"}, expect=409))["code"] == "FREE_TEXT_NOT_ALLOWED"
        st = await env.turn(speaker, rid, {"choice_id": cur["options"][0]["choice_id"]})
        st = await env.state(kid, rid)
    assert st["status"] == "finished"
    await env.drain()
    assert env.ai.coach_calls() == [] and env.ai.speech_requests == []
    for req in env.assessment.requests:
        assert req["kind"] == "scenario" and req["audience"] in ("kids", "adults")
        assert {t["mode"] for t in req["turns"] if t["speaker"] == "learner"} == {"choice"}
    rep = (await env.c.get(f"/internal/v1/me/pair-rooms/{rid}/report", headers=env.h(kid))).json()
    assert rep["team"]["summary"]["ru"].startswith("Здорово") and rep["me"]["contributed"] is True


async def test_coach_unavailable_falls_back_to_script_choices(env: Env) -> None:
    env.ai.mode["cooperative_lesson_coach"] = "unavailable"
    a, b = uuid.uuid4(), uuid.uuid4()
    rid = await env.started_room(a, b)
    st = await env.state(a, rid)
    assert st["mode"] == "choices" and st["ai_degraded"] is True and st["next_speaker"] == "A"
    assert "mode_changed" in [e["kind"] for e in st["events"]] and st["options"] and st["my_role_brief"]
    assert (await env.turn(a, rid, {"text": "Hello"}, expect=409))["code"] == "FREE_TEXT_NOT_ALLOWED"
    calls = len(env.ai.coach_calls())
    st = await env.turn(a, rid, {"choice_id": st["options"][0]["choice_id"]})
    assert st["next_speaker"] == "B" and len(env.ai.coach_calls()) == calls
    # ответ коуча не по схеме (чужой room_id) — тоже сценарий
    env.ai.mode["cooperative_lesson_coach"] = "wrong_room"
    c, d = uuid.uuid4(), uuid.uuid4()
    rid2 = await env.started_room(c, d)
    assert (await env.state(c, rid2))["mode"] == "choices"


async def test_room_budget_exhausted_switches_to_script(env: Env) -> None:
    a, b = uuid.uuid4(), uuid.uuid4()
    rid = await env.started_room(a, b)
    await env.turn(a, rid, {"text": "Two lattes, please."})
    env.ai.mode["cooperative_lesson_coach"] = "unavailable"  # budget_exceeded: AiBudget.room_cap_usd
    st = await env.turn(b, rid, {"text": "And a croissant."})
    assert st["mode"] == "choices" and st["ai_degraded"] is True and st["next_speaker"] == "A"
    calls = len(env.ai.coach_calls())
    env.ai.mode["cooperative_lesson_coach"] = "ok"  # бюджет комнаты не возвращается: до конца — сценарий
    st = await env.state(a, rid)
    await env.turn(a, rid, {"choice_id": st["options"][0]["choice_id"]})
    assert len(env.ai.coach_calls()) == calls
    rows = await env.sql("SELECT ai_cost_usd, engine FROM pair_rooms WHERE room_id = :r", r=uuid.UUID(rid))
    assert float(rows[0][0]) == 0.02 and rows[0][1] == "script"  # старт + 1 ход (отказ — без стоимости)


async def test_voice_needs_consent_and_is_recognized_once(env: Env) -> None:
    a, b = uuid.uuid4(), uuid.uuid4()
    rid = await env.started_room(a, b)
    audio_url = f"/internal/v1/me/pair-rooms/{rid}/audio"
    h = {**env.h(a), "content-type": "audio/wav"}
    r = await env.c.post(audio_url, content=wav(2000), headers=h)
    assert r.status_code == 403 and r.json()["code"] == "VOICE_CONSENT_REQUIRED" and r.json()["details"] == {
        "who": "self"}
    assert env.ai.speech_requests == []
    env.identity.voice.add(a)
    assert (await env.c.post(audio_url, content=wav(2000), headers={**env.h(b), "content-type": "audio/wav"})
            ).json()["code"] == "NOT_YOUR_TURN"
    for body, reason in ((b"RIFF" + b"\x00" * 60, "format"), (wav(300), "too_short"), (wav(16_000), "too_long"),
                         (b"\x00" * 600_001, "too_large")):
        r = await env.c.post(audio_url, content=body, headers=h)
        assert r.status_code == 422 and r.json()["details"]["reason"] == reason, reason
    r = await env.c.post(audio_url, content=wav(2000, rate=8000), headers=h)
    assert r.json()["details"]["reason"] == "format"
    r = await env.c.post(audio_url, content=wav(14_900), headers=h)  # ~477 КБ — больше общего лимита 256 КиБ
    assert r.status_code == 200, r.text
    rec = r.json()
    assert rec["text"] == env.ai.speech_text and rec["duration_ms"] == 14_900 and rec["audio_id"]
    [meta] = env.ai.speech_requests
    assert meta["room_id"] == rid and meta["user_id"] == str(a) and meta["audience"] == "adults"
    st = await env.turn(a, rid, {"audio_id": rec["audio_id"]})
    assert st["events"][0]["text"] == env.ai.speech_text and st["my_speaking_seconds"] == 15
    rows = await env.sql("SELECT mode FROM room_events WHERE room_id = :r AND kind = 'turn'", r=uuid.UUID(rid))
    assert rows == [("voice",)]
    # повтор audio_id — нет (один раз); голос недоступен — 503
    env.identity.voice.add(b)
    st = await env.state(b, rid)
    assert st["voice_available"] is False  # согласие дано после входа — флаг с момента входа
    assert (await env.turn(b, rid, {"audio_id": rec["audio_id"]}, expect=422))["code"] == "ANSWER_INVALID"
    env.ai.speech_mode = "unavailable"
    r = await env.c.post(audio_url, content=wav(2000), headers={**env.h(b), "content-type": "audio/wav"})
    assert r.status_code == 503 and r.json()["code"] == "SPEECH_UNAVAILABLE"
    env.ai.speech_mode = "ok"
    rec_b = (await env.c.post(audio_url, content=wav(1000), headers={**env.h(b), "content-type": "audio/wav"})).json()
    await env.pass_time(rid, 360, a, b)  # audio_id живёт 5 минут
    assert (await env.turn(b, rid, {"audio_id": rec_b["audio_id"]}, expect=422))["details"]["field"] == "audio_id"
    out = await env.tick()
    assert out["pair_audio_purged"] >= 1
    assert (await env.sql("SELECT count(*) FROM room_audio WHERE room_id = :r", r=uuid.UUID(rid)))[0][0] == 0


async def test_voice_available_with_consent_and_teen_needs_guardian(env: Env) -> None:
    a, b = uuid.uuid4(), uuid.uuid4()
    env.identity.voice.add(a)
    env.identity.bands[b] = "14-17"
    env.age[str(b)] = "14-17"
    env.social.audience[b] = "teens"
    rid = await env.started_room(a, b)
    assert (await env.state(a, rid))["voice_available"] is True
    assert (await env.state(b, rid))["voice_available"] is False
    calls = env.ai.coach_calls()
    assert calls[0]["audience"] == "teens"  # в комнате подросток
    await env.turn(a, rid, {"text": "Hi!"})
    r = await env.c.post(f"/internal/v1/me/pair-rooms/{rid}/audio", content=wav(1000),
                         headers={**env.h(b), "content-type": "audio/wav"})
    assert r.status_code == 403 and r.json()["details"] == {"who": "guardian"}


async def test_social_or_identity_unavailable_gives_clear_errors(env: Env) -> None:
    a, b = uuid.uuid4(), uuid.uuid4()
    env.friends(a, b)
    env.social.down = True
    r = await env.invite(a, b, expect=503)
    assert r["code"] == "UPSTREAM_UNAVAILABLE" and r["details"] == {"service": "social"}
    env.social.down = False
    # member_id не найден (нет ни в проекции, ни у social) — 404; себя — 422; неверный формат — 422
    stranger = uuid.uuid4()
    assert (await env.invite(a, stranger, expect=404))["code"] == "MEMBER_NOT_FOUND"
    env.social.know(a)
    assert (await env.invite(a, a, expect=422))["code"] == "VALIDATION_ERROR"
    for start in ("yesterday", (env.now - timedelta(hours=1)).isoformat(), (env.now + timedelta(days=8)).isoformat()):
        assert (await env.invite(a, b, start=start, expect=422))["code"] == "VALIDATION_ERROR", start
    assert (await env.invite(a, b, pair_id="ru-uz", expect=409))["code"] == "PAIR_NOT_AVAILABLE"
    # учёба при этом работает
    await env.lesson(a)
    # identity недоступен — голос недоступен (503), комната работает
    rid = await env.started_room(a, b, start="now")
    env.identity.down = True
    r = await env.c.post(f"/internal/v1/me/pair-rooms/{rid}/audio", content=wav(1000),
                         headers={**env.h(a), "content-type": "audio/wav"})
    assert r.status_code == 503 and r.json()["code"] == "SPEECH_UNAVAILABLE"
    assert (await env.turn(a, rid, {"text": "Hello"}))["status"] == "in_progress"


async def test_coach_busy_keeps_waiting_and_retries_after_timeout(env: Env) -> None:
    """ai-gateway ещё обрабатывает тот же request_id (409 IDEMPOTENCY_IN_PROGRESS): комната ждёт коуча (никто не
    говорит), повтор вызова — не раньше AI_TIMEOUT_SECONDS + 5 с, с тем же request_id."""
    env.ai.mode["cooperative_lesson_coach"] = "busy"
    a, b = uuid.uuid4(), uuid.uuid4()
    rid = await env.started_room(a, b)
    st = await env.state(a, rid)
    assert st["status"] == "in_progress" and st["next_speaker"] is None and st["options"] is None
    assert (await env.turn(a, rid, {"text": "Hi"}, expect=409))["code"] == "NOT_YOUR_TURN"
    env.ai.mode["cooperative_lesson_coach"] = "ok"
    calls = len(env.ai.coach_calls())
    await env.state(a, rid)
    assert len(env.ai.coach_calls()) == calls  # ещё рано
    await env.pass_time(rid, 26, a, b)
    await env.state(a, rid)  # повтор коуча — фоном (запрос не ждёт ИИ)
    await env.drain()
    st = await env.state(a, rid)
    assert st["next_speaker"] == "A" and st["my_role_brief"]
    ids = {c["request_id"] for c in env.ai.coach_calls()}
    assert len(ids) == 1  # тот же request_id — шлюз вернёт сохранённый ответ, бюджет не тратится дважды


async def test_member_id_format_and_projection_lookup(env: Env) -> None:
    from tilhero_lessons.domain import members

    u = uuid.uuid4()
    mid = members.member_id(u, env.settings.member_key())
    assert mid == env.mid(u) and len(mid) == 25 and members.MEMBER_RE.match(mid)
    # по проекции social.profile.updated.v1 — без вызова social
    a, b = uuid.uuid4(), uuid.uuid4()
    env.friends(a, b)
    await env.nickname(b, "Bobur")
    env.social.calls.clear()
    room = await env.invite(a, b)
    assert room["partner"]["nickname"] == "Bobur"
    assert not [c for c in env.social.calls if "/members/" in c]
    # подменённый member_id (social вернул другого ученика) — 404
    env.social.users.add(uuid.uuid4())
    fake = "mb_" + "A" * 22
    r = await env.c.post("/internal/v1/me/pair-rooms", json={
        "partner_member_id": fake, "pair_id": "ru-en", "scenario_id": "sc-cafe-coffee", "start": "now"},
        headers={**env.h(a), "Idempotency-Key": "fake-member-01"})
    assert r.status_code == 404 and r.json()["code"] == "MEMBER_NOT_FOUND"
