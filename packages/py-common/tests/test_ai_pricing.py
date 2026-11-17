"""Формула стоимости (A36): детерминизм, раздельные ставки кэша, quantize, unpriced, резерв ≥ стоимости —
property-тесты на детерминированном генераторе (без сети и БД)."""

from __future__ import annotations

import random
from decimal import Decimal

import pytest

from tilhero_common.ai_pricing import (
    Catalog,
    CatalogItem,
    ExternalCall,
    ModelRates,
    UsageIn,
    catalog_from_json,
    content_hash,
    cost,
    cost_micro,
    env_catalog,
    from_micro,
    parse_rate,
    q6,
    to_micro,
    worst_case_micro,
    worst_case_micro_tokens,
)

D = Decimal
HAIKU = "claude-haiku-4-5"


def catalog(version: str = "2026-10-12", **rates: str) -> Catalog:
    r = {"input": "1.00", "output": "5.00", "cw": "1.25", "cr": "0.10", **rates}
    return Catalog.build(version, [
        CatalogItem("model", HAIKU, D(r["input"]), D(r["output"]), D(r["cw"]), D(r["cr"])),
        CatalogItem("external_api", "aviasales.search", per_call_usd=D("0.002")),
        CatalogItem("request_fee", "anthropic", per_call_usd=D("0")),
    ])


def test_example_with_cache_tokens_uses_own_rates() -> None:
    """Пример UsageRecord §2.4: 3200 in, 800 out, 2100 cache write. Кэш не по цене input (исправление дефекта 9)."""
    b = cost(UsageIn(HAIKU, 3200, 800, 2100, 0), catalog())
    assert b.status == "priced" and b.price_catalog_version == "2026-10-12"
    assert (b.llm_input_usd, b.llm_output_usd, b.cache_write_usd, b.cache_read_usd) == (
        D("0.003200"), D("0.004000"), D("0.002625"), D("0.000000"))
    assert b.total_cost_usd == D("0.009825")
    env = Catalog.build("env", [CatalogItem("model", HAIKU, D("1"), D("5"), D("1"), D("1"))])
    assert cost(UsageIn(HAIKU, 3200, 800, 2100, 0), env).total_cost_usd == D("0.009300")  # прежнее поведение
    reads = cost(UsageIn(HAIKU, 1000, 0, 0, 50_000), catalog())
    assert reads.cache_read_usd == D("0.005000") and reads.total_cost_usd == D("0.006000")


def test_each_part_is_quantized_half_up_before_sum() -> None:
    c = catalog(input="0.25", output="1.25", cw="0.30", cr="0.03")
    b = cost(UsageIn(HAIKU, 3, 1, 5, 17), c)
    # 3·0.25/1e6 = 0.00000075 → 0.000001; 1·1.25/1e6 = 0.00000125 → 0.000001; 5·0.30 = 0.0000015 → 0.000002;
    # 17·0.03 = 0.00000051 → 0.000001 (каждое слагаемое — q6 HALF_UP)
    assert (b.llm_input_usd, b.llm_output_usd, b.cache_write_usd, b.cache_read_usd) == (
        D("0.000001"), D("0.000001"), D("0.000002"), D("0.000001"))
    assert b.total_cost_usd == D("0.000005")
    assert q6(D("0.0000005")) == D("0.000001") and q6(D("0.00000049")) == D("0")


def test_external_calls_and_fee() -> None:
    c = Catalog.build("v", [CatalogItem("model", HAIKU, D(1), D(5), D(1), D("0.1")),
                            CatalogItem("external_api", "aviasales.search", per_call_usd=D("0.0025")),
                            CatalogItem("request_fee", "*", per_call_usd=D("0.0001"))])
    b = cost(UsageIn(HAIKU, 0, 0, external_api_calls=(ExternalCall("aviasales.search", 3),)), c)
    assert b.external_api_usd == D("0.007500") and b.request_fee_usd == D("0.000100")
    assert b.total_cost_usd == D("0.007600") and b.llm_cost_usd == D("0.000100")
    missing = cost(UsageIn(HAIKU, 1, 1, external_api_calls=(ExternalCall("hotellook.search", 1),)), c)
    assert missing.status == "unpriced" and missing.unpriced == ("external_api:hotellook.search",)


