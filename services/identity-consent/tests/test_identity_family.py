"""Возраст, детские профили 6–13 (опекунство) и согласие родителя для 14–17 по ссылке (AT-03, CONVENTIONS §8)."""

from __future__ import annotations

import asyncio
import hashlib
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from conftest import REQUIRED
from sqlalchemy import func, select, text

from tilhero_identity.models import Consent, GuardianConsentRequest, GuardianLink

CHILD_SETTINGS = {
    "enabled": True,
    "categories": {"reminders": False, "missed": False, "social": False, "support": True, "product": False},
    "quiet_hours": {"start": "22:00", "end": "08:00"},
    "timezone": "Asia/Tashkent",
}


async def _gc_rows(env, teen: str) -> list[GuardianConsentRequest]:
    async with env.runtime.transaction() as s:
        return list((await s.execute(
            select(GuardianConsentRequest).where(GuardianConsentRequest.teen_user_id == uuid.UUID(teen))
            .order_by(GuardianConsentRequest.created_at)
        )).scalars())


async def _request_link(env, teen: str, key: str | None = None):
    headers = {"Idempotency-Key": key} if key else None
    return await env.call("POST", "/internal/v1/me/guardian-consent-requests", teen, headers=headers)


async def _token(env, teen: str) -> str:
    r = await _request_link(env, teen)
    assert r.status_code == 200, r.text
    return r.json()["token"]


async def _decide(env, token: str, guardian: str, decision: str = "accept"):
    return await env.call("POST", f"/internal/v1/guardian-consents/{token}/{decision}", guardian)


async def _preview(env, token: str):
    return await env.call("GET", f"/internal/v1/guardian-consents/{token}", None)


# ---------------------------------------------------------------- возраст

async def test_set_age_adult_and_teen(env) -> None:
    adult = await env.new_user()
    me = await env.set_age(adult, "18+")
    assert (me["user"]["age_band"], me["user"]["guardian_consent"]) == ("18+", "not_required")
    assert me["learners"][0]["age_band"] == "18+"
    teen = await env.new_user()
    me = await env.set_age(teen, "14-17")
    assert (me["user"]["age_band"], me["user"]["guardian_consent"]) == ("14-17", "pending")

    [a] = await env.events("user.profile.updated.v1", adult)
    assert a.payload == {"user_id": adult, "changed_fields": ["age_band"], "age_band": "18+", "is_minor": False,
                         "locale": "ru", "guardian_consent": "not_required"}
    [t] = await env.events("user.profile.updated.v1", teen)
    assert t.payload["changed_fields"] == ["age_band", "guardian_consent"]
    assert (t.payload["age_band"], t.payload["is_minor"], t.payload["guardian_consent"]) == ("14-17", True, "pending")
    assert (await env.user_row(teen)).age_set_at is not None


async def test_age_is_set_once(env) -> None:
    uid = await env.adult()
    again = await env.call("PUT", "/internal/v1/me/age", uid, {"age_band": "18+"})
    assert again.status_code == 200 and again.json()["user"]["age_band"] == "18+"  # повтор — без изменений
    changed = await env.call("PUT", "/internal/v1/me/age", uid, {"age_band": "14-17"})
    assert changed.status_code == 409 and changed.json()["code"] == "AGE_ALREADY_SET"
    assert changed.json()["details"] == {"age_band": "18+"}
    assert len(await env.events("user.profile.updated.v1", uid)) == 1


@pytest.mark.parametrize("body", [
    {"age_band": "6-9"}, {"age_band": "10-13"},  # 6–13 — только детский профиль у родителя (AT-03)
    {"age_band": "21"}, {}, {"age_band": None}, {"age_band": "18+", "birth_date": "2000-01-01"},
])
async def test_age_validation(env, body) -> None:
    uid = await env.new_user()
    r = await env.call("PUT", "/internal/v1/me/age", uid, body)
    assert r.status_code == 422 and r.json()["code"] == "VALIDATION_ERROR"
    assert (await env.user_row(uid)).age_band is None


# ---------------------------------------------------------------- детские профили

