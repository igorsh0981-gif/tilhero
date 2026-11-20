"""Спринт 5, admin API словаря курса (INTERNAL_API §2.5, admin.ts): список и очередь переводов ИИ, карточка с историей,
создание (FORM_TAKEN), правка с If-Match (428 / 409), override только у course, решение по переводу ИИ (NOT_PENDING),
архив только статей методиста, права в домене, аудит glossary.entry_*, события, неизменяемость истории в БД."""

from __future__ import annotations

import uuid
from typing import Any

import asyncpg
import pytest
import ts_contract as ts
from catalog_kit import DASHBOARD, GLOSSARIST, GLOSSARIST2, READER, SUPPORT, L
from test_catalog_glossary import AI, CHANGED, LOOKUP, ai_body, entries, ref

from tilhero_common.testing import assert_event_conforms

URL = "/admin/v1/glossary"
ROW_FIELDS = set(ts.fields("admin.ts", "GlossaryRow")) | {"updated_by"}
DETAIL_FIELDS = set(ts.fields("admin.ts", "GlossaryDetail"))


def new_entry(lemma: str = "barista", **kw: Any) -> dict[str, Any]:
    body: dict[str, Any] = {"pair_id": "ru-en", "lemma": lemma, "forms": [lemma], "part_of_speech": "noun",
                            "gloss": L("бариста", "barista"), "example_en": "The barista is nice.",
                            "reason": "Нужна статья для текста"}
    body.update(kw)
    return body


async def create(env, actor=GLOSSARIST, **kw: Any):
    return await env.c.post(URL, json=new_entry(**kw), headers=env.h(actor))


async def ai_pending(env, surface: str = "office") -> dict[str, Any]:
    r = await env.c.post(AI, json=ai_body(surface), headers=env.memory())
    assert r.status_code == 201, r.text
    return dict(r.json())


async def patch(env, entry: dict[str, Any], body: dict[str, Any], actor=GLOSSARIST, if_match: str | None = "auto"):
    headers = env.h(actor)
    if if_match == "auto":
        headers["If-Match"] = f'"{entry["updated_at"]}"'
    elif if_match is not None:
        headers["If-Match"] = if_match
    return await env.c.patch(f"{URL}/{entry['entry_id']}", json=body, headers=headers)


# ---------------------------------------------------------------- список, карточка, счётчики


async def test_list_filters_queue_and_pagination(env) -> None:
    r = await env.c.get(URL, params={"pair_id": "ru-en", "source": "course"}, headers=env.h(READER))
    assert r.status_code == 200, r.text
    page = r.json()
    assert len(page["items"]) == 19 and set(page["items"][0]) == ROW_FIELDS
    lemmas = [i["lemma"] for i in page["items"]]
    assert lemmas == sorted(lemmas, key=str.lower)
    first = (await env.c.get(URL, params={"limit": 5}, headers=env.h(READER))).json()
    second = (await env.c.get(URL, params={"limit": 5, "cursor": first["next_cursor"]}, headers=env.h(READER))).json()
    assert len(first["items"]) == 5 and {i["entry_id"] for i in first["items"]}.isdisjoint(
        {i["entry_id"] for i in second["items"]})
    q = (await env.c.get(URL, params={"q": "здравств"}, headers=env.h(READER))).json()["items"]
    assert [i["lemma"] for i in q] == ["hello"]
    q = (await env.c.get(URL, params={"q": "meet"}, headers=env.h(READER))).json()["items"]
    assert [i["lemma"] for i in q] == ["nice to meet you"]
    # очередь переводов ИИ — по числу мест в контенте
    b = await ai_pending(env, "usually")
    a = await ai_pending(env, "milk")
    r = await env.c.post(AI, json=ai_body("milk", content=ref("reading", "r-a0-my-cat", locator="s6")),
                         headers=env.memory())
    assert r.status_code == 200 and len(r.json()["refs"]) == 2  # новое место в контенте, перевод тот же
    queue = (await env.c.get(URL, params={"review_status": "pending"}, headers=env.h(READER))).json()
    assert [i["entry_id"] for i in queue["items"]] == [a["entry_id"], b["entry_id"]]
    assert [i["refs_count"] for i in queue["items"]] == [2, 1]
    assert all(i["source"] == "ai" and i["confidence"] == 0.9 for i in queue["items"])
    q1 = (await env.c.get(URL, params={"review_status": "pending", "limit": 1}, headers=env.h(READER))).json()
    q2 = (await env.c.get(URL, params={"review_status": "pending", "limit": 1, "cursor": q1["next_cursor"]},
                          headers=env.h(READER))).json()
    assert [i["entry_id"] for i in q1["items"] + q2["items"]] == [a["entry_id"], b["entry_id"]]
    assert q2["next_cursor"] is None
    assert (await env.c.get(URL, params={"cursor": "%%%"}, headers=env.h(READER))).status_code == 400
    assert (await env.c.get(URL, params={"source": "robot"}, headers=env.h(READER))).status_code == 422


