"""Согласие: версия политики, обязательные и необязательные цели, возраст и согласие родителя (AT-02, AT-03),
evidence_hash, история, отзыв; события по схемам."""

from __future__ import annotations

import uuid

import pytest
from conftest import ALL_PURPOSES, REQUIRED
from sqlalchemy import select, text

from tilhero_identity.domain.evidence import evidence_hash
from tilhero_identity.domain.policy import get_policy
from tilhero_identity.models import Consent

OPTIONAL = ["voice_recording", "social", "product_news"]


async def _consents(env, uid: str) -> list[Consent]:
    async with env.runtime.transaction() as s:
        return list(
            (
                await s.execute(
                    select(Consent).where(Consent.user_id == uuid.UUID(uid)).order_by(Consent.accepted_at)
                )
            ).scalars()
        )


async def test_accept_consent_with_evidence(env) -> None:
    uid = await env.adult(language_code="ru")
    r = await env.consent(uid, ["product_news", *REQUIRED, "voice_recording"])
    assert r.status_code == 200, r.text
    state = r.json()
    assert state["accepted"] is True and state["policy_version"] == "1.0"
    assert state["current_policy_version"] == "1.0"
    assert state["purposes"] == [*REQUIRED, "voice_recording", "product_news"]  # порядок политики
    assert len(state["evidence_hash"]) == 64 and state["accepted_at"].endswith("Z")

    [row] = await _consents(env, uid)
    assert row.purposes == state["purposes"] and row.channel == "telegram"
    assert row.locale == "ru" and row.revoked_at is None
    assert (row.age_band, row.basis, row.granted_by_user_id) == ("18+", "self", None)
    assert row.policy_text_sha256 == get_policy("1.0").text_sha256("ru")
    # доказательство пересчитывается из сохранённых фактов
    assert (
        row.evidence_hash
        == state["evidence_hash"]
        == evidence_hash(
            user_id=row.user_id,
            policy_version=row.policy_version,
            purposes=row.purposes,
            accepted_at=row.accepted_at,
            channel=row.channel,
            locale=row.locale,
            policy_text_sha256=row.policy_text_sha256,
            age_band=row.age_band,
            basis=row.basis,
            granted_by=row.granted_by_user_id,
        )
    )

    me = (await env.call("GET", "/internal/v1/me", uid)).json()
    assert me["consent"] == state
    assert me["settings"]["enabled"] is True  # первое согласие включает уведомления
    assert me["settings"]["categories"]["reminders"] is False  # категории — только явным выбором

    [event] = await env.events("consent.accepted.v1", uid)
    assert event.payload == {
        "user_id": uid,
        "consent_id": str(row.consent_id),
        "policy_version": "1.0",
        "purposes": state["purposes"],
        "age_band": "18+",
    }
    [notify] = await env.events("user.notification_settings.changed.v1", uid)
    assert notify.payload == {"user_id": uid, "enabled": True, "categories": ["support"]}


async def test_refusing_voice_recording_does_not_block_onboarding(env) -> None:
    """AT-02: отказ от необязательных целей (запись голоса и др.) не блокирует онбординг."""
    uid = await env.adult()
    r = await env.consent(uid, REQUIRED)
    assert r.status_code == 200 and r.json()["accepted"] is True and r.json()["purposes"] == REQUIRED
    me = (await env.call("GET", "/internal/v1/me", uid)).json()
    assert me["consent"]["accepted"] is True and "voice_recording" not in me["consent"]["purposes"]


async def test_teen_optional_purposes_need_guardian_consent(env) -> None:
    """AT-03: 14–17 — до согласия родителя необязательные функции выключены; после — можно включить."""
    teen = await env.teen()
    for optional in (["voice_recording"], ["social"], OPTIONAL):
        r = await env.consent(teen, [*REQUIRED, *optional])
        assert r.status_code == 403 and r.json()["code"] == "GUARDIAN_CONSENT_REQUIRED"
        assert r.json()["details"] == {"age_band": "14-17", "guardian_consent": "pending", "purposes": optional}
    assert await _consents(env, teen) == []
    required = await env.consent(teen, REQUIRED)
    assert required.status_code == 200  # обязательные — сам

    token = (await env.call("POST", "/internal/v1/me/guardian-consent-requests", teen)).json()["token"]
    parent = await env.adult()
    assert (await env.call("POST", f"/internal/v1/guardian-consents/{token}/accept", parent)).status_code == 200
    r = await env.consent(teen, ALL_PURPOSES)
    assert r.status_code == 200 and r.json()["purposes"] == ALL_PURPOSES
    rows = await _consents(env, teen)
    assert [(c.revoke_reason, c.age_band) for c in rows] == [("superseded", "14-17"), (None, "14-17")]
    assert [e.payload["age_band"] for e in await env.events("consent.accepted.v1", teen)] == ["14-17", "14-17"]


