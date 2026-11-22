"""Модели social — зеркало миграций 0001 и 0002 (UNIQUE, индексы, FK и CHECK объявлены и здесь: тест schema_drift).

user_id — аккаунт (sub внутреннего токена для social) или детский профиль (член семьи опекуна). PII не хранится:
имена берутся у identity-consent при выдаче ответа.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    SmallInteger,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy import text as sql_text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

TS = DateTime(timezone=True)


class Base(DeclarativeBase):
    pass


class Invite(Base):
    """Приглашение по deep link `startapp=inv_<token>`. Токен не хранится: token_hash = sha256(token),
    token = base64url(HMAC-SHA256(INVITE_TOKEN_KEY, invite_id))[:32] — создатель видит ссылку повторно."""

    __tablename__ = "invites"
    __table_args__ = (
        UniqueConstraint("inviter_user_id", "idempotency_key", name="uq_invites_inviter_idempotency"),
        CheckConstraint("kind IN ('family','friend','referral')", name="ck_invites_kind"),
        CheckConstraint("status IN ('active','accepted','revoked','expired')", name="ck_invites_status"),
        CheckConstraint("max_uses IS NULL OR max_uses >= 1", name="ck_invites_max_uses"),
        CheckConstraint("uses >= 0", name="ck_invites_uses"),
        Index("ix_invites_inviter_created", "inviter_user_id", "created_at"),
        Index("ix_invites_status_expires", "status", "expires_at"),
    )

    invite_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    inviter_user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    max_uses: Mapped[int | None] = mapped_column(Integer())
    uses: Mapped[int] = mapped_column(Integer(), nullable=False, server_default="0")
    expires_at: Mapped[datetime | None] = mapped_column(TS)
    idempotency_key: Mapped[str] = mapped_column(String(128), nullable=False)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class InviteRedemption(Base):
    """Получатель открыл приглашение (строка появляется при первом :open) и ответил на него."""

    __tablename__ = "invite_redemptions"
    __table_args__ = (
        Index("ix_redemptions_invitee", "invitee_user_id"),
        Index("ix_redemptions_opened", "opened_at"),
    )

    invite_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("invites.invite_id", ondelete="CASCADE", name="fk_redemptions_invite"),
        primary_key=True)
    invitee_user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    opened_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    accepted_at: Mapped[datetime | None] = mapped_column(TS)
    declined_at: Mapped[datetime | None] = mapped_column(TS)
    reminded_at: Mapped[datetime | None] = mapped_column(TS)


class Family(Base):
    __tablename__ = "families"

    family_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    owner_user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, unique=True)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())


class FamilyMember(Base):
    """Пользователь состоит не больше чем в одной семье (user_id UNIQUE)."""

    __tablename__ = "family_members"
    __table_args__ = (
        UniqueConstraint("user_id", name="uq_family_members_user"),
        CheckConstraint("role IN ('owner','adult','teen','child')", name="ck_family_members_role"),
    )

    family_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("families.family_id", ondelete="CASCADE", name="fk_family_members_family"),
        primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    role: Mapped[str] = mapped_column(String(8), nullable=False)
    joined_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class Friendship(Base):
    """Дружба — упорядоченная пара (user_a < user_b). Спринт 1 — только создание через приглашение."""

    __tablename__ = "friendships"
    __table_args__ = (
        CheckConstraint("user_a < user_b", name="ck_friendships_order"),
        Index("ix_friendships_user_b", "user_b"),
    )

    user_a: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    user_b: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    invite_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class Profile(Base):
    """Проекция из user.profile.created/updated.v1: вид профиля и согласие родителя (14–17) — запасной источник,
    если в ответе identity-consent `/users/{id}/public` нет `guardian_consent`. Возраст и опекуна social не хранит
    (CONVENTIONS §8, ревью P-6): решения по возрасту — по ответу `/public`, опекун ребёнка берётся из события
    user.profile.created.v1 в момент добавления в семью. Без имени и даты рождения."""

    __tablename__ = "profiles"
    __table_args__ = (
        CheckConstraint("kind IS NULL OR kind IN ('account','child')", name="ck_profiles_kind"),
        CheckConstraint("guardian_consent IS NULL OR guardian_consent IN "
                        "('not_required','pending','granted','declined')", name="ck_profiles_guardian_consent"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    kind: Mapped[str | None] = mapped_column(String(8))
    guardian_consent: Mapped[str | None] = mapped_column(String(16))
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())


class DeletedUser(Base):
    """Отметка исполненного удаления: запоздавшие события профиля не воскрешают данные. Без PII."""

    __tablename__ = "deleted_users"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    request_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    deleted_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())


# ===================================================================== спринт 7 (миграция 0002)


class MemberId(Base):
    """Реестр member_id → user_id (§0): member_id = "mb_" + base64url(HMAC-SHA256(MEMBER_ID_KEY, user_id)[:16]).
    Обратного вычисления нет: строка появляется, когда social впервые отдаёт или принимает member_id ученика."""

    __tablename__ = "member_ids"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    member_id: Mapped[str] = mapped_column(String(25), nullable=False, unique=True)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False, server_default=func.now())


class CommunityProfile(Base):
    """Профиль сообщества (§1.1): ник (nickname_lc — ключ уникальности: регистр, ё/е, двойники кириллица/латиница),
    код друга TH-XXXX-XXXX, скрытие игрового профиля. Создаётся лениво при первом обращении."""

    __tablename__ = "community_profiles"
    __table_args__ = (
        CheckConstraint("(nickname IS NULL) = (nickname_lc IS NULL)", name="ck_community_nickname_pair"),
        CheckConstraint("code_rotations >= 0", name="ck_community_code_rotations"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    nickname: Mapped[str | None] = mapped_column(String(20))
    nickname_lc: Mapped[str | None] = mapped_column(String(20), unique=True)
    friend_code: Mapped[str] = mapped_column(String(12), nullable=False, unique=True)
    game_profile_hidden: Mapped[bool] = mapped_column(Boolean(), nullable=False, server_default=sql_text("false"))
    nickname_changed_at: Mapped[datetime | None] = mapped_column(TS)
    nickname_reset_at: Mapped[datetime | None] = mapped_column(TS)
    code_window_start: Mapped[datetime | None] = mapped_column(TS)
    code_rotations: Mapped[int] = mapped_column(SmallInteger(), nullable=False, server_default="0")
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class FriendRequest(Base):
    """Заявка в друзья (§1.2). Один pending на неупорядоченную пару (pair_a < pair_b, частичный UNIQUE)."""

    __tablename__ = "friend_requests"
    __table_args__ = (
        CheckConstraint("status IN ('pending','accepted','declined','cancelled','expired')",
                        name="ck_friend_requests_status"),
        CheckConstraint("from_user <> to_user", name="ck_friend_requests_self"),
        CheckConstraint("pair_a < pair_b", name="ck_friend_requests_pair"),
        Index("uq_friend_requests_pending", "pair_a", "pair_b", unique=True,
              postgresql_where=sql_text("status = 'pending'")),
        Index("ix_friend_requests_to", "to_user", "created_at"),
        Index("ix_friend_requests_from", "from_user", "created_at"),
        Index("ix_friend_requests_pending_created", "created_at", postgresql_where=sql_text("status = 'pending'")),
    )

    request_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    from_user: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    to_user: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    pair_a: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    pair_b: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    decided_at: Mapped[datetime | None] = mapped_column(TS)


class Block(Base):
    """Блокировка blocker → blocked (односторонняя)."""

    __tablename__ = "blocks"
    __table_args__ = (
        CheckConstraint("blocker <> blocked", name="ck_blocks_self"),
        Index("ix_blocks_blocked", "blocked"),
    )

    blocker: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    blocked: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class Case(Base):
    """Дело модерации (§1.3) по жалобе. Без переписки: предмет жалобы, ник цели на момент жалобы, комментарий
    жалобщика. Сага обезличивает: reporter/target → null, решение и основание остаются."""

    __tablename__ = "cases"
    __table_args__ = (
        CheckConstraint("subject_kind IN ('user','nickname','friend_request','invite','duel','pair_room')",
                        name="ck_cases_subject_kind"),
        CheckConstraint("reason IN ('spam','abuse','inappropriate_nickname','cheating','other')",
                        name="ck_cases_reason"),
        CheckConstraint("status IN ('open','resolved','dismissed')", name="ck_cases_status"),
        CheckConstraint("resolution IS NULL OR resolution IN ('dismiss','warning','social_ban','nickname_reset')",
                        name="ck_cases_resolution"),
        Index("ix_cases_status_created", "status", "created_at"),
        Index("ix_cases_target_created", "target_user_id", "created_at"),
        Index("ix_cases_reporter_created", "reporter_user_id", "created_at"),
    )

    case_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    reporter_user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    target_user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    subject_kind: Mapped[str] = mapped_column(String(16), nullable=False)
    subject_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    reason: Mapped[str] = mapped_column(String(32), nullable=False)
    comment: Mapped[str | None] = mapped_column(String(500))
    target_nickname_at_report: Mapped[str | None] = mapped_column(String(20))
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    resolution: Mapped[str | None] = mapped_column(String(16))
    resolution_basis: Mapped[str | None] = mapped_column(String(500))
    sanction_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    resolved_by: Mapped[str | None] = mapped_column(String(64))
    resolved_by_name: Mapped[str | None] = mapped_column(String(120))
    resolved_at: Mapped[datetime | None] = mapped_column(TS)


class Sanction(Base):
    """Санкция (§1.3): warning | social_ban (until; null — бессрочно) | nickname_reset. Снятие — revoked_*,
    истечение срока — expired_at (tick, событие active=false). Сага удаляет санкции ученика (обжалования — каскадом)."""

    __tablename__ = "sanctions"
    __table_args__ = (
        CheckConstraint("kind IN ('warning','social_ban','nickname_reset')", name="ck_sanctions_kind"),
        CheckConstraint("until IS NULL OR kind = 'social_ban'", name="ck_sanctions_until"),
        Index("ix_sanctions_user", "user_id", "decided_at"),
        Index("ix_sanctions_ban_until", "until",
              postgresql_where=sql_text("kind = 'social_ban' AND revoked_at IS NULL AND expired_at IS NULL")),
    )

    sanction_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    until: Mapped[datetime | None] = mapped_column(TS)
    basis: Mapped[str] = mapped_column(String(500), nullable=False)
    case_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    decided_by: Mapped[str] = mapped_column(String(64), nullable=False)
    decided_by_name: Mapped[str] = mapped_column(String(120), nullable=False)
    decided_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(TS)
    revoked_by: Mapped[str | None] = mapped_column(String(64))
    revoked_by_name: Mapped[str | None] = mapped_column(String(120))
    revoke_reason: Mapped[str | None] = mapped_column(String(500))
    expired_at: Mapped[datetime | None] = mapped_column(TS)


class Appeal(Base):
    """Обжалование санкции — одно на санкцию."""

    __tablename__ = "appeals"
    __table_args__ = (
        CheckConstraint("status IN ('open','upheld','overturned')", name="ck_appeals_status"),
        Index("ix_appeals_status_created", "status", "created_at"),
    )

    appeal_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    sanction_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("sanctions.sanction_id", ondelete="CASCADE", name="fk_appeals_sanction"),
        nullable=False, unique=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    text: Mapped[str] = mapped_column(String(1000), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(128), nullable=False)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    decided_by: Mapped[str | None] = mapped_column(String(64))
    decided_by_name: Mapped[str | None] = mapped_column(String(120))
    decided_at: Mapped[datetime | None] = mapped_column(TS)
    decision_note: Mapped[str | None] = mapped_column(String(500))


class ReferralCampaign(Base):
    """Версии реферальной кампании (§1.4): одна draft и одна active (частичные UNIQUE); версия 1 — миграцией."""

    __tablename__ = "referral_campaigns"
    __table_args__ = (
        CheckConstraint("status IN ('draft','active','archived')", name="ck_referral_campaigns_status"),
        Index("uq_referral_campaigns_draft", "status", unique=True, postgresql_where=sql_text("status = 'draft'")),
        Index("uq_referral_campaigns_active", "status", unique=True, postgresql_where=sql_text("status = 'active'")),
    )

    version: Mapped[int] = mapped_column(Integer(), primary_key=True, autoincrement=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB(), nullable=False)
    comment: Mapped[str | None] = mapped_column(String(500))
    based_on: Mapped[int | None] = mapped_column(Integer())
    created_by: Mapped[str | None] = mapped_column(String(64))
    created_by_name: Mapped[str | None] = mapped_column(String(120))
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    validated_at: Mapped[datetime | None] = mapped_column(TS)
    activated_by: Mapped[str | None] = mapped_column(String(64))
    activated_by_name: Mapped[str | None] = mapped_column(String(120))
    activated_at: Mapped[datetime | None] = mapped_column(TS)


class Referral(Base):
    """Реферал (§1.4): строка — из принятого приглашения kind referral. reject_code — публичный, risk_flags —
    внутренние (только админке). decision_history — решения операторов (пересмотр сохраняет прежнее)."""

    __tablename__ = "referrals"
    __table_args__ = (
        CheckConstraint("status IN ('invited','diagnostic_done','learning','review','qualified','rewarded',"
                        "'rejected','expired','capped')", name="ck_referrals_status"),
        CheckConstraint("reject_code IS NULL OR reject_code IN ('not_new_user','family_member','window_expired',"
                        "'review_rejected','monthly_cap')", name="ck_referrals_reject_code"),
        CheckConstraint("reward_outcome IS NULL OR reward_outcome IN ('rewarded','legacy','inviter_capped')",
                        name="ck_referrals_reward_outcome"),
        Index("ix_referrals_inviter", "inviter_user_id", "accepted_at"),
        Index("ix_referrals_status_accepted", "status", "accepted_at"),
        Index("ix_referrals_inviter_qualified", "inviter_user_id", "qualified_at",
              postgresql_where=sql_text("qualified_at IS NOT NULL")),
    )

    referral_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    inviter_user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    invitee_user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), unique=True)
    invite_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    campaign_version: Mapped[int] = mapped_column(
        Integer(), ForeignKey("referral_campaigns.version", name="fk_referrals_campaign"), nullable=False)
    accepted_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    diagnostic_at: Mapped[datetime | None] = mapped_column(TS)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    reject_code: Mapped[str | None] = mapped_column(String(32))
    risk_flags: Mapped[list[str]] = mapped_column(JSONB(), nullable=False, server_default=sql_text("'[]'::jsonb"))
    decided_by: Mapped[str | None] = mapped_column(String(64))
    decided_by_name: Mapped[str | None] = mapped_column(String(120))
    decided_at: Mapped[datetime | None] = mapped_column(TS)
    decision_note: Mapped[str | None] = mapped_column(String(500))
    decision_history: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB(), nullable=False, server_default=sql_text("'[]'::jsonb"))
    qualified_at: Mapped[datetime | None] = mapped_column(TS)
    rewarded_at: Mapped[datetime | None] = mapped_column(TS)
    # исход ack gamification (game.referral.rewarded.v1 outcome): rewarded — награда кампании; legacy — награда выдана
    # раньше по правилу спринта 6; inviter_capped — пригласивший не получил награду из-за месячного лимита
    reward_outcome: Mapped[str | None] = mapped_column(String(16))
    # момент первого открытия приглашения приглашённым (для «не новый ученик»)
    opened_at: Mapped[datetime | None] = mapped_column(TS)
    # перенесён миграцией из спринта 6: диагностика засчитана, окно — от выкладки (window_from), истечение — тихо
    legacy: Mapped[bool] = mapped_column(Boolean(), nullable=False, server_default=sql_text("false"))
    # начало окна условий; null — от принятия
    window_from: Mapped[datetime | None] = mapped_column(TS)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class ReferralLesson(Base):
    """Зачётный урок приглашённого (lesson.session.completed.v1 kind lesson, completed, practice_only=false) — одна
    запись на сессию (дубль session_id не считается). lesson_key — lesson_id (повтор урока считается один раз)."""

    __tablename__ = "referral_lessons"
    __table_args__ = (Index("ix_referral_lessons_referral", "referral_id"),)

    session_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    referral_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("referrals.referral_id", ondelete="CASCADE", name="fk_referral_lessons_ref"),
        nullable=False)
    lesson_key: Mapped[str] = mapped_column(String(200), nullable=False)
    local_date: Mapped[date] = mapped_column(Date(), nullable=False)
    minutes: Mapped[int] = mapped_column(Integer(), nullable=False)
    finished_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class LearnerActivity(Base):
    """Проекция активности (только для рефералов): регистрация, первый завершённый урок и первая диагностика ученика —
    «не новый ученик», занятия раньше принятия приглашения, диагностика до принятия. Без содержания занятий."""

    __tablename__ = "learner_activity"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    # регистрация (user.profile.created.v1 created_at); для учеников до спринта 7 — самый ранний известный social след
    # (профиль, приглашения, семья, дружба — миграция 0002): не позже настоящей регистрации
    first_seen_at: Mapped[datetime | None] = mapped_column(TS)
    first_lesson_at: Mapped[datetime | None] = mapped_column(TS)
    diagnostic_at: Mapped[datetime | None] = mapped_column(TS)
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class LearnerIdempotency(Base):
    """Idempotency-Key создающих команд ученика (заявка в друзья, жалоба): повтор — тот же ответ (200)."""

    __tablename__ = "learner_idempotency"
    __table_args__ = (Index("ix_learner_idempotency_created", "created_at"),)

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    scope: Mapped[str] = mapped_column(String(32), primary_key=True)
    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    status_code: Mapped[int] = mapped_column(SmallInteger(), nullable=False)
    response: Mapped[dict[str, Any]] = mapped_column(JSONB(), nullable=False)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class NicknameStop(Base):
    """Глобальный стоп-лист ников, сброшенных модератором (ключ уникальности): ник нельзя задать никому, в том числе
    тому, у кого его сбросили. Сага обезличивает user_id, ключ остаётся."""

    __tablename__ = "nickname_stoplist"

    nickname_lc: Mapped[str] = mapped_column(String(20), primary_key=True)
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    sanction_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False)


class Counter(Base):
    """Монотонные номера (версии реферальной кампании): удалённый черновик номер не освобождает."""

    __tablename__ = "counters"

    name: Mapped[str] = mapped_column(String(32), primary_key=True)
    value: Mapped[int] = mapped_column(Integer(), nullable=False)
