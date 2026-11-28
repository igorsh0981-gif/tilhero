"""Спринт 7, повторное ревью бэкенда Н1: выгрузка профилей для начальной загрузки проекции gamification.

GET /internal/v1/export/profiles — только gamification; неудалённые ученики; age_band и guardian_consent — ровно как
в user.profile.updated.v1; курсор по user_id, битый — 400; без лишних полей.
"""

from __future__ import annotations

import uuid
from typing import Any

from test_identity_guardian_grants import _granted_teen

EXPORT = "/internal/v1/export/profiles"
FIELDS = {"user_id", "kind", "age_band", "guardian_consent", "guardian_user_id", "updated_at"}


async def _all(env, limit: int = 500) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    cursor: str | None = None
    while True:
        path = f"{EXPORT}?limit={limit}" + (f"&cursor={cursor}" if cursor else "")
        r = await env.call("GET", path, None, issuer="gamification")
        assert r.status_code == 200, r.text
        body = r.json()
        items += body["items"]
        cursor = body["next_cursor"]
        if cursor is None:
            return items


async def test_export_profiles_values_match_event(env) -> None:
    parent = await env.parent()
    adult = await env.adult()
    teen = await _granted_teen(env, parent)
    young = await env.teen()  # 14–17 без согласия родителя
    child = (await env.child(parent, "Мадина", "10-13"))["learner_id"]
    unknown = await env.new_user()  # возраст ещё не указан
    rows = {i["user_id"]: i for i in await _all(env)}
    for uid in (parent, adult, teen, young, child, unknown):
        assert uid in rows, uid
        assert set(rows[uid]) == FIELDS
    assert (rows[adult]["kind"], rows[adult]["age_band"], rows[adult]["guardian_consent"]) == (
        "account", "18+", "not_required")
    assert (rows[teen]["age_band"], rows[teen]["guardian_consent"]) == ("14-17", "granted")
    assert rows[young]["age_band"] == "14-17" and rows[young]["guardian_consent"] != "granted"
    assert (rows[child]["kind"], rows[child]["age_band"]) == ("child", "10-13")
    assert rows[unknown]["age_band"] is None
    # значения совпадают с последним событием user.profile.updated.v1 каждого ученика
    for uid in (adult, teen, young):
        last = (await env.events("user.profile.updated.v1", uid))[-1].payload
        assert (rows[uid]["age_band"], rows[uid]["guardian_consent"]) == (last["age_band"], last["guardian_consent"])
    # без имени, username и Telegram ID
    r = await env.call("GET", f"{EXPORT}?limit=1000", None, issuer="gamification")
    assert "Мадина" not in r.text and "telegram" not in r.text


async def test_export_profiles_paging_and_deleted(env) -> None:
    users = [await env.adult() for _ in range(5)]
    deleting = await env.adult()
    r = await env.call("POST", "/internal/v1/me/deletion-request", deleting, {"confirm_word": "УДАЛИТЬ"})
    assert r.status_code == 202, r.text
    paged = await _all(env, limit=2)
    ids = [i["user_id"] for i in paged]
    assert ids == sorted(ids, key=uuid.UUID) and len(ids) == len(set(ids))  # стабильный порядок, без повторов
    assert set(users) <= set(ids)
    assert deleting not in ids  # удаляемый не выгружается
    assert [i["user_id"] for i in await _all(env, limit=1000)] == ids


async def test_export_profiles_access(env) -> None:
    await env.adult()
    for caller in ("social", "telegram-bff", "lessons", "notifications"):
        r = await env.call("GET", EXPORT, None, issuer=caller)
        assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED", caller
    assert (await env.client.get(EXPORT)).status_code == 401
    r = await env.call("GET", f"{EXPORT}?cursor=not-a-cursor", None, issuer="gamification")
    assert r.status_code == 400 and r.json()["code"] == "INVALID_CURSOR"
    r = await env.call("GET", f"{EXPORT}?limit=1001", None, issuer="gamification")
    assert r.status_code == 422
