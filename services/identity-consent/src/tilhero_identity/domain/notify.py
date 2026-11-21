"""Настройки уведомлений ученика: категории (явное включение), тихие часы, выключатель.

Категории (bff.ts NotificationCategories): `reminders`, `missed`, `social`, `support`, `product`, `game` (спринт 7:
игра и лиги — значки, рост героя, спасённая серия, итоги лиги, дуэли). По умолчанию включены `support` (служебные
ответы поддержки) и `game` (INTERNAL_API спринта 7 §5: выключенная — уведомления остаются в центре без Telegram);
остальные — только явным включением пользователя (APP-ONB-03).
Тихие часы по умолчанию 22:00–08:00 (интервал может переходить через полночь), `null` — выключены.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from datetime import time

CATEGORIES: tuple[str, ...] = ("reminders", "missed", "social", "support", "product", "game")
DEFAULT_CATEGORIES: tuple[str, ...] = ("support", "game")
DEFAULT_QUIET_START = time(22, 0)
DEFAULT_QUIET_END = time(8, 0)

_HHMM_RE = re.compile(r"^([01][0-9]|2[0-3]):[0-5][0-9]$")


class QuietHoursError(ValueError):
    def __init__(self, field: str, reason: str) -> None:
        super().__init__(f"{field}: {reason}")
        self.field = field
        self.reason = reason


def hhmm(value: time) -> str:
    return value.strftime("%H:%M")


def parse_hhmm(value: str, field: str) -> time:
    if not _HHMM_RE.match(value):
        raise QuietHoursError(field, "format")
    hours, minutes = value.split(":")
    return time(int(hours), int(minutes))


def parse_quiet_hours(start: str, end: str) -> tuple[time, time]:
    """"HH:MM" 00:00–23:59, начало ≠ конец (пустой интервал), переход через полночь допустим (22:00–08:00)."""
    s, e = parse_hhmm(start, "start"), parse_hhmm(end, "end")
    if s == e:
        raise QuietHoursError("end", "empty")
    return s, e


def normalize_categories(values: Iterable[str]) -> list[str]:
    """Канонический порядок, без дублей и неизвестных."""
    present = set(values)
    return [c for c in CATEGORIES if c in present]


def apply_categories(current: Iterable[str], changes: dict[str, bool]) -> list[str]:
    result = set(current)
    for code, enabled in changes.items():
        if code not in CATEGORIES:
            continue
        if enabled:
            result.add(code)
        else:
            result.discard(code)
    return normalize_categories(result)