@pytest.mark.parametrize("model_rates", [None, (D(1), D(5), None, None)])
def test_unpriced_model_is_not_silent_zero(model_rates) -> None:
    items = [] if model_rates is None else [CatalogItem("model", HAIKU, *model_rates)]
    b = cost(UsageIn(HAIKU, 100, 100), Catalog.build("2026-10-12", items))
    assert b.status == "unpriced" and b.total_cost_usd is None and b.llm_cost_usd is None
    assert b.unpriced == (f"model:{HAIKU}",)
    assert b.as_json()["total_cost_usd"] is None


def test_negative_or_bool_tokens_rejected() -> None:
    for bad in (-1, True):
        with pytest.raises(ValueError):
            cost(UsageIn(HAIKU, bad, 0), catalog())  # type: ignore[arg-type]


def _random_usage(rng: random.Random) -> UsageIn:
    return UsageIn(HAIKU, rng.randint(0, 200_000), rng.randint(0, 8000), rng.randint(0, 50_000),
                   rng.randint(0, 200_000),
                   external_api_calls=tuple(ExternalCall("aviasales.search", rng.randint(1, 3))
                                            for _ in range(rng.randint(0, 2))))


def test_property_deterministic_and_order_independent() -> None:
    """A36: одинаковый usage + та же версия → та же стоимость; порядок строк каталога и «рестарт» (новый разбор
    каталога) не влияют; итог = сумма частей; каждая часть ≥ 0 и кратна 0.000001."""
    rng = random.Random(20261012)
    base = catalog()
    shuffled_items = list(base.items)
    for _ in range(300):
        u = _random_usage(rng)
        rng.shuffle(shuffled_items)
        restarted = Catalog.build(base.version, list(shuffled_items))
        a, b = cost(u, base), cost(u, restarted)
        assert a == b and a.as_json() == b.as_json()
        parts = [a.llm_input_usd, a.llm_output_usd, a.cache_write_usd, a.cache_read_usd, a.request_fee_usd,
                 a.external_api_usd]
        assert all(p is not None and p >= 0 and p == q6(p) for p in parts)
        assert a.total_cost_usd == sum(parts, D(0))  # type: ignore[arg-type]
    assert content_hash(base.items) == content_hash(reversed(base.items))


def test_property_cost_depends_on_catalog_version_only() -> None:
    rng = random.Random(7)
    old = catalog("2026-10-12")
    new = catalog("2026-11-01", input="2.00", output="9.00", cw="2.50", cr="0.20")
    for _ in range(100):
        u = _random_usage(rng)
        a, b = cost(u, old), cost(u, new)
        assert a.price_catalog_version == "2026-10-12" and b.price_catalog_version == "2026-11-01"
        assert cost(u, old) == a  # пересчёт по старой версии после появления новой — тот же
        if u.tokens_in or u.tokens_out or u.cache_write_tokens or u.cache_read_tokens:
            assert b.llm_cost_usd >= a.llm_cost_usd  # type: ignore[operator]


def test_property_monotonic_in_tokens() -> None:
    rng = random.Random(11)
    c = catalog()
    for _ in range(200):
        u = _random_usage(rng)
        more = UsageIn(HAIKU, u.tokens_in + rng.randint(0, 1000), u.tokens_out + rng.randint(0, 100),
                       u.cache_write_tokens, u.cache_read_tokens, external_api_calls=u.external_api_calls)
        assert cost(more, c).total_cost_usd >= cost(u, c).total_cost_usd  # type: ignore[operator]


