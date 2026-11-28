"""Начальная загрузка проекции learners (INTERNAL_API §1.16): события профилей живут в стриме 7 дней — давние ученики
приходят выгрузкой identity-consent `GET /internal/v1/export/profiles?cursor=&limit=` ({user_id, kind, age_band,
guardian_consent, updated_at, guardian_user_id}). Элемент — через обработчик проекции в режиме «вставить, если нет;
обновить, если новее» (learners.on_profile_export). Отметка — projection_loads (курсор продолжения, completed_at).
Запуск: фоном при старте (если не завершена), каждым billing:tick (повтор после сбоя), вручную —
POST /internal/v1/projections/bootstrap (force — заново, безопасно). Одна загрузка за раз — сессионная advisory-
блокировка; сбой источника не роняет сервис."""

from __future__ import annotations

import asyncio
import logging
import zlib
from datetime import datetime
from typing import Any, Final, cast

from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_billing import clients
from tilhero_billing.domain import learners
from tilhero_billing.domain.common import now_of
from tilhero_billing.models import ProjectionLoad
from tilhero_billing.settings import Settings
from tilhero_common.app import Runtime

log = logging.getLogger("tilhero.billing.bootstrap")

NAME: Final = "profiles"
LOCK_CLASS: Final = 0x42494C42  # 'BILB'
MAX_PAGES: Final = 100_000


def _lock_object(schema: str | None) -> int:
    return int.from_bytes(zlib.crc32((schema or "").encode()).to_bytes(4, "big"), "big", signed=True)


async def _state(db: AsyncSession) -> ProjectionLoad:
    await db.execute(insert(ProjectionLoad).values(name=NAME, items=0).on_conflict_do_nothing(
        index_elements=["name"]))
    return (await db.execute(select(ProjectionLoad).where(ProjectionLoad.name == NAME).with_for_update()
                             .execution_options(populate_existing=True))).scalar_one()


async def load(rt: Runtime, now: datetime, *, force: bool = False) -> dict[str, Any]:
    settings = cast(Settings, rt.settings)
    async with rt.transaction() as db:
        st = await _state(db)
        if st.completed_at is not None and not force:
            return {"status": "skipped", "items": int(st.items)}
        if force:
            st.cursor, st.items, st.completed_at, st.error = None, 0, None, None
        cursor = st.cursor
    loaded = 0
    for _ in range(MAX_PAGES):
        try:
            items, nxt = await clients.export_profiles(rt, cursor, settings.projection_page_size)
        except Exception as exc:
            log.warning("projection bootstrap source failed", extra={"error_type": type(exc).__name__})
            async with rt.transaction() as db:
                st = await _state(db)
                st.attempted_at, st.error = now, type(exc).__name__[:64]
            return {"status": "failed", "items": loaded}
        for item in items:
            try:
                async with rt.transaction() as db:
                    await learners.on_profile_export(db, item, now)
            except (KeyError, ValueError, TypeError) as exc:
                log.warning("projection bootstrap item skipped", extra={"error_type": type(exc).__name__})
        async with rt.transaction() as db:
            st = await _state(db)
            st.cursor, st.items, st.attempted_at, st.error = nxt, int(st.items) + len(items), now, None
            st.completed_at = now if nxt is None else None
        loaded += len(items)
        if nxt is None:
            return {"status": "completed", "items": loaded}
        cursor = nxt
    return {"status": "failed", "items": loaded}


async def run(rt: Runtime, now: datetime, *, force: bool = False) -> dict[str, Any]:
    assert rt.db is not None
    async with rt.db.engine.connect() as conn:
        got = (await conn.execute(text("SELECT pg_try_advisory_lock(:c, :o)"),
                                  {"c": LOCK_CLASS, "o": _lock_object(rt.db.schema)})).scalar_one()
        await conn.commit()
        if not got:
            return {"skipped": True}
        try:
            return {NAME: await load(rt, now, force=force)}
        finally:
            await conn.execute(text("SELECT pg_advisory_unlock(:c, :o)"),
                               {"c": LOCK_CLASS, "o": _lock_object(rt.db.schema)})
            await conn.commit()


async def run_pending(rt: Runtime, now: datetime) -> int:
    try:
        out = await run(rt, now)
    except Exception as exc:
        log.warning("projection bootstrap failed", extra={"error_type": type(exc).__name__})
        return 0
    item = out.get(NAME)
    return int(item.get("items", 0)) if isinstance(item, dict) and item.get("status") == "completed" else 0


async def on_start(rt: Runtime) -> None:
    async def task() -> None:
        await asyncio.sleep(1.0)
        await run_pending(rt, now_of(rt))

    rt.spawn(task(), "projection-bootstrap")
