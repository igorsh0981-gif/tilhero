"""Версии конфигурации, активации и откат. События — через outbox в той же транзакции.

Активации приложения сериализуются pg_advisory_xact_lock(app): «текущая» читается и пишется атомарно,
две параллельные публикации не получат одинаковый previous_version.
"""

from __future__ import annotations

import base64
import uuid
from datetime import UTC, datetime
from typing import Any, Literal, cast

from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common import context
from tilhero_common.errors import ApiError, conflict, not_found
from tilhero_common.internal_auth import Actor
from tilhero_common.messaging import emit
from tilhero_experience.domain.payload import checksum, validate_payload
from tilhero_experience.models import Activation, ConfigVersion
from tilhero_experience.schemas import ActivationOut, VersionDetail, VersionSummary

PRODUCER = "experience-config"
ACTIVATED_EVENT = "experience.config.activated.v1"
AUDIT_EVENT = "admin.audit.recorded.v1"
OBJECT_TYPE = "experience_config"
_LOCK_CLASS = 0x45585043  # 'EXPC'
_APP_LOCK = {"miniapp": 1, "admin": 2}


# ---------------------------------------------------------------- представления


Status = Literal["current", "previous"] | None


def version_summary(v: ConfigVersion, status: Status = None) -> VersionSummary:
    return VersionSummary(version_id=v.id, app=v.app, version=v.version, checksum=v.checksum,
                          change_note=v.change_note, created_by=v.created_by, created_at=v.created_at,
                          status=status)


def version_detail(v: ConfigVersion, status: Status = None) -> VersionDetail:
    return VersionDetail(**version_summary(v, status).model_dump(), payload=v.payload)


def activation_out(a: Activation) -> ActivationOut:
    return ActivationOut(activation_id=a.id, app=a.app, version=a.version,
                         previous_version=a.previous_version,
                         kind=cast(Literal["activate", "rollback"], a.kind), reason=a.reason,
                         activated_by=a.activated_by, activated_at=a.activated_at)


def encode_cursor(seq: int) -> str:
    return base64.urlsafe_b64encode(str(seq).encode()).decode()


def decode_cursor(cursor: str) -> int:
    return int(base64.urlsafe_b64decode(cursor.encode()).decode())


# ---------------------------------------------------------------- чтение


async def current_activation(session: AsyncSession, app: str) -> Activation | None:
    stmt = select(Activation).where(Activation.app == app).order_by(Activation.seq.desc()).limit(1)
    return (await session.execute(stmt)).scalar_one_or_none()


async def get_version(session: AsyncSession, app: str, version: str) -> ConfigVersion | None:
    stmt = select(ConfigVersion).where(ConfigVersion.app == app, ConfigVersion.version == version)
    return (await session.execute(stmt)).scalar_one_or_none()


def public_config(app: str, v: ConfigVersion) -> dict[str, Any]:
    """Ответ GET current: payload + app/version (для miniapp — ExperienceConfig из bff.ts)."""
    return {"app": app, "version": v.version, **v.payload}


async def current_config(session: AsyncSession, app: str) -> tuple[int, dict[str, Any]] | None:
    """(seq текущей активации, конфигурация) — seq нужен кэшу, чтобы не затереть новое старым."""
    act = await current_activation(session, app)
    if act is None:
        return None
    v = await get_version(session, app, act.version)
    return (act.seq, public_config(app, v)) if v is not None else None


def version_not_found(version: str) -> ApiError:
    return not_found("EXPERIENCE_VERSION_NOT_FOUND", f"Версия конфигурации {version} не найдена")


def config_not_found() -> ApiError:
    return not_found("EXPERIENCE_CONFIG_NOT_FOUND", "Активная конфигурация не найдена")


# ---------------------------------------------------------------- команды


