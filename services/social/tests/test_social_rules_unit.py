"""Чистые правила: токен и ссылка, кто может приглашать и принимать (дети и подростки), статус, порядок пары."""

from __future__ import annotations

import re
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from tilhero_common.errors import ApiError
from tilhero_social.domain import rules
from tilhero_social.identity import Person
from tilhero_social.settings import DEV_TELEGRAM_APP_LINK, Settings

NOW = datetime(2026, 11, 16, 8, 0, tzinfo=UTC)


def person(age: str | None = "18+", *, kind: str = "account", status: str = "ACTIVE",
           consent: str | None = None, accepted: bool = True,
           purposes: tuple[str, ...] = ("terms", "privacy", "learning", "social")) -> Person:
    return Person(uuid.uuid4(), "Имя", kind, age, status, consent, consent_accepted=accepted,
                  purposes=frozenset(purposes))


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


PROD = {"internal_jwt_secret": "p" * 40, "internal_jwt_private_key": "A" * 43}
PROD_LINK = "https://t.me/tilhero_bot/app"


def test_settings_guard_invite_key_and_link() -> None:
    with pytest.raises(ValueError, match="INVITE_TOKEN_KEY"):
        Settings(env="prod", telegram_app_link=PROD_LINK, **PROD)
    ok = Settings(env="prod", invite_token_key="k" * 32, telegram_app_link=PROD_LINK, **PROD)
    assert ok.invite_key_bytes() == b"k" * 32 and ok.telegram_app_link == PROD_LINK
    dev = Settings(env="test", internal_jwt_secret="t" * 40)
    assert len(dev.invite_key_bytes()) == 32 and dev.invite_key_bytes() != b"t" * 40
    for bad in ("http://t.me/bot/app", "https://t.me/bot/app?x=1", "t.me/bot"):
        with pytest.raises(ValueError):
            Settings(env="test", telegram_app_link=bad)
    assert Settings(env="test", telegram_app_link="https://t.me/bot/app/").telegram_app_link == "https://t.me/bot/app"


def test_telegram_app_link_required_in_secure_env(monkeypatch) -> None:
    """P-2: в stage/prod TELEGRAM_APP_LINK обязателен (значения по умолчанию нет); в dev/test по умолчанию — та же
    ссылка, что у telegram-bff (config.ts DEV_DEFAULTS): приглашения и согласие родителя ведут в одно приложение."""
    monkeypatch.delenv("TELEGRAM_APP_LINK", raising=False)
    for env_name in ("stage", "prod"):
        for missing in ({}, {"telegram_app_link": ""}, {"telegram_app_link": "  "}):
            with pytest.raises(ValueError, match="TELEGRAM_APP_LINK"):
                Settings(env=env_name, invite_token_key="k" * 32, **missing, **PROD)
    bff = Path(__file__).resolve().parents[3] / "services" / "telegram-bff" / "src" / "config.ts"
    [bff_dev] = re.findall(r'TELEGRAM_APP_LINK: "([^"]+)"', bff.read_text(encoding="utf-8"))
    for env_name in ("dev", "test"):
        dev = Settings(env=env_name, internal_jwt_secret="t" * 40)
        assert dev.telegram_app_link == bff_dev == DEV_TELEGRAM_APP_LINK
    monkeypatch.setenv("TELEGRAM_APP_LINK", "https://t.me/tilhero_stage_bot/app")
    staged = Settings(env="stage", invite_token_key="k" * 32, **PROD)
    assert staged.telegram_app_link == "https://t.me/tilhero_stage_bot/app"
    inv_id = uuid.uuid4()
    assert rules.invite_link(staged.telegram_app_link, rules.make_token(b"k" * 32, inv_id)).startswith(
        "https://t.me/tilhero_stage_bot/app?startapp=inv_")


def test_scheduler_token_length_guard_in_secure_env() -> None:
    """P-8: в stage/prod SCHEDULER_TOKEN пустой (вход выключен) или не короче 32 символов."""
    base = {"invite_token_key": "k" * 32, "telegram_app_link": PROD_LINK, **PROD}
    for env_name in ("stage", "prod"):
        for short in ("abc", "x" * 31):
            with pytest.raises(ValueError, match="SCHEDULER_TOKEN"):
                Settings(env=env_name, scheduler_token=short, **base)
        assert Settings(env=env_name, scheduler_token="z" * 32, **base).scheduler_token.get_secret_value() == "z" * 32
        assert Settings(env=env_name, scheduler_token="", **base).scheduler_token.get_secret_value() == ""
    assert Settings(env="test", internal_jwt_secret="t" * 40, scheduler_token="abc").scheduler_token


@pytest.mark.parametrize(("who", "social", "purpose"), [
    (person("18+", purposes=("terms", "privacy", "learning", "social")), True, None),
    (person("18+", purposes=("terms", "privacy", "learning")), True, "social"),
    (person("18+", purposes=("terms", "privacy", "learning")), False, None),
    (person("18+", accepted=False), False, "terms"),
    (person("18+", accepted=False, purposes=("social",)), True, "terms"),
    (None, False, "terms"),
])
def test_check_consent(who, social, purpose) -> None:
    """P-3: открыть/посмотреть — consent_accepted, иначе {purpose: terms}; создать/принять — ещё и цель social."""
    if purpose is None:
        rules.check_consent(who, social=social)
        return
    with pytest.raises(ApiError) as exc:
        rules.check_consent(who, social=social)
    assert (exc.value.status, exc.value.code, exc.value.details) == (403, "CONSENT_REQUIRED", {"purpose": purpose})


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
