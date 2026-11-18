"""Аудитория рассылок (спринт 2, docs/sprint2/INTERNAL_API.md §3; admin.ts CampaignSegment) — вызывает только
notifications.

Всегда исключены: детские профили (`kind=child`), статус ≠ ACTIVE (отключённые, удаляемые, удалённые), ученики без
выбранного возраста, без действующего своего согласия с целью `product_news`, без включённой категории `product`
(admin.ts CampaignSegment: «только ученики с действующим согласием product_news и включённой категорией product»),
подростки 14–17 без `guardian_consent=granted`. Подростки попадают в аудиторию только при явном `age=teens`; по
умолчанию — только взрослые. `kids` → 422.

Фильтры: `ui_lang` — язык аккаунта (`users.locale`; язык сообщений рассылки — тот же, что в DeliveryInfo);
`onboarded` и `active_days` — проекция learner_activity (activity.py). `active_days=N>0` — занимался за последние
N дней (`last_activity_at ≥ now − N дней`); `N<0` — не занимался |N| дней или никогда.

Курсор — по `user_id` (стабилен; набор может меняться между страницами — notifications перепроверяет согласие и
категорию при создании каждого уведомления).
"""

from __future__ import annotations

import base64
import json
import re
import uuid
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import String, and_, exists, func, literal_column, or_, select
from sqlalchemy.sql.elements import ColumnElement

from tilhero_common.app import Runtime
from tilhero_common.errors import ApiError, bad_request, unprocessable
from tilhero_identity.domain.age import ADULT, TEEN
from tilhero_identity.models import Consent, LearnerActivity, User
from tilhero_identity.schemas import AudienceByLang, AudienceCount, AudienceMember, AudiencePage

UI_LANGS: tuple[str, ...] = ("ru", "uz")
AGE_SEGMENTS: dict[str, str] = {"teens": TEEN, "adults": ADULT}
DEFAULT_AGE: tuple[str, ...] = ("adults",)
ACTIVE_DAYS_MAX = 90
AUDIENCE_MAX_LIMIT = 500
_ACTIVE_DAYS_RE = re.compile(r"^[+-]?[0-9]{1,3}$")
_CURSOR_MAX = 128


def _now() -> datetime:
    return datetime.now(UTC)


def _sql(value: str) -> ColumnElement[Any]:
    """Строковая константа кода прямо в SQL (не параметр): предикаты совпадают с частичными индексами 0004 и в общем
    плане подготовленного запроса. Только константы модуля — никогда входные данные."""
    return literal_column("'" + value + "'", String)


def segment_invalid(field: str, reason: str) -> ApiError:
    return unprocessable("SEGMENT_INVALID", "Некорректный сегмент аудитории", {"field": field, "reason": reason})


@dataclass(frozen=True)
class Segment:
    ui_lang: tuple[str, ...]  # пусто — все языки
    age: tuple[str, ...]  # teens / adults, не пусто
    onboarded: bool | None
    active_days: int | None


def _values(raw: Iterable[str] | None) -> list[str]:
    """`a,b` и повтор параметра (`?x=a&x=b`); пустые элементы пропускаются, порядок и без дублей."""
    out: list[str] = []
    for chunk in raw or ():
        for item in chunk.split(","):
            value = item.strip().lower()
            if value and value not in out:
                out.append(value)
    return out


def parse_segment(
    *, ui_lang: list[str] | None, age: list[str] | None, onboarded: str | None, active_days: str | None
) -> Segment:
    langs = _values(ui_lang)
    for lang in langs:
        if lang not in UI_LANGS:
            raise segment_invalid("ui_lang", "unknown_value")
    ages = _values(age)
    if "kids" in ages:  # детям 6–13 рассылки не уходят никогда (CONVENTIONS §8)
        raise segment_invalid("age", "kids_not_allowed")
    for item in ages:
        if item not in AGE_SEGMENTS:
            raise segment_invalid("age", "unknown_value")
    flag: bool | None = None
    if onboarded is not None and onboarded.strip() != "":
        value = onboarded.strip().lower()
        if value not in ("true", "false"):
            raise segment_invalid("onboarded", "format")
        flag = value == "true"
    days: int | None = None
    if active_days is not None and active_days.strip() != "":
        value = active_days.strip()
        if not _ACTIVE_DAYS_RE.match(value):
            raise segment_invalid("active_days", "format")
        days = int(value)
        if days == 0 or abs(days) > ACTIVE_DAYS_MAX:
            raise segment_invalid("active_days", "range")
    return Segment(ui_lang=tuple(langs), age=tuple(ages) or DEFAULT_AGE, onboarded=flag, active_days=days)


