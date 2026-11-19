"""Рассылки (INTERNAL_API спринта 2 §3, admin.ts «Рассылки», AT-22).

Только категория `product`: identity-consent отбирает аудиторию (`/internal/v1/audience`: согласие `product_news`,
статус ACTIVE, без детских профилей, подростки — только при «teens» в сегменте и согласии родителя), notifications
создаёт записи пачками и доставляет их по общей политике (категория перепроверяется в момент отправки, тихие часы
ученика по его поясу → отложить). Детям — никогда (и защита в глубину в обработчике журнала).

Исполнение — `POST /internal/v1/notifications:dispatch` (n8n, 5 мин) → `run()`:
1) `scheduled` с `send_at ≤ now` → `sending` (`started_at`, фиксация оценки аудитории `audience_count`);
2) выборка аудитории пачками по 500 с сохранением курсора (`campaigns.cursor`, сравнение-и-запись) →
   `campaign_recipients (pending)`; повтор безопасен (PK (campaign_id, user_id), ON CONFLICT DO NOTHING);
3) получатели пачками под блокировкой рассылки и учеников: `created` у ученика за CAMPAIGN_MIN_INTERVAL_DAYS по
   другой рассылке → `skipped_frequency`; удалён → `cancelled`; иначе запись журнала (`product`, kind `campaign`,
   dedup `campaign:<id>:<user>`, детерминированный id) → `created`;
4) аудитория исчерпана и pending нет → `done` (`finished_at`), аудит `campaign.finished`.
«Отправить сейчас» (QA D2-03, ревью T2-11): `schedule` с send_at=null (часы сервера) или send_at ≤ now+1 мин
выполняет шаг 1 в самой команде (ответ уже `sending`), а первую пачку получателей — фоновой задачей `StartNow`
сразу после коммита (те же шаги Runner, что у :dispatch); дальше — обычный :dispatch.
`stop` (из scheduled | sending | done; draft → 409 CAMPAIGN_NOT_ACTIVE): `stopped`, pending → cancelled,
неотправленные записи журнала → `cancelled` (и их получатели); отправленные не отзываются. Плейсхолдер — только
`{learner_name}`.

Ревью P2-7: неудача шага запуска или выборки аудитории (SEGMENT_INVALID, INVALID_CURSOR, identity недоступен …)
записывается в `last_error {code, since, attempts}` и сбрасывается первым успешным шагом; после
CAMPAIGN_FAILURE_ALERT_ATTEMPTS (6) неудач подряд — аудит `campaign.failed` (один раз на серию).
Ревью P2-8: лимит частоты считает только получателей, чья запись рассылки дошла до ученика или ещё в пути
(`sent | in_app_only | scheduled`); `skipped` (категория выключена, ученик неактивен), `failed`, `cancelled` — нет.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections import Counter
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any, cast

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.app import Runtime
from tilhero_common.errors import ApiError, conflict, not_found, unavailable, unprocessable
from tilhero_common.internal_auth import Actor
from tilhero_notifications import audit, store
from tilhero_notifications.broadcasts import notification_id_for
from tilhero_notifications.domain.texts import FieldError, check_plain, check_texts, normalize
from tilhero_notifications.models import Campaign, CampaignRecipient, DeletedUser, Notification
from tilhero_notifications.settings import Settings
from tilhero_notifications.templates import CAMPAIGN_PLACEHOLDERS, CAMPAIGN_TEMPLATE

log = logging.getLogger("tilhero.notifications.campaigns")

# Маршруты Mini App для кнопки (каталог packages/contracts/release-notes.json); спринт 3 — + диагностика, план,
# карта навыков, сценарии, медиатека, заявки на песни/фильмы, «Мои языки»
ROUTES = (
    "home", "lessons", "review", "progress", "profile", "schedule", "notifications", "family", "support", "news",
    "diagnostics", "plan", "skills", "scenarios", "media", "media_requests", "languages",
)
UI_LANGS = ("ru", "uz")
AGES = ("teens", "adults")
DEFAULT_AGES = ("adults",)
ACTIVE_DAYS_MAX = 90
CATEGORY = "product"
KIND = "campaign"
# Запись рассылки «дошла до ученика или ещё в пути» — участвует в лимите частоты (ревью P2-8)
REACHED_STATUSES = ("sent", "in_app_only", "scheduled")
STOPPABLE = ("scheduled", "sending", "done")


def _s(rt: Runtime) -> Settings:
    return cast(Settings, rt.settings)


def iso(dt: datetime | None) -> str | None:
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z") if dt is not None else None


def campaign_invalid(fields: list[FieldError]) -> ApiError:
    return unprocessable("CAMPAIGN_INVALID", "Рассылка не прошла проверку", {"fields": fields})


def campaign_not_found() -> ApiError:
    return not_found("CAMPAIGN_NOT_FOUND", "Рассылка не найдена")


def dedup_key(campaign_id: uuid.UUID, user_id: uuid.UUID) -> str:
    return f"campaign:{campaign_id}:{user_id}"


# ---------------------------------------------------------------- содержание: проверка и нормализация


def check_segment(segment: dict[str, Any] | None) -> list[FieldError]:
    errors: list[FieldError] = []
    seg = segment or {}
    for lang in seg.get("ui_lang") or []:
        if lang not in UI_LANGS:
            errors.append({"path": "segment.ui_lang", "reason": "invalid"})
            break
    for age in seg.get("age") or []:
        if age == "kids":  # детям 6–13 рассылки не уходят никогда
            errors.append({"path": "segment.age", "reason": "kids_not_allowed"})
            break
        if age not in AGES:
            errors.append({"path": "segment.age", "reason": "invalid"})
            break
    days = seg.get("active_days")
    if days is not None and (isinstance(days, bool) or not 1 <= abs(int(days)) <= ACTIVE_DAYS_MAX):
        errors.append({"path": "segment.active_days", "reason": "out_of_range"})
    return errors


def normalize_segment(segment: dict[str, Any] | None) -> dict[str, Any]:
    """Пустые списки — «не задано» (язык — все, возраст — взрослые); порядок и повторы не важны."""
    seg = segment or {}
    out: dict[str, Any] = {}
    if seg.get("ui_lang"):
        out["ui_lang"] = sorted(set(seg["ui_lang"]))
    if seg.get("age"):
        out["age"] = sorted(set(seg["age"]))
    if seg.get("onboarded") is not None:
        out["onboarded"] = bool(seg["onboarded"])
    if seg.get("active_days") is not None:
        out["active_days"] = int(seg["active_days"])
    return out


def check_content(title: Any, texts: Any, route: Any, segment: Any) -> list[FieldError]:
    errors = check_plain(title, path="title", limit=120)
    errors += check_texts(texts, allowed=CAMPAIGN_PLACEHOLDERS)
    if route is not None and route not in ROUTES:
        errors.append({"path": "route", "reason": "invalid"})
    errors += check_segment(segment)
    return errors


def normalized_content(title: str, texts: Any, route: str | None, segment: Any) -> dict[str, Any]:
    return {
        "title": title.strip(),
        "texts": normalize(texts) or {},
        "route": route,
        "segment": normalize_segment(segment),
    }


# ---------------------------------------------------------------- представление


def empty_stats() -> dict[str, int]:
    return {"audience": 0, "created": 0, "sent": 0, "in_app_only": 0, "deferred": 0, "skipped_frequency": 0,
            "failed": 0}


async def stats_for(session: AsyncSession, campaigns: list[Campaign]) -> dict[uuid.UUID, dict[str, int]]:
    out = {c.campaign_id: {**empty_stats(), "audience": c.audience_count or 0} for c in campaigns}
    if not campaigns:
        return out
    rows = (
        await session.execute(
            select(
                CampaignRecipient.campaign_id,
                CampaignRecipient.status,
                Notification.telegram_status,
                Notification.reason,
                func.count(),
            )
            .select_from(CampaignRecipient)
            .outerjoin(Notification, Notification.notification_id == CampaignRecipient.notification_id)
            .where(CampaignRecipient.campaign_id.in_(list(out)))
            .group_by(
                CampaignRecipient.campaign_id, CampaignRecipient.status, Notification.telegram_status,
                Notification.reason,
            )
        )
    ).all()
    for campaign_id, status, telegram, reason, count in rows:
        st = out[campaign_id]
        if status == "created":
            st["created"] += count
        elif status == "skipped_frequency":
            st["skipped_frequency"] += count
        if telegram == "sent":
            st["sent"] += count
        elif telegram == "in_app_only":
            st["in_app_only"] += count
        elif telegram == "failed":
            st["failed"] += count
        elif telegram == "scheduled" and reason == "quiet_hours":
            st["deferred"] += count
    return out


def view(c: Campaign, stats: dict[str, int] | None = None) -> dict[str, Any]:
    return {
        "campaign_id": str(c.campaign_id),
        "title": c.title,
        "texts": c.texts,
        "route": c.route,
        "segment": c.segment,
        "status": c.status,
        "version": c.version,
        "send_at": iso(c.send_at),
        "created_by": c.created_by,
        "created_by_name": None,  # имена сотрудников добавляет admin-bff
        "created_at": iso(c.created_at),
        "updated_at": iso(c.updated_at),
        "scheduled_by": c.scheduled_by,
        "scheduled_at": iso(c.scheduled_at),
        "started_at": iso(c.started_at),
        "finished_at": iso(c.finished_at),
        "stopped_by": c.stopped_by,
        "stopped_at": iso(c.stopped_at),
        "stop_reason": c.stop_reason,
        "stats": stats or {**empty_stats(), "audience": c.audience_count or 0},
        "last_error": (
            {"code": c.error_code, "since": iso(c.error_since), "attempts": c.error_attempts}
            if c.error_code is not None else None
        ),
    }


def clear_error(c: Campaign) -> None:
    c.error_code = None
    c.error_since = None
    c.error_attempts = 0
    c.error_reported = False


def error_code_of(exc: BaseException) -> str:
    """Код неудачи шага для last_error: код identity-consent (SEGMENT_INVALID, INVALID_CURSOR, UPSTREAM_UNAVAILABLE …)
    или общий — без текста исключения (там могут быть данные)."""
    if isinstance(exc, ApiError):
        return exc.code[:64]
    if isinstance(exc, ValidationError | ValueError | TypeError):
        return "AUDIENCE_RESPONSE_INVALID"
    return "INTERNAL_ERROR"


async def view_one(session: AsyncSession, c: Campaign) -> dict[str, Any]:
    return view(c, (await stats_for(session, [c]))[c.campaign_id])


async def load(session: AsyncSession, campaign_id: uuid.UUID, *, for_update: bool = False) -> Campaign:
    stmt = select(Campaign).where(Campaign.campaign_id == campaign_id)
    if for_update:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    row = (await session.execute(stmt)).scalar_one_or_none()
    if row is None:
        raise campaign_not_found()
    return row


# ---------------------------------------------------------------- аудитория (identity-consent)


class AudienceCount(BaseModel):
    model_config = ConfigDict(extra="ignore")

    count: int = Field(ge=0)
    by_lang: dict[str, int] = Field(default_factory=dict)


class AudienceItem(BaseModel):
    model_config = ConfigDict(extra="ignore")

    user_id: uuid.UUID
    locale: str | None = None


class AudiencePage(BaseModel):
    model_config = ConfigDict(extra="ignore")

    items: list[AudienceItem]
    next_cursor: str | None = Field(default=None, max_length=512)


def audience_params(segment: dict[str, Any]) -> dict[str, str]:
    params = {"age": ",".join(segment.get("age") or DEFAULT_AGES)}
    if segment.get("ui_lang"):
        params["ui_lang"] = ",".join(segment["ui_lang"])
    if segment.get("onboarded") is not None:
        params["onboarded"] = "true" if segment["onboarded"] else "false"
    if segment.get("active_days") is not None:
        params["active_days"] = str(int(segment["active_days"]))
    return params


async def audience_count(rt: Runtime, segment: dict[str, Any]) -> AudienceCount:
    data = await rt.client("identity-consent").get("/internal/v1/audience/count", params=audience_params(segment))
    return AudienceCount.model_validate(data)


async def audience_page(rt: Runtime, segment: dict[str, Any], cursor: str | None) -> AudiencePage:
    params = {**audience_params(segment), "limit": str(_s(rt).campaign_audience_page)}
    if cursor:
        params["cursor"] = cursor
    data = await rt.client("identity-consent").get("/internal/v1/audience", params=params)
    return AudiencePage.model_validate(data)


def upstream_unavailable() -> ApiError:
    return unavailable("UPSTREAM_UNAVAILABLE", "identity-consent недоступен", {"service": "identity-consent"})


def segment_rejected(exc: ApiError) -> ApiError | None:
    """identity-consent отклонил сегмент (422 SEGMENT_INVALID {field, reason}) → 422 CAMPAIGN_INVALID {fields}."""
    if exc.status != 422 or exc.code != "SEGMENT_INVALID":
        return None
    field = str(exc.details.get("field") or "segment")[:64]
    path = field if field.startswith("segment") else f"segment.{field}"
    return campaign_invalid([{"path": path, "reason": str(exc.details.get("reason") or "invalid")[:64]}])


def audience_error(exc: Exception) -> ApiError:
    if isinstance(exc, ApiError) and (rejected := segment_rejected(exc)) is not None:
        return rejected
    log.warning("audience unavailable", extra={"error_type": type(exc).__name__,
                                               "error_code": getattr(exc, "code", None)})
    return upstream_unavailable()


async def count_or_503(rt: Runtime, segment: dict[str, Any]) -> AudienceCount:
    try:
        return await audience_count(rt, segment)
    except (ApiError, ValidationError, ValueError, TypeError) as exc:
        raise audience_error(exc) from None


async def recently_reached(
    session: AsyncSession, users: list[uuid.UUID], *, since: datetime, exclude: uuid.UUID
) -> set[uuid.UUID]:
    if not users:
        return set()
    rows = await session.execute(
        select(CampaignRecipient.user_id)
        .join(Notification, Notification.notification_id == CampaignRecipient.notification_id)
        .where(
            CampaignRecipient.user_id.in_(users),
            CampaignRecipient.status == "created",
            CampaignRecipient.processed_at >= since,
            CampaignRecipient.campaign_id != exclude,
            Notification.telegram_status.in_(REACHED_STATUSES),
        )
        .distinct()
    )
    return set(rows.scalars().all())


async def estimate(rt: Runtime, campaign: Campaign, now: datetime, *, max_pages: int = 10) -> dict[str, Any]:
    """CampaignEstimate: охват — identity-consent `/audience/count`; лимит частоты — пересечение аудитории (до
    `max_pages` страниц) с получателями других рассылок за CAMPAIGN_MIN_INTERVAL_DAYS, дальше — пропорционально."""
    segment = campaign.segment or {}
    count = await count_or_503(rt, segment)
    since = now - timedelta(days=_s(rt).campaign_min_interval_days)
    scanned, capped, cursor = 0, 0, None
    try:
        for _ in range(max_pages):
            page = await audience_page(rt, segment, cursor)
            users = [item.user_id for item in page.items]
            async with rt.transaction() as session:
                capped += len(await recently_reached(session, users, since=since, exclude=campaign.campaign_id))
            scanned += len(users)
            cursor = page.next_cursor or None
            if cursor is None:
                break
    except (ApiError, ValidationError, ValueError, TypeError) as exc:
        raise audience_error(exc) from None
    if cursor is not None and scanned:
        capped = round(capped * count.count / scanned)
    return {
        "audience": count.count,
        "by_lang": {lang: int(count.by_lang.get(lang, 0)) for lang in UI_LANGS},
        "frequency_capped": min(capped, count.count),
        "computed_at": iso(now),
    }


# ---------------------------------------------------------------- команды сотрудников


async def find_by_idempotency(session: AsyncSession, actor_id: str, key: str) -> Campaign | None:
    return (
        await session.execute(
            select(Campaign).where(Campaign.created_by == actor_id, Campaign.idempotency_key == key)
        )
    ).scalar_one_or_none()


async def create(
    session: AsyncSession,
    content: dict[str, Any],
    *,
    actor: Actor,
    idempotency_key: str,
    fingerprint: str,
    now: datetime,
) -> tuple[Campaign, bool]:
    existing = await find_by_idempotency(session, actor.id[:64], idempotency_key)
    if existing is not None:
        if existing.request_hash != fingerprint:
            raise unprocessable("IDEMPOTENCY_KEY_REUSED", "Ключ идемпотентности уже использован с другими данными")
        return existing, True
    row = Campaign(
        campaign_id=uuid.uuid4(),
        title=content["title"],
        texts=content["texts"],
        route=content["route"],
        segment=content["segment"],
        status="draft",
        version=1,
        audience_complete=False,
        created_by=actor.id[:64],
        created_at=now,
        updated_at=now,
        idempotency_key=idempotency_key,
        request_hash=fingerprint,
    )
    session.add(row)
    await session.flush()
    await audit.emit_audit(
        session,
        audit.record(
            "campaign.created", audit.CAMPAIGN, str(row.campaign_id), actor=actor,
            after={"title": row.title, "route": row.route, "segment": row.segment, "status": "draft"}, now=now,
        ),
    )
    return row, False


def require_draft(row: Campaign, expected_version: int | None) -> None:
    if row.status != "draft":
        raise conflict("CAMPAIGN_NOT_DRAFT", "Изменять можно только черновик", {"status": row.status})
    if expected_version is not None and row.version != expected_version:
        raise conflict(
            "CAMPAIGN_VERSION_CONFLICT", "Рассылку уже изменили — обновите страницу",
            {"current_version": row.version},
        )


async def update_draft(
    session: AsyncSession,
    campaign_id: uuid.UUID,
    changes: dict[str, Any],
    *,
    expected_version: int,
    actor: Actor,
    now: datetime,
) -> Campaign:
    row = await load(session, campaign_id, for_update=True)
    require_draft(row, expected_version)
    changed = sorted(name for name, value in changes.items() if getattr(row, name) != value)
    for name, value in changes.items():
        setattr(row, name, value)
    if changed:
        row.version += 1
        row.updated_at = now
        await session.flush()
        await audit.emit_audit(
            session,
            audit.record(
                "campaign.updated", audit.CAMPAIGN, str(row.campaign_id), actor=actor,
                after={"fields": changed, "version": row.version, "segment": row.segment}, now=now,
            ),
        )
    return row


async def schedule(
    session: AsyncSession,
    campaign_id: uuid.UUID,
    *,
    expected_version: int,
    send_at: datetime,
    reason: str,
    audience: int,
    actor: Actor,
    now: datetime,
    start: bool = False,
) -> Campaign:
    """Черновик → scheduled. `start` — «Отправить сейчас» (QA D2-03): запуск в этой же транзакции, как шаг 1
    `start_due` (`sending`, `started_at`, фиксация оценки аудитории), без ожидания ближайшего :dispatch."""
    row = await load(session, campaign_id, for_update=True)
    require_draft(row, expected_version)
    row.status = "sending" if start else "scheduled"
    row.send_at = send_at
    clear_error(row)
    row.scheduled_by = actor.id[:64]
    row.scheduled_at = now
    if start:
        row.started_at = now
        row.audience_count = audience
    row.version += 1
    row.updated_at = now
    await session.flush()
    await audit.emit_audit(
        session,
        audit.record(
            "campaign.scheduled", audit.CAMPAIGN, str(row.campaign_id), actor=actor,
            before={"status": "draft"},
            after={"status": row.status, "send_at": iso(send_at), "audience_estimate": audience, "send_now": start},
            reason=reason, now=now,
        ),
    )
    if start:
        log.info("campaign started", extra={"campaign_id": str(campaign_id), "audience": audience,
                                            "send_now": True})
    return row


async def unschedule(
    session: AsyncSession, campaign_id: uuid.UUID, *, reason: str, actor: Actor, now: datetime
) -> tuple[Campaign, bool]:
    row = await load(session, campaign_id, for_update=True)
    if row.status == "draft":
        return row, False
    if row.status != "scheduled":
        raise conflict("CAMPAIGN_ALREADY_SENDING", "Рассылка уже отправляется или завершена", {"status": row.status})
    send_at = row.send_at
    row.status = "draft"
    row.send_at = None
    row.scheduled_by = None
    row.scheduled_at = None
    clear_error(row)
    row.version += 1
    row.updated_at = now
    await session.flush()
    await audit.emit_audit(
        session,
        audit.record(
            "campaign.unscheduled", audit.CAMPAIGN, str(row.campaign_id), actor=actor,
            before={"status": "scheduled", "send_at": iso(send_at)}, after={"status": "draft"},
            reason=reason, now=now,
        ),
    )
    return row, True


async def stop(
    session: AsyncSession, campaign_id: uuid.UUID, *, reason: str, actor: Actor, now: datetime
) -> tuple[Campaign, bool]:
    """Экстренная остановка (scheduled | sending | done): новые записи не создаются (блокировка строки рассылки —
    та же, что у пачки получателей), pending → cancelled, неотправленные записи журнала (у done — отложенные тихими
    часами) → cancelled. Повтор — без изменений; черновик — 409 CAMPAIGN_NOT_ACTIVE."""
    row = await load(session, campaign_id, for_update=True)
    if row.status == "stopped":
        return row, False
    if row.status not in STOPPABLE:
        raise conflict("CAMPAIGN_NOT_ACTIVE", "Остановить можно только запланированную или отправляемую рассылку",
                       {"status": row.status})
    before = row.status
    pending = await session.execute(
        update(CampaignRecipient)
        .where(CampaignRecipient.campaign_id == campaign_id, CampaignRecipient.status == "pending")
        .values(status="cancelled", processed_at=now)
        .execution_options(synchronize_session=False)
    )
    created = select(CampaignRecipient.notification_id).where(
        CampaignRecipient.campaign_id == campaign_id,
        CampaignRecipient.status == "created",
        CampaignRecipient.notification_id.is_not(None),
    )
    cancelled_ids = list(
        (
            await session.execute(
                update(Notification)
                .where(Notification.notification_id.in_(created), Notification.telegram_status == "scheduled")
                .values(telegram_status="cancelled", params=None, scheduled_for=None, reason="campaign_stopped",
                        updated_at=now)
                .returning(Notification.notification_id)
                .execution_options(synchronize_session=False)
            )
        ).scalars().all()
    )
    if cancelled_ids:
        await session.execute(
            update(CampaignRecipient)
            .where(CampaignRecipient.campaign_id == campaign_id, CampaignRecipient.notification_id.in_(cancelled_ids))
            .values(status="cancelled", processed_at=now)
            .execution_options(synchronize_session=False)
        )
    row.status = "stopped"
    row.stopped_by = actor.id[:64]
    row.stopped_at = now
    row.stop_reason = reason
    row.version += 1
    row.updated_at = now
    await session.flush()
    await audit.emit_audit(
        session,
        audit.record(
            "campaign.stopped", audit.CAMPAIGN, str(row.campaign_id), actor=actor,
            before={"status": before},
            after={"status": "stopped", "cancelled_recipients": int(getattr(pending, "rowcount", 0) or 0),
                   "cancelled_notifications": len(cancelled_ids)},
            reason=reason, now=now,
        ),
    )
    return row, True


# ---------------------------------------------------------------- исполнение (notifications:dispatch)


class Runner:
    """Шаги 1–4 исполнения рассылок; каждый шаг — своя транзакция, повтор и параллельный вызов безопасны."""

    def __init__(self, rt: Runtime, wake: Callable[[], None] | None = None) -> None:
        self.rt = rt
        self.wake = wake or (lambda: None)

    async def run(self, now: datetime | None = None) -> Counter[str]:
        now = now or datetime.now(UTC)
        out: Counter[str] = Counter()
        out["started"] = await self.start_due(now)
        budget = _s(self.rt).campaign_max_batches_per_call
        async with self.rt.transaction() as session:
            sending = list(
                (
                    await session.execute(
                        select(Campaign.campaign_id).where(Campaign.status == "sending").order_by(Campaign.started_at)
                    )
                ).scalars().all()
            )
        for campaign_id in sending:
            while budget > 0:
                budget -= 1
                step = await self.step(campaign_id, now)
                out[step] += 1
                if step in ("done", "idle", "stopped"):
                    break
        return out

    async def start_now(self, campaign_id: uuid.UUID, now: datetime | None = None) -> Counter[str]:
        """«Отправить сейчас» (QA D2-03): первые CAMPAIGN_START_NOW_BATCHES пачек получателей уже запущенной рассылки —
        те же шаги, что у :dispatch (страница аудитории → пачка → завершение, если всё обработано). Параллельный
        :dispatch безопасен: курсор — сравнение-и-запись, пачка — под FOR UPDATE рассылки, получатели SKIP LOCKED,
        записи журнала с детерминированным id. Остальное — ближайший :dispatch."""
        now = now or datetime.now(UTC)
        batches = _s(self.rt).campaign_start_now_batches
        out: Counter[str] = Counter()
        for _ in range(2 * batches + 1):  # на каждую пачку — не больше одной страницы аудитории, плюс завершение
            if out["created"] >= batches:
                break
            step = await self.step(campaign_id, now)
            out[step] += 1
            if step in ("done", "idle", "stopped"):
                return out
        if out["created"]:
            # маленькая рассылка обработана целиком — завершить сразу (finish сам проверяет, что pending нет)
            if await self.finish(campaign_id, now) == "done":
                out["done"] += 1
        return out

    async def start_due(self, now: datetime) -> int:
        async with self.rt.transaction() as session:
            due = (
                await session.execute(
                    select(Campaign.campaign_id, Campaign.segment)
                    .where(Campaign.status == "scheduled", Campaign.send_at <= now)
                    .order_by(Campaign.send_at)
                    .limit(50)
                )
            ).all()
        started = 0
        for campaign_id, segment in due:
            try:
                count = await audience_count(self.rt, segment or {})
            except Exception as exc:  # запуск — при следующем dispatch; неудача видна в last_error
                await self.failed(campaign_id, "scheduled", exc, now)
                continue
            async with self.rt.transaction() as session:
                row = await load(session, campaign_id, for_update=True)
                if row.status != "scheduled" or row.send_at is None or row.send_at > now:
                    continue
                row.status = "sending"
                row.started_at = now
                row.audience_count = count.count
                row.version += 1
                row.updated_at = now
                clear_error(row)
                started += 1
                log.info("campaign started", extra={"campaign_id": str(campaign_id), "audience": count.count})
        return started

    async def step(self, campaign_id: uuid.UUID, now: datetime) -> str:
        """→ created (пачка получателей) | fetched (страница аудитории) | done | idle (ошибка источника) |
        stopped (рассылка уже не отправляется)."""
        async with self.rt.transaction() as session:
            row = await session.get(Campaign, campaign_id)
            if row is None or row.status != "sending":
                return "stopped"
            has_pending = (
                await session.execute(
                    select(CampaignRecipient.user_id)
                    .where(CampaignRecipient.campaign_id == campaign_id, CampaignRecipient.status == "pending")
                    .limit(1)
                )
            ).first() is not None
            complete, cursor, segment = row.audience_complete, row.cursor, dict(row.segment or {})
        if has_pending:
            return "created" if await self.create_batch(campaign_id, now) else "stopped"
        if not complete:
            return await self.fetch_page(campaign_id, segment, cursor, now)
        return await self.finish(campaign_id, now)

    async def fetch_page(self, campaign_id: uuid.UUID, segment: dict[str, Any], cursor: str | None,
                         now: datetime) -> str:
        try:
            page = await audience_page(self.rt, segment, cursor)
        except Exception as exc:
            await self.failed(campaign_id, "sending", exc, now)
            return "idle"
        async with self.rt.transaction() as session:
            row = await load(session, campaign_id, for_update=True)
            # Сравнение-и-запись курсора: страницу уже взял параллельный вызов — пропустить
            if row.status != "sending" or row.audience_complete or row.cursor != cursor:
                return "fetched"
            if page.items:
                await session.execute(
                    insert(CampaignRecipient)
                    .values([
                        {"campaign_id": campaign_id, "user_id": item.user_id, "status": "pending", "created_at": now}
                        for item in page.items
                    ])
                    .on_conflict_do_nothing()
                )
            next_cursor = page.next_cursor or None
            row.cursor = next_cursor
            row.audience_complete = next_cursor is None
            row.updated_at = now
            clear_error(row)
        return "fetched"

    async def failed(self, campaign_id: uuid.UUID, status: str, exc: BaseException, now: datetime,
                     *, step: str | None = None) -> None:
        """Неудача шага (ревью P2-7): last_error {code, since, attempts}; на CAMPAIGN_FAILURE_ALERT_ATTEMPTS-й
        неудаче подряд — аудит campaign.failed (один раз на серию). Рассылка остаётся в своём статусе (повтор при
        следующем dispatch; сотрудник видит причину и может остановить)."""
        code = error_code_of(exc)
        threshold = _s(self.rt).campaign_failure_alert_attempts
        async with self.rt.transaction() as session:
            row = await load(session, campaign_id, for_update=True)
            if row.status != status:
                return
            if row.error_code is None:
                row.error_since, row.error_attempts, row.error_reported = now, 0, False
            row.error_code = code
            row.error_attempts += 1
            row.updated_at = now
            alert = row.error_attempts >= threshold and not row.error_reported
            if alert:
                row.error_reported = True
                await session.flush()
                await audit.emit_audit(
                    session,
                    audit.record(
                        "campaign.failed", audit.CAMPAIGN, str(campaign_id), actor=None,
                        after={"status": row.status, "code": code, "attempts": row.error_attempts,
                               "since": iso(row.error_since)},
                        now=now,
                    ),
                )
            attempts = row.error_attempts
        (log.error if alert or code == "SEGMENT_INVALID" else log.warning)(
            "campaign step failed",
            extra={"campaign_id": str(campaign_id),
                   "step": step or ("start" if status == "scheduled" else "audience"),
                   "error_code": code, "attempts": attempts},
        )

    async def create_batch(self, campaign_id: uuid.UUID, now: datetime) -> int:
        s = _s(self.rt)
        async with self.rt.transaction() as session:
            row = await load(session, campaign_id, for_update=True)  # сериализация со stop и другими пачками
            if row.status != "sending":
                return 0
            users = sorted(
                (
                    await session.execute(
                        select(CampaignRecipient.user_id)
                        .where(CampaignRecipient.campaign_id == campaign_id, CampaignRecipient.status == "pending")
                        .order_by(CampaignRecipient.user_id)
                        .limit(s.campaign_recipient_batch)
                        .with_for_update(skip_locked=True)
                    )
                ).scalars().all()
            )
            if not users:
                return 0
            for user_id in users:  # порядок по user_id — без взаимоблокировок с другими рассылками
                await store.lock_user(session, user_id)
            deleted = set(
                (await session.execute(select(DeletedUser.user_id).where(DeletedUser.user_id.in_(users))))
                .scalars().all()
            )
            capped = await recently_reached(
                session, users, since=now - timedelta(days=s.campaign_min_interval_days), exclude=campaign_id
            )
            create = [u for u in users if u not in deleted and u not in capped]
            if create:
                await session.execute(
                    insert(Notification)
                    .values([_notification(campaign_id, u, now) for u in create])
                    .on_conflict_do_nothing()
                )
            updates = [
                {"campaign_id": campaign_id, "user_id": u, "status": "created",
                 "notification_id": notification_id_for(dedup_key(campaign_id, u)), "processed_at": now}
                for u in create
            ] + [
                {"campaign_id": campaign_id, "user_id": u, "status": "cancelled", "notification_id": None,
                 "processed_at": now}
                for u in deleted
            ] + [
                {"campaign_id": campaign_id, "user_id": u, "status": "skipped_frequency", "notification_id": None,
                 "processed_at": now}
                for u in users if u in capped and u not in deleted
            ]
            await session.execute(update(CampaignRecipient), updates)
            if row.error_code is not None:  # удачная пачка завершает серию неудач (например, фоновой пачки)
                clear_error(row)
                row.updated_at = now
        if create:
            self.wake()
        return len(users)

    async def finish(self, campaign_id: uuid.UUID, now: datetime) -> str:
        async with self.rt.transaction() as session:
            row = await load(session, campaign_id, for_update=True)
            if row.status != "sending":
                return "stopped"
            pending = (
                await session.execute(
                    select(CampaignRecipient.user_id)
                    .where(CampaignRecipient.campaign_id == campaign_id, CampaignRecipient.status == "pending")
                    .limit(1)
                )
            ).first()
            if not row.audience_complete or pending is not None:
                return "fetched"
            row.status = "done"
            row.finished_at = now
            row.version += 1
            row.updated_at = now
            await session.flush()
            stats = (await stats_for(session, [row]))[campaign_id]
            await audit.emit_audit(
                session,
                audit.record(
                    "campaign.finished", audit.CAMPAIGN, str(campaign_id), actor=None,
                    before={"status": "sending"},
                    after={"status": "done", "audience": stats["audience"], "created": stats["created"],
                           "skipped_frequency": stats["skipped_frequency"]},
                    now=now,
                ),
            )
        log.info("campaign finished", extra={"campaign_id": str(campaign_id)})
        return "done"


class StartNow:
    """Фоновые первые пачки «Отправить сейчас» (QA D2-03): задача запускается после коммита команды schedule, ответ
    от неё не зависит. Неудача выборки аудитории попадает в last_error внутри шагов Runner (как у :dispatch); любая
    другая — тоже в last_error (best effort) и в лог. Задачи отменяются при остановке сервиса; рассылку доведёт
    :dispatch."""

    def __init__(self, rt: Runtime, wake: Callable[[], None] | None = None) -> None:
        self.rt = rt
        self.wake = wake
        self.tasks: set[asyncio.Task[None]] = set()

    def spawn(self, campaign_id: uuid.UUID) -> None:
        if _s(self.rt).campaign_start_now_batches <= 0:
            return
        task = asyncio.create_task(self._run(campaign_id), name=f"campaign-start-now:{campaign_id}")
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    async def _run(self, campaign_id: uuid.UUID) -> None:
        runner = Runner(self.rt, wake=self.wake)
        try:
            steps = await runner.start_now(campaign_id)
            log.info("campaign first batch", extra={"campaign_id": str(campaign_id),
                                                    **{f"campaign_{k}": v for k, v in steps.items()}})
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.error("campaign first batch failed",
                      extra={"campaign_id": str(campaign_id), "error_type": type(exc).__name__})
            try:
                await runner.failed(campaign_id, "sending", exc, datetime.now(UTC), step="start_now")
            except Exception as again:  # БД недоступна — рассылку продолжит :dispatch
                log.warning("campaign last_error not recorded", extra={"campaign_id": str(campaign_id),
                                                                       "error_type": type(again).__name__})

    async def drain(self) -> None:
        """Дождаться фоновых задач (тесты, плавная остановка)."""
        while self.tasks:
            await asyncio.gather(*list(self.tasks), return_exceptions=True)

    async def close(self, _rt: Runtime | None = None) -> None:
        for task in list(self.tasks):
            task.cancel()
        await asyncio.gather(*list(self.tasks), return_exceptions=True)


def _notification(campaign_id: uuid.UUID, user_id: uuid.UUID, now: datetime) -> dict[str, Any]:
    key = dedup_key(campaign_id, user_id)
    return {
        "notification_id": notification_id_for(key),
        "user_id": user_id,
        "category": CATEGORY,
        "kind": KIND,
        "template": CAMPAIGN_TEMPLATE,
        "params": {"campaign_id": str(campaign_id)},
        "dedup_key": key,
        "telegram_status": "scheduled",
        "center_only": False,
        "scheduled_for": now,
        "attempts": 0,
        "created_at": now,
        "updated_at": now,
    }


# ---------------------------------------------------------------- сводка для Dashboard


async def summary(session: AsyncSession, *, since: datetime) -> dict[str, int]:
    """DashboardCampaigns: запланировано и отправляется сейчас; запущено за период; доставлено в Telegram за период."""
    by_status = dict(
        (await session.execute(
            select(Campaign.status, func.count()).where(Campaign.status.in_(("scheduled", "sending")))
            .group_by(Campaign.status)
        )).all()
    )
    started = (
        await session.execute(select(func.count()).select_from(Campaign).where(Campaign.started_at >= since))
    ).scalar_one()
    delivered = (
        await session.execute(
            select(func.count()).select_from(Notification).where(
                Notification.kind == KIND, Notification.telegram_status == "sent", Notification.sent_at >= since
            )
        )
    ).scalar_one()
    return {
        "scheduled": int(by_status.get("scheduled", 0)),
        "sending": int(by_status.get("sending", 0)),
        "sent_in_period": int(started),
        "delivered_in_period": int(delivered),
    }
