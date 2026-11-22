"""SEC9-05: редакция логов py-common — ключи PII/секретов (нормализация camelCase/kebab-case), коды подтверждения,
значения-секреты в любых строках и в тексте сообщения; служебные поля не трогаются."""

from __future__ import annotations

import json
import logging

import pytest

from tilhero_common.logging import JsonFormatter, redact, sensitive_key

SECRET = "s3cr3t-value-CANARY"


def fmt(msg: str = "event", **extra: object) -> dict:
    rec = logging.LogRecord("tilhero.t", logging.INFO, "t.py", 1, msg, None, None)
    for k, v in extra.items():
        setattr(rec, k, v)
    return json.loads(JsonFormatter("t").format(rec))


@pytest.mark.parametrize("key", [
    "email", "userEmail", "contact_email", "phone", "phoneNumber", "first_name", "lastName", "full_name", "chat_id",
    "chatId", "telegram_id", "tgUserId", "tg_user_id", "api_key", "apiKey", "X-Api-Key", "bot_token", "botToken",
    "scheduler_token", "totp", "otp", "totp_code", "mfaCode", "verification_code", "pin_code", "private_key",
    "x-internal-token", "X-Internal-Token", "cookie", "Set-Cookie", "session_cookie", "client_secret", "password",
    "newPassword", "authorization", "Authorization", "access_token", "refreshToken", "code", "pin", "initData",
])
def test_sensitive_keys_redacted(key: str) -> None:
    assert sensitive_key(key), key
    out = fmt(nested={"a": [{key: SECRET}]}, **{key.replace("-", "_"): SECRET})
    assert SECRET not in json.dumps(out, ensure_ascii=False), key


@pytest.mark.parametrize("key", [
    "input_tokens", "output_tokens", "token_type", "email_verified", "phone_verified", "error_code", "airport_code",
    "country_code", "status", "duration_ms", "event_id", "provider", "path", "method", "outcome", "message_count",
    "password_changed_at", "cookie_enabled",
])
def test_service_keys_kept(key: str) -> None:
    assert not sensitive_key(key), key
    assert redact({key: "value-1"}) == {key: "value-1"}


@pytest.mark.parametrize("value,secret", [
    ("ошибка: ключ sk-ant-api03-AbCdEfGhIjKlMnOp отклонён", "sk-ant-api03-AbCdEfGhIjKlMnOp"),
    ("token eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl", "eyJhbGciOiJFZERTQSJ9"),
    ("header Authorization: Bearer abcdef1234567890.xyz", "abcdef1234567890"),
    ("bot 7000000001:AAcanaryQ5botTOKEN-xxxxxxxxxxxxxx", "AAcanaryQ5botTOKEN"),
    ("пишите на ivan.petrov@mail.ru", "ivan.petrov@mail.ru"),
    ("звонок +998 90 123-45-67", "123-45-67"),
])
def test_secret_values_redacted_in_any_field_and_message(value: str, secret: str) -> None:
    out = fmt(value, detail=value, deep={"x": [value]})
    dumped = json.dumps(out, ensure_ascii=False)
    assert secret not in dumped and "[redacted]" in out["detail"] and "[redacted]" in out["msg"]


def test_ordinary_values_and_types_untouched() -> None:
    data = {"ts": "2026-10-17T10:00:00+05:00", "uuid": "3f1c2e4a-9b8d-4c7e-a1f2-0d9e8c7b6a50", "n": 12345678901,
            "price": "1470.00", "url": "/internal/v1/x/{id}", "ok": True, "password": True, "email": None,
            "phone": False}
    assert redact(data) == data


# ---------------------------------------------------------------- перепроверка SEC9-05

@pytest.mark.parametrize("key", ["tokens_in", "tokens_out", "max_tokens", "cache_read_input_tokens", "tokensIn",
                                 "shipping", "mapping", "spinner"])
def test_llm_token_counters_and_lookalikes_kept(key: str) -> None:
    """provider-gateway llm/service.py пишет tokens_in/tokens_out — числа, а не секреты."""
    assert not sensitive_key(key)
    assert fmt(**{key: 1234})[key] == 1234


@pytest.mark.parametrize("key", ["init_data_raw", "rawInitData", "pin_hash", "pinHash", "new_pin", "tg_id", "tgId",
                                 "credentials", "aws_credentials", "database_url", "DATABASE_URL", "dsn", "redis_dsn"])
def test_more_sensitive_keys(key: str) -> None:
    assert sensitive_key(key), key
    assert fmt(**{key: SECRET})[key] == "[redacted]"