async def test_create_child_profile(env) -> None:
    guardian = await env.adult(first_name="Родитель")
    await env.call("PATCH", "/internal/v1/me/settings", guardian, {"notifications": {"timezone": "Asia/Samarkand"}})
    child = await env.child(guardian, " Мадина ", "6-9")
    cid = child["learner_id"]
    assert child == {"learner_id": cid, "kind": "child", "display_name": "Мадина", "age_band": "6-9",
                     "is_active": False, "onboarding_completed": False, "voice_consent": False,
                     "settings": {**CHILD_SETTINGS, "timezone": "Asia/Samarkand"}}
    second = await env.child(guardian, "Тимур", "10-13")

    listed = (await env.call("GET", "/internal/v1/me/learners", guardian)).json()["items"]
    assert [(x["learner_id"], x["kind"]) for x in listed] == [
        (guardian, "self"), (cid, "child"), (second["learner_id"], "child")]
    assert "settings" not in listed[1]  # список — LearnerSummary
    me = (await env.call("GET", "/internal/v1/me", guardian)).json()
    assert me["learners"] == listed

    row = await env.user_row(cid)
    assert (row.kind, row.telegram_user_id, row.username, row.status) == ("child", None, None, "ACTIVE")
    assert (row.guardian_consent, row.locale) == ("granted", "ru")
    async with env.runtime.transaction() as s:
        link = await s.get(GuardianLink, uuid.UUID(cid))
        [consent] = (await s.execute(select(Consent).where(Consent.user_id == uuid.UUID(cid)))).scalars()
    assert link is not None and str(link.guardian_user_id) == guardian
    # создание детского профиля = согласие родителя на обработку данных ребёнка (основание guardian)
    assert consent.purposes == REQUIRED and consent.basis == "guardian"
    assert str(consent.granted_by_user_id) == guardian and consent.age_band == "6-9"

    created = [e for e in await env.events("user.profile.created.v1") if e.payload["kind"] == "child"]
    assert [e.payload["user_id"] for e in created] == [cid, second["learner_id"]]
    assert created[0].payload == {"user_id": cid, "kind": "child", "locale": "ru", "age_band": "6-9",
                                  "guardian_user_id": guardian, "created_at": created[0].payload["created_at"]}
    [accepted] = await env.events("consent.accepted.v1", cid)
    assert accepted.payload["purposes"] == REQUIRED and accepted.payload["age_band"] == "6-9"
    # имени ребёнка нет ни в событиях, ни в outbox
    assert "Мадина" not in await env.outbox_dump()


async def test_create_child_requires_adult(env) -> None:
    body = {"display_name": "Мадина", "age_band": "6-9"}
    no_age = await env.new_user()
    r = await env.call("POST", "/internal/v1/me/learners", no_age, body)
    assert r.status_code == 403 and r.json()["code"] == "ADULT_REQUIRED" and r.json()["details"] == {"age_band": None}
    teen = await env.teen()
    r = await env.call("POST", "/internal/v1/me/learners", teen, body)
    assert r.status_code == 403 and r.json()["details"] == {"age_band": "14-17"}
    async with env.runtime.transaction() as s:
        assert (await s.execute(select(func.count()).select_from(GuardianLink))).scalar_one() == 0


async def test_children_limit_is_five_even_in_parallel(env) -> None:
    guardian = await env.adult()
    results = await asyncio.gather(*[
        env.call("POST", "/internal/v1/me/learners", guardian, {"display_name": f"Ребёнок {i}", "age_band": "6-9"})
        for i in range(8)
    ])
    assert sorted(r.status_code for r in results) == [201] * 5 + [409] * 3
    refused = [r.json() for r in results if r.status_code == 409]
    assert all(b["code"] == "CHILDREN_LIMIT" and b["details"] == {"limit": 5} for b in refused)
    listed = (await env.call("GET", "/internal/v1/me/learners", guardian)).json()["items"]
    assert len(listed) == 6
    # лимит — на аккаунт: у другого родителя свой счёт
    other = await env.adult()
    await env.child(other)


async def test_create_child_idempotency(env) -> None:
    guardian = await env.adult()
    key = f"child-{uuid.uuid4().hex}"
    first = await env.child(guardian, "Мадина", key=key)
    again = await env.child(guardian, "Мадина", key=key)
    assert again == first
    reused = await env.call("POST", "/internal/v1/me/learners", guardian,
                            {"display_name": "Тимур", "age_band": "6-9"}, headers={"Idempotency-Key": key})
    assert reused.status_code == 422 and reused.json()["code"] == "IDEMPOTENCY_KEY_REUSED"
    for bad in ("short", "x" * 129, "bad key!"):
        r = await env.call("POST", "/internal/v1/me/learners", guardian,
                           {"display_name": "Тимур", "age_band": "6-9"}, headers={"Idempotency-Key": bad})
        assert r.status_code == 422 and r.json()["code"] == "IDEMPOTENCY_KEY_INVALID"
    # тот же ключ у другого родителя — независимая команда
    other = await env.adult()
    assert (await env.child(other, "Мадина", key=key))["learner_id"] != first["learner_id"]
    assert len((await env.call("GET", "/internal/v1/me/learners", guardian)).json()["items"]) == 2
    assert len([e for e in await env.events("user.profile.created.v1") if e.payload["kind"] == "child"]) == 2


