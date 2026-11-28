"""Общие помощники фиатных адаптеров Payme, Click, Uzum (поток B, INTERNAL_API спринта 8 §1.4–§1.8, §4).

- деньги — только целые тийины (ADR-0001): `parse_sum_string` разбирает строку Click (`"15000.00"`) без float,
  `format_sum` собирает `N.NN` для ссылки Click, `vat_inside` — НДС «внутри цены» целочисленно (§1.9);
- время провайдеров — мс от эпохи (Payme, Uzum) ↔ `datetime` UTC без float;
- секреты — только `hmac.compare_digest` (постоянное время); пустой ожидаемый секрет никогда не совпадает;
- адрес клиента — `X-Forwarded-For` на фиксированной глубине справа (`CLIENT_IP_DEPTH`: Railway edge + Caddy
  payments-edge), крайний левый адрес подделывает клиент; список CIDR провайдера пуст — проверка IP выключена (В16);
- журнал `provider_calls` (§1.1) — только метаданные: метод, код результата, время ответа, IP, номер заказа и id
  транзакции провайдера; без тел, подписей, учётных данных и ПДн;
- исходящие вызовы провайдеров (Click Merchant API, Payme Subscribe API) — таймаут 10 с (`PROVIDER_TIMEOUT_SECONDS`),
  один повтор на сеть/5xx (неидемпотентные команды — только если запрос не ушёл), circuit breaker на провайдера.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import hmac
import ipaddress
import json
import logging
import re
import secrets
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any, Literal, Protocol, cast

import httpx
from sqlalchemy import text

from tilhero_common.http_client import CircuitBreaker

if TYPE_CHECKING:
    from redis.asyncio import Redis

    from tilhero_billing.providers.base import ProviderAdapter, ProviderCode, TxnView
    from tilhero_billing.settings import Settings
    from tilhero_common.app import Runtime

log = logging.getLogger("tilhero.billing.providers")

EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
# тело колбэка: payments-edge режет на 64 КиБ (413), billing проверяет то же (защита в глубину)
MAX_CALLBACK_BODY_BYTES = 64 * 1024
# X-Forwarded-For к billing: «…, <клиент по версии Railway edge>, <адрес edge, дописанный Caddy>» — клиент второй справа
CLIENT_IP_DEPTH = 2
# исходящие к провайдерам: один повтор на сеть/5xx, затем circuit breaker (N неудач подряд → пауза)
OUTBOUND_RETRIES = 1
OUTBOUND_RETRY_DELAY_SECONDS = 0.3
BREAKER_THRESHOLD = 5
BREAKER_COOLDOWN_SECONDS = 30.0
# суточная соль псевдонима IP для лимита pay.callback_ip — как ts-common rateLimit.ts (rl:salt:<день>, 48 ч)
SALT_TTL_SECONDS = 48 * 3600


# ---------------------------------------------------------------- деньги (ADR-0001)

# Click присылает сумму строкой в сумах: целые сумы и до двух знаков тийинов; только ASCII-цифры (`\d` в Python
# пропускает и арабские, и деванагари), без знака, пробелов и экспоненты
_SUM_STRING = re.compile(r"[0-9]{1,12}(?:\.[0-9]{1,2})?")


def parse_sum_string(value: str) -> int | None:
    """`"15000.00"` → 1 500 000 тийинов; `"15000.5"` → 1 500 050; `"15000"` → 1 500 000. Иная форма — None
    (Click: ошибка -2). Без float и Decimal: целая и дробная части разбираются отдельно."""
    if not isinstance(value, str) or not _SUM_STRING.fullmatch(value):
        return None
    whole, _, frac = value.partition(".")
    return int(whole) * 100 + int(frac.ljust(2, "0"))


def format_sum(tiyin: int) -> str:
    """Целые тийины → `N.NN` (ссылка Click): 4 900 000 → `49000.00`."""
    if isinstance(tiyin, bool) or not isinstance(tiyin, int) or tiyin < 0:
        raise ValueError("amount must be a non-negative integer of tiyin")
    return f"{tiyin // 100}.{tiyin % 100:02d}"


def vat_inside(price_tiyin: int, vat_percent: int) -> int:
    """НДС «внутри цены» (§1.9): ⌊price × p / (100 + p) + ½⌋ — целочисленно; округление подтверждает бухгалтер."""
    if vat_percent <= 0 or price_tiyin <= 0:
        return 0
    denominator = 2 * (100 + vat_percent)
    return (2 * price_tiyin * vat_percent + 100 + vat_percent) // denominator


# ---------------------------------------------------------------- время

def ms_to_dt(ms: int) -> datetime:
    """Мс от эпохи (Payme `time`, Uzum `timestamp`) → UTC без float."""
    return EPOCH + timedelta(milliseconds=ms)


def dt_to_ms(dt: datetime) -> int:
    """`datetime` → мс от эпохи (наивное время считается UTC)."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return (dt - EPOCH) // timedelta(milliseconds=1)


