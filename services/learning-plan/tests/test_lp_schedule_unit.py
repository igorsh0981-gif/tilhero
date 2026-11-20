"""Чистые правила графика: пресеты ↔ дни, валидация, моменты слотов в зонах с DST, окно tick, «сегодня»."""

from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

import pytest

from tilhero_learning_plan.domain import schedule as sch

CUR = sch.ScheduleState("daily", (1, 2, 3, 4, 5, 6, 7), time(19, 0), 20, False, "Asia/Tashkent")
TASHKENT = ZoneInfo("Asia/Tashkent")
NEW_YORK = ZoneInfo("America/New_York")


def merged(**patch):
    return sch.merge_schedule(CUR, patch)


def test_preset_sets_canonical_days() -> None:
    assert merged(preset="weekdays").days == (1, 2, 3, 4, 5)
    assert merged(preset="three_per_week").days == (1, 3, 5)
    assert merged(preset="daily").days == (1, 2, 3, 4, 5, 6, 7)
    # custom без дней — текущие дни
    assert merged(preset="custom") == sch.ScheduleState("custom", CUR.days, time(19, 0), 20, False, CUR.timezone)


def test_preset_and_days_must_agree() -> None:
    assert merged(preset="weekdays", days=[5, 1, 2, 3, 4]).days == (1, 2, 3, 4, 5)  # порядок нормализуется
    assert merged(preset="custom", days=[2, 4]).days == (2, 4)
    for preset, days in (("weekdays", [1, 2, 3]), ("three_per_week", [2, 4, 6]), ("daily", [1, 2, 3, 4, 5, 6])):
        with pytest.raises(sch.PlanInvalid) as exc:
            merged(preset=preset, days=days)
        assert (exc.value.field, exc.value.reason) == ("schedule.days", "preset_mismatch")


def test_days_without_preset_become_custom_unless_canonical() -> None:
    assert merged(days=[1, 3, 5]).preset == "custom"  # был daily → поменял дни → custom
    assert merged(days=[1, 2, 3, 4, 5, 6, 7]).preset == "daily"
    weekdays = sch.ScheduleState("weekdays", (1, 2, 3, 4, 5), time(8, 0), 10, True, "UTC")
    assert sch.merge_schedule(weekdays, {"days": [1, 2, 3, 4, 5]}).preset == "weekdays"


@pytest.mark.parametrize(("patch", "field", "reason"), [
    ({"days": []}, "schedule.days", "empty"),
    ({"days": [0, 1]}, "schedule.days", "out_of_range"),
    ({"days": [8]}, "schedule.days", "out_of_range"),
    ({"days": [1, 1]}, "schedule.days", "duplicate"),
    ({"preset": "monthly"}, "schedule.preset", "unknown_value"),
    ({"preferred_time": "24:00"}, "schedule.preferred_time", "format"),
    ({"preferred_time": "7:00"}, "schedule.preferred_time", "format"),
    ({"preferred_time": "07:60"}, "schedule.preferred_time", "format"),
    ({"duration_min": 25}, "schedule.duration_min", "not_allowed"),
    ({"duration_min": True}, "schedule.duration_min", "not_allowed"),
    ({"timezone": "Mars/Olympus"}, "schedule.timezone", "unknown_timezone"),
    ({"timezone": "localtime"}, "schedule.timezone", "unknown_timezone"),
    ({"timezone": ""}, "schedule.timezone", "unknown_timezone"),
])
def test_schedule_validation(patch, field, reason) -> None:
    with pytest.raises(sch.PlanInvalid) as exc:
        merged(**patch)
    assert (exc.value.field, exc.value.reason) == (field, reason)


def test_boundary_times_and_zones_accepted() -> None:
    assert merged(preferred_time="00:00").preferred_time == time(0, 0)
    assert merged(preferred_time="23:59").preferred_time == time(23, 59)
    for tz in ("Asia/Tashkent", "Europe/Moscow", "America/New_York", "UTC", "Asia/Kolkata", "Australia/Lord_Howe"):
        assert merged(timezone=tz).timezone == tz


def test_topics_validation() -> None:
    assert sch.validate_topics(["travel", "food"]) == ["travel", "food"]
    assert sch.validate_topics([]) == []
    for raw, reason in ((["nope"], "unknown_topic"), (["food", "food"], "duplicate"),
                        (["travel", "food", "work", "study", "home", "tech"], "too_many")):
        with pytest.raises(sch.PlanInvalid) as exc:
            sch.validate_topics(raw)
        assert exc.value.reason == reason


def test_slot_instant_tashkent_has_no_dst() -> None:
    assert sch.slot_instant(date(2026, 11, 18), time(19, 0), TASHKENT) == datetime(2026, 11, 18, 14, 0, tzinfo=UTC)
    assert sch.day_start(date(2026, 11, 19), TASHKENT) == datetime(2026, 11, 18, 19, 0, tzinfo=UTC)
    assert sch.slot_instant(date(2026, 6, 18), time(19, 0), TASHKENT) == datetime(2026, 6, 18, 14, 0, tzinfo=UTC)


