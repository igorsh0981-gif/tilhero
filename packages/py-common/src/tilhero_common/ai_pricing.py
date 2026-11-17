"""Формула стоимости вызова модели по версии каталога цен (спринт 7, INTERNAL_API §2.5, §3.4, A36).

Общий модуль: ai-control (учёт, `cost_records`) и provider-gateway (резерв до вызова и списание) считают одной
функцией — расхождение `gateway_cost_micro` и стоимости ai-control не возникает из-за формулы. Чистые функции без
ввода-вывода, только Decimal и целые микродоллары, без float.

    llm      = q6(tokens_in·r_in/10⁶) + q6(tokens_out·r_out/10⁶) + q6(cache_write·r_cw/10⁶)
               + q6(cache_read·r_cr/10⁶) + fee
    external = Σ q6(count·per_call)
    total    = llm + external,   q6 — quantize 0.000001 ROUND_HALF_UP

Стоимость считается по версии каталога из записи usage (той, которой gateway резервировал), а не по текущей активной.
Модели (или внешнего API) нет в версии или у неё не заполнены ставки → `status = "unpriced"`, суммы None — не ноль
молча.

Резерв худшего случая (`worst_case_micro*`) округляется вверх и включает `ROUNDING_MARGIN_MICRO` (2 µ$): части
стоимости округляются HALF_UP по отдельности, и фактическая стоимость может превысить точную сумму до 2 µ$ — резерв
всегда не меньше списания.

Переиспользование GymBot (`_log_ai_usage`, /home/claude/ref/gymbot-api/api.py:135-152) с исправлением дефекта 9
reuse_map: цены не «Sonnet для всех моделей» — ставки берутся по ключу модели из версии каталога; cache-токены
(запись и чтение) тарифицируются своими ставками (как `_compute_cost_usd` FinAdvisor), а не по цене input
и не теряются; float заменён на Decimal.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from decimal import ROUND_CEILING, ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any

Q6 = Decimal("0.000001")
MTOK = Decimal(1_000_000)
MICRO = Decimal(1_000_000)
RATE_MAX = Decimal("1000")
ENV_VERSION = "env"
KINDS = ("model", "external_api", "request_fee")
ROUNDING_MARGIN_MICRO = 2  # до +2 µ$ от раздельного HALF_UP четырёх токенных частей
RATE_FIELDS = ("input_usd_per_mtok", "output_usd_per_mtok", "cache_write_usd_per_mtok", "cache_read_usd_per_mtok")


def q6(value: Decimal) -> Decimal:
    return value.quantize(Q6, rounding=ROUND_HALF_UP)


def to_micro(usd: Decimal) -> int:
    """Доллары → целые микродоллары, вверх (резерв никогда не меньше стоимости)."""
    return int((usd * MICRO).to_integral_value(rounding=ROUND_CEILING))


def from_micro(micro: int) -> Decimal:
    return q6(Decimal(micro) / MICRO)


def money(value: Decimal | None) -> str | None:
    """Деньги в JSON — строкой с 6 знаками."""
    return None if value is None else f"{q6(value):f}"


def parse_rate(value: Any) -> Decimal | None:
    """Ставка из JSON: строка-число 0..1000, не больше 6 знаков; None/"" — не задана. Иначе ValueError."""
    if value is None or value == "":
        return None
    if isinstance(value, bool) or not isinstance(value, str | int):
        raise ValueError("rate must be a decimal string")
    try:
        d = Decimal(str(value).strip())
    except InvalidOperation as exc:
        raise ValueError("rate must be a decimal string") from exc
    if not d.is_finite() or d < 0 or d > RATE_MAX:
        raise ValueError("rate must be within 0..1000")
    exponent = d.as_tuple().exponent
    if isinstance(exponent, int) and exponent < -6:
        raise ValueError("rate must have at most 6 decimal places")
    return d


@dataclass(frozen=True)
class ModelRates:
    input: Decimal | None
    output: Decimal | None
    cache_write: Decimal | None
    cache_read: Decimal | None

    @property
    def complete(self) -> bool:
        return None not in (self.input, self.output, self.cache_write, self.cache_read)


@dataclass(frozen=True)
class CatalogItem:
    kind: str
    key: str
    input_usd_per_mtok: Decimal | None = None
    output_usd_per_mtok: Decimal | None = None
    cache_write_usd_per_mtok: Decimal | None = None
    cache_read_usd_per_mtok: Decimal | None = None
    per_call_usd: Decimal | None = None

    def as_json(self) -> dict[str, Any]:
        return {"kind": self.kind, "key": self.key, **{f: money(getattr(self, f)) for f in (*RATE_FIELDS,
                                                                                           "per_call_usd")}}


@dataclass(frozen=True)
class Catalog:
    """Версия каталога цен (неизменяемая после активации)."""

    version: str
    items: tuple[CatalogItem, ...] = ()
    models: Mapping[str, ModelRates] = field(default_factory=dict)
    external: Mapping[str, Decimal | None] = field(default_factory=dict)
    fees: Mapping[str, Decimal | None] = field(default_factory=dict)

    @classmethod
    def build(cls, version: str, items: Iterable[CatalogItem]) -> Catalog:
        items = tuple(sorted(items, key=lambda i: (i.kind, i.key)))
        models = {i.key: ModelRates(i.input_usd_per_mtok, i.output_usd_per_mtok, i.cache_write_usd_per_mtok,
                                    i.cache_read_usd_per_mtok) for i in items if i.kind == "model"}
        external = {i.key: i.per_call_usd for i in items if i.kind == "external_api"}
        fees = {i.key: i.per_call_usd for i in items if i.kind == "request_fee"}
        return cls(version, items, models, external, fees)

    def model_priced(self, model: str) -> bool:
        rates = self.models.get(model)
        return rates is not None and rates.complete

    def rates(self, model: str) -> ModelRates | None:
        """Ставки модели, только если заполнены все четыре; иначе None (модель не оценена)."""
        rates = self.models.get(model)
        return rates if rates is not None and rates.complete else None

    def priced_models(self) -> list[str]:
        return sorted(k for k, r in self.models.items() if r.complete)

    def fee_for(self, provider: str) -> Decimal | None:
        """Плата за запрос: ключ провайдера (`anthropic`), иначе `*`; нет строки — 0."""
        if provider in self.fees:
            return self.fees[provider]
        if "*" in self.fees:
            return self.fees["*"]
        return Decimal(0)

    def content_hash(self) -> str:
        return content_hash(self.items)


def content_hash(items: Iterable[CatalogItem]) -> str:
    """sha256 канонического JSON строк каталога (ETag и защита от подмены)."""
    data = [i.as_json() for i in sorted(items, key=lambda i: (i.kind, i.key))]
    return hashlib.sha256(json.dumps(data, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


@dataclass(frozen=True)
class ExternalCall:
    key: str
    count: int


@dataclass(frozen=True)
class UsageIn:
    model: str
    tokens_in: int = 0
    tokens_out: int = 0
    cache_write_tokens: int = 0
    cache_read_tokens: int = 0
    model_provider: str = "anthropic"
    external_api_calls: tuple[ExternalCall, ...] = ()


@dataclass(frozen=True)
class CostBreakdown:
    status: str  # priced | unpriced
    price_catalog_version: str
    llm_input_usd: Decimal | None = None
    llm_output_usd: Decimal | None = None
    cache_write_usd: Decimal | None = None
    cache_read_usd: Decimal | None = None
    request_fee_usd: Decimal | None = None
    external_api_usd: Decimal | None = None
    unpriced: tuple[str, ...] = ()

    @property
    def llm_cost_usd(self) -> Decimal | None:
        parts = (self.llm_input_usd, self.llm_output_usd, self.cache_write_usd, self.cache_read_usd,
                 self.request_fee_usd)
        known = [p for p in parts if p is not None]
        return None if len(known) != len(parts) else sum(known, Decimal(0))

    @property
    def total_cost_usd(self) -> Decimal | None:
        llm = self.llm_cost_usd
        return None if llm is None or self.external_api_usd is None else llm + self.external_api_usd

    def as_json(self) -> dict[str, Any]:
        return {
            "llm_input_usd": money(self.llm_input_usd), "llm_output_usd": money(self.llm_output_usd),
            "cache_write_usd": money(self.cache_write_usd), "cache_read_usd": money(self.cache_read_usd),
            "request_fee_usd": money(self.request_fee_usd), "external_api_usd": money(self.external_api_usd),
            "total_cost_usd": money(self.total_cost_usd), "price_catalog_version": self.price_catalog_version,
        }


def _part(tokens: int, rate: Decimal) -> Decimal:
    return q6(Decimal(tokens) * rate / MTOK)


def cost(usage: UsageIn, catalog: Catalog) -> CostBreakdown:
    """Детерминированная стоимость вызова по версии каталога (A36): одинаковый usage + версия → та же сумма."""
    for n in (usage.tokens_in, usage.tokens_out, usage.cache_write_tokens, usage.cache_read_tokens):
        if not isinstance(n, int) or isinstance(n, bool) or n < 0:
            raise ValueError("token counts must be non-negative integers")
    missing: list[str] = []
    rates = catalog.models.get(usage.model)
    if rates is None or not rates.complete:
        missing.append(f"model:{usage.model}")
    fee = catalog.fee_for(usage.model_provider)
    if fee is None:
        missing.append(f"request_fee:{usage.model_provider}")
    external = Decimal(0)
    for call in usage.external_api_calls:
        per_call = catalog.external.get(call.key)
        if per_call is None:
            missing.append(f"external_api:{call.key}")
            continue
        external += q6(Decimal(call.count) * per_call)
    if missing:
        return CostBreakdown(status="unpriced", price_catalog_version=catalog.version, unpriced=tuple(missing))
    assert rates is not None and fee is not None
    return CostBreakdown(
        status="priced",
        price_catalog_version=catalog.version,
        llm_input_usd=_part(usage.tokens_in, rates.input),  # type: ignore[arg-type]
        llm_output_usd=_part(usage.tokens_out, rates.output),  # type: ignore[arg-type]
        cache_write_usd=_part(usage.cache_write_tokens, rates.cache_write),  # type: ignore[arg-type]
        cache_read_usd=_part(usage.cache_read_tokens, rates.cache_read),  # type: ignore[arg-type]
        request_fee_usd=q6(fee),
        external_api_usd=external,
    )


def cost_micro(usage: UsageIn, catalog: Catalog) -> int | None:
    """Стоимость в целых µ$ (части уже кратны 0.000001 — точное значение); не оценено — None."""
    total = cost(usage, catalog).total_cost_usd
    return None if total is None else int(total * MICRO)


def worst_case_micro_tokens(catalog: Catalog, model: str, *, input_tokens: int, max_tokens: int,
                            provider: str = "anthropic") -> int | None:
    """Худший случай до вызова: input_tokens × max(r_in, r_cw) + max_tokens × r_out + fee, µ$ вверх
    + `ROUNDING_MARGIN_MICRO`. None — модель не оценена (gateway → 409 AI_MODEL_NOT_PRICED)."""
    rates = catalog.rates(model)
    fee = catalog.fee_for(provider)
    if rates is None or fee is None:
        return None
    r_in = max(rates.input, rates.cache_write)  # type: ignore[type-var]
    usd = (Decimal(max(input_tokens, 0)) * r_in / MTOK  # type: ignore[operator]
           + Decimal(max(max_tokens, 0)) * rates.output / MTOK + fee)  # type: ignore[operator]
    return to_micro(usd) + ROUNDING_MARGIN_MICRO


def worst_case_micro(catalog: Catalog, model: str, *, input_chars: int, max_tokens: int,
                     provider: str = "anthropic") -> int | None:
    """Резерв gateway до вызова (§3.1) по длине входа: ceil(символов/2) токенов (см. `worst_case_micro_tokens`)."""
    return worst_case_micro_tokens(catalog, model, input_tokens=-(-max(input_chars, 0) // 2), max_tokens=max_tokens,
                                   provider=provider)


def _lenient_rate(value: Any) -> Decimal | None:
    try:
        return parse_rate(value)
    except ValueError:
        return None


def catalog_from_json(data: Any) -> Catalog | None:
    """Ответ ai-control `GET /internal/v1/pricing/active` `{version, items}` → каталог для клиента (gateway).
    Недоверенный вход: строки с испорченными ставками пропускаются (модель без полных ставок — не оценена),
    не больше 500 строк; не тот формат — None."""
    if not isinstance(data, dict) or not isinstance(data.get("version"), str) or not isinstance(data.get("items"),
                                                                                                  list):
        return None
    items: list[CatalogItem] = []
    for raw in data["items"][:500]:
        if not isinstance(raw, dict) or not isinstance(raw.get("key"), str) or raw.get("kind") not in KINDS:
            continue
        key = raw["key"][:64]
        if raw["kind"] == "model":
            rates = [_lenient_rate(raw.get(f)) for f in RATE_FIELDS]
            if any(r is None for r in rates):
                continue
            items.append(CatalogItem("model", key, *rates))
        else:
            per_call = _lenient_rate(raw.get("per_call_usd"))
            if per_call is not None:
                items.append(CatalogItem(raw["kind"], key, per_call_usd=per_call))
    return Catalog.build(data["version"][:16], items)


def env_catalog(model: str, input_usd: Decimal, output_usd: Decimal) -> Catalog:
    """Запас без ai-control (версия `env`): одна модель, ставки кэша = input — прежнее поведение ai_web и news."""
    return Catalog.build(ENV_VERSION, [CatalogItem("model", model, input_usd, output_usd, input_usd, input_usd)])
