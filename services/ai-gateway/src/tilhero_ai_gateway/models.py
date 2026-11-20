"""Модели ai-gateway — зеркало миграций (tests/test_gw_schema.py сверяет schema_drift).

Версии инструкций (`agent_versions`): черновик → (золотые тесты) → опубликована → архив. Опубликованная и архивная
версии, а также черновик под канарейкой неизменяемы: триггер `agent_versions_guard` (миграция 0001) запрещает менять
тело и идентичность, допускает только переходы статуса draft → published, published → archived, archived → published
(откат); удалить можно только черновик не под канарейкой. Роль сервиса не может снять триггер (DDL — у владельца).
`usage` — только метаданные вызова (без текстов запроса и ответа); вызов оценки произношения (спринт 5) — та же
таблица: агент `pronunciation_coach`, провайдер `azure_speech | fake_speech`, длительность аудио `audio_ms` (самого
аудио нет нигде). `models` — LLM (цена за 1 млн токенов) и речь (цена часа аудио `audio_usd_per_hour`).
"""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Identity,
    Index,
    Integer,
    Numeric,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from tilhero_ai_gateway.domain.registry import AGENT_IDS

TS = DateTime(timezone=True)
AGENT_IDS_SQL = ", ".join(f"'{a}'" for a in AGENT_IDS)
ID_SQL = "'^[a-z0-9][a-z0-9._-]{1,63}$'"
HEX64_SQL = "'^[0-9a-f]{64}$'"
# причины unavailable / refused (ai.ts AgentUnavailableReason | AgentRefusedReason; спринт 5: + not_configured)
REASONS_SQL = ("'ai_disabled', 'not_configured', 'budget_exceeded', 'cost_limit', 'provider_error', 'timeout', "
               "'invalid_output', 'kids_not_allowed', 'agent_not_active'")
# оценка произношения: вызов состоялся (status ok), но оценки нет (PronunciationResult insufficient_evidence)
INSUFFICIENT_SQL = "'not_recognized', 'low_confidence', 'incomplete'"
PROVIDERS_SQL = "'anthropic', 'fake', 'azure_speech', 'fake_speech'"
SPEECH_PROVIDERS_SQL = "'azure_speech', 'fake_speech'"
SESSION_KINDS_SQL = "'lesson', 'scenario', 'media', 'review', 'reading', 'memory', 'golden'"
USAGE_STATUS_REASON_SQL = (
    f"(status = 'pending' AND reason IS NULL) "
    f"OR (status = 'ok' AND (reason IS NULL OR reason IN ({INSUFFICIENT_SQL}))) "
    f"OR (status IN ('unavailable', 'refused') AND reason IN ({REASONS_SQL}))")
MODELS_KIND_SQL = (
    f"(provider IN ({SPEECH_PROVIDERS_SQL})) = (audio_usd_per_hour IS NOT NULL) "
    f"AND (provider NOT IN ({SPEECH_PROVIDERS_SQL}) OR (input_usd_per_mtok = 0 AND output_usd_per_mtok = 0))")


class Base(DeclarativeBase):
    pass


class AgentRow(Base):
    """Реестр агентов (ai.ts `Agent`): сид — 17 агентов LinguaFlow (domain/registry.py)."""

    __tablename__ = "agents"
    __table_args__ = (
        CheckConstraint(f"agent_id IN ({AGENT_IDS_SQL})", name="ck_agents_id"),
        CheckConstraint("jsonb_typeof(title) = 'object'", name="ck_agents_title"),
        CheckConstraint("jsonb_typeof(purpose) = 'object'", name="ck_agents_purpose"),
        CheckConstraint("implementation IN ('llm', 'rules', 'code')", name="ck_agents_implementation"),
        CheckConstraint("availability IN ('active', 'planned')", name="ck_agents_availability"),
        CheckConstraint("(availability = 'planned') = (planned_sprint IS NOT NULL)", name="ck_agents_planned"),
        CheckConstraint("planned_sprint IS NULL OR planned_sprint BETWEEN 1 AND 30", name="ck_agents_planned_sprint"),
    )

    agent_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    title: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    purpose: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    owner_role: Mapped[str] = mapped_column(String(32), nullable=False)
    implementation: Mapped[str] = mapped_column(String(8), nullable=False)
    availability: Mapped[str] = mapped_column(String(8), nullable=False)
    planned_sprint: Mapped[int | None] = mapped_column(Integer)
    free_text: Mapped[bool] = mapped_column(Boolean, nullable=False)
    implemented_in: Mapped[str | None] = mapped_column(String(32))
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())


