"""social спринт 7: member_ids, community_profiles, friend_requests, blocks, cases, sanctions, appeals,
referral_campaigns (версия 1 — active), referrals, referral_lessons, learner_activity, learner_idempotency,
nickname_stoplist, counters.

Данные:
- реестр member_id заполняется для всех известных social учеников (профили, семьи, дружбы, приглашения);
- learner_activity.first_seen_at — самый ранний след ученика в social (для «не новый ученик»);
- принятые реферальные приглашения последних 30 дней → referrals (invited, версия кампании 1, legacy: диагностика
  засчитана, окно — от выкладки, истечение — без уведомления).

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-21
"""
import base64
import hashlib
import hmac
import json
import uuid

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)
UUID = pg.UUID(as_uuid=True)

CAMPAIGN_V1 = {
    "require_diagnostic": True, "min_lessons": 3, "min_days": 2, "window_days": 30,
    "inviter_reward": {"freeze": 2, "til": 0}, "invitee_reward": {"freeze": 0, "til": 0},
    "monthly_cap": 10, "review": {"velocity_per_day": 5, "min_lesson_minutes": 3},
}


def _member_key() -> bytes:
    """Ключ member_id — из настроек сервиса (тесты передают их через Config.attributes, prod — окружение)."""
    from tilhero_social.settings import get_settings

    settings = op.get_context().config.attributes.get("settings") or get_settings()
    return bytes(settings.member_key_bytes())


