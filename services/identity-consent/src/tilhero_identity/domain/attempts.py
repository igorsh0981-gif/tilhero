"""Общий счётчик неудачных проверок кода родителя (PIN), биометрии и кода при удалении (5 попыток → блок 5 минут).

Хранится в Redis (`pin:fail:<user_id>`, `pin:lock:<user_id>`): блокировка действует на все реплики и все способы
проверки.

Попытка резервируется атомарно ДО проверки секрета (`reserve` → проверка → `failed` | `succeeded`):
параллельные запросы не перебирают больше `max_attempts` вариантов, а запрос, начатый до блокировки соседом, после
неё не проходит. Одиночный запрос: `remaining` уменьшается на 1, блокировка — на 5-й неудаче.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from redis.asyncio import Redis

from tilhero_common.errors import ApiError
from tilhero_common.redis_tools import AttemptLimiter, AttemptState

NAMESPACE = "pin"


def pin_locked(retry_after: int) -> ApiError:
    return ApiError(423, "PIN_LOCKED", "Слишком много неверных попыток. Попробуйте позже",
                    {"retry_after": max(int(retry_after), 1)})


@dataclass(frozen=True)
class Failure:
    code: str
    message: str


PIN_INVALID = Failure("PIN_INVALID", "Неверный PIN")
BIOMETRIC_INVALID = Failure("BIOMETRIC_INVALID", "Биометрия не подтверждена")


class PinAttempts:
    def __init__(self, redis: Redis, max_attempts: int = 5, lock_seconds: int = 300) -> None:
        self.limiter = AttemptLimiter(redis, NAMESPACE, max_attempts, lock_seconds)

    async def state(self, user_id: uuid.UUID) -> AttemptState:
        return await self.limiter.state(str(user_id))

    async def reserve(self, user_id: uuid.UUID) -> AttemptState:
        """Занять попытку до проверки секрета; заблокировано — 423 PIN_LOCKED."""
        state = await self.limiter.reserve(str(user_id))
        if state.locked:
            raise pin_locked(state.retry_after)
        return state

    async def failed(self, user_id: uuid.UUID, reserved: AttemptState) -> AttemptState:
        return await self.limiter.failed(str(user_id), reserved)

    async def succeeded(self, user_id: uuid.UUID) -> None:
        await self.limiter.reset(str(user_id))
