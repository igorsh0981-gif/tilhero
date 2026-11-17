"""Unit-тесты доменных правил (без БД)."""

from __future__ import annotations

import hashlib
import json
import uuid
from datetime import UTC, datetime

import pytest
from argon2 import PasswordHasher

from tilhero_identity.domain.evidence import canonical_json, evidence_document, evidence_hash, truncate_ms
from tilhero_identity.domain.locale import locale_from_language_code
from tilhero_identity.domain.pin import (
    PinHasher,
    new_biometric_token,
    pin_problem,
    token_digest,
    token_matches,
)
from tilhero_identity.domain.policy import POLICIES, get_policy, normalize_purposes
from tilhero_identity.settings import Settings


@pytest.mark.parametrize(
    ("code", "expected"),
    [
        ("ru", "ru"),
        ("uz", "ru"),
        ("kk", "ru"),
        ("be", "ru"),
        ("uk", "ru"),
        ("ru-RU", "ru"),
        ("UZ_Latn", "ru"),
        ("en", "en"),
        ("de", "en"),
        ("pt-br", "en"),
        ("kz", "en"),
        (None, "en"),
        ("", "en"),
    ],
)
def test_locale_from_language_code(code: str | None, expected: str) -> None:
    assert locale_from_language_code(code) == expected


@pytest.mark.parametrize("pin", ["2580", "1357", "402913", "1123", "9870", "0102"])
def test_pin_accepts_non_trivial(pin: str) -> None:
    assert pin_problem(pin) is None


@pytest.mark.parametrize(
    ("pin", "reason"),
    [
        ("0000", "trivial"),
        ("1111", "trivial"),
        ("999999", "trivial"),
        ("1234", "trivial"),
        ("0123", "trivial"),
        ("123456", "trivial"),
        ("456789", "trivial"),
        ("4321", "trivial"),
        ("987654", "trivial"),
        ("3210", "trivial"),
        ("123", "format"),
        ("12345", "format"),
        ("1234567", "format"),
        ("12a4", "format"),
        ("", "format"),
        ("١٢٣٧", "format"),
        ("12 4", "format"),
        ("+123", "format"),
    ],
)
def test_pin_rejects_format_and_trivial(pin: str, reason: str) -> None:
    assert pin_problem(pin) == reason


async def test_pin_hasher_uses_argon2id_with_salt() -> None:
    hasher = PinHasher()
    h1, h2 = await hasher.hash("2580"), await hasher.hash("2580")
    assert h1.startswith("$argon2id$") and h1 != h2 and "2580" not in h1
    assert (await hasher.verify(h1, "2580")).ok
    assert not (await hasher.verify(h1, "2581")).ok
    assert not (await hasher.verify("garbage", "2580")).ok


async def test_pin_hasher_rehashes_outdated_parameters() -> None:
    weak = PasswordHasher(time_cost=1, memory_cost=8, parallelism=1).hash("2580")
    result = await PinHasher().verify(weak, "2580")
    assert result.ok and result.rehash and result.rehash.startswith("$argon2id$") and result.rehash != weak


def test_biometric_token_digest_and_compare() -> None:
    token = new_biometric_token()
    assert len(token) == 43 and "=" not in token
    digest = token_digest(token)
    assert digest == hashlib.sha256(token.encode()).hexdigest()
    assert token_matches(token, digest)
    assert not token_matches(token + "x", digest)
    assert new_biometric_token() != token


def test_policy_texts_and_purposes() -> None:
    policy = get_policy("1.0")
    assert policy.purpose_codes == ("personalization", "notifications")
    assert policy.required_purposes == {"personalization"}
    ru, en = policy.text["ru"], policy.text["en"]
    for needle in (
        "Telegram ID",
        "интересы",
        "Города вылета",
        "Реакции",
        "уведомлений",
        "геолокацию",
        "Банковские данные",
        "отдельное согласие",
        "Отозвать согласие",
        "удалить профиль",
    ):
        assert needle.lower() in ru.lower(), needle
    for needle in (
        "Telegram ID",
        "Interests",
        "Departure cities",
        "Reactions",
        "notification",
        "location",
        "Banking data",
        "separate consent",
        "Revoke consent",
        "delete your profile",
    ):
        assert needle.lower() in en.lower(), needle
    assert policy.text_sha256("ru") != policy.text_sha256("en")
    assert normalize_purposes(policy, ["notifications", "personalization", "personalization"]) == (
        ["personalization", "notifications"],
        [],
        [],
    )
    assert normalize_purposes(policy, ["notifications", "ads"]) == (
        ["notifications"],
        ["ads"],
        ["personalization"],
    )


def test_settings_reject_unknown_policy_version_and_prod_without_redis() -> None:
    with pytest.raises(ValueError, match="no policy text"):
        Settings(current_policy_version="9.9")
    prod_keys = {"internal_jwt_secret": "p" * 40, "internal_jwt_private_key": "A" * 43}
    for env in ("prod", "stage"):
        with pytest.raises(ValueError, match="REDIS_URL"):
            Settings(env=env, **prod_keys)
        with pytest.raises(ValueError, match="INTERNAL_JWT_PRIVATE_KEY"):  # EdDSA: личный ключ обязателен
            Settings(env=env, internal_jwt_secret="p" * 40, redis_url="redis://r")
    assert Settings(env="prod", redis_url="redis://r", **prod_keys).is_secure_env
    assert set(POLICIES) >= {Settings().current_policy_version}


def test_evidence_hash_is_canonical_and_reproducible() -> None:
    user_id = uuid.uuid4()
    at = truncate_ms(datetime(2026, 10, 8, 9, 30, 15, 123987, tzinfo=UTC))
    assert at.microsecond == 123000
    fields = {
        "user_id": user_id,
        "policy_version": "1.0",
        "purposes": ["personalization"],
        "accepted_at": at,
        "channel": "telegram",
        "locale": "ru",
        "policy_text_sha256": "a" * 64,
    }
    doc = evidence_document(**fields)
    assert doc["accepted_at"] == "2026-10-08T09:30:15.123Z"
    expected = hashlib.sha256(
        json.dumps(doc, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
    ).hexdigest()
    assert evidence_hash(**fields) == expected
    assert canonical_json({"b": 1, "a": "ж"}) == '{"a":"ж","b":1}'
    assert evidence_hash(**{**fields, "purposes": ["personalization", "notifications"]}) != expected
