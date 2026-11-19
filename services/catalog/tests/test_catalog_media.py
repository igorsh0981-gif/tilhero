"""Медиа с правами (AT-29, ADM-MEDIA-01…03): аудио-файлы, подтверждение прав, флаг внешних источников, автоприостановка
по истечении прав (catalog:tick), предупреждение «истекает» на обзоре."""

from __future__ import annotations

import base64
import hashlib
from datetime import date

import ts_contract as ts
from catalog_kit import CONTENT_MANAGER, EDITOR2, PUBLISHER, READER, RIGHTS, codes, exercise, media, paths

from tilhero_common.testing import assert_event_conforms

MP3 = b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\xff\xfb\x90\x00" * 64
OGG = b"OggS\x00\x02" + b"\x00" * 100


def upload(data: bytes, content_type: str = "audio/mpeg", filename: str = "scene.mp3") -> dict:
    return {"filename": filename, "content_type": content_type, "data_base64": base64.b64encode(data).decode()}


# ---------------------------------------------------------------- аудио


async def test_upload_audio_and_preview(env) -> None:
    r = await env.c.post("/admin/v1/content/blobs", json=upload(MP3), headers=env.h(CONTENT_MANAGER))
    assert r.status_code == 201, r.text
    blob = r.json()
    assert set(blob) == set(ts.fields("admin.ts", "AudioBlob"))
    assert blob["size"] == len(MP3) and blob["sha256"] == hashlib.sha256(MP3).hexdigest()
    same = await env.c.post("/admin/v1/content/blobs", json=upload(MP3), headers=env.h(CONTENT_MANAGER))
    assert same.status_code == 200 and same.json()["blob_id"] == blob["blob_id"]  # без дублей
    got = await env.c.get(f"/admin/v1/content/blobs/{blob['blob_id']}", headers=env.h(READER))
    assert got.status_code == 200 and got.content == MP3 and got.headers["content-type"] == "audio/mpeg"
    assert got.headers["etag"] == f'"{blob["sha256"]}"'
    [audit] = await env.audit("content.blob_uploaded")
    assert audit["after"]["size"] == len(MP3)
    r = await env.c.get("/admin/v1/content/blobs/00000000-0000-4000-8000-000000000000", headers=env.h(READER))
    assert r.status_code == 404 and r.json()["code"] == "BLOB_NOT_FOUND"


async def test_upload_rejections(env) -> None:
    h = env.h(CONTENT_MANAGER)
    r = await env.c.post("/admin/v1/content/blobs", json=upload(OGG, "audio/mpeg"), headers=h)
    assert r.status_code == 422 and r.json()["details"] == {"reason": "signature"}
    r = await env.c.post("/admin/v1/content/blobs", json=upload(b"<html>evil</html>", "audio/ogg"), headers=h)
    assert r.status_code == 422 and r.json()["code"] == "AUDIO_INVALID"
    r = await env.c.post("/admin/v1/content/blobs", json={**upload(OGG, "audio/ogg"), "data_base64": "@@@@"},
                         headers=h)
    assert r.status_code == 422 and r.json()["details"] == {"reason": "encoding"}
    big = b"OggS" + b"\x00" * (3 * 1024 * 1024)
    r = await env.c.post("/admin/v1/content/blobs", json=upload(big, "audio/ogg"), headers=h)
    assert r.status_code == 422 and r.json()["details"] == {"reason": "size"}
    r = await env.c.post("/admin/v1/content/blobs", json={**upload(OGG, "audio/wav")}, headers=h)
    assert r.status_code == 422 and r.json()["code"] == "VALIDATION_ERROR"
    r = await env.c.post("/admin/v1/content/blobs", json=upload(OGG, "audio/ogg"), headers=env.h(READER))
    assert r.status_code == 403
    r = await env.c.post("/admin/v1/content/blobs", json=upload(OGG, "audio/ogg"))
    assert r.status_code == 401


async def test_body_limits(env) -> None:
    """Тело ≤ 4,5 МБ только у загрузки аудио; остальные маршруты — общий лимит 256 КБ."""
    huge = {"filename": "x.ogg", "content_type": "audio/ogg", "data_base64": "A" * 4_600_000}
    r = await env.c.post("/admin/v1/content/blobs", json=huge, headers=env.h(CONTENT_MANAGER))
    assert r.status_code == 413 and r.json()["code"] == "PAYLOAD_TOO_LARGE"
    ok = b"OggS" + b"\x00" * (2 * 1024 * 1024)  # 2 МБ → ~2,8 МБ base64 — больше 256 КБ, но в пределах маршрута
    r = await env.c.post("/admin/v1/content/blobs", json=upload(ok, "audio/ogg"), headers=env.h(CONTENT_MANAGER))
    assert r.status_code == 201, r.text
    p = media("m-big")
    p["original_title"] = "x" * 300_000
    r = await env.create("media_asset", p)
    assert r.status_code == 413