async def test_declined_guardian_consent_keeps_optional_off(env) -> None:
    teen = await env.teen()
    token = (await env.call("POST", "/internal/v1/me/guardian-consent-requests", teen)).json()["token"]
    await env.call("POST", f"/internal/v1/guardian-consents/{token}/decline", await env.adult())
    r = await env.consent(teen, [*REQUIRED, "social"])
    assert r.status_code == 403 and r.json()["details"]["guardian_consent"] == "declined"


async def test_age_unknown_allows_only_required_purposes(env) -> None:
    """Возраст не выбран → необязательные цели нельзя (иначе подросток обошёл бы правило, приняв их до выбора)."""
    uid = await env.new_user()
    r = await env.consent(uid, [*REQUIRED, "product_news"])
    assert r.status_code == 403 and r.json()["code"] == "GUARDIAN_CONSENT_REQUIRED"
    assert r.json()["details"]["age_band"] is None
    ok = await env.consent(uid, REQUIRED)
    assert ok.status_code == 200
    [row] = await _consents(env, uid)
    assert row.age_band is None
    await env.set_age(uid, "18+")
    assert (await env.consent(uid, ALL_PURPOSES)).status_code == 200


async def test_repeat_is_idempotent_and_change_supersedes(env) -> None:
    uid = await env.adult()
    first = (await env.consent(uid, ALL_PURPOSES)).json()
    repeat = (await env.consent(uid, ["social", *REQUIRED, "voice_recording", "product_news", "terms"])).json()
    assert repeat == first
    assert len(await env.events("consent.accepted.v1", uid)) == 1

    narrowed = (await env.consent(uid, REQUIRED)).json()
    assert narrowed["evidence_hash"] != first["evidence_hash"] and narrowed["accepted"]
    rows = await _consents(env, uid)
    assert len(rows) == 2
    assert rows[0].revoke_reason == "superseded" and rows[0].revoked_at is not None
    assert rows[1].revoked_at is None and rows[1].purposes == REQUIRED
    # замена согласия выключатель уведомлений не трогает
    assert (await env.call("GET", "/internal/v1/me", uid)).json()["settings"]["enabled"] is True
    assert len(await env.events("consent.accepted.v1", uid)) == 2
    assert await env.events("consent.revoked.v1", uid) == []  # замена — не отзыв
    assert len(await env.events("user.notification_settings.changed.v1", uid)) == 1


