"""Админ-контур identity-consent (спринт 2, docs/sprint2/INTERNAL_API.md §3): снимки учеников для read-модели
user-admin и раскрытие Telegram ID сотруднику.

- Снимок — поля AdminLearnerRow, которыми владеет identity-consent, и AdminLearnerCard.consent|security|notifications
  (admin.ts «Ученики») + `updated_at`. Полного Telegram ID в снимке нет — только маска `••••••789`.
- Раскрытие — только с синхронной записью `sensitive.view` в audit (сотрудник — в `on_behalf_of`: claim actor audit
  принимает только от admin-bff). Нет записи — нет значения. Причина и значение не пишутся ни в логи, ни в события.
"""

from __future__ import annotations

import base64
import json
import logging
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select, tuple_
from sqlalchemy.dialects.postgresql import distinct_on
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.app import Runtime
from tilhero_common.context import get_trace_id, pseudonymize
from tilhero_common.errors import ApiError, bad_request, conflict, not_found, too_many, unavailable
from tilhero_common.internal_auth import Actor
from tilhero_common.redis_tools import RateResult, rate_limit
from tilhero_identity.domain.notify import CATEGORIES
from tilhero_identity.models import Consent, GuardianLink, PinCredential, User
from tilhero_identity.schemas import (
    AdminConsent,
    AdminLearnerSnapshot,
    AdminLearnerSnapshotPage,
    AdminNotifications,
    AdminSecurity,
    NotificationCategories,
    RevealResult,
)
from tilhero_identity.service import learner_purposes
from tilhero_identity.settings import Settings

log = logging.getLogger("tilhero.identity.admin")

MASK = "•"  # •
AUDIT_CLIENT = "audit"
AUDIT_SENSITIVE_VIEW = "sensitive.view"
AUDIT_SENSITIVE_VIEW_LIMITED = "sensitive.view_rate_limited"
OBJECT_TYPE = "learner"  # object_type аудита (INTERNAL_API спринта 2)
REVEAL_FIELD = "telegram_user_id"
SNAPSHOT_MAX_LIMIT = 500  # user-admin сверяет пачками по 500 (INTERNAL_API §2)
_CURSOR_MAX = 256


def _now() -> datetime:
    return datetime.now(UTC)


def mask_telegram_id(telegram_user_id: int | None) -> str | None:
    """Маска для админки «••••••789» (последние 3 цифры); нет Telegram ID (детский профиль, обезличен) — null."""
    if telegram_user_id is None:
        return None
    return MASK * 6 + str(telegram_user_id)[-3:]


def encode_cursor(updated_at: datetime, user_id: uuid.UUID) -> str:
    raw = json.dumps({"t": updated_at.astimezone(UTC).isoformat(), "u": str(user_id)}, separators=(",", ":"))
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def decode_cursor(cursor: str) -> tuple[datetime, uuid.UUID]:
    try:
        if len(cursor) > _CURSOR_MAX:
            raise ValueError("too long")
        data = json.loads(base64.urlsafe_b64decode((cursor + "=" * (-len(cursor) % 4)).encode()).decode())
        when = datetime.fromisoformat(str(data["t"]))
        if when.tzinfo is None:
            raise ValueError("naive")
        return when, uuid.UUID(str(data["u"]))
    except Exception as exc:
        raise bad_request("INVALID_CURSOR", "Некорректный курсор") from exc


def learner_not_found() -> ApiError:
    return not_found("LEARNER_NOT_FOUND", "Ученик не найден")


