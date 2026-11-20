"""Матрица доступа по всем маршрутам catalog: 401 без токена, 403 чужой вызывающий, 403 без actor, 403 без права
(права проверяются в домене — защита в глубину, даже если admin-bff ошибётся)."""

from __future__ import annotations

import uuid

import pytest
from catalog_kit import SUPPORT
from test_catalog_languages import LANGUAGE, PAIR

RID = "00000000-0000-4000-8000-0000000000aa"
V = "/admin/v1/content/lesson/l-01-greetings/versions/1"
G = f"/admin/v1/glossary/{RID}"
GLOSS = {"ru": "кот", "uz": "mushuk"}
REF = {"kind": "reading", "key": "r-a0-my-cat", "version": 1}

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
    # спринт 5: словарь курса
    ("GET", "/admin/v1/glossary", None, "content.read"),
    ("GET", "/admin/v1/glossary/stats", None, "dashboard.read"),
    ("GET", G, None, "content.read"),
    ("POST", "/admin/v1/glossary", {"pair_id": "ru-en", "lemma": "cat", "forms": ["cat"], "part_of_speech": None,
                                    "gloss": GLOSS, "example_en": None, "reason": None}, "glossary.manage"),
    ("PATCH", G, {"lemma": "cat"}, "glossary.manage"),
    ("POST", f"{G}/review", {"decision": "approve"}, "glossary.manage"),
    ("DELETE", G, {"reason": "Лишняя"}, "glossary.manage"),
]

REQUEST = {"kind": "song", "title": "Песня"}
LOOKUP = {"pair_id": "ru-en", "text": "cat", "content_ref": REF}
AI_ENTRY = {"pair_id": "ru-en", "surface": "cat", "lemma": "cat", "part_of_speech": "noun", "gloss": GLOSS,
            "forms": [], "confidence": 0.9, "agent_version": "teaching_coach@2", "content_ref": REF}

# (метод, путь, разрешённые вызывающие, тело)
INTERNAL = [
    ("GET", "/internal/v1/pairs", {"telegram-bff", "learning-plan", "diagnostics", "lessons"}, None),
    ("GET", "/internal/v1/courses/en-core/snapshot", {"telegram-bff", "learning-plan", "diagnostics", "lessons"},
     None),
    ("GET", "/internal/v1/scenarios?audience=adults", {"telegram-bff", "lessons"}, None),
    ("GET", "/internal/v1/scenarios/sc-cafe-coffee?audience=adults", {"telegram-bff", "lessons"}, None),
    ("GET", "/internal/v1/media?audience=adults", {"telegram-bff", "lessons"}, None),
    ("GET", "/internal/v1/media/m-own-coffee-order?audience=adults", {"telegram-bff", "lessons"}, None),
    ("GET", "/internal/v1/media/m-own-coffee-order/audio", {"telegram-bff"}, None),
    ("GET", "/internal/v1/media/m-own-coffee-order/exercises?audience=adults", {"lessons"}, None),
    ("GET", "/internal/v1/versions/lesson/l-01-greetings/1", {"lessons", "assessment", "memory"}, None),
    ("GET", "/internal/v1/versions/lesson/l-01-greetings", {"lessons", "assessment", "memory"}, None),
    ("GET", "/internal/v1/versions/rubric/r-lesson-core/1", {"lessons", "assessment"}, None),
    ("GET", "/internal/v1/media/requests", {"telegram-bff"}, None),
    ("POST", "/internal/v1/media/requests", {"telegram-bff"}, REQUEST),
    ("GET", f"/internal/v1/media/requests/{RID}", {"telegram-bff", "notifications"}, None),
    # спринт 5
    ("GET", "/internal/v1/readings?audience=adults", {"telegram-bff", "lessons"}, None),
    ("GET", "/internal/v1/readings/r-a1-coffee-shop?audience=adults", {"telegram-bff", "lessons"}, None),
    ("POST", "/internal/v1/glossary/lookup", {"memory"}, LOOKUP),
    ("POST", "/internal/v1/glossary/ai-entries", {"memory"}, AI_ENTRY),
    ("GET", "/internal/v1/glossary/forms?pair_id=ru-en&forms=cat", {"memory"}, None),
    ("GET", "/internal/v1/skills/en.func.greet/check-items?audience=adults", {"memory"}, None),
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


@pytest.mark.parametrize(("method", "path", "allowed", "body"), INTERNAL,
                         ids=[f"{m} {p}" for m, p, _, _ in INTERNAL])
async def test_internal_route_callers(env, method: str, path: str, allowed: set[str], body) -> None:
    r = await _call(env, method, path, body, {})
    assert r.status_code == 401
    for caller in ("telegram-bff", "learning-plan", "diagnostics", "notifications", "admin-bff", "support", "lessons",
                   "assessment", "ai-gateway", "memory"):
        r = await _call(env, method, path, body, env.svc(caller, str(uuid.uuid4())))
        if caller in allowed:
            assert r.status_code not in (401, 403), (caller, r.text)
        else:
            assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED", caller
