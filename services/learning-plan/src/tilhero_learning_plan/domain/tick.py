"""plan:tick — напоминания о слотах и пропуски (PLAN.md «Правила напоминаний», INTERNAL_API §2, §11 P-1).

Окно (last_tick_at, now], не длиннее TICK_MAX_LOOKBACK_HOURS (24 ч): после простоя старые слоты не догоняются.

Один tick за раз: на всё время прохода берётся сессионная advisory-блокировка (`pg_try_advisory_lock`) на
выделенном соединении — на нём же идут транзакции пачек. Запуск, пока идёт предыдущий (повтор n8n по таймауту),
блокировку не ждёт и сразу отвечает `skipped` — соединения пула повторами не заняты.

Планы обрабатываются пачками по TICK_BATCH_SIZE (ключ — user_id), у каждой пачки своя короткая транзакция:
отметки slot_marks и события outbox пачки фиксируются вместе. `last_tick_at` двигается только после всех пачек.
Сбой посреди прохода: следующий tick снова пройдёт то же окно (и дальше), а уже выпущенное не повторится —
отметка slot_marks (user_id, local_date, kind) вставляется ON CONFLICT DO NOTHING, событие пишется только по
вставленной отметке, в той же транзакции.

Внутри пачки — фиксированное число запросов, не зависящее от размера пачки: планы-кандидаты (FOR KEY SHARE,
перечитываются свежими), занятия за даты кандидатов, вставка всех отметок с RETURNING, серия и consecutive_missed
одним запросом каждое, события outbox — одной пакетной вставкой.

- reminder: момент слота попал в окно, напоминания включены, в местную дату слота занятий нет;
- missed: в окне закончился местный день слота (00:00 следующей даты), занятий в эту дату нет; выпускается и без
  reminders_enabled (решение — в notifications по категории missed). consecutive_missed = 1 + выпущенные пропуски
  после последнего дня с занятием; next_slot_date — следующая дата графика.
Серия (streak_days) и consecutive_missed считаются после вставки всех отметок пачки: пропуск, выпущенный в том же
проходе за более раннюю дату (окно до 24 ч), уже учтён.
Слоты раньше effective_from (завершение онбординга, последняя смена времени/дней/зоны) не учитываются: новый график
действует со следующего слота, слот, по которому уже было напоминание, не повторяется (отметка по дате).
"""

from __future__ import annotations

import logging
import uuid
import zlib
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from typing import Any, Final

from sqlalchemy import any_, bindparam, select, text, update
from sqlalchemy.dialects.postgresql import ARRAY, UUID, insert
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from tilhero_common.messaging import make_envelope, outbox_table
from tilhero_learning_plan.domain import schedule as sch
from tilhero_learning_plan.models import Plan, TickState

REMINDER_DUE = "learning.reminder.due.v1"
SESSION_MISSED = "learning.session.missed.v1"

# пространство advisory-ключей tick (отдельное от блокировок учеников 'LPLN' в domain/plans.py); объект — от схемы:
# блокировка действует на свою tick_state (схемы тестов и стендов в одной БД друг другу не мешают)
TICK_LOCK_CLASS: Final = 0x4C505449  # 'LPTI'


def tick_lock_object(schema: str | None) -> int:
    return int.from_bytes(zlib.crc32((schema or "").encode()).to_bytes(4, "big"), "big", signed=True)

log = logging.getLogger("tilhero.learning_plan.tick")

_PLAN = Plan.__table__.c
_PLAN_COLS = (_PLAN.user_id, _PLAN.days, _PLAN.preferred_time, _PLAN.duration_min, _PLAN.reminders_enabled,
              _PLAN.timezone, _PLAN.onboarding_completed_at, _PLAN.schedule_set_at)
_UUIDS = ARRAY(UUID(as_uuid=True))

# занятия за пары (ученик, дата) кандидатов
_ACTIVE_DAYS = text("""
    SELECT DISTINCT a.user_id, a.local_date
    FROM activities a
    JOIN unnest(CAST(:uids AS uuid[]), CAST(:dates AS date[])) AS c(user_id, local_date)
      ON a.user_id = c.user_id AND a.local_date = c.local_date
""")

# отметки всех событий пачки разом; RETURNING — только вставленные (уже выпущенные пропускаются)
_INSERT_MARKS = text("""
    INSERT INTO slot_marks (user_id, local_date, kind, emitted_at)
    SELECT c.user_id, c.local_date, c.kind, CAST(:now AS timestamptz)
    FROM unnest(CAST(:uids AS uuid[]), CAST(:dates AS date[]), CAST(:kinds AS text[])) AS c(user_id, local_date, kind)
    ON CONFLICT DO NOTHING
    RETURNING user_id, local_date, kind
""")

