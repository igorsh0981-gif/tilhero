"""Генератор JSON Schema событий (packages/contracts/events) из единого каталога TilHero.

Каталог — источник истины для payload. Изменение несовместимым образом = новая версия .vN.
Необязательные поля (не из required) получают тип «или null».
Запуск: uv run python infra/scripts/gen_event_schemas.py
"""
import json
from pathlib import Path

UUID = {"type": "string", "format": "uuid"}
TS = {"type": "string", "format": "date-time"}
STR = {"type": "string", "maxLength": 200}
BOOL = {"type": "boolean"}
DATE = {"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}$"}
HHMM = {"type": "string", "pattern": r"^([01]\d|2[0-3]):[0-5]\d$"}
INT = {"type": "integer", "minimum": 0}
AGE_BAND = {"type": "string", "enum": ["6-9", "10-13", "14-17", "18+"]}
UI_LANG = {"type": "string", "enum": ["ru", "uz"]}


def enum(*v):
    return {"type": "string", "enum": list(v)}


def arr(item, max_items=50):
    return {"type": "array", "items": item, "maxItems": max_items}


CATALOG = {
    # ------------------------------------------------------------ identity-consent
    # kind: account — аккаунт Telegram; child — детский профиль 6–13 у родителя (без своего Telegram)
    "user.profile.created.v1": ({"user_id": UUID, "kind": enum("account", "child"), "locale": STR,
                                 "age_band": AGE_BAND, "guardian_user_id": UUID, "created_at": TS},
                                ["user_id", "kind", "created_at"]),
    # возраст, имя ученика, согласие родителя (14–17) — без даты рождения и без PII
    "user.profile.updated.v1": ({"user_id": UUID, "changed_fields": arr(STR), "age_band": AGE_BAND,
                                 "is_minor": BOOL, "locale": STR,
                                 "guardian_consent": enum("not_required", "pending", "granted", "declined")},
                                ["user_id", "changed_fields"]),
    "user.status.changed.v1": ({"user_id": UUID, "status": enum("ACTIVE", "DISABLED", "DELETION_REQUESTED", "DELETED"),
                                "previous_status": STR, "reason_code": STR}, ["user_id", "status", "previous_status"]),
    "user.security.changed.v1": ({"user_id": UUID, "change": enum("pin_set", "pin_changed", "pin_removed", "pin_reset",
                                                                   "pin_reset_requested", "pin_reset_cancelled",
                                                                   "pin_locked", "biometric_enabled", "biometric_disabled")},
                                 ["user_id", "change"]),
    # basis: self — сам ученик; guardian — родитель за ребёнка 6–13 или подростка 14–17 (granted_by_user_id — родитель)
    "consent.accepted.v1": ({"user_id": UUID, "consent_id": UUID, "policy_version": STR, "purposes": arr(STR),
                             "age_band": AGE_BAND, "basis": enum("self", "guardian"), "granted_by_user_id": UUID},
                            ["user_id", "consent_id", "policy_version", "purposes"]),
    "consent.revoked.v1": ({"user_id": UUID, "consent_id": UUID, "policy_version": STR,
                            "basis": enum("self", "guardian"), "revoked_by_user_id": UUID}, ["user_id", "consent_id"]),
    # настройки уведомлений: категории и тихие часы (сброс кэша адресации в notifications)
    "user.notification_settings.changed.v1": ({"user_id": UUID, "enabled": BOOL, "categories": arr(STR, 10)},
                                              ["user_id", "enabled", "categories"]),
    "user.deletion.requested.v1": ({"user_id": UUID, "request_id": UUID, "requested_at": TS,
                                    "attempt": {"type": "integer", "minimum": 1}},
                                   ["user_id", "request_id", "requested_at"]),
    "user.deletion.stuck.v1": ({"request_id": UUID, "user_id": UUID, "requested_at": TS, "stuck_at": TS,
                                "pending_domains": {"type": "array", "maxItems": 50, "items": STR},
                                "attempts": {"type": "integer", "minimum": 1}},
                               ["request_id", "user_id", "requested_at", "stuck_at", "pending_domains", "attempts"]),
    "user.domain.deleted.v1": ({"user_id": UUID, "request_id": UUID, "domain": STR, "mode": enum("deleted", "anonymized")},
                               ["user_id", "request_id", "domain", "mode"]),
    # ------------------------------------------------------------ learning-plan
    # ------------------------------------------------------------ catalog (спринт 3)
    "catalog.version.published.v1": ({"kind": enum("course", "skill", "module", "lesson", "rubric", "scenario",
                                                   "media_asset", "media_exercise", "reading"),
                                      "key": STR, "version": INT, "previous_version": INT,
                                      "action": enum("published", "rolled_back", "archived"), "course_id": STR,
                                      "published_by": UUID, "published_at": TS},
                                     ["kind", "key", "action", "published_at"]),
    "catalog.media.suspended.v1": ({"asset_id": STR, "version": INT,
                                    "reason": enum("rights_expired", "rights_revoked"), "suspended_at": TS},
                                   ["asset_id", "version", "reason", "suspended_at"]),
    "catalog.media_request.created.v1": ({"request_id": UUID, "user_id": UUID,
                                          "kind": enum("song", "movie", "series", "other"), "created_at": TS},
                                         ["request_id", "user_id", "kind", "created_at"]),
    "catalog.media_request.decided.v1": ({"request_id": UUID, "user_id": UUID,
                                          "status": enum("authored_alternative", "licensed", "rejected", "duplicate"),
                                          "title": STR, "linked_asset_id": STR, "decided_at": TS},
                                         ["request_id", "user_id", "status", "title", "decided_at"]),
    # ------------------------------------------------------------ diagnostics (спринт 3)
    "diagnostics.completed.v1": ({"user_id": UUID, "pair_id": STR, "result_id": UUID,
                                  "revision": {"type": "integer", "minimum": 1}, "test_id": STR, "test_version": INT,
                                  "provisional_level": enum("A0", "A1", "A2", "B1", "B2"),
                                  "areas": {"type": "object", "maxProperties": 8, "additionalProperties": {
                                      "type": "object", "additionalProperties": False,
                                      "required": ["status"],
                                      "properties": {"status": enum("assessed", "not_assessed"),
                                                     "band": {"type": ["string", "null"],
                                                              "enum": ["A0", "A1", "A2", "B1", "B2", None]},
                                                     "confidence": {"type": ["number", "null"], "minimum": 0,
                                                                    "maximum": 1}}}},
                                  "recommended_start_lesson_id": STR, "completed_at": TS},
                                 ["user_id", "pair_id", "result_id", "revision", "test_id", "test_version", "areas",
                                  "completed_at"]),
    "skills.state.changed.v1": ({"user_id": UUID, "pair_id": STR,
                                 "changes": arr({"type": "object", "additionalProperties": False,
                                                 "required": ["skill_id", "from", "to", "source"],
                                                 "properties": {
                                                     "skill_id": STR,
                                                     "from": enum("not_started", "learning", "demonstrated", "retained"),
                                                     "to": enum("not_started", "learning", "demonstrated", "retained"),
                                                     "source": enum("diagnostic", "lesson", "retention"),
                                                     "evidence_id": UUID}}, 500),
                                 "occurred_at": TS},
                                ["user_id", "pair_id", "changes", "occurred_at"]),
    # ------------------------------------------------------------ lessons (спринт 4)
    "lesson.session.started.v1": ({"session_id": UUID, "user_id": UUID, "kind": enum("lesson", "scenario", "media", "review", "reading"),
                                   "pair_id": STR, "lesson_id": STR, "scenario_id": STR, "asset_id": STR,
                                   "ai_mode": enum("full", "choices"), "started_at": TS},
                                  ["session_id", "user_id", "kind", "pair_id", "ai_mode", "started_at"]),
    "lesson.session.completed.v1": ({"session_id": UUID, "user_id": UUID,
                                     "kind": enum("lesson", "scenario", "media", "review", "reading"), "pair_id": STR,
                                     "lesson_id": STR, "scenario_id": STR, "asset_id": STR,
                                     "status": enum("completed", "cancelled", "failed"),
                                     "outcome": {"type": ["string", "null"], "enum": ["success", "alt_success", "fail", None]},
                                     "minutes": {"type": "integer", "minimum": 0, "maximum": 600},
                                     "local_date": DATE, "evaluation_id": UUID, "passed": BOOL, "practice_only": BOOL,
                                     "finished_at": TS},
                                    ["session_id", "user_id", "kind", "pair_id", "status", "minutes", "practice_only",
                                     "finished_at"]),
    # ------------------------------------------------------------ assessment (спринт 4)
    "assessment.completed.v1": ({"evaluation_id": UUID, "user_id": UUID, "pair_id": STR, "session_id": UUID,
                                 "kind": enum("lesson", "scenario", "media", "review", "reading"),
                                 "skill_outcomes": arr({"type": "object", "additionalProperties": False,
                                                        "required": ["skill_id", "outcome"],
                                                        "properties": {"skill_id": STR,
                                                                       "outcome": enum("demonstrated", "learning",
                                                                                       "not_assessed")}}, 100),
                                 "passed": BOOL, "practice_only": BOOL, "supersedes": UUID, "created_at": TS},
                                ["evaluation_id", "user_id", "pair_id", "session_id", "kind", "skill_outcomes",
                                 "practice_only", "created_at"]),
    "assessment.reevaluated.v1": ({"evaluation_id": UUID, "supersedes": UUID, "session_id": UUID, "user_id": UUID,
                                   "pair_id": STR,
                                   "skill_outcomes": arr({"type": "object", "additionalProperties": False,
                                                          "required": ["skill_id", "outcome"],
                                                          "properties": {"skill_id": STR,
                                                                         "outcome": enum("demonstrated", "learning",
                                                                                         "not_assessed")}}, 100),
                                   "passed": BOOL, "appeal_id": UUID, "created_at": TS},
                                  ["evaluation_id", "supersedes", "session_id", "user_id", "pair_id", "skill_outcomes",
                                   "created_at"]),
    "assessment.appeal.decided.v1": ({"appeal_id": UUID, "evaluation_id": UUID, "user_id": UUID,
                                      "decision": enum("upheld", "corrected"), "decided_at": TS},
                                     ["appeal_id", "evaluation_id", "user_id", "decision", "decided_at"]),
    # ------------------------------------------------------------ memory (спринт 5)
    # «Повторение дня» завершено (или истекло с ответами) — learning-plan засчитывает занятие review
    "memory.review.completed.v1": ({"session_id": UUID, "user_id": UUID, "pair_id": STR,
                                    "status": enum("completed", "expired"),
                                    "minutes": {"type": "integer", "minimum": 0, "maximum": 60},
                                    "reviewed": INT, "correct": INT, "finished_at": TS},
                                   ["session_id", "user_id", "pair_id", "status", "minutes", "reviewed", "correct",
                                    "finished_at"]),
    # вечер (19:00 по поясу плана): к сроку ≥ 5 карточек, повторения сегодня не было — notifications reviews_due
    "memory.reviews.due.v1": ({"user_id": UUID, "local_date": DATE,
                               "due_count": {"type": "integer", "minimum": 1, "maximum": 2000}, "timezone": STR},
                              ["user_id", "local_date", "due_count", "timezone"]),
    # проверка удержания навыка через 7/30 дней — diagnostics: d30 passed → retained, 2 провала подряд → learning
    "memory.retention.checked.v1": ({"check_id": UUID, "user_id": UUID, "pair_id": STR, "skill_id": STR,
                                     "stage": enum("d7", "d30"), "passed": BOOL,
                                     "consecutive_failures": {"type": "integer", "minimum": 0, "maximum": 2},
                                     "evidence_id": UUID, "checked_at": TS},
                                    ["check_id", "user_id", "pair_id", "skill_id", "stage", "passed",
                                     "consecutive_failures", "checked_at"]),
    # ------------------------------------------------------------ gamification (спринт 6)
    # заморозка закрыла пропуск дня графика — learning-plan: день frozen, серия не рвётся; notifications streak_frozen
    "game.streak.frozen.v1": ({"user_id": UUID, "local_date": DATE, "op_id": UUID,
                               "freeze_left": {"type": "integer", "minimum": 0, "maximum": 30}, "frozen_at": TS},
                              ["user_id", "local_date", "op_id", "freeze_left", "frozen_at"]),
    "game.level.reached.v1": ({"user_id": UUID, "level": {"type": "integer", "minimum": 2, "maximum": 100},
                               "xp_total": INT, "reached_at": TS},
                              ["user_id", "level", "xp_total", "reached_at"]),
    # notify=false — ученик выключил игровые уведомления (notifications не отправляет)
    "game.hero.stage_reached.v1": ({"user_id": UUID, "hero_code": {"type": "string", "pattern": r"^(robot|pet|human)_[0-9]$"},
                                    "stage": {"type": "integer", "enum": [2, 3]}, "confirmed_skills": INT,
                                    "notify": BOOL, "reached_at": TS},
                                   ["user_id", "hero_code", "stage", "confirmed_skills", "notify", "reached_at"]),
    "game.badge.earned.v1": ({"user_id": UUID, "badge_code": {"type": "string", "pattern": r"^[a-z0-9_]{3,40}$"},
                              "notify": BOOL, "earned_at": TS},
                             ["user_id", "badge_code", "notify", "earned_at"]),
    "game.purchase.completed.v1": ({"purchase_id": UUID, "user_id": UUID,
                                    "item_code": {"type": "string", "pattern": r"^[a-z0-9_]{3,40}$"},
                                    "item_kind": enum("background", "hero_frame", "streak_freeze"),
                                    "price_til": {"type": "integer", "minimum": 1, "maximum": 10000},
                                    "purchased_at": TS},
                                   ["purchase_id", "user_id", "item_code", "item_kind", "price_til", "purchased_at"]),
    "game.rules.activated.v1": ({"version": {"type": "integer", "minimum": 1},
                                 "based_on": {"type": "integer", "minimum": 1}, "activated_by": UUID,
                                 "activated_at": TS},
                                ["version", "activated_by", "activated_at"]),
    # ------------------------------------------------------------ catalog: словарь курса (спринт 5)
    "catalog.glossary.changed.v1": ({"pair_id": STR, "entry_id": UUID, "forms": arr(STR, 8),
                                     "change": enum("created", "updated", "reviewed", "archived"), "occurred_at": TS},
                                    ["pair_id", "entry_id", "forms", "change", "occurred_at"]),
    # ------------------------------------------------------------ learning-plan: траектория (спринт 3)
    "learning.trajectory.updated.v1": ({"user_id": UUID, "pair_id": STR, "revision": {"type": "integer", "minimum": 1},
                                        "next_lesson_id": STR, "reason_codes": arr(STR, 10), "computed_at": TS},
                                       ["user_id", "pair_id", "revision", "computed_at"]),
    "learning.plan.updated.v1": ({"user_id": UUID, "changed_fields": arr(STR), "goal": STR, "ui_lang": UI_LANG,
                                  "course_pair": STR, "timezone": STR,
                                  "days": arr({"type": "integer", "minimum": 1, "maximum": 7}, 7),
                                  "preferred_time": HHMM,
                                  "duration_min": {"type": "integer", "enum": [10, 15, 20, 30]},
                                  "reminders_enabled": BOOL, "onboarding_completed": BOOL,
                                  # спринт 2: для read-модели админки (user-admin) без досрочной сверки
                                  "level_self": {"type": ["string", "null"],
                                                 "enum": ["zero", "beginner", "some", "confident", None]},
                                  "preset": {"type": "string",
                                             "enum": ["daily", "weekdays", "three_per_week", "custom"]}},
                                 ["user_id", "changed_fields"]),
    # наступил слот графика, занятия сегодня ещё не было, напоминания включены
    "learning.reminder.due.v1": ({"user_id": UUID, "local_date": DATE, "slot_time": HHMM, "timezone": STR,
                                  "duration_min": {"type": "integer", "enum": [10, 15, 20, 30]}, "streak_days": INT},
                                 ["user_id", "local_date", "slot_time", "timezone", "duration_min"]),
    # местный день слота закончился без занятия
    "learning.session.missed.v1": ({"user_id": UUID, "local_date": DATE, "slot_time": HHMM, "timezone": STR,
                                    "consecutive_missed": {"type": "integer", "minimum": 1},
                                    "next_slot_date": DATE},
                                   ["user_id", "local_date", "slot_time", "timezone", "consecutive_missed"]),
    # занятие засчитано в день графика (урок, повторение, практика)
    # streak_days (спринт 6, необязательное) — серия после записи занятия (gamification: значки серии)
    "learning.activity.recorded.v1": ({"user_id": UUID, "activity_id": UUID, "local_date": DATE,
                                       "kind": enum("lesson", "review", "practice", "diagnostic"),
                                       "minutes": {"type": "integer", "minimum": 0, "maximum": 240},
                                       "recorded_at": TS, "streak_days": INT},
                                      ["user_id", "activity_id", "local_date", "kind", "minutes", "recorded_at"]),
    # ------------------------------------------------------------ social
    "social.invite.created.v1": ({"invite_id": UUID, "inviter_user_id": UUID, "kind": enum("family", "friend", "referral"),
                                  "expires_at": TS}, ["invite_id", "inviter_user_id", "kind"]),
    "social.invite.opened.v1": ({"invite_id": UUID, "inviter_user_id": UUID, "invitee_user_id": UUID,
                                 "kind": enum("family", "friend", "referral"), "opened_at": TS},
                                ["invite_id", "inviter_user_id", "invitee_user_id", "kind", "opened_at"]),
    "social.invite.accepted.v1": ({"invite_id": UUID, "inviter_user_id": UUID, "invitee_user_id": UUID,
                                   "kind": enum("family", "friend", "referral"), "accepted_at": TS},
                                  ["invite_id", "inviter_user_id", "invitee_user_id", "kind", "accepted_at"]),
    "social.invite.declined.v1": ({"invite_id": UUID, "inviter_user_id": UUID, "invitee_user_id": UUID,
                                   "kind": enum("family", "friend", "referral"), "declined_at": TS},
                                  ["invite_id", "inviter_user_id", "invitee_user_id", "kind", "declined_at"]),
    # получатель открыл приглашение, но не ответил 24 ч — одно напоминание
    "social.invite.reminder_due.v1": ({"invite_id": UUID, "inviter_user_id": UUID, "invitee_user_id": UUID,
                                       "kind": enum("family", "friend", "referral")},
                                      ["invite_id", "inviter_user_id", "invitee_user_id", "kind"]),
    "social.family.member_added.v1": ({"family_id": UUID, "owner_user_id": UUID, "user_id": UUID,
                                       "role": enum("owner", "adult", "teen", "child"), "added_at": TS},
                                      ["family_id", "owner_user_id", "user_id", "role", "added_at"]),
    # ------------------------------------------------------------ notifications
    "notification.requested.v1": ({
        "notification_id": UUID, "user_id": UUID,
        "kind": enum("critical", "transactional", "standard"),
        "category": enum("reminders", "missed", "social", "support", "product", "service"),
        "template": {"type": "string", "pattern": "^[a-z][a-z0-9_.]*$", "not": {"pattern": "^pin\\."}},
        "params": {"type": "object"},
        "dedup_key": {"type": "string", "maxLength": 200},
        "startapp": {"type": "string", "pattern": "^[A-Za-z0-9_-]{1,64}$"},
    }, ["notification_id", "user_id", "kind", "category", "template", "dedup_key"]),
    "notification.delivered.v1": ({"notification_id": UUID, "user_id": UUID, "channel": enum("telegram"),
                                   "delivered_at": TS}, ["notification_id", "user_id", "channel", "delivered_at"]),
    "telegram.delivery.failed.v1": ({"notification_id": UUID, "user_id": UUID,
                                     "reason": enum("blocked", "invalid_chat", "rate_limited", "error")},
                                    ["notification_id", "user_id", "reason"]),
    # ------------------------------------------------------------ support
    "support.ticket.created.v1": ({"ticket_id": UUID, "number": STR, "user_id": UUID, "category": STR, "priority": STR,
                                   "sla_first_response_at": TS},
                                  ["ticket_id", "number", "user_id", "category", "priority"]),
    "support.ticket.replied.v1": ({"ticket_id": UUID, "number": STR, "user_id": UUID, "message_id": UUID,
                                   "sender_type": enum("operator", "system"), "replied_at": TS},
                                  ["ticket_id", "number", "user_id", "message_id", "sender_type"]),
    "support.ticket.status.changed.v1": ({"ticket_id": UUID, "number": STR, "user_id": UUID,
                                          "from_status": STR, "to_status": STR, "changed_by": enum("user", "operator", "system")},
                                         ["ticket_id", "number", "from_status", "to_status", "changed_by"]),
    # ------------------------------------------------------------ experience-config
    "experience.config.activated.v1": ({"app": enum("miniapp", "admin"), "version": STR, "previous_version": STR,
                                        "activation_id": UUID}, ["app", "version", "activation_id"]),
    "experience.release_note.published.v1": ({"release_note_id": UUID, "slug": STR,
                                              "audience": enum("new", "existing", "all"),
                                              "segments": {"type": "object", "additionalProperties": False, "properties": {
                                                  "age": {"type": "array", "uniqueItems": True,
                                                          "items": enum("kids", "teens", "adults")},
                                                  "ui_lang": {"type": "array", "uniqueItems": True,
                                                              "items": enum("ru", "uz")}}},
                                              "published_at": TS},
                                             ["release_note_id", "slug", "audience", "published_at"]),
    # ------------------------------------------------------------ audit (payload = запись журнала)
    "admin.audit.recorded.v1": ({"record_id": UUID, "occurred_at": TS, "actor_type": enum("staff", "user", "system", "service"),
                                 "actor_id": STR, "actor_role": STR, "action": STR, "object_type": STR, "object_id": STR,
                                 "before": {}, "after": {}, "reason": {"type": "string"}, "ip": STR, "session_id": STR,
                                 "trace_id": STR}, ["record_id", "occurred_at", "actor_type", "action"]),
}


