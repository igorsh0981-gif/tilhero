"""Неделя лиг (INTERNAL_API спринта 7 §2.2): понедельник 00:00 – воскресенье 24:00 по LEAGUE_TIMEZONE, одна на всех.

«XP недели» — операции XP с reason из WEEK_REASONS; неделя операции (`ledger.league_week`) — по времени события
(как день и лимит спринта 6), но только пока неделя не закрывается. Гонка закрытия и запоздавшего события
разрешается advisory-блокировкой недели:
- операция XP берёт РАЗДЕЛЯЕМУЮ блокировку недели и читает её статус: open (или строки нет) — XP идёт в эту неделю;
  closing | closed — в следующую (текущую);
- tick перед закрытием групп ставит отметку closing под ИСКЛЮЧИТЕЛЬНОЙ блокировкой недели отдельной транзакцией (она
  ждёт все начатые операции XP этой недели и не держит блокировок учеников — без взаимных блокировок).
После отметки ни одна операция в закрытую неделю не попадает, а всё, что попало до неё, видит закрытие групп.
Событие старше прошлой недели идёт в текущую.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta
from typing import Final
from zoneinfo import ZoneInfo

from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_gamification.domain.common import zone
from tilhero_gamification.models import LeagueWeek
from tilhero_gamification.settings import Settings

WEEK_LOCK: Final = 0x47414D57  # 'GAMW'
WEEK: Final = timedelta(days=7)


def tz_of(settings: Settings) -> ZoneInfo:
    return zone(settings.league_timezone, "Asia/Tashkent")


def week_of(dt: datetime, tz: ZoneInfo) -> date:
    d = dt.astimezone(tz).date()
    return d - timedelta(days=d.weekday())


def week_start(week: date, tz: ZoneInfo) -> datetime:
    return datetime.combine(week, time(0, 0), tzinfo=tz).astimezone(UTC)


def week_end(week: date, tz: ZoneInfo) -> datetime:
    return week_start(week + WEEK, tz)


def current_week(settings: Settings, now: datetime) -> date:
    return week_of(now, tz_of(settings))


async def lock_shared(session: AsyncSession, week: date) -> None:
    await session.execute(text("SELECT pg_advisory_xact_lock_shared(:c, :o)"), {"c": WEEK_LOCK, "o": week.toordinal()})


async def lock_exclusive(session: AsyncSession, week: date) -> None:
    await session.execute(text("SELECT pg_advisory_xact_lock(:c, :o)"), {"c": WEEK_LOCK, "o": week.toordinal()})


async def status_of(session: AsyncSession, week: date) -> str | None:
    return (await session.execute(select(LeagueWeek.status).where(LeagueWeek.week == week))).scalar()


async def attribute(session: AsyncSession, settings: Settings, moment: datetime, now: datetime) -> date:
    """Неделя операции XP (под разделяемой блокировкой недели до конца транзакции)."""
    tz = tz_of(settings)
    current = week_of(now, tz)
    week = week_of(moment, tz)
    if week < current - WEEK:
        week = current
    for _ in range(4):  # неделя впереди закрываться не может: обычно хватает одного-двух шагов
        await lock_shared(session, week)
        if await status_of(session, week) in (None, "open"):
            return week
        week += WEEK
    return week


async def mark_closing(session: AsyncSession, week: date, now: datetime) -> None:
    """Отметка closing (вызывать отдельной транзакцией без других блокировок): ждёт начатые операции XP недели."""
    await lock_exclusive(session, week)
    stmt = insert(LeagueWeek).values(week=week, status="closing", closing_at=now, updated_at=now)
    await session.execute(stmt.on_conflict_do_update(
        index_elements=["week"], set_={"status": "closing", "closing_at": now, "updated_at": now},
        where=LeagueWeek.status == "open"))
