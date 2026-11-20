"""Политика доставки в момент отправки (INTERNAL_API §4) — чистые функции, без БД и сети.

Порядок шагов §4 (строго):
1. категория включена у ученика (`DeliveryInfo.categories`; support/service — всегда) — иначе skip;
2. `notifications_enabled` выключен — только центр (in_app_only);
3. тихие часы — отложить до их конца;
4. дети 6–13 — окно 08:00–20:00 местного (иначе отложить до 08:00), адресат — опекун, шаблон *.kid;
5. лимит ≤ 3 сообщений reminders+missed+social (+game, спринт 6) в местные сутки — проверяет вызывающий в транзакции
   (`limit_applies` / `local_day`), сверх — in_app_only;
6. дедупликация — UNIQUE(dedup_key) при приёме.

Правила событий, не меняющие порядок: неактивный статус → skip (кроме транзакционных); «только центр»
(отклонённое приглашение, «Что нового») → in_app_only; устаревшее (напоминание > 3 ч после слота, пропуск после
22:00 следующего дня) → in_app_only; нет адресата Telegram → in_app_only; пропуск ждёт `not_before`
(слот следующего дня). Отложенное до момента позже `stale_after` сразу уходит только в центр.

Спринт 6 (INTERNAL_API спринта 6 §3) — категория `game` (заморозка серии, значок, ступень героя):
- выключатель категории — общий (шаг 1), но пока `game` нет в настройках ученика (bff.ts NotificationCategories,
  identity-consent), она включается выключателем `reminders`: `Rules.category_gates` (настройка
  GAME_CATEGORY_GATE, `reminders` | `game`);
- выключатель выключен — запись остаётся в центре без Telegram (`Rules.center_when_disabled`), а не пропадает;
- входит в лимит дня (частота — общая);
- дети 6–13: опекуну только в сводке — запись в центре детского профиля (in_app_only, reason `kid_summary`),
  без отдельного сообщения в Telegram (`Item.kid_in_app_only`).
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

ALWAYS_ON = frozenset({"support", "service"})
LIMITED = frozenset({"reminders", "missed", "social", "game"})
KID_BANDS = frozenset({"6-9", "10-13"})
_HHMM = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")

Action = Literal["send", "defer", "in_app_only", "skip"]


@dataclass(frozen=True)
class Decision:
    action: Action
    at: datetime | None = None  # defer: когда обработать снова (UTC)
    reason: str | None = None


@dataclass(frozen=True)
class Recipient:
    """Срез DeliveryInfo, нужный политике."""

    status: str
    categories: frozenset[str]
    notifications_enabled: bool
    quiet_hours: tuple[str, str] | None
    timezone: str | None
    is_kid: bool
    has_address: bool


@dataclass(frozen=True)
class Rules:
    default_tz: str = "Asia/Tashkent"
    kid_window: tuple[str, str] = ("08:00", "20:00")
    # категория записи → категория настроек ученика, которая её включает (нет ключа — она сама); спринт 6:
    # {"game": "reminders"}, пока game нет в настройках ученика
    category_gates: Mapping[str, str] = field(default_factory=dict)
    # категории, которые при выключенном выключателе не пропадают, а остаются в центре без Telegram (спринт 6: game —
    # «Серия спасена» ученик видит в центре, даже если напоминания выключены; e2e спринта 6)
    center_when_disabled: frozenset[str] = frozenset()


@dataclass(frozen=True)
class Item:
    """Срез записи журнала, нужный политике."""

    category: str
    transactional: bool = False  # шаблон с обходом настроек (код сброса PIN), kind=transactional
    gated: bool = True  # категория проверяется (у отклонённого приглашения — нет: «—» в таблице §4)
    center_only: bool = False
    not_before: datetime | None = None
    stale_after: datetime | None = None
    # спринт 6: детям 6–13 — только центр детского профиля (опекуну «в сводке», без сообщения в Telegram)
    kid_in_app_only: bool = False


def zone(name: str | None, default: str) -> ZoneInfo:
    for candidate in (name, default, "UTC"):
        if not candidate:
            continue
        try:
            return ZoneInfo(candidate)
        except (ZoneInfoNotFoundError, ValueError):
            continue
    return ZoneInfo("UTC")


def parse_hhmm(value: str) -> time:
    m = _HHMM.match(value or "")
    if not m:
        raise ValueError("ожидается HH:MM")
    return time(int(m.group(1)), int(m.group(2)))


def at_local(day: date, hhmm: str | time, tz: ZoneInfo) -> datetime:
    """Местные дата + время → UTC (несуществующее/двойное время перехода на летнее — по правилам zoneinfo)."""
    t = parse_hhmm(hhmm) if isinstance(hhmm, str) else hhmm
    return datetime.combine(day, t, tzinfo=tz).astimezone(UTC)


def local_day(now: datetime, tz: ZoneInfo) -> date:
    return now.astimezone(tz).date()


def limit_applies(category: str) -> bool:
    return category in LIMITED


def quiet_hours_end(now: datetime, start: str, end: str, tz: ZoneInfo) -> datetime | None:
    """Если `now` внутри тихих часов [start, end) — момент их окончания в UTC, иначе None.
    Окно может переходить через полночь (22:00–08:00); start == end — тихих часов нет."""
    try:
        t_start, t_end = parse_hhmm(start), parse_hhmm(end)
    except ValueError:
        return None
    if t_start == t_end:
        return None
    local = now.astimezone(tz)
    current = local.time().replace(tzinfo=None)
    if t_start < t_end:
        inside = t_start <= current < t_end
        end_date = local.date()
    else:
        inside = current >= t_start or current < t_end
        end_date = local.date() + timedelta(days=1) if current >= t_start else local.date()
    if not inside:
        return None
    return at_local(end_date, t_end, tz)


def kid_window_start(now: datetime, window: tuple[str, str], tz: ZoneInfo) -> datetime | None:
    """Вне окна [start, end) местного — ближайшее начало окна (UTC), иначе None (можно отправлять)."""
    try:
        t_start, t_end = parse_hhmm(window[0]), parse_hhmm(window[1])
    except ValueError:
        t_start, t_end = time(8, 0), time(20, 0)
    local = now.astimezone(tz)
    current = local.time().replace(tzinfo=None)
    if t_start <= current < t_end:
        return None
    day = local.date() if current < t_start else local.date() + timedelta(days=1)
    return at_local(day, t_start, tz)


def decide(item: Item, who: Recipient, now: datetime, rules: Rules) -> Decision:
    bypass = item.transactional
    if who.status != "ACTIVE" and not bypass:
        return Decision("skip", reason="user_inactive")
    # 1. категория (спринт 6: game — по выключателю из rules.category_gates)
    gate = rules.category_gates.get(item.category, item.category)
    if item.gated and not bypass and item.category not in ALWAYS_ON and gate not in who.categories:
        if item.category in rules.center_when_disabled:
            return Decision("in_app_only", reason="category_disabled_center")
        return Decision("skip", reason="category_disabled")
    if item.center_only:
        return Decision("in_app_only", reason="center_only")
    if item.kid_in_app_only and who.is_kid and not bypass:
        return Decision("in_app_only", reason="kid_summary")
    if item.stale_after is not None and now >= item.stale_after:
        return Decision("in_app_only", reason="stale")
    # 2. общий выключатель Telegram
    if not who.notifications_enabled and not bypass:
        return Decision("in_app_only", reason="notifications_disabled")
    if not who.has_address:
        return Decision("in_app_only", reason="no_recipient")
    if bypass:
        return Decision("send")
    tz = zone(who.timezone, rules.default_tz)
    if item.not_before is not None and now < item.not_before:
        return _defer(item, item.not_before, "not_before")
    # 3. тихие часы
    if who.quiet_hours is not None:
        end = quiet_hours_end(now, who.quiet_hours[0], who.quiet_hours[1], tz)
        if end is not None and end > now:
            return _defer(item, end, "quiet_hours")
    # 4. дети 6–13: только в окне 08:00–20:00 местного
    if who.is_kid:
        start = kid_window_start(now, rules.kid_window, tz)
        if start is not None and start > now:
            return _defer(item, start, "kid_window")
    # 5. лимит — у вызывающего (нужен счёт в БД под блокировкой ученика)
    return Decision("send")


def _defer(item: Item, at: datetime, reason: str) -> Decision:
    if item.stale_after is not None and at >= item.stale_after:
        return Decision("in_app_only", reason="stale")
    return Decision("defer", at=at, reason=reason)
