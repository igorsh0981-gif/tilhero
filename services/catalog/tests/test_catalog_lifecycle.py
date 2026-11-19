"""Жизненный цикл версий контента через admin API (AT-26, AT-27, AT-28): черновик → проверка → публикация → архив,
откат, SELF_REVIEW, DRAFT_EXISTS, VERSION_CONFLICT, права, вызывающие, идемпотентность, аудит и события."""

from __future__ import annotations

import asyncio
import uuid

import asyncpg
import ts_contract as ts
from catalog_kit import (
    CONTENT_MANAGER,
    DASHBOARD,
    EDITOR2,
    METHODIST,
    PUBLISHER,
    READER,
    REVIEWER,
    SUPPORT,
    codes,
    lesson,
    paths,
    rubric,
    scenario,
    skill,
)
from sqlalchemy.engine import make_url

from tilhero_catalog.domain.versions import GRAPH_LOCK_CLASS
from tilhero_common.internal_auth import Actor
from tilhero_common.testing import TEST_ADMIN_URL, assert_event_conforms

PUBLISHED = "catalog.version.published.v1"


# ---------------------------------------------------------------- создание, доступ


async def test_create_draft_happy_path_and_audit(env) -> None:
    r = await env.create("skill", skill("en.func.thanks"))
    assert r.status_code == 201, r.text
    v = r.json()
    assert set(v) == set(ts.fields("admin.ts", "ContentVersion"))
    assert (v["kind"], v["key"], v["version"], v["status"]) == ("skill", "en.func.thanks", 1, "draft")
    assert v["author_id"] == CONTENT_MANAGER.id and v["author_name"] is None
    assert v["locale_checks"] == {"ru": "draft", "uz": "draft"} and len(v["payload_hash"]) == 64
    assert v["test_run"] is None and v["published_at"] is None
    [audit] = await env.audit("content.version_created")
    assert audit["actor_id"] == CONTENT_MANAGER.id and audit["object_id"] == "skill:en.func.thanks@1"
    assert "title" not in str(audit["after"])  # без текстов контента
    for e in env.events("admin.audit.recorded.v1"):
        assert_event_conforms(e)


async def test_auth_and_callers(env) -> None:
    url, body = "/admin/v1/content/skill", {"payload": skill("en.x1")}
    assert (await env.c.post(url, json=body)).json()["code"] == "INTERNAL_TOKEN_MISSING"
    r = await env.c.post(url, json=body, headers={"x-internal-token": "garbage"})
    assert r.status_code == 401 and r.json()["code"] == "INTERNAL_TOKEN_INVALID"
    r = await env.c.post(url, json=body, headers=env.svc("telegram-bff"))
    assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED"
    r = await env.c.post(url, json=body, headers=env.h(None))
    assert r.status_code == 403 and r.json()["code"] == "STAFF_CONTEXT_REQUIRED"
    r = await env.c.post(url, json=body, headers=env.h(READER))
    assert r.status_code == 403 and r.json()["details"] == {"permission": "content.edit"}
    r = await env.c.get(url, headers=env.h(SUPPORT))
    assert r.status_code == 403 and r.json()["details"] == {"permission": "content.read"}
    # чужая аудитория токена
    r = await env.c.get(url, headers=env.svc("admin-bff") | {})
    assert r.status_code == 403


async def test_unknown_kind_key_and_version(env) -> None:
    r = await env.c.get("/admin/v1/content/poem", headers=env.h(READER))
    assert r.status_code == 404 and r.json()["code"] == "CONTENT_KIND_UNKNOWN"
    r = await env.c.get("/admin/v1/content/lesson/l-nope", headers=env.h(READER))
    assert r.status_code == 404 and r.json()["code"] == "CONTENT_NOT_FOUND"
    r = await env.c.get("/admin/v1/content/lesson/Bad%20Key", headers=env.h(READER))
    assert r.status_code == 404
    r = await env.c.get("/admin/v1/content/lesson/l-01-greetings/versions/9", headers=env.h(READER))
    assert r.status_code == 404 and r.json()["code"] == "VERSION_NOT_FOUND"
    r = await env.act("lesson", "l-nope", 1, "submit", CONTENT_MANAGER)
    assert r.status_code == 404 and r.json()["code"] == "CONTENT_NOT_FOUND"


