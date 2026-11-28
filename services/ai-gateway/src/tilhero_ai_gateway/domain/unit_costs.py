"""Стоимость занятий (спринт 8, INTERNAL_API §7, ai.ts AiUnitCosts, AT-98): «сколько стоит урок и ИИ-минута».

Источник — `session_costs` (проекция событий lessons) и учёт вызовов `usage` по `session_id`:
- `lesson.session.completed.v1` — только `kind lesson | scenario` (занятия с ИИ; парная комната учитывается целиком по
  `lesson.pair.completed.v1`, а не по сессиям участников): session_id, ученик, минуты, `billable_minutes` (null —
  событие до спринта 8 или без ИИ-минут), `finished_at`;
- `lesson.pair.completed.v1` → `kind pair`, session_id = room_id (вызовы коуча — `usage.session_id = room_id`),
  ученик — плательщик комнаты (`billing.payer_user_id`, иначе NULL), минуты — наибольшие у участника,
  `billing.billable_minutes`.
Повтор события — без изменений (PK session_id). Издатель — только lessons. Удалённый ученик (сага) — без user_id.

Отчёт `GET /admin/v1/ai/unit-costs?period=week|month` (week — последние 7 дней по Ташкенту, month — календарный месяц
UTC, как потолок; по `completed_at`). По виду занятия:
- `sessions` — завершённые занятия; `cost_usd` — сумма usage по их session_id;
- `ai_sessions` — занятия, где ИИ работал: есть успешный вызов (`status ok`) или списаны ИИ-минуты;
- `cost_per_ai_session_p50/p95_usd` — медиана и 95-й перцентиль (ближайший ранг) стоимости занятия с ИИ;
- `billable_minutes` — сумма списанных ИИ-минут; `cost_per_billable_minute_usd` — `cost_usd / billable_minutes`;
- `degraded_sessions_pct` — доля занятий (всех видов), где вызов ИИ не обслужен из-за деградации или бюджета
  (`unavailable: degraded | budget_exceeded | ai_disabled`). Занятие, которое lessons сразу начал без ИИ по статусу
  (`paid_available = false`), вызовов не делает и сюда не попадает — оно видно в отчётах billing (удержание с 0
  минут).
USD — строки с 6 знаками (Decimal, HALF_UP).
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Final

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_ai_gateway.domain.common import iso_z, local_day_start, month_start
from tilhero_ai_gateway.models import DeletedUser, SessionCost, UsageRow

SESSION_COMPLETED: Final = "lesson.session.completed.v1"
PAIR_COMPLETED: Final = "lesson.pair.completed.v1"
PRODUCERS: Final = frozenset({"lessons"})
SESSION_KINDS: Final = ("lesson", "scenario")
KINDS: Final = ("lesson", "scenario", "pair")
DEGRADED_REASONS: Final = ("degraded", "budget_exceeded", "ai_disabled")
PERIODS: Final = ("week", "month")
Q6: Final = Decimal("0.000001")


def _ts(value: Any) -> datetime:
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def _minutes(value: Any, high: int) -> int:
    try:
        return max(0, min(int(value), high))
    except (TypeError, ValueError):
        return 0


def _billable(value: Any) -> int | None:
    if value is None:
        return None
    return _minutes(value, 240)


async def _known_user(session: AsyncSession, raw: Any) -> uuid.UUID | None:
    if raw is None:
        return None
    user_id = uuid.UUID(str(raw))
    return None if await session.get(DeletedUser, user_id) is not None else user_id


async def _insert(session: AsyncSession, **values: Any) -> bool:
    stmt = insert(SessionCost).values(**values).on_conflict_do_nothing(index_elements=[SessionCost.session_id])
    return bool(getattr(await session.execute(stmt), "rowcount", 0))


async def on_session_completed(session: AsyncSession, payload: dict[str, Any]) -> bool:
    """lesson.session.completed.v1 → session_costs (только lesson | scenario)."""
    kind = payload.get("kind")
    if kind not in SESSION_KINDS:
        return False
    return await _insert(session, session_id=uuid.UUID(str(payload["session_id"])), kind=kind,
                         user_id=await _known_user(session, payload.get("user_id")),
                         minutes=_minutes(payload.get("minutes"), 600),
                         billable_minutes=_billable(payload.get("billable_minutes")),
                         completed_at=_ts(payload["finished_at"]))


async def on_pair_completed(session: AsyncSession, payload: dict[str, Any]) -> bool:
    """lesson.pair.completed.v1 → session_costs (kind pair, session_id = room_id)."""
    billing = payload.get("billing") if isinstance(payload.get("billing"), dict) else None
    participants = payload.get("participants") or []
    minutes = max((_minutes(p.get("minutes"), 600) for p in participants if isinstance(p, dict)), default=0)
    return await _insert(session, session_id=uuid.UUID(str(payload["room_id"])), kind="pair",
                         user_id=await _known_user(session, billing.get("payer_user_id") if billing else None),
                         minutes=minutes,
                         billable_minutes=_billable(billing.get("billable_minutes")) if billing else None,
                         completed_at=_ts(payload["ended_at"]))


# ---------------------------------------------------------------- отчёт


def _usd(value: Decimal) -> str:
    return str(Decimal(value).quantize(Q6, rounding=ROUND_HALF_UP))


def _rank(values: list[Decimal], percent: int) -> Decimal | None:
    """Перцентиль ближайшего ранга."""
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, -(-percent * len(ordered) // 100) - 1)]


def period_bounds(period: str, now: datetime, tz: str) -> tuple[datetime, datetime]:
    if period == "week":
        return local_day_start(now, tz) - timedelta(days=6), now
    return month_start(now), now


def _kind_view(rows: list[tuple[Decimal, bool, int]]) -> dict[str, Any]:
    cost = sum((c for c, _, _ in rows), Decimal(0))
    ai_costs = [c for c, ai, _ in rows if ai]
    minutes = sum(m for _, _, m in rows)
    p50, p95 = _rank(ai_costs, 50), _rank(ai_costs, 95)
    return {
        "sessions": len(rows),
        "ai_sessions": len(ai_costs),
        "cost_usd": _usd(cost),
        "cost_per_ai_session_p50_usd": _usd(p50) if p50 is not None else None,
        "cost_per_ai_session_p95_usd": _usd(p95) if p95 is not None else None,
        "billable_minutes": minutes,
        "cost_per_billable_minute_usd": _usd(cost / minutes) if minutes else None,
    }


async def report(session: AsyncSession, period: str, now: datetime, tz: str) -> dict[str, Any]:
    """AiUnitCosts (ai.ts)."""
    since, until = period_bounds(period, now, tz)
    done = UsageRow.status != "pending"
    stmt = (
        select(SessionCost.session_id, SessionCost.kind, SessionCost.billable_minutes,
               func.coalesce(func.sum(UsageRow.cost_usd).filter(done), 0),
               func.count(UsageRow.call_id).filter(UsageRow.status == "ok"),
               func.count(UsageRow.call_id).filter(UsageRow.status == "unavailable",
                                                   UsageRow.reason.in_(DEGRADED_REASONS)))
        .outerjoin(UsageRow, UsageRow.session_id == SessionCost.session_id)
        .where(SessionCost.completed_at >= since, SessionCost.completed_at <= until)
        .group_by(SessionCost.session_id, SessionCost.kind, SessionCost.billable_minutes)
    )
    by_kind: dict[str, list[tuple[Decimal, bool, int]]] = {k: [] for k in KINDS}
    total = degraded = 0
    for _sid, kind, billable, cost, ok_calls, degraded_calls in (await session.execute(stmt)).all():
        minutes = int(billable or 0)
        by_kind.setdefault(kind, []).append((Decimal(cost or 0), int(ok_calls) > 0 or minutes > 0, minutes))
        total += 1
        degraded += 1 if int(degraded_calls) > 0 else 0
    return {
        "period": period,
        "from": iso_z(since),
        "to": iso_z(until),
        "by_kind": {k: _kind_view(by_kind[k]) for k in KINDS},
        "degraded_sessions_pct": round(degraded * 100 / total, 1) if total else None,
    }