# ---------------------------------------------------------------- права


async def test_rights_approval_rules(env) -> None:
    p = media("m-rights")
    assert (await env.create("media_asset", p)).status_code == 201
    url = "/admin/v1/content/media_asset/m-rights/versions/1/rights-approve"
    r = await env.c.post(url, json={"note": "Права проверены"}, headers=env.h(EDITOR2))
    assert r.status_code == 403 and r.json()["details"] == {"permission": "media.rights"}
    await env.submit("media_asset", "m-rights", 1)
    await env.approve("media_asset", "m-rights", 1)
    r = await env.publish("media_asset", "m-rights", 1)
    assert r.status_code == 422 and paths(r, "RIGHTS_REQUIRED") == ["rights_approved"]
    r = await env.c.post(url, json={"note": "Права проверены"}, headers=env.h(RIGHTS))
    assert r.status_code == 200 and r.json()["rights_approved_by"] == RIGHTS.id
    alias = await env.c.post(url.replace("rights-approve", "rights:approve"), json={"note": "Повтор"},
                             headers=env.h(RIGHTS))
    assert alias.status_code == 200
    assert (await env.publish("media_asset", "m-rights", 1)).status_code == 200
    r = await env.c.post(url, json={"note": "После публикации"}, headers=env.h(RIGHTS))
    assert r.status_code == 409 and r.json()["code"] == "VERSION_IMMUTABLE"
    r = await env.c.post("/admin/v1/content/lesson/l-01-greetings/versions/1/rights-approve",
                         json={"note": "Не медиа"}, headers=env.h(RIGHTS))
    assert r.status_code == 404
    audits = await env.audit("content.rights_approved")
    assert len(audits) == 2 and audits[0]["after"]["rights"]["license_type"] == "own"


async def test_rights_reset_on_edit_and_incomplete_rights(env) -> None:
    p = media("m-reset")
    await env.create("media_asset", p)
    url = "/admin/v1/content/media_asset/m-reset/versions/1/rights-approve"
    assert (await env.c.post(url, json={"note": "Права ок"}, headers=env.h(RIGHTS))).status_code == 200
    v = await env.get_version("media_asset", "m-reset", 1)
    edited = {**v["payload"], "level": "A2"}
    r = await env.put("media_asset", "m-reset", 1, edited, v["payload_hash"])
    assert r.status_code == 200 and r.json()["rights_approved_by"] is None and r.json()["rights_approved_at"] is None
    bad = {**edited, "rights": {**edited["rights"], "territories": ["KZ"]}}
    r = await env.put("media_asset", "m-reset", 1, bad, r.json()["payload_hash"])
    r = await env.c.post(url, json={"note": "Права ок"}, headers=env.h(RIGHTS))
    assert r.status_code == 422 and paths(r, "RIGHTS_REQUIRED") == ["payload.rights.territories"]


async def test_external_sources_closed_by_flag(env) -> None:
    p = media("m-licensed", license_type="contract", license_ref="Договор 7/2026")
    p["origin"] = "licensed"
    assert (await env.create("media_asset", p)).status_code == 201
    r = await env.submit("media_asset", "m-licensed", 1)
    assert r.status_code == 422 and "EXTERNAL_SOURCE_DISABLED" in codes(r)
    r = await env.act("media_asset", "m-licensed", 1, "rights-approve", RIGHTS, {"note": "Договор есть"})
    assert r.status_code == 422 and "EXTERNAL_SOURCE_DISABLED" in codes(r)


async def test_external_sources_with_flag(env_external) -> None:
    env = env_external
    p = media("m-licensed", license_type="contract", license_ref="Договор 7/2026")
    p["origin"] = "licensed"
    assert await env.published_new("media_asset", p) == 1
    cards = (await env.c.get("/internal/v1/media", params={"audience": "adults"},
                             headers=env.learner("8d1a0c4e-1111-4111-8111-111111111111"))).json()
    assert {c["asset_id"] for c in cards["items"]} == {"m-own-coffee-order", "m-licensed"}
    assert next(c for c in cards["items"] if c["asset_id"] == "m-licensed")["source_label"] == "TilHero"


# ---------------------------------------------------------------- истечение прав (catalog:tick)


async def test_tick_auth(env) -> None:
    r = await env.c.post("/internal/v1/catalog:tick")
    assert r.status_code == 401 and r.json()["code"] == "SCHEDULER_TOKEN_INVALID"
    r = await env.c.post("/internal/v1/catalog:tick", headers=env.scheduler("wrong" * 10))
    assert r.status_code == 401
    r = await env.c.post("/internal/v1/catalog:tick", headers=env.svc("learning-plan"))
    assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED"
    r = await env.c.post("/internal/v1/catalog:tick", headers=env.scheduler())
    assert r.status_code == 200 and r.json() == {"suspended": 0, "expiring": 0, "today": "2026-11-19"}


