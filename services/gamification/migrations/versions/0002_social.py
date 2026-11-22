"""Спринт 7 — социальное: проекции social и diagnostics, лиги недели, дуэли, реферальные награды по кампании,
совместные достижения парных уроков, правила с лигами, дуэлями и парными уроками.

- ledger: + `league_week` (неделя лиг операции XP, идущей в «XP недели»), новые reason `duel`, `pair_lesson`,
  `league_prize`, `referral_welcome`; триггер неизменяемости — с новой колонкой;
- learners: + `league_opt_in` (общая лига по желанию, по умолчанию false), `together_count` (значок together_1);
- значки: метрика `together`, шаблон «Вместе» RU/UZ;
- проекции: social_friends, social_blocks, community, family_members, sanctions, learner_levels;
- лиги: league_weeks, league_groups, league_members, league_results (неизменяемы: UPDATE/DELETE — только в саге
  удаления под `SET LOCAL tilhero.deletion = 'on'`, обезличивание);
- дуэли: duels, duel_results_history (неизменяема так же);
- referral_rewards — награды по social.referral.qualified.v1 (исход: rewarded | inviter_capped | legacy);
  рефералы спринта 6: новых строк нет, pending «доживают» по прежнему правилу 90 дней (статус expired добавлен);
- learners: + `guardian_consent`, `profile_updated_at` (проекция user.profile.updated.v1 — доступ 14–17 к общей лиге);
- pair_awards — награды участника парного урока (одна на комнату); projection_loads — разовая загрузка проекций;
- правила: новая версия (max + 1) на основе активной с `league`, `duel`, `pair_lesson`, сразу active; прежняя →
  archived. Если активная уже содержит эти разделы (повторный подъём) — без новой версии.

downgrade возвращает изменения upgrade: таблицы, колонки, ограничения (строки с новыми значениями — NOT VALID),
шаблон «Вместе», expired → void, версию правил миграции (если её ещё не использовали).

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-21
"""
import copy
from datetime import UTC, datetime

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql as pg

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)
EMPTY = sa.text("'[]'::jsonb")
EMPTY_OBJ = sa.text("'{}'::jsonb")
SYSTEM = "system"
RULES_COMMENT = "Спринт 7: лиги недели, дуэли, парные уроки (миграция)"

REASONS_V1 = ("'lesson','scenario','media','reading','review','skill_demonstrated','skill_retained','quest',"
              "'quest_bonus','registration_bonus','referral_bonus','streak_freeze','shop','manual','reversal','purchase'")
REASONS_V2 = REASONS_V1 + ",'duel','pair_lesson','league_prize','referral_welcome'"
METRICS_V1 = "'lessons','streak','skills','skill_retained','reviews_cards','readings','freeze'"
METRICS_V2 = METRICS_V1 + ",'together'"
BANDS = "'A0-A1','A2','B1+'"
CONSENTS = "'not_required','pending','granted','declined'"

SOCIAL_RULES = {
    "league": {"prizes": [50, 30, 20], "group_size": [20, 30], "anomaly": {"median_factor": 5, "min_xp": 1500}},
    "duel": {"win": 30, "draw": 15, "participation": 10, "daily_cap": 3},
    "pair_lesson": {"xp": 25, "min_turns": 1, "daily_cap": 3},
}

TOGETHER_TEMPLATE = {
    "code": "together", "metric": "together", "order": 8,
    "title": {"ru": "Вместе", "uz": "Birgalikda"},
    "description": {"ru": "Парный урок: цель команды достигнута, каждый внёс вклад",
                    "uz": "Juftlik darsi: jamoa maqsadiga erishildi, har kim hissa qoʻshdi"},
}