def nullable(schema):
    if not schema:
        return schema
    return {"anyOf": [schema, {"type": "null"}]}


def main() -> None:
    out = Path(__file__).resolve().parents[2] / "packages" / "contracts" / "events"
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("*.schema.json"):
        old.unlink()
    envelope = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "envelope.schema.json",
        "title": "TilHero event envelope",
        "type": "object",
        "required": ["event_id", "event_type", "occurred_at", "producer", "correlation_id", "payload"],
        "additionalProperties": False,
        "properties": {
            "event_id": UUID, "event_type": {"type": "string", "pattern": r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+\.v[0-9]+$"},
            "occurred_at": TS, "producer": STR, "correlation_id": STR, "causation_id": nullable(STR),
            "payload": {"type": "object"},
        },
    }
    (out / "envelope.schema.json").write_text(json.dumps(envelope, indent=2, ensure_ascii=False) + "\n")
    for name, (props, required) in CATALOG.items():
        schema = {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$id": f"{name}.schema.json",
            "title": name,
            "type": "object",
            "required": required,
            "additionalProperties": False,
            "properties": {k: (v if k in required else nullable(v)) for k, v in props.items()},
        }
        (out / f"{name}.schema.json").write_text(json.dumps(schema, indent=2, ensure_ascii=False) + "\n")
    print(f"{len(CATALOG)} event schemas → {out}")


if __name__ == "__main__":
    main()
