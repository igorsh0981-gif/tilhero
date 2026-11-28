"""Общее для домена billing: события, права, ошибки (INTERNAL_API §11, bff.ts/web.ts/admin.ts «Спринт 8»),
advisory-блокировки (всегда «аккаунт → заказ»), часы, курсоры, аудит, пункты сверки."""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import uuid
from collections.abc import Iterable
from datetime import UTC, date, datetime, time, timedelta
from typing import Any, Final
from zoneinfo import ZoneInfo

from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_billing.models import DeletedUser, ReconciliationItem
from tilhero_common import context
from tilhero_common.app import Runtime
from tilhero_common.errors import ApiError, bad_request, conflict, forbidden, not_found, unprocessable
from tilhero_common.internal_auth import Actor
from tilhero_common.messaging import emit

log = logging.getLogger("tilhero.billing")

PRODUCER: Final = "billing"
SYSTEM: Final = "system"

# события (§10)
ORDER_PAID: Final = "billing.order.paid.v1"
ORDER_REFUNDED: Final = "billing.order.refunded.v1"
SUBSCRIPTION_CHANGED: Final = "billing.subscription.changed.v1"
ACCESS_CHANGED: Final = "billing.access.changed.v1"
STARS_SUB_CHANGED: Final = "billing.stars_subscription.changed.v1"
SUBSCRIPTION_EXPIRING: Final = "billing.subscription.expiring.v1"
MINUTES_LOW: Final = "billing.minutes.low.v1"
ADJUSTMENT_APPLIED: Final = "billing.adjustment.applied.v1"
CATALOG_ACTIVATED: Final = "billing.catalog.activated.v1"
DOMAIN_DELETED: Final = "user.domain.deleted.v1"
AUDIT_EVENT: Final = "admin.audit.recorded.v1"

# права сотрудников (PLAN «Права и роли»; проверка — в домене по actor)
BILLING_READ: Final = "billing.read"
BILLING_MANAGE: Final = "billing.manage"
BILLING_PUBLISH: Final = "billing.publish"
BILLING_APPROVE: Final = "billing.approve"
BILLING_REFUND: Final = "billing.refund"
SUBSCRIPTIONS_OVERRIDE: Final = "subscriptions.override"
DASHBOARD_READ: Final = "dashboard.read"

FEATURES: Final = ("ai_lessons", "pair_lessons")
KIDS_BANDS: Final = frozenset({"6-9", "10-13"})
AGE_BANDS: Final = frozenset({"6-9", "10-13", "14-17", "18+"})
PAYME_TIMEOUT: Final = timedelta(milliseconds=43_200_000)  # 12 ч (§1.6)
REPORT_TZ: Final = "Asia/Tashkent"

_LOCK_ACCOUNT: Final = 0x42494C41  # 'BILA' — всё, что меняет деньги и минуты аккаунта
_LOCK_ORDER: Final = 0x42494C4F  # 'BILO' — заказ (после блокировки аккаунта)


# ---------------------------------------------------------------- ошибки (§11)

def payments_disabled() -> ApiError:
    return conflict("PAYMENTS_DISABLED", "Покупки временно недоступны")


def provider_not_available(provider: str) -> ApiError:
    del provider  # details — только поля контракта (bff.ts / web.ts: без деталей)
    return conflict("PROVIDER_NOT_AVAILABLE", "Этот способ оплаты сейчас недоступен")


def provider_not_allowed(provider: str, channel: str) -> ApiError:
    del provider, channel
    return unprocessable("PROVIDER_NOT_ALLOWED", "Способ оплаты недоступен в этом канале")


def payer_required() -> ApiError:
    return forbidden("PAYER_REQUIRED", "Оплатить может только владелец аккаунта в своём профиле")


def guardian_consent_required() -> ApiError:
    return forbidden("GUARDIAN_CONSENT_REQUIRED", "Для оплаты нужно согласие родителя")


def beneficiary_not_allowed() -> ApiError:
    return forbidden("BENEFICIARY_NOT_ALLOWED", "Получатель — только вы или детский профиль вашего аккаунта")


def product_not_found() -> ApiError:
    return not_found("PRODUCT_NOT_FOUND", "Товар не найден")


def product_not_available() -> ApiError:
    return conflict("PRODUCT_NOT_AVAILABLE", "Товар сейчас не продаётся")


def offer_version_mismatch(current: str) -> ApiError:
    return conflict("OFFER_VERSION_MISMATCH", "Условия оферты обновились — ознакомьтесь с ними снова",
                    {"current": current})


def forfeit_confirmation_required(minutes_left: int, days_left: int) -> ApiError:
    return conflict("FORFEIT_CONFIRMATION_REQUIRED", "Текущий период закончится сейчас, остаток минут сгорит",
                    {"minutes_left": minutes_left, "days_left": days_left})