LEDGER_GUARD = """
CREATE OR REPLACE FUNCTION gamification_ledger_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF coalesce(current_setting('tilhero.deletion', true), '') = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'ledger is append-only (DELETE only in the deletion saga)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'confirmed' AND NEW.status = 'reversed' AND OLD.reversed_by IS NULL
     AND NEW.reversed_by IS NOT NULL
     AND ROW(NEW.op_id, NEW.user_id, NEW.currency, NEW.amount, NEW.reason, NEW.source_kind, NEW.source_ref,
             NEW.source_session_id, NEW.rules_version, NEW.multiplier, NEW.capped, NEW.local_date,
             NEW.reversal_of, NEW.actor, NEW.comment, NEW.idempotency_key, NEW.created_at, NEW.league_week)
         IS NOT DISTINCT FROM
         ROW(OLD.op_id, OLD.user_id, OLD.currency, OLD.amount, OLD.reason, OLD.source_kind, OLD.source_ref,
             OLD.source_session_id, OLD.rules_version, OLD.multiplier, OLD.capped, OLD.local_date,
             OLD.reversal_of, OLD.actor, OLD.comment, OLD.idempotency_key, OLD.created_at, OLD.league_week) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ledger is append-only (only confirmed -> reversed)'
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
"""

LEDGER_GUARD_V1 = LEDGER_GUARD.replace(", NEW.league_week)", ")").replace(", OLD.league_week)", ")")

# Итоги лиг и версии результатов дуэлей: неизменяемы; в саге удаления (SET LOCAL tilhero.deletion = 'on') —
# обезличивание (UPDATE) и удаление
RESULTS_GUARD = """
CREATE OR REPLACE FUNCTION gamification_results_guard() RETURNS trigger AS $$
BEGIN
  IF coalesce(current_setting('tilhero.deletion', true), '') = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is immutable (new version instead)', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
"""