class ModelRow(Base):
    """Маршрутизация моделей и цены, правка — ai.publish (снижение — ещё costs.manage). LLM — $ за 1 млн токенов
    (audio_usd_per_hour NULL); речь (azure_speech | fake_speech, миграция 0004) — $ за час аудио, токенов нет (0)."""

    __tablename__ = "models"
    __table_args__ = (
        CheckConstraint(f"model_id ~ {ID_SQL}", name="ck_models_id"),
        CheckConstraint(f"provider IN ({PROVIDERS_SQL})", name="ck_models_provider"),
        CheckConstraint("input_usd_per_mtok >= 0 AND input_usd_per_mtok <= 1000", name="ck_models_input"),
        CheckConstraint("output_usd_per_mtok >= 0 AND output_usd_per_mtok <= 1000", name="ck_models_output"),
        CheckConstraint("audio_usd_per_hour IS NULL OR (audio_usd_per_hour >= 0 AND audio_usd_per_hour <= 1000)",
                        name="ck_models_audio"),
        CheckConstraint(MODELS_KIND_SQL, name="ck_models_kind"),
    )

    model_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    provider: Mapped[str] = mapped_column(String(16), nullable=False)
    input_usd_per_mtok: Mapped[Decimal] = mapped_column(Numeric(10, 4), nullable=False)
    output_usd_per_mtok: Mapped[Decimal] = mapped_column(Numeric(10, 4), nullable=False)
    audio_usd_per_hour: Mapped[Decimal | None] = mapped_column(Numeric(10, 4))
    active: Mapped[bool] = mapped_column(Boolean, nullable=False)
    updated_by: Mapped[str] = mapped_column(String(64), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())


