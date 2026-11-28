"""Общие помощники фиатных адаптеров: деньги без float (ADR-0001), время, секреты, адрес клиента и CIDR, псевдоним IP
для лимита, исходящий HTTP (таймаут, повтор, circuit breaker, журнал), запись `provider_calls` в БД."""

from __future__ import annotations

import base64
import ipaddress
import uuid
from datetime import UTC, datetime

import asyncpg
import httpx
import pytest
from redis.asyncio import Redis

from tilhero_billing.providers import common
from tilhero_billing.providers.common import (
    BadJson,
    DbProviderCallSink,
    ProviderCallRecord,
    ProviderHttp,
    ProviderUnavailable,
    basic_auth_ok,
    client_ip_from_forwarded,
    dt_to_ms,
    format_sum,
    ip_allowed,
    ip_rate_key,
    ip_subject,
    ms_to_dt,
    normalize_ip,
    parse_basic_auth,
    parse_json,
    parse_sum_string,
    secret_equals,
    vat_inside,
)
from tilhero_common.app import Runtime
from tilhero_common.testing import TEST_ADMIN_URL, TEST_REDIS_URL, create_schema, drop_schema, unique_schema

# ---------------------------------------------------------------- деньги


@pytest.mark.parametrize("raw,tiyin", [("15000.00", 1_500_000), ("15000.5", 1_500_050), ("15000", 1_500_000),
                                       ("0.01", 1), ("1.00", 100), ("999999999999.99", 99_999_999_999_999),
                                       ("007.10", 710)])
def test_parse_sum_string(raw: str, tiyin: int) -> None:
    assert parse_sum_string(raw) == tiyin


@pytest.mark.parametrize("raw", ["", " 1.00", "1.00 ", "1,00", "1.000", "1e5", "-1.00", "+1", "1.", ".5", "NaN",
                                 "inf", "١٢٣", "１２３", "1_000", "1234567890123", "0x10"])
def test_parse_sum_string_rejects(raw: str) -> None:
    assert parse_sum_string(raw) is None


def test_format_sum_and_vat() -> None:
    assert [format_sum(v) for v in (0, 1, 100, 4_900_000, 1_500_050)] == ["0.00", "0.01", "1.00", "49000.00",
                                                                           "15000.50"]
    for bad in (-1, True):
        with pytest.raises(ValueError):
            format_sum(bad)
    # ⌊price × p / (100 + p) + ½⌋, целочисленно
    assert vat_inside(4_900_000, 12) == 525_000
    assert vat_inside(1_500_000, 12) == 160_714
    assert vat_inside(112, 12) == 12 and vat_inside(56, 12) == 6 and vat_inside(1, 12) == 0
    assert vat_inside(4_900_000, 0) == 0
    for price in range(1, 3000, 7):
        exact_num, den = price * 12, 112
        assert vat_inside(price, 12) == (2 * exact_num + den) // (2 * den)


def test_no_float_in_json() -> None:
    data = parse_json(b'{"amount": 4900000, "x": 1.5, "y": [2.0]}')
    assert data == {"amount": 4900000, "x": "1.5", "y": ["2.0"]}
    for raw in (b'{"a": NaN}', b'{"a": -Infinity}', b"\xff", b"{"):
        with pytest.raises(BadJson):
            parse_json(raw)


# ---------------------------------------------------------------- время

def test_ms_roundtrip_without_float() -> None:
    ms = 1_795_336_445_455
    dt = ms_to_dt(ms)
    assert dt.tzinfo is UTC and dt_to_ms(dt) == ms and dt.microsecond == 455_000
    assert dt_to_ms(datetime(1970, 1, 1)) == 0  # наивное — UTC


# ---------------------------------------------------------------- секреты

