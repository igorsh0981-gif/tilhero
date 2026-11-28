"""Модели lessons — зеркало миграций 0001–0004 (UNIQUE, индексы и CHECK объявлены и здесь: тест schema_drift).

user_id везде — ученик (`lrn` внутреннего токена), account_id — аккаунт (`sub`). PII сервис не хранит; тексты
учеников (свободные реплики и открытые ответы) хранятся 90 дней и стираются `lessons-tick` (redacted_at).
"""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKeyConstraint,
    Index,
    Integer,
    Numeric,
    SmallInteger,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy import text as sql_text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

TS = DateTime(timezone=True)
BAND_CHECK = "IN ('A0','A1','A2','B1','B2')"
# спринт 7: + duel — задания дуэли (вне правила одной активной сессии; без ИИ и независимой оценки)
KINDS = ("lesson", "scenario", "media", "review", "reading", "duel")
STATUSES = ("ready", "in_progress", "paused", "completed", "failed", "cancelled")
ACTIVE_STATUSES = ("ready", "in_progress", "paused")
STAGES = ("retrieval", "explanation", "roleplay", "assessment", "summary", "listen", "exercises", "reading",
          "questions")
STEP_TYPES = ("notice", "explanation", "item", "roleplay", "roleplay_end", "listen", "open_answer", "reading", "done")
# спринт 7: deadline — сессия дуэли закрыта по сроку набора или итогу дуэли
HISTORY_REASONS = ("started", "pause", "resume", "auto_pause", "finish", "fail", "cancel", "expired",
                   "content_unpublished", "deadline")
LEVEL_BANDS = ("A0-A1", "A2", "B1+")
DUEL_SET_STATUSES = ("open", "closed", "finished")
ROOM_STATUSES = ("invited", "declined", "expired", "cancelled", "waiting", "in_progress", "paused", "finished",
                 "abandoned", "stopped")
ROOM_ACTIVE = ("invited", "waiting", "in_progress", "paused")
ROOM_ENDED = ("finished", "abandoned", "stopped")
END_REASONS = ("completed", "participant_left", "inactivity", "stopped")
ROOM_EVENT_KINDS = ("joined", "left", "offline", "online", "paused", "resumed", "roles", "coach", "turn",
                    "mode_changed", "finished", "stopped")
SIDES = ("inviter", "invitee")
# спринт 8: почему урок или сценарий идёт без ИИ по тарифу (bff.ts AiLockReason)
AI_LOCK_REASONS = ("no_subscription", "feature_not_in_plan", "minutes_exhausted", "billing_unavailable")


def _in(values: tuple[str, ...]) -> str:
    return "IN (" + ",".join(f"'{v}'" for v in values) + ")"


class Base(DeclarativeBase):
    pass


