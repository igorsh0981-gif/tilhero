"""Курсорная сверка read-модели с источниками: identity-consent (профиль) и learning-plan (план и график).

Зачем: события не несут имя/username/маску (identity-consent), а ученики, созданные до появления user-admin, событий в
потоке могут не иметь (JetStream хранит 7 дней). Прогон: `GET <источник>?updated_after=&cursor=&limit=` постранично
по возрастанию (updated_at, user_id); водяной знак (max updated_at применённых снимков) сохраняется в `reconcile_state`
после каждой страницы, следующий прогон берёт окно с перекрытием `reconcile_overlap_seconds` (транзакция источника
могла зафиксироваться позже).

Один прогон источника за раз во всём сервисе (ревью P2-6): на всё время прохода берётся сессионная advisory-блокировка
(`pg_try_advisory_lock`, ключ — схема + источник) на выделенном соединении; на нём же идут транзакции страниц и запись
состояния — прогон занимает одно соединение пула. Прогон уже идёт (в этом процессе или на другой реплике) — новый не
ждёт и сразу возвращает «пропущен» (None): повтор n8n по таймауту не копит ожидающих. Страница применяется пачкой
(projection.apply_snapshots / apply_plan_snapshots), по умолчанию 200 снимков.

Запуск — фоновые задачи Runtime: сразу при старте, затем каждые `reconcile_interval_seconds` (10 мин), досрочно — после
событий, которым не хватает данных источника (не чаще `reconcile_min_gap_seconds`), и по `POST /internal/v1/reconcile`
(n8n). Сбой источника не роняет сервис и не влияет на readiness: тип ошибки — в лог и в reconcile_state.
"""

from __future__ import annotations

import asyncio
import logging
import zlib
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Final, cast

from pydantic import ValidationError
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncSession

from tilhero_common.app import Runtime
from tilhero_user_admin.domain.projection import apply_plan_snapshots, apply_snapshots
from tilhero_user_admin.models import ReconcileState
from tilhero_user_admin.schemas import IdentitySnapshot, PlanSnapshot, SourceSnapshot
from tilhero_user_admin.settings import Settings

log = logging.getLogger("tilhero.user_admin.sync")

IDENTITY_CLIENT = "identity-consent"
PLANS_CLIENT = "learning-plan"
# пространство advisory-ключей сверки user-admin; объект — от схемы и источника (схемы тестов в одной БД не мешают)
RECONCILE_LOCK_CLASS: Final = 0x55415243  # 'UARC'


def utcnow() -> datetime:
    return datetime.now(UTC)


def lock_object(schema: str | None, source: str) -> int:
    return int.from_bytes(zlib.crc32(f"{schema or ''}:{source}".encode()).to_bytes(4, "big"), "big", signed=True)


@dataclass(frozen=True)
class Source:
    name: str  # ключ reconcile_state
    client: str  # имя клиента Runtime = aud внутреннего JWT
    path: str
    model: type[SourceSnapshot]
    apply_page: Callable[[AsyncSession, list[Any], datetime], Awaitable[Any]]


async def _apply_identity(session: AsyncSession, snaps: list[Any], read_at: datetime) -> Any:
    return await apply_snapshots(session, cast(list[IdentitySnapshot], snaps), read_at=read_at)


async def _apply_plans(session: AsyncSession, snaps: list[Any], read_at: datetime) -> Any:
    return await apply_plan_snapshots(session, cast(list[PlanSnapshot], snaps), read_at=read_at)


IDENTITY_SOURCE = Source("identity", IDENTITY_CLIENT, "/admin/v1/users", IdentitySnapshot, _apply_identity)
PLANS_SOURCE = Source("plans", PLANS_CLIENT, "/admin/v1/plans", PlanSnapshot, _apply_plans)


async def _update_state(session: AsyncSession, name: str, values: dict[str, Any]) -> None:
    state = await session.get(ReconcileState, name, with_for_update=True)
    if state is None:
        state = ReconcileState(name=name, synced_total=0)
        session.add(state)
    for key, value in values.items():
        if key == "synced":
            state.synced_total = (state.synced_total or 0) + value
        elif key == "watermark":
            if value is not None and (state.watermark is None or value > state.watermark):
                state.watermark = value
        else:
            setattr(state, key, value)