def test_property_worst_case_reserve_covers_cost() -> None:
    """Резерв gateway (§3.1) ≥ фактической стоимости для любого usage в пределах (вход ≤ символов/2, выход ≤
    max_tokens), если ставка чтения кэша не выше input."""
    rng = random.Random(3)
    c = Catalog.build("v", [CatalogItem("model", HAIKU, D(1), D(5), D("1.25"), D("0.1"))])
    for _ in range(300):
        chars, max_tokens = rng.randint(0, 400_000), rng.randint(1, 4096)
        budget_in = -(-chars // 2)
        tin = rng.randint(0, budget_in)
        cw = rng.randint(0, budget_in - tin)
        cr = budget_in - tin - cw
        u = UsageIn(HAIKU, tin, rng.randint(0, max_tokens), cw, cr)
        reserve = worst_case_micro(c, HAIKU, input_chars=chars, max_tokens=max_tokens)
        # части округляются HALF_UP по отдельности (до +2 µ$ к точной сумме) — резерв включает этот запас
        assert reserve is not None and to_micro(cost(u, c).total_cost_usd) <= reserve  # type: ignore[arg-type]
    assert worst_case_micro(c, "claude-unknown", input_chars=10, max_tokens=10) is None
    assert from_micro(9300) == D("0.009300") and to_micro(D("0.0000001")) == 1


@pytest.mark.parametrize("value,ok", [("1.00", True), ("0", True), ("1000", True), ("0.000001", True),
                                      ("1000.01", False), ("-1", False), ("0.0000001", False), ("abc", False),
                                      ("NaN", False), (1.5, False), (True, False)])
def test_parse_rate(value, ok) -> None:
    if ok:
        assert parse_rate(value) == D(str(value))
    else:
        with pytest.raises(ValueError):
            parse_rate(value)
    assert parse_rate(None) is None and parse_rate("") is None


def test_shared_helpers_for_gateway() -> None:
    """Общие функции gateway: стоимость в µ$, резерв по токенам, разбор ответа pricing/active, env-каталог."""
    c = catalog_from_json({"version": "2026-10-12", "items": [
        {"kind": "model", "key": HAIKU, "input_usd_per_mtok": "1.00", "output_usd_per_mtok": "5.00",
         "cache_write_usd_per_mtok": "1.25", "cache_read_usd_per_mtok": "0.10"},
        {"kind": "model", "key": "claude-sonnet-x", "input_usd_per_mtok": "3.00", "output_usd_per_mtok": None,
         "cache_write_usd_per_mtok": None, "cache_read_usd_per_mtok": None},
        {"kind": "model", "key": "bad", "input_usd_per_mtok": 1.5},
        {"kind": "request_fee", "key": "anthropic", "per_call_usd": "0.0002"},
        "junk",
    ]})
    assert c is not None and c.version == "2026-10-12"
    assert c.rates(HAIKU) is not None and c.rates("claude-sonnet-x") is None and c.rates("bad") is None
    assert c.fee_for("anthropic") == D("0.0002")
    u = UsageIn(HAIKU, 3200, 800, 2100, 0)
    assert cost_micro(u, c) == 3200 + 4000 + 2625 + 200
    assert cost_micro(UsageIn("claude-sonnet-x", 1), c) is None
    assert worst_case_micro_tokens(c, HAIKU, input_tokens=1000, max_tokens=100) == 1250 + 500 + 200 + 2
    assert worst_case_micro(c, HAIKU, input_chars=2000, max_tokens=100) == 1250 + 500 + 200 + 2
    assert catalog_from_json({"items": []}) is None and catalog_from_json([]) is None
    env = env_catalog(HAIKU, D("1.00"), D("5.00"))
    assert env.version == "env" and env.rates(HAIKU) == ModelRates(D(1), D(5), D(1), D(1))
    assert cost_micro(UsageIn(HAIKU, 0, 0, 1000, 1000), env) == 2000  # env: кэш по цене input (как до спринта 7)
