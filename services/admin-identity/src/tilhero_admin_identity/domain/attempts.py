"""Счётчик попыток с резервированием — `AttemptLimiter` из py-common (те же ключи Redis).

Резервирование (`reserve` → проверка секрета → `failed` | `reset`) и атомарность (проверка блокировки, INCR и
блокировка — один Lua-скрипт) перенесены в py-common (форк aievent, исправление Q9): тот же приём нужен PIN Mini App
(identity-consent). История: AttemptLimiter.fail() считал неудачу ПОСЛЕ проверки пароля/кода — параллельный «залп»
перебирал больше max_attempts вариантов; затем state() и INCR отдельными командами давали обход блокировки
(нестабильный test_parallel_burst_cannot_exceed_attempt_limit, исправление Q9)."""

from __future__ import annotations

from tilhero_common.redis_tools import AttemptLimiter


class ReservingLimiter(AttemptLimiter):
    """Имя для админ-контура: вход и MFA сотрудника всегда идут через `reserve()`."""
