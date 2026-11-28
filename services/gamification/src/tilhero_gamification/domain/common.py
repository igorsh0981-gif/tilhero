"""Общее для домена gamification: события, права, ошибки (коды §12, bff.ts/admin.ts «Спринт 6», спринт 7 — §8),
блокировки, время, курсоры, аудит, тексты."""

from __future__ import annotations

import base64
import hashlib
import json
import uuid
from datetime import UTC, date, datetime, time, timedelta
from typing import Any, Final
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common import context
from tilhero_common.errors import ApiError, bad_request, conflict, forbidden, not_found, unprocessable
from tilhero_common.internal_auth import Actor
from tilhero_common.messaging import emit

PRODUCER: Final = "gamification"

# события (§11)
STREAK_FROZEN: Final = "game.streak.frozen.v1"
LEVEL_REACHED: Final = "game.level.reached.v1"
STAGE_REACHED: Final = "game.hero.stage_reached.v1"
BADGE_EARNED: Final = "game.badge.earned.v1"
PURCHASE_COMPLETED: Final = "game.purchase.completed.v1"
RULES_ACTIVATED: Final = "game.rules.activated.v1"
DOMAIN_DELETED: Final = "user.domain.deleted.v1"
AUDIT_EVENT: Final = "admin.audit.recorded.v1"
# спринт 7 (§7)
LEAGUE_CLOSED: Final = "game.league.closed.v1"
DUEL_CHALLENGED: Final = "game.duel.challenged.v1"
DUEL_FINISHED: Final = "game.duel.finished.v1"
REFERRAL_REWARDED: Final = "game.referral.rewarded.v1"
# спринт 8 (INTERNAL_API §6, §10): подтверждения billing по пакетам тилов
TIL_PACK_CREDITED: Final = "game.til_pack.credited.v1"
TIL_PACK_REVERSED: Final = "game.til_pack.reversed.v1"

# права сотрудников (PLAN «Права и роли») — проверяются в домене по actor (защита в глубину)
GAME_READ: Final = "game.read"
GAME_MANAGE: Final = "game.manage"
GAME_PUBLISH: Final = "game.publish"
WALLET_ADJUST: Final = "wallet.adjust"
DASHBOARD_READ: Final = "dashboard.read"
# спринт 7: лиги недели и дуэли (переоценка — step-up)
LEAGUE_READ: Final = "league.read"
LEAGUE_MANAGE: Final = "league.manage"

KIDS_BANDS: Final = frozenset({"6-9", "10-13"})
AGE_BANDS: Final = frozenset({"6-9", "10-13", "14-17", "18+"})
AUDIENCES: Final = ("kids", "teens", "adults")
SYSTEM_ACTOR: Final = "system"

# причины операций активностей (под дневным лимитом и множителем; quest — тоже под лимитом)
ACTIVITY_REASONS: Final = ("lesson", "scenario", "media", "reading", "review", "skill_demonstrated",
                           "skill_retained")
CAPPED_REASONS: Final = (*ACTIVITY_REASONS, "quest")
# «XP недели» лиг (§2.2): занятия, задания, дуэли, парные уроки; ручные операции, призы и бонусы не считаются
WEEK_REASONS: Final = (*ACTIVITY_REASONS, "quest", "quest_bonus", "duel", "pair_lesson")

_LOCK_USER: Final = 0x47414D55  # 'GAMU' — все изменения одного ученика (кошелёк, задания, значки)

Localized = dict[str, str]


def loc(ru: str, uz: str) -> Localized:
    return {"ru": ru, "uz": uz}


# ---------------------------------------------------------------- ошибки


def user_deleted() -> ApiError:
    return ApiError(410, "USER_DELETED", "Данные ученика удалены по запросу")


def idempotency_reused() -> ApiError:
    return unprocessable("IDEMPOTENCY_KEY_REUSED", "Ключ идемпотентности уже использован с другими данными")


def hero_not_found() -> ApiError:
    return not_found("HERO_NOT_FOUND", "Герой не найден")


def item_not_found() -> ApiError:
    return not_found("ITEM_NOT_FOUND", "Предмет не найден")


def item_not_available() -> ApiError:
    return ApiError(410, "ITEM_NOT_AVAILABLE", "Предмет сейчас недоступен")


