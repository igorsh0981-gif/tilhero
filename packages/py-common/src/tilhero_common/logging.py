"""Структурные JSON-логи с контекстом трассировки и вычисткой PII.

Правило: в логах не бывает initData, PIN, кодов, токенов, текстов сообщений пользователей, Telegram ID в открытом виде.
"""

from __future__ import annotations

import json
import logging
import sys
import traceback
from datetime import UTC, datetime
from typing import Any

from tilhero_common import context

REDACT_KEYS = {
    "authorization",
    "init_data",
    "initdata",
    "pin",
    "new_pin",
    "current_pin",
    "code",
    "token",
    "access_token",
    "refresh_token",
    "password",
    "secret",
    "biometric_token",
    "text",
    "message",
    "telegram_user_id",
    "username",
    "display_name",
    # SEC9-05 (матрица SEC-13/14): PII, идентификаторы Telegram, ключи и коды
    "email",
    "phone",
    "first_name",
    "last_name",
    "full_name",
    "chat_id",
    "telegram_id",
    "tg_user_id",
    "api_key",
    "apikey",
    "bot_token",
    "scheduler_token",
    "totp",
    "otp",
    "private_key",
    "x_internal_token",
    "internal_token",
    "cookie",
    "set_cookie",
    "client_secret",
    # перепроверка SEC9-05: сырой initData, хеш PIN, Telegram ID, учётные данные, строки подключения
    "init_data_raw",
    "raw_init_data",
    "pin_hash",
    "tg_id",
    "credentials",
    "database_url",
    "dsn",
    # спринт 8 (INTERNAL_API §0.8): секреты платёжных провайдеров и входа «Log In with Telegram» — точные имена полей.
    # `key` и `code` — только целиком: `idempotency_key`, `dedup_key`, `error_code` не вычищаются; бизнес-код ошибки
    # (UPPER_SNAKE) в поле `code` остаётся виден (см. _business_code)
    "key",
    "sign_string",
    "secret_key",
    "code_verifier",
    "id_token",
    "payme_key",
    "payme_subscribe_key",
    "member_id_key",
}
# Ключ, содержащий одну из частей (после нормализации camelCase/kebab-case → snake_case), — секрет или PII …
REDACT_KEY_PARTS = ("password", "passwd", "secret", "token", "apikey", "api_key", "authorization", "cookie",
                    "private_key", "email", "phone", "totp", "otp", "first_name", "last_name", "chat_id",
                    "telegram_id", "initdata", "init_data", "credential", "dsn", "database_url")
# Целые слова ключа: `pin` (`pin_hash`, `new_pin`), но не `shipping`/`mapping`
REDACT_KEY_WORDS = ("pin",)
# Счётчики токенов LLM (`tokens_in`, `max_tokens`, `cache_read_input_tokens`): слово `tokens` во множественном числе —
# число, не секрет (секрет — `token`, `access_token`)
SAFE_KEY_WORDS = ("tokens",)
# … кроме служебных суффиксов: ссылки, счётчики, признаки (`input_tokens`, `token_type`, `email_verified`, `chat_id`
# остаётся по точному ключу выше)
SAFE_KEY_SUFFIXES = ("_tokens", "_count", "_total", "_type", "_kind", "_at", "_ms", "_len", "_length", "_enabled",
                     "_verified", "_status", "_version", "_ttl", "_ttl_seconds", "_expires_at")
# Коды подтверждения в ключах вида `<что>_code` (код ошибки, аэропорта, страны — не секрет)
SECRET_CODE_PREFIXES = ("totp", "otp", "mfa", "verification", "verify", "pin", "reset", "auth", "sms", "confirm",
                        "login", "recovery", "backup", "one_time")
REDACTED = "[redacted]"
# Значения-секреты и PII в любых строках (`detail`, `error`, текст сообщения): заменяется совпадение, а не вся строка
_VALUE_PATTERNS = __import__("re").compile(
    r"sk-ant-[A-Za-z0-9_\-]{8,}"                                   # ключ Anthropic
    r"|eyJ[A-Za-z0-9_\-]{5,}\.[A-Za-z0-9_\-]{5,}\.[A-Za-z0-9_\-]*"  # JWT
    r"|(?i:bearer)\s+[A-Za-z0-9._~+/\-]{8,}=*"                     # Authorization: Bearer …
    r"|\b\d{6,12}:[A-Za-z0-9_\-]{30,}"                              # токен бота Telegram
    r"|[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}"             # e-mail
    r"|\+\d[\d\s\-().]{7,}\d"                                      # телефон в международном формате
)
_CAMEL1 = __import__("re").compile(r"([A-Z]+)([A-Z][a-z])")
_CAMEL2 = __import__("re").compile(r"([a-z0-9])([A-Z])")
_SEP = __import__("re").compile(r"[^A-Za-z0-9]+")
_KEY_CACHE: dict[str, bool] = {}

_STD_ATTRS = set(logging.makeLogRecord({}).__dict__) | {"message", "asctime"}


def _norm_key(key: str) -> str:
    return _SEP.sub("_", _CAMEL2.sub(r"\1_\2", _CAMEL1.sub(r"\1_\2", key))).strip("_").lower()


