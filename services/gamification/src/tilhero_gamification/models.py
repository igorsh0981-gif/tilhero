"""Модели gamification — зеркало миграций 0001–0002 (UNIQUE, индексы и CHECK объявлены и здесь: тест schema_drift).

user_id везде — ученик (`lrn` внутреннего токена). PII сервис не хранит: только идентификаторы, счётчики и суммы.
Реестр `ledger` — только добавление (триггер): UPDATE — лишь перевод `confirmed → reversed` с `reversed_by`,
DELETE — только в саге удаления (`SET LOCAL tilhero.deletion = 'on'`). Значки неизменяемы так же.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Index,
    Integer,
    LargeBinary,
    Numeric,
    SmallInteger,
    String,
    UniqueConstraint,
)
from sqlalchemy import text as sql_text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

TS = DateTime(timezone=True)

CURRENCIES = ("xp", "til", "freeze")
REASONS = ("lesson", "scenario", "media", "reading", "review", "skill_demonstrated", "skill_retained", "quest",
           "quest_bonus", "registration_bonus", "referral_bonus", "streak_freeze", "shop", "manual", "reversal",
           "purchase",
           # спринт 7: XP за дуэль и парный урок, приз общей лиги (тилы), награда приглашённому по кампании
           "duel", "pair_lesson", "league_prize", "referral_welcome")
AUDIENCES = ("kids", "teens", "adults")
AGE_BANDS = ("6-9", "10-13", "14-17", "18+")
SKILL_STATES = ("not_started", "learning", "demonstrated", "retained")
QUEST_KINDS = ("lesson_complete", "review_cards", "reading_complete", "scenario_complete", "media_complete",
               "xp_earned", "skill_confirmed")
QUEST_STATUSES = ("active", "completed", "expired")
REFERRAL_STATUSES = ("pending", "rewarded", "capped", "void", "expired")
RULES_STATUSES = ("draft", "active", "archived")
HERO_LINES = ("robot", "pet", "human")
ASSET_PURPOSES = ("hero_stage", "shop_item", "badge")
SHOP_KINDS = ("background", "hero_frame", "streak_freeze")
SHOP_STATUSES = ("draft", "published", "retired")
EVENT_STATUSES = ("draft", "published", "cancelled", "finished")
BADGE_METRICS = ("lessons", "streak", "skills", "skill_retained", "reviews_cards", "readings", "freeze", "together")
# спринт 7
LEVEL_BANDS = ("A0-A1", "A2", "B1+")
LEAGUE_WEEK_STATUSES = ("open", "closing", "closed")
LEAGUE_GROUP_STATUSES = ("open", "closed", "held")
DUEL_STATUSES = ("challenged", "declined", "expired", "accepted", "finished", "cancelled")
DUEL_RESULTS = ("challenger", "opponent", "draw", "none")
SANCTION_KINDS = ("warning", "social_ban", "nickname_reset")
FAMILY_ROLES = ("owner", "adult", "teen", "child")
GUARDIAN_CONSENTS = ("not_required", "pending", "granted", "declined")
REFERRAL_OUTCOMES = ("rewarded", "inviter_capped", "legacy")
PROJECTIONS = ("families", "friendships", "levels", "profiles")


def _in(values: tuple[str, ...]) -> str:
    return "IN (" + ",".join(f"'{v}'" for v in values) + ")"


class Base(DeclarativeBase):
    pass


class Ledger(Base):
    """Реестр операций XP, тилов и заморозок (§1.1). Баланс валюты = сумма amount всех операций, включая обратные."""

    __tablename__ = "ledger"
    __table_args__ = (
        CheckConstraint(f"currency {_in(CURRENCIES)}", name="ck_ledger_currency"),
        CheckConstraint("amount <> 0", name="ck_ledger_amount"),
        CheckConstraint(f"reason {_in(REASONS)}", name="ck_ledger_reason"),
        CheckConstraint("source_kind IN ('event','command','staff')", name="ck_ledger_source_kind"),
        CheckConstraint("status IN ('confirmed','reversed')", name="ck_ledger_status"),
        CheckConstraint("(status = 'reversed') = (reversed_by IS NOT NULL)", name="ck_ledger_reversed"),
        CheckConstraint("(reason = 'reversal') = (reversal_of IS NOT NULL)", name="ck_ledger_reversal"),
        CheckConstraint("actor IN ('system','learner') OR actor LIKE 'staff:%'", name="ck_ledger_actor"),
        CheckConstraint("multiplier >= 1 AND multiplier <= 3", name="ck_ledger_multiplier"),
        UniqueConstraint("user_id", "idempotency_key", name="uq_ledger_idempotency"),
        Index("ix_ledger_user_created", "user_id", "created_at", "op_id"),
        Index("ix_ledger_user_day", "user_id", "local_date", "currency"),
        Index("ix_ledger_session", "user_id", "source_session_id",
              postgresql_where=sql_text("source_session_id IS NOT NULL")),
        Index("uq_ledger_reversal_of", "reversal_of", unique=True,
              postgresql_where=sql_text("reversal_of IS NOT NULL")),
        Index("ix_ledger_league_week", "league_week", "user_id", postgresql_where=sql_text("league_week IS NOT NULL")),
    )

    op_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    currency: Mapped[str] = mapped_column(String(6), nullable=False)
    amount: Mapped[int] = mapped_column(Integer(), nullable=False)
    reason: Mapped[str] = mapped_column(String(24), nullable=False)
    source_kind: Mapped[str] = mapped_column(String(8), nullable=False)
    source_ref: Mapped[str] = mapped_column(String(200), nullable=False)
    source_session_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    rules_version: Mapped[int | None] = mapped_column(Integer())
    multiplier: Mapped[Decimal] = mapped_column(Numeric(4, 2), nullable=False, server_default=sql_text("1"))
    capped: Mapped[bool] = mapped_column(Boolean(), nullable=False, server_default=sql_text("false"))
    local_date: Mapped[date] = mapped_column(Date(), nullable=False)
    status: Mapped[str] = mapped_column(String(10), nullable=False, server_default=sql_text("'confirmed'"))
    reversed_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    reversal_of: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    actor: Mapped[str] = mapped_column(String(80), nullable=False)
    comment: Mapped[str | None] = mapped_column(String(300))
    idempotency_key: Mapped[str] = mapped_column(String(200), nullable=False)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    # спринт 7: неделя лиг (понедельник) операции XP, идущей в «XP недели»; null — не идёт (ручные, призы, бонусы)
    league_week: Mapped[date | None] = mapped_column(Date())


class Wallet(Base):
    """Материализованные итоги реестра (пересчитываются в транзакции операции; tick сверяет раз в сутки)."""

    __tablename__ = "wallets"
    __table_args__ = (
        CheckConstraint("xp_total >= 0", name="ck_wallets_xp"),
        CheckConstraint("til_balance >= 0", name="ck_wallets_til"),
        CheckConstraint("freeze_stock >= 0", name="ck_wallets_freeze"),
        CheckConstraint("level BETWEEN 1 AND 100", name="ck_wallets_level"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    xp_total: Mapped[int] = mapped_column(BigInteger(), nullable=False, server_default=sql_text("0"))
    til_balance: Mapped[int] = mapped_column(Integer(), nullable=False, server_default=sql_text("0"))
    freeze_stock: Mapped[int] = mapped_column(Integer(), nullable=False, server_default=sql_text("0"))
    level: Mapped[int] = mapped_column(SmallInteger(), nullable=False, server_default=sql_text("1"))
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class Learner(Base):
    """Ученик в игре: проекция (вид, возраст, пояс), герой и ступень, настройки мотивации, экипировка, счётчики
    значков. Ступень не понижается; confirmed_skills — текущее число навыков в demonstrated / retained, подтверждённых
    в учёбе (lesson | retention), без отметок первичной диагностики."""

    __tablename__ = "learners"
    __table_args__ = (
        CheckConstraint("kind IN ('account','child')", name="ck_learners_kind"),
        CheckConstraint(f"age_band IS NULL OR age_band {_in(AGE_BANDS)}", name="ck_learners_age_band"),
        CheckConstraint("hero_stage BETWEEN 1 AND 3", name="ck_learners_stage"),
        CheckConstraint("celebrations IN ('full','quiet')", name="ck_learners_celebrations"),
        CheckConstraint("confirmed_skills >= 0 AND lessons_completed >= 0 AND reviews_cards >= 0 "
                        "AND readings_completed >= 0 AND streak_best >= 0 AND freezes_used >= 0 "
                        "AND skills_retained >= 0", name="ck_learners_counters"),
        CheckConstraint("together_count >= 0", name="ck_learners_together"),
        CheckConstraint(f"guardian_consent IS NULL OR guardian_consent {_in(GUARDIAN_CONSENTS)}",
                        name="ck_learners_guardian_consent"),
        Index("ix_learners_hero", "hero_code", postgresql_where=sql_text("hero_code IS NOT NULL")),
        Index("ix_learners_league_opt_in", "user_id", postgresql_where=sql_text("league_opt_in")),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    account_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    kind: Mapped[str] = mapped_column(String(8), nullable=False, server_default=sql_text("'account'"))
    age_band: Mapped[str | None] = mapped_column(String(8))
    timezone: Mapped[str | None] = mapped_column(String(64))
    plan_updated_at: Mapped[datetime | None] = mapped_column(TS)
    hero_code: Mapped[str | None] = mapped_column(String(16))
    hero_stage: Mapped[int] = mapped_column(SmallInteger(), nullable=False, server_default=sql_text("1"))
    confirmed_skills: Mapped[int] = mapped_column(Integer(), nullable=False, server_default=sql_text("0"))
    auto_freeze: Mapped[bool] = mapped_column(Boolean(), nullable=False, server_default=sql_text("true"))
    quests_hidden: Mapped[bool] = mapped_column(Boolean(), nullable=False, server_default=sql_text("false"))
    celebrations: Mapped[str] = mapped_column(String(5), nullable=False, server_default=sql_text("'full'"))
    game_notifications: Mapped[bool] = mapped_column(Boolean(), nullable=False, server_default=sql_text("true"))
    settings_customized: Mapped[bool] = mapped_column(Boolean(), nullable=False, server_default=sql_text("false"))
    background_code: Mapped[str | None] = mapped_column(String(40))
    frame_code: Mapped[str | None] = mapped_column(String(40))
    lessons_completed: Mapped[int] = mapped_column(Integer(), nullable=False, server_default=sql_text("0"))
    reviews_cards: Mapped[int] = mapped_column(Integer(), nullable=False, server_default=sql_text("0"))
    readings_completed: Mapped[int] = mapped_column(Integer(), nullable=False, server_default=sql_text("0"))
    streak_best: Mapped[int] = mapped_column(Integer(), nullable=False, server_default=sql_text("0"))
    freezes_used: Mapped[int] = mapped_column(Integer(), nullable=False, server_default=sql_text("0"))
    skills_retained: Mapped[int] = mapped_column(Integer(), nullable=False, server_default=sql_text("0"))
    registered_at: Mapped[datetime | None] = mapped_column(TS)
    # бонус регистрации выдан (при создании строки ученика или по user.profile.created — один ключ, без дубля)
    registration_bonus_at: Mapped[datetime | None] = mapped_column(TS)
    last_session_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    last_session_at: Mapped[datetime | None] = mapped_column(TS)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    # спринт 7: участие в общей лиге недели (14+, по желанию); парные уроки с целью и вкладом обоих (значок together)
    league_opt_in: Mapped[bool] = mapped_column(Boolean(), nullable=False, server_default=sql_text("false"))
    together_count: Mapped[int] = mapped_column(Integer(), nullable=False, server_default=sql_text("0"))
    # проекция user.profile.updated.v1 (identity-consent): согласие родителя на социальное (14–17); время события
    guardian_consent: Mapped[str | None] = mapped_column(String(16))
    profile_updated_at: Mapped[datetime | None] = mapped_column(TS)


class SkillState(Base):
    """Проекция состояния навыка из skills.state.changed.v1 (только от diagnostics). confirmed — навык подтверждён в
    учёбе (переход в demonstrated/retained с source lesson | retention); отметка первичной диагностики не
    подтверждает. В ступень героя идут навыки в demonstrated/retained с confirmed."""

    __tablename__ = "skill_states"
    __table_args__ = (
        CheckConstraint(f"state {_in(SKILL_STATES)}", name="ck_skill_states_state"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    pair_id: Mapped[str] = mapped_column(String(16), primary_key=True)
    skill_id: Mapped[str] = mapped_column(String(200), primary_key=True)
    state: Mapped[str] = mapped_column(String(16), nullable=False)
    confirmed: Mapped[bool] = mapped_column(Boolean(), nullable=False, server_default=sql_text("false"))
    changed_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class Referral(Base):
    """Спринт 6: привлечение по реферальной ссылке (награда после первого урока). Со спринта 7 новые строки не
    создаются; pending «доживают» по правилу спринта 6 LEGACY_REFERRAL_DAYS с принятия (первый урок приглашённого →
    награда пригласившему с месячным лимитом), затем — expired. Награды спринта 7 — referral_rewards."""

    __tablename__ = "referrals"
    __table_args__ = (
        CheckConstraint(f"status {_in(REFERRAL_STATUSES)}", name="ck_referrals_status"),
        CheckConstraint("inviter_user_id <> invitee_user_id", name="ck_referrals_self"),
        Index("ix_referrals_inviter", "inviter_user_id", "status", "rewarded_at"),
        Index("ix_referrals_pending", "accepted_at", postgresql_where=sql_text("status = 'pending'")),
    )

    invitee_user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    inviter_user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    invite_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    status: Mapped[str] = mapped_column(String(8), nullable=False)
    accepted_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    rewarded_at: Mapped[datetime | None] = mapped_column(TS)
    op_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class Ownership(Base):
    """Купленная косметика: второй раз не купить; снятие с продажи не отбирает."""

    __tablename__ = "ownership"
    __table_args__ = (Index("ix_ownership_item", "item_code"),)

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    item_code: Mapped[str] = mapped_column(String(40), primary_key=True)
    purchase_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    price_til: Mapped[int] = mapped_column(Integer(), nullable=False)
    purchased_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class Purchase(Base):
    """Покупка за тилы (одна транзакция: списание + владение). Повтор Idempotency-Key — тот же ответ."""

    __tablename__ = "purchases"
    __table_args__ = (
        CheckConstraint("status IN ('completed','refunded')", name="ck_purchases_status"),
        CheckConstraint("price_til BETWEEN 1 AND 10000", name="ck_purchases_price"),
        CheckConstraint(f"item_kind {_in(SHOP_KINDS)}", name="ck_purchases_kind"),
        UniqueConstraint("user_id", "idempotency_key", name="uq_purchases_idempotency"),
        Index("ix_purchases_user_created", "user_id", "created_at"),
        Index("ix_purchases_item", "item_code", "status"),
    )

    purchase_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    item_code: Mapped[str] = mapped_column(String(40), nullable=False)
    item_kind: Mapped[str] = mapped_column(String(16), nullable=False)
    price_til: Mapped[int] = mapped_column(Integer(), nullable=False)
    op_ids: Mapped[list[str]] = mapped_column(JSONB(), nullable=False)
    status: Mapped[str] = mapped_column(String(10), nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(128), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    response: Mapped[dict[str, Any]] = mapped_column(JSONB(), nullable=False)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    refunded_at: Mapped[datetime | None] = mapped_column(TS)


class Quest(Base):
    """Задание дня (slot 1..3) и строка бонуса за все три (slot 0, kind all_done)."""

    __tablename__ = "quests"
    __table_args__ = (
        CheckConstraint("slot BETWEEN 0 AND 3", name="ck_quests_slot"),
        CheckConstraint(f"kind {_in((*QUEST_KINDS, 'all_done'))}", name="ck_quests_kind"),
        CheckConstraint(f"status {_in(QUEST_STATUSES)}", name="ck_quests_status"),
        CheckConstraint("target >= 1 AND progress >= 0 AND reward_xp >= 0 AND reward_til >= 0",
                        name="ck_quests_numbers"),
        CheckConstraint("(status = 'completed') = (completed_at IS NOT NULL)", name="ck_quests_completed"),
        Index("ix_quests_active", "local_date", postgresql_where=sql_text("status = 'active'")),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    local_date: Mapped[date] = mapped_column(Date(), primary_key=True)
    slot: Mapped[int] = mapped_column(SmallInteger(), primary_key=True)
    template_code: Mapped[str] = mapped_column(String(40), nullable=False)
    kind: Mapped[str] = mapped_column(String(24), nullable=False)
    target: Mapped[int] = mapped_column(Integer(), nullable=False)
    progress: Mapped[int] = mapped_column(Integer(), nullable=False, server_default=sql_text("0"))
    status: Mapped[str] = mapped_column(String(10), nullable=False)
    reward_xp: Mapped[int] = mapped_column(Integer(), nullable=False)
    reward_til: Mapped[int] = mapped_column(Integer(), nullable=False)
    completed_at: Mapped[datetime | None] = mapped_column(TS)
    rules_version: Mapped[int] = mapped_column(Integer(), nullable=False)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class Badge(Base):
    """Выданный значок (неизменяем): основание — метрика, значение и порог на момент выдачи, событие."""

    __tablename__ = "badges"
    __table_args__ = (
        CheckConstraint(f"metric {_in(BADGE_METRICS)}", name="ck_badges_metric"),
        Index("ix_badges_earned", "earned_at"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    badge_code: Mapped[str] = mapped_column(String(40), primary_key=True)
    metric: Mapped[str] = mapped_column(String(16), nullable=False)
    value: Mapped[int] = mapped_column(Integer(), nullable=False)
    threshold: Mapped[int] = mapped_column(Integer(), nullable=False)
    event_id: Mapped[str | None] = mapped_column(String(64))
    earned_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class BadgeTemplate(Base):
    """Тексты значков RU/UZ по семействам (first_lesson, streak, skills, skill_retained, reviews, readings,
    first_freeze): `{n}` — порог, `{unit}` — единица с согласованием числа (unit: {ru: [1, 2–4, 5+], uz})."""

    __tablename__ = "badge_templates"
    __table_args__ = (
        CheckConstraint(f"metric {_in(BADGE_METRICS)}", name="ck_badge_templates_metric"),
    )

    code: Mapped[str] = mapped_column(String(40), primary_key=True)
    metric: Mapped[str] = mapped_column(String(16), nullable=False)
    title: Mapped[dict[str, str]] = mapped_column(JSONB(), nullable=False)
    description: Mapped[dict[str, str]] = mapped_column(JSONB(), nullable=False)
    unit: Mapped[dict[str, Any] | None] = mapped_column(JSONB(none_as_null=True))
    asset_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    order: Mapped[int] = mapped_column(SmallInteger(), nullable=False)


class RulesVersion(Base):
    """Правила игры (§1.3): одна draft, одна active (частичные UNIQUE). Активная и архивные неизменяемы (триггер):
    допустим только перевод active → archived при новой активации."""

    __tablename__ = "rules_versions"
    __table_args__ = (
        CheckConstraint(f"status {_in(RULES_STATUSES)}", name="ck_rules_versions_status"),
        CheckConstraint("version >= 1", name="ck_rules_versions_version"),
        CheckConstraint("status = 'draft' OR activated_at IS NOT NULL", name="ck_rules_versions_activated"),
        Index("uq_rules_versions_draft", "status", unique=True, postgresql_where=sql_text("status = 'draft'")),
        Index("uq_rules_versions_active", "status", unique=True, postgresql_where=sql_text("status = 'active'")),
    )

    version: Mapped[int] = mapped_column(Integer(), primary_key=True, autoincrement=False)
    status: Mapped[str] = mapped_column(String(10), nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB(), nullable=False)
    comment: Mapped[str | None] = mapped_column(String(300))
    based_on: Mapped[int | None] = mapped_column(Integer())
    created_by: Mapped[str] = mapped_column(String(64), nullable=False)
    created_by_name: Mapped[str | None] = mapped_column(String(120))
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    validated_at: Mapped[datetime | None] = mapped_column(TS)
    activated_by: Mapped[str | None] = mapped_column(String(64))
    activated_by_name: Mapped[str | None] = mapped_column(String(120))
    activated_at: Mapped[datetime | None] = mapped_column(TS)


class Hero(Base):
    """Каталог героев: живые поля + черновик (draft — JSON тех же полей). Публикация — draft → живые, version + 1."""

    __tablename__ = "heroes"
    __table_args__ = (
        CheckConstraint(f"line {_in(HERO_LINES)}", name="ck_heroes_line"),
        CheckConstraint("code ~ '^(robot|pet|human)_[0-9]$'", name="ck_heroes_code"),
    )

    code: Mapped[str] = mapped_column(String(16), primary_key=True)
    line: Mapped[str] = mapped_column(String(8), nullable=False)
    order: Mapped[int] = mapped_column(SmallInteger(), nullable=False)
    name: Mapped[dict[str, str]] = mapped_column(JSONB(), nullable=False)
    tagline: Mapped[dict[str, str]] = mapped_column(JSONB(), nullable=False)
    audiences: Mapped[list[str]] = mapped_column(JSONB(), nullable=False)
    stages: Mapped[list[dict[str, Any]]] = mapped_column(JSONB(), nullable=False)
    draft: Mapped[dict[str, Any] | None] = mapped_column(JSONB(none_as_null=True))
    draft_updated_at: Mapped[datetime | None] = mapped_column(TS)
    version: Mapped[int] = mapped_column(Integer(), nullable=False, server_default=sql_text("1"))
    published_at: Mapped[datetime | None] = mapped_column(TS)
    published_by: Mapped[str | None] = mapped_column(String(64))
    published_by_name: Mapped[str | None] = mapped_column(String(120))
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class Asset(Base):
    """Картинка (webp | png, ≤ 300 КБ, ≤ 1024×1024): байты + sha256; не изменяется (триггер)."""

    __tablename__ = "assets"
    __table_args__ = (
        CheckConstraint("mime IN ('image/webp','image/png')", name="ck_assets_mime"),
        CheckConstraint(f"purpose {_in(ASSET_PURPOSES)}", name="ck_assets_purpose"),
        CheckConstraint("width BETWEEN 1 AND 4096 AND height BETWEEN 1 AND 4096 AND size >= 1",
                        name="ck_assets_dims"),
        UniqueConstraint("sha256", "purpose", name="uq_assets_sha_purpose"),
    )

    asset_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    mime: Mapped[str] = mapped_column(String(10), nullable=False)
    data: Mapped[bytes] = mapped_column("bytes", LargeBinary(), nullable=False)
    width: Mapped[int] = mapped_column(Integer(), nullable=False)
    height: Mapped[int] = mapped_column(Integer(), nullable=False)
    size: Mapped[int] = mapped_column(Integer(), nullable=False)
    purpose: Mapped[str] = mapped_column(String(10), nullable=False)
    uploaded_by: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class ShopItem(Base):
    """Предмет магазина: косметика (фон, рамка героя) и заморозка (единственная, цена и запас — из правил)."""

    __tablename__ = "shop_items"
    __table_args__ = (
        CheckConstraint(f"kind {_in(SHOP_KINDS)}", name="ck_shop_items_kind"),
        CheckConstraint(f"status {_in(SHOP_STATUSES)}", name="ck_shop_items_status"),
        CheckConstraint("price_til BETWEEN 1 AND 10000", name="ck_shop_items_price"),
        CheckConstraint("(kind = 'streak_freeze') = (code = 'streak_freeze')", name="ck_shop_items_freeze"),
        CheckConstraint("available_until IS NULL OR available_from IS NULL OR available_until > available_from",
                        name="ck_shop_items_window"),
        CheckConstraint("code ~ '^[a-z0-9_]{3,40}$'", name="ck_shop_items_code"),
    )

    code: Mapped[str] = mapped_column(String(40), primary_key=True)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    title: Mapped[dict[str, str]] = mapped_column(JSONB(), nullable=False)
    description: Mapped[dict[str, str]] = mapped_column(JSONB(), nullable=False)
    asset_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    theme: Mapped[dict[str, str] | None] = mapped_column(JSONB(none_as_null=True))
    price_til: Mapped[int] = mapped_column(Integer(), nullable=False)
    audiences: Mapped[list[str]] = mapped_column(JSONB(), nullable=False)
    available_from: Mapped[datetime | None] = mapped_column(TS)
    available_until: Mapped[datetime | None] = mapped_column(TS)
    status: Mapped[str] = mapped_column(String(10), nullable=False)
    order: Mapped[int] = mapped_column(SmallInteger(), nullable=False, server_default=sql_text("0"))
    created_by: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class GameEvent(Base):
    """Событие недели: период ≤ 14 дней, аудитория, множители XP/тилов по виду действия."""

    __tablename__ = "game_events"
    __table_args__ = (
        CheckConstraint(f"status {_in(EVENT_STATUSES)}", name="ck_game_events_status"),
        CheckConstraint("ends_at > starts_at", name="ck_game_events_period"),
        CheckConstraint("code ~ '^[a-z0-9_]{3,40}$'", name="ck_game_events_code"),
        UniqueConstraint("code", name="uq_game_events_code"),
        Index("ix_game_events_status", "status", "starts_at"),
    )

    event_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    code: Mapped[str] = mapped_column(String(40), nullable=False)
    title: Mapped[dict[str, str]] = mapped_column(JSONB(), nullable=False)
    description: Mapped[dict[str, str]] = mapped_column(JSONB(), nullable=False)
    starts_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    ends_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    audiences: Mapped[list[str]] = mapped_column(JSONB(), nullable=False)
    multipliers: Mapped[list[dict[str, Any]]] = mapped_column(JSONB(), nullable=False)
    status: Mapped[str] = mapped_column(String(10), nullable=False)
    created_by: Mapped[str] = mapped_column(String(64), nullable=False)
    created_by_name: Mapped[str | None] = mapped_column(String(120))
    published_by: Mapped[str | None] = mapped_column(String(64))
    published_by_name: Mapped[str | None] = mapped_column(String(120))
    published_at: Mapped[datetime | None] = mapped_column(TS)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class DailyStat(Base):
    """Обезличенная статистика дня (переживает удаление учеников): (день, аудитория, метрика) → значение."""

    __tablename__ = "daily_stats"
    __table_args__ = (
        CheckConstraint(f"audience {_in(AUDIENCES)}", name="ck_daily_stats_audience"),
    )

    local_date: Mapped[date] = mapped_column(Date(), primary_key=True)
    audience: Mapped[str] = mapped_column(String(8), primary_key=True)
    metric: Mapped[str] = mapped_column(String(24), primary_key=True)
    value: Mapped[int] = mapped_column(BigInteger(), nullable=False, server_default=sql_text("0"))


class SessionReward(Base):
    """Итоги занятия для экрана наград (§1.8): событие сессии обработано; рост уровня и ступени, значки, задания.
    evaluation_id — оценка урока: награды навыков с evidence_id = evaluation_id относятся к этому занятию в любом
    порядке событий. op_ids — операции, привязанные к занятию после проводки (реестр неизменяем: source_session_id
    у них пуст, связь — здесь)."""

    __tablename__ = "session_rewards"
    __table_args__ = (
        Index("ix_session_rewards_session", "session_id"),
        Index("ix_session_rewards_evaluation", "user_id", "evaluation_id",
              postgresql_where=sql_text("evaluation_id IS NOT NULL")),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    session_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    evaluation_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    op_ids: Mapped[list[str]] = mapped_column(JSONB(), nullable=False, server_default=sql_text("'[]'::jsonb"))
    level_from: Mapped[int | None] = mapped_column(SmallInteger())
    level_to: Mapped[int | None] = mapped_column(SmallInteger())
    stage_from: Mapped[int | None] = mapped_column(SmallInteger())
    stage_to: Mapped[int | None] = mapped_column(SmallInteger())
    badges: Mapped[list[str]] = mapped_column(JSONB(), nullable=False, server_default=sql_text("'[]'::jsonb"))
    quests: Mapped[list[list[Any]]] = mapped_column(JSONB(), nullable=False, server_default=sql_text("'[]'::jsonb"))
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class EvidenceReward(Base):
    """Итоги навыков по доказательству (evidence_id), пришедшие раньше события урока с тем же evaluation_id: когда урок
    придёт, они переносятся в его session_rewards. Не связанные за IDEMPOTENCY_DAYS — удаляются tick."""

    __tablename__ = "evidence_rewards"
    __table_args__ = (Index("ix_evidence_rewards_created", "created_at"),)

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    evidence_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    level_from: Mapped[int | None] = mapped_column(SmallInteger())
    level_to: Mapped[int | None] = mapped_column(SmallInteger())
    stage_from: Mapped[int | None] = mapped_column(SmallInteger())
    stage_to: Mapped[int | None] = mapped_column(SmallInteger())
    badges: Mapped[list[str]] = mapped_column(JSONB(), nullable=False, server_default=sql_text("'[]'::jsonb"))
    quests: Mapped[list[list[Any]]] = mapped_column(JSONB(), nullable=False, server_default=sql_text("'[]'::jsonb"))
    op_ids: Mapped[list[str]] = mapped_column(JSONB(), nullable=False, server_default=sql_text("'[]'::jsonb"))
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class Idempotency(Base):
    """Idempotency-Key команд сотрудников (создание предмета и события, ручная операция): повтор — тот же ответ."""

    __tablename__ = "idempotency"
    __table_args__ = (Index("ix_idempotency_created", "created_at"),)

    scope: Mapped[str] = mapped_column(String(48), primary_key=True)
    actor: Mapped[str] = mapped_column(String(80), primary_key=True)
    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    status_code: Mapped[int] = mapped_column(SmallInteger(), nullable=False)
    response: Mapped[dict[str, Any]] = mapped_column(JSONB(), nullable=False)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class DeletedUser(Base):
    """Отметка исполненного удаления: события после удаления не воскрешают данные ученика."""

    __tablename__ = "deleted_users"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    request_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    deleted_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class TickState(Base):
    """Время последнего прохода редких шагов tick (сверка кошельков раз в сутки)."""

    __tablename__ = "tick_state"

    name: Mapped[str] = mapped_column(String(32), primary_key=True)
    last_run_at: Mapped[datetime] = mapped_column(TS, nullable=False)


# ===================================================================================================================
# Спринт 7: проекции social и diagnostics (INTERNAL_API спринта 7 §2.1). Запоздавшее событие не откатывает более
# новое (changed_at / updated_at / completed_at); события удалённых учеников не воскрешают данные.
# ===================================================================================================================


class SocialFriend(Base):
    """Дружба из social.friendship.changed.v1: пара упорядочена (user_a < user_b по строке UUID), status — последний
    известный (added | removed)."""

    __tablename__ = "social_friends"
    __table_args__ = (
        CheckConstraint("status IN ('added','removed')", name="ck_social_friends_status"),
        CheckConstraint("user_a <> user_b", name="ck_social_friends_pair"),
        Index("ix_social_friends_b", "user_b", postgresql_where=sql_text("status = 'added'")),
    )

    user_a: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    user_b: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    status: Mapped[str] = mapped_column(String(8), nullable=False)
    changed_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class SocialBlock(Base):
    """Блокировка A→B (односторонняя) из social.block.changed.v1."""

    __tablename__ = "social_blocks"
    __table_args__ = (
        CheckConstraint("status IN ('added','removed')", name="ck_social_blocks_status"),
        Index("ix_social_blocks_blocked", "blocked_user_id", postgresql_where=sql_text("status = 'added'")),
    )

    blocker_user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    blocked_user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    status: Mapped[str] = mapped_column(String(8), nullable=False)
    changed_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class Community(Base):
    """Профиль сообщества из social.profile.updated.v1: member_id, ник, скрытие игрового профиля."""

    __tablename__ = "community"
    __table_args__ = (UniqueConstraint("member_id", name="uq_community_member"),)

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    member_id: Mapped[str] = mapped_column(String(25), nullable=False)
    nickname: Mapped[str | None] = mapped_column(String(20))
    hidden: Mapped[bool] = mapped_column(Boolean(), nullable=False, server_default=sql_text("false"))
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class FamilyMember(Base):
    """Семья из social.family.member_added.v1 (участник и владелец семьи); ученик — не больше чем в одной семье."""

    __tablename__ = "family_members"
    __table_args__ = (
        CheckConstraint(f"role {_in(FAMILY_ROLES)}", name="ck_family_members_role"),
        Index("ix_family_members_family", "family_id"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    family_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    role: Mapped[str] = mapped_column(String(8), nullable=False)
    added_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class Sanction(Base):
    """Санкция из social.sanction.changed.v1 (без основания). Действует social_ban: active и (until null или в
    будущем)."""

    __tablename__ = "sanctions"
    __table_args__ = (
        CheckConstraint(f"kind {_in(SANCTION_KINDS)}", name="ck_sanctions_kind"),
        Index("ix_sanctions_user_active", "user_id", postgresql_where=sql_text("active AND kind = 'social_ban'")),
    )

    sanction_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    until: Mapped[datetime | None] = mapped_column(TS)
    active: Mapped[bool] = mapped_column(Boolean(), nullable=False)
    changed_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class LearnerLevel(Base):
    """Полоса уровня для лиги и дуэли из diagnostics.completed.v1 (provisional_level: A0/A1 → A0-A1, A2, B1/B2 →
    B1+). Активная пара ученика — пара последней диагностики."""

    __tablename__ = "learner_levels"
    __table_args__ = (CheckConstraint(f"level_band {_in(LEVEL_BANDS)}", name="ck_learner_levels_band"),)

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    pair_id: Mapped[str] = mapped_column(String(16), primary_key=True)
    level_band: Mapped[str] = mapped_column(String(6), nullable=False)
    result_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    completed_at: Mapped[datetime] = mapped_column(TS, nullable=False)


# ===================================================================================================================
# Спринт 7: лиги недели (§2.2), дуэли (§2.3), реферальные награды (§2.4)
# ===================================================================================================================


class LeagueWeek(Base):
    """Неделя лиг (понедельник по LEAGUE_TIMEZONE): open → closing (с этого момента XP с временем этой недели идёт в
    текущую; отметка ставится под исключительной advisory-блокировкой недели) → closed (все группы закрыты)."""

    __tablename__ = "league_weeks"
    __table_args__ = (CheckConstraint(f"status {_in(LEAGUE_WEEK_STATUSES)}", name="ck_league_weeks_status"),)

    week: Mapped[date] = mapped_column(Date(), primary_key=True)
    status: Mapped[str] = mapped_column(String(8), nullable=False)
    formed_at: Mapped[datetime | None] = mapped_column(TS)
    closing_at: Mapped[datetime | None] = mapped_column(TS)
    closed_at: Mapped[datetime | None] = mapped_column(TS)
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class LeagueGroup(Base):
    """Группа общей лиги (неделя, пара, полоса, номер): open → closed | held (призы удержаны — аномалия)."""

    __tablename__ = "league_groups"
    __table_args__ = (
        CheckConstraint(f"status {_in(LEAGUE_GROUP_STATUSES)}", name="ck_league_groups_status"),
        CheckConstraint(f"level_band {_in(LEVEL_BANDS)}", name="ck_league_groups_band"),
        CheckConstraint("group_no >= 1", name="ck_league_groups_no"),
        UniqueConstraint("week", "pair_id", "level_band", "group_no", name="uq_league_groups_no"),
        Index("ix_league_groups_week_status", "week", "status"),
    )

    group_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    week: Mapped[date] = mapped_column(Date(), nullable=False)
    pair_id: Mapped[str] = mapped_column(String(16), nullable=False)
    level_band: Mapped[str] = mapped_column(String(6), nullable=False)
    group_no: Mapped[int] = mapped_column(SmallInteger(), nullable=False)
    status: Mapped[str] = mapped_column(String(6), nullable=False)
    version: Mapped[int | None] = mapped_column(Integer())
    anomalies: Mapped[int] = mapped_column(SmallInteger(), nullable=False, server_default=sql_text("0"))
    closed_at: Mapped[datetime | None] = mapped_column(TS)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class LeagueMember(Base):
    """Участник группы недели: один на неделю. left_at — выключил участие (доигрывает без строки в рейтинге)."""

    __tablename__ = "league_members"
    __table_args__ = (Index("ix_league_members_group", "group_id"),)

    week: Mapped[date] = mapped_column(Date(), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    group_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    joined_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    left_at: Mapped[datetime | None] = mapped_column(TS)


class LeagueResult(Base):
    """Итоги группы — неизменяемы (триггер): переоценка добавляет версию, прежняя хранится. standings:
    [{user_id | null (обезличено сагой), place, xp, prize_til, anomaly}]; closed_by — system | staff:<id>."""

    __tablename__ = "league_results"
    __table_args__ = (
        CheckConstraint("version >= 1", name="ck_league_results_version"),
        CheckConstraint("closed_by = 'system' OR closed_by LIKE 'staff:%'", name="ck_league_results_by"),
        Index("ix_league_results_week", "week"),
    )

    group_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    version: Mapped[int] = mapped_column(Integer(), primary_key=True, autoincrement=False)
    week: Mapped[date] = mapped_column(Date(), nullable=False)
    standings: Mapped[list[dict[str, Any]]] = mapped_column(JSONB(), nullable=False)
    prizes_held: Mapped[bool] = mapped_column(Boolean(), nullable=False)
    excluded_user_ids: Mapped[list[str]] = mapped_column(JSONB(), nullable=False,
                                                         server_default=sql_text("'[]'::jsonb"))
    closed_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    closed_by: Mapped[str] = mapped_column(String(80), nullable=False)
    closed_by_name: Mapped[str | None] = mapped_column(String(120))
    reason: Mapped[str | None] = mapped_column(String(500))


class Duel(Base):
    """Дуэль (§2.3): challenged → accepted → finished | cancelled; declined, expired. scores — по ролям
    {challenger | opponent: {correct, total, session_id, finished_at}}; rewards — операции XP по версиям результата;
    eligible — роль уложилась в дневной лимит наградных дуэлей при завершении. pair_key — упорядоченная пара учеников
    (не больше одной активной дуэли на пару); challenger / opponent / pair_key → null — обезличено сагой удаления."""

    __tablename__ = "duels"
    __table_args__ = (
        CheckConstraint(f"status {_in(DUEL_STATUSES)}", name="ck_duels_status"),
        CheckConstraint(f"result IS NULL OR result {_in(DUEL_RESULTS)}", name="ck_duels_result"),
        CheckConstraint(f"level_band {_in(LEVEL_BANDS)}", name="ck_duels_band"),
        CheckConstraint("challenger IS NULL OR opponent IS NULL OR challenger <> opponent", name="ck_duels_self"),
        CheckConstraint("result_version >= 0", name="ck_duels_version"),
        UniqueConstraint("challenger", "idempotency_key", name="uq_duels_idempotency"),
        Index("uq_duels_active_pair", "pair_key", unique=True,
              postgresql_where=sql_text("status IN ('challenged','accepted')")),
        Index("ix_duels_challenger", "challenger", "status"),
        Index("ix_duels_opponent", "opponent", "status"),
        Index("ix_duels_challenged", "accept_deadline", postgresql_where=sql_text("status = 'challenged'")),
        Index("ix_duels_accepted", "play_deadline", postgresql_where=sql_text("status = 'accepted'")),
        Index("ix_duels_created", "created_at", "duel_id"),
        Index("ix_duels_finished", "finished_at", postgresql_where=sql_text("status = 'finished'")),
    )

    duel_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    challenger: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    opponent: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    pair_key: Mapped[str | None] = mapped_column(String(80))
    pair_id: Mapped[str] = mapped_column(String(16), nullable=False)
    level_band: Mapped[str] = mapped_column(String(6), nullable=False)
    status: Mapped[str] = mapped_column(String(10), nullable=False)
    set_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    accept_deadline: Mapped[datetime] = mapped_column(TS, nullable=False)
    play_deadline: Mapped[datetime | None] = mapped_column(TS)
    scores: Mapped[dict[str, Any]] = mapped_column(JSONB(), nullable=False, server_default=sql_text("'{}'::jsonb"))
    result: Mapped[str | None] = mapped_column(String(10))
    technical: Mapped[bool] = mapped_column(Boolean(), nullable=False, server_default=sql_text("false"))
    result_version: Mapped[int] = mapped_column(Integer(), nullable=False, server_default=sql_text("0"))
    rewards: Mapped[list[dict[str, Any]]] = mapped_column(JSONB(), nullable=False,
                                                          server_default=sql_text("'[]'::jsonb"))
    eligible: Mapped[dict[str, bool]] = mapped_column(JSONB(), nullable=False, server_default=sql_text("'{}'::jsonb"))
    idempotency_key: Mapped[str] = mapped_column(String(128), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    accepted_at: Mapped[datetime | None] = mapped_column(TS)
    finished_at: Mapped[datetime | None] = mapped_column(TS)
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class DuelResultHistory(Base):
    """Версии результата дуэли (неизменяемы, триггер): версия 1 — завершение, далее — переоценки сотрудником."""

    __tablename__ = "duel_results_history"
    __table_args__ = (CheckConstraint(f"result {_in(DUEL_RESULTS)}", name="ck_duel_results_history_result"),)

    duel_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    version: Mapped[int] = mapped_column(Integer(), primary_key=True, autoincrement=False)
    result: Mapped[str] = mapped_column(String(10), nullable=False)
    technical: Mapped[bool] = mapped_column(Boolean(), nullable=False)
    reason: Mapped[str | None] = mapped_column(String(500))
    decided_by: Mapped[str | None] = mapped_column(String(80))
    decided_by_name: Mapped[str | None] = mapped_column(String(120))
    at: Mapped[datetime] = mapped_column(TS, nullable=False)


class ReferralReward(Base):
    """Награды по social.referral.qualified.v1 (§2.4): одна строка на реферал; операции — op_ids. Пригласивший или
    приглашённый → null — обезличено сагой удаления."""

    __tablename__ = "referral_rewards"
    __table_args__ = (
        CheckConstraint(f"outcome {_in(REFERRAL_OUTCOMES)}", name="ck_referral_rewards_outcome"),
        Index("ix_referral_rewards_inviter", "inviter_user_id", "qualified_at"),
        Index("ix_referral_rewards_invitee", "invitee_user_id"),
    )

    referral_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    inviter_user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    invitee_user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    campaign_version: Mapped[int] = mapped_column(Integer(), nullable=False)
    # rewarded — награды выданы; inviter_capped — пригласившему нет (месячный лимит с наградами спринта 6);
    # legacy — приглашённый уже награждён (или упёрся в лимит) по правилу спринта 6: награды пригласившему нет
    outcome: Mapped[str] = mapped_column(String(16), nullable=False, server_default=sql_text("'rewarded'"))
    op_ids: Mapped[list[str]] = mapped_column(JSONB(), nullable=False, server_default=sql_text("'[]'::jsonb"))
    rewarded_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    # qualified_at события — месяц лимита пригласившего (как в social)
    qualified_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class PairAward(Base):
    """Награды участника парного урока (одна строка на комнату и ученика — повтор события не учитывается дважды):
    XP за вклад (0 — без вклада, комната не finished, меньше min_turns ходов или дневной лимит) и значок «Вместе»."""

    __tablename__ = "pair_awards"
    __table_args__ = (
        CheckConstraint("xp >= 0", name="ck_pair_awards_xp"),
        Index("ix_pair_awards_user_day", "user_id", "local_date"),
    )

    room_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    xp: Mapped[int] = mapped_column(Integer(), nullable=False)
    together: Mapped[bool] = mapped_column(Boolean(), nullable=False)
    local_date: Mapped[date] = mapped_column(Date(), nullable=False)
    at: Mapped[datetime] = mapped_column(TS, nullable=False)


class ProjectionLoad(Base):
    """Разовая загрузка проекции из выгрузки источника (social families / friendships, diagnostics levels): курсор
    продолжения после сбоя, completed_at — загрузка завершена."""

    __tablename__ = "projection_loads"
    __table_args__ = (CheckConstraint(f"name {_in(PROJECTIONS)}", name="ck_projection_loads_name"),)

    name: Mapped[str] = mapped_column(String(16), primary_key=True)
    cursor: Mapped[str | None] = mapped_column(String(500))
    items: Mapped[int] = mapped_column(Integer(), nullable=False, server_default=sql_text("0"))
    attempted_at: Mapped[datetime | None] = mapped_column(TS)
    completed_at: Mapped[datetime | None] = mapped_column(TS)
    error: Mapped[str | None] = mapped_column(String(64))