async def test_detail_and_stats(env) -> None:
    hello = (await entries(env, "hello"))["hello"]
    r = await env.c.get(f"{URL}/{hello['entry_id']}", headers=env.h(READER))
    assert r.status_code == 200
    d = r.json()
    assert set(d) == DETAIL_FIELDS
    assert set(d["history"][0]) == {"at", "by", "by_name", "action", "before", "after", "reason"}
    assert (await env.c.get(f"{URL}/{uuid.uuid4()}", headers=env.h(READER))).status_code == 404
    assert (await env.c.get(f"{URL}/not-a-uuid", headers=env.h(READER))).status_code == 422
    await ai_pending(env)
    s = await env.c.get(f"{URL}/stats", headers=env.h(DASHBOARD))
    assert s.status_code == 200
    assert s.json() == {"pair_id": None, "ai_glosses_pending": 1, "ai_approved": 0, "ai_rejected": 0,
                        "entries": {"course": 19, "methodist": 0, "ai": 1}, "overridden": 0}
    assert (await env.c.get(f"{URL}/stats", params={"pair_id": "ru-uz"}, headers=env.h(READER))).json()[
        "ai_glosses_pending"] == 0
    assert (await env.c.get(f"{URL}/stats", headers=env.h(SUPPORT))).status_code == 403


async def test_permissions_and_callers(env) -> None:
    hello = (await entries(env, "hello"))["hello"]
    assert (await env.c.get(URL)).status_code == 401
    assert (await env.c.get(URL, headers=env.svc("memory"))).json()["code"] == "CALLER_NOT_ALLOWED"
    assert (await env.c.get(URL, headers=env.h(None))).json()["code"] == "STAFF_CONTEXT_REQUIRED"
    r = await env.c.get(URL, headers=env.h(SUPPORT))
    assert r.status_code == 403 and r.json()["details"] == {"permission": "content.read"}
    r = await env.c.get(f"{URL}/{hello['entry_id']}", headers=env.h(DASHBOARD))
    assert r.status_code == 403
    for method, path, body in (("post", URL, new_entry()),
                               ("patch", f"{URL}/{hello['entry_id']}", {"override": None}),
                               ("post", f"{URL}/{hello['entry_id']}/review", {"decision": "approve"}),
                               ("delete", f"{URL}/{hello['entry_id']}", {"reason": "Удалить"})):
        r = await env.c.request(method.upper(), path, json=body, headers=env.h(READER))
        assert r.status_code == 403 and r.json()["details"] == {"permission": "glossary.manage"}, path
    # content_manager тоже управляет словарём
    assert (await create(env, GLOSSARIST2)).status_code == 201


# ---------------------------------------------------------------- создание


async def test_create_methodist_entry_audit_event(env) -> None:
    r = await create(env, forms=["Barista", "baristas", "barista!"])
    assert r.status_code == 201, r.text
    d = r.json()
    assert set(d) == DETAIL_FIELDS
    assert (d["source"], d["review_status"], d["forms"], d["refs"], d["updated_by"]) == (
        "methodist", "not_required", ["barista", "baristas"], [], GLOSSARIST.id)
    assert d["history"][0]["action"] == "created" and d["history"][0]["reason"] == "Нужна статья для текста"
    [audit] = await env.audit("glossary.entry_created")
    assert audit["actor_id"] == GLOSSARIST.id and audit["object_type"] == "glossary_entry"
    assert audit["object_id"] == d["entry_id"] and "бариста" not in str(audit)
    for e in env.events("admin.audit.recorded.v1"):
        assert_event_conforms(e)
    [event] = [e.payload for e in env.events(CHANGED)]
    assert event["change"] == "created" and event["forms"] == ["barista", "baristas"]
    # статья видна в поиске memory
    r = await env.c.post(LOOKUP, json={"pair_id": "ru-en", "text": "barista", "content_ref": ref(locator="s3")},
                         headers=env.memory())
    assert r.json()["entry"]["entry_id"] == d["entry_id"]