async def test_create_schema_errors_and_key_exists(env) -> None:
    bad = lesson("l-new")
    bad["duration_min"] = 25
    bad["unknown"] = True
    r = await env.create("lesson", bad)
    assert r.status_code == 422 and r.json()["code"] == "CONTENT_INVALID"
    assert {"payload.duration_min", "payload.unknown"} <= set(paths(r, "SCHEMA_INVALID"))
    r = await env.c.post("/admin/v1/content/lesson", json={"payload": lesson("l-x"), "extra": 1},
                         headers=env.h(CONTENT_MANAGER))
    assert r.status_code == 422 and r.json()["code"] == "VALIDATION_ERROR"
    r = await env.create("lesson", lesson("l-01-greetings"))
    assert r.status_code == 409 and r.json()["code"] == "CONTENT_KEY_EXISTS"


async def test_create_idempotency(env) -> None:
    key = {"Idempotency-Key": "create-skill-0001"}
    first = await env.create("skill", skill("en.func.idem"), **key)
    again = await env.create("skill", skill("en.func.idem"), **key)
    assert first.status_code == again.status_code == 201
    assert again.headers.get("idempotent-replay") == "true" and again.json() == first.json()
    other = await env.create("skill", skill("en.func.other"), **key)
    assert other.status_code == 422 and other.json()["code"] == "IDEMPOTENCY_KEY_REUSED"
    assert len(await env.audit("content.version_created")) == 1


# ---------------------------------------------------------------- списки


async def test_list_filters_and_pagination(env) -> None:
    draft = skill("en.zz.draft", level="B1")
    draft["title"] = {"ru": "Черновик навыка", "uz": "Koʻnikma qoralamasi"}
    await env.create("skill", draft)
    r = await env.c.get("/admin/v1/content/skill", params={"limit": 2}, headers=env.h(READER))
    assert r.status_code == 200
    page = r.json()
    assert len(page["items"]) == 2 and page["next_cursor"]
    assert set(page["items"][0]) == set(ts.fields("admin.ts", "ContentRow")) | {"updated_by"}
    seen = [i["key"] for i in page["items"]]
    while page["next_cursor"]:
        page = (await env.c.get("/admin/v1/content/skill", params={"limit": 2, "cursor": page["next_cursor"]},
                                headers=env.h(READER))).json()
        seen += [i["key"] for i in page["items"]]
    assert seen == sorted(seen) and len(seen) == 4
    drafts = (await env.c.get("/admin/v1/content/skill", params={"status": "draft"}, headers=env.h(READER))).json()
    assert [i["key"] for i in drafts["items"]] == ["en.zz.draft"]
    assert drafts["items"][0]["published_version"] is None and drafts["items"][0]["level"] == "B1"
    pub = (await env.c.get("/admin/v1/content/skill", params={"status": "published"}, headers=env.h(READER))).json()
    assert len(pub["items"]) == 3
    a0 = (await env.c.get("/admin/v1/content/skill", params={"level": "A0"}, headers=env.h(READER))).json()
    assert {i["key"] for i in a0["items"]} == {"en.func.greet", "en.gram.to-be"}
    q = (await env.c.get("/admin/v1/content/skill", params={"q": "напит"}, headers=env.h(READER))).json()
    assert [i["key"] for i in q["items"]] == ["en.func.order-drink"]
    q = (await env.c.get("/admin/v1/content/skill", params={"q": "100%_"}, headers=env.h(READER))).json()
    assert q["items"] == []
    r = await env.c.get("/admin/v1/content/skill", params={"cursor": "!!!"}, headers=env.h(READER))
    assert r.status_code == 400 and r.json()["code"] == "INVALID_CURSOR"
    r = await env.c.get("/admin/v1/content/skill", params={"status": "bogus"}, headers=env.h(READER))
    assert r.status_code == 422


