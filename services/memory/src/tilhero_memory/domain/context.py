"""Контекст запроса домена memory: runtime (БД, Redis, клиенты), catalog, настройки, время, ученик."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import cast

from tilhero_common.app import Runtime
from tilhero_memory.clients import CatalogGateway
from tilhero_memory.domain.learners import Learner
from tilhero_memory.settings import Settings


@dataclass
class Ctx:
    rt: Runtime
    catalog: CatalogGateway
    settings: Settings
    now: datetime
    learner: Learner

    @property
    def user_id(self) -> uuid.UUID:
        return self.learner.user_id


def settings_of(rt: Runtime) -> Settings:
    return cast(Settings, rt.settings)


def now_of(rt: Runtime) -> datetime:
    """Часы сервиса (UTC): тесты подменяют `runtime.clock` (сроки FSRS, 7/30 дней, 90 дней хранения)."""
    clock = getattr(rt, "clock", None)
    return clock() if callable(clock) else datetime.now(UTC)
