"""plan:tick — напоминания о слотах и пропуски (PLAN.md «Правила напоминаний», INTERNAL_API §2).

Окно (last_tick_at, now], не длиннее TICK_MAX_LOOKBACK_HOURS (24 ч): после простоя старые слоты не догоняются.
Строка tick_state блокируется FOR UPDATE — параллельные запуски (повтор n8n) идут по очереди, второй видит окно,
сдвинутое первым. Повторный проход того же окна не дублирует события: отметка slot_marks (user_id, local_date, kind)
вставляется ON CONFLICT DO NOTHING, событие пишется в outbox только если отметка вставлена — в той же транзакции.

- reminder: момент слота попал в окно, напоминания включены, в местную дату слота занятий нет;
- missed: в окне закончился местный день слота (00:00 следующей даты), занятий в эту дату нет; выпускается и без
  reminders_enabled (решение — в notifications по категории missed). consecutive_missed = 1 + выпущенные пропуски
  после последнего дня с занятием; next_slot_date — следующая дата графика.
Слоты раньше effective_from (завершение онбординга, последняя смена времени/дней/зоны) не учитываются: новый график
действует со следующего слота, слот, по которому уже было напоминание, не повторяется (отметка по дате).
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta

from sqlalchemy import exists, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.messaging import emit
from tilhero_learning_plan.domain import schedule as sch
from tilhero_learning_plan.domain.plans import streak_days
from tilhero_learning_plan.models import Activity, Plan, SlotMark, TickState

REMINDER_DUE = "learning.reminder.due.v1"
SESSION_MISSED = "learning.session.missed.v1"

log = logging.getLogger("tilhero.learning_plan.tick")


@dataclass
class TickResult:
    plans_checked: int = 0
    reminders: int = 0
    missed: int = 0


@dataclass(frozen=True)
class _PlanRow:
    user_id: uuid.UUID
    days: list[int]
    preferred_time: time
    duration_min: int
    reminders_enabled: bool
    timezone: str
    onboarding_completed_at: datetime
    schedule_set_at: datetime | None


async def _window_start(session: AsyncSession, now: datetime) -> datetime | None:
    """Блокирует tick_state и возвращает начало окна (None — строки не было: первый запуск, окно пустое)."""
    row = (await session.execute(select(TickState).where(TickState.id == 1).with_for_update())).scalar_one_or_none()
    if row is None:
        await session.execute(insert(TickState).values(id=1, last_tick_at=now).on_conflict_do_nothing())
        await session.execute(select(TickState).where(TickState.id == 1).with_for_update())
        return None
    return row.last_tick_at


async def _has_activity(session: AsyncSession, user_id: uuid.UUID, d: date) -> bool:
    act = Activity.__table__.c
    return bool((await session.execute(
        select(exists().where(act.user_id == user_id, act.local_date == d)))).scalar_one())


async def _mark(session: AsyncSession, user_id: uuid.UUID, d: date, kind: str, now: datetime) -> bool:
    inserted = await session.execute(
        insert(SlotMark).values(user_id=user_id, local_date=d, kind=kind, emitted_at=now)
        .on_conflict_do_nothing().returning(SlotMark.user_id)
    )
    return inserted.first() is not None


async def _consecutive_missed(session: AsyncSession, user_id: uuid.UUID, d: date) -> int:
    act = Activity.__table__.c
    marks = SlotMark.__table__.c
    last_done = (await session.execute(
        select(func.max(act.local_date)).where(act.user_id == user_id, act.local_date < d))).scalar_one()
    stmt = select(func.count()).select_from(SlotMark).where(
        marks.user_id == user_id, marks.kind == "missed", marks.local_date < d)
    if last_done is not None:
        stmt = stmt.where(marks.local_date > last_done)
    return int((await session.execute(stmt)).scalar_one()) + 1


async def _still_present(session: AsyncSession, user_id: uuid.UUID) -> bool:
    """FOR KEY SHARE: удаление плана (сага) ждёт конца tick и затем удаляет и записанные им отметки."""
    stmt = select(Plan.user_id).where(Plan.user_id == user_id).with_for_update(read=True, key_share=True)
    return (await session.execute(stmt)).first() is not None


async def _process(session: AsyncSession, p: _PlanRow, start: datetime, end: datetime, producer: str,
                   result: TickResult) -> None:
    try:
        tz = sch.zone(p.timezone)
    except Exception:  # зона исчезла из tzdata после записи — план пропускаем, остальные обрабатываем
        log.warning("plan with unknown timezone skipped", extra={"timezone": p.timezone[:64]})
        return
    rule = sch.SlotRule(frozenset(p.days), p.preferred_time, tz,
                        sch.effective_from(p.onboarding_completed_at, p.schedule_set_at))
    due = sch.due_in_window(rule, start, end)
    reminders = due.reminders if p.reminders_enabled else []
    if not reminders and not due.missed:
        return
    if not await _still_present(session, p.user_id):
        return
    slot_time = sch.fmt_hhmm(p.preferred_time)
    for d in reminders:
        if await _has_activity(session, p.user_id, d) or not await _mark(session, p.user_id, d, "reminder", end):
            continue
        await emit(session, REMINDER_DUE, {
            "user_id": str(p.user_id),
            "local_date": d.isoformat(),
            "slot_time": slot_time,
            "timezone": p.timezone,
            "duration_min": p.duration_min,
            "streak_days": await streak_days(session, p.user_id, d),
        }, producer=producer)
        result.reminders += 1
    for d in due.missed:
        if await _has_activity(session, p.user_id, d) or not await _mark(session, p.user_id, d, "missed", end):
            continue
        consecutive = await _consecutive_missed(session, p.user_id, d)
        nxt = sch.next_slot_date(p.days, d)
        await emit(session, SESSION_MISSED, {
            "user_id": str(p.user_id),
            "local_date": d.isoformat(),
            "slot_time": slot_time,
            "timezone": p.timezone,
            "consecutive_missed": consecutive,
            "next_slot_date": nxt.isoformat() if nxt else None,
        }, producer=producer)
        result.missed += 1


async def run_tick(session: AsyncSession, *, clock: Callable[[], datetime], producer: str,
                   max_lookback: timedelta = timedelta(hours=24), batch_size: int = 500) -> TickResult:
    """Один проход окна. `clock` вызывается ПОСЛЕ блокировки tick_state (запуск, ждавший соседа, видит своё now)."""
    result = TickResult()
    state_start = await _window_start(session, clock())
    now = clock()
    if state_start is None:
        return result
    start = max(state_start, now - max_lookback)
    if now <= start:
        return result  # часы не ушли вперёд — окно пустое, last_tick_at назад не двигаем
    c = Plan.__table__.c
    cols = (c.user_id, c.days, c.preferred_time, c.duration_min, c.reminders_enabled, c.timezone,
            c.onboarding_completed_at, c.schedule_set_at)
    last: uuid.UUID | None = None
    while True:
        stmt = select(*cols).where(c.onboarding_completed_at.is_not(None)).order_by(c.user_id).limit(batch_size)
        if last is not None:
            stmt = stmt.where(c.user_id > last)
        rows = (await session.execute(stmt)).all()
        if not rows:
            break
        for row in rows:
            result.plans_checked += 1
            await _process(session, _PlanRow(*row), start, now, producer, result)
        last = rows[-1].user_id
        if len(rows) < batch_size:
            break
    state = (await session.execute(select(TickState).where(TickState.id == 1))).scalar_one()
    state.last_tick_at = now
    await session.flush()
    return result