async def test_card_with_versions(env) -> None:
    r = await env.c.get("/admin/v1/content/lesson/l-07-coffee", headers=env.h(READER))
    assert r.status_code == 200
    body = r.json()
    assert body["row"]["published_version"] == 1 and body["row"]["latest_status"] == "published"
    [meta] = body["versions"]
    assert set(meta) == set(ts.fields("admin.ts", "ContentVersionMeta"))
    assert meta["locale_checks"] == {"ru": "checked", "uz": "checked"}


# ---------------------------------------------------------------- правка черновика


async def test_update_draft_conflicts_and_key_change(env) -> None:
    v = (await env.create("skill", skill("en.func.edit"))).json()
    changed = {**v["payload"], "level": "A2"}
    r = await env.put("skill", "en.func.edit", 1, changed, v["payload_hash"], EDITOR2)
    assert r.status_code == 200 and r.json()["payload"]["level"] == "A2"
    new_hash = r.json()["payload_hash"]
    assert new_hash != v["payload_hash"]
    stale = await env.put("skill", "en.func.edit", 1, {**changed, "level": "B1"}, v["payload_hash"])
    assert stale.status_code == 409 and stale.json()["code"] == "VERSION_CONFLICT"
    assert stale.json()["details"] == {"payload_hash": new_hash}
    renamed = await env.put("skill", "en.func.edit", 1, {**changed, "skill_id": "en.func.renamed"}, new_hash)
    assert renamed.status_code == 422 and codes(renamed) == ["KEY_CHANGED"]
    same = await env.put("skill", "en.func.edit", 1, changed, new_hash)
    assert same.status_code == 200 and same.json()["payload_hash"] == new_hash
    assert len(await env.audit("content.version_updated")) == 1  # повтор без изменений — не правка
    # правивший черновик (EDITOR2) тоже не может его проверять
    assert (await env.submit("skill", "en.func.edit", 1)).status_code == 200
    r = await env.approve("skill", "en.func.edit", 1, Actor(id=EDITOR2.id, role="methodist",
                                                           permissions=frozenset({"content.review"})))
    assert r.status_code == 409 and r.json()["code"] == "SELF_REVIEW"
    r = await env.put("skill", "en.func.edit", 1, changed, new_hash)
    assert r.status_code == 409 and r.json()["code"] == "VERSION_NOT_DRAFT"


# ---------------------------------------------------------------- отправка и проверка (AT-27)


async def test_submit_runs_business_rules(env) -> None:
    p = lesson("l-bad")
    p["control_items"] = p["control_items"][:1]
    p["title"]["uz"] = ""
    p["stages"][4]["minutes"] = 9
    p["primary_skill_id"] = "en.func.ghost"
    assert (await env.create("lesson", p)).status_code == 201
    r = await env.submit("lesson", "l-bad", 1)
    assert r.status_code == 422 and r.json()["code"] == "CONTENT_INVALID"
    found = set(codes(r))
    assert {"NO_CONTROL_ITEMS", "LOCALE_MISSING", "STAGES_INVALID", "UNKNOWN_REF"} <= found
    assert "payload.title.uz" in paths(r, "LOCALE_MISSING")
    v = await env.get_version("lesson", "l-bad", 1)
    assert v["status"] == "draft" and v["locale_checks"]["uz"] == "missing"
    rub = rubric("r-empty")
    rub["criteria"] = []
    await env.create("rubric", rub)
    r = await env.submit("rubric", "r-empty", 1)
    assert r.status_code == 422 and {"COUNT_OUT_OF_RANGE", "RUBRIC_WEIGHTS"} <= set(codes(r))