async def _release(conn: AsyncConnection) -> None:
    """Снять сессионную блокировку до возврата соединения в пул. Не вышло (разрыв, отмена) — соединение
    закрывается: блокировка сервера живёт только вместе с его сессией."""
    try:
        if conn.in_transaction():
            await conn.rollback()
        await conn.execute(text("SELECT pg_advisory_unlock_all()"))
        await conn.commit()
    except BaseException:
        await conn.invalidate()
        raise


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

    async def _save(self, **values: Any) -> None:
        async with self.rt.transaction() as session:
            await _update_state(session, self.source.name, values)

    @staticmethod
    def _session(conn: AsyncConnection) -> AsyncSession:
        return AsyncSession(bind=conn, expire_on_commit=False)

    async def _save_on(self, conn: AsyncConnection, **values: Any) -> None:
        async with self._session(conn) as session:
            await _update_state(session, self.source.name, values)
            await session.commit()

    async def run_once(self) -> int | None:
        """Один прогон сверки. → число применённых снимков; None — прогон этого источника уже идёт (здесь или на
        другой реплике). Исключения (сбой источника) — наружу."""
        if self._lock.locked():
            return None
        async with self._lock:
            assert self.rt.db is not None, "reconcile requires DATABASE_URL"
            async with self.rt.db.engine.connect() as conn:
                got = (await conn.execute(text("SELECT pg_try_advisory_lock(:c, :o)"), {
                    "c": RECONCILE_LOCK_CLASS, "o": lock_object(self.settings.db_schema, self.source.name)})
                ).scalar_one()
                await conn.commit()
                if not got:
                    return None
                try:
                    return await self._run_locked(conn)
                finally:
                    await _release(conn)

    async def _run_locked(self, conn: AsyncConnection) -> int:
        s = self.settings
        async with self._session(conn) as session:
            state = await session.get(ReconcileState, self.source.name)
            watermark = state.watermark if state else None
            await session.commit()
        updated_after = watermark - timedelta(seconds=s.reconcile_overlap_seconds) if watermark else None
        await self._save_on(conn, last_run_at=utcnow())
        client = self.rt.client(self.source.client)
        cursor: str | None = None
        applied = 0
        while True:
            params: dict[str, Any] = {"limit": s.reconcile_page_size}
            if updated_after is not None:
                params["updated_after"] = updated_after.isoformat()
            if cursor:
                params["cursor"] = cursor
            # запрос к источнику — вне транзакции: блокировки строк держатся только на время применения страницы
            page = await client.get(self.source.path, params=params)
            items = (page or {}).get("items") or []
            read_at = utcnow()
            snaps: list[SourceSnapshot] = []
            for item in items:
                try:
                    snaps.append(self.source.model.model_validate(item))
                except ValidationError:
                    log.warning("snapshot skipped: invalid shape", extra={"source": self.source.name})
            page_max = max((snap.updated_at for snap in snaps), default=None)
            async with self._session(conn) as session:
                if snaps:
                    await self.source.apply_page(session, snaps, read_at)
                await _update_state(session, self.source.name, {"watermark": page_max, "synced": len(items)})
                await session.commit()
            applied += len(snaps)
            cursor = (page or {}).get("next_cursor")
            if not cursor:
                break
        await self._save_on(conn, last_success_at=utcnow(), last_error=None)
        return applied

    async def run_safe(self) -> tuple[int | None, str | None]:
        """Прогон без исключений наружу: → (применено | None — пропущен, тип ошибки | None); ошибка — в лог и
        reconcile_state."""
        try:
            applied = await self.run_once()
            if applied is None:
                log.info("reconcile skipped: already running", extra={"source": self.source.name})
            else:
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

    async def run_all(self) -> dict[str, tuple[int | None, str | None]]:
        identity, plans = await asyncio.gather(self.identity.run_safe(), self.plans.run_safe())
        return {"identity": identity, "plans": plans}