def test_slot_instant_dst_gap_and_overlap() -> None:
    # 08.03.2026 в Нью-Йорке 02:00 → 03:00: 02:30 не существует — слот сдвигается на 03:30 EDT (07:30Z), не теряется
    assert sch.slot_instant(date(2026, 3, 8), time(2, 30), NEW_YORK) == datetime(2026, 3, 8, 7, 30, tzinfo=UTC)
    # 01.11.2026 01:30 бывает дважды — берём первое (EDT, 05:30Z), один слот на дату
    assert sch.slot_instant(date(2026, 11, 1), time(1, 30), NEW_YORK) == datetime(2026, 11, 1, 5, 30, tzinfo=UTC)
    # обычное время в день перехода
    assert sch.slot_instant(date(2026, 3, 8), time(19, 0), NEW_YORK) == datetime(2026, 3, 8, 23, 0, tzinfo=UTC)
    # сутки перехода: 23 и 25 часов
    assert sch.day_start(date(2026, 3, 9), NEW_YORK) - sch.day_start(date(2026, 3, 8), NEW_YORK) == timedelta(hours=23)
    assert sch.day_start(date(2026, 11, 2), NEW_YORK) - sch.day_start(date(2026, 11, 1), NEW_YORK) == timedelta(
        hours=25)


def _rule(days=(1, 2, 3, 4, 5, 6, 7), at=time(19, 0), tz=TASHKENT, since=datetime(2026, 1, 1, tzinfo=UTC)):
    return sch.SlotRule(frozenset(days), at, tz, since)


def test_due_in_window_reminder_and_midnight() -> None:
    rule = _rule()
    # 18.11 (ср) 19:00 Ташкент = 14:00Z
    assert sch.due_in_window(rule, datetime(2026, 11, 18, 13, 55, tzinfo=UTC),
                             datetime(2026, 11, 18, 14, 0, tzinfo=UTC)) == sch.Due([date(2026, 11, 18)], [])
    # граница окна: момент слота = start — уже не в окне (он был в предыдущем)
    assert sch.due_in_window(rule, datetime(2026, 11, 18, 14, 0, tzinfo=UTC),
                             datetime(2026, 11, 18, 14, 5, tzinfo=UTC)) == sch.Due([], [])
    # местная полночь 19.11 = 18.11 19:00Z → пропуск за 18.11
    assert sch.due_in_window(rule, datetime(2026, 11, 18, 18, 55, tzinfo=UTC),
                             datetime(2026, 11, 18, 19, 0, tzinfo=UTC)) == sch.Due([], [date(2026, 11, 18)])
    # пустое и обратное окно
    t = datetime(2026, 11, 18, 14, 0, tzinfo=UTC)
    assert sch.due_in_window(rule, t, t) == sch.Due([], [])
    assert sch.due_in_window(rule, t, t - timedelta(minutes=5)) == sch.Due([], [])


def test_due_in_window_respects_days_and_effective_from() -> None:
    weekdays = _rule(days=(1, 2, 3, 4, 5))
    sat_start, sat_end = datetime(2026, 11, 21, 0, 0, tzinfo=UTC), datetime(2026, 11, 22, 0, 0, tzinfo=UTC)
    # суббота не в графике: ни напоминания, ни пропуска за неё; пропуск за пятницу — в полночь пт→сб (пт 19:00Z)
    assert sch.due_in_window(weekdays, sat_start, sat_end) == sch.Due([], [])
    # слот раньше effective_from (онбординг после 19:00) не напоминается и не считается пропущенным
    late = _rule(since=datetime(2026, 11, 18, 15, 0, tzinfo=UTC))
    assert sch.due_in_window(late, datetime(2026, 11, 18, 13, 0, tzinfo=UTC),
                             datetime(2026, 11, 18, 20, 0, tzinfo=UTC)) == sch.Due([], [])