class AgentVersion(Base):
    """Версия инструкций агента (ai.ts `AgentVersion`). Не больше одной published и одного draft на агента."""

    __tablename__ = "agent_versions"
    __table_args__ = (
        UniqueConstraint("agent_id", "version", name="uq_agent_versions_agent_version"),
        CheckConstraint("version >= 1", name="ck_agent_versions_version"),
        CheckConstraint("status IN ('draft', 'published', 'archived')", name="ck_agent_versions_status"),
        CheckConstraint("char_length(instructions) <= 20000", name="ck_agent_versions_instructions"),
        CheckConstraint("char_length(rules) <= 10000", name="ck_agent_versions_rules"),
        CheckConstraint("jsonb_typeof(output_schema) = 'object'", name="ck_agent_versions_output_schema"),
        CheckConstraint("schema_version ~ '^[a-z0-9][a-z0-9._-]{0,63}$'", name="ck_agent_versions_schema_version"),
        CheckConstraint("temperature >= 0 AND temperature <= 1", name="ck_agent_versions_temperature"),
        CheckConstraint("max_output_tokens BETWEEN 1 AND 2000", name="ck_agent_versions_max_output_tokens"),
        CheckConstraint("timeout_ms BETWEEN 2000 AND 30000", name="ck_agent_versions_timeout"),
        CheckConstraint("max_cost_usd >= 0 AND max_cost_usd <= 10", name="ck_agent_versions_max_cost"),
        CheckConstraint("notes IS NULL OR char_length(notes) <= 2000", name="ck_agent_versions_notes"),
        CheckConstraint(f"body_hash ~ {HEX64_SQL}", name="ck_agent_versions_body_hash"),
        CheckConstraint("status <> 'published' OR published_at IS NOT NULL", name="ck_agent_versions_published"),
        CheckConstraint("status <> 'archived' OR archived_at IS NOT NULL", name="ck_agent_versions_archived"),
        Index("uq_agent_versions_published", "agent_id", unique=True, postgresql_where=text("status = 'published'")),
        Index("uq_agent_versions_draft", "agent_id", unique=True, postgresql_where=text("status = 'draft'")),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    seq: Mapped[int] = mapped_column(BigInteger, Identity(always=True), unique=True)
    agent_id: Mapped[str] = mapped_column(String(64), ForeignKey("agents.agent_id", name="fk_agent_versions_agent"),
                                          nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    instructions: Mapped[str] = mapped_column(Text, nullable=False)
    rules: Mapped[str] = mapped_column(Text, nullable=False)
    output_schema: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    schema_version: Mapped[str] = mapped_column(String(64), nullable=False)
    model_id: Mapped[str] = mapped_column(String(64), ForeignKey("models.model_id", name="fk_agent_versions_model"),
                                          nullable=False)
    fallback_model_id: Mapped[str | None] = mapped_column(
        String(64), ForeignKey("models.model_id", name="fk_agent_versions_fallback"))
    temperature: Mapped[Decimal] = mapped_column(Numeric(3, 2), nullable=False)
    max_output_tokens: Mapped[int] = mapped_column(Integer, nullable=False)
    timeout_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    max_cost_usd: Mapped[Decimal] = mapped_column(Numeric(10, 6), nullable=False)
    notes: Mapped[str | None] = mapped_column(Text)
    body_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    author_id: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())
    updated_by: Mapped[str] = mapped_column(String(64), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())
    published_by: Mapped[str | None] = mapped_column(String(64))
    published_at: Mapped[datetime | None] = mapped_column(TS)
    archived_at: Mapped[datetime | None] = mapped_column(TS)


class AgentRollout(Base):
    """Что обслуживает вызовы агента: опубликованная версия, канарейка (доля 0..50 %), прежняя (для отката)."""

    __tablename__ = "agent_rollout"
    __table_args__ = (
        ForeignKeyConstraint(["agent_id", "published_version"], ["agent_versions.agent_id", "agent_versions.version"],
                             name="fk_agent_rollout_published"),
        ForeignKeyConstraint(["agent_id", "canary_version"], ["agent_versions.agent_id", "agent_versions.version"],
                             name="fk_agent_rollout_canary"),
        ForeignKeyConstraint(["agent_id", "previous_version"], ["agent_versions.agent_id", "agent_versions.version"],
                             name="fk_agent_rollout_previous"),
        CheckConstraint("canary_percent BETWEEN 0 AND 50", name="ck_agent_rollout_percent"),
        CheckConstraint("(canary_version IS NULL) = (canary_percent = 0)", name="ck_agent_rollout_canary"),
        CheckConstraint("canary_version IS NULL OR canary_version IS DISTINCT FROM published_version",
                        name="ck_agent_rollout_canary_distinct"),
    )

    agent_id: Mapped[str] = mapped_column(String(64), ForeignKey("agents.agent_id", name="fk_agent_rollout_agent"),
                                          primary_key=True)
    published_version: Mapped[int | None] = mapped_column(Integer)
    canary_version: Mapped[int | None] = mapped_column(Integer)
    canary_percent: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    previous_version: Mapped[int | None] = mapped_column(Integer)
    updated_by: Mapped[str] = mapped_column(String(64), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())


class GoldenCaseRow(Base):
    """Золотой тест агента (ai.ts `GoldenCase`): вход (аудитория + контекст) и проверки вывода; удаление = архив."""

    __tablename__ = "golden_cases"
    __table_args__ = (
        CheckConstraint(f"case_id ~ {ID_SQL}", name="ck_golden_cases_id"),
        CheckConstraint("char_length(title) BETWEEN 1 AND 200", name="ck_golden_cases_title"),
        CheckConstraint("jsonb_typeof(input) = 'object'", name="ck_golden_cases_input"),
        CheckConstraint("jsonb_typeof(checks) = 'array'", name="ck_golden_cases_checks"),
        Index("ix_golden_cases_agent", "agent_id", "case_id"),
    )

    case_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    agent_id: Mapped[str] = mapped_column(String(64), ForeignKey("agents.agent_id", name="fk_golden_cases_agent"),
                                          nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    input: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    checks: Mapped[list[Any]] = mapped_column(JSONB, nullable=False)
    mandatory: Mapped[bool] = mapped_column(Boolean, nullable=False)
    created_by: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())
    archived_at: Mapped[datetime | None] = mapped_column(TS)


class TestRunRow(Base):
    """Прогон золотых тестов версии: тело версии (body_hash) и набор обязательных кейсов (cases_hash) на момент
    прогона — после правки черновика или обязательных кейсов прогон устаревает (TESTS_REQUIRED)."""

    __test__ = False  # не тестовый класс pytest
    __tablename__ = "test_runs"
    __table_args__ = (
        ForeignKeyConstraint(["agent_id", "version"], ["agent_versions.agent_id", "agent_versions.version"],
                             name="fk_test_runs_version", ondelete="CASCADE"),
        CheckConstraint("status IN ('running', 'finished', 'failed')", name="ck_test_runs_status"),
        CheckConstraint("provider IN ('anthropic', 'fake')", name="ck_test_runs_provider"),
        CheckConstraint(f"body_hash ~ {HEX64_SQL}", name="ck_test_runs_body_hash"),
        CheckConstraint(f"cases_hash ~ {HEX64_SQL}", name="ck_test_runs_cases_hash"),
        CheckConstraint("jsonb_typeof(results) = 'array'", name="ck_test_runs_results"),
        CheckConstraint("passed >= 0 AND failed >= 0", name="ck_test_runs_counts"),
        CheckConstraint("cost_usd >= 0", name="ck_test_runs_cost"),
        CheckConstraint("(status = 'running') = (finished_at IS NULL)", name="ck_test_runs_finished"),
        Index("ix_test_runs_version", "agent_id", "version", "seq"),
    )

    run_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    seq: Mapped[int] = mapped_column(BigInteger, Identity(always=True), unique=True)
    agent_id: Mapped[str] = mapped_column(String(64), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    provider: Mapped[str] = mapped_column(String(16), nullable=False)
    body_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    cases_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    started_by: Mapped[str] = mapped_column(String(64), nullable=False)
    started_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(TS)
    results: Mapped[list[Any]] = mapped_column(JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    passed: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    failed: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    passed_mandatory: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    cost_usd: Mapped[Decimal] = mapped_column(Numeric(12, 6), nullable=False, server_default="0")


class BudgetRow(Base):
    """Бюджет ИИ (singleton, id = 1): аварийная остановка, потолок месяца, лимит ученика в день и урока."""

    __tablename__ = "budget"
    __table_args__ = (
        CheckConstraint("id = 1", name="ck_budget_singleton"),
        CheckConstraint("monthly_cap_usd >= 0 AND monthly_cap_usd <= 100000", name="ck_budget_monthly"),
        CheckConstraint("learner_daily_cap_usd >= 0 AND learner_daily_cap_usd <= 1000", name="ck_budget_daily"),
        CheckConstraint("lesson_cap_usd >= 0 AND lesson_cap_usd <= 1000", name="ck_budget_lesson"),
        CheckConstraint("alert_percent BETWEEN 1 AND 100", name="ck_budget_alert"),
    )

    id: Mapped[int] = mapped_column(SmallInteger, primary_key=True)
    ai_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False)
    monthly_cap_usd: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=False)
    learner_daily_cap_usd: Mapped[Decimal] = mapped_column(Numeric(10, 4), nullable=False)
    lesson_cap_usd: Mapped[Decimal] = mapped_column(Numeric(10, 4), nullable=False)
    alert_percent: Mapped[int] = mapped_column(Integer, nullable=False)
    updated_by: Mapped[str] = mapped_column(String(64), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())


class UsageRow(Base):
    """Учёт вызова агента — **без текста** запроса и ответа. `pending` — вызов идёт (reserved_usd — резерв по оценке
    стоимости, входит в бюджеты, чтобы параллельные вызовы не превысили потолок); после вызова — итог и стоимость
    по usage ответа провайдера. Сага удаления обезличивает user_id."""

    __tablename__ = "usage"
    __table_args__ = (
        CheckConstraint("status IN ('pending', 'ok', 'unavailable', 'refused')", name="ck_usage_status"),
        CheckConstraint(f"reason IS NULL OR reason IN ({REASONS_SQL}, {INSUFFICIENT_SQL})", name="ck_usage_reason"),
        CheckConstraint(USAGE_STATUS_REASON_SQL, name="ck_usage_status_reason"),
        CheckConstraint(f"provider IN ({PROVIDERS_SQL})", name="ck_usage_provider"),
        CheckConstraint(f"session_kind IS NULL OR session_kind IN ({SESSION_KINDS_SQL})",
                        name="ck_usage_session_kind"),
        CheckConstraint(f"audio_ms BETWEEN 0 AND 60000 AND (audio_ms = 0 OR provider IN ({SPEECH_PROVIDERS_SQL}))",
                        name="ck_usage_audio"),
        CheckConstraint("input_tokens >= 0 AND output_tokens >= 0", name="ck_usage_tokens"),
        CheckConstraint("cost_usd >= 0 AND reserved_usd >= 0", name="ck_usage_cost"),
        CheckConstraint("latency_ms >= 0", name="ck_usage_latency"),
        CheckConstraint("attempts BETWEEN 0 AND 5", name="ck_usage_attempts"),
        CheckConstraint("(status = 'pending') = (finished_at IS NULL)", name="ck_usage_finished"),
        CheckConstraint("status = 'pending' OR reserved_usd = 0", name="ck_usage_reserved"),
        Index("ix_usage_created", "created_at"),
        Index("ix_usage_user_created", "user_id", "created_at"),
        Index("ix_usage_session", "session_id"),
        Index("ix_usage_agent_seq", "agent_id", "seq"),
        Index("ix_usage_request", "request_id"),
        Index("ix_usage_pending", "created_at", postgresql_where=text("status = 'pending'")),
    )

    call_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    seq: Mapped[int] = mapped_column(BigInteger, Identity(always=True), unique=True)
    request_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    caller: Mapped[str] = mapped_column(String(32), nullable=False)
    agent_id: Mapped[str] = mapped_column(String(64), ForeignKey("agents.agent_id", name="fk_usage_agent"),
                                          nullable=False)
    version: Mapped[int | None] = mapped_column(Integer)
    model_id: Mapped[str | None] = mapped_column(String(64))
    provider: Mapped[str] = mapped_column(String(16), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    reason: Mapped[str | None] = mapped_column(String(32))
    input_tokens: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    output_tokens: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    cost_usd: Mapped[Decimal] = mapped_column(Numeric(12, 6), nullable=False, server_default="0")
    reserved_usd: Mapped[Decimal] = mapped_column(Numeric(12, 6), nullable=False, server_default="0")
    latency_ms: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    attempts: Mapped[int] = mapped_column(SmallInteger, nullable=False, server_default="0")
    session_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    session_kind: Mapped[str | None] = mapped_column(String(16))
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    canary: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    # длительность оценённого аудио, мс (только речь; стоимость = audio_ms / 3 600 000 × audio_usd_per_hour)
    audio_ms: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(TS)


class DeletedUser(Base):
    """Исполненное удаление ученика (сага): его новые вызовы учитываются без user_id."""

    __tablename__ = "deleted_users"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    request_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    deleted_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())