async def test_review_rules(env) -> None:
    await env.create("skill", skill("en.func.rev"), METHODIST)
    r = await env.approve("skill", "en.func.rev", 1)
    assert r.status_code == 409 and r.json()["code"] == "VERSION_NOT_IN_REVIEW"
    assert (await env.submit("skill", "en.func.rev", 1, METHODIST)).status_code == 200
    again = await env.submit("skill", "en.func.rev", 1, METHODIST)
    assert again.status_code == 409 and again.json()["code"] == "VERSION_NOT_DRAFT"
    r = await env.approve("skill", "en.func.rev", 1, METHODIST)  # автор
    assert r.status_code == 409 and r.json()["code"] == "SELF_REVIEW"
    r = await env.approve("skill", "en.func.rev", 1, CONTENT_MANAGER)  # нет content.review
    assert r.status_code == 403 and r.json()["details"] == {"permission": "content.review"}
    r = await env.act("skill", "en.func.rev", 1, "review", REVIEWER,
                      {"decision": "approve", "note": "ok ok", "locale_checks": {"ru": "checked", "uz": "draft"}})
    assert r.status_code == 422 and codes(r) == ["LOCALE_NOT_CHECKED"]
    r = await env.act("skill", "en.func.rev", 1, "review", REVIEWER,
                      {"decision": "approve", "note": "x", "locale_checks": {"ru": "checked", "uz": "checked"}})
    assert r.status_code == 422  # заметка 3..1000
    r = await env.act("skill", "en.func.rev", 1, "review", REVIEWER,
                      {"decision": "return", "note": "Уточните описание",
                       "locale_checks": {"ru": "checked", "uz": "draft"}})
    assert r.status_code == 200
    v = r.json()
    assert v["status"] == "draft" and v["reviewer_id"] == REVIEWER.id and v["review_note"] == "Уточните описание"
    assert v["locale_checks"] == {"ru": "checked", "uz": "draft"}
    assert len(await env.audit("content.returned")) == 1
    await env.submit("skill", "en.func.rev", 1, METHODIST)
    r = await env.approve("skill", "en.func.rev", 1)
    assert r.status_code == 200 and r.json()["status"] == "approved"
    assert r.json()["locale_checks"] == {"ru": "checked", "uz": "checked"}
    assert len(await env.audit("content.reviewed")) == 1


async def test_review_queue_excludes_own(env) -> None:
    await env.create("skill", skill("en.func.q1"), METHODIST)
    await env.submit("skill", "en.func.q1", 1, METHODIST)
    await env.create("rubric", rubric("r-q2"), CONTENT_MANAGER)
    await env.submit("rubric", "r-q2", 1, CONTENT_MANAGER)
    mine = (await env.c.get("/admin/v1/content/review-queue", headers=env.h(METHODIST))).json()
    assert [(i["kind"], i["key"]) for i in mine["items"]] == [("rubric", "r-q2")]
    other = (await env.c.get("/admin/v1/content/review-queue", headers=env.h(REVIEWER))).json()
    assert [(i["kind"], i["key"]) for i in other["items"]] == [("skill", "en.func.q1"), ("rubric", "r-q2")]
    assert other["items"][0]["latest_status"] == "in_review"
    only = (await env.c.get("/admin/v1/content/review-queue", params={"kind": "rubric", "limit": 1},
                            headers=env.h(REVIEWER))).json()
    assert [i["key"] for i in only["items"]] == ["r-q2"] and only["next_cursor"] is None
    page = (await env.c.get("/admin/v1/content/review-queue", params={"limit": 1}, headers=env.h(REVIEWER))).json()
    assert page["next_cursor"]
    nxt = (await env.c.get("/admin/v1/content/review-queue", params={"limit": 1, "cursor": page["next_cursor"]},
                           headers=env.h(REVIEWER))).json()
    assert [i["key"] for i in nxt["items"]] == ["r-q2"]
    r = await env.c.get("/admin/v1/content/review-queue", headers=env.h(READER))
    assert r.status_code == 403


# ---------------------------------------------------------------- публикация (AT-26)


async def test_publish_flow_event_audit_and_noop(env) -> None:
    version = await env.to_approved("skill", skill("en.func.pub"))
    r = await env.publish("skill", "en.func.pub", version, CONTENT_MANAGER)
    assert r.status_code == 403 and r.json()["details"] == {"permission": "content.publish"}
    r = await env.publish("skill", "en.func.pub", version, **{"Idempotency-Key": "publish-0001"})
    assert r.status_code == 200, r.text
    v = r.json()
    assert v["status"] == "published" and v["published_by"] == PUBLISHER.id and v["published_at"]
    replay = await env.publish("skill", "en.func.pub", version, **{"Idempotency-Key": "publish-0001"})
    assert replay.headers.get("idempotent-replay") == "true" and replay.json() == v
    noop = await env.publish("skill", "en.func.pub", version)
    assert noop.status_code == 200 and noop.json()["status"] == "published"
    await env.flush()
    [event] = env.events(PUBLISHED)
    assert_event_conforms(event)
    assert event.payload == {"kind": "skill", "key": "en.func.pub", "version": 1, "previous_version": None,
                             "action": "published", "course_id": "en-core", "published_by": PUBLISHER.id,
                             "published_at": v["published_at"]}
    [audit] = await env.audit("content.published")
    assert audit["reason"] == "Публикация в тесте" and audit["after"]["published_version"] == 1


