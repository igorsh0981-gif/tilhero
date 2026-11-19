"""Закрытые задания по ключам catalog (AT-44): все типы заданий урока и медиа по реальному сиду, gap_fill без
регистра и концевой пунктуации, точный порядок слов и реплик; ученик не может подменить правильность; без ответа —
неверно; версии контента — из запроса, ключи — только из catalog; идемпотентность по session_id; события;
валидация и права вызывающего."""

from __future__ import annotations

import uuid

from as_testkit import (
    always,
    correct_answer,
    exercises_of,
    lesson,
    lesson_request,
    media_request,
    wrong_answer,
)

from tilhero_common.testing import internal_headers


def by_id(result: dict) -> dict[str, dict]:
    return {i["item_id"]: i for i in result["items"]}


async def test_lesson_all_correct_choices_mode(env, user) -> None:
    r = await env.evaluate(user, lesson_request("l-01-greetings"))
    assert r["status"] == "ok" and r["passed"] is True and r["task_completed"] is True
    assert r["rubric_version"] == "r-kids@1" and r["evaluator"] is None and r["practice_only"] is False
    scores = {s["code"]: s["score"] for s in r["scores"]}
    # выбор реплик: vocabulary — null (не оценивался), task — по исходу, independence — по подсказкам
    assert scores == {"task": 3, "vocabulary": None, "independence": 3}
    rubric = env.catalog.content["rubric"]["r-kids"]
    assert [s["title"] for s in r["scores"]] == [c["title"] for c in rubric["criteria"]]
    items = by_id(r)
    assert set(items) == {f"l-01-c{i}" for i in range(1, 6)}
    assert all(i["correct"] and i["correct_answer"] is None and not i["hinted"] for i in items.values())
    assert items["l-01-c1"]["your_answer"] == "I'm fine, thanks."
    assert items["l-01-c3"]["your_answer"] == "My name is Aziz."
    assert r["key_errors"] == []
    assert r["skill_outcomes"] == [
        {"skill_id": "en.func.greet", "outcome": "demonstrated"},
        {"skill_id": "en.func.introduce", "outcome": "demonstrated"},
        {"skill_id": "en.gram.to-be", "outcome": "demonstrated"},
        {"skill_id": "en.gram.pronouns-possessives", "outcome": "demonstrated"},
    ]
    assert r["requires_human_review"] is False and r["superseded_by"] is None and r["appeal"] is None
    assert env.ai.requests == []  # без свободного текста оценщик не вызывается
    [ev] = await env.events("assessment.completed.v1", user)
    assert ev.payload == {
        "evaluation_id": r["evaluation_id"], "user_id": str(user), "pair_id": "ru-en", "session_id": r["session_id"],
        "kind": "lesson", "skill_outcomes": r["skill_outcomes"], "passed": True, "practice_only": False,
        "supersedes": None, "created_at": ev.payload["created_at"]}


async def test_lesson_wrong_answers_show_key_only_for_errors(env, user) -> None:
    ls = lesson("l-01-greetings")
    wrong = {"l-01-c1", "l-01-c2", "l-01-c3"}
    body = lesson_request("l-01-greetings", policy=lambda i: "wrong" if i["item_id"] in wrong else "correct")
    r = await env.evaluate(user, body)
    items = by_id(r)
    keys = {ci["item_id"]: ci for ci in ls["control_items"]}
    assert items["l-01-c1"] == {"item_id": "l-01-c1", "prompt_en": "Emma: How are you?",
                                "your_answer": "My name is Aziz.", "correct": False, "hinted": False,
                                "correct_answer": "I'm fine, thanks."}
    assert items["l-01-c2"]["your_answer"] == "zzz" and items["l-01-c2"]["correct_answer"] == "am"
    assert items["l-01-c3"]["your_answer"] == "Aziz. is name My"
    assert items["l-01-c3"]["correct_answer"] == " ".join(keys["l-01-c3"]["answer"])
    assert all(items[i]["correct"] and items[i]["correct_answer"] is None for i in ("l-01-c4", "l-01-c5"))
    # ошибки — неверные закрытые задания: ответ ученика (цитата) и верный ответ из ключа, 1–3 для итогов
    assert r["key_errors"] == [
        {"turn_id": "l-01-c1", "evidence": "My name is Aziz.", "correction": "I'm fine, thanks.",
         "error_code": "wrong_choice", "severity": "medium"},
        {"turn_id": "l-01-c2", "evidence": "zzz", "correction": "am", "error_code": "gap_fill", "severity": "medium"},
        {"turn_id": "l-01-c3", "evidence": "Aziz. is name My", "correction": "My name is Aziz.",
         "error_code": "word_order", "severity": "medium"},
    ]
    outcomes = {o["skill_id"]: o["outcome"] for o in r["skill_outcomes"]}
    # en.func.greet: c1 неверно, c4 верно — 1/2 < 2/3 → learning
    assert outcomes == {"en.func.greet": "learning", "en.func.introduce": "learning", "en.gram.to-be": "learning",
                        "en.gram.pronouns-possessives": "demonstrated"}


