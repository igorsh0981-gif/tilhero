"""Матрица доступа по всем маршрутам catalog: 401 без токена, 403 чужой вызывающий, 403 без actor, 403 без права
(права проверяются в домене — защита в глубину, даже если admin-bff ошибётся)."""

from __future__ import annotations

import uuid

import pytest
from catalog_kit import SUPPORT
from test_catalog_languages import LANGUAGE, PAIR

RID = "00000000-0000-4000-8000-0000000000aa"
V = "/admin/v1/content/lesson/l-01-greetings/versions/1"

# (метод, путь, тело, право)
ADMIN = [
    ("GET", "/admin/v1/content/lesson", None, "content.read"),
    ("POST", "/admin/v1/content/lesson", {"payload": {}}, "content.edit"),
    ("GET", "/admin/v1/content/lesson/l-01-greetings", None, "content.read"),
    ("POST", "/admin/v1/content/lesson/l-01-greetings/versions", {"from_version": 1}, "content.edit"),
    ("GET", V, None, "content.read"),
    ("PUT", V, {"payload": {}, "expected_hash": "0" * 64}, "content.edit"),
    ("POST", f"{V}/validate", None, "content.read"),
    ("POST", f"{V}/submit", None, "content.edit"),
    ("POST", f"{V}/review", {"decision": "approve", "note": "ok ok", "locale_checks": {"ru": "checked",
                                                                                       "uz": "checked"}},
     "content.review"),
    ("POST", f"{V}/publish", {"reason": "Публикация"}, "content.publish"),
    ("POST", "/admin/v1/content/lesson/l-01-greetings/archive", {"reason": "Снять"}, "content.publish"),
    ("POST", "/admin/v1/content/lesson/l-01-greetings/rollback", {"to_version": 1, "reason": "Откат"},
     "content.publish"),
    ("POST", "/admin/v1/content/scenario/sc-cafe-coffee/versions/1/test-run", None, "content.edit"),
    ("POST", "/admin/v1/content/media_asset/m-own-coffee-order/versions/1/rights-approve", {"note": "Права ок"},
     "media.rights"),
    ("POST", "/admin/v1/content/blobs", {"filename": "a.ogg", "content_type": "audio/ogg", "data_base64": "T2dnUw=="},
     "content.edit"),
    ("GET", f"/admin/v1/content/blobs/{RID}", None, "content.read"),
    ("GET", "/admin/v1/content/review-queue", None, "content.review"),
    ("GET", "/admin/v1/content/summary", None, "dashboard.read"),
    ("GET", "/admin/v1/content/media-requests", None, "media.rights"),
    ("GET", f"/admin/v1/content/media-requests/{RID}", None, "media.rights"),
    ("POST", f"/admin/v1/content/media-requests/{RID}/take", None, "media.rights"),
    ("POST", f"/admin/v1/content/media-requests/{RID}/decide", {"status": "rejected", "note": "Нет прав"},
     "media.rights"),
    ("GET", "/admin/v1/languages", None, "content.read"),
    ("PUT", "/admin/v1/languages/de", LANGUAGE, "lang.manage"),
    ("GET", "/admin/v1/language-pairs", None, "content.read"),
    ("PUT", "/admin/v1/language-pairs/ru-de", PAIR, "lang.manage"),
]

# (метод, путь, разрешённые вызывающие)
INTERNAL = [
    ("GET", "/internal/v1/pairs", {"telegram-bff", "learning-plan", "diagnostics"}),
    ("GET", "/internal/v1/courses/en-core/snapshot", {"telegram-bff", "learning-plan", "diagnostics"}),
    ("GET", "/internal/v1/scenarios?audience=adults", {"telegram-bff"}),
    ("GET", "/internal/v1/scenarios/sc-cafe-coffee?audience=adults", {"telegram-bff"}),
    ("GET", "/internal/v1/media?audience=adults", {"telegram-bff"}),
    ("GET", "/internal/v1/media/m-own-coffee-order?audience=adults", {"telegram-bff"}),
    ("GET", "/internal/v1/media/m-own-coffee-order/audio", {"telegram-bff"}),
    ("GET", "/internal/v1/media/requests", {"telegram-bff"}),
    ("POST", "/internal/v1/media/requests", {"telegram-bff"}),
    ("GET", f"/internal/v1/media/requests/{RID}", {"telegram-bff", "notifications"}),
]


async def _call(env, method: str, path: str, body, headers):
    return await env.c.request(method, path, json=body, headers=headers)


@pytest.mark.parametrize(("method", "path", "body", "permission"), ADMIN, ids=[f"{m} {p}" for m, p, _, _ in ADMIN])
async def test_admin_route_access(env, method: str, path: str, body, permission: str) -> None:
    r = await _call(env, method, path, body, {})
    assert r.status_code == 401 and r.json()["code"] == "INTERNAL_TOKEN_MISSING"
    r = await _call(env, method, path, body, env.svc("telegram-bff", str(uuid.uuid4())))
    assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED"
    r = await _call(env, method, path, body, env.h(None))
    assert r.status_code == 403 and r.json()["code"] == "STAFF_CONTEXT_REQUIRED"
    r = await _call(env, method, path, body, env.h(SUPPORT))
    assert r.status_code == 403 and r.json()["code"] == "PERMISSION_DENIED"
    assert r.json()["details"]["permission"] == permission


@pytest.mark.parametrize(("method", "path", "allowed"), INTERNAL, ids=[f"{m} {p}" for m, p, _ in INTERNAL])
async def test_internal_route_callers(env, method: str, path: str, allowed: set[str]) -> None:
    body = {"kind": "song", "title": "Песня"} if method == "POST" else None
    r = await _call(env, method, path, body, {})
    assert r.status_code == 401
    for caller in ("telegram-bff", "learning-plan", "diagnostics", "notifications", "admin-bff", "support"):
        r = await _call(env, method, path, body, env.svc(caller, str(uuid.uuid4())))
        if caller in allowed:
            assert r.status_code not in (401, 403), (caller, r.text)
        else:
            assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED", caller