async def test_publish_requires_approved_and_integrity(env) -> None:
    await env.create("skill", skill("en.func.dep"))
    r = await env.publish("skill", "en.func.dep", 1)
    assert r.status_code == 409 and r.json()["code"] == "VERSION_NOT_APPROVED"
    # урок ссылается на навык-черновик: на проверку можно (ключ существует), опубликовать — нет
    p = lesson("l-dep")
    p["secondary_skill_ids"] = ["en.func.dep"]
    version = await env.to_approved("lesson", p)
    r = await env.publish("lesson", "l-dep", version)
    assert r.status_code == 422 and paths(r, "UNKNOWN_REF") == ["payload.secondary_skill_ids[0]"]
    dry = await env.act("lesson", "l-dep", version, "validate", READER)
    assert dry.status_code == 200 and dry.json()["ok"] is False
    assert [e["code"] for e in dry.json()["errors"]] == ["UNKNOWN_REF"]
    await env.published_new("skill", skill("en.func.dep2"))
    p2 = lesson("l-dep2")
    p2["secondary_skill_ids"] = ["en.func.dep2"]
    await env.published_new("lesson", p2)


async def test_validate_dry_run(env) -> None:
    r = await env.act("lesson", "l-07-coffee", 1, "validate", READER)
    assert r.json() == {"ok": True, "errors": []}
    await env.create("rubric", rubric("r-dry"))
    r = await env.act("rubric", "r-dry", 1, "validate", READER)
    assert r.json()["ok"] is False and {e["code"] for e in r.json()["errors"]} == {"LOCALE_NOT_CHECKED"}
    r = await env.act("rubric", "r-dry", 1, "validate", SUPPORT)
    assert r.status_code == 403


async def test_new_version_republish_and_immutability(env) -> None:
    r = await env.new_version("lesson", "l-01-greetings", 1)
    assert r.status_code == 201, r.text
    draft = r.json()
    assert (draft["version"], draft["status"], draft["author_id"]) == (2, "draft", CONTENT_MANAGER.id)
    dup = await env.new_version("lesson", "l-01-greetings", 1, EDITOR2)
    assert dup.status_code == 409 and dup.json()["code"] == "DRAFT_EXISTS" and dup.json()["details"] == {"version": 2}
    r = await env.new_version("lesson", "l-01-greetings", 7)
    assert r.status_code == 404 and r.json()["code"] == "VERSION_NOT_FOUND"
    # опубликованная версия не правится
    published = await env.get_version("lesson", "l-01-greetings", 1)
    r = await env.put("lesson", "l-01-greetings", 1, published["payload"], published["payload_hash"])
    assert r.status_code == 409 and r.json()["code"] == "VERSION_NOT_DRAFT"
    payload = {**draft["payload"], "hints": [{"ru": "Новая подсказка", "uz": "Yangi maslahat"}]}
    r = await env.put("lesson", "l-01-greetings", 2, payload, draft["payload_hash"])
    assert r.status_code == 200
    await env.to_approved("lesson", payload, version=2)
    r = await env.publish("lesson", "l-01-greetings", 2)
    assert r.status_code == 200
    v1 = await env.get_version("lesson", "l-01-greetings", 1)
    assert v1["status"] == "archived" and v1["archived_at"] and v1["payload"] == published["payload"]
    await env.flush()
    [event] = [e for e in env.events(PUBLISHED) if e.payload["key"] == "l-01-greetings"]
    payload = event.payload
    assert (payload["version"], payload["previous_version"], payload["course_id"]) == (2, 1, "en-core")
    card = (await env.c.get("/admin/v1/content/lesson/l-01-greetings", headers=env.h(READER))).json()
    assert [m["status"] for m in card["versions"]] == ["published", "archived"]