def _audit(actor: Actor, action: str, app: str, version: str, before: dict | None, after: dict | None,
           reason: str) -> dict[str, Any]:
    """Payload admin.audit.recorded.v1 = запись журнала (RecordIn audit-service)."""
    return {
        "record_id": str(uuid.uuid4()),
        "occurred_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "actor_type": "staff",
        "actor_id": actor.id[:64],
        "actor_role": actor.role[:64],
        "action": action,
        "object_type": OBJECT_TYPE,
        "object_id": f"{app}@{version}",
        "before": before,
        "after": after,
        "reason": reason,
        "trace_id": context.get_trace_id()[:64],
    }


async def _lock_app(session: AsyncSession, app: str) -> None:
    await session.execute(text("SELECT pg_advisory_xact_lock(:c, :o)"),
                          {"c": _LOCK_CLASS, "o": _APP_LOCK[app]})


async def create_version(session: AsyncSession, app: str, version: str, raw_payload: Any, change_note: str,
                         actor: Actor) -> tuple[ConfigVersion, bool]:
    """Создаёт неизменяемую версию. Повтор с тем же содержимым — тот же результат (created=False);
    та же версия с другим содержимым — 409 EXPERIENCE_VERSION_EXISTS."""
    payload = validate_payload(app, raw_payload)
    digest = checksum(payload)
    existing = await get_version(session, app, version)
    if existing is None:
        stmt = insert(ConfigVersion).values(
            id=uuid.uuid4(), app=app, version=version, payload=payload, checksum=digest,
            change_note=change_note, created_by=actor.id[:64],
        ).on_conflict_do_nothing(index_elements=["app", "version"]).returning(ConfigVersion.id)
        inserted = (await session.execute(stmt)).scalar_one_or_none()
        existing = await get_version(session, app, version)
        assert existing is not None
        if inserted is not None:
            await emit(session, AUDIT_EVENT,
                       _audit(actor, "config.create", app, version, None,
                              {"version": version, "checksum": digest}, change_note),
                       producer=PRODUCER)
            return existing, True
    if existing.checksum != digest or existing.change_note != change_note:
        raise conflict("EXPERIENCE_VERSION_EXISTS",
                       f"Версия {version} уже существует и не может быть изменена",
                       {"version": version, "checksum": existing.checksum})
    return existing, False


async def _record_activation(session: AsyncSession, app: str, version: str, previous: str | None, kind: str,
                             reason: str, actor: Actor) -> Activation:
    act = Activation(id=uuid.uuid4(), app=app, version=version, previous_version=previous, kind=kind,
                     reason=reason, activated_by=actor.id[:64], activated_at=datetime.now(UTC))
    session.add(act)
    await session.flush()
    await emit(session, ACTIVATED_EVENT,
               {"app": app, "version": version, "previous_version": previous, "activation_id": str(act.id)},
               producer=PRODUCER)
    action = "config.rollback" if kind == "rollback" else "config.publish"
    await emit(session, AUDIT_EVENT,
               _audit(actor, action, app, version, {"version": previous} if previous else None,
                      {"version": version, "activation_id": str(act.id)}, reason),
               producer=PRODUCER)
    return act


async def activate(session: AsyncSession, app: str, version: str, reason: str,
                   actor: Actor) -> tuple[Activation, bool]:
    """Публикация версии. Если она уже текущая — no-op (возвращается текущая активация, created=False)."""
    await _lock_app(session, app)
    if await get_version(session, app, version) is None:
        raise version_not_found(version)
    cur = await current_activation(session, app)
    if cur is not None and cur.version == version:
        return cur, False
    previous = cur.version if cur else None
    act = await _record_activation(session, app, version, previous, "activate", reason, actor)
    return act, True


async def rollback(session: AsyncSession, app: str, reason: str, actor: Actor) -> Activation:
    """Откат = новая активация previous-версии; повторный откат возвращает обратно (previous ↔ current)."""
    await _lock_app(session, app)
    cur = await current_activation(session, app)
    if cur is None:
        raise config_not_found()
    if cur.previous_version is None:
        raise conflict("EXPERIENCE_NO_PREVIOUS", "Нет предыдущей версии для отката",
                       {"current_version": cur.version})
    return await _record_activation(session, app, cur.previous_version, cur.version, "rollback", reason,
                                    actor)