def utcnow() -> datetime:
    return datetime.now(UTC)


# ---------------------------------------------------------------- секреты и учётные данные

def secret_equals(presented: str | bytes | None, expected: str) -> bool:
    """Сравнение за постоянное время; пустой ожидаемый секрет (ключ не задан) никогда не совпадает."""
    if not expected or presented is None:
        return False
    got = presented.encode("utf-8") if isinstance(presented, str) else presented
    return hmac.compare_digest(got, expected.encode("utf-8"))


def parse_basic_auth(header: str | None) -> tuple[str, str] | None:
    """`Authorization: Basic base64(login:password)` → (login, password); иное — None. Значения не логируются."""
    if not header:
        return None
    scheme, _, value = header.strip().partition(" ")
    if scheme.lower() != "basic" or not value.strip():
        return None
    try:
        raw = base64.b64decode(value.strip(), validate=True).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError, ValueError):
        return None
    login, sep, password = raw.partition(":")
    if not sep:
        return None
    return login, password


def basic_auth_ok(header: str | None, login: str, password: str) -> bool:
    """Basic-авторизация провайдера: логин и пароль — за постоянное время, оба сравниваются всегда."""
    parsed = parse_basic_auth(header)
    if parsed is None or not password:
        return False
    login_ok = hmac.compare_digest(parsed[0].encode("utf-8"), login.encode("utf-8"))
    password_ok = hmac.compare_digest(parsed[1].encode("utf-8"), password.encode("utf-8"))
    return bool(login_ok & password_ok)


def md5_hex(value: str) -> str:
    """MD5 подписи Click (SHOP API) — алгоритм задаёт провайдер."""
    return hashlib.md5(value.encode("utf-8"), usedforsecurity=False).hexdigest()


def sha1_hex(value: str) -> str:
    """SHA-1 заголовка `Auth` Click Merchant API — алгоритм задаёт провайдер."""
    return hashlib.sha1(value.encode("utf-8"), usedforsecurity=False).hexdigest()


# ---------------------------------------------------------------- адрес клиента и CIDR (В16, О8)

IpNetwork = ipaddress.IPv4Network | ipaddress.IPv6Network


def normalize_ip(value: str | None) -> str | None:
    """Строка адреса → канонический вид; IPv4, отображённый в IPv6, — как IPv4; мусор — None."""
    if not value:
        return None
    candidate = value.strip()
    if candidate.startswith("[") and "]" in candidate:  # "[2001:db8::1]:443"
        candidate = candidate[1:candidate.index("]")]
    candidate = candidate.split("%", 1)[0]
    try:
        ip = ipaddress.ip_address(candidate)
    except ValueError:
        return None
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        return str(ip.ipv4_mapped)
    return str(ip)


def client_ip_from_forwarded(forwarded_for: str | None, depth: int = CLIENT_IP_DEPTH) -> str | None:
    """Адрес клиента на фиксированной глубине справа в `X-Forwarded-For` (как TRUST_PROXY_HOPS=2 admin-bff).
    Короче глубины или не адрес — None (проверка CIDR такой вызов не пропустит)."""
    if not forwarded_for:
        return None
    parts = [p.strip() for p in forwarded_for.split(",")]
    if len(parts) < depth:
        return None
    return normalize_ip(parts[-depth])


def ip_allowed(client_ip: str | None, networks: Sequence[IpNetwork]) -> bool:
    """Список сетей пуст — проверка выключена (В16: IP провайдеров запросить при договоре)."""
    if not networks:
        return True
    norm = normalize_ip(client_ip)
    if norm is None:
        return False
    addr = ipaddress.ip_address(norm)
    return any(addr in net for net in networks if net.version == addr.version)


def ip_rate_key(ip: str) -> str:
    """Ключ лимита по IP — как ts-common `ipRateKey`: IPv4 как есть, IPv6 — сеть /64."""
    norm = normalize_ip(ip)
    if norm is None:
        return ip.strip().lower()
    addr = ipaddress.ip_address(norm)
    if addr.version == 4:
        return norm
    groups = addr.exploded.split(":")[:4]
    return ":".join(groups) + "::/64"