def encode_cursor(user_id: uuid.UUID) -> str:
    return base64.urlsafe_b64encode(json.dumps({"u": str(user_id)}).encode()).decode().rstrip("=")


def decode_cursor(cursor: str) -> uuid.UUID:
    try:
        if len(cursor) > _CURSOR_MAX:
            raise ValueError("too long")
        data = json.loads(base64.urlsafe_b64decode((cursor + "=" * (-len(cursor) % 4)).encode()).decode())
        return uuid.UUID(str(data["u"]))
    except Exception as exc:
        raise bad_request("INVALID_CURSOR", "Некорректный курсор") from exc


def audience_conditions(segment: Segment, now: datetime) -> list[ColumnElement[bool]]:
    """Условия отбора (запрос — FROM users LEFT JOIN learner_activity). База совпадает с частичными индексами
    ix_users_audience и ix_consents_product_news (models.AUDIENCE_USERS_SQL, PRODUCT_NEWS_CONSENT_SQL)."""
    by_age = []
    if "adults" in segment.age:
        by_age.append(User.age_band == _sql(ADULT))
    if "teens" in segment.age:  # подросток — только с согласием родителя
        by_age.append(and_(User.age_band == _sql(TEEN), User.guardian_consent == _sql("granted")))
    conds: list[ColumnElement[bool]] = [
        User.kind == _sql("account"),
        User.status == _sql("ACTIVE"),
        User.age_band.is_not(None),
        _sql("product") == func.any(User.notify_categories),
        or_(*by_age),
        exists().where(
            Consent.user_id == User.user_id,
            Consent.revoked_at.is_(None),
            Consent.basis == _sql("self"),
            _sql("product_news") == func.any(Consent.purposes),
        ),
    ]
    if segment.ui_lang:
        conds.append(User.locale.in_(segment.ui_lang))
    if segment.onboarded is True:
        conds.append(LearnerActivity.onboarding_completed_at.is_not(None))
    elif segment.onboarded is False:
        conds.append(LearnerActivity.onboarding_completed_at.is_(None))
    if segment.active_days is not None:
        since = now - timedelta(days=abs(segment.active_days))
        if segment.active_days > 0:
            conds.append(LearnerActivity.last_activity_at >= since)
        else:
            conds.append(or_(LearnerActivity.last_activity_at.is_(None), LearnerActivity.last_activity_at < since))
    return conds


class Audience:
    def __init__(self, runtime: Runtime, *, clock: Callable[[], datetime] | None = None) -> None:
        self.rt = runtime
        self.now: Callable[[], datetime] = clock or _now

    @staticmethod
    def _base(*columns: Any) -> Any:
        return select(*columns).select_from(User).outerjoin(LearnerActivity,
                                                            LearnerActivity.user_id == User.user_id)

    async def page(self, segment: Segment, *, cursor: str | None, limit: int) -> AudiencePage:
        stmt = self._base(User.user_id, User.locale).where(*audience_conditions(segment, self.now()))
        if cursor:
            stmt = stmt.where(User.user_id > decode_cursor(cursor))
        stmt = stmt.order_by(User.user_id).limit(limit + 1)
        async with self.rt.transaction() as session:
            rows = (await session.execute(stmt)).all()
        page = rows[:limit]
        items = [AudienceMember(user_id=uid, locale=locale) for uid, locale in page]
        return AudiencePage(items=items, next_cursor=encode_cursor(page[-1][0]) if len(rows) > limit else None)

    async def count(self, segment: Segment) -> AudienceCount:
        stmt = (self._base(User.locale, func.count())
                .where(*audience_conditions(segment, self.now()))
                .group_by(User.locale))
        async with self.rt.transaction() as session:
            rows = (await session.execute(stmt)).all()
        by_lang = {lang: 0 for lang in UI_LANGS}
        for lang, n in rows:
            by_lang[lang] = int(n)
        return AudienceCount(count=sum(by_lang.values()), by_lang=AudienceByLang(**by_lang))
