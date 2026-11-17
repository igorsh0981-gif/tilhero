"""Согласие: 18+, версия политики, обязательные цели, evidence_hash, история, отзыв; события по схемам."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select, text

from tilhero_identity.domain.evidence import evidence_hash
from tilhero_identity.domain.policy import get_policy
from tilhero_identity.models import Consent


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
    uid = await env.new_user(language_code="ru")
    r = await env.consent(uid, ["notifications", "personalization"])
    assert r.status_code == 200, r.text
    state = r.json()
    assert state["accepted"] is True and state["policy_version"] == "1.0"
    assert state["current_policy_version"] == "1.0" and state["age_confirmed_18_plus"] is True
    assert len(state["evidence_hash"]) == 64 and state["accepted_at"].endswith("Z")

    [row] = await _consents(env, uid)
    assert row.purposes == ["personalization", "notifications"] and row.channel == "telegram"
    assert row.locale == "ru" and row.revoked_at is None and row.age_confirmed_18_plus
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
        )
    )

    me = (await env.call("GET", "/internal/v1/me", uid)).json()
    assert me["consent"] == state and me["settings"]["enabled"] is True

    [event] = await env.events("consent.accepted.v1", uid)
    assert event.payload == {
        "user_id": uid,
        "consent_id": str(row.consent_id),
        "policy_version": "1.0",
        "purposes": ["personalization", "notifications"],
        "age_confirmed_18_plus": True,
    }


async def test_repeat_is_idempotent_and_change_supersedes(env) -> None:
    uid = await env.new_user()
    first = (await env.consent(uid, ["personalization", "notifications"])).json()
    repeat = (await env.consent(uid, ["notifications", "personalization", "personalization"])).json()
    assert repeat == first
    assert len(await env.events("consent.accepted.v1", uid)) == 1

    narrowed = (await env.consent(uid, ["personalization"])).json()
    assert narrowed["evidence_hash"] != first["evidence_hash"] and narrowed["accepted"]
    rows = await _consents(env, uid)
    assert len(rows) == 2
    assert rows[0].revoke_reason == "superseded" and rows[0].revoked_at is not None
    assert rows[1].revoked_at is None and rows[1].purposes == ["personalization"]
    assert (await env.call("GET", "/internal/v1/me", uid)).json()["settings"]["enabled"] is False
    assert len(await env.events("consent.accepted.v1", uid)) == 2
    assert await env.events("consent.revoked.v1", uid) == []  # замена — не отзыв


@pytest.mark.parametrize(
    ("body", "status", "code"),
    [
        (
            {"policy_version": "1.0", "purposes": ["personalization"], "age_confirmed_18_plus": False},
            422,
            "AGE_CONFIRMATION_REQUIRED",
        ),
        ({"policy_version": "1.0", "purposes": ["personalization"]}, 422, "AGE_CONFIRMATION_REQUIRED"),
        (
            {"policy_version": "0.9", "purposes": ["personalization"], "age_confirmed_18_plus": True},
            409,
            "POLICY_VERSION_OUTDATED",
        ),
        (
            {"policy_version": "1.0", "purposes": ["notifications"], "age_confirmed_18_plus": True},
            422,
            "CONSENT_PURPOSES_INVALID",
        ),
        (
            {"policy_version": "1.0", "purposes": [], "age_confirmed_18_plus": True},
            422,
            "CONSENT_PURPOSES_INVALID",
        ),
        (
            {"policy_version": "1.0", "purposes": ["personalization", "ads"], "age_confirmed_18_plus": True},
            422,
            "CONSENT_PURPOSES_INVALID",
        ),
        (
            {
                "policy_version": "1.0",
                "purposes": ["personalization"],
                "age_confirmed_18_plus": True,
                "accepted_at": "2020-01-01T00:00:00Z",
            },
            422,
            "VALIDATION_ERROR",
        ),
        (
            {"policy_version": "1.0", "purposes": ["p" * 33], "age_confirmed_18_plus": True},
            422,
            "VALIDATION_ERROR",
        ),
        (
            {"policy_version": "1.0", "purposes": ["personalization"] * 11, "age_confirmed_18_plus": True},
            422,
            "VALIDATION_ERROR",
        ),
        ({"purposes": ["personalization"], "age_confirmed_18_plus": True}, 422, "VALIDATION_ERROR"),
    ],
)
async def test_consent_rejections(env, body, status, code) -> None:
    uid = await env.new_user()
    r = await env.call("POST", "/internal/v1/me/consent", uid, body)
    assert r.status_code == status and r.json()["code"] == code, r.text
    assert await _consents(env, uid) == []
    if code == "POLICY_VERSION_OUTDATED":
        assert r.json()["details"] == {"current_policy_version": "1.0"}
    if code == "CONSENT_PURPOSES_INVALID" and "ads" in body["purposes"]:
        assert r.json()["details"] == {"unknown": ["ads"], "missing_required": []}
    me = (await env.call("GET", "/internal/v1/me", uid)).json()
    assert me["consent"]["accepted"] is False and me["consent"]["age_confirmed_18_plus"] is False


async def test_revoke_consent(env) -> None:
    uid = await env.new_user()
    accepted = (await env.consent(uid)).json()
    r = await env.call("DELETE", "/internal/v1/me/consent", uid)
    assert r.status_code == 200
    assert r.json() == {
        "accepted": False,
        "policy_version": None,
        "current_policy_version": "1.0",
        "accepted_at": None,
        "evidence_hash": None,
        "age_confirmed_18_plus": True,
    }
    assert (await env.call("GET", "/internal/v1/me", uid)).json()["settings"]["enabled"] is False
    [row] = await _consents(env, uid)
    assert row.revoke_reason == "user" and row.evidence_hash == accepted["evidence_hash"]  # история сохранена
    again = await env.call("DELETE", "/internal/v1/me/consent", uid)
    assert again.status_code == 200 and again.json()["accepted"] is False
    [event] = await env.events("consent.revoked.v1", uid)
    assert event.payload == {"user_id": uid, "consent_id": str(row.consent_id), "policy_version": "1.0"}

    # повторное согласие после отзыва — новая запись
    renewed = (await env.consent(uid)).json()
    assert renewed["accepted"] and renewed["evidence_hash"] != accepted["evidence_hash"]
    assert len(await _consents(env, uid)) == 2


async def test_consent_is_isolated_per_user(env) -> None:
    a = await env.new_user()
    b = await env.new_user()
    await env.consent(a)
    assert (await env.call("GET", "/internal/v1/me", b)).json()["consent"]["accepted"] is False
    await env.call("DELETE", "/internal/v1/me/consent", b)
    assert (await env.call("GET", "/internal/v1/me", a)).json()["consent"]["accepted"] is True


async def test_consent_locale_follows_user_language(env) -> None:
    uid = await env.new_user(language_code="en")
    await env.consent(uid)
    [row] = await _consents(env, uid)
    assert row.locale == "en" and row.policy_text_sha256 == get_policy("1.0").text_sha256("en")


async def test_consent_rows_are_immutable_evidence(env) -> None:
    uid = await env.new_user()
    await env.consent(uid)
    for stmt in (
        "UPDATE consents SET purposes = ARRAY['personalization']::varchar[]",
        "UPDATE consents SET evidence_hash = repeat('0', 64)",
        "UPDATE consents SET accepted_at = now()",
        "DELETE FROM consents",
    ):
        with pytest.raises(Exception, match="immutable evidence"):
            async with env.runtime.transaction() as s:
                await s.execute(text(stmt))
    await env.call("DELETE", "/internal/v1/me/consent", uid)
    with pytest.raises(Exception, match="revocation is final"):
        async with env.runtime.transaction() as s:
            await s.execute(text("UPDATE consents SET revoked_at = NULL, revoke_reason = NULL"))
