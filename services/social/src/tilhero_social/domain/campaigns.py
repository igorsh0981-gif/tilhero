"""Реферальные кампании (§1.4, ADM-REF-01): версии draft → проверка (валидатор) → активация (referral.manage +
step-up + комментарий ≥ 10). Одна draft и одна active (частичные UNIQUE), версия 1 — миграцией. Прежняя active →
archived; рефералы остаются на версии, по которой приняты. Каждая команда — аудит."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Final

from sqlalchemy import func, select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.errors import ApiError, conflict, not_found, unprocessable
from tilhero_common.internal_auth import Actor
from tilhero_social.domain.common import emit_audit, iso, staff_ref
from tilhero_social.models import Counter, ReferralCampaign

# ограничения валидатора (admin.ts ReferralCampaignPayload)
_INT_RANGES: Final = {
    "min_lessons": (1, 10), "window_days": (7, 90), "monthly_cap": (1, 100),
}
_REWARD_RANGES: Final = {"freeze": (0, 5), "til": (0, 1000)}
_REVIEW_RANGES: Final = {"velocity_per_day": (1, 50), "min_lesson_minutes": (1, 20)}
_TOP_KEYS: Final = ("require_diagnostic", "min_lessons", "min_days", "window_days", "inviter_reward",
                    "invitee_reward", "monthly_cap", "review")
_STRUCTURAL: Final = frozenset({"type", "required", "unknown"})
_COUNTER: Final = "referral_campaign"


def version_not_found() -> ApiError:
    return not_found("CAMPAIGN_VERSION_NOT_FOUND", "Версия кампании не найдена")


def campaign_invalid(errors: list[dict[str, str]]) -> ApiError:
    return unprocessable("CAMPAIGN_INVALID", "Кампания не прошла проверку", {"errors": errors})


def draft_conflict(updated_at: datetime | None) -> ApiError:
    return conflict("DRAFT_CONFLICT", "Черновик изменён другим сотрудником — обновите страницу",
                    {"updated_at": iso(updated_at)})


def _is_int(v: object) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _obj(errors: list[dict[str, str]], value: object, path: str, keys: tuple[str, ...]) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        errors.append({"path": path, "code": "type"})
        return None
    for k in keys:
        if k not in value:
            errors.append({"path": f"{path}.{k}" if path else k, "code": "required"})
    for k in value:
        if k not in keys:
            errors.append({"path": f"{path}.{k}" if path else str(k), "code": "unknown"})
    return value


def _int(errors: list[dict[str, str]], obj: dict[str, Any], key: str, path: str, lo: int, hi: int) -> int | None:
    if key not in obj:
        return None
    v = obj[key]
    if not _is_int(v):
        errors.append({"path": path, "code": "type"})
        return None
    if not lo <= v <= hi:
        errors.append({"path": path, "code": "range"})
    return int(v)


def validate(payload: object) -> list[dict[str, str]]:
    """Ошибки [{path, code}]: type | required | unknown (структура) | range | min_days_gt_min_lessons."""
    errors: list[dict[str, str]] = []
    top = _obj(errors, payload, "", _TOP_KEYS)
    if top is None:
        return errors
    if "require_diagnostic" in top and not isinstance(top["require_diagnostic"], bool):
        errors.append({"path": "require_diagnostic", "code": "type"})
    values = {k: _int(errors, top, k, k, lo, hi) for k, (lo, hi) in _INT_RANGES.items()}
    min_days = _int(errors, top, "min_days", "min_days", 1, 10)
    if min_days is not None and values["min_lessons"] is not None and min_days > values["min_lessons"]:
        errors.append({"path": "min_days", "code": "min_days_gt_min_lessons"})
    for side in ("inviter_reward", "invitee_reward"):
        if side in top:
            reward = _obj(errors, top[side], side, tuple(_REWARD_RANGES))
            if reward is not None:
                for k, (lo, hi) in _REWARD_RANGES.items():
                    _int(errors, reward, k, f"{side}.{k}", lo, hi)
    if "review" in top:
        review = _obj(errors, top["review"], "review", tuple(_REVIEW_RANGES))
        if review is not None:
            for k, (lo, hi) in _REVIEW_RANGES.items():
                _int(errors, review, k, f"review.{k}", lo, hi)
    return errors


def structural(errors: list[dict[str, str]]) -> list[dict[str, str]]:
    return [e for e in errors if e["code"] in _STRUCTURAL]


def warnings(draft: dict[str, Any], active: dict[str, Any]) -> list[dict[str, str]]:
    """Предупреждения (не мешают активации): пригласившему ничего, лимит месяца вырос больше чем вдвое, порог
    проверки скорости выше лимита месяца, окно меньше чем 7 дней на каждый требуемый день."""
    out: list[dict[str, str]] = []
    if draft["inviter_reward"]["freeze"] == 0 and draft["inviter_reward"]["til"] == 0:
        out.append({"path": "inviter_reward", "code": "no_inviter_reward"})
    if draft["monthly_cap"] > 2 * int(active.get("monthly_cap", draft["monthly_cap"])):
        out.append({"path": "monthly_cap", "code": "cap_more_than_doubled"})
    if draft["review"]["velocity_per_day"] > draft["monthly_cap"]:
        out.append({"path": "review.velocity_per_day", "code": "velocity_above_monthly_cap"})
    return out


def diff(active: dict[str, Any], draft: dict[str, Any], prefix: str = "") -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for key in sorted(set(active) | set(draft)):
        path = f"{prefix}.{key}" if prefix else key
        a, d = active.get(key), draft.get(key)
        if isinstance(a, dict) and isinstance(d, dict):
            out.extend(diff(a, d, path))
        elif a != d:
            out.append({"path": path, "from": a, "to": d})
    return out


def summary(v: ReferralCampaign) -> dict[str, Any]:
    return {"version": v.version, "status": v.status, "comment": v.comment, "based_on": v.based_on,
            "created_by": staff_ref(v.created_by, v.created_by_name), "created_at": iso(v.created_at),
            "validated_at": iso(v.validated_at), "activated_by": staff_ref(v.activated_by, v.activated_by_name),
            "activated_at": iso(v.activated_at)}


async def active(session: AsyncSession, *, lock: bool = False) -> ReferralCampaign:
    stmt = select(ReferralCampaign).where(ReferralCampaign.status == "active")
    if lock:
        stmt = stmt.with_for_update()
    return (await session.execute(stmt.execution_options(populate_existing=True))).scalar_one()


async def payload_of(session: AsyncSession, version: int) -> dict[str, Any]:
    v = await session.get(ReferralCampaign, version)
    assert v is not None
    return dict(v.payload)


async def _draft(session: AsyncSession) -> ReferralCampaign | None:
    return (await session.execute(select(ReferralCampaign).where(ReferralCampaign.status == "draft")
                                  .with_for_update().execution_options(populate_existing=True))).scalar_one_or_none()


async def full(session: AsyncSession, v: ReferralCampaign) -> dict[str, Any]:
    act = v if v.status == "active" else await active(session)
    return {**summary(v), "payload": v.payload, "diff": diff(dict(act.payload), dict(v.payload)),
            "updated_at": iso(v.updated_at)}


async def list_versions(session: AsyncSession) -> dict[str, Any]:
    rows = (await session.execute(select(ReferralCampaign).order_by(ReferralCampaign.version.desc()))
            ).scalars().all()
    return {"items": [summary(v) for v in rows]}


async def get_version(session: AsyncSession, version: int) -> dict[str, Any]:
    v = await session.get(ReferralCampaign, version)
    if v is None:
        raise version_not_found()
    return await full(session, v)


async def _lock(session: AsyncSession) -> None:
    """Команды над версиями — по очереди (номер версии, одна draft/active)."""
    await session.execute(text("SELECT pg_advisory_xact_lock(:c, 0)"), {"c": 0x534F4352})  # 'SOCR'


async def _next_version(session: AsyncSession) -> int:
    """Следующий номер версии — монотонный счётчик (удалённый черновик номер не освобождает). Под _lock."""
    top = int(await session.scalar(select(func.coalesce(func.max(ReferralCampaign.version), 0))) or 0)
    counter = await session.get(Counter, _COUNTER, with_for_update=True, populate_existing=True)
    nxt = max(top, counter.value if counter is not None else 0) + 1
    await session.execute(insert(Counter).values(name=_COUNTER, value=nxt).on_conflict_do_update(
        index_elements=["name"], set_={"value": nxt}))
    return nxt


async def put_draft(session: AsyncSession, actor: Actor, payload: Any, comment: str | None, based_on: int | None,
                    if_match: str | None, now: datetime) -> dict[str, Any]:
    """Создать или заменить черновик (замена — только с If-Match = updated_at, иначе 409 DRAFT_CONFLICT);
    структурно неверный payload не сохраняется (422 CAMPAIGN_INVALID)."""
    await _lock(session)
    errors = structural(validate(payload))
    if errors:
        raise campaign_invalid(errors)
    if based_on is not None and await session.get(ReferralCampaign, based_on) is None:
        raise version_not_found()
    draft = await _draft(session)
    if draft is None:
        if if_match:
            raise draft_conflict(None)
        draft = ReferralCampaign(version=await _next_version(session), status="draft", payload=payload,
                                 comment=comment, based_on=based_on, created_by=actor.id[:64],
                                 created_by_name=(actor.name or "")[:120], created_at=now, updated_at=now)
        session.add(draft)
        action = "referral.campaign.draft_created"
    else:
        if if_match is None or if_match.strip().strip('"') != iso(draft.updated_at):
            raise draft_conflict(draft.updated_at)
        draft.payload, draft.comment, draft.based_on = payload, comment, based_on
        draft.updated_at, draft.validated_at = now, None
        action = "referral.campaign.draft_saved"
    await session.flush()
    await emit_audit(session, actor, action, "referral_campaign", str(draft.version),
                     after={"version": draft.version, "based_on": based_on})
    return await full(session, draft)


async def delete_draft(session: AsyncSession, actor: Actor) -> None:
    await _lock(session)
    draft = await _draft(session)
    if draft is None:
        raise version_not_found()
    version = draft.version
    await session.delete(draft)
    await emit_audit(session, actor, "referral.campaign.draft_deleted", "referral_campaign", str(version))


async def validate_draft(session: AsyncSession, actor: Actor, now: datetime) -> dict[str, Any]:
    """RulesValidation {ok, errors, warnings}; ok — ставит validated_at."""
    await _lock(session)
    draft = await _draft(session)
    if draft is None:
        raise version_not_found()
    errors = validate(draft.payload)
    warns = warnings(dict(draft.payload), dict((await active(session)).payload)) if not errors else []
    if not errors:
        draft.validated_at = now
    await emit_audit(session, actor, "referral.campaign.validated", "referral_campaign", str(draft.version),
                     after={"ok": not errors, "errors": len(errors), "warnings": len(warns)})
    return {"ok": not errors, "errors": errors, "warnings": warns}


async def activate_draft(session: AsyncSession, actor: Actor, comment: str, now: datetime) -> dict[str, Any]:
    """409 CAMPAIGN_NOT_VALIDATED — черновик не проверен после последней правки; прежняя active → archived."""
    await _lock(session)
    draft = await _draft(session)
    if draft is None:
        raise version_not_found()
    if draft.validated_at is None or draft.validated_at < draft.updated_at:
        raise conflict("CAMPAIGN_NOT_VALIDATED", "Сначала проверьте черновик", {"updated_at": iso(draft.updated_at)})
    errors = validate(draft.payload)
    if errors:
        raise campaign_invalid(errors)
    prev = await active(session, lock=True)
    prev.status = "archived"
    await session.flush()
    draft.status, draft.comment = "active", comment
    draft.activated_by, draft.activated_by_name, draft.activated_at = actor.id[:64], (actor.name or "")[:120], now
    await session.flush()
    await emit_audit(session, actor, "referral.campaign.activated", "referral_campaign", str(draft.version),
                     before={"active_version": prev.version}, after={"active_version": draft.version},
                     reason=comment)
    return await full(session, draft)