def _member_id(key: bytes, user_id: str) -> str:
    digest = hmac.new(key, str(uuid.UUID(user_id)).encode("utf-8"), hashlib.sha256).digest()[:16]
    return "mb_" + base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def upgrade() -> None:
    op.create_table(
        "member_ids",
        sa.Column("user_id", UUID, primary_key=True),
        sa.Column("member_id", sa.String(25), nullable=False, unique=True),
        sa.Column("created_at", TS, nullable=False, server_default=sa.func.now()),
    )
    op.create_table(
        "community_profiles",
        sa.Column("user_id", UUID, primary_key=True),
        sa.Column("nickname", sa.String(20)),
        sa.Column("nickname_lc", sa.String(20), unique=True),
        sa.Column("friend_code", sa.String(12), nullable=False, unique=True),
        sa.Column("game_profile_hidden", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("nickname_changed_at", TS),
        sa.Column("nickname_reset_at", TS),
        sa.Column("code_window_start", TS),
        sa.Column("code_rotations", sa.SmallInteger(), nullable=False, server_default="0"),
        sa.Column("created_at", TS, nullable=False),
        sa.Column("updated_at", TS, nullable=False),
        sa.CheckConstraint("(nickname IS NULL) = (nickname_lc IS NULL)", name="ck_community_nickname_pair"),
        sa.CheckConstraint("code_rotations >= 0", name="ck_community_code_rotations"),
    )
    op.create_table(
        "friend_requests",
        sa.Column("request_id", UUID, primary_key=True),
        sa.Column("from_user", UUID, nullable=False),
        sa.Column("to_user", UUID, nullable=False),
        sa.Column("pair_a", UUID, nullable=False),
        sa.Column("pair_b", UUID, nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("created_at", TS, nullable=False),
        sa.Column("decided_at", TS),
        sa.CheckConstraint("status IN ('pending','accepted','declined','cancelled','expired')",
                           name="ck_friend_requests_status"),
        sa.CheckConstraint("from_user <> to_user", name="ck_friend_requests_self"),
        sa.CheckConstraint("pair_a < pair_b", name="ck_friend_requests_pair"),
    )
    op.create_index("uq_friend_requests_pending", "friend_requests", ["pair_a", "pair_b"], unique=True,
                    postgresql_where=sa.text("status = 'pending'"))
    op.create_index("ix_friend_requests_to", "friend_requests", ["to_user", "created_at"])
    op.create_index("ix_friend_requests_from", "friend_requests", ["from_user", "created_at"])
    op.create_index("ix_friend_requests_pending_created", "friend_requests", ["created_at"],
                    postgresql_where=sa.text("status = 'pending'"))
    op.create_table(
        "blocks",
        sa.Column("blocker", UUID, primary_key=True),
        sa.Column("blocked", UUID, primary_key=True),
        sa.Column("created_at", TS, nullable=False),
        sa.CheckConstraint("blocker <> blocked", name="ck_blocks_self"),
    )
    op.create_index("ix_blocks_blocked", "blocks", ["blocked"])
    op.create_table(
        "cases",
        sa.Column("case_id", UUID, primary_key=True),
        sa.Column("reporter_user_id", UUID),
        sa.Column("target_user_id", UUID),
        sa.Column("subject_kind", sa.String(16), nullable=False),
        sa.Column("subject_id", UUID),
        sa.Column("reason", sa.String(32), nullable=False),
        sa.Column("comment", sa.String(500)),
        sa.Column("target_nickname_at_report", sa.String(20)),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("resolution", sa.String(16)),
        sa.Column("resolution_basis", sa.String(500)),
        sa.Column("sanction_id", UUID),
        sa.Column("created_at", TS, nullable=False),
        sa.Column("resolved_by", sa.String(64)),
        sa.Column("resolved_by_name", sa.String(120)),
        sa.Column("resolved_at", TS),
        sa.CheckConstraint("subject_kind IN ('user','nickname','friend_request','invite','duel','pair_room')",
                           name="ck_cases_subject_kind"),
        sa.CheckConstraint("reason IN ('spam','abuse','inappropriate_nickname','cheating','other')",
                           name="ck_cases_reason"),
        sa.CheckConstraint("status IN ('open','resolved','dismissed')", name="ck_cases_status"),
        sa.CheckConstraint("resolution IS NULL OR resolution IN ('dismiss','warning','social_ban','nickname_reset')",
                           name="ck_cases_resolution"),
    )
    op.create_index("ix_cases_status_created", "cases", ["status", "created_at"])
    op.create_index("ix_cases_target_created", "cases", ["target_user_id", "created_at"])
    op.create_index("ix_cases_reporter_created", "cases", ["reporter_user_id", "created_at"])
    op.create_table(
        "sanctions",
        sa.Column("sanction_id", UUID, primary_key=True),
        sa.Column("user_id", UUID, nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("until", TS),
        sa.Column("basis", sa.String(500), nullable=False),
        sa.Column("case_id", UUID),
        sa.Column("decided_by", sa.String(64), nullable=False),
        sa.Column("decided_by_name", sa.String(120), nullable=False),
        sa.Column("decided_at", TS, nullable=False),
        sa.Column("revoked_at", TS),
        sa.Column("revoked_by", sa.String(64)),
        sa.Column("revoked_by_name", sa.String(120)),
        sa.Column("revoke_reason", sa.String(500)),
        sa.Column("expired_at", TS),
        sa.CheckConstraint("kind IN ('warning','social_ban','nickname_reset')", name="ck_sanctions_kind"),
        sa.CheckConstraint("until IS NULL OR kind = 'social_ban'", name="ck_sanctions_until"),
    )
    op.create_index("ix_sanctions_user", "sanctions", ["user_id", "decided_at"])
    op.create_index("ix_sanctions_ban_until", "sanctions", ["until"],
                    postgresql_where=sa.text("kind = 'social_ban' AND revoked_at IS NULL AND expired_at IS NULL"))
    op.create_table(
        "appeals",
        sa.Column("appeal_id", UUID, primary_key=True),
        sa.Column("sanction_id", UUID, sa.ForeignKey("sanctions.sanction_id", ondelete="CASCADE",
                                                     name="fk_appeals_sanction"), nullable=False, unique=True),
        sa.Column("user_id", UUID, nullable=False),
        sa.Column("text", sa.String(1000), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("idempotency_key", sa.String(128), nullable=False),
        sa.Column("created_at", TS, nullable=False),
        sa.Column("decided_by", sa.String(64)),
        sa.Column("decided_by_name", sa.String(120)),
        sa.Column("decided_at", TS),
        sa.Column("decision_note", sa.String(500)),
        sa.CheckConstraint("status IN ('open','upheld','overturned')", name="ck_appeals_status"),
    )
    op.create_index("ix_appeals_status_created", "appeals", ["status", "created_at"])
    op.create_table(
        "referral_campaigns",
        sa.Column("version", sa.Integer(), primary_key=True, autoincrement=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("payload", pg.JSONB(), nullable=False),
        sa.Column("comment", sa.String(500)),
        sa.Column("based_on", sa.Integer()),
        sa.Column("created_by", sa.String(64)),
        sa.Column("created_by_name", sa.String(120)),
        sa.Column("created_at", TS, nullable=False),
        sa.Column("updated_at", TS, nullable=False),
        sa.Column("validated_at", TS),
        sa.Column("activated_by", sa.String(64)),
        sa.Column("activated_by_name", sa.String(120)),
        sa.Column("activated_at", TS),
        sa.CheckConstraint("status IN ('draft','active','archived')", name="ck_referral_campaigns_status"),
    )
    op.create_index("uq_referral_campaigns_draft", "referral_campaigns", ["status"], unique=True,
                    postgresql_where=sa.text("status = 'draft'"))
    op.create_index("uq_referral_campaigns_active", "referral_campaigns", ["status"], unique=True,
                    postgresql_where=sa.text("status = 'active'"))
    op.create_table(
        "referrals",
        sa.Column("referral_id", UUID, primary_key=True),
        sa.Column("inviter_user_id", UUID),
        sa.Column("invitee_user_id", UUID, unique=True),
        sa.Column("invite_id", UUID),
        sa.Column("campaign_version", sa.Integer(), sa.ForeignKey("referral_campaigns.version",
                                                                  name="fk_referrals_campaign"), nullable=False),
        sa.Column("accepted_at", TS, nullable=False),
        sa.Column("diagnostic_at", TS),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("reject_code", sa.String(32)),
        sa.Column("risk_flags", pg.JSONB(), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("decided_by", sa.String(64)),
        sa.Column("decided_by_name", sa.String(120)),
        sa.Column("decided_at", TS),
        sa.Column("decision_note", sa.String(500)),
        sa.Column("decision_history", pg.JSONB(), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("qualified_at", TS),
        sa.Column("rewarded_at", TS),
        sa.Column("reward_outcome", sa.String(16)),
        sa.Column("opened_at", TS),
        sa.Column("legacy", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("window_from", TS),
        sa.Column("created_at", TS, nullable=False),
        sa.Column("updated_at", TS, nullable=False),
        sa.CheckConstraint("status IN ('invited','diagnostic_done','learning','review','qualified','rewarded',"
                           "'rejected','expired','capped')", name="ck_referrals_status"),
        sa.CheckConstraint("reject_code IS NULL OR reject_code IN ('not_new_user','family_member','window_expired',"
                           "'review_rejected','monthly_cap')", name="ck_referrals_reject_code"),
        sa.CheckConstraint("reward_outcome IS NULL OR reward_outcome IN ('rewarded','legacy','inviter_capped')",
                           name="ck_referrals_reward_outcome"),
    )
    op.create_index("ix_referrals_inviter", "referrals", ["inviter_user_id", "accepted_at"])
    op.create_index("ix_referrals_status_accepted", "referrals", ["status", "accepted_at"])
    op.create_index("ix_referrals_inviter_qualified", "referrals", ["inviter_user_id", "qualified_at"],
                    postgresql_where=sa.text("qualified_at IS NOT NULL"))
    op.create_table(
        "referral_lessons",
        sa.Column("session_id", UUID, primary_key=True),
        sa.Column("referral_id", UUID, sa.ForeignKey("referrals.referral_id", ondelete="CASCADE",
                                                     name="fk_referral_lessons_ref"), nullable=False),
        sa.Column("lesson_key", sa.String(200), nullable=False),
        sa.Column("local_date", sa.Date(), nullable=False),
        sa.Column("minutes", sa.Integer(), nullable=False),
        sa.Column("finished_at", TS, nullable=False),
    )
    op.create_index("ix_referral_lessons_referral", "referral_lessons", ["referral_id"])
    op.create_table(
        "learner_activity",
        sa.Column("user_id", UUID, primary_key=True),
        sa.Column("first_seen_at", TS),
        sa.Column("first_lesson_at", TS),
        sa.Column("diagnostic_at", TS),
        sa.Column("updated_at", TS, nullable=False),
    )
    op.create_table(
        "learner_idempotency",
        sa.Column("user_id", UUID, primary_key=True),
        sa.Column("scope", sa.String(32), primary_key=True),
        sa.Column("key", sa.String(128), primary_key=True),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column("status_code", sa.SmallInteger(), nullable=False),
        sa.Column("response", pg.JSONB(), nullable=False),
        sa.Column("created_at", TS, nullable=False),
    )
    op.create_index("ix_learner_idempotency_created", "learner_idempotency", ["created_at"])
    op.create_table(
        "nickname_stoplist",
        sa.Column("nickname_lc", sa.String(20), primary_key=True),
        sa.Column("user_id", UUID),
        sa.Column("sanction_id", UUID),
        sa.Column("created_at", TS, nullable=False),
    )
    op.create_table(
        "counters",
        sa.Column("name", sa.String(32), primary_key=True),
        sa.Column("value", sa.Integer(), nullable=False),
    )

    bind = op.get_bind()
    bind.execute(sa.text("INSERT INTO counters (name, value) VALUES ('referral_campaign', 1)"))
    # кампания: версия 1 (решение владельца 20.11.2026) — сразу active
    bind.execute(sa.text(
        "INSERT INTO referral_campaigns (version, status, payload, comment, created_at, updated_at, validated_at, "
        "activated_at) VALUES (1, 'active', CAST(:payload AS jsonb), :comment, now(), now(), now(), now())"),
        {"payload": json.dumps(CAMPAIGN_V1), "comment": "Версия 1 (миграция спринта 7)"})
    # реестр member_id для всех известных учеников (обратного вычисления нет)
    users = bind.execute(sa.text(
        "SELECT user_id FROM profiles UNION SELECT user_id FROM family_members "
        "UNION SELECT user_a FROM friendships UNION SELECT user_b FROM friendships "
        "UNION SELECT inviter_user_id FROM invites UNION SELECT invitee_user_id FROM invite_redemptions "
        "EXCEPT SELECT user_id FROM deleted_users")).scalars().all()
    if users:
        key = _member_key()
        bind.execute(sa.text("INSERT INTO member_ids (user_id, member_id) VALUES (:u, :m) ON CONFLICT DO NOTHING"),
                     [{"u": u, "m": _member_id(key, str(u))} for u in users])
    # «не новый ученик»: регистрация — из user.profile.created.v1 (с выкладки); для известных учеников — самый ранний
    # след в social (не позже настоящей регистрации, поэтому новых не отклоняет)
    bind.execute(sa.text(
        "INSERT INTO learner_activity (user_id, first_seen_at, updated_at) "
        "SELECT u, min(t), now() FROM ("
        "  SELECT user_id AS u, updated_at AS t FROM profiles "
        "  UNION ALL SELECT inviter_user_id, created_at FROM invites "
        "  UNION ALL SELECT invitee_user_id, opened_at FROM invite_redemptions "
        "  UNION ALL SELECT user_id, joined_at FROM family_members "
        "  UNION ALL SELECT user_a, created_at FROM friendships UNION ALL SELECT user_b, created_at FROM friendships"
        ") s WHERE u NOT IN (SELECT user_id FROM deleted_users) GROUP BY u"))
    # переход спринт 6 → 7 (решение оркестратора: никто не получает дважды и никто не теряет обещанное): принятые
    # реферальные приглашения последних 30 дней → referrals (invited, версия 1, legacy): диагностика засчитана
    # (до спринта 7 входила в онбординг), окно условий — от выкладки, истечение — без уведомления; один реферал на
    # приглашённого (самое раннее принятие), без самоприглашений и удалённых
    bind.execute(sa.text(
        "INSERT INTO referrals (referral_id, inviter_user_id, invitee_user_id, invite_id, campaign_version, "
        "accepted_at, diagnostic_at, opened_at, legacy, window_from, status, created_at, updated_at) "
        "SELECT gen_random_uuid(), x.inviter_user_id, x.invitee_user_id, x.invite_id, 1, x.accepted_at, "
        "x.accepted_at, x.opened_at, true, now(), 'invited', now(), now() FROM ("
        "  SELECT DISTINCT ON (r.invitee_user_id) i.inviter_user_id, r.invitee_user_id, i.invite_id, r.accepted_at, "
        "  r.opened_at FROM invite_redemptions r JOIN invites i ON i.invite_id = r.invite_id "
        "  WHERE i.kind = 'referral' AND r.accepted_at IS NOT NULL AND r.accepted_at > now() - interval '30 days' "
        "    AND i.inviter_user_id <> r.invitee_user_id "
        "    AND r.invitee_user_id NOT IN (SELECT user_id FROM deleted_users) "
        "    AND i.inviter_user_id NOT IN (SELECT user_id FROM deleted_users) "
        "  ORDER BY r.invitee_user_id, r.accepted_at) x "
        "ON CONFLICT DO NOTHING"))


def downgrade() -> None:
    """Симметрично upgrade: все таблицы спринта 7 (в т. ч. перенесённые рефералы) удаляются; данные спринта 1
    (приглашения, ответы, семьи, дружбы, профили) не меняются — повторный upgrade снова перенесёт рефералы."""
    op.drop_table("counters")
    op.drop_table("nickname_stoplist")
    op.drop_index("ix_learner_idempotency_created", table_name="learner_idempotency")
    op.drop_table("learner_idempotency")
    op.drop_table("learner_activity")
    op.drop_index("ix_referral_lessons_referral", table_name="referral_lessons")
    op.drop_table("referral_lessons")
    op.drop_index("ix_referrals_inviter_qualified", table_name="referrals")
    op.drop_index("ix_referrals_status_accepted", table_name="referrals")
    op.drop_index("ix_referrals_inviter", table_name="referrals")
    op.drop_table("referrals")
    op.drop_index("uq_referral_campaigns_active", table_name="referral_campaigns")
    op.drop_index("uq_referral_campaigns_draft", table_name="referral_campaigns")
    op.drop_table("referral_campaigns")
    op.drop_index("ix_appeals_status_created", table_name="appeals")
    op.drop_table("appeals")
    op.drop_index("ix_sanctions_ban_until", table_name="sanctions")
    op.drop_index("ix_sanctions_user", table_name="sanctions")
    op.drop_table("sanctions")
    op.drop_index("ix_cases_reporter_created", table_name="cases")
    op.drop_index("ix_cases_target_created", table_name="cases")
    op.drop_index("ix_cases_status_created", table_name="cases")
    op.drop_table("cases")
    op.drop_index("ix_blocks_blocked", table_name="blocks")
    op.drop_table("blocks")
    op.drop_index("ix_friend_requests_pending_created", table_name="friend_requests")
    op.drop_index("ix_friend_requests_from", table_name="friend_requests")
    op.drop_index("ix_friend_requests_to", table_name="friend_requests")
    op.drop_index("uq_friend_requests_pending", table_name="friend_requests")
    op.drop_table("friend_requests")
    op.drop_table("community_profiles")
    op.drop_table("member_ids")