class Session(Base):
    """Сессия урока, сценария, медиа, повтора или чтения (INTERNAL_API §2.1 спринта 4, §4 спринта 5). Статус меняет
    только сервер (машина состояний domain/machine.py); у ученика не больше одной незавершённой сессии (частичный
    UNIQUE).
    content_versions — версии контента, зафиксированные при старте; plan — этапы и задания (без ключей);
    state — положение в плане и ролевой ситуации."""

    __tablename__ = "sessions"
    __table_args__ = (
        CheckConstraint(f"kind {_in(KINDS)}", name="ck_sessions_kind"),
        CheckConstraint(f"status {_in(STATUSES)}", name="ck_sessions_status"),
        CheckConstraint(f"stage IS NULL OR stage {_in(STAGES)}", name="ck_sessions_stage"),
        CheckConstraint("audience IN ('kids','teens','adults')", name="ck_sessions_audience"),
        CheckConstraint("locale IN ('ru','uz')", name="ck_sessions_locale"),
        CheckConstraint("ai_mode IN ('full','choices')", name="ck_sessions_ai_mode"),
        CheckConstraint("outcome IS NULL OR outcome IN ('success','alt_success','fail')", name="ck_sessions_outcome"),
        CheckConstraint(f"level IS NULL OR level {BAND_CHECK}", name="ck_sessions_level"),
        CheckConstraint("evaluation_status IN ('none','pending','done','failed')", name="ck_sessions_evaluation"),
        CheckConstraint("minutes BETWEEN 0 AND 600", name="ck_sessions_minutes"),
        CheckConstraint("active_seconds >= 0 AND hints_used >= 0 AND step_index >= 0", name="ck_sessions_counters"),
        # спринт 8 (миграция 0004)
        CheckConstraint("ai_active_seconds >= 0", name="ck_sessions_ai_seconds"),
        CheckConstraint(f"ai_lock_reason IS NULL OR ai_lock_reason {_in(AI_LOCK_REASONS)}",
                        name="ck_sessions_ai_lock_reason"),
        CheckConstraint("billable_minutes IS NULL OR billable_minutes BETWEEN 0 AND 240",
                        name="ck_sessions_billable_minutes"),
        CheckConstraint("(kind <> 'lesson' OR lesson_id IS NOT NULL) AND (kind <> 'scenario' OR scenario_id IS NOT "
                        "NULL) AND (kind <> 'media' OR asset_id IS NOT NULL) AND (kind <> 'review' OR "
                        "source_session_id IS NOT NULL) AND (kind <> 'reading' OR reading_id IS NOT NULL) AND "
                        "(kind <> 'duel' OR duel_id IS NOT NULL)",
                        name="ck_sessions_target"),
        UniqueConstraint("user_id", "idempotency_key", name="uq_sessions_user_idempotency"),
        # одна незавершённая сессия на ученика — кроме сессий дуэли (спринт 7, INTERNAL_API §3.1)
        Index("uq_sessions_active", "user_id", unique=True,
              postgresql_where=sql_text("status IN ('ready','in_progress','paused') AND kind <> 'duel'")),
        # одна сессия дуэли на участника
        Index("uq_sessions_duel", "duel_id", "user_id", unique=True, postgresql_where=sql_text("kind = 'duel'")),
        Index("ix_sessions_user_created", "user_id", "created_at"),
        Index("ix_sessions_account", "account_id"),
        Index("ix_sessions_created", "created_at"),
        Index("ix_sessions_status_activity", "status", "last_activity_at"),
        Index("ix_sessions_evaluation_pending", "finished_at",
              postgresql_where=sql_text("evaluation_status = 'pending'")),
        Index("ix_sessions_reading_results", "user_id", "reading_id", "finished_at",
              postgresql_where=sql_text("kind = 'reading' AND status = 'completed'")),
    )

    session_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    account_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    kind: Mapped[str] = mapped_column(String(8), nullable=False)
    pair_id: Mapped[str] = mapped_column(String(16), nullable=False)
    course_id: Mapped[str | None] = mapped_column(String(64))
    lesson_id: Mapped[str | None] = mapped_column(String(64))
    scenario_id: Mapped[str | None] = mapped_column(String(64))
    asset_id: Mapped[str | None] = mapped_column(String(64))
    # спринт 5: текст для чтения (kind reading; миграция 0002)
    reading_id: Mapped[str | None] = mapped_column(String(64))
    # спринт 7: дуэль (kind duel; миграция 0003)
    duel_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    source_session_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    title: Mapped[dict[str, Any]] = mapped_column(JSONB(), nullable=False)
    level: Mapped[str | None] = mapped_column(String(2))
    audience: Mapped[str] = mapped_column(String(8), nullable=False)
    locale: Mapped[str] = mapped_column(String(2), nullable=False, server_default=sql_text("'ru'"))
    ai_mode: Mapped[str] = mapped_column(String(8), nullable=False)
    ai_degraded: Mapped[bool] = mapped_column(Boolean(), nullable=False, server_default=sql_text("false"))
    ai_used: Mapped[bool] = mapped_column(Boolean(), nullable=False, server_default=sql_text("false"))
    hints_used: Mapped[int] = mapped_column(Integer(), nullable=False, server_default=sql_text("0"))
    seed: Mapped[str] = mapped_column(String(64), nullable=False)
    content_versions: Mapped[dict[str, Any]] = mapped_column(JSONB(), nullable=False)
    plan: Mapped[dict[str, Any]] = mapped_column(JSONB(), nullable=False)
    state: Mapped[dict[str, Any]] = mapped_column(JSONB(), nullable=False)
    status: Mapped[str] = mapped_column(String(12), nullable=False)
    stage: Mapped[str | None] = mapped_column(String(16))
    step_index: Mapped[int] = mapped_column(Integer(), nullable=False, server_default=sql_text("0"))
    duration_min: Mapped[int] = mapped_column(SmallInteger(), nullable=False)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(TS)
    paused_at: Mapped[datetime | None] = mapped_column(TS)
    finished_at: Mapped[datetime | None] = mapped_column(TS)
    last_activity_at: Mapped[datetime | None] = mapped_column(TS)
    active_seconds: Mapped[int] = mapped_column(Integer(), nullable=False, server_default=sql_text("0"))
    minutes: Mapped[int] = mapped_column(SmallInteger(), nullable=False, server_default=sql_text("0"))
    outcome: Mapped[str | None] = mapped_column(String(12))
    practice_only: Mapped[bool] = mapped_column(Boolean(), nullable=False, server_default=sql_text("false"))
    evaluation_status: Mapped[str] = mapped_column(String(12), nullable=False, server_default=sql_text("'none'"))
    evaluation_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    evaluation: Mapped[dict[str, Any] | None] = mapped_column(JSONB(none_as_null=True))
    evaluation_attempts: Mapped[int] = mapped_column(SmallInteger(), nullable=False, server_default=sql_text("0"))
    summary: Mapped[dict[str, Any] | None] = mapped_column(JSONB(none_as_null=True))
    fail_reason: Mapped[str | None] = mapped_column(String(32))
    idempotency_key: Mapped[str | None] = mapped_column(String(128))
    request_hash: Mapped[str | None] = mapped_column(String(64))
    # спринт 8 (миграция 0004): ИИ-секунды (in_progress, ai_mode full, без деградации и отказа ИИ), урок без ИИ по
    # тарифу, удержание минут billing при старте, к списанию ⌈ai_active_seconds / 60⌉ ≤ minutes (при завершении)
    ai_active_seconds: Mapped[int] = mapped_column(Integer(), nullable=False, server_default=sql_text("0"))
    ai_lock_reason: Mapped[str | None] = mapped_column(String(24))
    billing_hold_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    billable_minutes: Mapped[int | None] = mapped_column(SmallInteger())


