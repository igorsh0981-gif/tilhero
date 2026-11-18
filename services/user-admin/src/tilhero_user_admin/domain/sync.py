"""Курсорная сверка read-модели с identity-consent.

Зачем: события не несут username/имя/last_seen, а пользователи, созданные до появления user-admin, событий в потоке
могут не иметь (JetStream хранит 7 дней). Прогон: `GET identity-consent /admin/v1/users?updated_after=&cursor=`
постранично по возрастанию (updated_at, user_id); водяной знак (max updated_at) сохраняется после каждой страницы,
следующий прогон берёт окно с перекрытием `sync_overlap_seconds` (транзакция источника могла зафиксироваться позже).

Запуск — фоновая задача Runtime: сразу при старте, затем каждые `sync_interval_seconds` и досрочно после
user.profile.created.v1 (не чаще `sync_min_gap_seconds`). Сбой identity-consent не роняет сервис и не влияет на
readiness: ошибка пишется в лог (только тип) и в sync_state, следующий прогон — по расписанию.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from pydantic import ValidationError

from tilhero_common.app import Runtime
from tilhero_user_admin.domain.projection import apply_snapshot
from tilhero_user_admin.models import SyncState
from tilhero_user_admin.schemas import IdentitySnapshot
from tilhero_user_admin.settings import Settings

log = logging.getLogger("tilhero.user_admin.sync")

IDENTITY_CLIENT = "identity-consent"
STATE_NAME = "identity"


def utcnow() -> datetime:
    return datetime.now(UTC)


class IdentitySync:
    def __init__(self, runtime: Runtime) -> None:
        self.rt = runtime
        self._wake = asyncio.Event()
        self._lock = asyncio.Lock()

    @property
    def settings(self) -> Settings:
        return self.rt.settings  # type: ignore[return-value]

    def wake(self) -> None:
        """Досрочный прогон (новый пользователь: username/имя есть только в identity-consent)."""
        self._wake.set()

    async def _state(self) -> SyncState | None:
        async with self.rt.transaction() as session:
            return await session.get(SyncState, STATE_NAME)

    async def _save(self, **values: Any) -> None:
        async with self.rt.transaction() as session:
            state = await session.get(SyncState, STATE_NAME, with_for_update=True)
            if state is None:
                state = SyncState(name=STATE_NAME, synced_total=0)
                session.add(state)
            for key, value in values.items():
                if key == "synced":
                    state.synced_total = (state.synced_total or 0) + value
                elif key == "watermark":
                    if value is not None and (state.watermark is None or value > state.watermark):
                        state.watermark = value
                else:
                    setattr(state, key, value)

    async def run_once(self) -> int:
        """Один прогон сверки. → число применённых снимков. Исключения (сбой источника) — наружу."""
        async with self._lock:
            s = self.settings
            state = await self._state()
            watermark = state.watermark if state else None
            updated_after = watermark - timedelta(seconds=s.sync_overlap_seconds) if watermark else None
            await self._save(last_run_at=utcnow())
            client = self.rt.client(IDENTITY_CLIENT)
            cursor: str | None = None
            applied = 0
            while True:
                params: dict[str, Any] = {"limit": s.sync_page_size}
                if updated_after is not None:
                    params["updated_after"] = updated_after.isoformat()
                if cursor:
                    params["cursor"] = cursor
                page = await client.get("/admin/v1/users", params=params)
                read_at = utcnow()
                page_max: datetime | None = None
                async with self.rt.transaction() as session:
                    for item in page.get("items") or []:
                        try:
                            snap = IdentitySnapshot.model_validate(item)
                        except ValidationError:
                            log.warning("identity snapshot skipped: invalid shape")
                            continue
                        await apply_snapshot(session, snap, read_at=read_at)
                        applied += 1
                        page_max = max(page_max, snap.updated_at) if page_max else snap.updated_at
                await self._save(watermark=page_max, synced=len(page.get("items") or []))
                cursor = page.get("next_cursor")
                if not cursor:
                    break
            await self._save(last_success_at=utcnow(), last_error=None)
            return applied

    async def run_forever(self) -> None:
        s = self.settings
        while True:
            try:
                applied = await self.run_once()
                log.info("identity sync completed", extra={"applied": applied})
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.warning("identity sync failed", extra={"error_type": type(exc).__name__})
                try:
                    await self._save(last_error_at=utcnow(), last_error=type(exc).__name__[:64])
                except asyncio.CancelledError:
                    raise
                except Exception:
                    log.warning("sync state not saved", exc_info=False)
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=s.sync_interval_seconds)
            except TimeoutError:
                pass
            self._wake.clear()
            await asyncio.sleep(s.sync_min_gap_seconds)