async def test_gap_fill_ignores_case_spaces_and_trailing_punctuation(env, user) -> None:
    for variant, ok in (("  AM!", True), ("Am.", True), ("am ?!", True), ("am…", True), ("a m", False),
                        ("'am", False), ("is", False)):
        body = lesson_request("l-01-greetings")
        for a in body["answers"]:
            if a["item_id"] == "l-01-c2":
                a["answer"] = variant
        r = await env.evaluate(user, body)
        assert by_id(r)["l-01-c2"]["correct"] is ok, variant


async def test_order_words_exact_order_and_option_indices(env, user) -> None:
    ls = lesson("l-01-greetings")
    c3 = next(ci for ci in ls["control_items"] if ci["item_id"] == "l-01-c3")
    cases = [
        (["My", "name", "is", "Aziz."], True),
        ([c3["options"].index(w) for w in c3["answer"]], True),  # индексы вариантов в правильном порядке
        (["my", "name", "is", "Aziz."], False),  # точный порядок и написание
        (["My", "is", "name", "Aziz."], False),
        (["My", "name", "is"], False),
        ([0, 1, 2, 99], False),
    ]
    for answer, ok in cases:
        body = lesson_request("l-01-greetings")
        for a in body["answers"]:
            if a["item_id"] == "l-01-c3":
                a["answer"] = answer
        r = await env.evaluate(user, body)
        assert by_id(r)["l-01-c3"]["correct"] is ok, answer


async def test_choice_answer_by_index_only_out_of_range_is_wrong(env, user) -> None:
    for answer, ok in ((2, True), ("I'm fine, thanks.", True), (5, False), (-1, False), ("2", False), (True, None)):
        body = lesson_request("l-01-greetings")
        for a in body["answers"]:
            if a["item_id"] == "l-01-c1":
                a["answer"] = answer
        if ok is None:  # bool — не индекс (строгая форма)
            r = await env.c.post("/internal/v1/evaluations", json=body, headers=env.lessons(user))
            assert r.status_code == 422
            continue
        r = await env.evaluate(user, body)
        assert by_id(r)["l-01-c1"]["correct"] is ok, answer


async def test_learner_cannot_substitute_correctness(env, user) -> None:
    body = lesson_request("l-01-greetings", policy=always("wrong"))
    for field in ("correct", "is_correct", "score"):
        tampered = {**body, "answers": [{**a, field: True} for a in body["answers"]]}
        r = await env.c.post("/internal/v1/evaluations", json=tampered, headers=env.lessons(user))
        assert r.status_code == 422 and r.json()["code"] == "VALIDATION_ERROR", field
    tampered = {**body, "passed": True}
    r = await env.c.post("/internal/v1/evaluations", json=tampered, headers=env.lessons(user))
    assert r.status_code == 422
    # без подмены — всё неверно по ключу catalog
    r = await env.evaluate(user, body)
    assert not any(i["correct"] for i in r["items"])
    assert {o["outcome"] for o in r["skill_outcomes"]} == {"learning"}


async def test_unanswered_and_dont_know_are_wrong_without_evidence(env, user) -> None:
    body = lesson_request("l-01-greetings",
                          policy=lambda i: {"l-01-c1": "skip", "l-01-c2": "dont_know"}.get(i["item_id"], "correct"))
    r = await env.evaluate(user, body)
    items = by_id(r)
    for item_id in ("l-01-c1", "l-01-c2"):
        assert items[item_id]["correct"] is False and items[item_id]["your_answer"] is None
        assert items[item_id]["correct_answer"] is not None
    assert r["key_errors"] == []  # без ответа нет цитаты — не «ошибка с доказательством»