async def test_rights_expire_suspend_and_warn(env) -> None:
    learner = env.learner("8d1a0c4e-2222-4222-8222-222222222222")
    await env.published_new("media_asset", media("m-expiring", valid_to="2026-11-25"))
    await env.published_new("media_exercise", exercise("mx-expiring", asset_id="m-expiring"))
    rows = (await env.c.get("/admin/v1/content/media_asset", headers=env.h(READER))).json()["items"]
    assert {r["key"]: r["rights_warning"] for r in rows} == {"m-expiring": "expiring", "m-own-coffee-order": None}
    summary = (await env.c.get("/admin/v1/content/summary", headers=env.h(READER))).json()
    assert summary["rights_expiring"] == [{"asset_id": "m-expiring", "title": media("m")["title"],
                                           "valid_to": "2026-11-25"}]
    detail = await env.c.get("/internal/v1/media/m-expiring", params={"audience": "adults"}, headers=learner)
    assert detail.status_code == 200 and detail.json()["exercises_available"] is True
    # последний день прав — ещё доступно
    env.set_today(date(2026, 11, 25))
    assert (await env.c.post("/internal/v1/catalog:tick", headers=env.scheduler())).json()["suspended"] == 0
    # срок истёк: ученик не видит сразу (защита в глубину), tick приостанавливает
    env.set_today(date(2026, 11, 26))
    r = await env.c.get("/internal/v1/media/m-expiring", params={"audience": "adults"}, headers=learner)
    assert r.status_code == 404 and r.json()["code"] == "MEDIA_NOT_AVAILABLE"
    tick = await env.c.post("/internal/v1/catalog:tick", headers=env.scheduler())
    assert tick.json()["suspended"] == 1
    again = await env.c.post("/internal/v1/catalog:tick", headers=env.scheduler())
    assert again.json()["suspended"] == 0  # повтор безопасен
    v = await env.get_version("media_asset", "m-expiring", 1)
    assert v["status"] == "suspended" and v["suspend_reason"] == "rights_expired" and v["suspended_at"]
    rows = (await env.c.get("/admin/v1/content/media_asset", headers=env.h(READER))).json()["items"]
    row = next(r for r in rows if r["key"] == "m-expiring")
    assert row["rights_warning"] == "expired" and row["published_version"] is None
    summary = (await env.c.get("/admin/v1/content/summary", headers=env.h(READER))).json()
    assert summary["suspended_media"] == 1 and summary["rights_expiring"] == []
    await env.flush()
    [event] = env.events("catalog.media.suspended.v1")
    assert_event_conforms(event)
    assert event.payload["asset_id"] == "m-expiring" and event.payload["reason"] == "rights_expired"
    [audit] = await env.audit("media.suspended")
    assert audit["actor_type"] == "system" and audit["actor_role"] is None
    # приостановленное нельзя откатить или снова опубликовать — только новая версия с продлёнными правами
    r = await env.c.post("/admin/v1/content/media_asset/m-expiring/rollback",
                         json={"to_version": 1, "reason": "Вернуть"}, headers=env.h(PUBLISHER))
    assert r.status_code == 409
    v2 = await env.edit_published("media_asset", "m-expiring", 1, {"rights": {**v["payload"]["rights"],
                                                                              "valid_to": "2027-12-31"}})
    assert (await env.publish("media_asset", "m-expiring", v2)).status_code == 200
    r = await env.c.get("/internal/v1/media/m-expiring", params={"audience": "adults"}, headers=learner)
    assert r.status_code == 200


async def test_expired_rights_block_publish(env) -> None:
    await env.create("media_asset", media("m-old", valid_to="2026-11-18"))
    r = await env.submit("media_asset", "m-old", 1)
    assert r.status_code == 422 and paths(r, "RIGHTS_REQUIRED") == ["payload.rights.valid_to"]


async def test_exercise_review_and_publish(env) -> None:
    """Упражнения к медиа проходят проверку методиста (ADM-MEDIA-03): без неё не публикуются."""
    await env.create("media_exercise", exercise("mx-1"))
    r = await env.publish("media_exercise", "mx-1", 1)
    assert r.status_code == 409 and r.json()["code"] == "VERSION_NOT_APPROVED"
    await env.submit("media_exercise", "mx-1", 1)
    r = await env.approve("media_exercise", "mx-1", 1, CONTENT_MANAGER)
    assert r.status_code == 403
    await env.approve("media_exercise", "mx-1", 1)
    assert (await env.publish("media_exercise", "mx-1", 1)).status_code == 200