async def test_create_form_taken_and_validation(env) -> None:
    hello = (await entries(env, "hello"))["hello"]
    r = await create(env, lemma="hi", forms=["hi", "Hello!"])
    assert r.status_code == 409 and r.json()["code"] == "FORM_TAKEN"
    assert r.json()["details"] == {"entry_id": hello["entry_id"], "form": "hello"}
    pending = await ai_pending(env, "office")
    r = await create(env, lemma="office", forms=["office"])
    assert r.status_code == 409 and r.json()["details"]["entry_id"] == pending["entry_id"]  # на проверке — не уступает
    bad = [
        new_entry(pair_id="xx-yy"),
        new_entry(forms=["..."]),
        new_entry(forms=["бариста"]),
        new_entry(gloss=L("бариста", "бариста")),
        new_entry(gloss=L("бариста", "o'qituvchi")),
    ]
    for body in bad:
        r = await env.c.post(URL, json=body, headers=env.h(GLOSSARIST))
        assert r.status_code == 422 and r.json()["code"] == "GLOSSARY_INVALID", body
    for body in (new_entry(forms=[]), new_entry(forms=[f"f{i}" for i in range(9)]), new_entry(lemma="x" * 61),
                 new_entry(gloss=L("x" * 81, "y")), new_entry(extra=1), new_entry(part_of_speech="noun phrase")):
        assert (await env.c.post(URL, json=body, headers=env.h(GLOSSARIST))).status_code == 422, body


async def test_create_replaces_rejected_ai_entry(env) -> None:
    ai = await ai_pending(env, "office")
    r = await env.c.post(f"{URL}/{ai['entry_id']}/review", json={"decision": "reject"}, headers=env.h(GLOSSARIST))
    assert r.status_code == 200
    r = await create(env, lemma="office", forms=["office", "offices"], gloss=L("офис", "ofis"))
    assert r.status_code == 201, r.text
    old = (await env.c.get(f"{URL}/{ai['entry_id']}", headers=env.h(READER))).json()
    assert old["archived_at"] is not None and old["history"][0]["action"] == "archived"
    body = (await env.c.post(LOOKUP, json={"pair_id": "ru-en", "text": "office", "content_ref": ref()},
                             headers=env.memory())).json()
    assert body["rejected"] is False and body["entry"]["gloss"] == L("офис", "ofis")


async def test_create_idempotency(env) -> None:
    headers = {**env.h(GLOSSARIST), "Idempotency-Key": "glossary-create-1"}
    first = await env.c.post(URL, json=new_entry(), headers=headers)
    again = await env.c.post(URL, json=new_entry(), headers=headers)
    assert first.status_code == again.status_code == 201
    assert again.headers.get("idempotent-replay") == "true" and again.json()["entry_id"] == first.json()["entry_id"]
    plain = await env.c.post(URL, json=new_entry(), headers=env.h(GLOSSARIST))
    assert plain.status_code == 409 and plain.json()["code"] == "FORM_TAKEN"


# ---------------------------------------------------------------- правка


async def test_patch_methodist_fields_if_match(env) -> None:
    d = (await create(env)).json()
    r = await patch(env, d, {"gloss": L("бариста (кофе)", "barista")}, if_match=None)
    assert r.status_code == 428 and r.json()["code"] == "IF_MATCH_REQUIRED"
    r = await patch(env, d, {"gloss": L("бариста (кофе)", "barista")}, if_match='"2020-01-01T00:00:00.000Z"')
    assert r.status_code == 409 and r.json()["code"] == "VERSION_CONFLICT"
    assert r.json()["details"] == {"updated_at": d["updated_at"]}
    r = await patch(env, d, {"gloss": L("бариста (кофе)", "barista"), "forms": ["barista", "baristas"],
                             "reason": "Уточнение"})
    assert r.status_code == 200, r.text
    d2 = r.json()
    assert d2["gloss"] == L("бариста (кофе)", "barista") and d2["forms"] == ["barista", "baristas"]
    assert d2["updated_at"] > d["updated_at"]
    assert d2["history"][0]["action"] == "updated" and d2["history"][0]["before"] == {
        "forms": ["barista"], "gloss": L("бариста", "barista")}
    # старый If-Match больше не подходит (W/ и кавычки понимаются)
    r = await patch(env, d, {"lemma": "barista!"}, if_match=f'W/"{d["updated_at"]}"')
    assert r.status_code == 409
    # без изменений — та же версия
    same = await patch(env, d2, {"lemma": "barista"})
    assert same.status_code == 200 and same.json()["updated_at"] == d2["updated_at"]
    [audit] = await env.audit("glossary.entry_updated")
    assert audit["after"]["fields"] == ["forms", "gloss"]
    events = [e.payload for e in env.events(CHANGED) if e.payload["change"] == "updated"]
    assert events and events[-1]["forms"] == ["barista", "baristas"]
    # освобождённая форма снова доступна
    r = await patch(env, d2, {"forms": ["barista"]})
    assert r.status_code == 200
    assert (await create(env, lemma="baristas", forms=["baristas"])).status_code == 201


