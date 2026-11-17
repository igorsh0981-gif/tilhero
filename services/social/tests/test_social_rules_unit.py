"""Чистые правила: токен и ссылка, кто может приглашать и принимать (дети и подростки), статус, порядок пары."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest

from tilhero_common.errors import ApiError
from tilhero_social.domain import rules
from tilhero_social.identity import Person
from tilhero_social.settings import Settings

NOW = datetime(2026, 11, 16, 8, 0, tzinfo=UTC)


def person(age: str | None = "18+", *, kind: str = "account", status: str = "ACTIVE",
           consent: str | None = None) -> Person:
    return Person(uuid.uuid4(), "Имя", kind, age, status, consent)


def test_token_is_hmac_of_invite_id_and_only_hash_is_stored() -> None:
    key, iid = b"k" * 32, uuid.UUID("3f2a1c9e-0000-4000-8000-000000000001")
    token = rules.make_token(key, iid)
    assert len(token) == 32 and rules.is_token(token) and token == rules.make_token(key, iid)
    assert token != rules.make_token(b"x" * 32, iid) and token != rules.make_token(key, uuid.uuid4())
    assert len(rules.token_hash(token)) == 64 and rules.token_hash(token) != token
    link = rules.invite_link("https://t.me/bot/app", token)
    assert link == f"https://t.me/bot/app?startapp=inv_{token}" and len(f"inv_{token}") <= 64
    for bad in ("", "a" * 31, "a" * 33, "a" * 31 + "/", "a" * 31 + "="):
        assert not rules.is_token(bad)


def test_settings_guard_invite_key_and_link() -> None:
    with pytest.raises(ValueError, match="INVITE_TOKEN_KEY"):
        Settings(env="prod", internal_jwt_secret="p" * 40, internal_jwt_private_key="A" * 43)
    ok = Settings(env="prod", internal_jwt_secret="p" * 40, internal_jwt_private_key="A" * 43,
                  invite_token_key="k" * 32)
    assert ok.invite_key_bytes() == b"k" * 32
    dev = Settings(env="test", internal_jwt_secret="t" * 40)
    assert len(dev.invite_key_bytes()) == 32 and dev.invite_key_bytes() != b"t" * 40
    for bad in ("http://t.me/bot/app", "https://t.me/bot/app?x=1", "t.me/bot"):
        with pytest.raises(ValueError):
            Settings(env="test", telegram_app_link=bad)
    assert Settings(env="test", telegram_app_link="https://t.me/bot/app/").telegram_app_link == "https://t.me/bot/app"


@pytest.mark.parametrize(("who", "kind", "code"), [
    (person("18+"), "family", None),
    (person("18+"), "friend", None),
    (person("18+"), "referral", None),
    (person("14-17", consent="granted"), "friend", None),
    (person("14-17", consent="granted"), "family", "ADULT_REQUIRED"),
    (person("14-17", consent="pending"), "friend", "INVITES_NOT_ALLOWED"),
    (person("14-17"), "referral", "INVITES_NOT_ALLOWED"),
    (person("10-13"), "friend", "INVITES_NOT_ALLOWED"),
    (person("6-9"), "family", "INVITES_NOT_ALLOWED"),
    (person("10-13", kind="child"), "friend", "INVITES_NOT_ALLOWED"),
    (person(None), "friend", "INVITES_NOT_ALLOWED"),
    (person(None), "family", "ADULT_REQUIRED"),
    (person("18+", status="DISABLED"), "friend", "INVITES_NOT_ALLOWED"),
    (person("18+", status="DELETION_REQUESTED"), "family", "INVITES_NOT_ALLOWED"),
    (None, "friend", "INVITES_NOT_ALLOWED"),
])
def test_check_inviter(who, kind, code) -> None:
    if code is None:
        rules.check_inviter(who, kind)
        return
    with pytest.raises(ApiError) as exc:
        rules.check_inviter(who, kind)
    assert exc.value.status == 403 and exc.value.code == code


def test_can_receive_and_role() -> None:
    assert rules.can_receive(person("18+")) and rules.member_role(person("18+")) == "adult"
    teen = person("14-17", consent="granted")
    assert rules.can_receive(teen) and rules.member_role(teen) == "teen"
    for who in (person("14-17", consent="pending"), person("14-17", consent="declined"), person("14-17"),
                person("10-13"), person("6-9", kind="child"), person(None), person("18+", status="DISABLED"), None):
        assert not rules.can_receive(who)


def test_expiry_and_effective_status() -> None:
    assert rules.expires_at("family", NOW, 7, 30) == NOW + timedelta(days=7)
    assert rules.expires_at("friend", NOW, 7, 30) == NOW + timedelta(days=30)
    assert rules.expires_at("referral", NOW, 7, 30) is None
    assert rules.effective_status("active", NOW, NOW) == "expired"
    assert rules.effective_status("active", NOW + timedelta(seconds=1), NOW) == "active"
    assert rules.effective_status("active", None, NOW) == "active"
    assert rules.effective_status("revoked", NOW - timedelta(days=1), NOW) == "revoked"


def test_ordered_pair_matches_postgres_uuid_order() -> None:
    a = uuid.UUID("00000000-0000-4000-8000-000000000001")
    b = uuid.UUID("ffffffff-0000-4000-8000-000000000001")
    assert rules.ordered_pair(b, a) == (a, b) == rules.ordered_pair(a, b)
