"""Курсорная сверка read-модели с источниками: identity-consent (профиль) и learning-plan (план и график).

Зачем: события не несут имя/username/маску (identity-consent), уровень и пресет графика (learning-plan), а ученики,
созданные до появления user-admin, событий в потоке могут не иметь (JetStream хранит 7 дней). Прогон:
`GET <источник>?updated_after=&cursor=&limit=` постранично по возрастанию (updated_at, user_id); водяной знак
(max updated_at применённых снимков) сохраняется в `reconcile_state` после каждой страницы, следующий прогон берёт окно
с перекрытием `reconcile_overlap_seconds` (транзакция источника могла зафиксироваться позже).

Запуск — фоновые задачи Runtime: сразу при старте, затем каждые `reconcile_interval_seconds` (10 мин), досрочно — после
событий, которым не хватает данных источника (не чаще `reconcile_min_gap_seconds`), и по `POST /internal/v1/reconcile`
(n8n). Сбой источника не роняет сервис и не влияет на readiness: тип ошибки — в лог и в reconcile_state.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, cast

from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.app import Runtime
from tilhero_user_admin.domain.projection import apply_plan_snapshot, apply_snapshot
from tilhero_user_admin.models import ReconcileState
from tilhero_user_admin.schemas import IdentitySnapshot, PlanSnapshot, SourceSnapshot
from tilhero_user_admin.settings import Settings

log = logging.getLogger("tilhero.user_admin.sync")

IDENTITY_CLIENT = "identity-consent"
PLANS_CLIENT = "learning-plan"


def utcnow() -> datetime:
    return datetime.now(UTC)


@dataclass(frozen=True)
class Source:
    name: str  # ключ reconcile_state
    client: str  # имя клиента Runtime = aud внутреннего JWT
    path: str
    model: type[SourceSnapshot]
    apply: Callable[[AsyncSession, Any, datetime], Awaitable[Any]]


async def _apply_identity(session: AsyncSession, snap: Any, read_at: datetime) -> Any:
    return await apply_snapshot(session, cast(IdentitySnapshot, snap), read_at=read_at)


async def _apply_plan(session: AsyncSession, snap: Any, read_at: datetime) -> Any:
    return await apply_plan_snapshot(session, cast(PlanSnapshot, snap), read_at=read_at)


IDENTITY_SOURCE = Source("identity", IDENTITY_CLIENT, "/admin/v1/users", IdentitySnapshot, _apply_identity)
PLANS_SOURCE = Source("plans", PLANS_CLIENT, "/admin/v1/plans", PlanSnapshot, _apply_plan)


class SourceSync:
    def __init__(self, runtime: Runtime, source: Source) -> None:
        self.rt = runtime
        self.source = source
        self._wake = asyncio.Event()
        self._lock = asyncio.Lock()

    @property
    def settings(self) -> Settings:
        return cast(Settings, self.rt.settings)

    def wake(self) -> None:
        """Досрочный прогон (данных, которых нет в событии)."""
        self._wake.set()

    async def _state(self) -> ReconcileState | None:
        async with self.rt.transaction() as session:
            return await session.get(ReconcileState, self.source.name)

    async def _save(self, **values: Any) -> None:
        async with self.rt.transaction() as session:
            state = await session.get(ReconcileState, self.source.name, with_for_update=True)
            if state is None:
                state = ReconcileState(name=self.source.name, synced_total=0)
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
            updated_after = watermark - timedelta(seconds=s.reconcile_overlap_seconds) if watermark else None
            await self._save(last_run_at=utcnow())
            client = self.rt.client(self.source.client)
            cursor: str | None = None
            applied = 0
            while True:
                params: dict[str, Any] = {"limit": s.reconcile_page_size}
                if updated_after is not None:
                    params["updated_after"] = updated_after.isoformat()
                if cursor:
                    params["cursor"] = cursor
                page = await client.get(self.source.path, params=params)
                items = (page or {}).get("items") or []
                read_at = utcnow()
                page_max: datetime | None = None
                async with self.rt.transaction() as session:
                    for item in items:
                        try:
                            snap = self.source.model.model_validate(item)
                        except ValidationError:
                            log.warning("snapshot skipped: invalid shape", extra={"source": self.source.name})
                            continue
                        await self.source.apply(session, snap, read_at)
                        applied += 1
                        page_max = max(page_max, snap.updated_at) if page_max else snap.updated_at
                await self._save(watermark=page_max, synced=len(items))
                cursor = (page or {}).get("next_cursor")
                if not cursor:
                    break
            await self._save(last_success_at=utcnow(), last_error=None)
            return applied

    async def run_safe(self) -> tuple[int, str | None]:
        """Прогон без исключений наружу: → (применено, тип ошибки | None); ошибка — в лог и reconcile_state."""
        try:
            applied = await self.run_once()
            log.info("reconcile completed", extra={"source": self.source.name, "applied": applied})
            return applied, None
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            error = type(exc).__name__[:64]
            log.warning("reconcile failed", extra={"source": self.source.name, "error_type": error})
            try:
                await self._save(last_error_at=utcnow(), last_error=error)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.warning("reconcile state not saved", extra={"source": self.source.name})
            return 0, error

    async def run_forever(self) -> None:
        s = self.settings
        while True:
            await self.run_safe()
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=s.reconcile_interval_seconds)
            except TimeoutError:
                pass
            self._wake.clear()
            await asyncio.sleep(s.reconcile_min_gap_seconds)


class Reconciler:
    """Обе сверки сервиса: identity-consent и learning-plan."""

    def __init__(self, runtime: Runtime) -> None:
        self.identity = SourceSync(runtime, IDENTITY_SOURCE)
        self.plans = SourceSync(runtime, PLANS_SOURCE)

    def start(self, rt: Runtime) -> None:
        rt.spawn(self.identity.run_forever(), "reconcile-identity")
        rt.spawn(self.plans.run_forever(), "reconcile-plans")

    async def run_all(self) -> dict[str, tuple[int, str | None]]:
        identity, plans = await asyncio.gather(self.identity.run_safe(), self.plans.run_safe())
        return {"identity": identity, "plans": plans}
