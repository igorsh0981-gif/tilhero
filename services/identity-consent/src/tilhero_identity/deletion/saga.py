"""Чистые правила саги удаления (ADR-009, INTERNAL_API §1.3): статусы, расписание повторов, «зависло», ручной повтор.

Без БД, FastAPI и часов: время передаётся параметром, поэтому правила проверяются юнит-тестами.

Статусы: REQUESTED → STUCK (через `stuck_hours` без полного ACK) → COMPLETED; REQUESTED → COMPLETED. Из STUCK тоже
только COMPLETED — и только когда подтвердили все домены. Принудительного завершения без ACK нет.

Расписание: точки повтора P_k = requested_at + offset(k), offset — `schedule` минут (15, 60, 240, 720, 1440), дальше —
каждые TAIL_MINUTES. После любой рассылки (таймер или сотрудник) в момент t следующий повтор — первая точка P_k > t:
ручной повтор не вызывает «догоняющий» повтор таймера сразу за ним, а простой таймера (рестарт, сбой БД) даёт один
повтор, а не пачку пропущенных.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Sequence
from datetime import datetime, timedelta
from itertools import pairwise

REQUESTED = "REQUESTED"
STUCK = "STUCK"
COMPLETED = "COMPLETED"
STATUSES = (REQUESTED, STUCK, COMPLETED)
OPEN_STATUSES = (REQUESTED, STUCK)

TAIL_MINUTES = 1440  # после расписания — раз в сутки, пока запрос открыт
MAX_SCHEDULE_MINUTES = 7 * 1440

BY_USER = "user"  # первичная рассылка — запрос пользователя
BY_SYSTEM = "system"  # повтор по таймеру

# фильтр админ-списка → статусы
LIST_FILTERS: dict[str, tuple[str, ...]] = {
    "open": OPEN_STATUSES,
    "stuck": (STUCK,),
    "completed": (COMPLETED,),
}


def parse_schedule(raw: str | Iterable[int]) -> tuple[int, ...]:
    """"15,60,240,720,1440" → (15, 60, 240, 720, 1440). Минуты > 0, строго по возрастанию, не больше недели."""
    items = [p.strip() for p in raw.split(",")] if isinstance(raw, str) else [str(p) for p in raw]
    try:
        values = tuple(int(p) for p in items if p)
    except ValueError as exc:
        raise ValueError("DELETION_RETRY_SCHEDULE_MINUTES: ожидаются целые минуты через запятую") from exc
    if not values:
        raise ValueError("DELETION_RETRY_SCHEDULE_MINUTES: расписание пусто")
    if any(v <= 0 or v > MAX_SCHEDULE_MINUTES for v in values):
        raise ValueError(f"DELETION_RETRY_SCHEDULE_MINUTES: минуты в диапазоне 1..{MAX_SCHEDULE_MINUTES}")
    if any(b <= a for a, b in pairwise(values)):
        raise ValueError("DELETION_RETRY_SCHEDULE_MINUTES: значения строго по возрастанию")
    return values


def retry_offset(k: int, schedule: Sequence[int]) -> timedelta:
    """Смещение k-го повтора (k ≥ 1) от момента запроса."""
    if k < 1:
        raise ValueError("k >= 1")
    if k <= len(schedule):
        return timedelta(minutes=schedule[k - 1])
    return timedelta(minutes=schedule[-1] + TAIL_MINUTES * (k - len(schedule)))


def next_retry_at(requested_at: datetime, sent_at: datetime, schedule: Sequence[int]) -> datetime:
    """Первая точка расписания строго позже последней рассылки `sent_at`."""
    for minutes in schedule:
        point = requested_at + timedelta(minutes=minutes)
        if point > sent_at:
            return point
    last = requested_at + timedelta(minutes=schedule[-1])
    tail = timedelta(minutes=TAIL_MINUTES)
    steps = math.floor((sent_at - last) / tail) + 1
    return last + tail * steps


def stuck_deadline(requested_at: datetime, stuck_hours: float) -> datetime:
    return requested_at + timedelta(hours=stuck_hours)


def stuck_due(status: str, requested_at: datetime, now: datetime, stuck_hours: float) -> bool:
    """REQUESTED без полного ACK дольше `stuck_hours` → STUCK (повторы продолжаются)."""
    return status == REQUESTED and now >= stuck_deadline(requested_at, stuck_hours)


def retry_due(status: str, next_at: datetime | None, now: datetime) -> bool:
    return status in OPEN_STATUSES and next_at is not None and next_at <= now


def pending_domains(expected: Sequence[str], acked: Iterable[str]) -> list[str]:
    """Домены, которые ещё не подтвердили удаление, в порядке `expected` (без дублей)."""
    done = set(acked)
    return [d for d in dict.fromkeys(expected) if d not in done]


def all_acked(expected: Sequence[str], acked: Iterable[str]) -> bool:
    return not pending_domains(expected, acked)


def manual_retry_wait(last_sent_at: datetime | None, now: datetime, min_seconds: int) -> int:
    """Сколько секунд ждать до ручного повтора (0 — можно сейчас). Округление вверх: «повторите через N с»."""
    if last_sent_at is None or min_seconds <= 0:
        return 0
    left = (last_sent_at + timedelta(seconds=min_seconds) - now).total_seconds()
    return max(0, math.ceil(left))


def can_retry(status: str) -> bool:
    """Повтор (таймер или сотрудник) — только для открытого запроса."""
    return status in OPEN_STATUSES