def insufficient_tils(price: int, balance: int) -> ApiError:
    # спринт 8: purchase_available и текст о покупке тилов — telegram-bff (по каталогу billing); здесь — false
    return conflict("INSUFFICIENT_TILS", "Не хватает тилов — заработайте их в уроках",
                    {"price": price, "balance": balance, "missing": max(price - balance, 0),
                     "purchase_available": False})


def balance_negative(currency: str, balance: int, amount: int) -> ApiError:
    return conflict("BALANCE_NEGATIVE", "Баланс не может уйти в минус",
                    {"currency": currency, "balance": balance, "amount": amount})


def wallet_not_found() -> ApiError:
    return not_found("WALLET_NOT_FOUND", "Кошелёк ученика не найден")


def step_up_required(permission: str) -> ApiError:
    return forbidden("STEP_UP_REQUIRED", "Подтвердите действие кодом из приложения-аутентификатора",
                     {"permission": permission})


# ---------------------------------------------------------------- ошибки спринта 7 (INTERNAL_API §8)


def member_not_found() -> ApiError:
    return not_found("MEMBER_NOT_FOUND", "Участник не найден")


def blocked() -> ApiError:
    return forbidden("BLOCKED", "Действие недоступно")


def social_restricted(until: datetime | None) -> ApiError:
    return forbidden("SOCIAL_RESTRICTED", "Социальные действия временно ограничены", {"until": iso(until)})


def friends_not_allowed(reason: str) -> ApiError:
    return forbidden("FRIENDS_NOT_ALLOWED", "Социальные функции недоступны", {"reason": reason})


def partner_not_allowed() -> ApiError:
    return forbidden("PARTNER_NOT_ALLOWED", "Вызвать можно только друга или члена семьи")


def kids_not_allowed() -> ApiError:
    return forbidden("KIDS_NOT_ALLOWED", "Недоступно в детском профиле")


def nickname_required() -> ApiError:
    return conflict("NICKNAME_REQUIRED", "Чтобы участвовать в общей лиге, задайте ник")


def upstream_unavailable(service: str) -> ApiError:
    return ApiError(503, "UPSTREAM_UNAVAILABLE", "Сервис временно недоступен — попробуйте позже",
                    {"service": service})


def duel_not_found() -> ApiError:
    return not_found("DUEL_NOT_FOUND", "Дуэль не найдена")


def duel_state(status: str) -> ApiError:
    return conflict("DUEL_STATE", "Дуэль уже в другом состоянии", {"status": status})


def group_not_found() -> ApiError:
    return not_found("GROUP_NOT_FOUND", "Группа лиги не найдена")


def result_state(status: str) -> ApiError:
    return conflict("RESULT_STATE", "Действие недоступно в этом состоянии", {"status": status})


# ---------------------------------------------------------------- блокировки, время


def _lock_key(value: uuid.UUID) -> int:
    return int.from_bytes(value.bytes[:4], "big", signed=True)


async def lock_user(session: AsyncSession, user_id: uuid.UUID) -> None:
    """Сериализация изменений одного ученика (consumers, покупки, настройки, команды сотрудников, tick, сага) до
    конца транзакции. Баланс дополнительно защищён `SELECT … FOR UPDATE` строки wallets и CHECK ≥ 0."""
    await session.execute(text("SELECT pg_advisory_xact_lock(:c, :o)"), {"c": _LOCK_USER, "o": _lock_key(user_id)})


async def lock_users(session: AsyncSession, *user_ids: uuid.UUID) -> None:
    """Несколько учеников — в одном порядке (без взаимных блокировок)."""
    for uid in sorted(set(user_ids), key=lambda u: u.bytes):
        await lock_user(session, uid)


def iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    return dt.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def zone(name: str | None, default: str) -> ZoneInfo:
    for candidate in (name, default):
        if candidate:
            try:
                return ZoneInfo(candidate)
            except (ZoneInfoNotFoundError, ValueError):
                continue
    return ZoneInfo("UTC")


def valid_tz(name: str) -> bool:
    try:
        ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return False
    return True


def local_date(now: datetime, tz: ZoneInfo) -> date:
    return now.astimezone(tz).date()


def day_end(d: date, tz: ZoneInfo) -> datetime:
    """Конец местного дня d (UTC) — начало следующего местного дня."""
    return datetime.combine(d + timedelta(days=1), time(0, 0), tzinfo=tz).astimezone(UTC)


