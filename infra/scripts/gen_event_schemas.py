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


def obj(props, required=None):
    """Вложенный объект: строго, без лишних полей; required по умолчанию — все поля."""
    return {"type": "object", "additionalProperties": False, "required": list(required or props),
            "properties": props}


# ------------------------------------------------------------ спринт 7 (социальное)
# ник сообщества (3–20) или null — не задан; обязательное поле со значением null
NICK = {"type": ["string", "null"], "minLength": 3, "maxLength": 20}
MEMBER_ID = {"type": "string", "pattern": r"^mb_[A-Za-z0-9_-]{22}$"}
LEVEL_BAND = enum("A0-A1", "A2", "B1+")
REWARD = obj({"freeze": {"type": "integer", "minimum": 0, "maximum": 10},
              "til": {"type": "integer", "minimum": 0, "maximum": 10000}})
SCORE = obj({"correct": {"type": "integer", "minimum": 0, "maximum": 50},
             "total": {"type": "integer", "minimum": 1, "maximum": 50}})
SCORE_OR_NULL = {"anyOf": [SCORE, {"type": "null"}]}
UUID_OR_NULL = {"type": ["string", "null"], "format": "uuid"}
SESSION_KINDS = ("lesson", "scenario", "media", "review", "reading")

# ------------------------------------------------------------ спринт 8 (деньги и контроль ИИ)
# Деньги — целые числа (ADR-0001): сумы — тийины (1 сум = 100 тийинов, валюта UZS), Stars — целые звёзды (XTR).
# В событии заказа и возврата заполнено ровно одно из amount_tiyin / amount_stars (по currency), второе — null.
TS_OR_NULL = {"type": ["string", "null"], "format": "date-time"}
TIYIN_OR_NULL = {"type": ["integer", "null"], "minimum": 100, "maximum": 100_000_000_000}
STARS_OR_NULL = {"type": ["integer", "null"], "minimum": 1, "maximum": 100_000}
ORDER_NO = {"type": "integer", "minimum": 100_001}
PRODUCT_CODE = {"type": "string", "pattern": r"^[a-z0-9_]{2,40}$"}
PRODUCT_CODE_OR_NULL = {"type": ["string", "null"], "pattern": r"^[a-z0-9_]{2,40}$"}
TITLE_RU_UZ = obj({"ru": {"type": "string", "minLength": 1, "maxLength": 60},
                   "uz": {"type": "string", "minLength": 1, "maxLength": 60}})