def test_secret_equals_and_basic() -> None:
    assert secret_equals("test-a", "test-a") and not secret_equals("test-b", "test-a")
    assert not secret_equals("", "") and not secret_equals(None, "test-a") and not secret_equals("x", "")
    assert secret_equals(b"test-a", "test-a")
    header = "Basic " + base64.b64encode(b"Paycom:test-key:with:colons").decode()
    assert parse_basic_auth(header) == ("Paycom", "test-key:with:colons")
    assert basic_auth_ok(header, "Paycom", "test-key:with:colons")
    assert not basic_auth_ok(header, "Paycom", "test-key")
    assert not basic_auth_ok(header, "paycom", "test-key:with:colons")
    for bad in (None, "", "Basic", "Bearer x", "Basic ***", "Basic " + base64.b64encode(b"nocolon").decode()):
        assert parse_basic_auth(bad) is None
    assert not basic_auth_ok("Basic " + base64.b64encode(b"Paycom:").decode(), "Paycom", "")


# ---------------------------------------------------------------- адрес клиента и CIDR

@pytest.mark.parametrize("xff,ip", [
    ("6.6.6.6, 185.234.113.7, 10.0.0.2", "185.234.113.7"),  # клиент подделал крайний левый
    ("185.234.113.7, 100.64.0.3", "185.234.113.7"),
    ("185.234.113.7", None),  # нет edge — адрес неизвестен
    ("", None),
    (None, None),
    ("garbage, 100.64.0.3", None),
    ("2001:db8::1, 100.64.0.3", "2001:db8::1"),
    ("::ffff:185.234.113.7, 100.64.0.3", "185.234.113.7"),
    ("[2001:db8::1]:443, 100.64.0.3", "2001:db8::1"),
])
def test_client_ip_second_from_right(xff: str | None, ip: str | None) -> None:
    assert client_ip_from_forwarded(xff) == ip


def test_ip_allowed() -> None:
    nets = [ipaddress.ip_network("185.234.113.0/24"), ipaddress.ip_network("2001:db8::/32")]
    assert ip_allowed("185.234.113.7", nets) and ip_allowed("2001:db8::5", nets)
    assert ip_allowed("::ffff:185.234.113.7", nets)
    assert not ip_allowed("185.234.114.1", nets) and not ip_allowed(None, nets) and not ip_allowed("x", nets)
    assert ip_allowed(None, []) and ip_allowed("8.8.8.8", [])  # пустой список — проверка выключена (В16)
    assert normalize_ip(" 10.0.0.1 ") == "10.0.0.1" and normalize_ip("fe80::1%eth0") == "fe80::1"


def test_ip_rate_key_like_ts_common() -> None:
    assert ip_rate_key("185.234.113.7") == "185.234.113.7"
    assert ip_rate_key("2001:db8:1:2:3:4:5:6") == "2001:0db8:0001:0002::/64"
    assert ip_rate_key("::ffff:10.1.2.3") == "10.1.2.3"


async def test_ip_subject_daily_salt_hides_address() -> None:
    redis = Redis.from_url(TEST_REDIS_URL, decode_responses=True)
    prefix = f"t:{uuid.uuid4().hex[:8]}:"
    try:
        now = datetime(2026, 11, 22, 12, tzinfo=UTC)
        a = await ip_subject(redis, "185.234.113.7", now=now, prefix=prefix)
        assert a == await ip_subject(redis, "185.234.113.7", now=now, prefix=prefix) and len(a) == 16
        assert a != await ip_subject(redis, "185.234.113.8", now=now, prefix=prefix)
        assert await ip_subject(redis, "2001:db8::1", now=now, prefix=prefix) == await ip_subject(
            redis, "2001:db8::ffff", now=now, prefix=prefix)  # одна сеть /64
        assert a != await ip_subject(redis, "185.234.113.7", now=now.replace(day=23), prefix=prefix)
        assert await ip_subject(redis, None, now=now, prefix=prefix) == "unknown"
        assert "185.234.113.7" not in a
        assert await redis.ttl(f"{prefix}rl:salt:2026-11-22") > 0
    finally:
        keys = [k async for k in redis.scan_iter(f"{prefix}*")]
        if keys:
            await redis.delete(*keys)
        await redis.aclose()


# ---------------------------------------------------------------- исходящий HTTP