async def test_media_all_types_by_seed_keys(env, user) -> None:
    # m-own-hello-song: comprehension, gap_fill, order_lines (рубрика r-kids)
    r = await env.evaluate(user, media_request("m-own-hello-song"))
    assert r["status"] == "ok" and r["passed"] is True and r["rubric_version"] == "r-kids@1"
    # медиа: task — доля верных упражнений, vocabulary — доля верных gap_fill / phrase_meaning
    assert {s["code"]: s["score"] for s in r["scores"]} == {"task": 3, "vocabulary": 3, "independence": 3}
    items = by_id(r)
    assert set(items) == {"mx-hello-song-1", "mx-hello-song-2", "mx-hello-song-3"}
    assert all(i["correct"] for i in items.values())
    assert items["mx-hello-song-3"]["your_answer"].count(" / ") == 3
    assert {o["skill_id"]: o["outcome"] for o in r["skill_outcomes"]} == {
        "en.func.greet": "demonstrated", "en.func.introduce": "demonstrated"}
    # m-own-coffee-order: phrase_meaning; m-own-hotel-reception (r-media): comprehension + vocabulary (gap_fill),
    # произношение по тексту не оценивается
    r = await env.evaluate(user, media_request("m-own-coffee-order", policy=always("wrong")))
    assert not any(i["correct"] for i in r["items"]) and r["passed"] is False
    assert {e["error_code"] for e in r["key_errors"]} <= {"wrong_choice", "gap_fill"}
    r = await env.evaluate(user, media_request("m-own-hotel-reception"))
    assert {s["code"]: s["score"] for s in r["scores"]} == {"comprehension": 3, "vocabulary": 3, "pronunciation": None}
    assert r["status"] == "ok" and r["passed"] is True and r["rubric_version"] == "r-media@1"


async def test_media_order_lines_exact_order(env, user) -> None:
    ex = next(e for e in exercises_of("m-own-hello-song") if e["type"] == "order_lines")
    for answer, ok in ((correct_answer(ex), True), (list(ex["answer"]), True), (wrong_answer(ex), False),
                       (ex["options"], False)):
        body = media_request("m-own-hello-song")
        for a in body["answers"]:
            if a["item_id"] == ex["exercise_id"]:
                a["answer"] = answer
        r = await env.evaluate(user, body)
        assert by_id(r)[ex["exercise_id"]]["correct"] is ok, answer


async def test_review_and_practice_only_have_no_skill_effect(env, user) -> None:
    body = lesson_request("l-01-greetings", kind="review", roleplay=None, turns=[],
                          policy=lambda i: "correct" if i["item_id"] in ("l-01-c1", "l-01-c2") else "skip")
    r = await env.evaluate(user, body)
    assert r["practice_only"] is True and r["skill_outcomes"] == []
    assert set(by_id(r)) == {"l-01-c1", "l-01-c2"}  # повтор — только отвеченные задания
    body = lesson_request("l-01-greetings", practice_only=True)
    r2 = await env.evaluate(user, body)
    assert r2["practice_only"] is True and r2["skill_outcomes"] == []
    events = await env.events("assessment.completed.v1", user)
    assert [(e.payload["practice_only"], e.payload["skill_outcomes"], e.payload["kind"]) for e in events] == [
        (True, [], "review"), (True, [], "lesson")]


async def test_idempotent_by_session_id(env, user) -> None:
    body = lesson_request("l-01-greetings", open_answer="I am Aziz and I like to meet new people.")
    first = await env.evaluate(user, body)
    calls, ai_calls = len(env.catalog.calls), len(env.ai.requests)
    # повтор (другие ответы — неважно): та же оценка, без пересчёта, вызовов ИИ и событий
    again = {**body, "answers": []}
    r = await env.c.post("/internal/v1/evaluations", json=again, headers=env.lessons(user))
    assert r.status_code == 200 and r.headers["idempotent-replayed"] == "true"
    assert r.json() == first
    assert len(env.catalog.calls) == calls and len(env.ai.requests) == ai_calls
    assert len(await env.events("assessment.completed.v1", user)) == 1
    # чужой ученик с той же сессией — конфликт, данные не раскрываются
    r = await env.c.post("/internal/v1/evaluations", json=body, headers=env.lessons(uuid.uuid4()))
    assert r.status_code == 409 and r.json()["code"] == "SESSION_CONFLICT" and "items" not in r.json()["details"]


async def test_content_versions_are_pinned_and_cached(env, user) -> None:
    rubric_v2 = {**env.catalog.content["rubric"]["r-kids"]}
    rubric_v2["pass_rule"] = {"min_weighted": 3.0, "min_per_criterion": 2}
    env.catalog.extra[("rubric", "r-kids", 2)] = rubric_v2
    body = lesson_request("l-01-greetings", roleplay_hints=1)
    body["content_refs"][1]["version"] = 2
    r = await env.evaluate(user, body)
    assert r["rubric_version"] == "r-kids@2" and r["passed"] is False  # independence 2 → weighted < 3
    calls = len(env.catalog.calls)
    body2 = {**body, "session_id": str(uuid.uuid4())}
    await env.evaluate(user, body2)
    assert len(env.catalog.calls) == calls  # версии неизменяемы — кеш бессрочный