@pytest.mark.parametrize("value,secret,kept", [
    ("db postgresql+asyncpg://ops_monitor:S3cretPw@db.internal:5432/tilhero down", "S3cretPw",
     "postgresql+asyncpg://ops_monitor:[redacted]@db.internal:5432/tilhero"),
    ("redis://:R3disPass@cache:6379/0", "R3disPass", "redis://:[redacted]@cache:6379/0"),
    ("key -----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0B\n-----END PRIVATE KEY----- loaded", "MIIEvQIBADAN",
     "loaded"),
    ("bad initData query_id=AAHdF6IQ&user=%7B%22id%22%3A1%7D&auth_date=1700000000&hash=" + "ab" * 32 + " rejected",
     "auth_date=1700000000", "rejected"),
    ("GET https://feeds.example/rss?token=4f9a1c2b3d4e5f60&page=2", "4f9a1c2b3d4e5f60", "&page=2"),
    ("call https://api.example/v1?api_key=ZXhhbXBsZS1rZXk%3D", "ZXhhbXBsZS1rZXk", "api_key=[redacted]"),
])
def test_dsn_pem_initdata_and_url_secrets(value: str, secret: str, kept: str) -> None:
    out = fmt(value, detail=value)
    assert secret not in json.dumps(out, ensure_ascii=False)
    assert kept in out["detail"] and kept in out["msg"]


def test_plain_equals_and_short_values_untouched() -> None:
    for v in ("a=b", "retry=3", "status=ok page=2", "key=a"):
        assert redact({"detail": v}) == {"detail": v}, v


# ---------------------------------------------------------------- спринт 8 (INTERNAL_API §0.8): платежи и вход на сайт

@pytest.mark.parametrize("key", ["authorization", "sign_string", "signString", "secret_key", "CLICK_SECRET_KEY",
                                 "password", "UZUM_PASSWORD", "key", "Key", "client_secret", "clientSecret",
                                 "code", "code_verifier", "codeVerifier", "id_token", "idToken", "payme_key",
                                 "PAYME_SUBSCRIBE_KEY", "member_id_key", "x-edge-token", "payments_edge_token",
                                 "web_session_secret", "telegram_login_client_secret"])
def test_sprint8_secret_keys_redacted(key: str) -> None:
    assert sensitive_key(key), key
    out = fmt(nested={"a": [{key: SECRET}]}, **{key.replace("-", "_"): SECRET})
    assert SECRET not in json.dumps(out, ensure_ascii=False), key


@pytest.mark.parametrize("key", ["idempotency_key", "dedup_key", "cache_key", "payload_hash", "error_code",
                                 "upstream_code", "result_code", "order_no", "provider_txn_id", "state", "keys"])
def test_sprint8_key_and_code_are_exact_field_names(key: str) -> None:
    """`key` и `code` — точные имена поля: составные (идемпотентность, дедупликация, коды результата) — не секрет."""
    assert not sensitive_key(key), key
    assert redact({key: "value-1"}) == {key: "value-1"}


def test_sprint8_business_error_code_kept_secret_code_redacted() -> None:
    """Бизнес-код ошибки (UPPER_SNAKE) в поле `code` виден; одноразовый код OIDC, TOTP — нет."""
    assert fmt(code="PAYMENTS_DISABLED")["code"] == "PAYMENTS_DISABLED"
    assert redact({"nested": {"code": "WALLET_DRIFT"}}) == {"nested": {"code": "WALLET_DRIFT"}}
    for secret_code in ("a1b2c3d4e5f6-oidc-code", "123456", "Ab_CDEF", "9ZZZ_ZZZ"):
        assert fmt(code=secret_code)["code"] == "[redacted]", secret_code
    assert fmt(key="PAYMENTS_DISABLED")["key"] == "[redacted]"  # исключение — только для `code`


@pytest.mark.parametrize("value,secret", [
    ("GET /web/v1/auth/callback?code=Qw3rTy-0neT1me-c0de&state=st4te0000", "Qw3rTy-0neT1me-c0de"),
    ("POST https://oauth.telegram.org/token grant_type=authorization_code&code_verifier=V3r1f13r-abcdefgh",
     "V3r1f13r-abcdefgh"),
    ("client_secret=Cl13ntS3cr3t-xyz rejected", "Cl13ntS3cr3t-xyz"),
    ("click sign_string=0123456789abcdef0123456789abcdef", "0123456789abcdef0123456789abcdef"),
    ("id_token=abcdef.ghijkl.mnopqr", "abcdef.ghijkl.mnopqr"),
])
def test_sprint8_secret_values_in_strings(value: str, secret: str) -> None:
    out = fmt(value, detail=value)
    assert secret not in json.dumps(out, ensure_ascii=False)
    assert "[redacted]" in out["detail"] and "[redacted]" in out["msg"]


def test_sprint8_plain_code_words_untouched() -> None:
    for v in ("error code=PAYMENTS_DISABLED", "status=ok code=200", "promo code"):
        assert redact({"detail": v}) == {"detail": v}, v