@pytest.mark.parametrize("body", [
    {"display_name": "", "age_band": "6-9"},
    {"display_name": "   ", "age_band": "6-9"},
    {"display_name": "М" * 41, "age_band": "6-9"},
    {"display_name": "Ма‮дина", "age_band": "6-9"},
    {"display_name": "Ма\nдина", "age_band": "6-9"},
    {"display_name": "Мадина", "age_band": "14-17"},
    {"display_name": "Мадина", "age_band": "18+"},
    {"display_name": "Мадина"},
    {"display_name": "Мадина", "age_band": "6-9", "telegram_user_id": 1},
])
async def test_create_child_validation(env, body) -> None:
    guardian = await env.adult()
    r = await env.call("POST", "/internal/v1/me/learners", guardian, body)
    assert r.status_code == 422 and r.json()["code"] == "VALIDATION_ERROR", r.text


async def test_learner_access_is_isolated(env) -> None:
    guardian = await env.adult()
    child = await env.child(guardian)
    stranger = await env.adult()
    stranger_child = await env.child(stranger, "Чужой")

    own = await env.call("GET", f"/internal/v1/me/learners/{child['learner_id']}", guardian)
    assert own.status_code == 200 and own.json() == child
    me = await env.call("GET", f"/internal/v1/me/learners/{guardian}", guardian)
    assert me.status_code == 200 and me.json()["kind"] == "self" and me.json()["settings"]["enabled"] is False
    for learner in (stranger_child["learner_id"], stranger, str(uuid.uuid4())):
        for method, body in (("GET", None), ("PATCH", {"display_name": "Взлом"})):
            r = await env.call(method, f"/internal/v1/me/learners/{learner}", guardian, body)
            assert r.status_code == 404 and r.json()["code"] == "LEARNER_NOT_FOUND", (method, learner)
    assert (await env.call("GET", "/internal/v1/me/learners/abc", guardian)).status_code == 422
    assert (await env.user_row(stranger_child["learner_id"])).display_name == "Чужой"


async def test_patch_child_name_and_notifications(env) -> None:
    guardian = await env.adult()
    child = await env.child(guardian)
    cid = child["learner_id"]
    r = await env.call("PATCH", f"/internal/v1/me/learners/{cid}", guardian, {
        "display_name": "Мадинахон",
        "settings": {"categories": {"reminders": True, "missed": True}, "quiet_hours": {"start": "21:00",
                                                                                        "end": "07:00"}},
    })
    assert r.status_code == 200, r.text
    assert r.json()["display_name"] == "Мадинахон"
    assert r.json()["settings"]["categories"]["reminders"] is True
    assert r.json()["settings"]["quiet_hours"] == {"start": "21:00", "end": "07:00"}
    # повтор того же — без событий
    await env.call("PATCH", f"/internal/v1/me/learners/{cid}", guardian, {"display_name": "Мадинахон"})
    [renamed] = await env.events("user.profile.updated.v1", cid)
    assert renamed.payload["changed_fields"] == ["display_name"] and "Мадинахон" not in renamed.to_json()
    [notify] = await env.events("user.notification_settings.changed.v1", cid)
    # enabled — итоговая доставка ребёнку: выключатель ребёнка включён, опекун активен и не блокировал бота
    assert notify.payload == {"user_id": cid, "enabled": True, "categories": ["reminders", "missed", "support"]}
    assert (await env.delivery(cid)).json()["notifications_enabled"] is True

    # свой профиль через learners не меняется (для этого PATCH /me/settings)
    r = await env.call("PATCH", f"/internal/v1/me/learners/{guardian}", guardian, {"display_name": "Я"})
    assert r.status_code == 404 and r.json()["code"] == "LEARNER_NOT_FOUND"
    for body, code in (
        ({"settings": {"quiet_hours": {"start": "10:00", "end": "10:00"}}}, "QUIET_HOURS_INVALID"),
        ({"display_name": ""}, "VALIDATION_ERROR"),
        ({"age_band": "10-13"}, "VALIDATION_ERROR"),  # возраст ребёнка — через поддержку
        ({"settings": {"locale": "uz"}}, "VALIDATION_ERROR"),
    ):
        r = await env.call("PATCH", f"/internal/v1/me/learners/{cid}", guardian, body)
        assert r.status_code == 422 and r.json()["code"] == code, body
    # родитель отключил TilHero — включить уведомления ребёнку нельзя
    await env.call("PATCH", f"/internal/v1/me/learners/{cid}", guardian, {"settings": {"enabled": False}})
    await env.call("POST", "/internal/v1/me/disable", guardian)
    r = await env.call("PATCH", f"/internal/v1/me/learners/{cid}", guardian, {"settings": {"enabled": True}})
    assert r.status_code == 409 and r.json()["code"] == "USER_DISABLED"


