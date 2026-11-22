"""Разовая загрузка проекций (ревью спринта 7, 🔴3; повторное ревью, 🔴 Н1): семьи и дружбы (social), полосы уровня
(diagnostics), возраст и согласие родителя (identity-consent `profiles`) живут в стриме 7 дней — после выкладки
события старше недели не придут. Загрузка читает выгрузки источников
`GET /internal/v1/export/<name>?cursor=&limit=` (элемент — payload соответствующего события; у `profiles` — своя
форма {user_id, kind, age_band, guardian_consent, updated_at}, заполняет пустое или более старое) и пропускает каждый
элемент через тот же обработчик проекции в режиме seed: строка только вставляется, если её нет (более свежее
состояние из событий не перетирается, снятая дружба не возвращается), удалённые ученики пропускаются (DeletedUser —
после блокировки, как у событий).

Отметки — projection_loads (курсор продолжения после сбоя, completed_at). Запуск: в фоне при старте сервиса (если не
завершена), каждым game:tick (повтор после сбоя источника), вручную — POST /internal/v1/projections/bootstrap
(force — заново, безопасно). Одна загрузка за раз — сессионная advisory-блокировка. Сбой источника не роняет сервис:
ошибка (тип) пишется в отметку и лог, загрузка продолжится с курсора следующим запуском.
"""

from __future__ import annotations

import asyncio
import logging
import zlib
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any, Final, cast

from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.app import Runtime
from tilhero_gamification import clients
from tilhero_gamification.domain import projections
from tilhero_gamification.models import ProjectionLoad
from tilhero_gamification.settings import Settings

log = logging.getLogger("tilhero.gamification.bootstrap")

Seed = Callable[..., Awaitable[None]]
SOURCES: Final[dict[str, tuple[str, Seed]]] = {
    "families": (clients.SOCIAL, projections.on_family),
    "friendships": (clients.SOCIAL, projections.on_friendship),
    "levels": (clients.DIAGNOSTICS, projections.on_diagnostics),
    # возраст и согласие родителя (доступ 14–17 к общей лиге) — отдельная форма выгрузки, не payload события
    "profiles": (clients.IDENTITY, projections.on_profile_export),
}
LOCK_CLASS: Final = 0x47414D42  # 'GAMB'
MAX_PAGES: Final = 100_000  # защита от зацикленного курсора источника


def _lock_object(schema: str | None) -> int:
    return int.from_bytes(zlib.crc32((schema or "").encode()).to_bytes(4, "big"), "big", signed=True)


async def _state(db: AsyncSession, name: str) -> ProjectionLoad:
    await db.execute(insert(ProjectionLoad).values(name=name, items=0).on_conflict_do_nothing(
        index_elements=["name"]))
    return (await db.execute(select(ProjectionLoad).where(ProjectionLoad.name == name).with_for_update()
                             .execution_options(populate_existing=True))).scalar_one()


async def load(rt: Runtime, name: str, now: datetime, *, force: bool = False) -> dict[str, Any]:
    """Одна проекция: → {status: completed | skipped | failed, items}."""
    settings = cast(Settings, rt.settings)
    service, handler = SOURCES[name]
    async with rt.transaction() as db:
        st = await _state(db, name)
        if st.completed_at is not None and not force:
            return {"status": "skipped", "items": int(st.items)}
        if force:
            st.cursor, st.items, st.completed_at, st.error = None, 0, None, None
        cursor = st.cursor
    loaded = 0
    for _ in range(MAX_PAGES):
        try:
            items, nxt = await clients.export_page(rt, service, name, cursor, settings.projection_page_size)
        except Exception as exc:
            log.warning("projection bootstrap source failed", extra={"projection": name,
                                                                    "error_type": type(exc).__name__})
            async with rt.transaction() as db:
                st = await _state(db, name)
                st.attempted_at, st.error = now, type(exc).__name__[:64]
            return {"status": "failed", "items": loaded}
        async with rt.transaction() as db:
            for item in items:
                try:
                    async with db.begin_nested():
                        await handler(db, item, now, seed=True)
                except (KeyError, ValueError, TypeError) as exc:  # неверный элемент — пропустить, не ронять загрузку
                    log.warning("projection bootstrap item skipped", extra={"projection": name,
                                                                           "error_type": type(exc).__name__})
            st = await _state(db, name)
            st.cursor, st.items, st.attempted_at, st.error = nxt, int(st.items) + len(items), now, None
            st.completed_at = now if nxt is None else None
        loaded += len(items)
        if nxt is None:
            log.info("projection bootstrap completed", extra={"projection": name, "items": loaded})
            return {"status": "completed", "items": loaded}
        cursor = nxt
    return {"status": "failed", "items": loaded}


async def run(rt: Runtime, now: datetime, *, force: bool = False) -> dict[str, Any]:
    """Все проекции (одна загрузка за раз в схеме сервиса): {name: {status, items}} или {skipped: true}."""
    assert rt.db is not None
    async with rt.db.engine.connect() as conn:
        got = (await conn.execute(text("SELECT pg_try_advisory_lock(:c, :o)"),
                                  {"c": LOCK_CLASS, "o": _lock_object(rt.db.schema)})).scalar_one()
        await conn.commit()
        if not got:
            return {"skipped": True}
        try:
            return {name: await load(rt, name, now, force=force) for name in SOURCES}
        finally:
            await conn.execute(text("SELECT pg_advisory_unlock(:c, :o)"),
                               {"c": LOCK_CLASS, "o": _lock_object(rt.db.schema)})
            await conn.commit()


async def run_pending(rt: Runtime, now: datetime) -> int:
    """Для tick: незавершённые загрузки; → число загруженных элементов (сбой — 0, повтор следующим tick)."""
    try:
        out = await run(rt, now)
    except Exception as exc:
        log.warning("projection bootstrap failed", extra={"error_type": type(exc).__name__})
        return 0
    return sum(int(v.get("items", 0)) for v in out.values() if isinstance(v, dict) and v.get("status") == "completed")


async def on_start(rt: Runtime) -> None:
    """Фоном при старте сервиса: не задерживает готовность, ошибки не роняют процесс."""
    async def task() -> None:
        await asyncio.sleep(1.0)
        clock = getattr(rt, "clock", None)
        await run_pending(rt, clock() if callable(clock) else datetime.now(UTC))

    rt.spawn(task(), "projection-bootstrap")