async def test_publish_supersedes_older_approved(env) -> None:
    v1 = await env.published_new("rubric", rubric("r-sup"))
    v2 = await env.edit_published("rubric", "r-sup", v1, {"pass_rule": {"min_weighted": 2.0, "min_per_criterion": 1}})
    v3 = await env.edit_published("rubric", "r-sup", v1, {"pass_rule": {"min_weighted": 2.5, "min_per_criterion": 1}})
    assert (await env.publish("rubric", "r-sup", v3)).status_code == 200
    assert (await env.get_version("rubric", "r-sup", v2))["status"] == "archived"
    r = await env.publish("rubric", "r-sup", v2)
    assert r.status_code == 409 and r.json()["code"] == "VERSION_NOT_APPROVED"


# ---------------------------------------------------------------- снятие с публикации и откат


async def test_archive_in_use_and_unused(env) -> None:
    r = await env.c.post("/admin/v1/content/skill/en.func.greet/archive", json={"reason": "Убрать навык"},
                         headers=env.h(PUBLISHER))
    assert r.status_code == 409 and r.json()["code"] == "CONTENT_IN_USE"
    refs = r.json()["details"]["refs"]
    assert {"kind": "lesson", "key": "l-01-greetings"} in refs
    assert {"kind": "skill", "key": "en.func.order-drink"} in refs
    r = await env.c.post("/admin/v1/content/course/en-core/archive", json={"reason": "Снять курс"},
                         headers=env.h(PUBLISHER))
    assert r.status_code == 409 and r.json()["details"]["refs"] == [{"kind": "language_pair", "key": "ru-en"}]
    await env.published_new("skill", skill("en.func.lonely"))
    r = await env.c.post("/admin/v1/content/skill/en.func.lonely/archive", json={"reason": "Не нужен"},
                         headers=env.h(PUBLISHER))
    assert r.status_code == 200, r.text
    row = r.json()["row"]
    assert row["published_version"] is None and row["latest_status"] == "archived"
    again = await env.c.post("/admin/v1/content/skill/en.func.lonely/archive", json={"reason": "Не нужен"},
                             headers=env.h(PUBLISHER))
    assert again.status_code == 409 and again.json()["code"] == "CONTENT_NOT_PUBLISHED"
    await env.flush()
    archived = [e for e in env.events(PUBLISHED) if e.payload["action"] == "archived"]
    assert len(archived) == 1 and archived[0].payload["version"] is None
    assert archived[0].payload["previous_version"] == 1
    assert_event_conforms(archived[0])
    snap = (await env.c.get("/internal/v1/courses/en-core/snapshot", headers=env.svc("learning-plan"))).json()
    assert "en.func.lonely" not in {s["skill_id"] for s in snap["skills"]}
    r = await env.c.post("/admin/v1/content/skill/en.func.lonely/archive", json={"reason": "x"},
                         headers=env.h(PUBLISHER))
    assert r.status_code == 422
    r = await env.c.post("/admin/v1/content/skill/en.func.nope/archive", json={"reason": "Нет такого"},
                         headers=env.h(PUBLISHER))
    assert r.status_code == 404


