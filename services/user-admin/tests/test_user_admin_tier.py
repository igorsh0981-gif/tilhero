"""Спринт 8 (INTERNAL_API §9, admin.ts AdminLearnerRow.tier, ADM-USR-01): тариф ученика в read-модели — consumer
billing.access.changed.v1 (только от billing; поздние события тариф не откатывают; удаление стирает), фильтр списка
?tier=free|paid (NULL — «считать free», paid с истёкшим paid_until — free), тариф в строке и карточке."""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import select
from user_admin_testkit import ID, iso, now

from tilhero_common.testing import assert_event_conforms
from tilhero_user_admin.models import LearnerSummary

LIST = "/admin/v1/learners"


def access(user_id: str, tier: str = "paid", *, paid_until: datetime | None = None,
           changed_at: datetime | None = None) -> dict[str, Any]:
    return {"user_id": user_id, "account_id": user_id, "tier": tier,
            "features": ["ai_lessons", "pair_lessons"] if tier == "paid" else [],
            "paid_until": iso(paid_until) if paid_until else None, "changed_at": iso(changed_at or now())}


async def emit_access(env, user_id: str, tier: str = "paid", producer: str = "billing", **kw: Any):
    ev = await env.emit("billing.access.changed.v1", access(user_id, tier, **kw), producer=producer)
    assert_event_conforms(ev)
    return ev


async def row(env, user_id: str) -> LearnerSummary:
    async with env.runtime.transaction() as s:
        return (await s.execute(select(LearnerSummary).where(LearnerSummary.user_id == uuid.UUID(user_id)))
                ).scalar_one()


async def tiers(env, **params: Any) -> dict[str, str | None]:
    r = await env.get(LIST, params={"limit": 100, **params})
    assert r.status_code == 200, r.text
    return {i["user_id"]: i["tier"] for i in r.json()["items"]}


async def test_tier_projection_and_filter(env) -> None:
    paid, free, unknown, expired = [str((await env.seed(n=i))["user_id"]) for i in range(4)]
    await emit_access(env, paid, paid_until=now() + timedelta(days=30))
    await emit_access(env, free, "free")
    await emit_access(env, expired, paid_until=now() - timedelta(minutes=1))  # tick billing ещё не дошёл
    everyone = await tiers(env)
    assert {k: everyone[k] for k in (paid, free, unknown, expired)} == {
        paid: "paid", free: "free", unknown: None, expired: "free"}
    assert set(await tiers(env, tier="paid")) == {paid}
    assert set(await tiers(env, tier="free")) >= {free, unknown, expired} and paid not in await tiers(env, tier="free")
    r = await env.get(LIST, params={"tier": "gold"})
    assert r.status_code == 422
    # карточка — тот же тариф
    card = (await env.get(f"{LIST}/{paid}")).json()
    assert card["tier"] == "paid"
    # бессрочный доступ (выдача сотрудником без конца) — paid
    await emit_access(env, unknown, paid_until=None)
    assert (await tiers(env, tier="paid")).keys() == {paid, unknown}


async def test_late_event_does_not_roll_back_and_redelivery(env) -> None:
    uid = str((await env.seed(n=1))["user_id"])
    t0 = now()
    await emit_access(env, uid, paid_until=t0 + timedelta(days=30), changed_at=t0)
    await emit_access(env, uid, "free", changed_at=t0 - timedelta(minutes=5))  # позднее — пропущено
    r = await row(env, uid)
    assert r.tier == "paid" and r.paid_until is not None and r.tier_at is not None
    ev = await emit_access(env, uid, "free", changed_at=t0 + timedelta(days=30))
    await env.deliver(ev, times=2)  # повторная доставка — inbox
    r = await row(env, uid)
    assert (r.tier, r.paid_until) == ("free", None)


async def test_foreign_producer_ignored(env, caplog) -> None:
    caplog.set_level(logging.WARNING, logger="tilhero.user_admin.projection")
    uid = str((await env.seed(n=2))["user_id"])
    await emit_access(env, uid, producer="lessons")
    await emit_access(env, uid, producer=ID)
    assert (await row(env, uid)).tier is None
    warned = [r for r in caplog.records if r.getMessage() == "event from unexpected producer ignored"]
    assert len(warned) == 2 and all(uid not in str(r.__dict__) for r in warned)


async def test_deletion_erases_tier(env) -> None:
    uid = str((await env.seed(n=3))["user_id"])
    await emit_access(env, uid, paid_until=now() + timedelta(days=30))
    req = str(uuid.uuid4())
    await env.emit("user.domain.deleted.v1", {"user_id": uid, "request_id": req, "domain": ID,
                                              "mode": "anonymized"}, producer=ID)
    r = await row(env, uid)
    assert (r.status, r.tier, r.paid_until) == ("DELETED", None, None)
    # поздний тариф удалённому не возвращается
    await emit_access(env, uid, paid_until=now() + timedelta(days=60), changed_at=now() + timedelta(minutes=1))
    assert (await row(env, uid)).tier is None


async def test_event_before_profile_creates_hidden_row(env) -> None:
    """Событие billing раньше профиля: строка-заготовка (profile_known=false) в списке не видна, тариф сохранён и
    появится вместе с профилем."""
    uid = str(uuid.uuid4())
    await emit_access(env, uid, paid_until=now() + timedelta(days=30))
    assert uid not in await tiers(env)
    assert (await row(env, uid)).tier == "paid"
