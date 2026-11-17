"""Защита оповещений операторам без Redis (спринт 9, Q10): дедупликация и лимит в памяти процесса.

Оповещение операторам («Redis недоступен», «NATS недоступен», сбой поставщика) важнее строгой идемпотентности: при
недоступном Redis `POST /internal/v1/ops-messages` не отказывает 503, а держит `dedup_key` и лимит «N в минуту» в
памяти процесса (bot-gateway — одна реплика). Семантика — как у `IdempotencyStore` py-common: повтор с тем же ключом
и телом → сохранённый ответ, другое тело → 422, параллельный дубль → 409. Завершённые в памяти ключи проверяются и
после возврата Redis — повтор notifications не дублирует сообщение. Перезапуск процесса во время простоя Redis
теряет память (возможен один дубль сообщения операторам — приемлемо).
"""

from __future__ import annotations

import time
from collections import OrderedDict
from collections.abc import Callable
from typing import Any

from tilhero_common.errors import conflict, unprocessable

MAX_KEYS = 10_000


class MemoryIdempotency:
    def __init__(self, ttl_seconds: int, clock: Callable[[], float] = time.monotonic) -> None:
        self.ttl = ttl_seconds
        self.clock = clock
        self._items: OrderedDict[tuple[str, str], tuple[float, dict[str, Any]]] = OrderedDict()

    def _get(self, scope: str, key: str) -> dict[str, Any] | None:
        item = self._items.get((scope, key))
        if item is None:
            return None
        expires, value = item
        if expires <= self.clock():
            del self._items[(scope, key)]
            return None
        return value

    def _put(self, scope: str, key: str, value: dict[str, Any], ttl: float) -> None:
        self._items[(scope, key)] = (self.clock() + ttl, value)
        self._items.move_to_end((scope, key))
        while len(self._items) > MAX_KEYS:
            self._items.popitem(last=False)

    def done(self, scope: str, key: str, request_fp: str) -> dict[str, Any] | None:
        """Ответ, сохранённый в памяти во время простоя Redis (то же тело), иначе None."""
        stored = self._get(scope, key)
        if stored is None or stored.get("state") != "done":
            return None
        if stored.get("fp") != request_fp:
            raise unprocessable("IDEMPOTENCY_KEY_REUSED", "Ключ идемпотентности уже использован с другими данными")
        return stored["response"]

    def begin(self, scope: str, key: str, request_fp: str) -> dict[str, Any] | None:
        stored = self._get(scope, key)
        if stored is None:
            self._put(scope, key, {"state": "pending", "fp": request_fp}, 60)
            return None
        if stored.get("fp") != request_fp:
            raise unprocessable("IDEMPOTENCY_KEY_REUSED", "Ключ идемпотентности уже использован с другими данными")
        if stored.get("state") == "pending":
            raise conflict("IDEMPOTENCY_IN_PROGRESS", "Запрос с этим ключом уже выполняется")
        return stored["response"]

    def complete(self, scope: str, key: str, request_fp: str, response: dict[str, Any]) -> None:
        self._put(scope, key, {"state": "done", "fp": request_fp, "response": response}, self.ttl)

    def abort(self, scope: str, key: str) -> None:
        self._items.pop((scope, key), None)


class MemoryMinuteLimit:
    """Фиксированное окно в минуту (как `rate_limit` py-common): → (разрешено, секунд до сброса)."""

    def __init__(self, limit: int, clock: Callable[[], float] = time.monotonic) -> None:
        self.limit = limit
        self.clock = clock
        self._window = -1
        self._count = 0

    def hit(self) -> tuple[bool, int]:
        now = self.clock()
        window = int(now // 60)
        if window != self._window:
            self._window, self._count = window, 0
        self._count += 1
        return self._count <= self.limit, max(int(60 - now % 60), 1)


class OpsLocalGuard:
    def __init__(self, ttl_seconds: int, per_minute: int) -> None:
        self.idem = MemoryIdempotency(ttl_seconds)
        self.limit = MemoryMinuteLimit(per_minute)