async def ip_subject(redis: Redis, client_ip: str | None, *, now: datetime, prefix: str = "") -> str:
    """Псевдоним IP для лимита `pay.callback_ip`: sha256(`ip:<ключ>:<соль дня>`)[:16], соль `rl:salt:<день>` — общая с
    ts-common (адрес в открытом виде в Redis не попадает). Адрес неизвестен — общий субъект `unknown`."""
    if client_ip is None:
        return "unknown"
    day = now.astimezone(UTC).strftime("%Y-%m-%d")
    key = f"{prefix}rl:salt:{day}"
    await redis.set(key, secrets.token_hex(16), ex=SALT_TTL_SECONDS, nx=True)
    salt = await redis.get(key)
    if isinstance(salt, bytes):
        salt = salt.decode("utf-8")
    if not salt:
        raise RuntimeError("rate limit salt unavailable")
    raw = f"ip:{ip_rate_key(client_ip)}:{salt}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


# ---------------------------------------------------------------- JSON без float

class BadJson(ValueError):
    """Тело не JSON (Payme -32700, Uzum 10002)."""


def _reject_constant(name: str) -> Any:
    raise BadJson(f"constant {name} is not allowed")


def parse_json(body: bytes) -> Any:
    """JSON провайдера: числа с дробной частью остаются строками (float для денег не появляется — ADR-0001), NaN и
    Infinity отвергаются."""
    try:
        return json.loads(body.decode("utf-8"), parse_float=str, parse_constant=_reject_constant)
    except (UnicodeDecodeError, ValueError, RecursionError) as exc:
        raise BadJson("invalid json") from exc


def as_int(value: Any) -> int | None:
    """Целое JSON (не bool) — иначе None."""
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def digits(value: Any, max_len: int = 18) -> str | None:
    """Номер заказа / id как строка ASCII-цифр (`100001` или `"100001"`) — иначе None."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        value = str(value)
    if not isinstance(value, str) or not re.fullmatch(rf"[0-9]{{1,{max_len}}}", value):
        return None
    return value


# ---------------------------------------------------------------- ссылки оплаты

def return_url_for(settings: Settings, order_no: int) -> str:
    """Возврат покупателя с сайта провайдера — страница заказа сайта оплаты (§1.3)."""
    return f"{settings.web_pay_origin.rstrip('/')}/orders/{order_no}"


class CheckoutUnavailable(Exception):
    """Ссылку оплаты построить нельзя (провайдер не настроен, заказ не того провайдера или канала)."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


# ---------------------------------------------------------------- журнал provider_calls (§1.1)

@dataclass(frozen=True, slots=True)
class ProviderCallRecord:
    """Строка `provider_calls`: только метаданные. Тела, подписи, учётные данные и ПДн сюда не попадают."""

    provider: str
    direction: Literal["in", "out"]
    method: str  # ≤ 40: CheckPerformTransaction, prepare, check, status_by_mti, reversal…
    result_code: str
    latency_ms: int
    provider_txn_id: str | None = None
    order_no: int | None = None
    client_ip: str | None = None


class ProviderCallSink(Protocol):
    async def record(self, rec: ProviderCallRecord) -> None: ...


class NullCallSink:
    """Журнал выключен (тесты адаптеров без БД)."""

    async def record(self, rec: ProviderCallRecord) -> None:
        return None


_INSERT_CALL = text(
    "INSERT INTO provider_calls (provider, direction, method, provider_txn_id, order_no, result_code, latency_ms,"
    " client_ip) VALUES (:provider, :direction, :method, :provider_txn_id, :order_no, :result_code, :latency_ms,"
    " CAST(:client_ip AS inet))"
)


class DbProviderCallSink:
    """`provider_calls` в схеме billing (таблица миграции 0001 потока A, хранение 90 дней — чистит tick).
    Отдельная короткая транзакция; сбой записи журнала не влияет на ответ провайдеру (только WARNING)."""

    def __init__(self, runtime: Runtime) -> None:
        self.runtime = runtime

    async def record(self, rec: ProviderCallRecord) -> None:
        if self.runtime.db is None:
            return
        params = {
            "provider": rec.provider[:20],
            "direction": rec.direction,
            "method": rec.method[:40],
            "provider_txn_id": (rec.provider_txn_id or None) and rec.provider_txn_id[:128],
            "order_no": rec.order_no,
            "result_code": rec.result_code[:40],
            "latency_ms": max(0, rec.latency_ms),
            "client_ip": normalize_ip(rec.client_ip),
        }
        try:
            async with self.runtime.transaction() as session:
                await session.execute(_INSERT_CALL, params)
        except Exception as exc:
            log.warning("provider call log failed", extra={"provider": rec.provider, "error_type": type(exc).__name__})