def sensitive_key(key: Any) -> bool:
    """Ключ лога — секрет или PII: точные ключи, части (`*password*`, `*token*`, `x-internal-token`, `userEmail`),
    коды подтверждения (`totp_code`, `mfaCode`); служебные суффиксы (`input_tokens`, `error_code`) — нет."""
    k = str(key)
    hit = _KEY_CACHE.get(k)
    if hit is not None:
        return hit
    norm = _norm_key(k)
    compact = norm.replace("_", "")
    if norm in REDACT_KEYS or compact in REDACT_KEYS:
        hit = True
    elif any(norm.endswith(sfx) for sfx in SAFE_KEY_SUFFIXES) or any(w in norm.split("_") for w in SAFE_KEY_WORDS):
        hit = False
    elif any(w in norm.split("_") for w in REDACT_KEY_WORDS):
        hit = True
    elif norm.endswith("_code"):
        hit = norm[: -len("_code")] in SECRET_CODE_PREFIXES
    else:
        hit = any(p in norm or p.replace("_", "") in compact for p in REDACT_KEY_PARTS)
    if len(_KEY_CACHE) < 4096:
        _KEY_CACHE[k] = hit
    return hit


_re = __import__("re")
# PEM-блок ключа/сертификата целиком
_PEM = _re.compile(r"-----BEGIN [A-Z0-9 ]+-----.*?(?:-----END [A-Z0-9 ]+-----|$)", _re.DOTALL)
# пароль в строке подключения: scheme://user:pass@host → scheme://user:[redacted]@host
_DSN_PASSWORD = _re.compile(r"(\b[A-Za-z][A-Za-z0-9+.\-]*://[^:/@\s]*:)[^@/\s]+(@)")
# строка initData Telegram (`…auth_date=…&hash=…`) — целиком
_INIT_DATA = _re.compile(r"\S*(?:auth_date=|[?&]hash=[0-9A-Fa-f]{16,})\S*")
# секреты в параметрах URL/строк: token=…, key=…, api_key=…, sig=…; спринт 8 — client_secret=…, sign_string=…,
# code_verifier=…, id_token=… (OIDC, Click) и одноразовый `code` OIDC — только как параметр адреса (?code= / &code=)
_URL_SECRET = _re.compile(r"((?:^|[?&;\s])(?:[A-Za-z_]*token|[A-Za-z_]*key|[A-Za-z_]*secret|sig|signature|sign_string"
                          r"|password|passwd|code_verifier)=|[?&]code=)"
                          r"[^&\s#\"']{6,}", _re.IGNORECASE)


def redact_text(value: str) -> str:
    """Секреты и PII внутри строки → `[redacted]` (быстрый выход, если подозрительных символов нет)."""
    if not value or ("@" not in value and ":" not in value and "+" not in value and "sk-" not in value
                     and "eyJ" not in value and "earer" not in value and "EARER" not in value and "=" not in value
                     and "-----" not in value):
        return value
    if "-----" in value:
        value = _PEM.sub(REDACTED, value)
    if "://" in value:
        value = _DSN_PASSWORD.sub(r"\1" + REDACTED + r"\2", value)
    if "=" in value:
        value = _INIT_DATA.sub(REDACTED, value)
        value = _URL_SECRET.sub(r"\1" + REDACTED, value)
    return _VALUE_PATTERNS.sub(REDACTED, value)


_BUSINESS_CODE = _re.compile(r"^[A-Z][A-Z0-9_]{2,63}$")


def _business_code(key: Any, value: Any) -> bool:
    """Поле `code` с бизнес-кодом ошибки (`WALLET_DRIFT`, `PAYMENTS_DISABLED`) — не секрет: остаётся в логе. Секретные
    коды (OIDC `code`, TOTP, код подтверждения) на него не похожи: в них есть строчные буквы, цифры в начале или `-`."""
    return isinstance(value, str) and _norm_key(str(key)) == "code" and bool(_BUSINESS_CODE.match(value))


def redact(value: Any, depth: int = 0) -> Any:
    if depth > 6:
        return "[depth]"
    if isinstance(value, dict):
        return {k: (REDACTED if v is not None and not isinstance(v, bool) and sensitive_key(k)
                    and not _business_code(k, v)
                    else redact(v, depth + 1)) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [redact(v, depth + 1) for v in value]
    if isinstance(value, str):
        return redact_text(value)
    return value


class JsonFormatter(logging.Formatter):
    """safe_exceptions=True (stage/prod): у исключений пишем только тип и кадры стека, без текста сообщения —
    текст ValidationError/DBAPIError несёт входные данные (PII, параметры SQL, коды)."""

    def __init__(self, service: str, *, safe_exceptions: bool = False) -> None:
        super().__init__()
        self.service = service
        self.safe_exceptions = safe_exceptions

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds"),
            "level": record.levelname.lower(),
            "service": self.service,
            "logger": record.name,
            "msg": redact_text(record.getMessage()),
            "trace_id": context.trace_id_var.get(),
            "correlation_id": context.correlation_id_var.get(),
        }
        user_pid = context.user_pid_var.get()
        if user_pid:
            payload["user_pid"] = user_pid
        extra = {k: v for k, v in record.__dict__.items() if k not in _STD_ATTRS and not k.startswith("_")}
        if extra:
            payload.update(redact(extra))
        if record.exc_info:
            if self.safe_exceptions:
                exc_type, _, tb = record.exc_info
                name = exc_type.__name__ if exc_type else "Exception"
                payload["exc"] = f"{name} (message hidden)\n" + "".join(traceback.format_tb(tb))[-4000:]
            else:
                payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False, default=str)


def configure_logging(service: str, level: str = "INFO", *, safe_exceptions: bool = False) -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter(service, safe_exceptions=safe_exceptions))
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level.upper())
    for noisy in ("uvicorn.access", "nats", "httpx", "httpcore", "asyncio"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    # uvicorn.error оставляем, но через наш форматтер
    for name in ("uvicorn", "uvicorn.error"):
        lg = logging.getLogger(name)
        lg.handlers[:] = []
        lg.propagate = True
