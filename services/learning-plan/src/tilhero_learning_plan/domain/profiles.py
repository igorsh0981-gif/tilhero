"""Команды над профилем предпочтений.

Изменение и событие user.preferences.updated.v1 пишутся в одной транзакции (outbox).

Конкурентность: изменения одного пользователя сериализуются pg_advisory_xact_lock (ключ из user_id), строка
профиля дополнительно блокируется FOR UPDATE. Это же закрывает гонку «PATCH ↔ удаление»: после удаления
профиль не воскрешается (таблица deleted_users проверяется под той же блокировкой).
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import delete, select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.errors import ApiError, conflict
from tilhero_common.messaging import emit
from tilhero_learning_plan.domain import validation as v
from tilhero_learning_plan.models import DeletedUser, PreferenceProfile
from tilhero_learning_plan.schemas import PreferencesOut, PreferencesPatchIn

PRODUCER = "preferences"
UPDATED_EVENT = "user.preferences.updated.v1"
DOMAIN_DELETED_EVENT = "user.domain.deleted.v1"
_LOCK_CLASS = 0x50524546  # 'PREF' — пространство advisory-ключей сервиса

PATCHABLE = (
    "interests",
    "geographies",
    "strong_events_outside_geo",
    "event_formats",
    "budget",
    "search_horizon_months",
    "notification_points_months",
    "flight_prefs",
    "hotel_prefs",
)


def defaults(user_id: uuid.UUID) -> dict[str, Any]:
    """Профиль по умолчанию (INTERNAL_API).

    Города вылета пустые: без действия пользователя город не выбираем (BR-TG-004).
    """
    return {
        "user_id": user_id,
        "interests": {"categories": [], "entities": []},
        "geographies": [],
        "strong_events_outside_geo": False,
        "event_formats": ["offline"],
        "budget": {"currency": "USD", "preset": None, "min": None, "max": None, "custom_amount": None},
        "search_horizon_months": 12,
        "notification_points_months": [3, 6],
        "departures": [],
        "flight_prefs": {"direct": True, "connecting": True, "alternative_departure": True},
        "hotel_prefs": {"rating_min": None, "max_distance_km": None, "min_stars": None},
        "onboarding_completed_at": None,
        "version": 1,
    }


def user_deleted() -> ApiError:
    return ApiError(410, "USER_DELETED", "Профиль удалён по запросу пользователя")


def to_public(p: PreferenceProfile) -> PreferencesOut:
    return PreferencesOut.model_validate({
        "interests": p.interests,
        "geographies": p.geographies,
        "strong_events_outside_geo": p.strong_events_outside_geo,
        "event_formats": p.event_formats,
        "budget": p.budget,
        "search_horizon_months": p.search_horizon_months,
        "notification_points_months": p.notification_points_months,
        "departures": p.departures,
        "flight_prefs": p.flight_prefs,
        "hotel_prefs": p.hotel_prefs,
        "onboarding_completed_at": p.onboarding_completed_at,
        "updated_at": p.updated_at,
        "version": p.version,
    })


async def _lock_user(session: AsyncSession, user_id: uuid.UUID) -> None:
    obj = int.from_bytes(user_id.bytes[:4], "big", signed=True)
    await session.execute(text("SELECT pg_advisory_xact_lock(:c, :o)"), {"c": _LOCK_CLASS, "o": obj})


async def _ensure_not_deleted(session: AsyncSession, user_id: uuid.UUID) -> None:
    if await session.get(DeletedUser, user_id) is not None:
        raise user_deleted()


async def get_or_create(session: AsyncSession, user_id: uuid.UUID) -> PreferenceProfile:
    """Чтение; при первом обращении создаёт профиль по умолчанию."""
    profile = await session.get(PreferenceProfile, user_id)
    if profile is not None:
        return profile
    await _lock_user(session, user_id)
    await _ensure_not_deleted(session, user_id)
    await session.execute(
        insert(PreferenceProfile).values(**defaults(user_id)).on_conflict_do_nothing(index_elements=["user_id"])
    )
    stmt = select(PreferenceProfile).where(PreferenceProfile.user_id == user_id)
    return (await session.execute(stmt)).scalar_one()


async def _load_for_update(session: AsyncSession, user_id: uuid.UUID) -> PreferenceProfile:
    await _lock_user(session, user_id)
    await _ensure_not_deleted(session, user_id)
    await session.execute(
        insert(PreferenceProfile).values(**defaults(user_id)).on_conflict_do_nothing(index_elements=["user_id"])
    )
    stmt = select(PreferenceProfile).where(PreferenceProfile.user_id == user_id).with_for_update()
    return (await session.execute(stmt.execution_options(populate_existing=True))).scalar_one()


async def _commit_change(session: AsyncSession, p: PreferenceProfile, changed: list[str]) -> None:
    p.version += 1
    p.updated_at = datetime.now(UTC)
    await session.flush()
    await emit(
        session,
        UPDATED_EVENT,
        {"user_id": str(p.user_id), "changed_fields": changed,
         "onboarding_completed": p.onboarding_completed_at is not None},
        producer=PRODUCER,
    )


async def apply_patch(session: AsyncSession, user_id: uuid.UUID,
                      patch: PreferencesPatchIn) -> PreferenceProfile:
    """Частичное обновление. Повтор того же PATCH — no-op (версия и события не меняются)."""
    provided = patch.model_fields_set - {"version"}
    for name in provided:
        if getattr(patch, name) is None:
            raise v.PreferencesInvalid(name, "null_not_allowed")

    p = await _load_for_update(session, user_id)
    if patch.version is not None and patch.version != p.version:
        raise conflict("PREFERENCES_VERSION_CONFLICT",
                       "Предпочтения уже изменены в другом окне — обновите данные",
                       {"current_version": p.version})

    # После проверки выше «поле передано» ⇔ «поле не None».
    new: dict[str, Any] = {}
    if patch.interests is not None:
        new["interests"] = v.interests(patch.interests)
    if patch.geographies is not None:
        new["geographies"] = v.geographies(patch.geographies)
    if patch.strong_events_outside_geo is not None:
        new["strong_events_outside_geo"] = patch.strong_events_outside_geo
    if patch.event_formats is not None:
        new["event_formats"] = v.event_formats(list(patch.event_formats))
    if patch.budget is not None:
        new["budget"] = v.budget(patch.budget)
    horizon: int = patch.search_horizon_months or p.search_horizon_months
    if patch.search_horizon_months is not None:
        new["search_horizon_months"] = horizon
    if patch.notification_points_months is not None:
        points = list(patch.notification_points_months)
        new["notification_points_months"] = v.notification_points(points, horizon)
    elif patch.search_horizon_months is not None:
        # Как в прототипе: уменьшение горизонта снимает точки напоминания дальше него.
        new["notification_points_months"] = [x for x in p.notification_points_months if x <= horizon]
    if patch.flight_prefs is not None:
        new["flight_prefs"] = v.flight_prefs(patch.flight_prefs)
    if patch.hotel_prefs is not None:
        new["hotel_prefs"] = v.hotel_prefs(patch.hotel_prefs)

    changed = [name for name in PATCHABLE if name in new and getattr(p, name) != new[name]]
    for name in changed:
        setattr(p, name, new[name])
    if changed:
        await _commit_change(session, p, changed)
    return p


async def set_departures(session: AsyncSession, user_id: uuid.UUID, codes: list[str]) -> PreferenceProfile:
    deps = v.departures(codes)
    p = await _load_for_update(session, user_id)
    if p.departures != deps:
        p.departures = deps
        await _commit_change(session, p, ["departures"])
    return p


async def complete_onboarding(session: AsyncSession, user_id: uuid.UUID) -> PreferenceProfile:
    """Идемпотентно: повторный вызов возвращает исходную отметку времени без нового события."""
    p = await _load_for_update(session, user_id)
    if p.onboarding_completed_at is None:
        p.onboarding_completed_at = datetime.now(UTC)
        await _commit_change(session, p, ["onboarding_completed_at"])
    return p


async def get_release_seen(session: AsyncSession, user_id: uuid.UUID) -> PreferenceProfile:
    """«Что нового» (9.4): чтение отметки; профиль по умолчанию создаётся, как при GET предпочтений."""
    return await get_or_create(session, user_id)


async def mark_release_seen(session: AsyncSession, user_id: uuid.UUID, note_id: uuid.UUID,
                            published_at: datetime) -> PreferenceProfile:
    """Отметка «просмотрено» только движется вперёд: более старая или та же заметка — no-op (идемпотентно, порядок
    запросов с двух устройств не важен). Не правка предпочтений: version, updated_at и события не меняются."""
    p = await _load_for_update(session, user_id)
    current = p.last_seen_release_note_at
    if current is None or published_at > current:
        p.last_seen_release_note_id = note_id
        p.last_seen_release_note_at = published_at
        await session.flush()
    return p


async def delete_user_data(session: AsyncSession, user_id: uuid.UUID, request_id: uuid.UUID,
                           causation_id: str | None) -> None:
    """Физическое удаление профиля (TG-FR-006) + ACK саге. Повторный запрос снова подтверждает удаление."""
    await _lock_user(session, user_id)
    await session.execute(delete(PreferenceProfile).where(PreferenceProfile.user_id == user_id))
    await session.execute(
        insert(DeletedUser).values(user_id=user_id, request_id=request_id).on_conflict_do_nothing(
            index_elements=["user_id"])
    )
    await emit(
        session,
        DOMAIN_DELETED_EVENT,
        {"user_id": str(user_id), "request_id": str(request_id), "domain": "preferences", "mode": "deleted"},
        producer=PRODUCER,
        causation_id=causation_id,
    )