class StatusHistory(Base):
    """История смены статусов (AT-41): append-only (UPDATE запрещён триггером; DELETE — только с сессией в саге)."""

    __tablename__ = "status_history"
    __table_args__ = (
        CheckConstraint(f"from_status IS NULL OR from_status {_in(STATUSES)}", name="ck_status_history_from"),
        CheckConstraint(f"to_status {_in(STATUSES)}", name="ck_status_history_to"),
        CheckConstraint(f"reason {_in(HISTORY_REASONS)}", name="ck_status_history_reason"),
        ForeignKeyConstraint(["session_id"], ["sessions.session_id"], ondelete="CASCADE",
                             name="fk_status_history_session"),
    )

    session_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    seq: Mapped[int] = mapped_column(SmallInteger(), primary_key=True)
    from_status: Mapped[str | None] = mapped_column(String(12))
    to_status: Mapped[str] = mapped_column(String(12), nullable=False)
    reason: Mapped[str] = mapped_column(String(24), nullable=False)
    at: Mapped[datetime] = mapped_column(TS, nullable=False)


class Step(Base):
    """Шаг урока s{n} (INTERNAL_API §2.1): payload — что показано ученику (без ключей), ref — служебная ссылка на
    задание/узел (не уходит наружу), response — feedback/reply ответа для идемпотентного повтора.
    Показанный шаг неизменяем; ответ записывается один раз; после ответа меняется только стирание текста."""

    __tablename__ = "steps"
    __table_args__ = (
        CheckConstraint(f"stage {_in(STAGES)}", name="ck_steps_stage"),
        CheckConstraint(f"type {_in(STEP_TYPES)}", name="ck_steps_type"),
        CheckConstraint("result IS NULL OR result IN ('correct','incorrect','skipped')", name="ck_steps_result"),
        CheckConstraint("hints >= 0", name="ck_steps_hints"),
        CheckConstraint("(answered_at IS NULL) = (response IS NULL)", name="ck_steps_answered"),
        ForeignKeyConstraint(["session_id"], ["sessions.session_id"], ondelete="CASCADE", name="fk_steps_session"),
        UniqueConstraint("session_id", "step_id", name="uq_steps_session_step"),
    )

    session_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    seq: Mapped[int] = mapped_column(Integer(), primary_key=True)
    step_id: Mapped[str] = mapped_column(String(8), nullable=False)
    stage: Mapped[str] = mapped_column(String(16), nullable=False)
    type: Mapped[str] = mapped_column(String(16), nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB(), nullable=False)
    ref: Mapped[dict[str, Any]] = mapped_column(JSONB(), nullable=False)
    answer: Mapped[Any] = mapped_column(JSONB(none_as_null=True), nullable=True)
    result: Mapped[str | None] = mapped_column(String(12))
    hints: Mapped[int] = mapped_column(SmallInteger(), nullable=False, server_default=sql_text("0"))
    response: Mapped[dict[str, Any] | None] = mapped_column(JSONB(none_as_null=True))
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    answered_at: Mapped[datetime | None] = mapped_column(TS)
    redacted_at: Mapped[datetime | None] = mapped_column(TS)


