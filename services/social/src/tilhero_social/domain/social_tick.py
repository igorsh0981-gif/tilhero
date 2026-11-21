"""Шаги tick спринта 7 (§1.5) в `POST /internal/v1/invites:tick` (n8n, каждый час): заявки в друзья старше
FRIEND_REQUEST_TTL_DAYS → expired; рефералы с истёкшим окном → expired (social.referral.rejected.v1 window_expired);
social_ban с прошедшим сроком → expired_at (social.sanction.changed.v1 change=expired, active=false); ключи
идемпотентности команд ученика старше IDEMPOTENCY_DAYS. Пачками, строки — FOR UPDATE SKIP LOCKED с повторной
проверкой условий: параллельные запуски не публикуют событие дважды. Повтор безопасен."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import delete, select, update

from tilhero_common.app import Runtime
from tilhero_social.domain import referrals
from tilhero_social.domain.common import SANCTION_CHANGED, emit_event, iso
from tilhero_social.models import FriendRequest, LearnerIdempotency, Sanction
from tilhero_social.settings import Settings


@dataclass
class SocialTickResult:
    friend_requests_expired: int = 0
    referrals_expired: int = 0
    sanctions_expired: int = 0
    idempotency_purged: int = 0


async def run(rt: Runtime, settings: Settings, now: datetime) -> SocialTickResult:
    out = SocialTickResult()
    ttl = timedelta(days=settings.friend_request_ttl_days)
    async with rt.transaction() as session:
        res = await session.execute(
            update(FriendRequest).where(FriendRequest.status == "pending", FriendRequest.created_at <= now - ttl)
            .values(status="expired", decided_at=FriendRequest.created_at + ttl).returning(FriendRequest.request_id))
        out.friend_requests_expired = len(res.all())
    batch = settings.tick_batch_size
    while True:
        async with rt.transaction() as session:
            n = await referrals.expire_due(session, now, batch)
        out.referrals_expired += n
        if n < batch:
            break
    while True:
        async with rt.transaction() as session:
            rows = (await session.execute(
                select(Sanction).where(Sanction.kind == "social_ban", Sanction.revoked_at.is_(None),
                                       Sanction.expired_at.is_(None), Sanction.until.is_not(None),
                                       Sanction.until <= now)
                .order_by(Sanction.until).limit(batch).with_for_update(skip_locked=True)
                .execution_options(populate_existing=True))).scalars().all()
            for s in rows:
                s.expired_at = now
                await emit_event(session, SANCTION_CHANGED, {
                    "user_id": str(s.user_id), "sanction_id": str(s.sanction_id), "kind": s.kind,
                    "until": iso(s.until), "active": False, "change": "expired",
                    "changed_at": iso(min(s.until or now, now))})
            await session.flush()
        out.sanctions_expired += len(rows)
        if len(rows) < batch:
            break
    async with rt.transaction() as session:
        res = await session.execute(delete(LearnerIdempotency).where(
            LearnerIdempotency.created_at < now - timedelta(days=settings.idempotency_days))
            .returning(LearnerIdempotency.key))
        out.idempotency_purged = len(res.all())
    return out