class ListSink:
    def __init__(self) -> None:
        self.records: list[ProviderCallRecord] = []

    async def record(self, rec: ProviderCallRecord) -> None:
        self.records.append(rec)


def scripted(*steps: object) -> tuple[httpx.MockTransport, list[httpx.Request]]:
    seen: list[httpx.Request] = []
    queue = list(steps)

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        step = queue.pop(0) if queue else 200
        if isinstance(step, type) and issubclass(step, Exception):
            raise step("scripted", request=request)  # type: ignore[call-arg]
        assert isinstance(step, int)
        return httpx.Response(step, json={"error_code": 0, "ok": 1.5})

    return httpx.MockTransport(handler), seen


def http(transport: httpx.MockTransport, sink: ListSink) -> ProviderHttp:
    return ProviderHttp("click", "https://api.click.test/v2/merchant", timeout=10.0, transport=transport, sink=sink,
                        retry_delay=0)


async def test_read_retries_once_on_5xx_and_network() -> None:
    sink = ListSink()
    transport, seen = scripted(503, 200)
    res = await http(transport, sink).request("GET", "/payment/status", op="status")
    assert res.status_code == 200 and res.body == {"error_code": 0, "ok": "1.5"} and len(seen) == 2
    assert [r.result_code for r in sink.records] == ["HTTP_503", "200"]
    assert all(r.direction == "out" and r.provider == "click" and r.latency_ms >= 0 for r in sink.records)
    transport, seen = scripted(httpx.ReadTimeout, 200)
    assert (await http(transport, sink).request("GET", "/x", op="status")).status_code == 200 and len(seen) == 2
    transport, seen = scripted(503, 503)
    with pytest.raises(ProviderUnavailable) as exc:
        await http(transport, sink).request("GET", "/x", op="status")
    assert exc.value.code == "HTTP_503" and len(seen) == 2


async def test_command_retries_only_when_not_sent() -> None:
    sink = ListSink()
    transport, seen = scripted(httpx.ConnectError, 200)
    assert (await http(transport, sink).request("DELETE", "/r", op="reversal", retry="connect")).status_code == 200
    assert len(seen) == 2
    for first in (httpx.ReadTimeout, 502):
        transport, seen = scripted(first, 200)
        with pytest.raises(ProviderUnavailable):
            await http(transport, sink).request("DELETE", "/r", op="reversal", retry="connect")
        assert len(seen) == 1


async def test_4xx_is_returned_not_retried() -> None:
    transport, seen = scripted(401, 200)
    res = await http(transport, ListSink()).request("GET", "/x", op="status")
    assert res.status_code == 401 and len(seen) == 1


async def test_bad_json_response_is_unavailable() -> None:
    transport = httpx.MockTransport(lambda r: httpx.Response(200, content=b"<html>"))
    with pytest.raises(ProviderUnavailable) as exc:
        await http(transport, ListSink()).request("GET", "/x", op="status")
    assert exc.value.code == "BAD_RESPONSE"


async def test_circuit_breaker_opens_and_half_opens(monkeypatch: pytest.MonkeyPatch) -> None:
    sink = ListSink()
    transport, seen = scripted(*([503] * 20))
    client = http(transport, sink)
    client.retries = 0
    for _ in range(common.BREAKER_THRESHOLD):
        with pytest.raises(ProviderUnavailable):
            await client.request("GET", "/x", op="status")
    with pytest.raises(ProviderUnavailable) as exc:
        await client.request("GET", "/x", op="status")
    assert exc.value.code == "CIRCUIT_OPEN" and len(seen) == common.BREAKER_THRESHOLD
    assert sink.records[-1].result_code == "CIRCUIT_OPEN"
    # после паузы — одна пробная попытка
    client.breaker.opened_at = (client.breaker.opened_at or 0) - common.BREAKER_COOLDOWN_SECONDS - 1
    with pytest.raises(ProviderUnavailable):
        await client.request("GET", "/x", op="status")
    assert len(seen) == common.BREAKER_THRESHOLD + 1


