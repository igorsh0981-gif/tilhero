"""Политика доставки (domain/policy.py): порядок шагов §4, тихие часы через полночь, окно детей, устаревание."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from tilhero_notifications.domain.policy import (
    Item,
    Recipient,
    Rules,
    decide,
    kid_window_start,
    limit_applies,
    local_day,
    quiet_hours_end,
    zone,
)

TZ = ZoneInfo("Asia/Tashkent")  # UTC+5, без перехода на летнее время
RULES = Rules()


def t(hhmm: str, day: date = date(2026, 11, 20), tz: ZoneInfo = TZ) -> datetime:
    h, m = (int(x) for x in hhmm.split(":"))
    return datetime(day.year, day.month, day.day, h, m, tzinfo=tz).astimezone(UTC)


def who(**kw) -> Recipient:
    base = dict(
        status="ACTIVE",
        categories=frozenset({"reminders", "missed", "social", "support", "product"}),
        notifications_enabled=True,
        quiet_hours=("22:00", "08:00"),
        timezone="Asia/Tashkent",
        is_kid=False,
        has_address=True,
    )
    base.update(kw)
    return Recipient(**base)  # type: ignore[arg-type]


def test_quiet_hours_across_midnight_and_same_day() -> None:
    assert quiet_hours_end(t("23:30"), "22:00", "08:00", TZ) == t("08:00", date(2026, 11, 21))
    assert quiet_hours_end(t("07:59"), "22:00", "08:00", TZ) == t("08:00")
    assert quiet_hours_end(t("08:00"), "22:00", "08:00", TZ) is None  # конец не входит
    assert quiet_hours_end(t("21:59"), "22:00", "08:00", TZ) is None
    assert quiet_hours_end(t("22:00"), "22:00", "08:00", TZ) == t("08:00", date(2026, 11, 21))
    assert quiet_hours_end(t("13:00"), "12:00", "14:00", TZ) == t("14:00")
    assert quiet_hours_end(t("13:00"), "10:00", "10:00", TZ) is None  # пустое окно
    assert quiet_hours_end(t("13:00"), "bad", "10:00", TZ) is None


def test_kid_window_boundaries() -> None:
    window = ("08:00", "20:00")
    assert kid_window_start(t("07:59"), window, TZ) == t("08:00")
    assert kid_window_start(t("08:00"), window, TZ) is None
    assert kid_window_start(t("19:59"), window, TZ) is None
    assert kid_window_start(t("20:00"), window, TZ) == t("08:00", date(2026, 11, 21))  # «не позже 20:00»
    assert kid_window_start(t("23:59"), window, TZ) == t("08:00", date(2026, 11, 21))


def test_local_day_and_zone_fallback() -> None:
    late = t("23:30")  # 18:30 UTC того же дня; в Ташкенте уже 23:30 → местная дата 20.11
    assert local_day(late, TZ) == date(2026, 11, 20)
    assert local_day(late + timedelta(minutes=31), TZ) == date(2026, 11, 21)  # полночь по местному
    assert zone("Not/AZone", "Asia/Tashkent") == TZ
    assert zone(None, "also-bad").key == "UTC"
    assert limit_applies("reminders") and limit_applies("social") and not limit_applies("support")


def test_order_category_before_switch_before_quiet_hours() -> None:
    night = t("23:00")
    no_cat = who(categories=frozenset({"support"}), notifications_enabled=False)
    # 1. категория выключена → skip, даже если выключатель и тихие часы тоже сработали бы
    assert decide(Item("reminders"), no_cat, night, RULES) == decide(Item("reminders"), no_cat, t("12:00"), RULES)
    assert decide(Item("reminders"), no_cat, night, RULES).action == "skip"
    # support/service — всегда включены; 2. выключатель → только центр, а не «отложить на тихие часы»
    d = decide(Item("support"), no_cat, night, RULES)
    assert (d.action, d.reason) == ("in_app_only", "notifications_disabled")
    # 3. тихие часы → отложить до конца
    d = decide(Item("support"), who(), night, RULES)
    assert (d.action, d.at, d.reason) == ("defer", t("08:00", date(2026, 11, 21)), "quiet_hours")
    assert decide(Item("support"), who(quiet_hours=None), night, RULES).action == "send"


def test_kids_window_after_quiet_hours() -> None:
    kid = who(is_kid=True, quiet_hours=("22:00", "07:00"))
    # 07:30: тихие часы закончились, но окно детей с 08:00
    d = decide(Item("reminders"), kid, t("07:30"), RULES)
    assert (d.action, d.at, d.reason) == ("defer", t("08:00"), "kid_window")
    # 21:00: не тихие часы, но после 20:00 — на 08:00 завтра
    d = decide(Item("reminders"), kid, t("21:00"), RULES)
    assert (d.action, d.at) == ("defer", t("08:00", date(2026, 11, 21)))
    # 23:00: тихие часы раньше окна детей (порядок §4) — до 07:00, затем окно перенесёт на 08:00
    d = decide(Item("reminders"), kid, t("23:00"), RULES)
    assert (d.action, d.reason) == ("defer", "quiet_hours") and d.at == t("07:00", date(2026, 11, 21))
    assert decide(Item("reminders"), kid, t("12:00"), RULES).action == "send"
    assert decide(Item("reminders"), who(), t("21:00"), RULES).action == "send"  # взрослому окно не нужно


def test_stale_and_not_before() -> None:
    slot = t("21:00")
    reminder = Item("reminders", stale_after=slot + timedelta(hours=3))
    # Тихие часы до 08:00 — позже срока актуальности: сразу только центр, без «отложено»
    d = decide(reminder, who(), t("22:30"), RULES)
    assert (d.action, d.reason) == ("in_app_only", "stale")
    assert decide(reminder, who(quiet_hours=None), t("23:59"), RULES).action == "send"
    assert decide(reminder, who(quiet_hours=None), slot + timedelta(hours=3), RULES).reason == "stale"
    # Пропуск: ждёт слота следующего дня; после 22:00 — только центр
    missed = Item("missed", not_before=t("19:00"), stale_after=t("22:00"))
    d = decide(missed, who(quiet_hours=None), t("00:00"), RULES)
    assert (d.action, d.at, d.reason) == ("defer", t("19:00"), "not_before")
    assert decide(missed, who(quiet_hours=None), t("19:00"), RULES).action == "send"
    assert decide(missed, who(quiet_hours=None), t("21:30"), RULES).action == "send"  # «сразу, если ещё не 22:00»
    assert decide(missed, who(quiet_hours=None), t("22:00"), RULES).reason == "stale"


@pytest.mark.parametrize(
    ("item", "recipient", "expected"),
    [
        (Item("social", center_only=True), who(), ("in_app_only", "center_only")),
        (Item("social", gated=False, center_only=True), who(categories=frozenset()), ("in_app_only", "center_only")),
        (Item("social"), who(status="DISABLED"), ("skip", "user_inactive")),
        (Item("social"), who(has_address=False, quiet_hours=None), ("in_app_only", "no_recipient")),
        (Item("product"), who(categories=frozenset({"support"})), ("skip", "category_disabled")),
        # код сброса PIN: мимо статуса, категорий, выключателя и тихих часов
        (
            Item("service", transactional=True),
            who(status="DISABLED", notifications_enabled=False, categories=frozenset()),
            ("send", None),
        ),
    ],
)
def test_event_rules(item: Item, recipient: Recipient, expected: tuple[str, str | None]) -> None:
    d = decide(item, recipient, t("23:00"), RULES)
    assert (d.action, d.reason) == expected
