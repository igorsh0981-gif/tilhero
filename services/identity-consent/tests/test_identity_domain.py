"""Unit-тесты доменных правил (без БД)."""

from __future__ import annotations

import hashlib
import json
import uuid
from datetime import UTC, datetime

import pytest
from argon2 import PasswordHasher

from tilhero_identity.domain.age import (
    guardian_consent_for,
    is_adult,
    is_minor,
    optional_purposes_allowed,
)
from tilhero_identity.domain.evidence import canonical_json, evidence_document, evidence_hash, truncate_ms
from tilhero_identity.domain.guardian import derive_token, token_hash, token_key, well_formed
from tilhero_identity.domain.locale import locale_from_language_code
from tilhero_identity.domain.notify import (
    QuietHoursError,
    apply_categories,
    normalize_categories,
    parse_quiet_hours,
)
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
        ("uz", "uz"),
        ("UZ_Latn", "uz"),
        ("uz-Cyrl-UZ", "uz"),
        ("ru-RU", "ru"),
        ("kk", "ru"),
        ("en", "ru"),
        ("de", "ru"),
        ("uzb", "ru"),
        (None, "ru"),
        ("", "ru"),
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
    assert policy.purpose_codes == ("terms", "privacy", "learning", "voice_recording", "social", "product_news")
    assert policy.required_purposes == {"terms", "privacy", "learning"}
    assert policy.optional_purposes == {"voice_recording", "social", "product_news"}
    ru, uz = policy.text["ru"], policy.text["uz"]
    for needle in ("черновик", "юристы", "Telegram ID", "Возрастную группу", "6–13", "14–17", "согласие родителя",
                   "Отозвать согласие", "Удалить профиль", "детскими профилями"):
        assert needle.lower() in ru.lower(), needle
    for needle in ("qoralama", "yuristlar", "Telegram ID", "Yosh guruhi", "6–13", "14–17", "ota-ona roziligi",
                   "qaytarib olish", "Profilni oʻchirish"):
        assert needle.lower() in uz.lower(), needle
    for p in policy.purposes:
        assert p.title["ru"] and p.title["uz"] and p.description["ru"] and p.description["uz"]
    assert policy.text_sha256("ru") != policy.text_sha256("uz")
    assert normalize_purposes(policy, ["social", "terms", "privacy", "learning", "terms"]) == (
        ["terms", "privacy", "learning", "social"],
        [],
        [],
    )
    assert normalize_purposes(policy, ["voice_recording", "ads", "privacy"]) == (
        ["privacy", "voice_recording"],
        ["ads"],
        ["terms", "learning"],
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
        "purposes": ["terms", "privacy", "learning"],
        "accepted_at": at,
        "channel": "telegram",
        "locale": "ru",
        "policy_text_sha256": "a" * 64,
        "age_band": "18+",
        "basis": "self",
        "granted_by": None,
    }
    doc = evidence_document(**fields)
    assert doc["accepted_at"] == "2026-10-08T09:30:15.123Z"
    assert (doc["age_band"], doc["basis"], doc["granted_by"]) == ("18+", "self", None)
    expected = hashlib.sha256(
        json.dumps(doc, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
    ).hexdigest()
    assert evidence_hash(**fields) == expected
    assert canonical_json({"b": 1, "a": "ж"}) == '{"a":"ж","b":1}'
    assert evidence_hash(**{**fields, "purposes": ["terms"]}) != expected
    guardian = uuid.uuid4()
    by_guardian = evidence_hash(**{**fields, "basis": "guardian", "granted_by": guardian, "age_band": "6-9"})
    assert by_guardian != expected
    assert evidence_document(**{**fields, "granted_by": guardian})["granted_by"] == str(guardian)


@pytest.mark.parametrize(("age_band", "consent", "minor", "adult", "optional"), [
    ("6-9", "granted", True, False, False),  # детский профиль: необязательные цели не предлагаются
    ("10-13", "granted", True, False, False),
    ("14-17", "pending", True, False, False),
    ("14-17", "declined", True, False, False),
    ("14-17", "granted", True, False, True),
    ("18+", "not_required", False, True, True),
    (None, "not_required", False, False, False),
])
def test_age_rules(age_band, consent, minor, adult, optional) -> None:
    assert is_minor(age_band) is minor
    assert is_adult(age_band) is adult
    assert optional_purposes_allowed(age_band, consent) is optional


def test_guardian_consent_initial_state() -> None:
    assert guardian_consent_for("14-17") == "pending"
    assert guardian_consent_for("18+") == "not_required"


def test_quiet_hours_and_categories() -> None:
    from datetime import time

    assert parse_quiet_hours("22:00", "08:00") == (time(22), time(8))  # через полночь
    assert parse_quiet_hours("00:00", "23:59") == (time(0), time(23, 59))
    for start, end, field, reason in (("22:00", "22:00", "end", "empty"), ("24:00", "08:00", "start", "format"),
                                      ("22:00", "8:00", "end", "format"), ("2200", "08:00", "start", "format")):
        with pytest.raises(QuietHoursError) as exc:
            parse_quiet_hours(start, end)
        assert (exc.value.field, exc.value.reason) == (field, reason)
    assert normalize_categories(["support", "reminders", "support", "ads"]) == ["reminders", "support"]
    assert apply_categories(["support"], {"missed": True, "support": False, "ads": True}) == ["missed"]
    assert apply_categories(["support"], {}) == ["support"]


def test_guardian_token_is_hmac_derived_and_hashed() -> None:
    key = token_key("s" * 40)
    rid = uuid.uuid4()
    token = derive_token(key, rid)
    assert len(token) == 43 and well_formed(token) and "=" not in token
    assert derive_token(key, rid) == token  # повтор команды — та же ссылка
    assert derive_token(key, uuid.uuid4()) != token
    assert derive_token(token_key("t" * 40), rid) != token  # без ключа сервиса токен не вычислить
    assert token_hash(token) == hashlib.sha256(token.encode()).hexdigest() and token not in token_hash(token)
    for bad in ("", "a" * 42, "a" * 44, "a" * 42 + "=", "a" * 42 + "/"):
        assert not well_formed(bad)