# ---------------------------------------------------------------- исходящие вызовы провайдеров

class ProviderUnavailable(Exception):
    """Сеть, таймаут, 5xx после повтора или открытый circuit breaker; `code` — для журнала и `failure_code`."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True, slots=True)
class HttpResult:
    status_code: int
    body: Any  # разобранный JSON (числа с дробной частью — строки) или None


RetryPolicy = Literal["network", "connect"]


class ProviderHttp:
    """HTTP к провайдеру: таймаут `timeout` (10 с, §0.3), `OUTBOUND_RETRIES` повтор на сеть/5xx — для чтения;
    для команд с последствиями (`retry="connect"`: возврат, фискализация) — повтор, только если соединение не
    установлено (запрос точно не ушёл). Circuit breaker на провайдера. Каждый вызов — `provider_calls` (out)."""

    def __init__(self, provider: str, base_url: str, *, timeout: float,
                 transport: httpx.AsyncBaseTransport | None = None,
                 sink: ProviderCallSink | None = None, breaker: CircuitBreaker | None = None,
                 retries: int = OUTBOUND_RETRIES, retry_delay: float = OUTBOUND_RETRY_DELAY_SECONDS) -> None:
        self.provider = provider
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.transport = transport
        self.sink: ProviderCallSink = sink or NullCallSink()
        self.breaker = breaker or CircuitBreaker(threshold=BREAKER_THRESHOLD, cooldown=BREAKER_COOLDOWN_SECONDS)
        self.retries = retries
        self.retry_delay = retry_delay
        self._client: httpx.AsyncClient | None = None

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(base_url=self.base_url, timeout=self.timeout, transport=self.transport,
                                             follow_redirects=False)
        return self._client

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def request(self, method: str, path: str, *, op: str, headers: Mapping[str, str] | None = None,
                      json_body: Any = None, retry: RetryPolicy = "network", order_no: int | None = None,
                      provider_txn_id: str | None = None,
                      result_code: Callable[[HttpResult], str] | None = None) -> HttpResult:
        """→ HttpResult для любого ответа < 500 (4xx провайдера разбирает адаптер); ProviderUnavailable — сеть,
        таймаут, 5xx, не-JSON или открытый breaker."""
        if not self.breaker.allow():
            await self._log(op, "CIRCUIT_OPEN", 0, order_no, provider_txn_id)
            raise ProviderUnavailable("CIRCUIT_OPEN")
        attempts = 1 + max(0, self.retries)
        for attempt in range(1, attempts + 1):
            started = time.perf_counter()
            try:
                resp = await self._http().request(method, path, headers=dict(headers or {}), json=json_body)
            except httpx.TransportError as exc:
                latency = _elapsed_ms(started)
                self.breaker.failure()
                code = "TIMEOUT" if isinstance(exc, httpx.TimeoutException) else "NETWORK"
                await self._log(op, code, latency, order_no, provider_txn_id)
                not_sent = isinstance(exc, httpx.ConnectError | httpx.ConnectTimeout)
                if attempt < attempts and (retry == "network" or not_sent):
                    await asyncio.sleep(self.retry_delay * attempt)
                    continue
                log.warning("provider call failed", extra={"provider": self.provider, "op": op,
                                                           "error_type": type(exc).__name__})
                raise ProviderUnavailable(code) from exc
            latency = _elapsed_ms(started)
            if resp.status_code >= 500:
                self.breaker.failure()
                await self._log(op, f"HTTP_{resp.status_code}", latency, order_no, provider_txn_id)
                if attempt < attempts and retry == "network":
                    await asyncio.sleep(self.retry_delay * attempt)
                    continue
                log.warning("provider call failed", extra={"provider": self.provider, "op": op,
                                                           "status": resp.status_code})
                raise ProviderUnavailable(f"HTTP_{resp.status_code}")
            self.breaker.success()
            body: Any = None
            if resp.content:
                try:
                    body = parse_json(resp.content)
                except BadJson as exc:
                    await self._log(op, "BAD_RESPONSE", latency, order_no, provider_txn_id)
                    raise ProviderUnavailable("BAD_RESPONSE") from exc
            result = HttpResult(resp.status_code, body)
            code = result_code(result) if result_code else str(resp.status_code)
            await self._log(op, code, latency, order_no, provider_txn_id)
            return result
        raise ProviderUnavailable("NETWORK")  # pragma: no cover — цикл всегда выходит return/raise

    async def _log(self, op: str, code: str, latency_ms: int, order_no: int | None,
                   provider_txn_id: str | None) -> None:
        await self.sink.record(ProviderCallRecord(provider=self.provider, direction="out", method=op,
                                                  result_code=code, latency_ms=latency_ms, order_no=order_no,
                                                  provider_txn_id=provider_txn_id))


def _elapsed_ms(started: float) -> int:
    return max(0, int((time.perf_counter() - started) * 1000))


# ---------------------------------------------------------------- сборка адаптеров для ядра (поток A)

StatementSource = Callable[[datetime, datetime], Awaitable[Sequence["TxnView"]]]


class CoreJournalSink:
    """Журнал через `PaymentService.record_call` ядра (поток A) — одна запись `provider_calls` для всех адаптеров."""

    def __init__(self, journal: Any) -> None:
        self.journal = journal

    async def record(self, rec: ProviderCallRecord) -> None:
        await self.journal.record_call(rec.provider, rec.direction, rec.method, rec.result_code, rec.latency_ms,
                                       provider_txn_id=rec.provider_txn_id, order_no=rec.order_no,
                                       client_ip=rec.client_ip)


class StarsStyleJournalSink:
    """Журнал через `record_provider_call(...)` (протокол `ProviderCallJournal` потока G)."""

    def __init__(self, journal: Any) -> None:
        self.journal = journal

    async def record(self, rec: ProviderCallRecord) -> None:
        await self.journal.record_provider_call(
            provider=rec.provider, direction=rec.direction, method=rec.method, provider_txn_id=rec.provider_txn_id,
            order_no=rec.order_no, result_code=rec.result_code, latency_ms=rec.latency_ms, client_ip=rec.client_ip)


def journal_sink(journal: Any) -> ProviderCallSink | None:
    """Журнал реализации порта: `record_call` (ядро A) или `record_provider_call` (как у Stars); нет — None."""
    if journal is not None and callable(getattr(journal, "record_call", None)):
        return CoreJournalSink(journal)
    if journal is not None and callable(getattr(journal, "record_provider_call", None)):
        return StarsStyleJournalSink(journal)
    return None


def core_port(rt: Runtime) -> Any | None:
    """`PaymentService(rt)` ядра (поток A), если есть БД и модуль; иначе None."""
    if rt.db is None and not rt.settings.database_url:
        return None
    try:
        from tilhero_billing.domain.payments import PaymentService
    except ImportError:  # ядро ещё не сдано
        return None
    return PaymentService(rt)


def core_clock(rt: Runtime) -> Callable[[], datetime]:
    """Часы сервиса: `runtime.clock` (тесты ядра подменяют), иначе текущее UTC — как domain/common.now_of."""

    def now() -> datetime:
        clock = getattr(rt, "clock", None)
        return clock() if callable(clock) else utcnow()

    return now


def runtime_parts(rt: Runtime) -> tuple[Settings, ProviderCallSink, Callable[[], datetime], Any | None]:
    """Настройки, журнал `provider_calls`, часы и порт ядра для фабрик `build_adapter(rt)`."""
    port = core_port(rt)
    sink = journal_sink(port) or DbProviderCallSink(rt)
    return cast("Settings", rt.settings), sink, core_clock(rt), port


def build_fiat_adapters(settings: Settings, *, transports: Mapping[str, httpx.AsyncBaseTransport] | None = None,
                        sink: ProviderCallSink | None = None, click_statement: StatementSource | None = None,
                        clock: Callable[[], datetime] = utcnow) -> dict[ProviderCode, ProviderAdapter]:
    """Адаптеры канала `web` по настройкам: {payme, click, uzum}. transports — заглушки исходящих вызовов по имени
    провайдера (тесты); sink — журнал `provider_calls` для исходящих (DbProviderCallSink(runtime));
    click_statement — наши транзакции Click за период (`PaymentPort.statement("click", …)`) для сверки
    `status_by_mti`: без него `ClickAdapter.remote_status` возвращает None."""
    from tilhero_billing.providers.click import ClickAdapter
    from tilhero_billing.providers.payme import PaymeAdapter
    from tilhero_billing.providers.uzum import UzumAdapter

    tr = transports or {}
    return {
        "payme": PaymeAdapter(settings, transport=tr.get("payme"), sink=sink, clock=clock),
        "click": ClickAdapter(settings, transport=tr.get("click"), sink=sink, statement=click_statement, clock=clock),
        "uzum": UzumAdapter(settings, clock=clock),
    }