def test_each_slot_falls_in_exactly_one_window_across_dst() -> None:
    """Окна по 5 минут через переходы DST: каждый слот и каждый конец дня — ровно один раз."""
    for tz, at, first in ((NEW_YORK, time(2, 30), datetime(2026, 3, 6, tzinfo=UTC)),
                          (NEW_YORK, time(1, 30), datetime(2026, 10, 30, tzinfo=UTC)),
                          (ZoneInfo("Europe/Berlin"), time(0, 0), datetime(2026, 3, 27, tzinfo=UTC)),
                          # Чили: переход в полночь — 06.09.2026 00:00 не существует, 04.04.2026 23:xx бывает дважды
                          (ZoneInfo("America/Santiago"), time(0, 0), datetime(2026, 9, 3, tzinfo=UTC)),
                          (ZoneInfo("America/Santiago"), time(23, 30), datetime(2026, 4, 2, tzinfo=UTC)),
                          (ZoneInfo("Australia/Lord_Howe"), time(2, 15), datetime(2026, 10, 2, tzinfo=UTC)),
                          (TASHKENT, time(23, 59), datetime(2026, 11, 16, tzinfo=UTC))):
        rule = _rule(at=at, tz=tz)
        reminders: list[date] = []
        missed: list[date] = []
        t = first
        for _ in range(5 * 24 * 12):
            due = sch.due_in_window(rule, t, t + timedelta(minutes=5))
            reminders += due.reminders
            missed += due.missed
            t += timedelta(minutes=5)
        assert len(reminders) == len(set(reminders)) and len(missed) == len(set(missed)), tz
        assert len(reminders) >= 4 and len(missed) >= 4, tz
        assert sorted(reminders) == reminders and sorted(missed) == missed
        # без пропусков дат: каждая дата между первой и последней — ровно один раз
        span = (reminders[-1] - reminders[0]).days + 1
        assert len(reminders) == span, (tz, reminders)


def test_santiago_midnight_transitions() -> None:
    santiago = ZoneInfo("America/Santiago")
    # 06.09.2026: 00:00 → 01:00 — день начинается в 01:00 (-03) = 04:00Z
    assert sch.day_start(date(2026, 9, 6), santiago) == datetime(2026, 9, 6, 4, 0, tzinfo=UTC)
    assert sch.slot_instant(date(2026, 9, 5), time(23, 30), santiago) < sch.day_start(date(2026, 9, 6), santiago)
    # 04.04.2026: 23:30 бывает дважды — берём первое (-03, 02:30Z); новый день — 00:00 (-04) = 04:00Z
    assert sch.slot_instant(date(2026, 4, 4), time(23, 30), santiago) == datetime(2026, 4, 5, 2, 30, tzinfo=UTC)
    assert sch.day_start(date(2026, 4, 5), santiago) == datetime(2026, 4, 5, 4, 0, tzinfo=UTC)


def test_next_slot_date() -> None:
    wed = date(2026, 11, 18)
    assert sch.next_slot_date([1, 3, 5], wed) == date(2026, 11, 20)
    assert sch.next_slot_date([1, 3, 5], wed, include=True) == wed
    assert sch.next_slot_date([3], wed) == date(2026, 11, 25)
    assert sch.next_slot_date([], wed) is None


def test_today_plan_week_and_next_slot() -> None:
    wed = date(2026, 11, 18)
    facts = sch.DayFacts({date(2026, 11, 16): 15, wed: 5}, frozenset({date(2026, 11, 17)}))
    out = sch.today_plan(today=wed, days=[1, 2, 3, 5], preferred_time=time(8, 5), duration_min=15, facts=facts,
                         streak_days=1)
    assert out["local_date"] == "2026-11-18" and out["is_scheduled_today"] is True and out["slot_time"] == "08:05"
    assert out["done_today"] is True and out["minutes_today"] == 5
    assert out["next_slot"] == {"local_date": "2026-11-20", "time": "08:05"}  # сегодня сделано → следующий
    assert out["week"][0]["local_date"] == "2026-11-16" and len(out["week"]) == 7
    assert [(d["scheduled"], d["done"], d["missed"]) for d in out["week"][:4]] == [
        (True, True, False), (True, False, True), (True, True, False), (False, False, False)]
    assert not any(d["frozen"] for d in out["week"])
    not_done = sch.today_plan(today=wed, days=[3], preferred_time=time(8, 0), duration_min=10,
                              facts=sch.DayFacts({}, frozenset()), streak_days=0)
    assert not_done["next_slot"] == {"local_date": "2026-11-18", "time": "08:00"}
    off = sch.today_plan(today=wed, days=[1], preferred_time=time(8, 0), duration_min=10,
                         facts=sch.DayFacts({}, frozenset()), streak_days=0)
    assert off["is_scheduled_today"] is False and off["slot_time"] is None
    assert off["next_slot"] == {"local_date": "2026-11-23", "time": "08:00"}


def test_today_plan_week_frozen() -> None:
    """Спринт 6: frozen — только пропущенный день (missed остаётся true) с заморозкой; день с занятием важнее
    заморозки; заморозка без выпущенного пропуска день не помечает."""
    mon, tue, wed, thu = (date(2026, 11, d) for d in (16, 17, 18, 19))
    facts = sch.DayFacts({wed: 10}, frozenset({mon, tue, wed}), frozenset({tue, wed, thu}))
    out = sch.today_plan(today=date(2026, 11, 20), days=[1, 2, 3, 4, 5], preferred_time=time(8, 0),
                         duration_min=10, facts=facts, streak_days=1)
    assert [(d["done"], d["missed"], d["frozen"]) for d in out["week"][:4]] == [
        (False, True, False), (False, True, True), (True, False, False), (False, False, False)]
