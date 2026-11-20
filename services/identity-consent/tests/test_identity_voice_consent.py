"""Спринт 5 (INTERNAL_API §6, PLAN «Решения владельца», AT-58): согласие опекуна на запись голоса детского профиля —
PUT /internal/v1/me/learners/{child_id}/voice-consent {granted}: только аккаунт 18+ со своим действующим согласием
(иначе 403 ADULT_REQUIRED / CONSENT_REQUIRED), только свой ребёнок (иначе 404); новая запись согласия ребёнка
`basis: guardian` (обязательные цели + voice_recording при granted), consent.accepted.v1, повтор того же значения —
без записи. `/public` детского профиля — voice_recording, если её дал опекун (остальные необязательные — никогда);
memory допущен к `/public`. LearnerSummary/LearnerDetail.voice_consent: аккаунт — своя цель (подросток — после
согласия родителя), ребёнок — согласие опекуна."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest
from conftest import ALL_PURPOSES, REQUIRED
from sqlalchemy import select

from tilhero_identity.domain.evidence import evidence_hash
from tilhero_identity.domain.policy import get_policy
from tilhero_identity.models import Consent, User
from tilhero_identity.service import learner_purposes, voice_consent

VOICE = "voice_recording"


def path(child_id: str) -> str:
    return f"/internal/v1/me/learners/{child_id}/voice-consent"


async def put(env, account: str | None, child_id: str, granted: object, issuer: str = "telegram-bff"):
    return await env.call("PUT", path(child_id), account, {"granted": granted}, issuer=issuer)


async def consents(env, uid: str) -> list[Consent]:
    async with env.runtime.transaction() as s:
        return list((await s.execute(
            select(Consent).where(Consent.user_id == uuid.UUID(uid)).order_by(Consent.accepted_at, Consent.consent_id)
        )).scalars())


async def active(env, uid: str, basis: str = "guardian") -> Consent:
    return next(c for c in await consents(env, uid) if c.basis == basis and c.revoked_at is None)


async def learners(env, account: str) -> dict[str, dict]:
    r = await env.call("GET", "/internal/v1/me/learners", account)
    assert r.status_code == 200, r.text
    return {x["learner_id"]: x for x in r.json()["items"]}


async def family(env, **kw) -> tuple[str, str]:
    parent = await env.parent(**kw)
    child = await env.child(parent)
    assert child["voice_consent"] is False
    return parent, child["learner_id"]


# ---------------------------------------------------------------- happy path, /public, события


async def test_guardian_grants_and_withdraws_child_voice_consent(env) -> None:
    parent, cid = await family(env, language_code="uz")
    r = await put(env, parent, cid, True)
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["learner_id"], body["kind"], body["voice_consent"]) == (cid, "child", True)
    assert "settings" in body  # LearnerDetail, как у PATCH /me/learners/{id}
    assert (await learners(env, parent))[cid]["voice_consent"] is True
    assert (await learners(env, parent))[parent]["voice_consent"] is False  # своё согласие родителя — без голоса
    detail = (await env.call("GET", f"/internal/v1/me/learners/{cid}", parent)).json()
    assert detail["voice_consent"] is True
    pub = (await env.public(cid, issuer="memory")).json()
    assert (pub["kind"], pub["consent_accepted"], pub["purposes"]) == ("child", True, [*REQUIRED, VOICE])

    rows = await consents(env, cid)
    assert [(c.purposes, c.revoke_reason) for c in rows] == [(REQUIRED, "superseded"), ([*REQUIRED, VOICE], None)]
    new = rows[-1]
    assert (new.basis, str(new.granted_by_user_id), new.age_band, new.locale) == ("guardian", parent, "6-9", "uz")
    assert new.policy_text_sha256 == get_policy(new.policy_version).text_sha256("uz")  # родитель читал политику
    assert new.evidence_hash == evidence_hash(
        user_id=new.user_id, policy_version=new.policy_version, purposes=list(new.purposes),
        accepted_at=new.accepted_at, channel=new.channel, locale=new.locale,
        policy_text_sha256=new.policy_text_sha256, age_band=new.age_band, basis=new.basis,
        granted_by=new.granted_by_user_id)
    events = await env.events("consent.accepted.v1", cid)
    assert [e.payload["purposes"] for e in events] == [REQUIRED, [*REQUIRED, VOICE]]
    last = events[-1].payload
    assert (last["basis"], last["granted_by_user_id"], last["consent_id"], last["age_band"]) == (
        "guardian", parent, str(new.consent_id), "6-9")

    # снятие — новая запись без цели
    r = await put(env, parent, cid, False)
    assert r.status_code == 200 and r.json()["voice_consent"] is False
    assert (await env.public(cid, issuer="memory")).json()["purposes"] == REQUIRED
    rows = await consents(env, cid)
    assert [c.purposes for c in rows] == [REQUIRED, [*REQUIRED, VOICE], REQUIRED]
    assert [c.revoke_reason for c in rows] == ["superseded", "superseded", None]
    assert [e.payload["purposes"] for e in await env.events("consent.accepted.v1", cid)] == [
        REQUIRED, [*REQUIRED, VOICE], REQUIRED]
    # категории доставки от цели не зависят: событий настроек нет, доставка ребёнка прежняя
    assert await env.events("user.notification_settings.changed.v1", cid) == []
    assert (await env.delivery(cid)).json()["categories"] == ["support"]
    assert await env.events("consent.revoked.v1", cid) == []


async def test_repeat_same_value_without_new_record(env) -> None:
    parent, cid = await family(env)
    r = await put(env, parent, cid, False)  # уже нет — без записи
    assert r.status_code == 200 and r.json()["voice_consent"] is False
    assert len(await consents(env, cid)) == 1
    for _ in range(3):
        r = await put(env, parent, cid, True)
        assert r.status_code == 200 and r.json()["voice_consent"] is True
    assert len(await consents(env, cid)) == 2
    assert len(await env.events("consent.accepted.v1", cid)) == 2  # создание профиля + одно разрешение


async def test_children_isolated(env) -> None:
    parent, first = await family(env)
    second = (await env.child(parent, "Тимур", "10-13"))["learner_id"]
    await put(env, parent, first, True)
    listed = await learners(env, parent)
    assert (listed[first]["voice_consent"], listed[second]["voice_consent"]) == (True, False)
    assert VOICE not in (await env.public(second, issuer="memory")).json()["purposes"]
    assert len(await consents(env, second)) == 1


# ---------------------------------------------------------------- права и ошибки


async def test_only_adult_with_own_consent(env) -> None:
    # взрослый без своего согласия (создать ребёнка можно, разрешать функции — нет)
    adult = await env.adult()
    cid = (await env.child(adult))["learner_id"]
    r = await put(env, adult, cid, True)
    assert (r.status_code, r.json()["code"], r.json()["details"]) == (403, "CONSENT_REQUIRED", {"purpose": "terms"})
    assert (await env.consent(adult)).status_code == 200
    assert (await put(env, adult, cid, True)).status_code == 200
    # отозвал своё согласие — снова нельзя (разрешение ребёнка остаётся)
    await env.call("DELETE", "/internal/v1/me/consent", adult)
    r = await put(env, adult, cid, False)
    assert (r.status_code, r.json()["code"]) == (403, "CONSENT_REQUIRED")
    assert (await env.public(cid, issuer="memory")).json()["purposes"] == [*REQUIRED, VOICE]
    # подросток и аккаунт без возраста — не опекуны
    teen = await env.teen()
    await env.consent(teen)
    no_age = await env.new_user()
    for uid, band in ((teen, "14-17"), (no_age, None)):
        r = await put(env, uid, cid, True)
        assert (r.status_code, r.json()["code"], r.json()["details"]) == (403, "ADULT_REQUIRED", {"age_band": band})


async def test_foreign_self_and_unknown_child_404(env) -> None:
    parent, cid = await family(env)
    other = await env.parent()
    other_child = (await env.child(other))["learner_id"]
    for target in (other_child, parent, str(uuid.uuid4())):
        r = await put(env, parent, target, True)
        assert (r.status_code, r.json()["code"]) == (404, "LEARNER_NOT_FOUND"), target
    # чужой опекун не может разрешить голос моему ребёнку
    r = await put(env, other, cid, True)
    assert (r.status_code, r.json()["code"]) == (404, "LEARNER_NOT_FOUND")
    assert len(await consents(env, cid)) == 1 and len(await consents(env, other_child)) == 1
    # детский профиль сам ничего не вызывает (sub = ребёнок)
    r = await put(env, cid, cid, True)
    assert (r.status_code, r.json()["code"]) == (404, "USER_NOT_FOUND")


async def test_auth_and_validation(env) -> None:
    parent, cid = await family(env)
    r = await put(env, None, cid, True)
    assert r.status_code == 401
    assert (await env.client.put(path(cid), json={"granted": True})).status_code == 401
    for issuer in ("memory", "admin-bff", "social", "notifications"):
        r = await put(env, parent, cid, True, issuer=issuer)
        assert (r.status_code, r.json()["code"]) == (403, "CALLER_NOT_ALLOWED"), issuer
    for bad in ({"granted": "yes"}, {"granted": 1}, {}, {"granted": True, "who": "self"}, {"granted": None}):
        r = await env.call("PUT", path(cid), parent, bad)
        assert (r.status_code, r.json()["code"]) == (422, "VALIDATION_ERROR"), bad
    r = await env.call("PUT", "/internal/v1/me/learners/not-a-uuid/voice-consent", parent, {"granted": True})
    assert r.status_code == 422
    assert len(await consents(env, cid)) == 1


async def test_after_deletion_request_no_changes(env) -> None:
    parent, cid = await family(env)
    r = await env.call("POST", "/internal/v1/me/deletion-request", parent, {"confirm_word": "УДАЛИТЬ"})
    assert r.status_code == 202, r.text
    r = await put(env, parent, cid, True)
    assert (r.status_code, r.json()["code"]) == (409, "USER_DELETION_REQUESTED")


# ---------------------------------------------------------------- voice_consent аккаунта и /public


async def test_account_voice_consent_adult_and_teen(env) -> None:
    adult = await env.parent()
    assert (await learners(env, adult))[adult]["voice_consent"] is False
    await env.consent(adult, [*REQUIRED, VOICE])
    assert (await learners(env, adult))[adult]["voice_consent"] is True
    me = (await env.call("GET", "/internal/v1/me", adult)).json()
    assert me["learners"][0]["voice_consent"] is True
    assert (await env.public(adult, issuer="memory")).json()["purposes"] == [*REQUIRED, VOICE]

    # подросток: цель только после согласия родителя; отзыв родителем — снова нет
    teen = await env.teen()
    await env.consent(teen)
    r = await env.consent(teen, [*REQUIRED, VOICE])
    assert (r.status_code, r.json()["code"]) == (403, "GUARDIAN_CONSENT_REQUIRED")
    assert (await learners(env, teen))[teen]["voice_consent"] is False
    token = (await env.call("POST", "/internal/v1/me/guardian-consent-requests", teen)).json()["token"]
    assert (await env.call("POST", f"/internal/v1/guardian-consents/{token}/accept", adult)).status_code == 200
    assert (await learners(env, teen))[teen]["voice_consent"] is False  # разрешено, но подросток не включил
    assert (await env.consent(teen, [*REQUIRED, VOICE])).status_code == 200
    assert (await learners(env, teen))[teen]["voice_consent"] is True
    assert VOICE in (await env.public(teen, issuer="memory")).json()["purposes"]
    r = await env.call("POST", f"/internal/v1/me/guardian-consents/{teen}:revoke", adult)
    assert r.status_code == 200, r.text
    assert (await learners(env, teen))[teen]["voice_consent"] is False
    assert VOICE not in (await env.public(teen, issuer="memory")).json()["purposes"]
    # опекун подростка не может включить голос через ручку детского профиля
    r = await put(env, adult, teen, True)
    assert (r.status_code, r.json()["code"]) == (404, "LEARNER_NOT_FOUND")


async def test_public_callers_include_memory(env) -> None:
    _, cid = await family(env)
    for caller in ("social", "notifications", "memory"):
        assert (await env.public(cid, issuer=caller)).status_code == 200, caller
    for caller in ("telegram-bff", "lessons", "learning-plan", "ai-gateway"):
        r = await env.public(cid, issuer=caller)
        assert (r.status_code, r.json()["code"]) == (403, "CALLER_NOT_ALLOWED"), caller


async def test_admin_snapshot_shows_child_voice_purpose(env) -> None:
    parent, cid = await family(env)
    await put(env, parent, cid, True)
    r = await env.call("GET", f"/admin/v1/users/{cid}", None, issuer="user-admin")
    assert r.status_code == 200, r.text
    snap = r.json()["consent"]
    assert (snap["basis"], snap["purposes"]) == ("guardian", [*REQUIRED, VOICE])


# ---------------------------------------------------------------- домен (без БД)


def _user(kind: str, age_band: str | None, guardian_consent: str) -> User:
    return User(user_id=uuid.uuid4(), kind=kind, age_band=age_band, guardian_consent=guardian_consent)


def _consent(purposes: list[str], basis: str, policy_version: str = "1.2") -> Consent:
    return Consent(consent_id=uuid.uuid4(), user_id=uuid.uuid4(), policy_version=policy_version, purposes=purposes,
                   accepted_at=datetime.now(UTC), basis=basis)


@pytest.mark.parametrize(("kind", "age", "gc", "basis", "expected"), [
    ("child", "6-9", "granted", "guardian", [*REQUIRED, VOICE]),  # ребёнку — только голос от опекуна
    ("child", "10-13", "granted", "self", REQUIRED),  # не опекун — ничего необязательного
    ("account", "18+", "not_required", "self", ALL_PURPOSES),
    ("account", "14-17", "granted", "self", ALL_PURPOSES),
    ("account", "14-17", "pending", "self", REQUIRED),
    ("account", "14-17", "declined", "self", REQUIRED),
    ("account", None, "not_required", "self", REQUIRED),
])
def test_learner_purposes_rules(kind: str, age: str | None, gc: str, basis: str, expected: list[str]) -> None:
    """Даже если в записи согласия ребёнка оказались social/product_news, детям действует только voice_recording."""
    user = _user(kind, age, gc)
    consent = _consent(list(ALL_PURPOSES), basis)
    assert learner_purposes(user, consent) == expected
    assert voice_consent(user, consent) is (VOICE in expected)
    assert voice_consent(user, None) is False


@pytest.mark.parametrize(("kind", "age", "gc", "basis"), [
    ("account", "18+", "not_required", "self"),
    ("account", "14-17", "granted", "self"),
    ("child", "6-9", "granted", "guardian"),
])
def test_voice_from_policy_1_0_is_not_pronunciation_consent(kind: str, age: str | None, gc: str, basis: str) -> None:
    """В 1.0 voice_recording значила «хранить записи 30 дней» (без передачи в сервис оценки): после 1.1 она не даёт
    оценку произношения — нужно подтвердить согласие заново; остальные цели 1.0 действуют как раньше."""
    user = _user(kind, age, gc)
    consent = _consent(list(ALL_PURPOSES), basis, policy_version="1.0")
    assert VOICE not in learner_purposes(user, consent)
    assert voice_consent(user, consent) is False
    if kind == "account":
        assert [p for p in ALL_PURPOSES if p != VOICE] == learner_purposes(user, consent)


@pytest.mark.parametrize("version", ["1.1", "1.2"])
def test_voice_from_policy_1_1_and_1_2_counts(version: str) -> None:
    """Согласие на голос по 1.1 (допускало Azure) шире, чем по 1.2 (только наш сервер) — оба действуют."""
    user = _user("account", "18+", "not_required")
    assert voice_consent(user, _consent(list(ALL_PURPOSES), "self", policy_version=version)) is True

