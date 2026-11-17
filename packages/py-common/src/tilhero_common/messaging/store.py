"""Transactional outbox и inbox-дедупликация.

- `emit(session, ...)` пишет событие в таблицу outbox в ТОЙ ЖЕ транзакции, что и доменное изменение.
- `OutboxRelay` фоново публикует неотправленные записи в шину (SELECT … FOR UPDATE SKIP LOCKED — безопасно
  при нескольких репликах), с экспоненциальной задержкой при сбоях.
- опубликованные записи старше `retention` (OUTBOX_RETENTION_HOURS, по умолчанию 72 ч) периодически удаляются:
  outbox — не архив событий (минимизация данных, ревью спринта 1 P2);
- `run_with_inbox` выполняет обработчик события ровно один раз на (event_id, consumer) — повторы игнорируются.

Таблицы входят в `messaging_metadata`; Alembic каждого сервиса подключает её в target_metadata.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import Column, DateTime, Integer, MetaData, String, Table, Text, delete, func, select, update
from sqlalchemy.dialects.postgresql import JSONB, UUID, insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.db import Database
from tilhero_common.messaging.bus import EventBus, backoff_seconds
from tilhero_common.messaging.envelope import Envelope, make_envelope

log = logging.getLogger("tilhero.outbox")

messaging_metadata = MetaData()

outbox_table = Table(
    "outbox",
    messaging_metadata,
    Column("id", UUID(as_uuid=False), primary_key=True),
    Column("event_type", String(120), nullable=False),
    Column("envelope", JSONB, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
    Column("published_at", DateTime(timezone=True), nullable=True, index=True),
    Column("attempts", Integer, nullable=False, server_default="0"),
    Column("next_attempt_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
    Column("last_error", Text, nullable=True),
)

inbox_table = Table(
    "inbox",
    messaging_metadata,
    Column("event_id", UUID(as_uuid=False), primary_key=True),
    Column("consumer", String(120), primary_key=True),
    Column("event_type", String(120), nullable=False),
    Column("processed_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
)


async def emit(
    session: AsyncSession,
    event_type: str,
    payload: dict[str, Any],
    *,
    producer: str,
    causation_id: str | None = None,
) -> Envelope:
    envelope = make_envelope(event_type, payload, producer=producer, causation_id=causation_id)
    await session.execute(
        outbox_table.insert().values(
            id=envelope.event_id,
            event_type=envelope.event_type,
            envelope=envelope.model_dump(mode="json"),
        )
    )
    return envelope


class OutboxRelay:
    def __init__(
        self,
        db: Database,
        bus: EventBus,
        *,
        interval_ms: int = 200,
        batch: int = 100,
        publish_timeout: float = 3.0,
        retention: timedelta = timedelta(hours=72),
        cleanup_interval: float = 3600.0,
    ) -> None:
        self.db = db
        self.bus = bus
        self.interval = interval_ms / 1000
        self.batch = batch
        self.publish_timeout = publish_timeout
        self.retention = retention
        self.cleanup_interval = cleanup_interval
        self._task: asyncio.Task | None = None
        self._wake = asyncio.Event()
        self._next_cleanup = 0.0

    def start(self) -> None:
        self._task = asyncio.create_task(self._run(), name="outbox-relay")

    def wake(self) -> None:
        self._wake.set()

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task

    async def _run(self) -> None:
        loop = asyncio.get_running_loop()
        while True:
            try:
                sent = await self.flush_once()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.warning("outbox relay iteration failed", extra={"error_type": type(exc).__name__})
                sent = 0
            if loop.time() >= self._next_cleanup:
                self._next_cleanup = loop.time() + self.cleanup_interval
                try:
                    purged = await self.purge_published()
                    if purged:
                        log.info("outbox purged", extra={"rows": purged})
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    log.warning("outbox purge failed", extra={"error_type": type(exc).__name__})
            if sent < self.batch:
                with contextlib.suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(self._wake.wait(), timeout=self.interval)
                self._wake.clear()

    async def purge_published(self, now: datetime | None = None) -> int:
        """Удаляет опубликованные записи старше retention. Неопубликованные не трогает никогда."""
        cutoff = (now or datetime.now(UTC)) - self.retention
        async with self.db.session() as session:
            result = await session.execute(
                delete(outbox_table)
                .where(outbox_table.c.published_at.is_not(None))
                .where(outbox_table.c.published_at < cutoff)
            )
        return int(result.rowcount or 0)  # type: ignore[attr-defined]

    async def pending(self) -> int:
        """Число неопубликованных записей, срок которых наступил (включая захваченные другой итерацией)."""
        async with self.db.session() as session:
            count = await session.scalar(
                select(func.count())
                .select_from(outbox_table)
                .where(outbox_table.c.published_at.is_(None))
                .where(outbox_table.c.next_attempt_at <= func.now())
            )
        return int(count or 0)

    async def drain(self, wait_seconds: float = 5.0) -> None:
        """Публикует всё, что готово к отправке, и дожидается пачек, захваченных фоновой итерацией.

        flush_once пропускает строки, заблокированные фоновым relay (skip_locked), и может вернуть 0, пока те ещё
        не опубликованы. Для тестов и коротких скриптов: ждём, пока очередь не опустеет (или не выйдет wait_seconds)."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + wait_seconds
        while True:
            while await self.flush_once():
                pass
            if not self.bus.is_connected or await self.pending() == 0 or loop.time() >= deadline:
                return
            await asyncio.sleep(0.02)

    async def flush_once(self) -> int:
        """Публикует одну пачку. Возвращает число успешно опубликованных событий."""
        if not self.bus.is_connected:
            return 0
        sent = 0
        async with self.db.session() as session:
            rows = (
                await session.execute(
                    select(outbox_table.c.id, outbox_table.c.envelope, outbox_table.c.attempts)
                    .where(outbox_table.c.published_at.is_(None))
                    .where(outbox_table.c.next_attempt_at <= func.now())
                    .order_by(outbox_table.c.created_at, outbox_table.c.id)
                    .limit(self.batch)
                    .with_for_update(skip_locked=True)
                )
            ).all()
            for row in rows:
                try:
                    # Таймаут ограничивает удержание блокировок пачки при деградации шины (ревью #14)
                    await asyncio.wait_for(
                        self.bus.publish(Envelope.model_validate(row.envelope)), timeout=self.publish_timeout
                    )
                except Exception as exc:
                    attempts = row.attempts + 1
                    await session.execute(
                        update(outbox_table)
                        .where(outbox_table.c.id == row.id)
                        .values(
                            attempts=attempts,
                            # Тип ошибки без текста: в тексте исключения могут оказаться данные события
                            last_error=type(exc).__name__[:500],
                            next_attempt_at=datetime.now(UTC) + timedelta(seconds=backoff_seconds(attempts)),
                        )
                    )
                    break  # шина недоступна — остальные записи пачки попробуем в следующей итерации
                await session.execute(
                    update(outbox_table).where(outbox_table.c.id == row.id).values(published_at=func.now())
                )
                sent += 1
        return sent


async def run_with_inbox(
    db: Database,
    consumer: str,
    envelope: Envelope,
    handler: Callable[[AsyncSession, Envelope], Awaitable[None]],
) -> bool:
    """Выполняет handler в транзакции вместе с отметкой в inbox. False — событие уже обработано."""
    async with db.session() as session:
        inserted = await session.execute(
            insert(inbox_table)
            .values(event_id=envelope.event_id, consumer=consumer, event_type=envelope.event_type)
            .on_conflict_do_nothing()
            .returning(inbox_table.c.event_id)
        )
        if inserted.first() is None:
            log.info("duplicate event skipped", extra={"consumer": consumer, "event_type": envelope.event_type})
            return False
        await handler(session, envelope)
        return True