@pytest.mark.parametrize(
    ("body", "status", "code", "details"),
    [
        ({"policy_version": "0.9", "purposes": REQUIRED}, 409, "POLICY_VERSION_OUTDATED",
         {"current_policy_version": "1.0"}),
        ({"policy_version": "1.0", "purposes": ["terms", "privacy"]}, 422, "CONSENT_REQUIRED_PURPOSES",
         {"missing": ["learning"]}),
        ({"policy_version": "1.0", "purposes": ["voice_recording"]}, 422, "CONSENT_REQUIRED_PURPOSES",
         {"missing": REQUIRED}),
        ({"policy_version": "1.0", "purposes": []}, 422, "CONSENT_REQUIRED_PURPOSES", {"missing": REQUIRED}),
        ({"policy_version": "1.0", "purposes": [*REQUIRED, "ads"]}, 422, "CONSENT_PURPOSES_INVALID",
         {"unknown": ["ads"]}),
        ({"policy_version": "1.0", "purposes": ["personalization", "notifications"]}, 422,
         "CONSENT_PURPOSES_INVALID", {"unknown": ["notifications", "personalization"]}),  # цели aievent
        ({"policy_version": "1.0", "purposes": REQUIRED, "age_confirmed_18_plus": True}, 422, "VALIDATION_ERROR",
         None),  # поле aievent удалено: возраст — PUT /me/age
        ({"policy_version": "1.0", "purposes": REQUIRED, "accepted_at": "2020-01-01T00:00:00Z"}, 422,
         "VALIDATION_ERROR", None),
        ({"policy_version": "1.0", "purposes": ["p" * 33]}, 422, "VALIDATION_ERROR", None),
        ({"policy_version": "1.0", "purposes": ["terms"] * 11}, 422, "VALIDATION_ERROR", None),
        ({"purposes": REQUIRED}, 422, "VALIDATION_ERROR", None),
    ],
)
async def test_consent_rejections(env, body, status, code, details) -> None:
    uid = await env.adult()
    r = await env.call("POST", "/internal/v1/me/consent", uid, body)
    assert r.status_code == status and r.json()["code"] == code, r.text
    if details is not None:
        assert r.json()["details"] == details
    assert await _consents(env, uid) == []
    me = (await env.call("GET", "/internal/v1/me", uid)).json()
    assert me["consent"]["accepted"] is False and me["settings"]["enabled"] is False


async def test_revoke_consent(env) -> None:
    uid = await env.adult()
    accepted = (await env.consent(uid)).json()
    r = await env.call("DELETE", "/internal/v1/me/consent", uid)
    assert r.status_code == 200
    assert r.json() == {
        "accepted": False,
        "policy_version": None,
        "current_policy_version": "1.0",
        "accepted_at": None,
        "evidence_hash": None,
        "purposes": [],
    }
    assert (await env.call("GET", "/internal/v1/me", uid)).json()["settings"]["enabled"] is False
    [row] = await _consents(env, uid)
    assert row.revoke_reason == "user" and row.evidence_hash == accepted["evidence_hash"]  # история сохранена
    again = await env.call("DELETE", "/internal/v1/me/consent", uid)
    assert again.status_code == 200 and again.json()["accepted"] is False
    [event] = await env.events("consent.revoked.v1", uid)
    assert event.payload == {"user_id": uid, "consent_id": str(row.consent_id), "policy_version": "1.0"}

    # повторное согласие после отзыва — новая запись, уведомления снова включены
    renewed = (await env.consent(uid)).json()
    assert renewed["accepted"] and renewed["evidence_hash"] != accepted["evidence_hash"]
    assert len(await _consents(env, uid)) == 2
    assert (await env.call("GET", "/internal/v1/me", uid)).json()["settings"]["enabled"] is True


async def test_consent_is_isolated_per_user(env) -> None:
    a = await env.adult()
    b = await env.adult()
    await env.consent(a)
    assert (await env.call("GET", "/internal/v1/me", b)).json()["consent"]["accepted"] is False
    await env.call("DELETE", "/internal/v1/me/consent", b)
    assert (await env.call("GET", "/internal/v1/me", a)).json()["consent"]["accepted"] is True


async def test_consent_locale_follows_user_language(env) -> None:
    uid = await env.adult(language_code="uz")
    await env.consent(uid)
    [row] = await _consents(env, uid)
    assert row.locale == "uz" and row.policy_text_sha256 == get_policy("1.0").text_sha256("uz")


async def test_consent_rows_are_immutable_evidence(env) -> None:
    uid = await env.adult()
    await env.consent(uid)
    for stmt in (
        "UPDATE consents SET purposes = ARRAY['terms']::varchar[]",
        "UPDATE consents SET evidence_hash = repeat('0', 64)",
        "UPDATE consents SET accepted_at = now()",
        "UPDATE consents SET age_band = '14-17'",
        "UPDATE consents SET basis = 'guardian', granted_by_user_id = user_id",
        "DELETE FROM consents",
    ):
        with pytest.raises(Exception, match="immutable evidence"):
            async with env.runtime.transaction() as s:
                await s.execute(text(stmt))
    await env.call("DELETE", "/internal/v1/me/consent", uid)
    with pytest.raises(Exception, match="revocation is final"):
        async with env.runtime.transaction() as s:
            await s.execute(text("UPDATE consents SET revoked_at = NULL, revoke_reason = NULL"))