CHANNEL = enum("miniapp", "web", "renewal")
PROVIDER = enum("telegram_stars", "payme", "click", "uzum")
CURRENCY = enum("UZS", "XTR")
PRODUCT_KIND = enum("subscription", "til_pack")
FEATURES = {**arr(enum("ai_lessons", "pair_lessons"), 2), "uniqueItems": True}
MINUTES = {"type": "integer", "minimum": 0, "maximum": 100_000}
MINUTES_OR_NULL = {"type": ["integer", "null"], "minimum": 0, "maximum": 100_000}
TIL_PACK = {"type": "integer", "minimum": 1, "maximum": 100_000}
DEGRADATION_LEVEL = enum("normal", "economy", "paid_only", "off")


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
    # спринт 7: kind duel — сессия заданий дуэли (duel_id)
    "lesson.session.started.v1": ({"session_id": UUID, "user_id": UUID, "kind": enum(*SESSION_KINDS, "duel"),
                                   "pair_id": STR, "lesson_id": STR, "scenario_id": STR, "asset_id": STR,
                                   "ai_mode": enum("full", "choices"), "started_at": TS, "duel_id": UUID},
                                  ["session_id", "user_id", "kind", "pair_id", "ai_mode", "started_at"]),
    # спринт 7: kind duel — задания дуэли (duel_id, score; practice_only=true, без оценки — учёбу не меняет);
    # kind pair — участие в парном уроке, по событию на участника: session_id — сессия участника
    # uuid5(room_id, str(user_id)), room_id, evaluation_id — его оценка (без вклада — null). Для рефералов и пройденных
    # уроков duel и pair — не урок (зачётный — только kind lesson); learning-plan — занятие practice (INTERNAL_API
    # спринта 7 §10, п. 2)
    "lesson.session.completed.v1": ({"session_id": UUID, "user_id": UUID,
                                     "kind": enum(*SESSION_KINDS, "duel", "pair"), "pair_id": STR,
                                     "lesson_id": STR, "scenario_id": STR, "asset_id": STR,
                                     "status": enum("completed", "cancelled", "failed"),
                                     "outcome": {"type": ["string", "null"], "enum": ["success", "alt_success", "fail", None]},
                                     "minutes": {"type": "integer", "minimum": 0, "maximum": 600},
                                     "local_date": DATE, "evaluation_id": UUID, "passed": BOOL, "practice_only": BOOL,
                                     "finished_at": TS, "duel_id": UUID, "room_id": UUID, "score": SCORE,
                                     # спринт 8 (необязательные; прежние читатели терпимы): ИИ-минуты к списанию
                                     # ⌈ai_active_seconds/60⌉ и удержание billing, созданное при старте (нет — null)
                                     "billable_minutes": {"type": "integer", "minimum": 0, "maximum": 240},
                                     "billing_hold_id": UUID},
                                    ["session_id", "user_id", "kind", "pair_id", "status", "minutes", "practice_only",
                                     "finished_at"]),
    # ------------------------------------------------------------ lessons: парный урок (спринт 7)
    # приглашение в парный урок → notifications pair_invited (ник пригласившего — для текста; null — не задан)
    "lesson.pair.invited.v1": ({"room_id": UUID, "inviter_user_id": UUID, "invitee_user_id": UUID,
                                "inviter_nickname": NICK, "pair_id": STR, "scenario_id": STR,
                                "mode": enum("free", "choices"), "start_at": TS, "invited_at": TS},
                               ["room_id", "inviter_user_id", "invitee_user_id", "inviter_nickname", "pair_id",
                                "scenario_id", "mode", "start_at", "invited_at"]),
    # запланированная комната (принята, waiting) начнётся через 5 минут — notifications pair_starting обоим
    "lesson.pair.starting.v1": ({"room_id": UUID, "user_ids": {**arr(UUID, 2), "minItems": 2, "uniqueItems": True},
                                 "scenario_id": STR, "start_at": TS},
                                ["room_id", "user_ids", "scenario_id", "start_at"]),
    # комната завершена (участники — вошедшие в комнату) → gamification (XP за вклад, значок together_1),
    # notifications (end_reason stopped — pair_stopped). Тексты реплик и оценки в событие не входят
    "lesson.pair.completed.v1": ({"room_id": UUID, "scenario_id": STR, "pair_id": STR,
                                  "status": enum("finished", "abandoned", "stopped"),
                                  "end_reason": enum("completed", "participant_left", "inactivity", "stopped"),
                                  "team_goal_reached": BOOL,
                                  "participants": {**arr(obj({
                                      "user_id": UUID,
                                      "role": {"type": ["string", "null"], "enum": ["A", "B", None]},
                                      "contributed": BOOL,
                                      "turns": {"type": "integer", "minimum": 0, "maximum": 500},
                                      "speaking_seconds": {"type": "integer", "minimum": 0, "maximum": 7200},
                                      "minutes": {"type": "integer", "minimum": 0, "maximum": 240}}), 2),
                                      "minItems": 1},
                                  "ended_at": TS,
                                  # спринт 8 (необязательное): списание минут урока вдвоём у пригласившего — один раз
                                  # за комнату по времени работы коуча ⌈coach_active_seconds/60⌉; null — без удержания
                                  # (комната без коуча, с ребёнком, BILLING_ENFORCED=false)
                                  "billing": obj({"payer_user_id": UUID, "hold_id": UUID,
                                                  "billable_minutes": {"type": "integer", "minimum": 0,
                                                                       "maximum": 240}})},
                                 ["room_id", "scenario_id", "pair_id", "status", "end_reason", "team_goal_reached",
                                  "participants", "ended_at"]),
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
                               "freeze_left": INT, "frozen_at": TS},
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
    # ------------------------------------------------------------ gamification (спринт 7)
    # награды по social.referral.qualified.v1 обработаны (ack) → social: referral rewarded. outcome (необязательное,
    # нет — rewarded): rewarded — награды выданы; legacy — приглашённый уже награждён (или упёрся в лимит) по правилу
    # спринта 6, пригласившему по кампании ничего; inviter_capped — месячный лимит пригласившего исчерпан с наградами
    # спринта 6, пригласившему ничего. Приветственная награда приглашённого — во всех исходах. inviter_reward
    # (необязательное) — фактически выданное пригласившему; null — ничего (legacy, inviter_capped, пригласивший удалён).
    # notifications: referral_qualified пригласившему — только при outcome rewarded (или без поля)
    "game.referral.rewarded.v1": ({"referral_id": UUID, "inviter_user_id": UUID, "invitee_user_id": UUID,
                                   "rewarded_at": TS, "outcome": enum("rewarded", "legacy", "inviter_capped"),
                                   "inviter_reward": REWARD},
                                  ["referral_id", "inviter_user_id", "rewarded_at"]),
    # итоги группы общей лиги закрыты (version 1) или переоценены / призы выданы после удержания (version + 1) →
    # notifications league_closed (место и приз). prizes_held — призы удержаны до решения администратора (prize_til 0)
    "game.league.closed.v1": ({"week": DATE, "group_id": UUID, "version": {"type": "integer", "minimum": 1},
                               "pair_id": STR, "level_band": LEVEL_BAND, "prizes_held": BOOL,
                               "standings": arr(obj({"user_id": UUID,
                                                     "place": {"type": "integer", "minimum": 1, "maximum": 100},
                                                     "xp": INT,
                                                     "prize_til": {"type": "integer", "minimum": 0,
                                                                   "maximum": 10000}}), 50),
                               "closed_at": TS},
                              ["week", "group_id", "version", "pair_id", "level_band", "prizes_held", "standings",
                               "closed_at"]),
    # вызов на дуэль → notifications duel_challenged (ник вызывающего — для текста; null — не задан)
    "game.duel.challenged.v1": ({"duel_id": UUID, "challenger_user_id": UUID, "opponent_user_id": UUID,
                                 "challenger_nickname": NICK, "pair_id": STR, "level_band": LEVEL_BAND,
                                 "accept_deadline": TS, "created_at": TS},
                                ["duel_id", "challenger_user_id", "opponent_user_id", "challenger_nickname", "pair_id",
                                 "level_band", "accept_deadline", "created_at"]),
    # дуэль завершена (finished) или отменена после принятия — никто не сыграл (cancelled, result none) →
    # notifications duel_finished, lessons (разбор ответов открывается). Переоценка — result_version + 1
    "game.duel.finished.v1": ({"duel_id": UUID, "challenger_user_id": UUID, "opponent_user_id": UUID,
                               "status": enum("finished", "cancelled"),
                               "result": enum("challenger", "opponent", "draw", "none"), "technical": BOOL,
                               "result_version": {"type": "integer", "minimum": 1},
                               "scores": obj({"challenger": SCORE_OR_NULL, "opponent": SCORE_OR_NULL}),
                               "finished_at": TS},
                              ["duel_id", "challenger_user_id", "opponent_user_id", "status", "result", "technical",
                               "result_version", "scores", "finished_at"]),
    # ------------------------------------------------------------ gamification (спринт 8): тилы по заказу billing
    # billing.order.paid.v1 (til_pack) обработан → billing: заказ fulfilled. outcome user_deleted — получатель удалён,
    # тилы не начислены (op_id null): заказ закрывается, деньги — возвратом сотрудником
    "game.til_pack.credited.v1": ({"order_id": UUID, "user_id": UUID, "til": TIL_PACK, "op_id": UUID_OR_NULL,
                                   "outcome": enum("credited", "user_deleted"), "credited_at": TS},
                                  ["order_id", "user_id", "til", "op_id", "outcome", "credited_at"]),
    # billing.order.refunded.v1 (til_pack) обработан: reversed — обратная запись; tils_spent — тилов не хватило
    # (пункт сверки tils_spent_on_refund); user_deleted — получатель удалён
    "game.til_pack.reversed.v1": ({"order_id": UUID, "user_id": UUID,
                                   "outcome": enum("reversed", "tils_spent", "user_deleted"), "at": TS},
                                  ["order_id", "user_id", "outcome", "at"]),
    # ------------------------------------------------------------ billing (спринт 8, INTERNAL_API §10)
    # Без ПДн и Telegram ID. Заказ оплачен: подписка — период уже выдан в той же транзакции (period — его даты;
    # запланированный «после текущего» — даты null до активации); til_pack — заказ paid, тилы начисляет gamification
    # (til — размер пакета). → gamification (til_pack), notifications (канал miniapp|renewal — payment_succeeded, web —
    # purchase_applied без суммы и провайдера)
    "billing.order.paid.v1": ({"order_id": UUID, "order_no": ORDER_NO, "account_id": UUID, "beneficiary_user_id": UUID,
                               "channel": CHANNEL, "product_kind": PRODUCT_KIND, "product_code": PRODUCT_CODE,
                               "product_title": TITLE_RU_UZ, "currency": CURRENCY, "amount_tiyin": TIYIN_OR_NULL,
                               "amount_stars": STARS_OR_NULL, "provider": PROVIDER, "til": TIL_PACK,
                               "period": {"anyOf": [obj({"starts_at": TS_OR_NULL, "ends_at": TS_OR_NULL}),
                                                    {"type": "null"}]},
                               "paid_at": TS},
                              ["order_id", "order_no", "account_id", "beneficiary_user_id", "channel", "product_kind",
                               "product_code", "product_title", "currency", "amount_tiyin", "amount_stars", "provider",
                               "period", "paid_at"]),
    # возврат завершён (staff — по решению сотрудника, provider — по инициативе провайдера / Telegram). account_id и
    # beneficiary_user_id — null у обезличенного заказа (аккаунт удалён, В15) → gamification (til_pack: обратная
    # запись), notifications refund_completed (miniapp — со звёздами; web — нейтрально, без суммы и способа оплаты)
    "billing.order.refunded.v1": ({"order_id": UUID, "order_no": ORDER_NO, "account_id": UUID_OR_NULL,
                                   "beneficiary_user_id": UUID_OR_NULL, "channel": CHANNEL,
                                   "product_kind": PRODUCT_KIND, "currency": CURRENCY,
                                   "amount_tiyin": TIYIN_OR_NULL, "amount_stars": STARS_OR_NULL, "refund_id": UUID,
                                   "initiated_by": enum("staff", "provider"), "refunded_at": TS},
                                  ["order_id", "order_no", "account_id", "beneficiary_user_id", "channel",
                                   "product_kind", "currency", "amount_tiyin", "amount_stars", "refund_id",
                                   "initiated_by", "refunded_at"]),
    # статус подписки аккаунта изменился (§1.10). reason: purchase — оплачен заказ (сайт или первый платёж Stars),
    # renewal — продление Stars, trial — пробный по запросу ученика, trial_grant — разовая выдача пробного всем 14+,
    # grant — выдача сотрудником («четыре глаза»), activated — запланированный период начался, ended — период
    # закончился (status expired), superseded — заменён («начать сейчас», Stars поверх пробного), refund — отозван
    # возвратом, staff — отозван сотрудником. Без периода (status none | expired) — period_id, даты и минуты null
    # → notifications (subscription_expired — status expired и reason ended; trial_started — status trial)
    "billing.subscription.changed.v1": ({"account_id": UUID, "status": enum("none", "trial", "active", "expired"),
                                         "reason": enum("purchase", "renewal", "trial", "trial_grant", "grant",
                                                        "activated", "ended", "superseded", "refund", "staff"),
                                         "period_id": UUID_OR_NULL, "product_code": PRODUCT_CODE_OR_NULL,
                                         "starts_at": TS_OR_NULL, "ends_at": TS_OR_NULL,
                                         "minutes_granted": MINUTES_OR_NULL, "changed_at": TS},
                                        ["account_id", "status", "reason", "period_id", "product_code", "starts_at",
                                         "ends_at", "minutes_granted", "changed_at"]),
    # тариф ученика изменился — каждому ученику аккаунта (сам аккаунт и детские профили), новому детскому профилю —
    # по текущему статусу. tier paid — есть активный период с функциями; paid_until — его конец (null — free)
    # → ai-gateway (learner_tiers: дневной лимит и уровень paid_only), user-admin (фильтр tier)
    "billing.access.changed.v1": ({"user_id": UUID, "account_id": UUID, "tier": enum("free", "paid"),
                                   "features": FEATURES, "paid_until": TS_OR_NULL, "changed_at": TS},
                                  ["user_id", "account_id", "tier", "features", "paid_until", "changed_at"]),
    # подписка Stars (нативная подписка Telegram): canceled — автопродление выключено (пользователь в Telegram или
    # кнопкой в Mini App), active — включено снова, failed — продление не удалось (не хватило Stars), refunded —
    # возврат, ended — expires_at прошёл без продления → notifications (failed — stars_renewal_failed)
    "billing.stars_subscription.changed.v1": ({"account_id": UUID, "subscription_id": UUID,
                                               "status": enum("active", "canceled", "failed", "refunded", "ended"),
                                               "expires_at": TS, "changed_at": TS},
                                              ["account_id", "subscription_id", "status", "expires_at", "changed_at"]),
    # период заканчивается: за expiring_days (3) и в день окончания (days_left 0), если нет следующего периода и
    # живой подписки Stars с автопродлением → notifications subscription_expiring
    "billing.subscription.expiring.v1": ({"account_id": UUID, "period_id": UUID, "ends_at": TS,
                                          "days_left": {"type": "integer", "minimum": 0, "maximum": 30},
                                          "minutes_left": MINUTES},
                                         ["account_id", "period_id", "ends_at", "days_left", "minutes_left"]),
    # после списания доступно ≤ low_minutes_percent от выданного — один раз за период → notifications minutes_low
    "billing.minutes.low.v1": ({"account_id": UUID, "period_id": UUID, "minutes_left": MINUTES,
                                "minutes_granted": {"type": "integer", "minimum": 1, "maximum": 100_000}},
                               ["account_id", "period_id", "minutes_left", "minutes_granted"]),
    # корректировка «четыре глаза» применена (§1.13): minutes — ±N минут периода, grant_period — выдан период (days,
    # minutes), revoke_period — период отозван. Основание и сотрудники в событие не входят (аудит) → notifications
    # minutes_adjusted (минуты > 0 или выдача)
    "billing.adjustment.applied.v1": ({"adjustment_id": UUID, "account_id": UUID,
                                       "kind": enum("minutes", "grant_period", "revoke_period"),
                                       "minutes": {"type": ["integer", "null"], "minimum": -10_000,
                                                   "maximum": 10_000},
                                       "days": {"type": ["integer", "null"], "minimum": 1, "maximum": 90},
                                       "period_id": UUID_OR_NULL, "applied_at": TS},
                                      ["adjustment_id", "account_id", "kind", "minutes", "days", "period_id",
                                       "applied_at"]),
    # активирована версия каталога тарифов и товаров (активация или откат новой версией) — аналитика
    "billing.catalog.activated.v1": ({"version": {"type": "integer", "minimum": 1}, "activated_at": TS},
                                     ["version", "activated_at"]),
    # ------------------------------------------------------------ ai-gateway (спринт 8): уровень деградации ИИ
    # смена действующего уровня: threshold — по доле расхода месяца (auto), manual — сотрудником (step-up, аудит
    # ai.degradation_updated), emergency_stop — аварийная остановка, month_reset — новый месяц. spent_percent — доля
    # потолка месяца с резервами (может быть > 100)
    "ai.degradation.changed.v1": ({"from": DEGRADATION_LEVEL, "to": DEGRADATION_LEVEL,
                                   "mode": enum("auto", "manual"),
                                   "reason": enum("threshold", "manual", "emergency_stop", "month_reset"),
                                   "spent_percent": {"type": "number", "minimum": 0, "maximum": 1000}, "at": TS},
                                  ["from", "to", "mode", "reason", "spent_percent", "at"]),
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
    # ------------------------------------------------------------ social (спринт 7)
    # профиль сообщества изменён (ник, скрытие) → gamification, lessons (проекция member_id и ника)
    "social.profile.updated.v1": ({"user_id": UUID, "member_id": MEMBER_ID, "nickname": NICK,
                                   "game_profile_hidden": BOOL, "updated_at": TS},
                                  ["user_id", "member_id", "nickname", "game_profile_hidden", "updated_at"]),
    # заявка в друзья → notifications friend_request (ник отправителя — для текста; null — не задан)
    "social.friend_request.created.v1": ({"request_id": UUID, "from_user_id": UUID, "to_user_id": UUID,
                                          "from_nickname": NICK, "created_at": TS},
                                         ["request_id", "from_user_id", "to_user_id", "from_nickname", "created_at"]),
    # дружба: user_a < user_b (по строке UUID). source: request — принятая заявка (requester_user_id — кому
    # friend_accepted, accepter_nickname — ник принявшего); invite — приглашение Telegram kind friend; removed —
    # удаление другом; block — блокировка; deletion — сага удаления → gamification, notifications (added + request)
    "social.friendship.changed.v1": ({"user_a": UUID, "user_b": UUID, "status": enum("added", "removed"),
                                      "source": enum("request", "invite", "removed", "block", "deletion"),
                                      "requester_user_id": UUID, "accepter_nickname": NICK, "at": TS},
                                     ["user_a", "user_b", "status", "source", "at"]),
    # блокировка A→B (односторонняя) → gamification, lessons: отменить вызовы и приглашения между ними
    "social.block.changed.v1": ({"blocker_user_id": UUID, "blocked_user_id": UUID, "status": enum("added", "removed"),
                                 "at": TS},
                                ["blocker_user_id", "blocked_user_id", "status", "at"]),
    # санкция применена (applied), истекла (expired, tick), снята (revoked) или отменена по обжалованию (overturned) →
    # gamification, lessons (social_ban: общая лига, вызовы, приглашения), notifications sanction_applied (applied).
    # until: social_ban — конец запрета или null (бессрочно); warning, nickname_reset — null. Основание в событие не входит
    "social.sanction.changed.v1": ({"user_id": UUID, "sanction_id": UUID,
                                    "kind": enum("warning", "social_ban", "nickname_reset"),
                                    "until": {"type": ["string", "null"], "format": "date-time"}, "active": BOOL,
                                    "change": enum("applied", "expired", "revoked", "overturned"), "changed_at": TS},
                                   ["user_id", "sanction_id", "kind", "until", "active", "change", "changed_at"]),
    # дело модерации закрыто → notifications complaint_resolved жалобщику (без подробностей)
    "social.case.resolved.v1": ({"case_id": UUID, "reporter_user_id": UUID,
                                 "outcome": enum("action_taken", "dismissed"), "resolved_at": TS},
                                ["case_id", "reporter_user_id", "outcome", "resolved_at"]),
    # обжалование санкции решено → notifications appeal_decided (overturned дополнительно даёт sanction.changed)
    "social.appeal.decided.v1": ({"appeal_id": UUID, "sanction_id": UUID, "user_id": UUID,
                                  "decision": enum("upheld", "overturned"), "decided_at": TS},
                                 ["appeal_id", "sanction_id", "user_id", "decision", "decided_at"]),
    # реферал квалифицирован (условия кампании, проверка, лимит месяца) → gamification (награды, ack
    # game.referral.rewarded.v1). inviter_monthly_cap — месячный лимит кампании: gamification считает против него
    # награды пригласившего обоих правил (кампании и «доживающих» спринта 6) за месяц qualified_at по Ташкенту
    "social.referral.qualified.v1": ({"referral_id": UUID, "inviter_user_id": UUID, "invitee_user_id": UUID,
                                      "campaign_version": {"type": "integer", "minimum": 1},
                                      "inviter_reward": REWARD, "invitee_reward": REWARD,
                                      "inviter_monthly_cap": {"type": "integer", "minimum": 1, "maximum": 100},
                                      "qualified_at": TS},
                                     ["referral_id", "inviter_user_id", "invitee_user_id", "campaign_version",
                                      "inviter_reward", "invitee_reward", "inviter_monthly_cap", "qualified_at"]),
    # реферал без награды: rejected (правила или оператор), expired (window_expired), capped (monthly_cap) →
    # notifications referral_rejected; reject_code — публичный, без правил антифрода
    "social.referral.rejected.v1": ({"referral_id": UUID, "inviter_user_id": UUID,
                                     "reject_code": enum("not_new_user", "family_member", "window_expired",
                                                         "review_rejected", "monthly_cap"),
                                     "rejected_at": TS},
                                    ["referral_id", "inviter_user_id", "reject_code", "rejected_at"]),
    # реферал удержан на проверке оператора — только аналитика (флаги риска в событие не входят)
    "social.referral.held.v1": ({"referral_id": UUID, "held_at": TS}, ["referral_id", "held_at"]),
    # ------------------------------------------------------------ notifications
    "notification.requested.v1": ({
        "notification_id": UUID, "user_id": UUID,
        "kind": enum("critical", "transactional", "standard"),
        "category": enum("reminders", "missed", "social", "support", "product", "service", "game"),
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
