"""Чистые правила графика: валидация, слоты в часовом поясе плана, окно tick, «план на сегодня».

Слот = дата графика (ISO-день недели ∈ days) + preferred_time в зоне плана. Момент слота и начало местного дня
переводятся в UTC через zoneinfo (fold=0):
- несуществующее местное время (переход на летнее время) — момент сдвигается вперёд на величину перехода
  (02:30 при переводе 02:00→03:00 = 03:30 летнего времени), слот не теряется;
- неоднозначное местное время (переход на зимнее) — первое из двух, слот не дублируется.
Каждой местной дате соответствует ровно один момент слота и один момент «конца дня» (00:00 следующей даты),
окна tick (last, now] не пересекаются — поэтому каждое событие попадает ровно в одно окно.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from functools import lru_cache
from typing import Any, Final
from zoneinfo import ZoneInfo, available_timezones

from tilhero_learning_plan.directory import GOAL_CODES, TOPIC_CODES

GOALS: Final = GOAL_CODES
LEVELS: Final = frozenset({"zero", "beginner", "some", "confident"})
UI_LANGS: Final = frozenset({"ru", "uz"})
DURATIONS: Final = frozenset({10, 15, 20, 30})
PRESETS: Final = frozenset({"daily", "weekdays", "three_per_week", "custom"})
PRESET_DAYS: Final[dict[str, tuple[int, ...]]] = {
    "daily": (1, 2, 3, 4, 5, 6, 7),
    "weekdays": (1, 2, 3, 4, 5),
    "three_per_week": (1, 3, 5),
}
MAX_TOPICS: Final = 5
FALLBACK_TIMEZONE: Final = "Asia/Tashkent"
TIME_RE: Final = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
# поля графика, которые выбирает сам ученик (timezone приходит из Intl клиента и выбором не считается)
SCHEDULE_CHOICE_FIELDS: Final = frozenset({"preset", "days", "preferred_time", "duration_min", "reminders_enabled"})


class PlanInvalid(Exception):
    """422 PLAN_INVALID {field, reason}."""

    def __init__(self, field: str, reason: str) -> None:
        super().__init__(f"{field}: {reason}")
        self.field = field
        self.reason = reason


# ---------------------------------------------------------------- часовые пояса и время


# не IANA-зоны, хотя есть в системной tzdata: «localtime» — зона хоста, «Factory» — заглушка без смещения
_NOT_IANA: Final = frozenset({"localtime", "Factory", "posixrules"})


@lru_cache(maxsize=1)
def _zones() -> frozenset[str]:
    return frozenset(available_timezones()) - _NOT_IANA


def is_valid_timezone(name: object) -> bool:
    return isinstance(name, str) and 0 < len(name) <= 64 and name in _zones()


def zone(name: str) -> ZoneInfo:
    return ZoneInfo(name)


def parse_hhmm(value: str) -> time:
    if not TIME_RE.match(value):
        raise ValueError(value)
    return time(int(value[:2]), int(value[3:5]))


def fmt_hhmm(t: time) -> str:
    return f"{t.hour:02d}:{t.minute:02d}"


def slot_instant(d: date, t: time, tz: ZoneInfo) -> datetime:
    """UTC-момент местного времени t в дату d (fold=0, см. docstring модуля)."""
    return datetime.combine(d, t, tzinfo=tz).astimezone(UTC)


def day_start(d: date, tz: ZoneInfo) -> datetime:
    """UTC-момент начала местной даты d (00:00; если полночь пропущена переходом — первый момент дня)."""
    return slot_instant(d, time(0, 0), tz)


def local_date(instant: datetime, tz: ZoneInfo) -> date:
    return instant.astimezone(tz).date()


# ---------------------------------------------------------------- валидация правки


@dataclass(frozen=True)
class ScheduleState:
    preset: str
    days: tuple[int, ...]
    preferred_time: time
    duration_min: int
    reminders_enabled: bool
    timezone: str


def validate_days(raw: object) -> tuple[int, ...]:
    if not isinstance(raw, list | tuple) or not raw:
        raise PlanInvalid("schedule.days", "empty")
    out: set[int] = set()
    for v in raw:
        if not isinstance(v, int) or isinstance(v, bool) or not 1 <= v <= 7:
            raise PlanInvalid("schedule.days", "out_of_range")
        if v in out:
            raise PlanInvalid("schedule.days", "duplicate")
        out.add(v)
    return tuple(sorted(out))


def merge_schedule(current: ScheduleState, patch: dict[str, Any]) -> ScheduleState:
    """Применяет частичную правку графика. Пресет и дни согласованы:
    - пресет без дней → канонические дни пресета (custom — текущие дни);
    - пресет с днями → для daily/weekdays/three_per_week дни должны совпасть с каноническими (иначе preset_mismatch);
    - дни без пресета → текущий пресет, если дни совпали с его каноническими, иначе custom («поменял дни — custom»).
    """
    preset = current.preset
    days = current.days
    if "preset" in patch:
        preset = patch["preset"]
        if preset not in PRESETS:
            raise PlanInvalid("schedule.preset", "unknown_value")
    if "days" in patch:
        days = validate_days(patch["days"])
        if "preset" in patch:
            if preset != "custom" and days != PRESET_DAYS[preset]:
                raise PlanInvalid("schedule.days", "preset_mismatch")
        elif preset != "custom" and days != PRESET_DAYS[preset]:
            preset = "custom"
    elif "preset" in patch and preset != "custom":
        days = PRESET_DAYS[preset]

    preferred = current.preferred_time
    if "preferred_time" in patch:
        raw = patch["preferred_time"]
        if not isinstance(raw, str) or not TIME_RE.match(raw):
            raise PlanInvalid("schedule.preferred_time", "format")
        preferred = parse_hhmm(raw)

    duration = current.duration_min
    if "duration_min" in patch:
        raw = patch["duration_min"]
        if not isinstance(raw, int) or isinstance(raw, bool) or raw not in DURATIONS:
            raise PlanInvalid("schedule.duration_min", "not_allowed")
        duration = raw

    reminders = current.reminders_enabled
    if "reminders_enabled" in patch:
        raw = patch["reminders_enabled"]
        if not isinstance(raw, bool):
            raise PlanInvalid("schedule.reminders_enabled", "not_boolean")
        reminders = raw

    tz = current.timezone
    if "timezone" in patch:
        raw = patch["timezone"]
        if not is_valid_timezone(raw):
            raise PlanInvalid("schedule.timezone", "unknown_timezone")
        tz = raw
    return ScheduleState(preset, days, preferred, duration, reminders, tz)


def validate_topics(raw: object) -> list[str]:
    if not isinstance(raw, list):
        raise PlanInvalid("topics", "not_list")
    if len(raw) > MAX_TOPICS:
        raise PlanInvalid("topics", "too_many")
    seen: list[str] = []
    for code in raw:
        if not isinstance(code, str) or code not in TOPIC_CODES:
            raise PlanInvalid("topics", "unknown_topic")
        if code in seen:
            raise PlanInvalid("topics", "duplicate")
        seen.append(code)
    return seen


def validate_choice(field: str, raw: object, allowed: Iterable[str]) -> str:
    if not isinstance(raw, str) or raw not in allowed:
        raise PlanInvalid(field, "unknown_value")
    return raw


# ---------------------------------------------------------------- слоты и окно tick


@dataclass(frozen=True)
class SlotRule:
    days: frozenset[int]
    preferred_time: time
    tz: ZoneInfo
    # слоты с моментом не позже этого не напоминаются и не считаются пропущенными (онбординг, смена графика)
    effective_from: datetime

    def slot_at(self, d: date) -> datetime:
        return slot_instant(d, self.preferred_time, self.tz)

    def is_slot(self, d: date) -> bool:
        return d.isoweekday() in self.days and self.slot_at(d) > self.effective_from


def effective_from(onboarding_completed_at: datetime, schedule_set_at: datetime | None) -> datetime:
    return max(onboarding_completed_at, schedule_set_at) if schedule_set_at else onboarding_completed_at


@dataclass(frozen=True)
class Due:
    reminders: list[date]
    missed: list[date]


def due_in_window(rule: SlotRule, start: datetime, end: datetime) -> Due:
    """Слоты, чей момент попал в окно (start, end] (→ напоминание), и слоты, чей местный день закончился в окне
    (→ пропуск, если не было занятия). Устаревшие напоминания (после простоя, окно до 24 ч) отсекает notifications
    (> 3 ч после слота — только центр уведомлений)."""
    if end <= start:
        return Due([], [])
    first = local_date(start, rule.tz) - timedelta(days=1)
    last = local_date(end, rule.tz)
    reminders: list[date] = []
    missed: list[date] = []
    d = first
    while d <= last:
        if rule.is_slot(d):
            at = rule.slot_at(d)
            day_end = day_start(d + timedelta(days=1), rule.tz)
            if start < at <= end:
                reminders.append(d)
            if start < day_end <= end:
                missed.append(d)
        d += timedelta(days=1)
    return Due(reminders, missed)


def next_slot_date(days: Iterable[int], after: date, *, include: bool = False) -> date | None:
    """Ближайшая дата графика после `after` (или начиная с неё, include=True)."""
    allowed = set(days)
    if not allowed:
        return None
    d = after if include else after + timedelta(days=1)
    for _ in range(8):
        if d.isoweekday() in allowed:
            return d
        d += timedelta(days=1)
    return None  # pragma: no cover - недостижимо при непустых днях 1..7


# ---------------------------------------------------------------- план на сегодня


@dataclass(frozen=True)
class DayFacts:
    """Факты о днях ученика, нужные TodayPlan: минуты по датам недели, отметки пропусков недели и (спринт 6) дни,
    закрытые заморозкой серии."""

    minutes_by_date: dict[date, int]
    missed_dates: frozenset[date]
    frozen_dates: frozenset[date] = frozenset()


def today_plan(*, today: date, days: Iterable[int], preferred_time: time, duration_min: int,
               facts: DayFacts, streak_days: int) -> dict[str, Any]:
    """TodayPlan (bff.ts). week.missed — только выпущенные пропуски (slot_marks), если занятие так и не записано.
    week.frozen (спринт 6) — пропущенный день, закрытый заморозкой: missed при этом остаётся true; день с занятием
    важнее заморозки (done, не missed и не frozen)."""
    allowed = frozenset(days)
    scheduled_today = today.isoweekday() in allowed
    minutes_today = facts.minutes_by_date.get(today, 0)
    done_today = today in facts.minutes_by_date
    nxt = next_slot_date(allowed, today, include=scheduled_today and not done_today)
    monday = today - timedelta(days=today.isoweekday() - 1)
    week = []
    for i in range(7):
        d = monday + timedelta(days=i)
        done = d in facts.minutes_by_date
        missed = (not done) and d in facts.missed_dates
        week.append({"local_date": d.isoformat(), "scheduled": d.isoweekday() in allowed, "done": done,
                     "missed": missed, "frozen": missed and d in facts.frozen_dates})
    return {
        "local_date": today.isoformat(),
        "is_scheduled_today": scheduled_today,
        "slot_time": fmt_hhmm(preferred_time) if scheduled_today else None,
        "duration_min": duration_min,
        "minutes_today": minutes_today,
        "done_today": done_today,
        "next_slot": {"local_date": nxt.isoformat(), "time": fmt_hhmm(preferred_time)} if nxt else None,
        "streak_days": streak_days,
        "week": week,
    }