async def test_rollback(env) -> None:
    v2 = await env.edit_published("rubric", "r-lesson-core", 1,
                                  {"pass_rule": {"min_weighted": 2.0, "min_per_criterion": 1}})
    await env.publish("rubric", "r-lesson-core", v2)
    snap_before = await env.c.get("/internal/v1/courses/en-core/snapshot", headers=env.svc("learning-plan"))
    url = "/admin/v1/content/rubric/r-lesson-core/rollback"
    r = await env.c.post(url, json={"to_version": 2, "reason": "Вернуть"}, headers=env.h(PUBLISHER))
    assert r.status_code == 409 and r.json()["code"] == "ROLLBACK_TARGET_INVALID"
    r = await env.c.post(url, json={"to_version": 9, "reason": "Вернуть"}, headers=env.h(PUBLISHER))
    assert r.status_code == 404
    r = await env.c.post(url, json={"to_version": 1, "reason": "Вернуть"}, headers=env.h(CONTENT_MANAGER))
    assert r.status_code == 403
    r = await env.c.post(url, json={"to_version": 1, "reason": "Вернуть прежние пороги"}, headers=env.h(PUBLISHER))
    assert r.status_code == 200, r.text
    assert r.json()["version"] == 1 and r.json()["status"] == "published" and r.json()["archived_at"] is None
    assert (await env.get_version("rubric", "r-lesson-core", v2))["status"] == "archived"
    card = (await env.c.get("/admin/v1/content/rubric/r-lesson-core", headers=env.h(READER))).json()
    assert card["row"]["published_version"] == 1
    await env.flush()
    rolled = [e for e in env.events(PUBLISHED) if e.payload["action"] == "rolled_back"]
    assert [(e.payload["version"], e.payload["previous_version"]) for e in rolled] == [(1, 2)]
    assert_event_conforms(rolled[0])
    assert len(await env.audit("content.rolled_back")) == 1
    # версии остаются доступными по номеру (пройденные уроки ссылаются на свою версию)
    assert (await env.get_version("rubric", "r-lesson-core", 2))["payload"]["pass_rule"]["min_weighted"] == 2.0
    assert snap_before.status_code == 200


async def test_rollback_revalidates_target(env) -> None:
    """Откат к версии урока, ссылающейся на снятый с публикации навык, — 422 (повторная проверка)."""
    await env.published_new("skill", skill("en.func.temp"))
    p = lesson("l-rb")
    p["secondary_skill_ids"] = ["en.func.temp"]
    v1 = await env.published_new("lesson", p)
    v2 = await env.edit_published("lesson", "l-rb", v1, {"secondary_skill_ids": []})
    await env.publish("lesson", "l-rb", v2)
    r = await env.c.post("/admin/v1/content/skill/en.func.temp/archive", json={"reason": "Больше не нужен"},
                         headers=env.h(PUBLISHER))
    assert r.status_code == 200, r.text
    r = await env.c.post("/admin/v1/content/lesson/l-rb/rollback", json={"to_version": v1, "reason": "Вернуть"},
                         headers=env.h(PUBLISHER))
    assert r.status_code == 422 and paths(r, "UNKNOWN_REF") == ["payload.secondary_skill_ids[0]"]


# ---------------------------------------------------------------- сценарии: тестовый прогон (AT-28)


async def test_scenario_test_run_required_for_publish(env) -> None:
    p = scenario("sc-run")
    assert (await env.create("scenario", p)).status_code == 201
    await env.submit("scenario", "sc-run", 1)
    await env.approve("scenario", "sc-run", 1)
    r = await env.publish("scenario", "sc-run", 1)
    assert r.status_code == 422 and codes(r) == ["SCENARIO_TEST_FAILED"]
    run = await env.act("scenario", "sc-run", 1, "test-run", CONTENT_MANAGER)
    assert run.status_code == 200 and run.json()["ok"] is True
    assert set(run.json()) == set(ts.fields("content.ts", "ScenarioTestRun"))
    v = await env.get_version("scenario", "sc-run", 1)
    assert v["test_run"]["ok"] is True
    assert (await env.publish("scenario", "sc-run", 1)).status_code == 200
    r = await env.act("scenario", "sc-run", 1, "test-run", READER)
    assert r.status_code == 403
    r = await env.act("lesson", "l-01-greetings", 1, "test-run", CONTENT_MANAGER)
    assert r.status_code == 404
    assert len(await env.audit("content.test_run")) == 1


async def test_test_run_finds_problems_and_goes_stale(env) -> None:
    p = scenario("sc-broken")
    p["nodes"]["n2"]["transitions"][0]["to"] = "n9"
    p["nodes"]["n3"]["speaker"] = "ghost"
    await env.create("scenario", p)
    run = (await env.act("scenario", "sc-broken", 1, "test-run", CONTENT_MANAGER)).json()
    assert run["ok"] is False
    assert {(i["code"], i["node_id"]) for i in run["issues"]} >= {("UNKNOWN_NODE", "n2"), ("UNKNOWN_SPEAKER", "n3"),
                                                                  ("UNREACHABLE_NODE", "n4")}
    r = await env.submit("scenario", "sc-broken", 1)
    assert r.status_code == 422 and {"UNKNOWN_NODE", "UNKNOWN_SPEAKER", "UNREACHABLE_NODE"} <= set(codes(r))
    fixed = scenario("sc-broken")
    v = await env.get_version("scenario", "sc-broken", 1)
    ok = (await env.put("scenario", "sc-broken", 1, fixed, v["payload_hash"])).json()
    assert ok["test_run"] is None  # прогон устарел после правки
    assert (await env.act("scenario", "sc-broken", 1, "test-run", CONTENT_MANAGER)).json()["ok"] is True