class Turn(Base):
    """Реплика ролевой ситуации T{n}: ученик (выбор или свободный текст) или персонаж (реплика графа или ИИ).
    Текст свободных реплик стирается через 90 дней (redacted_at); остальные поля неизменяемы (триггер)."""

    __tablename__ = "turns"
    __table_args__ = (
        CheckConstraint("speaker IN ('learner','character')", name="ck_turns_speaker"),
        CheckConstraint("mode IN ('choice','text')", name="ck_turns_mode"),
        CheckConstraint("attempt IN (1, 2)", name="ck_turns_attempt"),
        CheckConstraint("text IS NOT NULL OR redacted_at IS NOT NULL", name="ck_turns_text"),
        ForeignKeyConstraint(["session_id"], ["sessions.session_id"], ondelete="CASCADE", name="fk_turns_session"),
        UniqueConstraint("session_id", "turn_id", name="uq_turns_session_turn"),
        Index("ix_turns_redact", "created_at", postgresql_where=sql_text("mode = 'text' AND redacted_at IS NULL")),
    )

    session_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    seq: Mapped[int] = mapped_column(Integer(), primary_key=True)
    turn_id: Mapped[str] = mapped_column(String(8), nullable=False)
    step_seq: Mapped[int] = mapped_column(Integer(), nullable=False)
    attempt: Mapped[int] = mapped_column(SmallInteger(), nullable=False)
    node_id: Mapped[str] = mapped_column(String(64), nullable=False)
    speaker: Mapped[str] = mapped_column(String(10), nullable=False)
    character_id: Mapped[str | None] = mapped_column(String(64))
    mode: Mapped[str] = mapped_column(String(8), nullable=False)
    text: Mapped[str | None] = mapped_column(String(500))
    intent: Mapped[str | None] = mapped_column(String(64))
    hinted: Mapped[bool] = mapped_column(Boolean(), nullable=False, server_default=sql_text("false"))
    ai_call_id: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    redacted_at: Mapped[datetime | None] = mapped_column(TS)


