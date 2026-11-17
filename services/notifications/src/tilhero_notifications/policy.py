"""Политика доставки (чистые функции).

- critical / transactional — сразу, в т.ч. в тихие часы (TG-FR-032);
- standard / digest — в тихие часы откладываются до их конца (в часовом поясе пользователя, zoneinfo);
- выключенные уведомления или статус не ACTIVE → skipped, кроме transactional-шаблона с bypass
  (код сброса PIN).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, datetime, time, timedelta
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from tilhero_notifications.delivery import DeliveryInfo
from tilhero_notifications.templates import TemplateSpec

IMMEDIATE_KINDS = frozenset({"critical", "transactional"})
_HHMM = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")


@dataclass(frozen=True)
class Decision:
    action: Literal["send", "defer", "skip"]
    at: datetime | None = None
    reason: str | None = None


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


def quiet_hours_end(now: datetime, start: str, end: str, tz: ZoneInfo) -> datetime | None:
    """Если `now` внутри тихих часов [start, end) — момент их окончания в UTC, иначе None.
    Окно может переходить через полночь (23:00–08:00); start == end — тихих часов нет."""
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
    return datetime.combine(end_date, t_end, tzinfo=tz).astimezone(UTC)


def decide(
    kind: str, template: TemplateSpec, delivery: DeliveryInfo, now: datetime, default_tz: str
) -> Decision:
    bypass = template.bypass_preferences and kind == "transactional"
    if delivery.status != "ACTIVE" and not bypass:
        return Decision("skip", reason="user_inactive")
    if not delivery.notifications_enabled and not bypass:
        return Decision("skip", reason="notifications_disabled")
    if kind in IMMEDIATE_KINDS or delivery.quiet_hours is None:
        return Decision("send")
    end = quiet_hours_end(
        now, delivery.quiet_hours.start, delivery.quiet_hours.end, zone(delivery.timezone, default_tz)
    )
    if end is not None and end > now:
        return Decision("defer", at=end)
    return Decision("send")