def active_period_exists(ends_at: datetime | None) -> ApiError:
    return conflict("ACTIVE_PERIOD_EXISTS", "Подписка уже активна", {"ends_at": iso(ends_at)})


def stars_subscription_exists() -> ApiError:
    return conflict("STARS_SUBSCRIPTION_EXISTS", "Подписка Telegram Stars уже оформлена")


def stars_subscription_not_found() -> ApiError:
    return not_found("STARS_SUBSCRIPTION_NOT_FOUND", "Подписка Telegram Stars не найдена")


def stars_unavailable() -> ApiError:
    """Заказ остаётся pending: повтор POST с тем же Idempotency-Key или чтение заказа вернёт его со ссылкой."""
    return ApiError(503, "STARS_UNAVAILABLE", "Оплата Stars временно недоступна — попробуйте позже")


def orders_limit() -> ApiError:
    return ApiError(429, "ORDERS_LIMIT", "Слишком много незавершённых заказов — завершите или отмените их")


def order_not_found() -> ApiError:
    return not_found("ORDER_NOT_FOUND", "Заказ не найден")


def order_state(status: str) -> ApiError:
    return conflict("ORDER_STATE", "Заказ уже в другом состоянии", {"status": status})


def trial_used() -> ApiError:
    return conflict("TRIAL_USED", "Пробный период уже был")


def trial_not_available() -> ApiError:
    return conflict("TRIAL_NOT_AVAILABLE", "Пробный период сейчас недоступен")


def user_deleted() -> ApiError:
    return ApiError(410, "USER_DELETED", "Данные аккаунта удалены по запросу")


def idempotency_reused() -> ApiError:
    return unprocessable("IDEMPOTENCY_KEY_REUSED", "Ключ идемпотентности уже использован с другими данными")


def step_up_required(permission: str) -> ApiError:
    return forbidden("STEP_UP_REQUIRED", "Подтвердите действие кодом из приложения-аутентификатора",
                     {"permission": permission})


def upstream_unavailable(service: str) -> ApiError:
    return ApiError(503, "UPSTREAM_UNAVAILABLE", "Сервис временно недоступен — попробуйте позже",
                    {"service": service})


def invalid_cursor() -> ApiError:
    return bad_request("INVALID_CURSOR", "Некорректный курсор")


# ---------------------------------------------------------------- блокировки


def _lock_key(value: uuid.UUID) -> int:
    return int.from_bytes(value.bytes[:4], "big", signed=True)


async def lock_account(session: AsyncSession, account_id: uuid.UUID) -> None:
    """Сериализация денег и минут аккаунта до конца транзакции. ВСЕГДА раньше блокировки заказа."""
    await session.execute(text("SELECT pg_advisory_xact_lock(:c, :o)"),
                          {"c": _LOCK_ACCOUNT, "o": _lock_key(account_id)})


async def lock_order(session: AsyncSession, order_id: uuid.UUID) -> None:
    """Заказ — после аккаунта (порядок «аккаунт → заказ» исключает взаимные блокировки)."""
    await session.execute(text("SELECT pg_advisory_xact_lock(:c, :o)"), {"c": _LOCK_ORDER, "o": _lock_key(order_id)})


async def lock_accounts(session: AsyncSession, accounts: Iterable[uuid.UUID]) -> None:
    for account in sorted(set(accounts), key=lambda u: u.bytes):
        await lock_account(session, account)


async def is_deleted(session: AsyncSession, user_id: uuid.UUID | None) -> bool:
    """Проверка «удалён?» — только ПОСЛЕ захвата блокировки (сага держит ту же блокировку)."""
    if user_id is None:
        return True
    return (await session.scalar(select(DeletedUser.user_id).where(DeletedUser.user_id == user_id))) is not None


# ---------------------------------------------------------------- время


def now_of(rt: Runtime) -> datetime:
    """Часы сервиса (UTC): тесты подменяют `runtime.clock`."""
    clock = getattr(rt, "clock", None)
    return clock() if callable(clock) else datetime.now(UTC)


def iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    return dt.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def iso_req(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_ts(value: object, default: datetime | None = None) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo is not None else value.replace(tzinfo=UTC)
    try:
        ts = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return default
    return ts if ts.tzinfo is not None else ts.replace(tzinfo=UTC)


def report_zone() -> ZoneInfo:
    return ZoneInfo(REPORT_TZ)


def local_day_start(d: date, tz: ZoneInfo) -> datetime:
    return datetime.combine(d, time(0, 0), tzinfo=tz).astimezone(UTC)


def days_left(ends_at: datetime | None, now: datetime) -> int:
    if ends_at is None:
        return 0
    seconds = (ends_at - now).total_seconds()
    return max(0, -int(-seconds // 86_400))  # потолок: 1 с до конца — «1 день»


# ---------------------------------------------------------------- курсоры (непрозрачные)


def encode_cursor(*parts: Any) -> str:
    raw = json.dumps([str(p) for p in parts], separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cursor: str | None, arity: int) -> list[str] | None:
    if cursor is None:
        return None
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4))
        parts = json.loads(raw)
        if not isinstance(parts, list) or len(parts) != arity or not all(isinstance(p, str) for p in parts):
            raise ValueError("arity")
        return parts
    except Exception as exc:
        raise invalid_cursor() from exc


def cursor_time_id(cursor: str | None) -> tuple[datetime, uuid.UUID] | None:
    parts = decode_cursor(cursor, 2)
    if parts is None:
        return None
    try:
        ts = parse_ts(parts[0])
        if ts is None:
            raise ValueError("ts")
        return ts, uuid.UUID(parts[1])
    except ValueError as exc:
        raise invalid_cursor() from exc


def cursor_int(cursor: str | None) -> int | None:
    parts = decode_cursor(cursor, 1)
    if parts is None:
        return None
    try:
        return int(parts[0])
    except ValueError as exc:
        raise invalid_cursor() from exc


def request_hash(payload: Any) -> str:
    return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode("utf-8")).hexdigest()


def canonical_hash(payload: Any) -> str:
    """sha256 канонического JSON (как в миграции 0001): ключи по порядку, без пробелов, UTF-8."""
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------- события, аудит, сверка


async def emit_event(session: AsyncSession, event_type: str, payload: dict[str, Any],
                     causation_id: str | None = None) -> None:
    await emit(session, event_type, payload, producer=PRODUCER, causation_id=causation_id)


def staff_ref(staff_id: str | None, name: str | None) -> dict[str, str] | None:
    if staff_id is None:
        return None
    return {"staff_id": staff_id, "name": name or ("Система" if staff_id == SYSTEM else "")}


async def emit_audit(session: AsyncSession, actor: Actor | None, action: str, object_type: str, object_id: str, *,
                     before: Any = None, after: Any = None, reason: str | None = None, at: datetime) -> None:
    """admin.audit.recorded.v1 через outbox (без ПДн учеников, Telegram ID и секретов). actor None — система."""
    await emit(session, AUDIT_EVENT, {
        "record_id": str(uuid.uuid4()),
        "occurred_at": iso(at),
        "actor_type": "staff" if actor is not None else "system",
        "actor_id": actor.id[:64] if actor is not None else SYSTEM,
        "actor_role": actor.role[:64] if actor is not None else None,
        "action": action,
        "object_type": object_type,
        "object_id": object_id[:200],
        "before": before,
        "after": after,
        "reason": reason,
        "trace_id": context.get_trace_id()[:64],
    }, producer=PRODUCER)


async def recon_item(session: AsyncSession, kind: str, dedup_key: str, *, at: datetime,
                     provider: str | None = None, order_id: uuid.UUID | None = None,
                     txn_id: uuid.UUID | None = None, period_id: uuid.UUID | None = None,
                     run_id: uuid.UUID | None = None, details: dict[str, Any] | None = None) -> bool:
    """Пункт очереди сверки (dedup_key — повтор не создаёт второй). details — без ПДн, Telegram ID и секретов.
    → True — пункт создан."""
    row = (await session.execute(insert(ReconciliationItem).values(
        item_id=uuid.uuid4(), run_id=run_id, kind=kind, provider=provider, order_id=order_id, txn_id=txn_id,
        period_id=period_id, details=details or {}, status="open", dedup_key=dedup_key[:300], created_at=at,
    ).on_conflict_do_nothing(index_elements=["dedup_key"]).returning(ReconciliationItem.item_id))).first()
    if row is not None:
        log.warning("reconciliation item", extra={"code": "RECON_ITEM", "kind": kind})
    return row is not None


def strip_meta(meta: Any) -> dict[str, Any]:
    """provider_meta: только простые значения; ключи вида секретов, подписей, карт и Telegram ID отбрасываются."""
    if not isinstance(meta, dict):
        return {}
    banned = ("sign", "secret", "password", "token", "card", "pan", "auth", "key", "telegram", "user", "phone")
    out: dict[str, Any] = {}
    for k, v in meta.items():
        name = str(k)[:40]
        if any(b in name.lower() for b in banned):
            continue
        if isinstance(v, bool | int | str) or v is None:
            out[name] = v if not isinstance(v, str) else v[:128]
    return out
