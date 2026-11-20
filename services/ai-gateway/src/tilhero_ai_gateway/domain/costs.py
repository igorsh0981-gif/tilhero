"""Модели и цены, бюджет и аварийная остановка, затраты (admin.ts «Модели и затраты», ADM-MONEY-01/02, AT-51).

Модели речи (спринт 5): цена — `audio_usd_per_hour` ($ за час аудио), цены токенов — 0 (иначе 422
PRICE_NOT_APPLICABLE); у `azure_speech` цена часа > 0 (422 PRICE_REQUIRED); снижение — только с costs.manage, как у
LLM; выключение модели речи допустимо (оценка произношения → not_configured, speech_available=false). Сводка: блок
`speech` — вызовы `pronunciation_coach`, минуты оценённого аудио (вызовы со status ok), расход (входит в spent_usd).

Сводка `usage/summary?period=day|week|month`: day — с начала «сегодня» по Ташкенту, week — последние 7 дней по
Ташкенту (включая сегодня), month — календарный месяц UTC (как потолок). spent_usd — все вызовы периода (включая
золотые прогоны — это реальные деньги); calls/unavailable/p95 — вызовы уроков (без золотых); доля потолка — расход
месяца против monthly_cap_usd; by_day — по датам Ташкента, дни без вызовов — нулями.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any, Final

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_ai_gateway.domain.budget import month_spent
from tilhero_ai_gateway.domain.common import (
    COSTS_MANAGE,
    audit_payload,
    emit_audit,
    iso_z,
    local_date,
    local_day_start,
    month_start,
    usd,
)
from tilhero_ai_gateway.domain.registry import SPEECH_PROVIDERS
from tilhero_ai_gateway.models import AgentRollout, AgentVersion, BudgetRow, ModelRow, UsageRow
from tilhero_common.errors import conflict, forbidden, not_found, unprocessable
from tilhero_common.internal_auth import Actor

PERIODS: Final = ("day", "week", "month")
SPEECH_AGENT: Final = "pronunciation_coach"


def model_view(m: ModelRow) -> dict[str, Any]:
    return {"model_id": m.model_id, "provider": m.provider, "input_usd_per_mtok": float(m.input_usd_per_mtok),
            "output_usd_per_mtok": float(m.output_usd_per_mtok),
            "audio_usd_per_hour": float(m.audio_usd_per_hour) if m.audio_usd_per_hour is not None else None,
            "active": m.active, "updated_at": iso_z(m.updated_at)}


def budget_view(b: BudgetRow) -> dict[str, Any]:
    return {"ai_enabled": b.ai_enabled, "monthly_cap_usd": float(b.monthly_cap_usd),
            "learner_daily_cap_usd": float(b.learner_daily_cap_usd), "lesson_cap_usd": float(b.lesson_cap_usd),
            "alert_percent": b.alert_percent, "updated_at": iso_z(b.updated_at)}


async def list_models(session: AsyncSession) -> list[ModelRow]:
    return list((await session.execute(select(ModelRow).order_by(ModelRow.model_id))).scalars().all())


def _price_fields(row: ModelRow, input_usd: Decimal, output_usd: Decimal, audio_usd: Decimal | None,
                  audio_given: bool) -> Decimal | None:
    """Проверка цен по виду модели → новая цена часа аудио (речь) или None (LLM)."""
    if row.provider in SPEECH_PROVIDERS:
        if input_usd != 0 or output_usd != 0:
            raise unprocessable("PRICE_NOT_APPLICABLE", "У модели оценки речи нет цен токенов — передайте 0",
                                {"fields": [f for f, v in (("input_usd_per_mtok", input_usd),
                                                           ("output_usd_per_mtok", output_usd)) if v != 0]})
        if audio_given and audio_usd is None:
            raise unprocessable("PRICE_REQUIRED", "Для модели оценки речи нужна цена часа аудио",
                                {"fields": ["audio_usd_per_hour"]})
        audio = audio_usd if audio_usd is not None else row.audio_usd_per_hour
        # как R1-12 для LLM: нулевая цена настоящего провайдера = бесконтрольный расход
        if row.provider == "azure_speech" and (audio is None or audio <= 0):
            raise unprocessable("PRICE_REQUIRED", "Для Azure Speech цена часа аудио должна быть больше нуля",
                                {"fields": ["audio_usd_per_hour"]})
        return audio
    if audio_usd is not None:
        raise unprocessable("PRICE_NOT_APPLICABLE", "Цена часа аудио — только у моделей оценки речи",
                            {"fields": ["audio_usd_per_hour"]})
    # ревью R1-12: у модели настоящего провайдера нулевая цена = бесконтрольный расход (бюджеты считают по цене)
    if row.provider == "anthropic" and (input_usd <= 0 or output_usd <= 0):
        raise unprocessable("PRICE_REQUIRED", "Для модели Anthropic цены ввода и вывода должны быть больше нуля",
                            {"fields": [f for f, v in (("input_usd_per_mtok", input_usd),
                                                       ("output_usd_per_mtok", output_usd)) if v <= 0]})
    return None


async def update_model(session: AsyncSession, model_id: str, *, input_usd: Decimal, output_usd: Decimal, active: bool,
                       reason: str, actor: Actor, now: datetime, audio_usd: Decimal | None = None,
                       audio_given: bool = False) -> ModelRow:
    row = (await session.execute(select(ModelRow).where(ModelRow.model_id == model_id).with_for_update())
           ).scalar_one_or_none()
    if row is None:
        raise not_found("MODEL_NOT_FOUND", "Модель не найдена")
    audio = _price_fields(row, input_usd, output_usd, audio_usd, audio_given)
    # снижение цены ослабляет все лимиты бюджета — только с правом на бюджет (costs.manage), не одним ai.publish
    lowered = input_usd < row.input_usd_per_mtok or output_usd < row.output_usd_per_mtok or (
        audio is not None and row.audio_usd_per_hour is not None and audio < row.audio_usd_per_hour)
    if lowered and COSTS_MANAGE not in actor.permissions:
        raise forbidden("PERMISSION_DENIED", "Снизить цену модели может только сотрудник с правом на бюджет",
                        {"permission": COSTS_MANAGE})
    if row.active and not active and row.provider not in SPEECH_PROVIDERS:
        # модель, на которой работает опубликованная версия или канарейка, выключать нельзя — сначала другая версия
        used = (await session.execute(
            select(AgentVersion.agent_id, AgentVersion.version)
            .join(AgentRollout, AgentRollout.agent_id == AgentVersion.agent_id)
            .where(AgentVersion.model_id == model_id,
                   (AgentVersion.version == AgentRollout.published_version)
                   | (AgentVersion.version == AgentRollout.canary_version)))).all()
        if used:
            raise conflict("MODEL_IN_USE", "Модель используется опубликованной версией или канарейкой",
                           {"versions": [f"{a}@{v}" for a, v in used]})
    def prices(m: ModelRow) -> dict[str, Any]:
        out: dict[str, Any] = {"input_usd_per_mtok": str(m.input_usd_per_mtok),
                               "output_usd_per_mtok": str(m.output_usd_per_mtok), "active": m.active}
        if m.provider in SPEECH_PROVIDERS:
            out["audio_usd_per_hour"] = str(m.audio_usd_per_hour)
        return out

    before = prices(row)
    row.input_usd_per_mtok = input_usd
    row.output_usd_per_mtok = output_usd
    row.audio_usd_per_hour = audio
    row.active = active
    row.updated_by = actor.id
    row.updated_at = now
    await session.flush()
    await emit_audit(session, audit_payload(actor, "ai.model_updated", "ai_model", model_id, before=before,
                                            after=prices(row), reason=reason))
    return row


async def get_budget(session: AsyncSession, *, for_update: bool = False) -> BudgetRow:
    stmt = select(BudgetRow).where(BudgetRow.id == 1)
    if for_update:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    row = (await session.execute(stmt)).scalar_one_or_none()
    if row is None:  # pragma: no cover — сид миграции 0001
        raise not_found("BUDGET_NOT_FOUND", "Бюджет не настроен")
    return row


async def update_budget(session: AsyncSession, values: dict[str, Any], expected_updated_at: str | None, reason: str,
                        actor: Actor, now: datetime) -> BudgetRow:
    row = await get_budget(session, for_update=True)
    if expected_updated_at is not None and expected_updated_at != iso_z(row.updated_at):
        raise conflict("BUDGET_CONFLICT", "Бюджет изменился — обновите страницу", {"updated_at": iso_z(row.updated_at)})
    before = budget_view(row)
    for key, value in values.items():
        setattr(row, key, value)
    after = budget_view(row)
    if {k: v for k, v in after.items() if k != "updated_at"} == {k: v for k, v in before.items() if k != "updated_at"}:
        return row
    row.updated_by = actor.id
    row.updated_at = now
    await session.flush()
    before.pop("updated_at")
    after = budget_view(row)
    after.pop("updated_at")
    if before["ai_enabled"] != after["ai_enabled"]:
        await emit_audit(session, audit_payload(actor, "ai.emergency_stop", "ai_budget", "budget",
                                                before={"ai_enabled": before["ai_enabled"]},
                                                after={"ai_enabled": after["ai_enabled"]}, reason=reason))
    caps_before = {k: v for k, v in before.items() if k != "ai_enabled"}
    caps_after = {k: v for k, v in after.items() if k != "ai_enabled"}
    if caps_before != caps_after:
        await emit_audit(session, audit_payload(actor, "ai.budget_updated", "ai_budget", "budget",
                                                before=caps_before, after=caps_after, reason=reason))
    return row


# ---------------------------------------------------------------- затраты


def _period_start(period: str, now: datetime, tz: str) -> datetime:
    if period == "day":
        return local_day_start(now, tz)
    if period == "week":
        return local_day_start(now, tz) - timedelta(days=6)
    return month_start(now)


def _p95(values: list[int]) -> int | None:
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, -(-95 * len(ordered) // 100) - 1)  # ближайший ранг
    return ordered[index]


async def speech_summary(session: AsyncSession, since: datetime, speech_available: bool) -> dict[str, Any]:
    """AiUsageSummary.speech: вызовы pronunciation_coach за период, минуты оценённого аудио (status ok — провайдер
    обработал запись), расход."""
    calls, audio_ms, spent = (await session.execute(
        select(func.count(),
               func.coalesce(func.sum(UsageRow.audio_ms).filter(UsageRow.status == "ok"), 0),
               func.coalesce(func.sum(UsageRow.cost_usd), 0))
        .where(UsageRow.created_at >= since, UsageRow.status != "pending", UsageRow.agent_id == SPEECH_AGENT))).one()
    return {"calls": int(calls), "audio_minutes": round(int(audio_ms) / 60_000, 2), "spent_usd": usd(spent),
            "speech_available": speech_available}


async def summary(session: AsyncSession, period: str, now: datetime, tz: str,
                  speech_available: bool = False) -> dict[str, Any]:
    """AiUsageSummary (admin.ts)."""
    budget = await get_budget(session)
    since = _period_start(period, now, tz)
    done = (UsageRow.created_at >= since, UsageRow.status != "pending")
    learner = func.coalesce(UsageRow.session_kind, "") != "golden"
    spent = Decimal(await session.scalar(select(func.coalesce(func.sum(UsageRow.cost_usd), 0)).where(*done)) or 0)
    calls, unavailable = (await session.execute(
        select(func.count(), func.count().filter(UsageRow.status == "unavailable")).where(*done, learner))).one()
    latencies = [int(v) for v in (await session.execute(
        select(UsageRow.latency_ms).where(*done, learner, UsageRow.status == "ok"))).scalars().all()]
    by_agent = [{"agent_id": a, "calls": int(n), "spent_usd": usd(s), "unavailable": int(u)}
                for a, n, s, u in (await session.execute(
                    select(UsageRow.agent_id, func.count().filter(learner),
                           func.coalesce(func.sum(UsageRow.cost_usd), 0),
                           func.count().filter(UsageRow.status == "unavailable", learner))
                    .where(*done).group_by(UsageRow.agent_id).order_by(UsageRow.agent_id))).all()]
    by_model = [{"model_id": m, "calls": int(n), "input_tokens": int(i), "output_tokens": int(o), "spent_usd": usd(s)}
                for m, n, i, o, s in (await session.execute(
                    select(UsageRow.model_id, func.count(), func.coalesce(func.sum(UsageRow.input_tokens), 0),
                           func.coalesce(func.sum(UsageRow.output_tokens), 0),
                           func.coalesce(func.sum(UsageRow.cost_usd), 0))
                    .where(*done, UsageRow.model_id.is_not(None)).group_by(UsageRow.model_id)
                    .order_by(UsageRow.model_id))).all()]
    days: dict[str, dict[str, Any]] = {}
    start_day = local_date(since, tz)
    for i in range((local_date(now, tz) - start_day).days + 1):
        d = (start_day + timedelta(days=i)).isoformat()
        days[d] = {"date": d, "spent": Decimal(0), "calls": 0}
    for created, cost, kind in (await session.execute(
            select(UsageRow.created_at, UsageRow.cost_usd, UsageRow.session_kind).where(*done))).all():
        d = local_date(created, tz).isoformat()
        bucket = days.setdefault(d, {"date": d, "spent": Decimal(0), "calls": 0})
        bucket["spent"] += Decimal(cost)
        if kind != "golden":
            bucket["calls"] += 1
    per_lesson = (await session.execute(
        select(func.sum(UsageRow.cost_usd)).where(*done, UsageRow.session_kind == "lesson")
        .group_by(UsageRow.session_id))).scalars().all()
    month = await month_spent(session, now)
    cap = Decimal(budget.monthly_cap_usd)
    return {
        "period": period,
        "spent_usd": usd(spent),
        "monthly_cap_usd": float(cap),
        "cap_used_pct": round(float(month * 100 / cap), 1) if cap > 0 else (100.0 if month > 0 else 0.0),
        "calls": int(calls),
        "unavailable": int(unavailable),
        "unavailable_pct": round(int(unavailable) * 100 / int(calls), 1) if calls else None,
        "p95_latency_ms": _p95(latencies),
        "by_agent": by_agent,
        "by_model": by_model,
        "by_day": [{"date": b["date"], "spent_usd": usd(b["spent"]), "calls": b["calls"]}
                   for b in sorted(days.values(), key=lambda b: str(b["date"]))],
        "avg_cost_per_lesson_usd": usd(sum((Decimal(v or 0) for v in per_lesson), Decimal(0)) / len(per_lesson))
        if per_lesson else None,
        "ai_enabled": budget.ai_enabled,
        "alert_percent": budget.alert_percent,
        "speech": await speech_summary(session, since, speech_available),
    }


def call_view(u: UsageRow) -> dict[str, Any]:
    """AiCall (admin.ts) — без текстов и без user_id."""
    return {"call_id": str(u.call_id), "agent_id": u.agent_id, "version": u.version, "model_id": u.model_id,
            "status": u.status, "reason": u.reason, "input_tokens": u.input_tokens, "output_tokens": u.output_tokens,
            "cost_usd": usd(u.cost_usd), "latency_ms": u.latency_ms,
            "session_id": str(u.session_id) if u.session_id else None, "canary": u.canary,
            "created_at": iso_z(u.created_at)}


async def list_calls(session: AsyncSession, *, session_id: Any | None, agent_id: str | None, before_seq: int | None,
                     limit: int) -> tuple[list[UsageRow], bool]:
    stmt = select(UsageRow).where(UsageRow.status != "pending")
    if session_id is not None:
        stmt = stmt.where(UsageRow.session_id == session_id)
    if agent_id is not None:
        stmt = stmt.where(UsageRow.agent_id == agent_id)
    if before_seq is not None:
        stmt = stmt.where(UsageRow.seq < before_seq)
    rows = list((await session.execute(stmt.order_by(UsageRow.seq.desc()).limit(limit + 1))).scalars().all())
    return rows[:limit], len(rows) > limit


async def by_session(session: AsyncSession, session_ids: list[uuid.UUID]) -> list[dict[str, Any]]:
    """Сводка ИИ по сессиям для журнала «Контроля диалогов» (SessionRow.models / cost_usd / p95_latency_ms):
    модели вызовов, оплаченная стоимость, p95 задержки успешных вызовов. Сессии без вызовов — нули, порядок — как в
    запросе (без повторов)."""
    ids = list(dict.fromkeys(session_ids))
    acc: dict[uuid.UUID, dict[str, Any]] = {sid: {"models": set(), "cost": Decimal(0), "latency": []} for sid in ids}
    if ids:
        rows = (await session.execute(
            select(UsageRow.session_id, UsageRow.model_id, UsageRow.cost_usd, UsageRow.latency_ms, UsageRow.status)
            .where(UsageRow.session_id.in_(ids), UsageRow.status != "pending"))).all()
        for sid, model_id, cost, latency, status in rows:
            item = acc.get(sid) if sid is not None else None
            if item is None:
                continue
            if model_id is not None:
                item["models"].add(model_id)
            item["cost"] += Decimal(cost)
            if status == "ok":
                item["latency"].append(int(latency))
    return [{"session_id": str(sid), "models": sorted(acc[sid]["models"]), "cost_usd": usd(acc[sid]["cost"]),
             "p95_latency_ms": _p95(acc[sid]["latency"])} for sid in ids]

