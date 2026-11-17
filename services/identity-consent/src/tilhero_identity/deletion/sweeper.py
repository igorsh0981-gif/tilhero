"""Таймер саги удаления (ADR-009, INTERNAL_API §1.3): раз в `DELETION_SWEEP_SECONDS` повторяет запрос неответившим
доменам по расписанию и переводит запросы без полного ACK дольше `DELETION_STUCK_HOURS` в STUCK.

Тик выполняет одна реплика: транзакционный `pg_try_advisory_xact_lock(SWEEP_LOCK)`; остальные пропускают тик. Строки
выбираются `FOR UPDATE SKIP LOCKED` и проверяются под блокировкой, поэтому даже без лидера (две реплики, ручной повтор,
ACK домена в ту же секунду) повтор не уходит дважды за одну точку расписания.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select

from tilhero_common import context
from tilhero_common.app import Runtime
from tilhero_identity.deletion import saga, store
from tilhero_identity.settings import Settings

log = logging.getLogger("tilhero.identity.deletion")

SWEEP_LOCK = 8_101_901  # advisory lock таймера (стабильный ключ сервиса 8101)
BATCH = 200


@dataclass(frozen=True)
class SweepResult:
    leader: bool
    retried: int = 0
    stuck: int = 0


async def sweep_once(rt: Runtime, now: datetime | None = None) -> SweepResult:
    settings: Settings = rt.settings  # type: ignore[assignment]
    now = now or datetime.now(UTC)
    schedule = settings.deletion_retry_schedule
    retried = stuck = 0
    async with rt.transaction() as session:
        if not (await session.execute(select(func.pg_try_advisory_xact_lock(SWEEP_LOCK)))).scalar_one():
            return SweepResult(leader=False)
        stuck_before = now - timedelta(hours=settings.deletion_stuck_hours)
        for req in await store.due_requests(session, now=now, stuck_before=stuck_before, limit=BATCH):
            # своё correlation_id на запрос: повторы одного удаления связаны между собой в логах и событиях
            token = context.correlation_id_var.set(f"deletion-{req.request_id}")
            try:
                if req.next_retry_at is None:
                    # запрос создан кодом спринта 8 (во время раскатки или после отката кода): достраиваем расписание
                    # от первичной рассылки, как миграция 0003 — существующим запросам
                    req.last_sent_at = req.last_sent_at or req.requested_at
                    req.next_retry_at = saga.next_retry_at(req.requested_at, req.last_sent_at, schedule)
                if saga.stuck_due(req.status, req.requested_at, now, settings.deletion_stuck_hours):
                    await store.mark_stuck(session, req, now=now)
                    stuck += 1
                if saga.retry_due(req.status, req.next_retry_at, now):
                    await store.send_retry(session, req, now=now, by=saga.BY_SYSTEM, schedule=schedule)
                    retried += 1
            finally:
                context.correlation_id_var.reset(token)
    return SweepResult(leader=True, retried=retried, stuck=stuck)


async def sweep_loop(rt: Runtime, interval: float) -> None:
    while True:
        await asyncio.sleep(interval)
        try:
            result = await sweep_once(rt)
            if result.leader:
                log.info("deletion sweep ok", extra={"retried": result.retried, "stuck": result.stuck})
        except Exception:
            log.warning("deletion sweep failed", exc_info=True)
