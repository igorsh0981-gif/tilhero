"""Staff API рассылок (admin.ts «Рассылки») — только admin-bff с actor. Права: `notif.campaigns.manage` — список,
черновик, оценка, предпросмотр, тест; `notif.campaigns.send` — расписание, снятие с расписания, остановка (step-up
расписания и остановки проверяет admin-bff). Сводка Dashboard — `dashboard.read`.

GET   /admin/v1/notifications/campaigns/summary?period=      → DashboardCampaigns
GET   /admin/v1/notifications/campaigns?status=&cursor=&limit= → Page<Campaign>
GET   /admin/v1/notifications/campaigns/{id}                  → Campaign
POST  /admin/v1/notifications/campaigns                       → 201 Campaign (Idempotency-Key обязателен)
PATCH /admin/v1/notifications/campaigns/{id}                  → Campaign
POST  /admin/v1/notifications/campaigns/{id}/estimate         → CampaignEstimate
POST  /admin/v1/notifications/campaigns/{id}/preview          → TemplatePreview
POST  /admin/v1/notifications/campaigns/{id}/test             → TestSendResult
POST  /admin/v1/notifications/campaigns/{id}/schedule         → Campaign (scheduled; «сейчас» — sending)
POST  /admin/v1/notifications/campaigns/{id}/unschedule       → Campaign (draft)
POST  /admin/v1/notifications/campaigns/{id}/stop             → Campaign (stopped)
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any, Literal, cast
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse
from sqlalchemy import select, tuple_
from sqlalchemy.exc import IntegrityError

from tilhero_common.app import Runtime, get_runtime
from tilhero_common.errors import unprocessable
from tilhero_common.internal_auth import Principal
from tilhero_notifications import audit, test_send
from tilhero_notifications import campaigns as cmp
from tilhero_notifications.api.common import IdempotencyKey, idempotent, require_any, staff
from tilhero_notifications.api.staff import preview_view, sample_for
from tilhero_notifications.domain.pagination import decode_cursor, encode_cursor
from tilhero_notifications.domain.texts import TextError, has_control
from tilhero_notifications.models import Campaign
from tilhero_notifications.schemas import (
    CampaignContentIn,
    CampaignPatchIn,
    CampaignScheduleIn,
    PreviewIn,
    ReasonIn,
    TestSendIn,
)
from tilhero_notifications.settings import Settings
from tilhero_notifications.template_versions import request_hash
from tilhero_notifications.templates import CAMPAIGN_PLACEHOLDERS, CAMPAIGN_SAMPLE, Lang, Rendered, render_campaign

router = APIRouter(prefix="/admin/v1/notifications/campaigns", tags=["staff"])
MANAGE, SEND, DASHBOARD = "notif.campaigns.manage", "notif.campaigns.send", "dashboard.read"
Status = Literal["draft", "scheduled", "sending", "done", "stopped"]


def _s(rt: Runtime) -> Settings:
    return cast(Settings, rt.settings)


def _reason(reason: str) -> str:
    value = reason.strip()
    if len(value) < 3 or has_control(value, allow_newline=True):
        raise unprocessable("VALIDATION_ERROR", "Укажите причину (3–300 символов)",
                            {"errors": [{"loc": ["body", "reason"], "msg": "invalid", "type": "value_error"}]})
    return value


def _render(campaign: Campaign, lang: Lang, sample: dict[str, str] | None) -> Rendered:
    values = sample_for(CAMPAIGN_SAMPLE[lang], CAMPAIGN_PLACEHOLDERS, sample)
    try:
        return render_campaign(lang, campaign.texts, campaign.route, values.get("learner_name"))
    except TextError:
        raise cmp.campaign_invalid([{"path": f"texts.{lang}", "reason": "invalid_placeholder"}]) from None


async def _get(rt: Runtime, campaign_id: uuid.UUID) -> Campaign:
    async with rt.transaction() as session:
        return await cmp.load(session, campaign_id)


# ---------------------------------------------------------------- чтение


@router.get("/summary")
async def summary(
    principal: Principal = Depends(staff),
    rt: Runtime = Depends(get_runtime),
    period: Literal["today", "7d", "30d"] = Query(default="today"),
) -> dict:
    """Блок «Рассылки» Dashboard (dashboard.read); «сегодня» — по DEFAULT_TIMEZONE."""
    require_any(principal, DASHBOARD, MANAGE)
    now = datetime.now(UTC)
    if period == "today":
        local = now.astimezone(ZoneInfo(_s(rt).default_timezone))
        since = local.replace(hour=0, minute=0, second=0, microsecond=0).astimezone(UTC)
    else:
        since = now - timedelta(days=7 if period == "7d" else 30)
    async with rt.transaction() as session:
        return await cmp.summary(session, since=since)


@router.get("")
async def list_campaigns(
    principal: Principal = Depends(staff),
    rt: Runtime = Depends(get_runtime),
    status: Status | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=100),
    cursor: str | None = Query(default=None, max_length=512),
) -> dict:
    principal.require_permission(MANAGE)
    stmt = select(Campaign).order_by(Campaign.created_at.desc(), Campaign.campaign_id.desc()).limit(limit + 1)
    if status is not None:
        stmt = stmt.where(Campaign.status == status)
    if cursor is not None:
        stmt = stmt.where(tuple_(Campaign.created_at, Campaign.campaign_id) < tuple_(*decode_cursor(cursor)))
    async with rt.transaction() as session:
        rows = list((await session.execute(stmt)).scalars().all())
        page = rows[:limit]
        stats = await cmp.stats_for(session, page)
    next_cursor = encode_cursor(page[-1].created_at, page[-1].campaign_id) if len(rows) > limit else None
    return {"items": [cmp.view(c, stats[c.campaign_id]) for c in page], "next_cursor": next_cursor}


@router.get("/{campaign_id}")
async def get_campaign(
    campaign_id: uuid.UUID, principal: Principal = Depends(staff), rt: Runtime = Depends(get_runtime)
) -> dict:
    principal.require_permission(MANAGE)
    async with rt.transaction() as session:
        return await cmp.view_one(session, await cmp.load(session, campaign_id))


# ---------------------------------------------------------------- черновик


@router.post("", status_code=201, responses={422: {"description": "CAMPAIGN_INVALID {fields}"}})
async def create_campaign(
    body: CampaignContentIn,
    principal: Principal = Depends(staff),
    rt: Runtime = Depends(get_runtime),
    idempotency_key: str | None = IdempotencyKey,
) -> JSONResponse:
    actor = principal.require_permission(MANAGE)
    if idempotency_key is None:
        raise unprocessable("IDEMPOTENCY_KEY_REQUIRED", "Нужен заголовок Idempotency-Key")
    raw = body.model_dump()
    errors = cmp.check_content(raw["title"], raw["texts"], raw["route"], raw["segment"])
    if errors:
        raise cmp.campaign_invalid(errors)
    content = cmp.normalized_content(raw["title"], raw["texts"], raw["route"], raw["segment"])
    fingerprint = request_hash(content)
    try:
        async with rt.transaction() as session:
            row, _ = await cmp.create(
                session, content, actor=actor, idempotency_key=idempotency_key, fingerprint=fingerprint,
                now=datetime.now(UTC),
            )
            out = await cmp.view_one(session, row)
    except IntegrityError:  # параллельный запрос с тем же ключом
        async with rt.transaction() as session:
            row = await cmp.find_by_idempotency(session, actor.id[:64], idempotency_key)  # type: ignore[assignment]
            if row is None or row.request_hash != fingerprint:
                raise unprocessable(
                    "IDEMPOTENCY_KEY_REUSED", "Ключ идемпотентности уже использован с другими данными"
                ) from None
            out = await cmp.view_one(session, row)
    return JSONResponse(out, status_code=201)


@router.patch("/{campaign_id}", responses={409: {"description": "CAMPAIGN_NOT_DRAFT | CAMPAIGN_VERSION_CONFLICT"}})
async def update_campaign(
    campaign_id: uuid.UUID,
    body: CampaignPatchIn,
    principal: Principal = Depends(staff),
    rt: Runtime = Depends(get_runtime),
) -> dict:
    actor = principal.require_permission(MANAGE)
    sent = body.model_fields_set - {"expected_version"}
    raw = body.model_dump()
    current = await _get(rt, campaign_id)
    merged: dict[str, Any] = {
        "title": raw["title"] if "title" in sent else current.title,
        "texts": raw["texts"] if "texts" in sent else current.texts,
        "route": raw["route"] if "route" in sent else current.route,
        "segment": raw["segment"] if "segment" in sent else current.segment,
    }
    errors = cmp.check_content(merged["title"], merged["texts"], merged["route"], merged["segment"])
    if errors:
        raise cmp.campaign_invalid(errors)
    content = cmp.normalized_content(merged["title"], merged["texts"], merged["route"], merged["segment"])
    changes = {name: content[name] for name in sent}
    async with rt.transaction() as session:
        row = await cmp.update_draft(
            session, campaign_id, changes, expected_version=body.expected_version, actor=actor, now=datetime.now(UTC)
        )
        return await cmp.view_one(session, row)


@router.post("/{campaign_id}/estimate")
async def estimate_campaign(
    campaign_id: uuid.UUID, principal: Principal = Depends(staff), rt: Runtime = Depends(get_runtime)
) -> dict:
    principal.require_permission(MANAGE)
    return await cmp.estimate(rt, await _get(rt, campaign_id), datetime.now(UTC))


@router.post("/{campaign_id}/preview")
async def preview_campaign(
    campaign_id: uuid.UUID,
    body: PreviewIn,
    principal: Principal = Depends(staff),
    rt: Runtime = Depends(get_runtime),
) -> dict:
    principal.require_permission(MANAGE)
    campaign = await _get(rt, campaign_id)
    return preview_view(body.lang, _render(campaign, body.lang, body.sample))


@router.post(
    "/{campaign_id}/test",
    responses={422: {"description": "TEST_RECIPIENT_NOT_ALLOWED"}, 429: {"description": "RATE_LIMITED"}},
)
async def test_campaign(
    campaign_id: uuid.UUID,
    body: TestSendIn,
    principal: Principal = Depends(staff),
    rt: Runtime = Depends(get_runtime),
) -> dict:
    """AT-21: только тестовый чат из ADMIN_TEST_CHAT_IDS, «[ТЕСТ] » в заголовке; ученикам — никогда."""
    actor = principal.require_permission(MANAGE)
    chat = test_send.chat_for(rt, body.recipient)
    campaign = await _get(rt, campaign_id)
    rendered = _render(campaign, body.lang, None)
    await test_send.enforce_rate(rt, actor.id)
    result = await test_send.send(rt, chat, rendered)
    async with rt.transaction() as session:
        await audit.emit_audit(
            session,
            audit.record(
                "campaign.test_sent", audit.CAMPAIGN, str(campaign_id), actor=actor,
                after={"lang": body.lang, "recipient": body.recipient, "sent": result["sent"],
                       "delivery_id": result["delivery_id"]},
            ),
        )
    return result


# ---------------------------------------------------------------- отправка (notif.campaigns.send)


@router.post(
    "/{campaign_id}/schedule",
    responses={409: {"description": "CAMPAIGN_NOT_DRAFT | CAMPAIGN_VERSION_CONFLICT"},
               422: {"description": "CAMPAIGN_INVALID | CAMPAIGN_EMPTY_AUDIENCE"}},
)
async def schedule_campaign(
    campaign_id: uuid.UUID,
    body: CampaignScheduleIn,
    request: Request,
    principal: Principal = Depends(staff),
    rt: Runtime = Depends(get_runtime),
    idempotency_key: str | None = IdempotencyKey,
) -> JSONResponse:
    """send_at=null — «Отправить сейчас» по часам сервера (QA D2-03, ревью T2-11); send_at не позже
    now+CAMPAIGN_ASAP_SECONDS (в т. ч. до CAMPAIGN_PAST_TOLERANCE_SECONDS в прошлом) — так же. «Сейчас» —
    запуск в этой команде (ответ уже `sending`, send_at = now), первая пачка получателей — в фоне сразу после
    коммита, дальше — :dispatch. Раньше now−CAMPAIGN_PAST_TOLERANCE_SECONDS — 422 CAMPAIGN_INVALID send_at
    in_past (ревью T2-2); дальше CAMPAIGN_MAX_SCHEDULE_DAYS — 422 too_far; аудитория 0 — 422
    CAMPAIGN_EMPTY_AUDIENCE. Повтор с тем же Idempotency-Key — сохранённый ответ, второй запуск не начинается."""
    actor = principal.require_permission(SEND)
    reason = _reason(body.reason)
    s = _s(rt)

    async def run() -> tuple[int, dict[str, Any]]:
        now = datetime.now(UTC)
        send_at = now
        if body.send_at is not None:
            send_at = body.send_at if body.send_at.tzinfo else body.send_at.replace(tzinfo=UTC)
            if send_at > now + timedelta(days=s.campaign_max_schedule_days):
                raise cmp.campaign_invalid([{"path": "send_at", "reason": "too_far"}])
            if send_at < now - timedelta(seconds=s.campaign_past_tolerance_seconds):
                raise cmp.campaign_invalid([{"path": "send_at", "reason": "in_past"}])  # ревью T2-2
        start = send_at - now <= timedelta(seconds=s.campaign_asap_seconds)
        if start:
            send_at = now
        current = await _get(rt, campaign_id)
        cmp.require_draft(current, body.expected_version)
        errors = cmp.check_content(current.title, current.texts, current.route, current.segment)
        if errors:
            raise cmp.campaign_invalid(errors)
        count = await cmp.count_or_503(rt, current.segment or {})
        if count.count == 0:
            raise unprocessable("CAMPAIGN_EMPTY_AUDIENCE", "В сегменте нет получателей", {"audience": 0})
        async with rt.transaction() as session:
            row = await cmp.schedule(
                session, campaign_id, expected_version=body.expected_version, send_at=send_at, reason=reason,
                audience=count.count, actor=actor, now=now, start=start,
            )
            out = await cmp.view_one(session, row)
        if start:  # после коммита: рассылка уже sending — первая пачка в фоне, ответ от неё не зависит
            cast(cmp.StartNow, request.app.state.campaign_start_now).spawn(campaign_id)
        return 200, out

    return await idempotent(rt, scope=f"{actor.id}:campaigns:schedule:{campaign_id}", key=idempotency_key,
                            request=body.model_dump(mode="json"), run=run)


@router.post("/{campaign_id}/unschedule", responses={409: {"description": "CAMPAIGN_ALREADY_SENDING"}})
async def unschedule_campaign(
    campaign_id: uuid.UUID, body: ReasonIn, principal: Principal = Depends(staff), rt: Runtime = Depends(get_runtime)
) -> dict:
    actor = principal.require_permission(SEND)
    reason = _reason(body.reason)
    async with rt.transaction() as session:
        row, _ = await cmp.unschedule(session, campaign_id, reason=reason, actor=actor, now=datetime.now(UTC))
        return await cmp.view_one(session, row)


@router.post("/{campaign_id}/stop", responses={409: {"description": "CAMPAIGN_NOT_ACTIVE"}})
async def stop_campaign(
    campaign_id: uuid.UUID, body: ReasonIn, principal: Principal = Depends(staff), rt: Runtime = Depends(get_runtime)
) -> dict:
    """Экстренная остановка (step-up — admin-bff) из scheduled | sending | done: новые записи не создаются,
    неотправленные отменяются; повтор — 200 без изменений; черновик — 409 CAMPAIGN_NOT_ACTIVE."""
    actor = principal.require_permission(SEND)
    reason = _reason(body.reason)
    async with rt.transaction() as session:
        row, _ = await cmp.stop(session, campaign_id, reason=reason, actor=actor, now=datetime.now(UTC))
        return await cmp.view_one(session, row)