# ---------------------------------------------------------------- сводка


async def test_summary(env) -> None:
    await env.create("skill", skill("en.func.s1"))
    await env.create("rubric", rubric("r-s2"))
    await env.submit("rubric", "r-s2", 1)
    r = await env.c.get("/admin/v1/content/summary", headers=env.h(DASHBOARD))
    assert r.status_code == 200
    s = r.json()
    assert set(s) == set(ts.fields("admin.ts", "ContentSummary"))
    assert s["by_kind"]["lesson"] == {"published": 2, "drafts": 0, "in_review": 0}
    assert s["by_kind"]["skill"]["drafts"] == 1 and s["by_kind"]["rubric"]["in_review"] == 1
    assert set(s["by_kind"]) == set(ts.type_aliases("content.ts")["ContentKind"])
    assert s["in_review"] == 1 and s["suspended_media"] == 0 and s["new_media_requests"] == 0
    assert (await env.c.get("/admin/v1/content/summary", headers=env.h(READER))).status_code == 200
    r = await env.c.get("/admin/v1/content/summary", headers=env.h(SUPPORT))
    assert r.status_code == 403


async def test_ids_in_events_only_for_uuid_staff(env) -> None:
    """published_by — UUID сотрудника; не-UUID идентификатор не попадает в событие (format uuid)."""
    odd = Actor(id="staff-legacy", role="methodist", permissions=PUBLISHER.permissions)
    version = await env.to_approved("skill", skill("en.func.odd"))
    assert (await env.publish("skill", "en.func.odd", version, odd)).status_code == 200
    await env.flush()
    [event] = env.events(PUBLISHED)
    assert event.payload["published_by"] is None
    assert_event_conforms(event)
    assert uuid.UUID(PUBLISHER.id)


# ---------------------------------------------------------------- блокировка графа (ревью: гонка CONTENT_IN_USE)


async def test_publish_archive_rollback_wait_for_graph_lock(env) -> None:
    """Публикация, снятие и откат проверяют ссылки под общей advisory-блокировкой графа: пока её держит другая
    транзакция, команда ждёт (и видна в pg_locks как ожидающая), после освобождения — выполняется."""
    version = await env.to_approved("skill", skill("en.func.locked"))
    url = make_url(TEST_ADMIN_URL).set(drivername="postgresql").render_as_string(hide_password=False)
    commands = [
        lambda: env.publish("skill", "en.func.locked", version),
        lambda: env.c.post("/admin/v1/content/skill/en.func.locked/archive", json={"reason": "Снять"},
                           headers=env.h(PUBLISHER)),
        lambda: env.c.post("/admin/v1/content/skill/en.func.locked/rollback",
                           json={"to_version": version, "reason": "Вернуть"}, headers=env.h(PUBLISHER)),
    ]
    holder = await asyncpg.connect(url)
    try:
        for command in commands:
            tr = holder.transaction()
            await tr.start()
            await holder.execute("SELECT pg_advisory_xact_lock($1, 0)", GRAPH_LOCK_CLASS)
            task = asyncio.create_task(command())
            for _ in range(50):
                waiting = await holder.fetchval(
                    "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND classid = $1 AND objid = 0 "
                    "AND NOT granted", GRAPH_LOCK_CLASS)
                if waiting:
                    break
                await asyncio.sleep(0.02)
            assert waiting == 1 and not task.done()
            await tr.rollback()
            r = await asyncio.wait_for(task, 10)
            assert r.status_code == 200, r.text
    finally:
        await holder.close()
    assert (await env.get_version("skill", "en.func.locked", version))["status"] == "published"