async def test_absolute_url_and_timeout() -> None:
    transport, seen = scripted(200)
    client = ProviderHttp("payme", "", timeout=10.0, transport=transport)
    await client.request("POST", "https://checkout.test.paycom.uz/api", op="receipts.get_all", json_body={"id": 1})
    assert str(seen[0].url) == "https://checkout.test.paycom.uz/api"
    assert client._http().timeout.read == 10.0
    await client.aclose()


# ---------------------------------------------------------------- provider_calls в БД

PROVIDER_CALLS_DDL = """
CREATE TABLE provider_calls (
  call_id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider        text NOT NULL,
  direction       text NOT NULL CHECK (direction IN ('in','out')),
  method          text NOT NULL CHECK (char_length(method) <= 40),
  provider_txn_id text,
  order_no        bigint,
  result_code     text NOT NULL,
  latency_ms      integer NOT NULL CHECK (latency_ms >= 0),
  client_ip       inet,
  created_at      timestamptz NOT NULL DEFAULT now()
)"""


async def test_db_sink_writes_metadata_only() -> None:
    """Таблица — по DDL INTERNAL_API §1.1 (миграция 0001 потока A); пишутся только метаданные."""
    from conftest import make_settings

    schema = unique_schema("bill_calls")
    await create_schema(schema)
    try:
        conn = await asyncpg.connect(TEST_ADMIN_URL)
        try:
            await conn.execute(f'SET search_path TO "{schema}"')
            await conn.execute(PROVIDER_CALLS_DDL)
        finally:
            await conn.close()
        settings = make_settings(database_url=TEST_ADMIN_URL, db_schema=schema, redis_url=None)
        rt = Runtime(settings)
        await rt.start()
        try:
            sink = DbProviderCallSink(rt)
            await sink.record(ProviderCallRecord(provider="payme", direction="in", method="x" * 60, result_code="0",
                                                 latency_ms=12, provider_txn_id="6745a1b2c3d4e5f600000001",
                                                 order_no=100001, client_ip="::ffff:185.234.113.7"))
            await sink.record(ProviderCallRecord(provider="click", direction="out", method="reversal",
                                                 result_code="-5014", latency_ms=-3, client_ip="garbage"))
        finally:
            await rt.stop()
        conn = await asyncpg.connect(TEST_ADMIN_URL, server_settings={"search_path": schema})
        try:
            rows = await conn.fetch("SELECT * FROM provider_calls ORDER BY call_id")
        finally:
            await conn.close()
        assert len(rows) == 2
        assert rows[0]["method"] == "x" * 40 and str(rows[0]["client_ip"]) == "185.234.113.7"
        assert rows[0]["order_no"] == 100001 and rows[0]["provider_txn_id"] == "6745a1b2c3d4e5f600000001"
        assert rows[1]["client_ip"] is None and rows[1]["latency_ms"] == 0 and rows[1]["direction"] == "out"
        assert set(rows[0].keys()) == {"call_id", "provider", "direction", "method", "provider_txn_id", "order_no",
                                       "result_code", "latency_ms", "client_ip", "created_at"}
    finally:
        await drop_schema(schema)


async def test_db_sink_failure_is_swallowed(caplog: pytest.LogCaptureFixture) -> None:
    from conftest import make_settings

    schema = unique_schema("bill_nocalls")
    await create_schema(schema)
    try:
        rt = Runtime(make_settings(database_url=TEST_ADMIN_URL, db_schema=schema, redis_url=None))
        await rt.start()
        try:
            await DbProviderCallSink(rt).record(ProviderCallRecord(provider="payme", direction="in", method="m",
                                                                   result_code="0", latency_ms=1))
        finally:
            await rt.stop()
        assert "provider call log failed" in caplog.text
    finally:
        await drop_schema(schema)
    no_db = Runtime(make_settings(redis_url=None))
    await DbProviderCallSink(no_db).record(ProviderCallRecord(provider="payme", direction="in", method="m",
                                                              result_code="0", latency_ms=1))