def parse_ts(value: object, default: datetime) -> datetime:
    try:
        ts = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return default
    return ts if ts.tzinfo is not None else ts.replace(tzinfo=UTC)


def audience_of(band: str | None, child: bool = False) -> str:
    """6-9 / 10-13 → kids, 14-17 → teens, 18+ → adults; детский профиль — kids; без сведений — adults (§1.2)."""
    if child or band in KIDS_BANDS:
        return "kids"
    if band == "14-17":
        return "teens"
    return "adults"


def request_hash(payload: Any) -> str:
    return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode("utf-8")).hexdigest()


def seeded_fraction(*parts: object) -> float:
    """Детерминированное число [0, 1) из sha256 (не зависит от версии Python)."""
    digest = hashlib.sha256(":".join(str(p) for p in parts).encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") / float(1 << 64)


# ---------------------------------------------------------------- курсоры (непрозрачные)


def encode_cursor(*parts: Any) -> str:
    raw = json.dumps(list(parts), separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def cursor_time_id(cursor: str | None) -> tuple[datetime, uuid.UUID] | None:
    if cursor is None:
        return None
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4))
        parts = json.loads(raw)
        if not isinstance(parts, list) or len(parts) != 2:
            raise ValueError("arity")
        return datetime.fromisoformat(str(parts[0])), uuid.UUID(str(parts[1]))
    except Exception as exc:
        raise bad_request("INVALID_CURSOR", "Некорректный курсор") from exc


def _cursor_parts(cursor: str, arity: int) -> list[Any]:
    raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4))
    parts = json.loads(raw)
    if not isinstance(parts, list) or len(parts) != arity:
        raise ValueError("arity")
    return parts


def decode_week_cursor(cursor: str | None) -> date | None:
    """Курсор истории лиг — неделя (понедельник)."""
    if cursor is None:
        return None
    try:
        return date.fromisoformat(str(_cursor_parts(cursor, 1)[0]))
    except Exception as exc:
        raise bad_request("INVALID_CURSOR", "Некорректный курсор") from exc


# ---------------------------------------------------------------- тексты


def plural_ru(n: int, forms: list[str]) -> str:
    if len(forms) != 3:
        return forms[-1] if forms else ""
    n100, n10 = abs(n) % 100, abs(n) % 10
    if n10 == 1 and n100 != 11:
        return forms[0]
    if 2 <= n10 <= 4 and not 12 <= n100 <= 14:
        return forms[1]
    return forms[2]


def render(template: Localized, n: int, unit: dict[str, Any] | None) -> Localized:
    out: Localized = {}
    for lang in ("ru", "uz"):
        u = ""
        if unit:
            raw = unit.get(lang)
            u = plural_ru(n, list(raw)) if isinstance(raw, list) else str(raw or "")
        out[lang] = str(template.get(lang, "")).replace("{n}", str(n)).replace("{unit}", u)
    return out


# ---------------------------------------------------------------- события и аудит


async def emit_event(session: AsyncSession, event_type: str, payload: dict[str, Any],
                     causation_id: str | None = None) -> None:
    await emit(session, event_type, payload, producer=PRODUCER, causation_id=causation_id)


def staff_ref(staff_id: str | None, name: str | None) -> dict[str, str] | None:
    if staff_id is None:
        return None
    return {"staff_id": staff_id, "name": name or ("Система" if staff_id == SYSTEM_ACTOR else "")}


async def emit_audit(session: AsyncSession, actor: Actor, action: str, object_type: str, object_id: str, *,
                     before: dict[str, Any] | None = None, after: dict[str, Any] | None = None,
                     reason: str | None = None) -> None:
    """admin.audit.recorded.v1 через outbox — идентификаторы, статусы, суммы; без текстов ученика."""
    await emit(session, AUDIT_EVENT, {
        "record_id": str(uuid.uuid4()),
        "occurred_at": iso(datetime.now(UTC)),
        "actor_type": "staff",
        "actor_id": actor.id[:64],
        "actor_role": actor.role[:64],
        "action": action,
        "object_type": object_type,
        "object_id": object_id[:200],
        "before": before,
        "after": after,
        "reason": reason,
        "trace_id": context.get_trace_id()[:64],
    }, producer=PRODUCER)