class ReviewItem(Base):
    """Очередь повторения до спринта 5 (memory): задание урока с ошибкой или подсказкой возвращается в этапе
    «повторение» после due_at. На (ученик, пара, урок, задание) — одна нерешённая запись."""

    __tablename__ = "review_items"
    __table_args__ = (
        CheckConstraint("reason IN ('wrong','hinted')", name="ck_review_items_reason"),
        CheckConstraint("lesson_version >= 1", name="ck_review_items_version"),
        Index("uq_review_items_open", "user_id", "pair_id", "lesson_id", "item_id", unique=True,
              postgresql_where=sql_text("resolved_at IS NULL")),
        Index("ix_review_items_due", "user_id", "pair_id", "due_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    pair_id: Mapped[str] = mapped_column(String(16), nullable=False)
    lesson_id: Mapped[str] = mapped_column(String(64), nullable=False)
    lesson_version: Mapped[int] = mapped_column(Integer(), nullable=False)
    item_id: Mapped[str] = mapped_column(String(64), nullable=False)
    skill_id: Mapped[str] = mapped_column(String(64), nullable=False)
    reason: Mapped[str] = mapped_column(String(8), nullable=False)
    due_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    resolved_at: Mapped[datetime | None] = mapped_column(TS)
    source_session_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class LearnerProfile(Base):
    """Проекция user.profile.created/updated.v1 (только от identity-consent): вид профиля и возрастная полоса —
    «липкий» детский режим (защита в глубину, если BFF не передал claims). Без имени и даты рождения."""

    __tablename__ = "learner_profiles"
    __table_args__ = (
        CheckConstraint("kind IS NULL OR kind IN ('account','child')", name="ck_learner_profiles_kind"),
        CheckConstraint("age_band IS NULL OR age_band IN ('6-9','10-13','14-17','18+')",
                        name="ck_learner_profiles_age_band"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    kind: Mapped[str | None] = mapped_column(String(8))
    age_band: Mapped[str | None] = mapped_column(String(8))
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())


class DeletedUser(Base):
    """Отметка исполненного удаления (сага TG-FR-006): запросы и события после удаления не воскрешают данные."""

    __tablename__ = "deleted_users"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    request_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    deleted_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())


# ---------------------------------------------------------------------------------------------------------------------
# Спринт 7 — социальное (INTERNAL_API §3): задания дуэли, парные комнаты, проекции social
# ---------------------------------------------------------------------------------------------------------------------


class DuelSet(Base):
    """Набор заданий дуэли (duel_host — код, §3.1): 10 закрытых заданий одной пары и полосы уровня, выбор детерминирован
    sha256(duel_id). items — снимки заданий с ключами (наружу не уходят; проверка ответа — по ключу снимка).
    open → closed (срок прохождения) → finished (game.duel.finished.v1 — открыт разбор). Участники обезличиваются
    сагой (user_a/user_b → null), набор остаётся второму участнику."""

    __tablename__ = "duel_sets"
    __table_args__ = (
        CheckConstraint(f"level_band {_in(LEVEL_BANDS)}", name="ck_duel_sets_band"),
        CheckConstraint(f"status {_in(DUEL_SET_STATUSES)}", name="ck_duel_sets_status"),
        CheckConstraint("audience IN ('kids','teens','adults')", name="ck_duel_sets_audience"),
        CheckConstraint("items_total BETWEEN 1 AND 50", name="ck_duel_sets_total"),
        UniqueConstraint("duel_id", name="uq_duel_sets_duel"),
        Index("ix_duel_sets_open", "play_deadline", postgresql_where=sql_text("status = 'open'")),
    )

    set_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    duel_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    pair_id: Mapped[str] = mapped_column(String(16), nullable=False)
    level_band: Mapped[str] = mapped_column(String(8), nullable=False)
    user_a: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    user_b: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    audience: Mapped[str] = mapped_column(String(8), nullable=False)
    seed: Mapped[str] = mapped_column(String(64), nullable=False)
    items: Mapped[list[dict[str, Any]]] = mapped_column(JSONB(), nullable=False)
    items_total: Mapped[int] = mapped_column(SmallInteger(), nullable=False)
    play_deadline: Mapped[datetime] = mapped_column(TS, nullable=False)
    status: Mapped[str] = mapped_column(String(10), nullable=False)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    closed_at: Mapped[datetime | None] = mapped_column(TS)
    finished_at: Mapped[datetime | None] = mapped_column(TS)
    result_version: Mapped[int | None] = mapped_column(SmallInteger())


class PairRoom(Base):
    """Парная комната (cooperative_lesson_coach, §3.2). engine: ai — коуч через ai-gateway; script — сценарий каталога
    с выбором реплик (дети, ИИ недоступен или бюджет исчерпан). state — состояние коуча/сценария (роли, цель,
    подсказка, варианты, узел графа, ожидание ответа коуча); тексты реплик — только в room_events.
    inviter/invitee → null сагой удаления (обезличивание; отчёт второго участника не трогается)."""

    __tablename__ = "pair_rooms"
    __table_args__ = (
        CheckConstraint(f"status {_in(ROOM_STATUSES)}", name="ck_pair_rooms_status"),
        CheckConstraint("mode IN ('free','choices')", name="ck_pair_rooms_mode"),
        CheckConstraint("engine IN ('ai','script')", name="ck_pair_rooms_engine"),
        CheckConstraint("audience IN ('kids','teens','adults')", name="ck_pair_rooms_audience"),
        CheckConstraint(f"end_reason IS NULL OR end_reason {_in(END_REASONS)}", name="ck_pair_rooms_end_reason"),
        CheckConstraint("next_speaker IS NULL OR next_speaker IN ('A','B','both')", name="ck_pair_rooms_next"),
        CheckConstraint("seq >= 0 AND turn_seq >= 0 AND progress_seconds >= 0 AND ai_cost_usd >= 0",
                        name="ck_pair_rooms_counters"),
        CheckConstraint(f"level IS NULL OR level {BAND_CHECK}", name="ck_pair_rooms_level"),
        # спринт 8 (миграция 0004)
        CheckConstraint("coach_active_seconds >= 0", name="ck_pair_rooms_coach_seconds"),
        CheckConstraint("billable_minutes IS NULL OR billable_minutes BETWEEN 0 AND 240",
                        name="ck_pair_rooms_billable_minutes"),
        CheckConstraint("billing_hold_id IS NULL OR billing_payer_user_id IS NOT NULL", name="ck_pair_rooms_billing"),
        UniqueConstraint("inviter", "idempotency_key", name="uq_pair_rooms_inviter_idempotency"),
        Index("ix_pair_rooms_created", "created_at"),
        Index("ix_pair_rooms_active", "status", postgresql_where=sql_text(
            "status IN ('invited','waiting','in_progress','paused')")),
        Index("ix_pair_rooms_ended", "ended_at", postgresql_where=sql_text("ended_at IS NOT NULL")),
        # планировщик: только комнаты, которым пора что-то сделать (срок следующего действия)
        Index("ix_pair_rooms_due", "due_at", postgresql_where=sql_text(
            "status IN ('invited','waiting','in_progress','paused')")),
    )

    room_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    pair_id: Mapped[str] = mapped_column(String(16), nullable=False)
    scenario_id: Mapped[str] = mapped_column(String(64), nullable=False)
    content_versions: Mapped[dict[str, Any]] = mapped_column(JSONB(), nullable=False)
    title: Mapped[dict[str, Any]] = mapped_column(JSONB(), nullable=False)
    level: Mapped[str | None] = mapped_column(String(2))
    mode: Mapped[str] = mapped_column(String(8), nullable=False)
    engine: Mapped[str] = mapped_column(String(8), nullable=False)
    ai_degraded: Mapped[bool] = mapped_column(Boolean(), nullable=False, server_default=sql_text("false"))
    # комната начата с ИИ-коучем — входит в суточный лимит участников (PAIR_AI_ROOMS_PER_DAY)
    coach_used: Mapped[bool] = mapped_column(Boolean(), nullable=False, server_default=sql_text("false"))
    audience: Mapped[str] = mapped_column(String(8), nullable=False)
    status: Mapped[str] = mapped_column(String(12), nullable=False)
    inviter: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    invitee: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    start_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    respond_until: Mapped[datetime] = mapped_column(TS, nullable=False)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    accepted_at: Mapped[datetime | None] = mapped_column(TS)
    started_at: Mapped[datetime | None] = mapped_column(TS)
    ended_at: Mapped[datetime | None] = mapped_column(TS)
    end_reason: Mapped[str | None] = mapped_column(String(20))
    team_goal_reached: Mapped[bool] = mapped_column(Boolean(), nullable=False, server_default=sql_text("false"))
    ai_cost_usd: Mapped[Decimal] = mapped_column(Numeric(10, 4), nullable=False, server_default=sql_text("0"))
    seq: Mapped[int] = mapped_column(Integer(), nullable=False, server_default=sql_text("0"))
    turn_seq: Mapped[int] = mapped_column(Integer(), nullable=False, server_default=sql_text("0"))
    next_speaker: Mapped[str | None] = mapped_column(String(4))
    prompt_at: Mapped[datetime | None] = mapped_column(TS)
    clock_at: Mapped[datetime | None] = mapped_column(TS)
    last_activity_at: Mapped[datetime | None] = mapped_column(TS)
    progress_seconds: Mapped[int] = mapped_column(Integer(), nullable=False, server_default=sql_text("0"))
    state: Mapped[dict[str, Any]] = mapped_column(JSONB(), nullable=False)
    starting_sent_at: Mapped[datetime | None] = mapped_column(TS)
    # срок следующего обслуживания (истечение, offline, соло, неактивность, предел времени, молчание, ответ коуча)
    due_at: Mapped[datetime | None] = mapped_column(TS)
    stopped_by_id: Mapped[str | None] = mapped_column(String(64))
    stopped_by_name: Mapped[str | None] = mapped_column(String(200))
    stop_reason: Mapped[str | None] = mapped_column(String(500))
    idempotency_key: Mapped[str | None] = mapped_column(String(128))
    request_hash: Mapped[str | None] = mapped_column(String(64))
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    # спринт 8 (миграция 0004): урок вдвоём оплачивает пригласивший (его подписка и минуты, один раз за комнату);
    # удержание — при старте с коучем; к списанию ⌈coach_active_seconds / 60⌉ (время с работающим коучем)
    billing_payer_user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    billing_hold_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    coach_active_seconds: Mapped[int] = mapped_column(Integer(), nullable=False, server_default=sql_text("0"))
    billable_minutes: Mapped[int | None] = mapped_column(SmallInteger())


class RoomParticipant(Base):
    """Участник комнаты (сторона inviter/invitee): роль, присутствие, время речи, минуты участника (учёт; списание
    минут подписки — по комнате у пригласившего, спринт 8), вклад, доказательства для независимой оценки, приватный
    отчёт, своя сессия session_id = uuid5(room_id, str(user_id)). holds_slot — комната занимает «слот» ученика
    (≤ 1 активной)."""

    __tablename__ = "room_participants"
    __table_args__ = (
        CheckConstraint(f"side {_in(SIDES)}", name="ck_room_participants_side"),
        CheckConstraint("role IS NULL OR role IN ('A','B')", name="ck_room_participants_role"),
        CheckConstraint("audience IN ('kids','teens','adults')", name="ck_room_participants_audience"),
        CheckConstraint("locale IN ('ru','uz')", name="ck_room_participants_locale"),
        CheckConstraint("network IS NULL OR network IN ('online','offline')", name="ck_room_participants_network"),
        CheckConstraint("evaluation_status IN ('none','pending','done','failed')",
                        name="ck_room_participants_evaluation"),
        CheckConstraint("turns >= 0 AND speaking_seconds >= 0 AND active_seconds >= 0 AND minutes >= 0 "
                        "AND evaluation_attempts >= 0", name="ck_room_participants_counters"),
        ForeignKeyConstraint(["room_id"], ["pair_rooms.room_id"], ondelete="CASCADE",
                             name="fk_room_participants_room"),
        UniqueConstraint("session_id", name="uq_room_participants_session"),
        Index("uq_room_participants_slot", "user_id", unique=True, postgresql_where=sql_text("holds_slot")),
        Index("ix_room_participants_user", "user_id"),
        Index("ix_room_participants_evaluation", "room_id",
              postgresql_where=sql_text("evaluation_status = 'pending'")),
    )

    room_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    side: Mapped[str] = mapped_column(String(8), primary_key=True)
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    session_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    role: Mapped[str | None] = mapped_column(String(1))
    audience: Mapped[str] = mapped_column(String(8), nullable=False)
    locale: Mapped[str] = mapped_column(String(2), nullable=False, server_default=sql_text("'ru'"))
    voice: Mapped[bool] = mapped_column(Boolean(), nullable=False, server_default=sql_text("false"))
    holds_slot: Mapped[bool] = mapped_column(Boolean(), nullable=False, server_default=sql_text("false"))
    joined_at: Mapped[datetime | None] = mapped_column(TS)
    last_seen_at: Mapped[datetime | None] = mapped_column(TS)
    left_at: Mapped[datetime | None] = mapped_column(TS)
    absent_since: Mapped[datetime | None] = mapped_column(TS)
    abandoned: Mapped[bool] = mapped_column(Boolean(), nullable=False, server_default=sql_text("false"))
    network: Mapped[str | None] = mapped_column(String(8))
    turns: Mapped[int] = mapped_column(SmallInteger(), nullable=False, server_default=sql_text("0"))
    speaking_seconds: Mapped[int] = mapped_column(Integer(), nullable=False, server_default=sql_text("0"))
    active_seconds: Mapped[int] = mapped_column(Integer(), nullable=False, server_default=sql_text("0"))
    minutes: Mapped[int] = mapped_column(SmallInteger(), nullable=False, server_default=sql_text("0"))
    contributed: Mapped[bool] = mapped_column(Boolean(), nullable=False, server_default=sql_text("false"))
    evidence: Mapped[list[dict[str, Any]]] = mapped_column(JSONB(), nullable=False,
                                                          server_default=sql_text("'[]'::jsonb"))
    report: Mapped[dict[str, Any] | None] = mapped_column(JSONB(none_as_null=True))
    evaluation_status: Mapped[str] = mapped_column(String(8), nullable=False, server_default=sql_text("'none'"))
    evaluation_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    evaluation_attempts: Mapped[int] = mapped_column(SmallInteger(), nullable=False, server_default=sql_text("0"))


class RoomEvent(Base):
    """Лента комнаты для long-poll (seq по комнате). Тексты (реплики учеников и коуча) видят только участники;
    админке — ход событий без текстов. Строка неизменяема, кроме стирания текста (срок хранения, сага) — триггер."""

    __tablename__ = "room_events"
    __table_args__ = (
        CheckConstraint(f"kind {_in(ROOM_EVENT_KINDS)}", name="ck_room_events_kind"),
        CheckConstraint(f"side IS NULL OR side {_in(SIDES)}", name="ck_room_events_side"),
        CheckConstraint("role IS NULL OR role IN ('A','B')", name="ck_room_events_role"),
        CheckConstraint("mode IS NULL OR mode IN ('text','voice','choice')", name="ck_room_events_mode"),
        ForeignKeyConstraint(["room_id"], ["pair_rooms.room_id"], ondelete="CASCADE", name="fk_room_events_room"),
        Index("uq_room_events_idempotency", "room_id", "side", "idempotency_key", unique=True,
              postgresql_where=sql_text("idempotency_key IS NOT NULL")),
        Index("ix_room_events_redact", "at", postgresql_where=sql_text("text IS NOT NULL")),
    )

    room_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    seq: Mapped[int] = mapped_column(Integer(), primary_key=True)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    side: Mapped[str | None] = mapped_column(String(8))
    role: Mapped[str | None] = mapped_column(String(1))
    text: Mapped[str | None] = mapped_column(String(600))
    mode: Mapped[str | None] = mapped_column(String(8))
    turn_id: Mapped[str | None] = mapped_column(String(8))
    at: Mapped[datetime] = mapped_column(TS, nullable=False)
    idempotency_key: Mapped[str | None] = mapped_column(String(128))
    request_hash: Mapped[str | None] = mapped_column(String(64))
    redacted_at: Mapped[datetime | None] = mapped_column(TS)


class RoomAudio(Base):
    """Распознанная голосовая реплика до подтверждения хода (audio_id живёт 5 минут, один раз). Аудио не хранится —
    только распознанный текст и длительность; запись удаляется tick-ом после срока."""

    __tablename__ = "room_audio"
    __table_args__ = (
        CheckConstraint(f"side {_in(SIDES)}", name="ck_room_audio_side"),
        CheckConstraint("duration_ms BETWEEN 0 AND 60000", name="ck_room_audio_duration"),
        ForeignKeyConstraint(["room_id"], ["pair_rooms.room_id"], ondelete="CASCADE", name="fk_room_audio_room"),
        Index("ix_room_audio_expires", "expires_at"),
    )

    audio_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    room_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    side: Mapped[str] = mapped_column(String(8), nullable=False)
    text: Mapped[str] = mapped_column(String(600), nullable=False)
    duration_ms: Mapped[int] = mapped_column(Integer(), nullable=False)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(TS)


class CommunityMember(Base):
    """Проекция social.profile.updated.v1 (только от social): member_id и ник — для member_id → user_id и ника
    партнёра в комнате и событии приглашения."""

    __tablename__ = "community_members"
    __table_args__ = (UniqueConstraint("member_id", name="uq_community_members_member"),)

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    member_id: Mapped[str] = mapped_column(String(32), nullable=False)
    nickname: Mapped[str | None] = mapped_column(String(20))
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class SocialBlock(Base):
    """Проекция social.block.changed.v1 (только от social): блокировка A→B; active=false — снята. Более старое событие
    не откатывает новое (at)."""

    __tablename__ = "social_blocks"

    blocker: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    blocked: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    active: Mapped[bool] = mapped_column(Boolean(), nullable=False)
    at: Mapped[datetime] = mapped_column(TS, nullable=False)


class SocialSanction(Base):
    """Проекция social.sanction.changed.v1 (только от social): действующий social_ban запрещает приглашения в парный
    урок (403 SOCIAL_RESTRICTED {until}); идущая комната доигрывается."""

    __tablename__ = "social_sanctions"
    __table_args__ = (Index("ix_social_sanctions_user", "user_id"),)

    sanction_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    until: Mapped[datetime | None] = mapped_column(TS)
    active: Mapped[bool] = mapped_column(Boolean(), nullable=False)
    changed_at: Mapped[datetime] = mapped_column(TS, nullable=False)