class AdminDirectory:
    def __init__(self, runtime: Runtime, *, clock: Callable[[], datetime] | None = None) -> None:
        self.rt = runtime
        self.settings: Settings = runtime.settings  # type: ignore[assignment]
        self.now: Callable[[], datetime] = clock or _now

    # ---------- снимки для user-admin ----------
    async def _snapshots(self, session: AsyncSession, users: list[User]) -> list[AdminLearnerSnapshot]:
        ids = [u.user_id for u in users]
        if not ids:
            return []
        pins = {p.user_id: p for p in (await session.execute(
            select(PinCredential).where(PinCredential.user_id.in_(ids)))).scalars().all()}
        guardians: dict[uuid.UUID, uuid.UUID] = {
            child: guardian for child, guardian in (await session.execute(
                select(GuardianLink.child_user_id, GuardianLink.guardian_user_id)
                .where(GuardianLink.child_user_id.in_(ids)))).all()
        }
        # детские профили аккаунта, кроме обезличенных (удаляемые ещё считаются — связь снимается при обезличивании)
        children: dict[uuid.UUID, int] = {
            guardian: int(count) for guardian, count in (await session.execute(
                select(GuardianLink.guardian_user_id, func.count())
                .join(User, User.user_id == GuardianLink.child_user_id)
                .where(GuardianLink.guardian_user_id.in_(ids), User.status != "DELETED")
                .group_by(GuardianLink.guardian_user_id))).all()
        }
        # По каждому ученику и основанию: действующее согласие, иначе последнее отозванное
        latest = (await session.execute(
            select(Consent)
            .where(Consent.user_id.in_(ids))
            .order_by(Consent.user_id, Consent.basis, Consent.revoked_at.desc().nulls_first(),
                      Consent.accepted_at.desc(), Consent.consent_id)
            .ext(distinct_on(Consent.user_id, Consent.basis))
        )).scalars().all()
        consents = {(c.user_id, c.basis): c for c in latest}
        now = self.now()
        out = []
        for u in users:
            basis = "guardian" if u.kind == "child" else "self"
            consent = consents.get((u.user_id, basis))
            pin = pins.get(u.user_id)
            out.append(AdminLearnerSnapshot(
                user_id=u.user_id,
                kind=u.kind,  # type: ignore[arg-type]
                guardian_user_id=guardians.get(u.user_id) if u.kind == "child" else None,
                display_name=u.display_name,
                username=u.username,
                telegram_id_masked=mask_telegram_id(u.telegram_user_id),
                locale=u.locale,  # type: ignore[arg-type]
                age_band=u.age_band,  # type: ignore[arg-type]
                guardian_consent=u.guardian_consent,  # type: ignore[arg-type]
                status=u.status,  # type: ignore[arg-type]
                children_count=children.get(u.user_id, 0) if u.kind == "account" else 0,
                created_at=u.created_at,
                updated_at=u.updated_at,
                consent=self._consent_view(u, consent),
                security=AdminSecurity(
                    pin_enabled=pin is not None,
                    # ожидающий сброс кода родителя, срок которого ещё не наступил (как SecurityState)
                    pin_reset_pending=pin is not None and pin.reset_effective_at is not None
                    and pin.reset_effective_at > now,
                ),
                notifications=None if u.status == "DELETED" else AdminNotifications(
                    enabled=u.notifications_enabled,
                    categories=NotificationCategories(**{c: c in set(u.notify_categories) for c in CATEGORIES}),
                ),
            ))
        return out

    @staticmethod
    def _consent_view(user: User, consent: Consent | None) -> AdminConsent:
        if consent is None:
            return AdminConsent(policy_version=None, purposes=[], accepted_at=None, revoked_at=None, basis=None)
        # действующее — цели, которые сейчас работают (необязательные — только пока разрешены); отозванное — как было
        purposes = learner_purposes(user, consent) if consent.revoked_at is None else list(consent.purposes)
        return AdminConsent(
            policy_version=consent.policy_version,
            purposes=purposes,
            accepted_at=consent.accepted_at,
            revoked_at=consent.revoked_at,
            basis=consent.basis,  # type: ignore[arg-type]
        )

    async def list_snapshots(
        self, *, updated_after: datetime | None, cursor: str | None, limit: int
    ) -> AdminLearnerSnapshotPage:
        """Курсорная выгрузка для сверки user-admin: по (updated_at, user_id) по возрастанию. Удаляемые и обезличенные
        ученики тоже отдаются — read-модель должна узнать об удалении."""
        stmt = select(User).order_by(User.updated_at, User.user_id).limit(limit + 1)
        if updated_after is not None:
            stmt = stmt.where(User.updated_at > updated_after)
        if cursor:
            at, uid = decode_cursor(cursor)
            stmt = stmt.where(tuple_(User.updated_at, User.user_id) > tuple_(at, uid))
        async with self.rt.transaction() as session:
            rows = list((await session.execute(stmt)).scalars().all())
            page = rows[:limit]
            items = await self._snapshots(session, page)
        next_cursor = encode_cursor(page[-1].updated_at, page[-1].user_id) if len(rows) > limit else None
        return AdminLearnerSnapshotPage(items=items, next_cursor=next_cursor)

    async def get_snapshot(self, user_id: uuid.UUID) -> AdminLearnerSnapshot:
        async with self.rt.transaction() as session:
            user = await session.get(User, user_id)
            if user is None:
                raise learner_not_found()
            return (await self._snapshots(session, [user]))[0]

    # ---------- раскрытие Telegram ID ----------
    async def _audit_sensitive(
        self, action: str, *, user_id: uuid.UUID, actor: Actor, field: str, reason: str,
        extra: dict[str, Any] | None = None,
    ) -> None:
        """Синхронная запись в audit (писатель — identity-consent; сотрудник — в on_behalf_of). Повтор безопасен:
        audit идемпотентен по record_id."""
        record_id = str(uuid.uuid4())
        await self.rt.client(AUDIT_CLIENT).post(
            "/internal/v1/records",
            json={
                "record_id": record_id,
                "occurred_at": _now().isoformat(),
                "action": action,
                "object_type": OBJECT_TYPE,
                "object_id": str(user_id),
                "after": {"field": field, **(extra or {})},
                "reason": reason,
                "trace_id": get_trace_id()[:64],
                "on_behalf_of": {"actor_id": actor.id[:64], "actor_role": actor.role[:64]},
            },
            idempotency_key=record_id,
        )

    async def reveal(self, user_id: uuid.UUID, *, actor: Actor, field: str, reason: str) -> RevealResult:
        """1) ученик: нет или обезличен → 404, детский профиль (Telegram ID нет) → 409 FIELD_NOT_AVAILABLE;
        2) квота на сотрудника (Redis): превышение → 429 RATE_LIMITED + запись `sensitive.view_rate_limited`;
        3) синхронная запись `sensitive.view` в audit: недоступен или отказал → 503 AUDIT_UNAVAILABLE, значения нет."""
        async with self.rt.transaction() as session:
            user = await session.get(User, user_id)
            if user is None or user.status == "DELETED":
                raise learner_not_found()
            if user.kind == "child" or user.telegram_user_id is None:
                raise conflict("FIELD_NOT_AVAILABLE", "У детского профиля нет Telegram ID", {"field": field})
            value = str(user.telegram_user_id)
        staff = actor.id[:64]
        s = self.settings
        quota = await self._quota(staff)
        if not quota.allowed:
            log.warning("sensitive reveal quota exceeded", extra={"staff_id": staff})
            try:
                await self._audit_sensitive(AUDIT_SENSITIVE_VIEW_LIMITED, user_id=user_id, actor=actor, field=field,
                                            reason=reason, extra={"limit": s.reveal_limit_per_window,
                                                                  "window_seconds": s.reveal_window_seconds})
            except Exception as exc:
                log.warning("reveal rate limit not audited",
                            extra={"error_type": type(exc).__name__, "status": getattr(exc, "status", None)})
            raise too_many("RATE_LIMITED", "Превышен лимит просмотров чувствительных данных",
                           quota.reset_seconds or s.reveal_window_seconds)
        try:
            await self._audit_sensitive(AUDIT_SENSITIVE_VIEW, user_id=user_id, actor=actor, field=field, reason=reason)
        except Exception as exc:
            log.warning("sensitive view not audited, value withheld",
                        extra={"error_type": type(exc).__name__, "status": getattr(exc, "status", None)})
            raise unavailable("AUDIT_UNAVAILABLE", "Журнал аудита недоступен — значение не показано",
                              {"service": "audit"}) from exc
        log.info("sensitive field revealed",
                 extra={"field": field, "staff_id": staff, "user_pid": pseudonymize(str(user_id))})
        return RevealResult(field="telegram_user_id", value=value, expires_in=s.reveal_expires_in_seconds)

    async def _quota(self, staff: str) -> RateResult:
        if self.rt.redis is None:
            raise unavailable("RATE_LIMIT_UNAVAILABLE", "Хранилище лимитов недоступно")
        try:
            return await rate_limit(self.rt.redis, f"identity:reveal:{staff}", self.settings.reveal_limit_per_window,
                                    self.settings.reveal_window_seconds)
        except Exception as exc:  # без квоты значение не выдаётся (fail closed)
            log.warning("reveal quota unavailable", extra={"error_type": type(exc).__name__})
            raise unavailable("RATE_LIMIT_UNAVAILABLE", "Хранилище лимитов недоступно") from exc
