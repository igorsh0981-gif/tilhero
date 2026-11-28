"""Уровни деградации ИИ (спринт 8, INTERNAL_API §7, ai.ts «Контроль ИИ», решение владельца В14).

Действующий уровень:
- аварийная остановка (`budget.ai_enabled = false`) → `off` (причина смены — `emergency_stop`);
- `degradation_mode = manual` → заданный сотрудником `degradation_level` (`manual`);
- `auto` → по доле расхода календарного месяца UTC с резервами идущих вызовов: `< economy_at_percent` — `normal`,
  `< paid_only_at_percent` — `economy`, `< 100 %` — `paid_only`, иначе `off` (`threshold`; снижение уровня из-за
  нового месяца — `month_reset`). Потолок месяца 0 без расхода — `normal` (LLM всё равно упирается в потолок при
  резерве; Whisper, $0, работает), с расходом — `off`.

Что делает уровень с вызовами учеников (`domain/invoke.py`, `domain/speech.py`, `domain/transcribe.py`):
- `economy` — попытки сразу резервной моделью версии (`fallback_model_id`; её нет — основной);
- `paid_only` — ученик без подписки (`learner_tiers`, tier free) → `unavailable: degraded` до провайдера, $0;
  подписчик — как `economy`;
- `off` — `ai_disabled` (аварийная остановка или ручной `off`) / `budget_exceeded` (авто, потолок месяца);
- золотые прогоны — только потолок месяца (уровень не применяется); произношение и распознавание голоса (Whisper,
  $0) — только `off`.

Смена действующего уровня фиксируется при наблюдении (вызов, статус, чтение и правка настроек админкой): строка
`degradation_events` и событие `ai.degradation.changed.v1` в той же транзакции, `budget.last_level` — новый уровень.
Дешёвый путь: уровень не изменился — без блокировок; изменился — строка бюджета `FOR UPDATE`, пересчёт и запись
(параллельные наблюдатели не пишут смену дважды). Ручная правка — ещё аудит `ai.degradation_updated`.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import ROUND_DOWN, Decimal
from typing import Any, Final

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_ai_gateway.domain.budget import month_spent
from tilhero_ai_gateway.domain.common import PRODUCER, audit_payload, emit_audit, iso_z, month_start
from tilhero_ai_gateway.models import BudgetRow, DegradationEventRow
from tilhero_common.errors import not_found, unprocessable
from tilhero_common.internal_auth import Actor
from tilhero_common.messaging import emit

NORMAL: Final = "normal"
ECONOMY: Final = "economy"
PAID_ONLY: Final = "paid_only"
OFF: Final = "off"
LEVELS: Final = (NORMAL, ECONOMY, PAID_ONLY, OFF)
RANK: Final = {level: i for i, level in enumerate(LEVELS)}
AUTO: Final = "auto"
MANUAL: Final = "manual"
MODES: Final = (AUTO, MANUAL)

REASON_THRESHOLD: Final = "threshold"
REASON_MANUAL: Final = "manual"
REASON_EMERGENCY: Final = "emergency_stop"
REASON_MONTH_RESET: Final = "month_reset"

EVENT: Final = "ai.degradation.changed.v1"
AUDIT_ACTION: Final = "ai.degradation_updated"
MAX_PERCENT: Final = Decimal(1000)
Q2: Final = Decimal("0.01")
EVENTS_SHOWN: Final = 20

# уровни, на которых ИИ доступен ученику без подписки и подписчику (AiStatus.free_available / paid_available)
FREE_LEVELS: Final = frozenset({NORMAL, ECONOMY})
PAID_LEVELS: Final = frozenset({NORMAL, ECONOMY, PAID_ONLY})


@dataclass(frozen=True)
class LevelState:
    """Действующий уровень и почему он такой (основание — для записи смены)."""

    level: str
    spent_percent: Decimal
    mode: str
    cause: str  # threshold | manual | emergency_stop

    def free_available(self) -> bool:
        return self.level in FREE_LEVELS

    def paid_available(self) -> bool:
        return self.level in PAID_LEVELS

    def economy_for(self, paid: bool) -> bool:
        """Попытки сразу резервной моделью: economy — всем, paid_only — подписчику."""
        return self.level == ECONOMY or (self.level == PAID_ONLY and paid)

    def refusal(self, paid: bool) -> str | None:
        """Причина отказа вызову ученика до провайдера (None — вызов идёт): off — ai_disabled (остановка или ручной
        off) / budget_exceeded (авто, потолок месяца); paid_only и ученик без подписки — degraded."""
        if self.level == OFF:
            return "budget_exceeded" if self.cause == REASON_THRESHOLD else "ai_disabled"
        if self.level == PAID_ONLY and not paid:
            return "degraded"
        return None


def spent_percent(spent: Decimal, cap: Decimal) -> Decimal:
    """Доля потолка месяца, % (0..1000, без округления — сравнение с порогами точное). Потолок 0: расхода нет —
    0 % (вызовы LLM всё равно упираются в потолок при резерве, а бесплатное распознавание Whisper работает, как до
    спринта 8); расход есть — 1000 %."""
    if cap <= 0:
        return Decimal(0) if spent <= 0 else MAX_PERCENT
    pct = Decimal(spent) * 100 / Decimal(cap)
    return min(max(pct, Decimal(0)), MAX_PERCENT)


def shown_percent(pct: Decimal) -> Decimal:
    """Для ответа, события и журнала — 2 знака вниз: 99,9995 % — «99,99», а не «100» при уровне ниже off."""
    return pct.quantize(Q2, rounding=ROUND_DOWN)


def auto_level(pct: Decimal, economy_at: int, paid_only_at: int) -> str:
    if pct < economy_at:
        return NORMAL
    if pct < paid_only_at:
        return ECONOMY
    if pct < 100:
        return PAID_ONLY
    return OFF


def resolve(budget: BudgetRow, pct: Decimal) -> LevelState:
    if not budget.ai_enabled:
        return LevelState(OFF, pct, budget.degradation_mode, REASON_EMERGENCY)
    if budget.degradation_mode == MANUAL and budget.degradation_level in LEVELS:
        return LevelState(str(budget.degradation_level), pct, MANUAL, REASON_MANUAL)
    return LevelState(auto_level(pct, budget.economy_at_percent, budget.paid_only_at_percent), pct, AUTO,
                      REASON_THRESHOLD)


async def current(session: AsyncSession, budget: BudgetRow, now: datetime) -> LevelState:
    pct = spent_percent(await month_spent(session, now), Decimal(budget.monthly_cap_usd))
    return resolve(budget, pct)


async def _locked_budget(session: AsyncSession) -> BudgetRow:
    row = (await session.execute(select(BudgetRow).where(BudgetRow.id == 1).with_for_update()
                                 .execution_options(populate_existing=True))).scalar_one_or_none()
    if row is None:  # pragma: no cover — сид миграции 0001
        raise not_found("BUDGET_NOT_FOUND", "Бюджет не настроен")
    return row


async def _event_reason(session: AsyncSession, budget: BudgetRow, state: LevelState, now: datetime,
                        hint: str | None) -> str:
    """Основание смены: известное вызывающему (правка сотрудником, остановка); вход в off аварийной остановкой и выход
    из неё — emergency_stop; снижение уровня из-за нового месяца — month_reset; иначе — основание уровня."""
    if hint is not None:
        return hint
    if state.cause == REASON_EMERGENCY:
        return REASON_EMERGENCY
    if budget.last_level == OFF:
        last = (await session.execute(select(DegradationEventRow.reason)
                                      .where(DegradationEventRow.to_level == OFF)
                                      .order_by(DegradationEventRow.seq.desc()).limit(1))).scalar_one_or_none()
        if last == REASON_EMERGENCY:
            return REASON_EMERGENCY
    if state.cause == REASON_THRESHOLD and budget.last_level_at is not None \
            and month_start(budget.last_level_at) < month_start(now) \
            and RANK[state.level] < RANK.get(budget.last_level, 0):
        return REASON_MONTH_RESET
    return state.cause


async def sync(session: AsyncSession, now: datetime, *, budget: BudgetRow | None = None,
               actor: Actor | None = None, hint: str | None = None) -> LevelState:
    """Действующий уровень; смена (≠ budget.last_level) записывается: degradation_events + ai.degradation.changed.v1.
    hint — основание смены, известное вызывающему (manual — правка сотрудником, emergency_stop — остановка)."""
    row = budget if budget is not None else await session.get(BudgetRow, 1)
    if row is None:  # pragma: no cover — сид миграции 0001
        raise not_found("BUDGET_NOT_FOUND", "Бюджет не настроен")
    state = await current(session, row, now)
    if state.level == row.last_level:
        return state
    row = await _locked_budget(session)
    state = await current(session, row, now)
    if state.level == row.last_level:
        return state
    reason = await _event_reason(session, row, state, now, hint)
    previous = row.last_level
    session.add(DegradationEventRow(from_level=previous, to_level=state.level, mode=row.degradation_mode,
                                    reason=reason, spent_percent=shown_percent(state.spent_percent),
                                    actor=actor.id[:64] if actor is not None else None, at=now))
    row.last_level = state.level
    row.last_level_at = now
    await session.flush()
    await emit(session, EVENT, {"from": previous, "to": state.level, "mode": row.degradation_mode, "reason": reason,
                                "spent_percent": float(shown_percent(state.spent_percent)), "at": iso_z(now)},
               producer=PRODUCER)
    return state


# ---------------------------------------------------------------- админка


def _event_view(e: DegradationEventRow) -> dict[str, Any]:
    return {"seq": int(e.seq), "from": e.from_level, "to": e.to_level, "mode": e.mode, "reason": e.reason,
            "spent_percent": float(e.spent_percent), "actor": e.actor, "at": iso_z(e.at)}


async def view(session: AsyncSession, now: datetime) -> dict[str, Any]:
    """AiDegradation (ai.ts): настройки, действующий уровень (смена — записывается), доля месяца, последние смены."""
    budget = await session.get(BudgetRow, 1)
    if budget is None:  # pragma: no cover
        raise not_found("BUDGET_NOT_FOUND", "Бюджет не настроен")
    state = await sync(session, now, budget=budget)
    budget = await session.get(BudgetRow, 1)
    assert budget is not None
    events = (await session.execute(select(DegradationEventRow).order_by(DegradationEventRow.seq.desc())
                                    .limit(EVENTS_SHOWN))).scalars().all()
    start = month_start(now)
    return {
        "mode": budget.degradation_mode,
        "manual_level": budget.degradation_level if budget.degradation_mode == MANUAL else None,
        "level": state.level,
        "economy_at_percent": int(budget.economy_at_percent),
        "paid_only_at_percent": int(budget.paid_only_at_percent),
        "spent_percent": float(shown_percent(state.spent_percent)),
        "month": f"{start.year:04d}-{start.month:02d}",
        "events": [_event_view(e) for e in events],
        "updated_at": iso_z(budget.degradation_updated_at),
    }


def validate_update(mode: str, manual_level: str | None, economy_at: int, paid_only_at: int) -> None:
    """422 DEGRADATION_INVALID {fields}: 1 ≤ economy_at ≤ paid_only_at ≤ 100; manual_level обязателен при manual и
    пуст в auto."""
    fields: list[str] = []
    if not 1 <= economy_at <= 100:
        fields.append("economy_at_percent")
    if not 1 <= paid_only_at <= 100 or paid_only_at < economy_at:
        fields.append("paid_only_at_percent")
    if mode == MANUAL and manual_level not in LEVELS:
        fields.append("manual_level")
    if mode == AUTO and manual_level is not None:
        fields.append("manual_level")
    if fields:
        raise unprocessable("DEGRADATION_INVALID",
                            "Пороги: 1 ≤ «экономия» ≤ «только подписчики» ≤ 100; ручной уровень — только в режиме "
                            "«вручную»", {"fields": fields})


async def update(session: AsyncSession, *, mode: str, manual_level: str | None, economy_at: int, paid_only_at: int,
                 reason: str, actor: Actor, now: datetime) -> dict[str, Any]:
    """PUT /admin/v1/ai/degradation: настройки → аудит ai.degradation_updated (если что-то поменялось) → смена
    действующего уровня (если есть) с основанием manual и автором."""
    validate_update(mode, manual_level, economy_at, paid_only_at)
    budget = await _locked_budget(session)
    # смена уровня, накопившаяся до правки (порог, новый месяц), записывается со своим основанием
    before_state = await sync(session, now, budget=budget)
    before = {"mode": budget.degradation_mode, "manual_level": budget.degradation_level,
              "economy_at_percent": int(budget.economy_at_percent),
              "paid_only_at_percent": int(budget.paid_only_at_percent)}
    after = {"mode": mode, "manual_level": manual_level if mode == MANUAL else None,
             "economy_at_percent": economy_at, "paid_only_at_percent": paid_only_at}
    if before != after:
        budget.degradation_mode = mode
        budget.degradation_level = after["manual_level"]  # type: ignore[assignment]
        budget.economy_at_percent = economy_at
        budget.paid_only_at_percent = paid_only_at
        budget.degradation_updated_at = now
        await session.flush()
        state = await sync(session, now, budget=budget, actor=actor, hint=REASON_MANUAL)
        await emit_audit(session, audit_payload(actor, AUDIT_ACTION, "ai_budget", "degradation",
                                                before={**before, "level": before_state.level},
                                                after={**after, "level": state.level}, reason=reason))
    return await view(session, now)
