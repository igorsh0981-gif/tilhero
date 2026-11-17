"""Состояние outbox и консьюмеров сервиса для ops-monitor (спринт 8, docs/sprint8/INTERNAL_API.md §3.1).

`create_app` подключает роутер каждому Python-сервису с БД. Вызывающий — только `ops-monitor`. В ответе — числа,
время и имя класса последней ошибки публикации; ни payload событий, ни текста ошибок.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, Request
from sqlalchemy import func, select

from tilhero_common.internal_auth import InternalAuth, Principal
from tilhero_common.messaging.store import outbox_table

OPS_MONITOR = "ops-monitor"
_ERROR_CLASS_RE = re.compile(r"^[A-Za-z_.]{1,64}$")

router = APIRouter(tags=["ops"])


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


async def outbox_stats(runtime: Any, now: datetime | None = None) -> dict[str, Any]:
    """`{service, pending, failing, oldest_pending_at, max_attempts, last_error_class, published_24h, consumers}`.
    `failing` — неопубликованные с attempts > 0; `last_error_class` — класс исключения последней неудачной
    публикации (у outbox в `last_error` и так только имя класса), иначе null."""
    now = now or datetime.now(UTC)
    o = outbox_table.c
    pending = o.published_at.is_(None)
    # Два запроса по индексу `published_at` вместо одного агрегата по всей таблице (ревью спринта 8): опубликованные
    # хранятся OUTBOX_RETENTION_HOURS (72 ч) и у нагруженного сервиса их много — неопубликованных единицы.
    async with runtime.db.session() as s:
        p = (await s.execute(select(
            func.count(),
            func.count().filter(o.attempts > 0),
            func.min(o.created_at),
            func.coalesce(func.max(o.attempts), 0),
        ).where(pending))).one()
        published_24h = (await s.execute(
            select(func.count()).select_from(outbox_table).where(o.published_at >= now - timedelta(hours=24))
        )).scalar_one()
        row = (*p, published_24h)
        last = (await s.execute(
            select(o.last_error).where(pending, o.attempts > 0, o.last_error.is_not(None))
            .order_by(o.next_attempt_at.desc()).limit(1)
        )).scalar()
    error_class = last if isinstance(last, str) and _ERROR_CLASS_RE.match(last) else None
    bus = runtime.bus
    stale = set(getattr(bus, "stale_consumers", lambda: [])()) if bus is not None else set()
    consumers = [{"durable": spec.durable, "stale": spec.durable in stale} for spec in runtime._consumers]
    return {
        "service": runtime.settings.service_name,
        "pending": int(row[0]),
        "failing": int(row[1]),
        "oldest_pending_at": _iso(row[2]),
        "max_attempts": int(row[3]),
        "last_error_class": error_class,
        "published_24h": int(row[4]),
        "consumers": consumers,
    }


@router.get("/internal/v1/ops/outbox")
async def get_outbox(request: Request,
                     principal: Principal = Depends(InternalAuth({OPS_MONITOR}))) -> dict[str, Any]:
    return await outbox_stats(request.app.state.runtime)