async def test_guardian_locale_change_applies_to_children(env) -> None:
    guardian = await env.adult()
    child = await env.child(guardian)
    await env.call("PATCH", "/internal/v1/me/settings", guardian, {"locale": "uz"})
    assert (await env.user_row(child["learner_id"])).locale == "uz"
    [ev] = await env.events("user.profile.updated.v1", child["learner_id"])
    assert ev.payload["changed_fields"] == ["locale"] and ev.payload["locale"] == "uz"
    assert (await env.delivery(child["learner_id"])).json()["locale"] == "uz"


# ---------------------------------------------------------------- согласие родителя 14–17

async def test_guardian_consent_accept_flow(env) -> None:
    teen = await env.teen(first_name="Подросток")
    parent = await env.parent()
    r = await _request_link(env, teen)
    assert r.status_code == 200, r.text
    token, expires_at = r.json()["token"], datetime.fromisoformat(r.json()["expires_at"])
    assert len(token) == 43 and "=" not in token
    assert timedelta(days=6, hours=23) < expires_at - datetime.now(UTC) <= timedelta(days=7)

    preview = await _preview(env, token)
    assert preview.status_code == 200
    assert preview.json() == {"teen_display_name": "Подросток", "status": "pending",
                              "expires_at": r.json()["expires_at"]}
    accepted = await _decide(env, token, parent)
    assert accepted.status_code == 200 and accepted.json()["status"] == "granted"
    me = (await env.call("GET", "/internal/v1/me", teen)).json()
    assert me["user"]["guardian_consent"] == "granted"
    assert (await _preview(env, token)).json()["status"] == "granted"

    [row] = await _gc_rows(env, teen)
    assert row.status == "granted" and str(row.guardian_user_id) == parent and row.decided_at is not None
    # в БД — только sha256 токена; сам токен не хранится и не попадает в события
    assert row.token_hash == hashlib.sha256(token.encode()).hexdigest()
    async with env.runtime.transaction() as s:
        dump = repr((await s.execute(text("SELECT * FROM guardian_consent_requests"))).all())
    assert token not in dump and token not in await env.outbox_dump()
    updates = [e.payload for e in await env.events("user.profile.updated.v1", teen)]
    assert [(u["changed_fields"], u["guardian_consent"]) for u in updates] == [
        (["age_band", "guardian_consent"], "pending"), (["guardian_consent"], "granted")]
    # согласие получено — новая ссылка не нужна
    again = await _request_link(env, teen)
    assert again.status_code == 409 and again.json()["code"] == "GUARDIAN_CONSENT_NOT_REQUIRED"


async def test_guardian_consent_decline_then_new_link(env) -> None:
    teen = await env.teen()
    parent = await env.parent()
    first = await _token(env, teen)
    declined = await _decide(env, first, parent, "decline")
    assert declined.status_code == 200 and declined.json()["status"] == "declined"
    assert (await env.user_row(teen)).guardian_consent == "declined"
    # решение по ссылке не меняется: повтор и обратное решение — 200 с прежним статусом
    assert (await _decide(env, first, parent, "accept")).json()["status"] == "declined"
    # подросток может попросить снова — новая ссылка, снова pending
    second = await _token(env, teen)
    assert second != first and (await env.user_row(teen)).guardian_consent == "pending"
    assert (await _preview(env, first)).json()["status"] == "declined"
    assert (await _decide(env, second, parent)).json()["status"] == "granted"
    assert (await env.user_row(teen)).guardian_consent == "granted"