async def test_validation_errors(env, user) -> None:
    async def post(body: dict, code: int = 422) -> dict:
        r = await env.c.post("/internal/v1/evaluations", json=body, headers=env.lessons(user))
        assert r.status_code == code, r.text
        return r.json()

    base = lesson_request("l-01-greetings")
    assert (await post({**base, "answers": [*base["answers"], {"item_id": "l-99-c1", "answer": 1}]}))["details"] == {
        "reason": "unknown_item", "item_id": "l-99-c1"}
    assert (await post({**base, "answers": [*base["answers"], base["answers"][0]]}))["code"] == "ANSWERS_INVALID"
    no_rubric = {**base, "content_refs": [r for r in base["content_refs"] if r["kind"] != "rubric"]}
    assert (await post(no_rubric))["code"] == "CONTENT_REFS_INVALID"
    wrong_rubric = {**base, "content_refs": [r if r["kind"] != "rubric" else {**r, "key": "r-lesson-core"}
                                             for r in base["content_refs"]]}
    assert (await post(wrong_rubric))["details"]["reason"] == "rubric_mismatch"
    missing = {**base, "content_refs": [r if r["kind"] != "lesson" else {**r, "version": 7}
                                        for r in base["content_refs"]]}
    assert (await post(missing))["details"] == {"kind": "lesson", "key": "l-01-greetings", "version": 7}
    env.catalog.extra[("lesson", "l-01-greetings", 3)] = lesson("l-01-greetings")
    env.catalog.statuses[("lesson", "l-01-greetings", 3)] = "draft"
    draft = {**base, "content_refs": [r if r["kind"] != "lesson" else {**r, "version": 3}
                                      for r in base["content_refs"]]}
    assert (await post(draft))["code"] == "CONTENT_REF_INVALID"
    assert (await post({**base, "roleplay": {"outcome": "victory", "hints": 0}}))["code"] == "VALIDATION_ERROR"
    assert (await post({**base, "user_id": str(uuid.uuid4())}))["code"] == "USER_MISMATCH"
    assert (await post({**base, "kind": "scenario"}))["code"] == "CONTENT_REFS_INVALID"
    media = media_request("m-own-hello-song")
    assert (await post({**media, "roleplay": {"outcome": "success", "hints": 0}}))["code"] == "TURNS_INVALID"
    assert (await post({**base, "turns": [*base["turns"], base["turns"][0]]}))["code"] == "TURNS_INVALID"
    env.catalog.down = True
    assert (await post({**base, "session_id": str(uuid.uuid4()),
                        "content_refs": [{"kind": "lesson", "key": "l-02-where-from", "version": 1},
                                         {"kind": "rubric", "key": "r-kids", "version": 1}],
                        "answers": [], "turns": [], "roleplay": None}, 503))["code"] == "CATALOG_UNAVAILABLE"
    env.catalog.down = False
    # словарная форма ссылок (как content_versions сессии lessons) тоже принимается; пустые — пропускаются
    as_map = {**base, "content_refs": {"lesson": {"key": "l-01-greetings", "version": 1},
                                       "scenario": {"key": "sc-meet-greetings", "version": 1},
                                       "rubric": {"key": "r-kids", "version": 1}, "media_asset": None,
                                       "media_exercises": []},
              "turns": [{**t, "mode": t.get("mode") or "choice"} for t in base["turns"]]}
    assert (await env.evaluate(user, as_map))["status"] == "ok"
    media_map = media_request("m-own-hello-song")
    media_map["content_refs"] = {
        "lesson": None, "scenario": None, "rubric": {"key": "r-kids", "version": 1},
        "media_asset": {"key": "m-own-hello-song", "version": 1},
        "media_exercises": [{"key": r["key"], "version": 1} for r in media_map["content_refs"]
                            if r["kind"] == "media_exercise"]}
    assert (await env.evaluate(user, media_map))["passed"] is True
    assert await env.events("assessment.completed.v1", user) and env.bus.dlq == []


async def test_caller_and_user_context(env, user) -> None:
    body = lesson_request("l-01-greetings")
    r = await env.c.post("/internal/v1/evaluations", json=body)
    assert r.status_code == 401
    r = await env.c.post("/internal/v1/evaluations", json=body, headers=env.lessons(user, issuer="telegram-bff"))
    assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED"
    r = await env.c.post("/internal/v1/evaluations", json=body, headers=env.lessons(None))
    assert r.status_code == 401 and r.json()["code"] == "USER_CONTEXT_REQUIRED"
    r = await env.c.post("/internal/v1/evaluations", json=body,
                         headers=internal_headers(env.settings, issuer="lessons", subject="not-a-uuid"))
    assert r.status_code == 401 and r.json()["code"] == "USER_CONTEXT_INVALID"