async def test_patch_rules(env) -> None:
    d = (await create(env)).json()
    hello = (await entries(env, "hello"))["hello"]
    r = await patch(env, d, {"forms": ["barista", "hello"]})
    assert r.status_code == 409 and r.json()["code"] == "FORM_TAKEN"
    r = await patch(env, d, {"override": {"gloss": L("x", "y"), "example_en": None}})
    assert r.status_code == 422 and r.json()["details"]["errors"][0]["code"] == "OVERRIDE_COURSE_ONLY"
    r = await patch(env, d, {"gloss": None})
    assert r.status_code == 422 and r.json()["details"]["errors"][0]["code"] == "VALUE_REQUIRED"
    r = await patch(env, d, {"part_of_speech": None, "example_en": None})
    assert r.status_code == 200 and r.json()["part_of_speech"] is None and r.json()["example_en"] is None
    # ai — правка полей
    ai = await ai_pending(env)
    r = await patch(env, ai, {"gloss": L("офис", "ofis")})
    assert r.status_code == 200 and r.json()["review_status"] == "pending"
    # course — только override
    r = await patch(env, hello, {"gloss": L("привет", "salom")})
    assert r.status_code == 422 and r.json()["details"]["errors"][0]["code"] == "COURSE_ENTRY_LOCKED"
    assert (await patch(env, {"entry_id": str(uuid.uuid4()), "updated_at": "x"}, {"lemma": "a"})).status_code == 404


async def test_override_course_entry(env) -> None:
    hello = (await entries(env, "hello"))["hello"]
    r = await patch(env, hello, {"override": {"gloss": L("привет!", "salom!"), "example_en": "Hello there!"},
                                 "reason": "Точнее"})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["gloss"] == L("привет!", "salom!") and d["example_en"] == "Hello there!"
    assert d["override"]["by"] == GLOSSARIST.id and d["override"]["gloss"] == L("привет!", "salom!")
    assert d["history"][0]["action"] == "overridden" and d["conflicts"] == [
        {"ref": ref("lesson", "l-01-greetings"), "gloss": L("привет, здравствуйте", "salom")}]
    row = (await env.c.get(URL, params={"q": "hello", "source": "course"}, headers=env.h(READER))).json()["items"][0]
    assert row["overridden"] is True and row["gloss"] == L("привет!", "salom!")
    # перевод для ученика (lookup) — действующий
    body = (await env.c.post(LOOKUP, json={"pair_id": "ru-en", "text": "hello",
                                           "content_ref": ref("lesson", "l-01-greetings")},
                             headers=env.memory())).json()
    assert body["entry"]["gloss"] == L("привет!", "salom!")
    # снять override
    r = await patch(env, d, {"override": None})
    assert r.status_code == 200 and r.json()["override"] is None
    assert r.json()["gloss"] == L("привет, здравствуйте", "salom") and r.json()["example_en"] == "Hello, I'm Sam."
    assert [h["action"] for h in r.json()["history"]][:2] == ["overridden", "overridden"]
    stats = (await env.c.get(f"{URL}/stats", headers=env.h(READER))).json()
    assert stats["overridden"] == 0


# ---------------------------------------------------------------- решение по переводу ИИ