async def test_new_link_revokes_previous(env) -> None:
    teen = await env.teen()
    parent = await env.parent()
    old = await _token(env, teen)
    new = await _token(env, teen)
    assert (await _preview(env, old)).json()["status"] == "expired"
    r = await _decide(env, old, parent)
    assert r.status_code == 410 and r.json()["code"] == "GUARDIAN_CONSENT_EXPIRED"
    assert [row.status for row in await _gc_rows(env, teen)] == ["revoked", "pending"]
    assert (await _decide(env, new, parent)).status_code == 200


async def test_guardian_consent_errors(env) -> None:
    teen = await env.teen()
    token = await _token(env, teen)
    # сам себе — нельзя
    r = await _decide(env, token, teen)
    assert r.status_code == 409 and r.json()["code"] == "GUARDIAN_CONSENT_SELF"
    # решает только взрослый аккаунт (возраст не выбран или подросток → 403)
    for other in (await env.new_user(), await env.teen()):
        r = await _decide(env, token, other)
        assert r.status_code == 403 and r.json()["code"] == "ADULT_REQUIRED"
    # неизвестный и некорректный токен неотличимы
    for bad in ("B" * 43, "short", "x" * 128, "A" * 42 + "!"):
        for r in (await _preview(env, bad), await _decide(env, bad, teen)):
            assert r.status_code == 404 and r.json()["code"] == "GUARDIAN_CONSENT_NOT_FOUND", bad
    # ссылка истекла
    async with env.runtime.transaction() as s:
        await s.execute(text("UPDATE guardian_consent_requests SET created_at = now() - interval '8 days', "
                             "expires_at = now() - interval '1 day'"))
    assert (await _preview(env, token)).json()["status"] == "expired"
    r = await _decide(env, token, await env.parent())
    assert r.status_code == 410 and r.json()["code"] == "GUARDIAN_CONSENT_EXPIRED"
    assert (await env.user_row(teen)).guardian_consent == "pending"
    # взрослому и без выбранного возраста согласие родителя не нужно
    for uid in (await env.adult(), await env.new_user()):
        r = await _request_link(env, uid)
        assert r.status_code == 409 and r.json()["code"] == "GUARDIAN_CONSENT_NOT_REQUIRED"
    assert (await _decide(env, token, teen, "approve")).status_code == 404  # нет такого действия


async def test_guardian_consent_repeat_and_parallel_decisions(env) -> None:
    teen = await env.teen()
    parents = [await env.parent() for _ in range(3)]
    token = await _token(env, teen)
    results = await asyncio.gather(*[_decide(env, token, p) for p in parents],
                                   *[_decide(env, token, p, "decline") for p in parents])
    assert all(r.status_code == 200 for r in results)
    final = {r.json()["status"] for r in results}
    [row] = await _gc_rows(env, teen)
    assert row.status in ("granted", "declined") and str(row.guardian_user_id) in parents
    assert final <= {"granted", "declined"} and (await _preview(env, token)).json()["status"] == row.status
    # решение принято один раз
    decided = [e for e in await env.events("user.profile.updated.v1", teen)
               if e.payload["guardian_consent"] in ("granted", "declined")]
    assert len(decided) == 1


async def test_guardian_consent_request_idempotency(env) -> None:
    teen = await env.teen()
    key = f"gc-{uuid.uuid4().hex}"
    first = await _request_link(env, teen, key)
    again = await _request_link(env, teen, key)
    assert first.status_code == again.status_code == 200 and first.json() == again.json()
    assert len(await _gc_rows(env, teen)) == 1
    bad = await _request_link(env, teen, "bad key")
    assert bad.status_code == 422 and bad.json()["code"] == "IDEMPOTENCY_KEY_INVALID"


async def test_guardian_consent_preview_hidden_after_teen_deletion(env) -> None:
    teen = await env.teen()
    token = await _token(env, teen)
    r = await env.call("POST", "/internal/v1/me/deletion-request", teen, {"confirm_word": "УДАЛИТЬ"})
    assert r.status_code == 202
    assert (await _preview(env, token)).json()["status"] == "expired"  # ссылка отозвана удалением
    r = await _decide(env, token, await env.parent())
    assert r.status_code == 410 and (await env.user_row(teen)).guardian_consent == "pending"