def upgrade() -> None:
    # ---------------------------------------------------------------- ledger, learners, значки
    op.add_column("ledger", sa.Column("league_week", sa.Date()))
    op.drop_constraint("ck_ledger_reason", "ledger", type_="check")
    op.create_check_constraint("ck_ledger_reason", "ledger", f"reason IN ({REASONS_V2})")
    op.create_index("ix_ledger_league_week", "ledger", ["league_week", "user_id"],
                    postgresql_where=sa.text("league_week IS NOT NULL"))
    op.execute(LEDGER_GUARD)

    op.add_column("learners", sa.Column("league_opt_in", sa.Boolean(), nullable=False, server_default=sa.text("false")))
    op.add_column("learners", sa.Column("together_count", sa.Integer(), nullable=False, server_default=sa.text("0")))
    op.create_check_constraint("ck_learners_together", "learners", "together_count >= 0")
    op.create_index("ix_learners_league_opt_in", "learners", ["user_id"], postgresql_where=sa.text("league_opt_in"))
    op.add_column("learners", sa.Column("guardian_consent", sa.String(16)))
    op.add_column("learners", sa.Column("profile_updated_at", TS))
    op.create_check_constraint("ck_learners_guardian_consent", "learners",
                               f"guardian_consent IS NULL OR guardian_consent IN ({CONSENTS})")
    # рефералы спринта 6: pending доживают по прежнему правилу 90 дней, затем — expired
    op.drop_constraint("ck_referrals_status", "referrals", type_="check")
    op.create_check_constraint("ck_referrals_status", "referrals",
                               "status IN ('pending','rewarded','capped','void','expired')")

    for table, name in (("badges", "ck_badges_metric"), ("badge_templates", "ck_badge_templates_metric")):
        op.drop_constraint(name, table, type_="check")
        op.create_check_constraint(name, table, f"metric IN ({METRICS_V2})")

    # ---------------------------------------------------------------- проекции
    op.create_table(
        "social_friends",
        sa.Column("user_a", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_b", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("status", sa.String(8), nullable=False),
        sa.Column("changed_at", TS, nullable=False),
        sa.CheckConstraint("status IN ('added','removed')", name="ck_social_friends_status"),
        sa.CheckConstraint("user_a <> user_b", name="ck_social_friends_pair"),
    )
    op.create_index("ix_social_friends_b", "social_friends", ["user_b"], postgresql_where=sa.text("status = 'added'"))

    op.create_table(
        "social_blocks",
        sa.Column("blocker_user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("blocked_user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("status", sa.String(8), nullable=False),
        sa.Column("changed_at", TS, nullable=False),
        sa.CheckConstraint("status IN ('added','removed')", name="ck_social_blocks_status"),
    )
    op.create_index("ix_social_blocks_blocked", "social_blocks", ["blocked_user_id"],
                    postgresql_where=sa.text("status = 'added'"))

    op.create_table(
        "community",
        sa.Column("user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("member_id", sa.String(25), nullable=False),
        sa.Column("nickname", sa.String(20)),
        sa.Column("hidden", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("updated_at", TS, nullable=False),
        sa.UniqueConstraint("member_id", name="uq_community_member"),
    )

    op.create_table(
        "family_members",
        sa.Column("user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("family_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("role", sa.String(8), nullable=False),
        sa.Column("added_at", TS, nullable=False),
        sa.CheckConstraint("role IN ('owner','adult','teen','child')", name="ck_family_members_role"),
    )
    op.create_index("ix_family_members_family", "family_members", ["family_id"])

    op.create_table(
        "sanctions",
        sa.Column("sanction_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("until", TS),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.Column("changed_at", TS, nullable=False),
        sa.CheckConstraint("kind IN ('warning','social_ban','nickname_reset')", name="ck_sanctions_kind"),
    )
    op.create_index("ix_sanctions_user_active", "sanctions", ["user_id"],
                    postgresql_where=sa.text("active AND kind = 'social_ban'"))

    op.create_table(
        "learner_levels",
        sa.Column("user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("pair_id", sa.String(16), primary_key=True),
        sa.Column("level_band", sa.String(6), nullable=False),
        sa.Column("result_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("completed_at", TS, nullable=False),
        sa.CheckConstraint(f"level_band IN ({BANDS})", name="ck_learner_levels_band"),
    )

    # ---------------------------------------------------------------- лиги
    op.create_table(
        "league_weeks",
        sa.Column("week", sa.Date(), primary_key=True),
        sa.Column("status", sa.String(8), nullable=False),
        sa.Column("formed_at", TS),
        sa.Column("closing_at", TS),
        sa.Column("closed_at", TS),
        sa.Column("updated_at", TS, nullable=False),
        sa.CheckConstraint("status IN ('open','closing','closed')", name="ck_league_weeks_status"),
    )

    op.create_table(
        "league_groups",
        sa.Column("group_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("week", sa.Date(), nullable=False),
        sa.Column("pair_id", sa.String(16), nullable=False),
        sa.Column("level_band", sa.String(6), nullable=False),
        sa.Column("group_no", sa.SmallInteger(), nullable=False),
        sa.Column("status", sa.String(6), nullable=False),
        sa.Column("version", sa.Integer()),
        sa.Column("anomalies", sa.SmallInteger(), nullable=False, server_default=sa.text("0")),
        sa.Column("closed_at", TS),
        sa.Column("created_at", TS, nullable=False),
        sa.CheckConstraint("status IN ('open','closed','held')", name="ck_league_groups_status"),
        sa.CheckConstraint(f"level_band IN ({BANDS})", name="ck_league_groups_band"),
        sa.CheckConstraint("group_no >= 1", name="ck_league_groups_no"),
        sa.UniqueConstraint("week", "pair_id", "level_band", "group_no", name="uq_league_groups_no"),
    )
    op.create_index("ix_league_groups_week_status", "league_groups", ["week", "status"])

    op.create_table(
        "league_members",
        sa.Column("week", sa.Date(), primary_key=True),
        sa.Column("user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("group_id", pg.UUID(as_uuid=True), nullable=False),
        sa.Column("joined_at", TS, nullable=False),
        sa.Column("left_at", TS),
    )
    op.create_index("ix_league_members_group", "league_members", ["group_id"])

    op.create_table(
        "league_results",
        sa.Column("group_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("version", sa.Integer(), primary_key=True, autoincrement=False),
        sa.Column("week", sa.Date(), nullable=False),
        sa.Column("standings", pg.JSONB(), nullable=False),
        sa.Column("prizes_held", sa.Boolean(), nullable=False),
        sa.Column("excluded_user_ids", pg.JSONB(), nullable=False, server_default=EMPTY),
        sa.Column("closed_at", TS, nullable=False),
        sa.Column("closed_by", sa.String(80), nullable=False),
        sa.Column("closed_by_name", sa.String(120)),
        sa.Column("reason", sa.String(500)),
        sa.CheckConstraint("version >= 1", name="ck_league_results_version"),
        sa.CheckConstraint("closed_by = 'system' OR closed_by LIKE 'staff:%'", name="ck_league_results_by"),
    )
    op.create_index("ix_league_results_week", "league_results", ["week"])

    # ---------------------------------------------------------------- дуэли
    op.create_table(
        "duels",
        sa.Column("duel_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("challenger", pg.UUID(as_uuid=True)),
        sa.Column("opponent", pg.UUID(as_uuid=True)),
        sa.Column("pair_key", sa.String(80)),
        sa.Column("pair_id", sa.String(16), nullable=False),
        sa.Column("level_band", sa.String(6), nullable=False),
        sa.Column("status", sa.String(10), nullable=False),
        sa.Column("set_id", pg.UUID(as_uuid=True)),
        sa.Column("accept_deadline", TS, nullable=False),
        sa.Column("play_deadline", TS),
        sa.Column("scores", pg.JSONB(), nullable=False, server_default=EMPTY_OBJ),
        sa.Column("result", sa.String(10)),
        sa.Column("technical", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("result_version", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("rewards", pg.JSONB(), nullable=False, server_default=EMPTY),
        sa.Column("eligible", pg.JSONB(), nullable=False, server_default=EMPTY_OBJ),
        sa.Column("idempotency_key", sa.String(128), nullable=False),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column("created_at", TS, nullable=False),
        sa.Column("accepted_at", TS),
        sa.Column("finished_at", TS),
        sa.Column("updated_at", TS, nullable=False),
        sa.CheckConstraint("status IN ('challenged','declined','expired','accepted','finished','cancelled')",
                           name="ck_duels_status"),
        sa.CheckConstraint("result IS NULL OR result IN ('challenger','opponent','draw','none')",
                           name="ck_duels_result"),
        sa.CheckConstraint(f"level_band IN ({BANDS})", name="ck_duels_band"),
        sa.CheckConstraint("challenger IS NULL OR opponent IS NULL OR challenger <> opponent", name="ck_duels_self"),
        sa.CheckConstraint("result_version >= 0", name="ck_duels_version"),
        sa.UniqueConstraint("challenger", "idempotency_key", name="uq_duels_idempotency"),
    )
    op.create_index("uq_duels_active_pair", "duels", ["pair_key"], unique=True,
                    postgresql_where=sa.text("status IN ('challenged','accepted')"))
    op.create_index("ix_duels_challenger", "duels", ["challenger", "status"])
    op.create_index("ix_duels_opponent", "duels", ["opponent", "status"])
    op.create_index("ix_duels_challenged", "duels", ["accept_deadline"], postgresql_where=sa.text("status = 'challenged'"))
    op.create_index("ix_duels_accepted", "duels", ["play_deadline"], postgresql_where=sa.text("status = 'accepted'"))
    op.create_index("ix_duels_created", "duels", ["created_at", "duel_id"])
    op.create_index("ix_duels_finished", "duels", ["finished_at"], postgresql_where=sa.text("status = 'finished'"))

    op.create_table(
        "duel_results_history",
        sa.Column("duel_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("version", sa.Integer(), primary_key=True, autoincrement=False),
        sa.Column("result", sa.String(10), nullable=False),
        sa.Column("technical", sa.Boolean(), nullable=False),
        sa.Column("reason", sa.String(500)),
        sa.Column("decided_by", sa.String(80)),
        sa.Column("decided_by_name", sa.String(120)),
        sa.Column("at", TS, nullable=False),
        sa.CheckConstraint("result IN ('challenger','opponent','draw','none')", name="ck_duel_results_history_result"),
    )

    op.create_table(
        "referral_rewards",
        sa.Column("referral_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("inviter_user_id", pg.UUID(as_uuid=True)),
        sa.Column("invitee_user_id", pg.UUID(as_uuid=True)),
        sa.Column("campaign_version", sa.Integer(), nullable=False),
        sa.Column("op_ids", pg.JSONB(), nullable=False, server_default=EMPTY),
        sa.Column("rewarded_at", TS, nullable=False),
        sa.Column("qualified_at", TS, nullable=False),
        sa.Column("outcome", sa.String(16), nullable=False, server_default=sa.text("'rewarded'")),
        sa.CheckConstraint("outcome IN ('rewarded','inviter_capped','legacy')", name="ck_referral_rewards_outcome"),
    )
    op.create_index("ix_referral_rewards_inviter", "referral_rewards", ["inviter_user_id", "qualified_at"])
    op.create_index("ix_referral_rewards_invitee", "referral_rewards", ["invitee_user_id"])

    op.create_table(
        "pair_awards",
        sa.Column("room_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("xp", sa.Integer(), nullable=False),
        sa.Column("together", sa.Boolean(), nullable=False),
        sa.Column("local_date", sa.Date(), nullable=False),
        sa.Column("at", TS, nullable=False),
        sa.CheckConstraint("xp >= 0", name="ck_pair_awards_xp"),
    )
    op.create_index("ix_pair_awards_user_day", "pair_awards", ["user_id", "local_date"])

    op.create_table(
        "projection_loads",
        sa.Column("name", sa.String(16), primary_key=True),
        sa.Column("cursor", sa.String(500)),
        sa.Column("items", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("attempted_at", TS),
        sa.Column("completed_at", TS),
        sa.Column("error", sa.String(64)),
        sa.CheckConstraint("name IN ('families','friendships','levels','profiles')", name="ck_projection_loads_name"),
    )

    op.execute(RESULTS_GUARD)
    for table in ("league_results", "duel_results_history"):
        op.execute(f"CREATE TRIGGER {table}_guard BEFORE UPDATE OR DELETE ON {table} "
                   "FOR EACH ROW EXECUTE FUNCTION gamification_results_guard()")

    _data()


def _data() -> None:
    bind = op.get_bind()
    now = datetime.now(UTC)

    templates = sa.table("badge_templates", sa.column("code"), sa.column("metric"), sa.column("title", pg.JSONB()),
                         sa.column("description", pg.JSONB()), sa.column("unit", pg.JSONB()),
                         sa.column("asset_id"), sa.column("order"))
    exists = bind.execute(sa.text("SELECT 1 FROM badge_templates WHERE code = 'together'")).first()
    if exists is None:
        t = TOGETHER_TEMPLATE
        bind.execute(templates.insert().values(code=t["code"], metric=t["metric"], title=t["title"],
                                               description=t["description"], unit=None, asset_id=None,
                                               order=t["order"]))

    active = bind.execute(sa.text("SELECT version, payload FROM rules_versions WHERE status = 'active'")).first()
    if active is None or all(k in active.payload for k in SOCIAL_RULES):
        return
    payload = copy.deepcopy(dict(active.payload))
    for key, value in SOCIAL_RULES.items():
        payload.setdefault(key, copy.deepcopy(value))
    version = int(bind.execute(sa.text("SELECT coalesce(max(version), 0) FROM rules_versions")).scalar_one()) + 1
    # триггер разрешает активной версии только перевод в archived (остальные поля неизменны)
    bind.execute(sa.text("UPDATE rules_versions SET status = 'archived' WHERE status = 'active'"))
    rules = sa.table("rules_versions", sa.column("version"), sa.column("status"), sa.column("payload", pg.JSONB()),
                     sa.column("comment"), sa.column("based_on"), sa.column("created_by"),
                     sa.column("created_by_name"), sa.column("created_at"), sa.column("updated_at"),
                     sa.column("validated_at"), sa.column("activated_by"), sa.column("activated_by_name"),
                     sa.column("activated_at"))
    bind.execute(rules.insert().values(
        version=version, status="active", payload=payload,
        comment=RULES_COMMENT, based_on=int(active.version),
        created_by=SYSTEM, created_by_name=None, created_at=now, updated_at=now, validated_at=now,
        activated_by=SYSTEM, activated_by_name=None, activated_at=now))


def downgrade() -> None:
    for table in ("duel_results_history", "league_results"):
        op.execute(f"DROP TRIGGER IF EXISTS {table}_guard ON {table}")
    op.execute("DROP FUNCTION IF EXISTS gamification_results_guard()")
    for table in ("projection_loads", "pair_awards", "referral_rewards", "duel_results_history", "duels",
                  "league_results", "league_members",
                  "league_groups", "league_weeks", "learner_levels", "sanctions", "family_members", "community",
                  "social_blocks", "social_friends"):
        op.drop_table(table)
    op.execute("DELETE FROM badge_templates WHERE code = 'together'")
    # строки с новыми значениями (операции спринта 7, значки together) остаются: прежние CHECK — NOT VALID
    for table, name in (("badges", "ck_badges_metric"), ("badge_templates", "ck_badge_templates_metric")):
        op.drop_constraint(name, table, type_="check")
        op.execute(f"ALTER TABLE {table} ADD CONSTRAINT {name} CHECK (metric IN ({METRICS_V1})) NOT VALID")
    # рефералы: expired (появился в 0002) → void, как в спринте 6 для просроченных pending
    op.execute("UPDATE referrals SET status = 'void' WHERE status = 'expired'")
    op.drop_constraint("ck_referrals_status", "referrals", type_="check")
    op.create_check_constraint("ck_referrals_status", "referrals", "status IN ('pending','rewarded','capped','void')")
    op.drop_constraint("ck_learners_guardian_consent", "learners", type_="check")
    op.drop_column("learners", "profile_updated_at")
    op.drop_column("learners", "guardian_consent")
    op.drop_index("ix_learners_league_opt_in", table_name="learners")
    op.drop_constraint("ck_learners_together", "learners", type_="check")
    op.drop_column("learners", "together_count")
    op.drop_column("learners", "league_opt_in")
    op.execute(LEDGER_GUARD_V1)
    op.drop_index("ix_ledger_league_week", table_name="ledger")
    op.drop_constraint("ck_ledger_reason", "ledger", type_="check")
    op.execute(f"ALTER TABLE ledger ADD CONSTRAINT ck_ledger_reason CHECK (reason IN ({REASONS_V1})) NOT VALID")
    op.drop_column("ledger", "league_week")
    _revert_rules()


def _revert_rules() -> None:
    """Версия правил миграции снимается, если она последняя, активная и на неё нет ссылок (операции, задания): прежняя
    снова active. Иначе остаётся (её уже использовали) — код спринта 6 читает её, не замечая новых разделов."""
    bind = op.get_bind()
    row = bind.execute(sa.text(
        "SELECT version, based_on FROM rules_versions WHERE status = 'active' AND created_by = :s AND comment = :c "
        "AND version = (SELECT max(version) FROM rules_versions)"), {"s": SYSTEM, "c": RULES_COMMENT}).first()
    if row is None or row.based_on is None:
        return
    used = bind.execute(sa.text("SELECT EXISTS (SELECT 1 FROM ledger WHERE rules_version = :v) "
                                "OR EXISTS (SELECT 1 FROM quests WHERE rules_version = :v)"), {"v": row.version})
    if used.scalar():
        return
    # триггер неизменяемости правил снимает только владелец схемы (миграция) — на время отката
    op.execute("ALTER TABLE rules_versions DISABLE TRIGGER rules_versions_guard")
    bind.execute(sa.text("DELETE FROM rules_versions WHERE version = :v"), {"v": row.version})
    bind.execute(sa.text("UPDATE rules_versions SET status = 'active' WHERE version = :v"), {"v": row.based_on})
    op.execute("ALTER TABLE rules_versions ENABLE TRIGGER rules_versions_guard")