# серия на дату слота — как streak_days (domain/plans.py): дни с занятием после последнего выпущенного пропуска
# без занятия, не позже даты слота
_STREAKS = text("""
    SELECT c.user_id, c.d, (
        SELECT count(DISTINCT a.local_date) FROM activities a
        WHERE a.user_id = c.user_id AND a.local_date <= c.d
          AND a.local_date > COALESCE((
              SELECT max(m.local_date) FROM slot_marks m
              WHERE m.user_id = c.user_id AND m.kind = 'missed' AND m.local_date < c.d
                AND NOT EXISTS (SELECT 1 FROM activities x
                                WHERE x.user_id = m.user_id AND x.local_date = m.local_date)
          ), '-infinity'::date)
    ) AS n
    FROM unnest(CAST(:uids AS uuid[]), CAST(:dates AS date[])) AS c(user_id, d)
""")

# consecutive_missed = 1 + выпущенные пропуски раньше даты, после последнего дня с занятием
_CONSECUTIVE = text("""
    SELECT c.user_id, c.d, 1 + (
        SELECT count(*) FROM slot_marks m
        WHERE m.user_id = c.user_id AND m.kind = 'missed' AND m.local_date < c.d
          AND m.local_date > COALESCE((
              SELECT max(a.local_date) FROM activities a WHERE a.user_id = c.user_id AND a.local_date < c.d
          ), '-infinity'::date)
    ) AS n
    FROM unnest(CAST(:uids AS uuid[]), CAST(:dates AS date[])) AS c(user_id, d)
""")


@dataclass
class TickResult:
    plans_checked: int = 0
    reminders: int = 0
    missed: int = 0
    skipped: bool = False


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


Key = tuple[uuid.UUID, date]


def _due(p: _PlanRow, start: datetime, end: datetime) -> tuple[list[date], list[date]]:
    """→ (даты напоминаний, даты пропусков) плана в окне; неизвестная зона — пусто (план пропускается)."""
    try:
        tz = sch.zone(p.timezone)
    except Exception:  # зона исчезла из tzdata после записи — план пропускаем, остальные обрабатываем
        log.warning("plan with unknown timezone skipped", extra={"timezone": p.timezone[:64]})
        return [], []
    rule = sch.SlotRule(frozenset(p.days), p.preferred_time, tz,
                        sch.effective_from(p.onboarding_completed_at, p.schedule_set_at))
    due = sch.due_in_window(rule, start, end)
    return (due.reminders if p.reminders_enabled else []), due.missed


def _pairs(keys: Sequence[Key]) -> dict[str, list[Any]]:
    return {"uids": [k[0] for k in keys], "dates": [k[1] for k in keys]}


async def _counts(conn: AsyncConnection, stmt: Any, keys: Sequence[Key]) -> dict[Key, int]:
    if not keys:
        return {}
    rows = (await conn.execute(stmt, _pairs(keys))).all()
    return {(u, d): int(n) for u, d, n in rows}


async def _process_batch(conn: AsyncConnection, user_ids: list[uuid.UUID], start: datetime, end: datetime,
                         producer: str, result: TickResult) -> None:
    """Пачка в транзакции вызывающего. user_ids — планы пачки, у которых в окне есть хоть одно событие."""
    # FOR KEY SHARE: удаление плана (сага) ждёт конца транзакции пачки и затем удаляет и записанные ею отметки;
    # PATCH берёт FOR NO KEY UPDATE и не ждёт. График перечитывается — решение по свежим данным.
    locked = (await conn.execute(
        select(*_PLAN_COLS)
        .where(_PLAN.user_id == any_(bindparam("ids", user_ids, type_=_UUIDS)),
               _PLAN.onboarding_completed_at.is_not(None))
        .order_by(_PLAN.user_id)
        .with_for_update(read=True, key_share=True)
    )).all()
    plans: dict[uuid.UUID, _PlanRow] = {}
    wanted: list[tuple[uuid.UUID, date, str]] = []
    for row in locked:
        p = _PlanRow(*row)
        reminders, missed = _due(p, start, end)
        plans[p.user_id] = p
        wanted += [(p.user_id, d, "reminder") for d in reminders] + [(p.user_id, d, "missed") for d in missed]
    if not wanted:
        return
    active = {(u, d) for u, d in (await conn.execute(_ACTIVE_DAYS, _pairs([(u, d) for u, d, _ in wanted]))).all()}
    wanted = [w for w in wanted if (w[0], w[1]) not in active]
    if not wanted:
        return
    inserted = (await conn.execute(_INSERT_MARKS, {
        "uids": [w[0] for w in wanted], "dates": [w[1] for w in wanted], "kinds": [w[2] for w in wanted],
        "now": end,
    })).all()
    marked = {(u, d, k) for u, d, k in inserted}
    new = [w for w in wanted if w in marked]  # порядок wanted: ученик, напоминания, затем пропуски — по датам
    if not new:
        return
    streaks = await _counts(conn, _STREAKS, [(u, d) for u, d, k in new if k == "reminder"])
    consecutive = await _counts(conn, _CONSECUTIVE, [(u, d) for u, d, k in new if k == "missed"])
    rows: list[dict[str, Any]] = []
    for u, d, kind in new:
        p = plans[u]
        slot_time = sch.fmt_hhmm(p.preferred_time)
        if kind == "reminder":
            payload: dict[str, Any] = {
                "user_id": str(u), "local_date": d.isoformat(), "slot_time": slot_time, "timezone": p.timezone,
                "duration_min": p.duration_min, "streak_days": streaks[(u, d)],
            }
            result.reminders += 1
        else:
            nxt = sch.next_slot_date(p.days, d)
            payload = {
                "user_id": str(u), "local_date": d.isoformat(), "slot_time": slot_time, "timezone": p.timezone,
                "consecutive_missed": consecutive[(u, d)], "next_slot_date": nxt.isoformat() if nxt else None,
            }
            result.missed += 1
        env = make_envelope(REMINDER_DUE if kind == "reminder" else SESSION_MISSED, payload, producer=producer)
        rows.append({"id": env.event_id, "event_type": env.event_type, "envelope": env.model_dump(mode="json")})
    # то же, что emit() на каждое событие, но одной пакетной вставкой (executemany → insertmanyvalues)
    await conn.execute(outbox_table.insert(), rows)


