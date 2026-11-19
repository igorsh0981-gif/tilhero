"""Заявки учеников на песни и фильмы (AT-30, AT-38, ADM-MEDIA-04) и сага удаления (обезличивание заявок)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import ts_contract as ts
from catalog_kit import CONTENT_MANAGER, EDITOR2, READER, RIGHTS, SUPPORT

from tilhero_common.messaging import make_envelope
from tilhero_common.testing import assert_event_conforms

URL = "/internal/v1/media/requests"
ADMIN = "/admin/v1/content/media-requests"
MEDIA_REQUEST_FIELDS = {"request_id", "kind", "title", "link", "comment", "status", "decision_note",
                        "linked_asset_id", "created_at", "decided_at"}


def body(title: str = "Bohemian Rhapsody", **kw: object) -> dict[str, object]:
    return {"kind": "song", "title": title, **kw}


async def create(env, user: uuid.UUID, payload: dict[str, object] | None = None, **headers: str):
    return await env.c.post(URL, json=payload or body(), headers={**env.learner(user), **headers})


def deletion(user: uuid.UUID, producer: str = "identity-consent"):
    return make_envelope("user.deletion.requested.v1", {
        "user_id": str(user), "request_id": str(uuid.uuid4()),
        "requested_at": datetime.now(UTC).isoformat().replace("+00:00", "Z")}, producer=producer)


# ---------------------------------------------------------------- ученик


async def test_create_and_list_own(env) -> None:
    user, other = uuid.uuid4(), uuid.uuid4()
    r = await create(env, user, body(link="https://example.com/song?id=1", comment="Хочу разобрать текст",
                                     ui_locale="uz"))
    assert r.status_code == 201, r.text
    req = r.json()
    assert set(req) == MEDIA_REQUEST_FIELDS
    assert set(ts.fields("bff.ts", "MediaRequestCreate")) - {"link", "comment"} <= set(req)
    assert (req["status"], req["link"], req["decision_note"], req["decided_at"]) == (
        "new", "https://example.com/song?id=1", None, None)
    await create(env, other, body("Другой фильм", kind="movie"))
    mine = (await env.c.get(URL, headers=env.learner(user))).json()["items"]
    assert [i["request_id"] for i in mine] == [req["request_id"]]  # изоляция учеников
    await env.flush()
    events = env.events("catalog.media_request.created.v1")
    assert len(events) == 2
    for e in events:
        assert_event_conforms(e)
    assert set(events[0].payload) == {"request_id", "user_id", "kind", "created_at"}  # без текста заявки
    stored = await env.sql("SELECT ui_locale, title_norm FROM media_requests WHERE request_id = $1",
                           uuid.UUID(req["request_id"]))
    assert stored[0]["ui_locale"] == "uz" and stored[0]["title_norm"] == "bohemian rhapsody"


async def test_create_validation(env) -> None:
    user = uuid.uuid4()
    for bad in (body("x"), body("   a   "), body(link="http://insecure.example.com"), body(link="javascript:alert(1)"),
                body(comment="c" * 501), body(kind="podcast"), {**body(), "user_id": str(uuid.uuid4())},
                body("Песня‮")):
        r = await create(env, user, bad)
        assert r.status_code == 422, bad
    r = await env.c.post(URL, json=body())
    assert r.status_code == 401
    r = await env.c.post(URL, json=body(), headers=env.svc("telegram-bff"))  # без субъекта
    assert r.status_code == 401 and r.json()["code"] == "USER_CONTEXT_REQUIRED"
    r = await env.c.post(URL, json=body(), headers=env.svc("learning-plan", str(user)))
    assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED"


async def test_kids_profile_cannot_request(env) -> None:
    account, child = uuid.uuid4(), uuid.uuid4()
    r = await env.c.post(URL, json=body(), headers=env.learner(account, lrn=str(child)))
    assert r.status_code == 403 and r.json()["code"] == "KIDS_NOT_ALLOWED"
    r = await env.c.post(URL, json=body(), headers=env.learner(account, age_band="10-13"))
    assert r.status_code == 403 and r.json()["code"] == "KIDS_NOT_ALLOWED"
    r = await env.c.post(URL, json=body(), headers=env.learner(account, lrn=str(account), age_band="18+"))
    assert r.status_code == 201
    rid = r.json()["request_id"]
    # чтение заявок из детского профиля — тоже 403 (список и по id)
    for headers in (env.learner(account, lrn=str(child)), env.learner(account, age_band="6-9")):
        r = await env.c.get(URL, headers=headers)
        assert r.status_code == 403 and r.json()["code"] == "KIDS_NOT_ALLOWED"
        r = await env.c.get(f"{URL}/{rid}", headers=headers)
        assert r.status_code == 403 and r.json()["code"] == "KIDS_NOT_ALLOWED"
    assert (await env.c.get(f"{URL}/{rid}", headers=env.learner(account, lrn=str(account)))).status_code == 200
    assert (await env.c.get(f"{URL}/{rid}", headers=env.svc("notifications"))).status_code == 200


async def test_idempotency_and_daily_limit(env) -> None:
    user = uuid.uuid4()
    a = await create(env, user, **{"Idempotency-Key": "req-key-0001"})
    b = await create(env, user, **{"Idempotency-Key": "req-key-0001"})
    assert a.status_code == b.status_code == 201 and a.json()["request_id"] == b.json()["request_id"]
    for i in range(4):
        assert (await create(env, user, body(f"Песня {i}"))).status_code == 201
    r = await create(env, user, body("Шестая"))
    assert r.status_code == 429 and r.json()["code"] == "MEDIA_REQUEST_LIMIT"
    assert 0 < int(r.headers["retry-after"]) <= 24 * 3600
    assert (await create(env, uuid.uuid4(), body("Чужой лимит"))).status_code == 201
    assert len((await env.c.get(URL, headers=env.learner(user))).json()["items"]) == 5


async def test_get_by_id_for_owner_and_notifications(env) -> None:
    user = uuid.uuid4()
    req = (await create(env, user, body(link="https://example.com/x", comment="личное"))).json()
    rid = req["request_id"]
    own = await env.c.get(f"{URL}/{rid}", headers=env.learner(user))
    assert own.status_code == 200 and own.json() == req
    r = await env.c.get(f"{URL}/{rid}", headers=env.learner(uuid.uuid4()))
    assert r.status_code == 404 and r.json()["code"] == "MEDIA_REQUEST_NOT_FOUND"  # чужая — как несуществующая
    svc = await env.c.get(f"{URL}/{rid}", headers=env.svc("notifications"))
    assert svc.status_code == 200
    data = svc.json()
    assert data["user_id"] == str(user) and "link" not in data and "comment" not in data
    r = await env.c.get(f"{URL}/{uuid.uuid4()}", headers=env.svc("notifications"))
    assert r.status_code == 404
    r = await env.c.get(f"{URL}/{rid}", headers=env.svc("diagnostics"))
    assert r.status_code == 403


# ---------------------------------------------------------------- сотрудники


async def test_admin_registry_similar_and_filters(env) -> None:
    for title in ("Bohemian Rhapsody", "bohemian  rhapsody!", "Другой фильм"):
        await create(env, uuid.uuid4(), body(title))
    r = await env.c.get(ADMIN, headers=env.h(RIGHTS))
    assert r.status_code == 200
    items = r.json()["items"]
    assert set(items[0]) == set(ts.fields("admin.ts", "AdminMediaRequest"))
    assert [i["title"] for i in items] == ["Другой фильм", "bohemian  rhapsody!", "Bohemian Rhapsody"]
    assert [i["similar_count"] for i in items] == [0, 1, 1]
    q = (await env.c.get(ADMIN, params={"q": "RHAPSODY"}, headers=env.h(RIGHTS))).json()["items"]
    assert len(q) == 2
    page = (await env.c.get(ADMIN, params={"limit": 2}, headers=env.h(RIGHTS))).json()
    nxt = (await env.c.get(ADMIN, params={"limit": 2, "cursor": page["next_cursor"]}, headers=env.h(RIGHTS))).json()
    assert len(page["items"]) == 2 and len(nxt["items"]) == 1 and nxt["next_cursor"] is None
    assert (await env.c.get(ADMIN, params={"status": "new"}, headers=env.h(RIGHTS))).json()["items"]
    assert (await env.c.get(ADMIN, params={"status": "licensed"}, headers=env.h(RIGHTS))).json()["items"] == []
    assert (await env.c.get(ADMIN, headers=env.h(SUPPORT))).status_code == 403
    # ссылка и комментарий ученика — ПД: реестр и карточка только с media.rights (content.read мало)
    r = await env.c.get(ADMIN, headers=env.h(READER))
    assert r.status_code == 403 and r.json()["details"] == {"permission": "media.rights"}
    rid = items[0]["request_id"]
    card = await env.c.get(f"{ADMIN}/{rid}", headers=env.h(RIGHTS))
    assert card.status_code == 200 and card.json() == items[0]
    assert (await env.c.get(f"{ADMIN}/{rid}", headers=env.h(READER))).status_code == 403
    r = await env.c.get(f"{ADMIN}/{uuid.uuid4()}", headers=env.h(RIGHTS))
    assert r.status_code == 404 and r.json()["code"] == "MEDIA_REQUEST_NOT_FOUND"
    summary = (await env.c.get("/admin/v1/content/summary", headers=env.h(READER))).json()
    assert summary["new_media_requests"] == 3


async def test_take_and_decide(env) -> None:
    user = uuid.uuid4()
    rid = (await create(env, user, body(link="https://example.com/song"))).json()["request_id"]
    r = await env.c.post(f"{ADMIN}/{rid}/take", headers=env.h(EDITOR2))
    assert r.status_code == 403 and r.json()["details"] == {"permission": "media.rights"}
    r = await env.c.post(f"{ADMIN}/{rid}/take", headers=env.h(RIGHTS))
    assert r.status_code == 200 and r.json()["status"] == "in_review"
    assert (await env.c.post(f"{ADMIN}/{rid}/take", headers=env.h(RIGHTS))).status_code == 200  # повтор
    r = await env.c.post(f"{ADMIN}/{uuid.uuid4()}/take", headers=env.h(RIGHTS))
    assert r.status_code == 404
    decide = f"{ADMIN}/{rid}/decide"
    r = await env.c.post(decide, json={"status": "authored_alternative", "note": "Подобрали сценку"},
                         headers=env.h(RIGHTS))
    assert r.status_code == 422 and r.json()["code"] == "LINKED_ASSET_REQUIRED"
    r = await env.c.post(decide, json={"status": "licensed", "note": "Есть лицензия", "linked_asset_id": "m-nope"},
                         headers=env.h(RIGHTS))
    assert r.status_code == 422 and r.json()["code"] == "LINKED_ASSET_NOT_PUBLISHED"
    r = await env.c.post(decide, json={"status": "rejected", "note": "Нет прав",
                                       "linked_asset_id": "m-own-coffee-order"}, headers=env.h(RIGHTS))
    assert r.status_code == 422 and r.json()["code"] == "LINKED_ASSET_NOT_ALLOWED"
    r = await env.c.post(decide, json={"status": "rejected", "note": "x"}, headers=env.h(RIGHTS))
    assert r.status_code == 422
    decision = {"status": "authored_alternative", "note": "Подобрали похожую сценку TilHero",
                "linked_asset_id": "m-own-coffee-order"}
    r = await env.c.post(decide, json=decision, headers=env.h(RIGHTS, **{"Idempotency-Key": "decide-0001"}))
    assert r.status_code == 200, r.text
    out = r.json()
    assert (out["status"], out["decided_by"], out["decided_by_name"]) == ("authored_alternative", RIGHTS.id, None)
    replay = await env.c.post(decide, json=decision, headers=env.h(RIGHTS, **{"Idempotency-Key": "decide-0001"}))
    assert replay.headers.get("idempotent-replay") == "true"
    same = await env.c.post(decide, json=decision, headers=env.h(RIGHTS))
    assert same.status_code == 200  # то же решение — без повторного уведомления
    r = await env.c.post(decide, json={"status": "rejected", "note": "Передумали"}, headers=env.h(RIGHTS))
    assert r.status_code == 409 and r.json()["code"] == "MEDIA_REQUEST_DECIDED"
    r = await env.c.post(f"{ADMIN}/{rid}/take", headers=env.h(RIGHTS))
    assert r.status_code == 409
    await env.flush()
    [event] = env.events("catalog.media_request.decided.v1")
    assert_event_conforms(event)
    assert event.payload == {"request_id": rid, "user_id": str(user), "status": "authored_alternative",
                             "title": "Bohemian Rhapsody", "linked_asset_id": "m-own-coffee-order",
                             "decided_at": out["decided_at"]}
    [audit] = await env.audit("media_request.decided")
    assert "Bohemian" not in str(audit) and "example.com" not in str(audit)  # без текста ученика
    assert len(await env.audit("media_request.taken")) == 1
    mine = (await env.c.get(URL, headers=env.learner(user))).json()["items"][0]
    assert mine["status"] == "authored_alternative" and mine["decision_note"] == decision["note"]
    assert mine["linked_asset_id"] == "m-own-coffee-order"
    assert CONTENT_MANAGER.permissions >= {"media.rights"}


async def test_decide_duplicate_without_take(env) -> None:
    rid = (await create(env, uuid.uuid4())).json()["request_id"]
    r = await env.c.post(f"{ADMIN}/{rid}/decide", json={"status": "duplicate", "note": "Уже есть такая заявка"},
                         headers=env.h(CONTENT_MANAGER))
    assert r.status_code == 200 and r.json()["status"] == "duplicate" and r.json()["linked_asset_id"] is None


# ---------------------------------------------------------------- сага удаления


async def test_deletion_anonymizes_requests(env) -> None:
    user, other = uuid.uuid4(), uuid.uuid4()
    rid = (await create(env, user, body(link="https://example.com/private", comment="Меня зовут Игорь"))).json()[
        "request_id"]
    keep = (await create(env, other, body("Чужая"))).json()["request_id"]
    event = deletion(user)
    assert_event_conforms(event)
    await env.bus.publish(event)
    await env.bus.publish(event)  # повторная доставка — один раз (inbox)
    assert not env.bus.dlq
    await env.flush()
    acks = env.events("user.domain.deleted.v1")
    assert len(acks) == 1
    assert_event_conforms(acks[0])
    assert acks[0].payload == {"user_id": str(user), "request_id": event.payload["request_id"], "domain": "catalog",
                               "mode": "anonymized"}
    items = {i["request_id"]: i for i in (await env.c.get(ADMIN, headers=env.h(RIGHTS))).json()["items"]}
    gone = items[rid]
    assert gone["user_id"] is None and gone["link"] is None and gone["comment"] is None
    assert gone["title"] == "Bohemian Rhapsody"  # реестр и решение остаются
    assert items[keep]["user_id"] == str(other)
    r = await create(env, user, body("Новая"))
    assert r.status_code == 410 and r.json()["code"] == "USER_DELETED"
    r = await env.c.get(URL, headers=env.learner(user))
    assert r.status_code == 410
    # решению по обезличенной заявке некого уведомлять — события нет
    r = await env.c.post(f"{ADMIN}/{rid}/decide", json={"status": "rejected", "note": "Нет прав"},
                         headers=env.h(RIGHTS))
    assert r.status_code == 200
    await env.flush()
    assert env.events("catalog.media_request.decided.v1") == []
    rows = await env.sql("SELECT idempotency_key, anonymized_at FROM media_requests WHERE request_id = $1",
                         uuid.UUID(rid))
    assert rows[0]["idempotency_key"] is None and rows[0]["anonymized_at"] is not None


async def test_deletion_from_unexpected_producer_ignored(env) -> None:
    user = uuid.uuid4()
    await create(env, user)
    await env.bus.publish(deletion(user, producer="support"))
    await env.flush()
    assert env.events("user.domain.deleted.v1") == []
    assert (await create(env, user, body("Ещё одна"))).status_code == 201
