from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, CheckConstraint, DateTime, Integer, func, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

TS = DateTime(timezone=True)


class Base(DeclarativeBase):
    pass


class PreferenceProfile(Base):
    """Профиль предпочтений (ТЗ «PreferenceProfile»). Один на пользователя; user_id — только из токена.

    version — оптимистическая блокировка: каждая фактическая правка +1 (PATCH с устаревшей version → 409).
    """

    __tablename__ = "preference_profiles"
    # Зеркало ограничений миграций 0001–0003 (вторая линия защиты после валидации в домене)
    __table_args__ = (
        CheckConstraint("version >= 1", name="ck_pref_version"),
        CheckConstraint("search_horizon_months IN (3, 6, 12, 24)", name="ck_pref_horizon"),
        CheckConstraint("jsonb_typeof(interests) = 'object'", name="ck_pref_interests"),
        CheckConstraint("jsonb_typeof(geographies) = 'array'", name="ck_pref_geographies"),
        CheckConstraint(
            "jsonb_typeof(event_formats) = 'array' AND jsonb_array_length(event_formats) BETWEEN 1 AND 2",
            name="ck_pref_formats",
        ),
        CheckConstraint("jsonb_typeof(budget) = 'object'", name="ck_pref_budget"),
        CheckConstraint("jsonb_typeof(notification_points_months) = 'array'", name="ck_pref_points"),
        CheckConstraint(
            "jsonb_typeof(departures) = 'array' AND jsonb_array_length(departures) <= 10", name="ck_pref_departures"
        ),
        CheckConstraint("jsonb_typeof(flight_prefs) = 'object'", name="ck_pref_flights"),
        CheckConstraint("jsonb_typeof(hotel_prefs) = 'object'", name="ck_pref_hotel"),  # 0002
        CheckConstraint("(last_seen_release_note_id IS NULL) = (last_seen_release_note_at IS NULL)",
                        name="ck_pref_release_seen"),  # 0003
    )

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    interests: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    geographies: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, nullable=False)
    strong_events_outside_geo: Mapped[bool] = mapped_column(Boolean, nullable=False)
    event_formats: Mapped[list[str]] = mapped_column(JSONB, nullable=False)
    budget: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    search_horizon_months: Mapped[int] = mapped_column(Integer, nullable=False)
    notification_points_months: Mapped[list[int]] = mapped_column(JSONB, nullable=False)
    departures: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, nullable=False)
    flight_prefs: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    # 6.3: оценка гостей / расстояние до площадки / звёзды отеля; null в поле — значение по умолчанию
    hotel_prefs: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default=text(
        """'{"rating_min": null, "max_distance_km": null, "min_stars": null}'::jsonb"""))
    onboarding_completed_at: Mapped[datetime | None] = mapped_column(TS)
    # 9.4 «Что нового»: последняя просмотренная заметка о релизе (experience-config). Не предпочтение: не меняет
    # version/updated_at и не публикует user.preferences.updated.v1; удаляется вместе с профилем (сага удаления).
    last_seen_release_note_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    last_seen_release_note_at: Mapped[datetime | None] = mapped_column(TS)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())


class DeletedUser(Base):
    """Отметка об исполненном удалении (TG-FR-006): запросы, пришедшие после удаления, не воскрешают профиль.

    Хранит только псевдонимный user_id и request_id саги — без персональных данных.
    """

    __tablename__ = "deleted_users"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    request_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    deleted_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())