async def _window_start(conn: AsyncConnection, now: datetime) -> datetime | None:
    """Начало окна (None — строки не было: первый запуск, окно пустое; строка создаётся с now)."""
    last = (await conn.execute(select(TickState.last_tick_at).where(TickState.id == 1))).scalar_one_or_none()
    if last is None:
        await conn.execute(insert(TickState).values(id=1, last_tick_at=now).on_conflict_do_nothing())
    return last


async def _run_locked(conn: AsyncConnection, *, clock: Callable[[], datetime], producer: str,
                      max_lookback: timedelta, batch_size: int,
                      on_commit: Callable[[], None] | None) -> TickResult:
    result = TickResult()
    async with conn.begin():
        state_start = await _window_start(conn, clock())
    now = clock()  # после блокировки: запуск после соседа видит своё now
    if state_start is None:
        return result
    start = max(state_start, now - max_lookback)
    if now <= start:
        return result  # часы не ушли вперёд — окно пустое, last_tick_at назад не двигаем
    last: uuid.UUID | None = None
    while True:
        stmt = select(*_PLAN_COLS).where(_PLAN.onboarding_completed_at.is_not(None)).order_by(_PLAN.user_id)
        if last is not None:
            stmt = stmt.where(_PLAN.user_id > last)
        emitted = result.reminders + result.missed
        async with conn.begin():
            rows = (await conn.execute(stmt.limit(batch_size))).all()
            result.plans_checked += len(rows)
            due = [row.user_id for row in rows if any(_due(_PlanRow(*row), start, now))]
            if due:
                await _process_batch(conn, due, start, now, producer, result)
        if on_commit is not None and result.reminders + result.missed > emitted:
            on_commit()
        if len(rows) < batch_size:
            break
        last = rows[-1].user_id
    async with conn.begin():
        # только вперёд: запуск со старыми часами (или старая реплика при выкладке) окно назад не вернёт
        await conn.execute(update(TickState).where(TickState.id == 1, TickState.last_tick_at < now)
                           .values(last_tick_at=now))
    return result


async def run_tick(engine: AsyncEngine, *, clock: Callable[[], datetime], producer: str, schema: str | None,
                   max_lookback: timedelta = timedelta(hours=24), batch_size: int = 500,
                   on_commit: Callable[[], None] | None = None) -> TickResult:
    """Один проход окна; занято другим tick → TickResult(skipped=True) без ожидания.

    `clock` вызывается после взятия блокировки. `on_commit` — после фиксации пачки с событиями (разбудить relay).
    """
    async with engine.connect() as conn:
        got = (await conn.execute(text("SELECT pg_try_advisory_lock(:c, :o)"),
                                  {"c": TICK_LOCK_CLASS, "o": tick_lock_object(schema)})).scalar_one()
        await conn.commit()
        if not got:
            return TickResult(skipped=True)
        try:
            return await _run_locked(conn, clock=clock, producer=producer, max_lookback=max_lookback,
                                     batch_size=batch_size, on_commit=on_commit)
        finally:
            await _release(conn)


async def _release(conn: AsyncConnection) -> None:
    """Снять сессионную блокировку до возврата соединения в пул. Не вышло (разрыв, отмена) — соединение
    закрывается: блокировка сервера живёт только вместе с его сессией."""
    try:
        if conn.in_transaction():
            await conn.rollback()
        await conn.execute(text("SELECT pg_advisory_unlock_all()"))
        await conn.commit()
    except BaseException:
        await conn.invalidate()
        raise
