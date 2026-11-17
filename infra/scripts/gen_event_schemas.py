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
                                                                   "pin_locked", "biometric_enabled", "biometric_disabled")},
                                 ["user_id", "change"]),
    "consent.accepted.v1": ({"user_id": UUID, "consent_id": UUID, "policy_version": STR, "purposes": arr(STR),
                             "age_band": AGE_BAND}, ["user_id", "consent_id", "policy_version", "purposes"]),
    "consent.revoked.v1": ({"user_id": UUID, "consent_id": UUID, "policy_version": STR}, ["user_id", "consent_id"]),
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
    "learning.plan.updated.v1": ({"user_id": UUID, "changed_fields": arr(STR), "goal": STR, "ui_lang": UI_LANG,
                                  "course_pair": STR, "timezone": STR,
                                  "days": arr({"type": "integer", "minimum": 1, "maximum": 7}, 7),
                                  "preferred_time": HHMM,
                                  "duration_min": {"type": "integer", "enum": [10, 15, 20, 30]},
                                  "reminders_enabled": BOOL, "onboarding_completed": BOOL},
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
    "learning.activity.recorded.v1": ({"user_id": UUID, "activity_id": UUID, "local_date": DATE,
                                       "kind": enum("lesson", "review", "practice", "diagnostic"),
                                       "minutes": {"type": "integer", "minimum": 0, "maximum": 240},
                                       "recorded_at": TS},
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
