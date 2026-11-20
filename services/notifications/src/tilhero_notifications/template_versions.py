"""Версии шаблонов уведомлений (INTERNAL_API спринта 2 §3, admin.ts «Шаблоны уведомлений»).

- код (templates.py) — тексты по умолчанию; сотрудник создаёт версию (draft) поверх, активирует её (step-up в
  admin-bff), откатывает — активацией любой прежней версии или сбросом к тексту по умолчанию;
- одна активная версия на ключ (частичный уникальный индекс); изменения ключа — под advisory-блокировкой ключа;
- аудит `template.version_created | activated | reset | test_sent` — `admin.audit.recorded.v1` в той же транзакции;
- отрисовка: активная версия из кэша процесса (≤ TEMPLATE_CACHE_TTL_SECONDS, ≤ 30 с); активация и сброс на этой
  реплике сбрасывают кэш сразу — новое уведомление уходит с новым текстом.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
from datetime import UTC, datetime
from functools import lru_cache
from typing import Any, cast

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.app import Runtime
from tilhero_common.errors import ApiError, not_found, unprocessable
from tilhero_common.internal_auth import Actor
from tilhero_notifications import audit
from tilhero_notifications.domain.texts import FieldError, check_texts
from tilhero_notifications.models import TemplateVersion
from tilhero_notifications.settings import Settings
from tilhero_notifications.templates import (
    EDITABLE,
    PLACEHOLDER_DESCRIPTIONS,
    TEMPLATES,
    TemplateSpec,
    TextOverride,
    default_texts,
    public_category,
    sample_values,
)

log = logging.getLogger("tilhero.notifications.template_versions")
LOCK_CLASS = 7_340_105  # advisory-lock'и ключей шаблонов
MAX_VERSIONS_SHOWN = 50


def iso(dt: datetime | None) -> str | None:
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z") if dt is not None else None


def spec_or_404(key: str) -> TemplateSpec:
    spec = TEMPLATES.get(key)
    if spec is None or not spec.editable:  # служебные pin.* не редактируются и не выводятся
        raise not_found("TEMPLATE_NOT_FOUND", "Шаблон не найден")
    return spec


def template_invalid(fields: list[FieldError]) -> ApiError:
    return unprocessable("TEMPLATE_INVALID", "Тексты шаблона не прошли проверку", {"fields": fields})


def check(spec: TemplateSpec, texts: Any) -> list[FieldError]:
    return check_texts(texts, allowed=spec.placeholder_names, kid=spec.kid)


def request_hash(payload: Any) -> str:
    return hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


async def lock_key(session: AsyncSession, key: str) -> None:
    await session.execute(text("SELECT pg_advisory_xact_lock(:c, hashtext(:k))"), {"c": LOCK_CLASS, "k": key})


# ---------------------------------------------------------------- представления (admin.ts)


@lru_cache(maxsize=64)
def _defaults(key: str) -> dict[str, dict[str, str | None]]:
    return default_texts(TEMPLATES[key])


def placeholders_view(spec: TemplateSpec) -> list[dict[str, Any]]:
    ru, uz = sample_values(spec, "ru"), sample_values(spec, "uz")
    return [
        {
            "name": name,
            "description": {"ru": PLACEHOLDER_DESCRIPTIONS[name][0], "en": PLACEHOLDER_DESCRIPTIONS[name][1]},
            "sample": {"ru": ru[name], "uz": uz[name]},
        }
        for name in spec.placeholder_names
    ]


def version_view(row: TemplateVersion) -> dict[str, Any]:
    return {
        "key": row.key,
        "version": row.version,
        "status": row.status,
        "texts": row.texts,
        "note": row.note,
        "created_by": row.created_by,
        "created_by_name": None,  # имена сотрудников добавляет admin-bff (staff/lookup)
        "created_at": iso(row.created_at),
        "activated_by": row.activated_by,
        "activated_by_name": None,
        "activated_at": iso(row.activated_at),
    }


def info_view(spec: TemplateSpec, active: TemplateVersion | None, updated_at: datetime | None) -> dict[str, Any]:
    return {
        "key": spec.name,
        "category": public_category(spec.category),  # game (спринт 6) — как reminders, см. templates
        "kid": spec.kid,
        "description": {"ru": spec.description[0], "en": spec.description[1]},
        "placeholders": placeholders_view(spec),
        "default_texts": _defaults(spec.name),
        "active_version": active.version if active is not None else None,
        "active_since": iso(active.activated_at) if active is not None else None,
        "updated_at": iso(updated_at),
    }


async def _active(session: AsyncSession, keys: list[str] | None = None) -> dict[str, TemplateVersion]:
    stmt = select(TemplateVersion).where(TemplateVersion.status == "active")
    if keys is not None:
        stmt = stmt.where(TemplateVersion.key.in_(keys))
    return {row.key: row for row in (await session.execute(stmt)).scalars().all()}


async def _updated(session: AsyncSession, keys: list[str] | None = None) -> dict[str, datetime]:
    last = func.max(
        func.greatest(
            TemplateVersion.created_at,
            func.coalesce(TemplateVersion.activated_at, TemplateVersion.created_at),
            func.coalesce(TemplateVersion.archived_at, TemplateVersion.created_at),
        )
    )
    stmt = select(TemplateVersion.key, last).group_by(TemplateVersion.key)
    if keys is not None:
        stmt = stmt.where(TemplateVersion.key.in_(keys))
    return {key: value for key, value in (await session.execute(stmt)).all()}


async def list_infos(session: AsyncSession) -> list[dict[str, Any]]:
    active, updated = await _active(session), await _updated(session)
    return [info_view(TEMPLATES[key], active.get(key), updated.get(key)) for key in EDITABLE]


async def get_info(session: AsyncSession, spec: TemplateSpec, *, with_versions: bool = True) -> dict[str, Any]:
    active = (await _active(session, [spec.name])).get(spec.name)
    updated = (await _updated(session, [spec.name])).get(spec.name)
    out = info_view(spec, active, updated)
    if with_versions:
        rows = (
            await session.execute(
                select(TemplateVersion)
                .where(TemplateVersion.key == spec.name)
                .order_by(TemplateVersion.version.desc())
                .limit(MAX_VERSIONS_SHOWN)
            )
        ).scalars().all()
        out["versions"] = [version_view(r) for r in rows]
    return out


async def get_version(
    session: AsyncSession, key: str, version: int, *, for_update: bool = False
) -> TemplateVersion:
    stmt = select(TemplateVersion).where(TemplateVersion.key == key, TemplateVersion.version == version)
    if for_update:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    row = (await session.execute(stmt)).scalar_one_or_none()
    if row is None:
        raise not_found("TEMPLATE_VERSION_NOT_FOUND", "Версия шаблона не найдена")
    return row


# ---------------------------------------------------------------- команды сотрудников


async def find_by_idempotency(session: AsyncSession, actor_id: str, key: str) -> TemplateVersion | None:
    return (
        await session.execute(
            select(TemplateVersion).where(
                TemplateVersion.created_by == actor_id, TemplateVersion.idempotency_key == key
            )
        )
    ).scalar_one_or_none()


async def create_version(
    session: AsyncSession,
    spec: TemplateSpec,
    *,
    texts: dict[str, Any],
    note: str,
    actor: Actor,
    idempotency_key: str | None,
    fingerprint: str,
    now: datetime,
) -> tuple[TemplateVersion, bool]:
    """→ (версия, replay). Повтор с тем же Idempotency-Key и телом — та же версия; другое тело — 422."""
    await lock_key(session, spec.name)
    if idempotency_key is not None:
        existing = await find_by_idempotency(session, actor.id, idempotency_key)
        if existing is not None:
            if existing.request_hash != fingerprint:
                raise unprocessable(
                    "IDEMPOTENCY_KEY_REUSED", "Ключ идемпотентности уже использован с другими данными"
                )
            return existing, True
    number = (
        await session.execute(
            select(func.coalesce(func.max(TemplateVersion.version), 0)).where(TemplateVersion.key == spec.name)
        )
    ).scalar_one()
    row = TemplateVersion(
        key=spec.name,
        version=int(number) + 1,
        status="draft",
        texts=texts,
        note=note,
        created_by=actor.id[:64],
        created_at=now,
        idempotency_key=idempotency_key,
        request_hash=fingerprint if idempotency_key is not None else None,
    )
    session.add(row)
    await session.flush()
    await audit.emit_audit(
        session,
        audit.record(
            "template.version_created",
            audit.TEMPLATE,
            spec.name,
            actor=actor,
            after={"key": spec.name, "version": row.version, "status": "draft"},
            reason=note,
            now=now,
        ),
    )
    return row, False


async def activate(
    session: AsyncSession, spec: TemplateSpec, version: int, *, reason: str, actor: Actor, now: datetime
) -> tuple[TemplateVersion, bool]:
    """→ (версия, изменилась ли). Уже активна — без изменений и без аудита. Прежняя активная → archived."""
    await lock_key(session, spec.name)
    row = await get_version(session, spec.name, version, for_update=True)
    if row.status == "active":
        return row, False
    errors = check(spec, row.texts)  # правила могли измениться после сохранения версии
    if errors:
        raise template_invalid(errors)
    current = (await _active(session, [spec.name])).get(spec.name)
    if current is not None:
        current.status = "archived"
        current.archived_at = now
        await session.flush()  # частичный уникальный индекс: сначала снять прежнюю активную
    row.status = "active"
    row.activated_by = actor.id[:64]
    row.activated_at = now
    row.archived_at = None
    await session.flush()
    await audit.emit_audit(
        session,
        audit.record(
            "template.activated",
            audit.TEMPLATE,
            spec.name,
            actor=actor,
            before={"active_version": current.version if current is not None else None},
            after={"active_version": row.version},
            reason=reason,
            now=now,
        ),
    )
    return row, True


async def reset(
    session: AsyncSession, spec: TemplateSpec, *, reason: str, actor: Actor, now: datetime
) -> bool:
    """Сброс к тексту по умолчанию: активная версия → archived. Нет активной — без изменений и без аудита."""
    await lock_key(session, spec.name)
    current = (await _active(session, [spec.name])).get(spec.name)
    if current is None:
        return False
    current.status = "archived"
    current.archived_at = now
    await session.flush()
    await audit.emit_audit(
        session,
        audit.record(
            "template.reset",
            audit.TEMPLATE,
            spec.name,
            actor=actor,
            before={"active_version": current.version},
            after={"active_version": None},
            reason=reason,
            now=now,
        ),
    )
    return True


# ---------------------------------------------------------------- активные версии для отрисовки


class ActiveTemplates:
    """Кэш активных версий в процессе: одна выборка на все ключи раз в TTL (≤ 30 с). Сбой БД — исключение
    (вызывающий отрисует текст из кода)."""

    def __init__(self, runtime: Runtime) -> None:
        self.rt = runtime
        self._data: dict[str, TextOverride] | None = None
        self._loaded_at = 0.0

    @property
    def ttl(self) -> float:
        return cast(Settings, self.rt.settings).template_cache_ttl_seconds

    def invalidate(self) -> None:
        self._data = None

    async def get(self, key: str) -> TextOverride | None:
        data = self._data
        if data is None or time.monotonic() - self._loaded_at >= self.ttl:
            data = await self._load()
        return data.get(key)

    async def _load(self) -> dict[str, TextOverride]:
        async with self.rt.transaction() as session:
            rows = (
                await session.execute(
                    select(TemplateVersion.key, TemplateVersion.version, TemplateVersion.texts).where(
                        TemplateVersion.status == "active"
                    )
                )
            ).all()
        data = {key: TextOverride(key=key, version=int(version), texts=texts) for key, version, texts in rows}
        self._data, self._loaded_at = data, time.monotonic()
        return data
