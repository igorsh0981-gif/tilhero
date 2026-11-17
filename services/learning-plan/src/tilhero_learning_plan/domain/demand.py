"""Агрегат спроса пользователей для discovery (спринт 3, GET /internal/v1/demand).

Источник — профили с завершённым онбордингом (onboarding_completed_at IS NOT NULL). Удалённые пользователи
физически удалены сагой (TG-FR-006), поэтому в агрегат не попадают. Статуса пользователя (ACTIVE/DISABLED)
preferences не хранит — он живёт в identity-consent.

Приватность: наружу уходят только счётчики по группам, без user_id; группа меньше `min_group` скрывается
(k-анонимность), общие счётчики ниже порога обнуляются. Подсчёт — в SQL (count DISTINCT по пользователю),
профили в память сервиса не загружаются.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from functools import lru_cache
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_learning_plan.directory import airports


# Группировка по элементам JSONB-массивов. Тексты запросов — константы (без подстановки ввода), параметры — bind.
def _geo_sql(key: str) -> str:
    return (
        "SELECT " + key + " AS key, min(g->>'code') AS name, count(DISTINCT p.user_id) AS users "
        "FROM preference_profiles p CROSS JOIN LATERAL jsonb_array_elements(p.geographies) AS g "
        "WHERE p.onboarding_completed_at IS NOT NULL AND g->>'level' = :level AND coalesce(g->>'code', '') <> '' "
        "GROUP BY 1 HAVING count(DISTINCT p.user_id) >= :min_group ORDER BY users DESC, key LIMIT :top"
    )


_COUNTRIES_SQL = _geo_sql("upper(g->>'code')")
_REGIONS_SQL = _geo_sql("g->>'code'")
_CITIES_SQL = _geo_sql("lower(g->>'code')")

_CATEGORIES_SQL = """
SELECT c AS key, count(DISTINCT p.user_id) AS users
FROM preference_profiles p CROSS JOIN LATERAL jsonb_array_elements_text(p.interests->'categories') AS c
WHERE p.onboarding_completed_at IS NOT NULL AND jsonb_typeof(p.interests->'categories') = 'array'
GROUP BY 1
HAVING count(DISTINCT p.user_id) >= :min_group
ORDER BY users DESC, key
LIMIT :top
"""

_TOTALS_SQL = """
SELECT count(*) AS users,
       count(*) FILTER (WHERE p.event_formats ? 'online') AS online_users,
       count(*) FILTER (WHERE p.geographies @> '[{"level": "world"}]'::jsonb) AS world_users
FROM preference_profiles p
WHERE p.onboarding_completed_at IS NOT NULL
"""


@dataclass
class Demand:
    generated_at: datetime
    users: int = 0
    countries: list[dict[str, Any]] = field(default_factory=list)
    cities: list[dict[str, Any]] = field(default_factory=list)
    categories: list[dict[str, Any]] = field(default_factory=list)
    online_users: int = 0
    regions: list[dict[str, Any]] = field(default_factory=list)
    world_users: int = 0


@lru_cache(maxsize=1)
def _city_countries() -> dict[str, frozenset[str]]:
    """Нормализованное название города → страны, где есть город с таким названием (справочник аэропортов)."""
    out: dict[str, set[str]] = {}
    for a in airports.load():
        out.setdefault(a.n_city, set()).add(a.country_code)
    return {k: frozenset(v) for k, v in out.items()}


def city_country(name: str) -> str | None:
    """Страна города по справочнику аэропортов; неизвестный или неоднозначный (несколько стран) город → None."""
    found = _city_countries().get(airports.normalize(name), frozenset())
    return next(iter(found)) if len(found) == 1 else None


def _hide_small(value: int, min_group: int) -> int:
    return value if value >= min_group else 0


async def build_demand(session: AsyncSession, *, min_group: int, top: int) -> Demand:
    params = {"min_group": min_group, "top": top}
    totals = (await session.execute(text(_TOTALS_SQL))).one()
    demand = Demand(
        generated_at=datetime.now(UTC),
        users=_hide_small(int(totals.users), min_group),
        online_users=_hide_small(int(totals.online_users), min_group),
        world_users=_hide_small(int(totals.world_users), min_group),
    )
    countries = await session.execute(
        text(_COUNTRIES_SQL), {**params, "level": "country"})
    demand.countries = [{"code": r.key, "users": int(r.users)} for r in countries]
    regions = await session.execute(text(_REGIONS_SQL), {**params, "level": "region"})
    demand.regions = [{"code": r.key, "users": int(r.users)} for r in regions]
    # Города — English naming (валидация профиля); группируем без учёта регистра, показываем исходное написание.
    cities = await session.execute(text(_CITIES_SQL), {**params, "level": "city"})
    demand.cities = [{"name": r.name, "country_code": city_country(r.name), "users": int(r.users)} for r in cities]
    categories = await session.execute(text(_CATEGORIES_SQL), params)
    demand.categories = [{"code": r.key, "users": int(r.users)} for r in categories]
    return demand
