"""Проекция учеников (identity-consent) и правила плательщика и получателя (INTERNAL_API §0.5, §1.16).

- Аккаунт — `account_id` = `user_id` аккаунта Telegram; детский профиль — ученик с `account_id` опекуна.
- Плательщик — владелец аккаунта в своём профиле (`lrn = sub`): 18+ или 14–17 с `guardian_consent = granted`; детский
  профиль, 6–13 и неизвестный возраст → PAYER_REQUIRED; 14–17 без согласия → GUARDIAN_CONSENT_REQUIRED. Возраст — claim
  `age_band` внутреннего токена telegram-bff (свежий), иначе проекция; согласие — только проекция.
- Получатель: подписка — сам аккаунт; пакет тилов — аккаунт или его детский профиль (иначе BENEFICIARY_NOT_ALLOWED).

Обработчики проекции — под блокировкой аккаунта; «удалён?» — после неё (сага держит ту же блокировку). Запоздавшее
событие не откатывает более новое (по времени события). Без ПДн: только id, вид профиля, полоса возраста, согласие."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_billing.domain.common import (
    AGE_BANDS,
    KIDS_BANDS,
    beneficiary_not_allowed,
    guardian_consent_required,
    is_deleted,
    lock_account,
    parse_ts,
    payer_required,
)
from tilhero_billing.models import GUARDIAN_CONSENTS, Learner

ACCOUNT_BANDS = frozenset({"14-17", "18+"})


@dataclass(frozen=True)
class Caller:
    """Ученик из внутреннего токена telegram-bff: sub — аккаунт, lrn — активный профиль, chn — канал продаж."""

    account_id: uuid.UUID
    learner_id: uuid.UUID
    age_band: str | None
    channel: str  # miniapp | web

    @property
    def child_profile(self) -> bool:
        return self.learner_id != self.account_id


@dataclass(frozen=True)
class PayerInfo:
    payer_required: bool
    can_pay: bool
    consent_required: bool


async def effective_band(db: AsyncSession, caller: Caller) -> str | None:
    """Полоса возраста профиля: claim `age_band` (Mini App), иначе проекция (сайт: у `chn web` claim нет)."""
    if caller.age_band in AGE_BANDS:
        return caller.age_band
    row = await db.get(Learner, caller.learner_id)
    return row.age_band if row is not None else None


async def payer_info(db: AsyncSession, caller: Caller) -> PayerInfo:
    if caller.child_profile:
        return PayerInfo(payer_required=True, can_pay=False, consent_required=False)
    row = await db.get(Learner, caller.account_id)
    band = await effective_band(db, caller)
    if band == "18+":
        return PayerInfo(False, True, False)
    if band == "14-17":
        granted = row is not None and row.guardian_consent == "granted"
        return PayerInfo(False, granted, not granted)
    return PayerInfo(True, False, False)


def require_payer(info: PayerInfo) -> None:
    if info.payer_required:
        raise payer_required()
    if not info.can_pay:
        raise guardian_consent_required()


async def payer_still_allowed(db: AsyncSession, account_id: uuid.UUID) -> bool:
    """Право платить ещё действует (pre-checkout Stars): по проекции, токена ученика здесь нет. Неизвестная полоса
    возраста не отвергает (claim проверен при создании заказа), 6–13 и подросток без согласия — отвергают."""
    row = await db.get(Learner, account_id)
    if row is None:
        return True
    if row.kind != "account" or row.age_band in KIDS_BANDS:
        return False
    if row.age_band == "14-17":
        return row.guardian_consent == "granted"
    return True


async def beneficiary(db: AsyncSession, caller: Caller, beneficiary_id: uuid.UUID | None,
                      product_kind: str) -> tuple[uuid.UUID, bool]:
    """→ (получатель, детский профиль?). Подписка — только сам аккаунт."""
    if beneficiary_id is None or beneficiary_id == caller.account_id:
        return caller.account_id, False
    if product_kind != "til_pack":
        raise beneficiary_not_allowed()
    row = await db.get(Learner, beneficiary_id)
    if row is None or row.kind != "child" or row.account_id != caller.account_id:
        raise beneficiary_not_allowed()
    if await is_deleted(db, beneficiary_id):
        raise beneficiary_not_allowed()
    return beneficiary_id, True


async def account_of(db: AsyncSession, learner_id: uuid.UUID) -> tuple[uuid.UUID, Learner | None]:
    """Аккаунт ученика (пул минут); неизвестный проекции ученик — сам себе аккаунт."""
    row = await db.get(Learner, learner_id)
    return (row.account_id if row is not None else learner_id), row


async def learners_of(db: AsyncSession, account_id: uuid.UUID) -> list[uuid.UUID]:
    """Ученики аккаунта: сам аккаунт и его детские профили (по проекции)."""
    rows = (await db.execute(select(Learner.user_id).where(Learner.account_id == account_id))).scalars().all()
    out = [account_id, *[r for r in rows if r != account_id]]
    return out


def is_kids(row: Learner | None, age_band: str | None = None) -> bool:
    if row is not None and (row.kind == "child" or row.age_band in KIDS_BANDS):
        return True
    return age_band in KIDS_BANDS


# ---------------------------------------------------------------- проекция (события и выгрузка)


def _uuid(value: object) -> uuid.UUID:
    return uuid.UUID(str(value))


async def on_profile_created(db: AsyncSession, payload: dict[str, Any], occurred_at: datetime,
                             now: datetime) -> Learner | None:
    """user.profile.created.v1 → learners (вид профиля и аккаунт — авторитетно из этого события). → строка, если
    создана или изменена (новому детскому профилю — access.changed по текущему тарифу)."""
    user = _uuid(payload["user_id"])
    kind = payload.get("kind")
    guardian = payload.get("guardian_user_id")
    if kind == "child":
        if not guardian:
            return None
        account = _uuid(guardian)
    elif kind == "account":
        account = user
    else:
        return None
    await lock_account(db, account)
    if await is_deleted(db, user) or await is_deleted(db, account):
        return None
    band = payload.get("age_band") if payload.get("age_band") in AGE_BANDS else None
    at = parse_ts(payload.get("created_at"), occurred_at) or occurred_at
    row = await db.get(Learner, user, with_for_update=True, populate_existing=True)
    if row is None:
        row = Learner(user_id=user, account_id=account, kind=kind, age_band=band, guardian_consent=None,
                      profile_updated_at=at, updated_at=now)
        db.add(row)
        await db.flush()
        return row
    row.kind, row.account_id = kind, account
    if band is not None and (row.age_band is None or row.profile_updated_at is None or row.profile_updated_at <= at):
        row.age_band = band
    row.updated_at = now
    return row


async def on_profile_updated(db: AsyncSession, payload: dict[str, Any], occurred_at: datetime,
                             now: datetime) -> None:
    """user.profile.updated.v1 → возраст и согласие родителя. Строки нет — создаётся только для аккаунта 14+ (детский
    профиль известен лишь из события создания или выгрузки). Неизвестные значения известное не стирают."""
    user = _uuid(payload["user_id"])
    band = payload.get("age_band") if payload.get("age_band") in AGE_BANDS else None
    consent = payload.get("guardian_consent") if payload.get("guardian_consent") in GUARDIAN_CONSENTS else None
    row = await db.get(Learner, user)
    account = row.account_id if row is not None else user
    await lock_account(db, account)
    if await is_deleted(db, user):
        return
    row = await db.get(Learner, user, with_for_update=True, populate_existing=True)
    if row is None:
        if band not in ACCOUNT_BANDS:
            return
        db.add(Learner(user_id=user, account_id=user, kind="account", age_band=band, guardian_consent=consent,
                       profile_updated_at=occurred_at, updated_at=now))
        await db.flush()
        return
    if row.profile_updated_at is not None and occurred_at < row.profile_updated_at:
        return
    if band is not None and row.kind == "account":
        row.age_band = band
    elif band is not None and band in KIDS_BANDS:
        row.age_band = band
    if consent is not None:
        row.guardian_consent = consent
    row.profile_updated_at = occurred_at
    row.updated_at = now


async def on_profile_export(db: AsyncSession, item: dict[str, Any], now: datetime) -> None:
    """Элемент выгрузки identity-consent `profiles` {user_id, kind, age_band, guardian_consent, updated_at,
    guardian_user_id?}: строка вставляется, если её нет; поля — если пусты или выгрузка новее (событие новее
    выгрузки не перетирается). Детский профиль без guardian_user_id пропускается."""
    user = _uuid(item["user_id"])
    kind = item.get("kind")
    if kind == "child":
        if not item.get("guardian_user_id"):
            return
        account = _uuid(item["guardian_user_id"])
    elif kind == "account":
        account = user
    else:
        return
    band = item.get("age_band") if item.get("age_band") in AGE_BANDS else None
    consent = item.get("guardian_consent") if item.get("guardian_consent") in GUARDIAN_CONSENTS else None
    at = parse_ts(item.get("updated_at"), now) or now
    await lock_account(db, account)
    if await is_deleted(db, user) or await is_deleted(db, account):
        return
    await db.execute(insert(Learner).values(
        user_id=user, account_id=account, kind=kind, age_band=band, guardian_consent=consent,
        profile_updated_at=at, updated_at=now).on_conflict_do_nothing(index_elements=["user_id"]))
    row = await db.get(Learner, user, with_for_update=True, populate_existing=True)
    if row is None:
        return
    newer = row.profile_updated_at is None or row.profile_updated_at < at
    if band is not None and (row.age_band is None or newer):
        row.age_band = band
    if consent is not None and (row.guardian_consent is None or newer):
        row.guardian_consent = consent
    if newer:
        row.profile_updated_at = at
    row.updated_at = now
