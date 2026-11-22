"""спринт 7: задания дуэли и парные комнаты (INTERNAL_API §3).

- sessions: kind `duel` (duel_id), сессия дуэли вне правила одной активной сессии (uq_sessions_active без duel),
  одна сессия дуэли на участника (uq_sessions_duel); причина истории `deadline`;
- duel_sets — наборы заданий дуэли (снимки заданий с ключами; наружу не уходят);
- pair_rooms (due_at — срок следующего обслуживания для планировщика; coach_used — суточный лимит комнат с ИИ),
  room_participants, room_events (лента long-poll; тексты стираются по сроку и сагой — триггер),
  room_audio (распознанный голос до подтверждения хода, 5 минут);
- проекции social: community_members (member_id, ник), social_blocks, social_sanctions.

Откат удаляет сессии дуэли (старые CHECK их не допускают) и новые таблицы.

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-21
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)
KINDS_V2 = "kind IN ('lesson','scenario','media','review','reading')"
KINDS_V3 = "kind IN ('lesson','scenario','media','review','reading','duel')"
TARGET_V2 = ("(kind <> 'lesson' OR lesson_id IS NOT NULL) AND (kind <> 'scenario' OR scenario_id IS NOT NULL) AND "
             "(kind <> 'media' OR asset_id IS NOT NULL) AND (kind <> 'review' OR source_session_id IS NOT NULL) AND "
             "(kind <> 'reading' OR reading_id IS NOT NULL)")
TARGET_V3 = f"{TARGET_V2} AND (kind <> 'duel' OR duel_id IS NOT NULL)"
REASONS_V2 = ("reason IN ('started','pause','resume','auto_pause','finish','fail','cancel','expired',"
              "'content_unpublished')")
REASONS_V3 = ("reason IN ('started','pause','resume','auto_pause','finish','fail','cancel','expired',"
              "'content_unpublished','deadline')")
ACTIVE_V2 = "status IN ('ready','in_progress','paused')"
ACTIVE_V3 = "status IN ('ready','in_progress','paused') AND kind <> 'duel'"
ROOM_STATUSES = ("IN ('invited','declined','expired','cancelled','waiting','in_progress','paused','finished',"
                 "'abandoned','stopped')")
END_REASONS = "IN ('completed','participant_left','inactivity','stopped')"
EVENT_KINDS = ("IN ('joined','left','offline','online','paused','resumed','roles','coach','turn','mode_changed',"
               "'finished','stopped')")
SIDES = "IN ('inviter','invitee')"
BAND_CHECK = "IN ('A0','A1','A2','B1','B2')"


def _sessions_checks(kinds: str, target: str, reasons: str, active: str) -> None:
    op.drop_constraint("ck_sessions_kind", "sessions", type_="check")
    op.drop_constraint("ck_sessions_target", "sessions", type_="check")
    op.drop_constraint("ck_status_history_reason", "status_history", type_="check")
    op.create_check_constraint("ck_sessions_kind", "sessions", kinds)
    op.create_check_constraint("ck_sessions_target", "sessions", target)
    op.create_check_constraint("ck_status_history_reason", "status_history", reasons)
    op.drop_index("uq_sessions_active", table_name="sessions")
    op.create_index("uq_sessions_active", "sessions", ["user_id"], unique=True, postgresql_where=sa.text(active))


def upgrade() -> None:
    op.add_column("sessions", sa.Column("duel_id", pg.UUID(as_uuid=True)))
    _sessions_checks(KINDS_V3, TARGET_V3, REASONS_V3, ACTIVE_V3)
    op.create_index("uq_sessions_duel", "sessions", ["duel_id", "user_id"], unique=True,
                    postgresql_where=sa.text("kind = 'duel'"))

    op.create_table(
        "duel_sets",
        sa.Column("set_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("duel_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("pair_id", sa.String(16), nullable=False),
        sa.Column("level_band", sa.String(8), nullable=False),
        sa.Column("user_a", pg.UUID(as_uuid=True)),
        sa.Column("user_b", pg.UUID(as_uuid=True)),
        sa.Column("audience", sa.String(8), nullable=False),
        sa.Column("seed", sa.String(64), nullable=False),
        sa.Column("items", pg.JSONB(), nullable=False),
        sa.Column("items_total", sa.SmallInteger(), nullable=False),
        sa.Column("play_deadline", TS, nullable=False),
        sa.Column("status", sa.String(10), nullable=False),
        sa.Column("created_at", TS, nullable=False),
        sa.Column("closed_at", TS),
        sa.Column("finished_at", TS),
        sa.Column("result_version", sa.SmallInteger()),
        sa.CheckConstraint("level_band IN ('A0-A1','A2','B1+')", name="ck_duel_sets_band"),
        sa.CheckConstraint("status IN ('open','closed','finished')", name="ck_duel_sets_status"),
        sa.CheckConstraint("audience IN ('kids','teens','adults')", name="ck_duel_sets_audience"),
        sa.CheckConstraint("items_total BETWEEN 1 AND 50", name="ck_duel_sets_total"),
        sa.UniqueConstraint("duel_id", name="uq_duel_sets_duel"),
    )
    op.create_index("ix_duel_sets_open", "duel_sets", ["play_deadline"], postgresql_where=sa.text("status = 'open'"))

    op.create_table(
        "pair_rooms",
        sa.Column("room_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("pair_id", sa.String(16), nullable=False),
        sa.Column("scenario_id", sa.String(64), nullable=False),
        sa.Column("content_versions", pg.JSONB(), nullable=False),
        sa.Column("title", pg.JSONB(), nullable=False),
        sa.Column("level", sa.String(2)),
        sa.Column("mode", sa.String(8), nullable=False),
        sa.Column("engine", sa.String(8), nullable=False),
        sa.Column("ai_degraded", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("coach_used", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("audience", sa.String(8), nullable=False),
        sa.Column("status", sa.String(12), nullable=False),
        sa.Column("inviter", pg.UUID(as_uuid=True)),
        sa.Column("invitee", pg.UUID(as_uuid=True)),
        sa.Column("start_at", TS, nullable=False),
        sa.Column("respond_until", TS, nullable=False),
        sa.Column("created_at", TS, nullable=False),
        sa.Column("accepted_at", TS),
        sa.Column("started_at", TS),
        sa.Column("ended_at", TS),
        sa.Column("end_reason", sa.String(20)),
        sa.Column("team_goal_reached", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("ai_cost_usd", sa.Numeric(10, 4), nullable=False, server_default=sa.text("0")),
        sa.Column("seq", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("turn_seq", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("next_speaker", sa.String(4)),
        sa.Column("prompt_at", TS),
        sa.Column("clock_at", TS),
        sa.Column("last_activity_at", TS),
        sa.Column("progress_seconds", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("state", pg.JSONB(), nullable=False),
        sa.Column("starting_sent_at", TS),
        sa.Column("due_at", TS),
        sa.Column("stopped_by_id", sa.String(64)),
        sa.Column("stopped_by_name", sa.String(200)),
        sa.Column("stop_reason", sa.String(500)),
        sa.Column("idempotency_key", sa.String(128)),
        sa.Column("request_hash", sa.String(64)),
        sa.Column("updated_at", TS, nullable=False),
        sa.CheckConstraint(f"status {ROOM_STATUSES}", name="ck_pair_rooms_status"),
        sa.CheckConstraint("mode IN ('free','choices')", name="ck_pair_rooms_mode"),
        sa.CheckConstraint("engine IN ('ai','script')", name="ck_pair_rooms_engine"),
        sa.CheckConstraint("audience IN ('kids','teens','adults')", name="ck_pair_rooms_audience"),
        sa.CheckConstraint(f"end_reason IS NULL OR end_reason {END_REASONS}", name="ck_pair_rooms_end_reason"),
        sa.CheckConstraint("next_speaker IS NULL OR next_speaker IN ('A','B','both')", name="ck_pair_rooms_next"),
        sa.CheckConstraint("seq >= 0 AND turn_seq >= 0 AND progress_seconds >= 0 AND ai_cost_usd >= 0",
                           name="ck_pair_rooms_counters"),
        sa.CheckConstraint(f"level IS NULL OR level {BAND_CHECK}", name="ck_pair_rooms_level"),
        sa.UniqueConstraint("inviter", "idempotency_key", name="uq_pair_rooms_inviter_idempotency"),
    )
    op.create_index("ix_pair_rooms_created", "pair_rooms", ["created_at"])
    op.create_index("ix_pair_rooms_active", "pair_rooms", ["status"],
                    postgresql_where=sa.text("status IN ('invited','waiting','in_progress','paused')"))
    op.create_index("ix_pair_rooms_ended", "pair_rooms", ["ended_at"],
                    postgresql_where=sa.text("ended_at IS NOT NULL"))
    op.create_index("ix_pair_rooms_due", "pair_rooms", ["due_at"],
                    postgresql_where=sa.text("status IN ('invited','waiting','in_progress','paused')"))

    op.create_table(
        "room_participants",
        sa.Column("room_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("side", sa.String(8), primary_key=True),
        sa.Column("user_id", pg.UUID(as_uuid=True)),
        sa.Column("session_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("role", sa.String(1)),
        sa.Column("audience", sa.String(8), nullable=False),
        sa.Column("locale", sa.String(2), nullable=False, server_default=sa.text("'ru'")),
        sa.Column("voice", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("holds_slot", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("joined_at", TS),
        sa.Column("last_seen_at", TS),
        sa.Column("left_at", TS),
        sa.Column("absent_since", TS),
        sa.Column("abandoned", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("network", sa.String(8)),
        sa.Column("turns", sa.SmallInteger(), nullable=False, server_default=sa.text("0")),
        sa.Column("speaking_seconds", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("active_seconds", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("minutes", sa.SmallInteger(), nullable=False, server_default=sa.text("0")),
        sa.Column("contributed", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("evidence", pg.JSONB(), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("report", pg.JSONB()),
        sa.Column("evaluation_status", sa.String(8), nullable=False, server_default=sa.text("'none'")),
        sa.Column("evaluation_id", pg.UUID(as_uuid=True)),
        sa.Column("evaluation_attempts", sa.SmallInteger(), nullable=False, server_default=sa.text("0")),
        sa.CheckConstraint(f"side {SIDES}", name="ck_room_participants_side"),
        sa.CheckConstraint("role IS NULL OR role IN ('A','B')", name="ck_room_participants_role"),
        sa.CheckConstraint("audience IN ('kids','teens','adults')", name="ck_room_participants_audience"),
        sa.CheckConstraint("locale IN ('ru','uz')", name="ck_room_participants_locale"),
        sa.CheckConstraint("network IS NULL OR network IN ('online','offline')",
                           name="ck_room_participants_network"),
        sa.CheckConstraint("evaluation_status IN ('none','pending','done','failed')",
                           name="ck_room_participants_evaluation"),
        sa.CheckConstraint("turns >= 0 AND speaking_seconds >= 0 AND active_seconds >= 0 AND minutes >= 0 "
                           "AND evaluation_attempts >= 0", name="ck_room_participants_counters"),
        sa.ForeignKeyConstraint(["room_id"], ["pair_rooms.room_id"], ondelete="CASCADE",
                                name="fk_room_participants_room"),
        sa.UniqueConstraint("session_id", name="uq_room_participants_session"),
    )
    op.create_index("uq_room_participants_slot", "room_participants", ["user_id"], unique=True,
                    postgresql_where=sa.text("holds_slot"))
    op.create_index("ix_room_participants_user", "room_participants", ["user_id"])
    op.create_index("ix_room_participants_evaluation", "room_participants", ["room_id"],
                    postgresql_where=sa.text("evaluation_status = 'pending'"))

    op.create_table(
        "room_events",
        sa.Column("room_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("seq", sa.Integer(), primary_key=True),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("side", sa.String(8)),
        sa.Column("role", sa.String(1)),
        sa.Column("text", sa.String(600)),
        sa.Column("mode", sa.String(8)),
        sa.Column("turn_id", sa.String(8)),
        sa.Column("at", TS, nullable=False),
        sa.Column("idempotency_key", sa.String(128)),
        sa.Column("request_hash", sa.String(64)),
        sa.Column("redacted_at", TS),
        sa.CheckConstraint(f"kind {EVENT_KINDS}", name="ck_room_events_kind"),
        sa.CheckConstraint(f"side IS NULL OR side {SIDES}", name="ck_room_events_side"),
        sa.CheckConstraint("role IS NULL OR role IN ('A','B')", name="ck_room_events_role"),
        sa.CheckConstraint("mode IS NULL OR mode IN ('text','voice','choice')", name="ck_room_events_mode"),
        sa.ForeignKeyConstraint(["room_id"], ["pair_rooms.room_id"], ondelete="CASCADE", name="fk_room_events_room"),
    )
    op.create_index("uq_room_events_idempotency", "room_events", ["room_id", "side", "idempotency_key"], unique=True,
                    postgresql_where=sa.text("idempotency_key IS NOT NULL"))
    op.create_index("ix_room_events_redact", "room_events", ["at"], postgresql_where=sa.text("text IS NOT NULL"))

    op.create_table(
        "room_audio",
        sa.Column("audio_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("room_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("side", sa.String(8), nullable=False),
        sa.Column("text", sa.String(600), nullable=False),
        sa.Column("duration_ms", sa.Integer(), nullable=False),
        sa.Column("created_at", TS, nullable=False),
        sa.Column("expires_at", TS, nullable=False),
        sa.Column("used_at", TS),
        sa.CheckConstraint(f"side {SIDES}", name="ck_room_audio_side"),
        sa.CheckConstraint("duration_ms BETWEEN 0 AND 60000", name="ck_room_audio_duration"),
        sa.ForeignKeyConstraint(["room_id"], ["pair_rooms.room_id"], ondelete="CASCADE", name="fk_room_audio_room"),
    )
    op.create_index("ix_room_audio_expires", "room_audio", ["expires_at"])

    op.create_table(
        "community_members",
        sa.Column("user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("member_id", sa.String(32), nullable=False),
        sa.Column("nickname", sa.String(20)),
        sa.Column("updated_at", TS, nullable=False),
        sa.UniqueConstraint("member_id", name="uq_community_members_member"),
    )
    op.create_table(
        "social_blocks",
        sa.Column("blocker", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("blocked", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.Column("at", TS, nullable=False),
    )
    op.create_table(
        "social_sanctions",
        sa.Column("sanction_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("until", TS),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.Column("changed_at", TS, nullable=False),
    )
    op.create_index("ix_social_sanctions_user", "social_sanctions", ["user_id"])

    # Лента комнаты неизменяема (роль сервиса не может снять триггер): допустимо только стирание текста реплики по
    # сроку хранения или сагой удаления (text → NULL вместе с redacted_at).
    op.execute(
        """
        CREATE OR REPLACE FUNCTION room_events_guard() RETURNS trigger AS $$
        BEGIN
          IF NEW.room_id IS DISTINCT FROM OLD.room_id OR NEW.seq IS DISTINCT FROM OLD.seq
            OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.side IS DISTINCT FROM OLD.side
            OR NEW.role IS DISTINCT FROM OLD.role OR NEW.mode IS DISTINCT FROM OLD.mode
            OR NEW.turn_id IS DISTINCT FROM OLD.turn_id OR NEW.at IS DISTINCT FROM OLD.at
            OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
            OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
            OR (NEW.text IS DISTINCT FROM OLD.text AND NOT (NEW.text IS NULL AND NEW.redacted_at IS NOT NULL))
            OR (OLD.redacted_at IS NOT NULL AND NEW.redacted_at IS DISTINCT FROM OLD.redacted_at) THEN
            RAISE EXCEPTION 'room_events: event is immutable (only text redaction)'
              USING ERRCODE = 'insufficient_privilege';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        """
    )
    op.execute("CREATE TRIGGER room_events_guard BEFORE UPDATE ON room_events FOR EACH ROW "
               "EXECUTE FUNCTION room_events_guard()")


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS room_events_guard ON room_events")
    op.execute("DROP FUNCTION IF EXISTS room_events_guard()")
    for table in ("social_sanctions", "social_blocks", "community_members", "room_audio", "room_events",
                  "room_participants", "pair_rooms", "duel_sets"):
        op.drop_table(table)
    op.drop_index("uq_sessions_duel", table_name="sessions")
    op.execute("DELETE FROM sessions WHERE kind = 'duel'")
    op.execute("DELETE FROM status_history WHERE reason = 'deadline'")
    _sessions_checks(KINDS_V2, TARGET_V2, REASONS_V2, ACTIVE_V2)
    op.drop_column("sessions", "duel_id")