async def test_review_approve_correct_reject(env) -> None:
    a, b, c = await ai_pending(env, "office"), await ai_pending(env, "usually"), await ai_pending(env, "milk")
    r = await env.c.post(f"{URL}/{a['entry_id']}/review", json={"decision": "approve"}, headers=env.h(GLOSSARIST))
    assert r.status_code == 200 and r.json()["review_status"] == "approved" and r.json()["corrected"] is False
    r = await env.c.post(f"{URL}/{b['entry_id']}/review", json={"decision": "correct"}, headers=env.h(GLOSSARIST))
    assert r.status_code == 422
    r = await env.c.post(f"{URL}/{b['entry_id']}/review",
                         json={"decision": "correct", "gloss": L("обычно", "odatda"), "note": "Исправлено"},
                         headers=env.h(GLOSSARIST))
    assert r.status_code == 200, r.text
    assert (r.json()["review_status"], r.json()["corrected"], r.json()["gloss"]) == (
        "approved", True, L("обычно", "odatda"))
    assert r.json()["history"][0]["action"] == "reviewed" and r.json()["history"][0]["reason"] == "Исправлено"
    # исправление сразу видно ученикам
    body = (await env.c.post(LOOKUP, json={"pair_id": "ru-en", "text": "usually", "content_ref": ref()},
                             headers=env.memory())).json()
    assert body["entry"]["gloss"] == L("обычно", "odatda")
    r = await env.c.post(f"{URL}/{c['entry_id']}/review", json={"decision": "reject"}, headers=env.h(GLOSSARIST))
    assert r.status_code == 200 and r.json()["review_status"] == "rejected"
    # повтор решения / не ai — 409 NOT_PENDING
    for entry_id in (a["entry_id"], c["entry_id"], (await entries(env, "hello"))["hello"]["entry_id"]):
        r = await env.c.post(f"{URL}/{entry_id}/review", json={"decision": "approve"}, headers=env.h(GLOSSARIST))
        assert r.status_code == 409 and r.json()["code"] == "NOT_PENDING", entry_id
    audits = await env.audit("glossary.entry_reviewed")
    assert sorted(x["after"]["decision"] for x in audits) == ["approve", "correct", "reject"]
    events = [e.payload for e in env.events(CHANGED) if e.payload["change"] == "reviewed"]
    assert len(events) == 3
    for e in env.events(CHANGED):
        assert_event_conforms(e)
    stats = (await env.c.get(f"{URL}/stats", headers=env.h(READER))).json()
    assert (stats["ai_glosses_pending"], stats["ai_approved"], stats["ai_rejected"]) == (0, 2, 1)


# ---------------------------------------------------------------- архив


async def test_archive_only_methodist(env) -> None:
    d = (await create(env)).json()
    hello = (await entries(env, "hello"))["hello"]
    ai = await ai_pending(env)
    for entry_id in (hello["entry_id"], ai["entry_id"]):
        r = await env.c.request("DELETE", f"{URL}/{entry_id}", json={"reason": "Лишняя статья"},
                                headers=env.h(GLOSSARIST))
        assert r.status_code == 409 and r.json()["code"] == "ARCHIVE_NOT_ALLOWED", entry_id
    r = await env.c.request("DELETE", f"{URL}/{d['entry_id']}", json={"reason": "Лишняя статья"},
                            headers=env.h(GLOSSARIST))
    assert r.status_code == 204
    again = await env.c.request("DELETE", f"{URL}/{d['entry_id']}", json={"reason": "Лишняя статья"},
                                headers=env.h(GLOSSARIST))
    assert again.status_code == 204
    assert len(await env.audit("glossary.entry_archived")) == 1
    archived = (await env.c.get(f"{URL}/{d['entry_id']}", headers=env.h(READER))).json()
    assert archived["archived_at"] is not None
    assert (await patch(env, archived, {"lemma": "x"})).json()["code"] == "ENTRY_ARCHIVED"
    # форма свободна; в списке — только с archived=true
    assert (await entries(env, "barista"))["barista"] is None
    listed = (await env.c.get(URL, params={"archived": "true"}, headers=env.h(READER))).json()["items"]
    assert [i["entry_id"] for i in listed] == [d["entry_id"]]
    assert (await create(env)).status_code == 201
    r = await env.c.request("DELETE", f"{URL}/{d['entry_id']}", json={}, headers=env.h(GLOSSARIST))
    assert r.status_code == 422


# ---------------------------------------------------------------- неизменяемость истории (БД)


async def test_history_is_append_only(env) -> None:
    await create(env)
    for stmt in ("UPDATE glossary_history SET reason = 'x'", "DELETE FROM glossary_history",
                 "TRUNCATE glossary_history"):
        with pytest.raises(asyncpg.PostgresError):
            await env.sql(stmt)
    rows = await env.sql("SELECT count(*) AS n FROM glossary_history")
    assert rows[0]["n"] >= 20
    # форма не может принадлежать двум статьям (защита в глубину)
    with pytest.raises(asyncpg.UniqueViolationError):
        await env.sql("INSERT INTO glossary_forms (pair_id, form_key, form, entry_id) "
                      "SELECT pair_id, form_key, form, entry_id FROM glossary_forms LIMIT 1")
