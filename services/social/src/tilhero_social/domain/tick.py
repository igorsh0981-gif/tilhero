"""invites:tick (n8n, каждый час): истёкшие → expired; открытые ≥ 24 ч назад без ответа → одно напоминание
получателю (social.invite.reminder_due.v1, AT-10) — только тому, кто сейчас может принять приглашение (QA D-02,
ревью P-5).

«Может принять» — те же правила, что `can_accept` в карточке (`preview_reason is None`): получатель — активный
аккаунт 14+ (подросток — с согласием родителя), не в семье (семейное), семья не заполнена, не друзья, реферал
ещё не использован; и, как для просмотра карточки, есть действующее согласие с политикой (`consent_accepted`).
Профили получателей — из identity-consent `/users/{id}/public` вне транзакций БД (по одному запросу на получателя,
не больше IDENTITY_CONCURRENCY одновременно). identity-consent недоступен или пользователь не найден — без
напоминания в этот раз.

Кто сейчас принять не может — без напоминания и без отметки: строка проверяется в следующих tick, пока открытие не
старше REMINDER_MAX_AGE_DAYS (подросток получил согласие родителя — напоминание придёт). Поэтому кандидаты
просматриваются целиком (ключ — opened_at, invite_id, invitee_user_id), а не первые N: отложенные строки не
вытесняют остальные.

Идемпотентность: reminded_at ставится в той же транзакции, что и событие в outbox; строки берутся
FOR UPDATE SKIP LOCKED с повторной проверкой условий — параллельные запуски не напоминают дважды. Открытые раньше
REMINDER_MAX_AGE_DAYS не напоминаются (после простоя или для старых реферальных ссылок без срока).
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Final

from sqlalchemy import or_, select, tuple_, update

from tilhero_common.app import Runtime
from tilhero_common.errors import ApiError
from tilhero_common.messaging import emit
from tilhero_social.domain import invites as inv
from tilhero_social.identity import IdentityGateway, PublicProfile
from tilhero_social.models import Invite, InviteRedemption

REMINDER_DUE = "social.invite.reminder_due.v1"
IDENTITY_CONCURRENCY: Final = 8

log = logging.getLogger("tilhero.social.tick")


@dataclass
class TickResult:
    reminders: int = 0
    expired: int = 0
    # не напомнили: сейчас принять не может или профиль недоступен (проверим в следующий tick)
    deferred: int = 0


def _pending(now: datetime, remind_after: timedelta, max_age: timedelta) -> list[Any]:
    r, i = InviteRedemption, Invite
    return [r.accepted_at.is_(None), r.declined_at.is_(None), r.reminded_at.is_(None),
            r.opened_at <= now - remind_after, r.opened_at > now - max_age,
            i.status == "active", or_(i.expires_at.is_(None), i.expires_at > now)]


async def _profiles(gateway: IdentityGateway, users: Sequence[uuid.UUID]) -> dict[uuid.UUID, PublicProfile | None]:
    """Профили получателей; None — не найден или identity-consent недоступен (без напоминания в этот раз)."""
    sem = asyncio.Semaphore(IDENTITY_CONCURRENCY)
    failed = 0

    async def one(user: uuid.UUID) -> PublicProfile | None:
        nonlocal failed
        async with sem:
            try:
                return await gateway.public(user)
            except ApiError:
                failed += 1
                return None

    found = await asyncio.gather(*(one(u) for u in users))
    if failed:
        log.warning("invites:tick: identity-consent unavailable for some invitees, reminders deferred",
                    extra={"count": failed})
    return dict(zip(users, found, strict=True))


async def run_tick(rt: Runtime, gateway: IdentityGateway, *, clock: Callable[[], datetime], producer: str,
                   remind_after: timedelta, max_age: timedelta, batch_size: int, family_max: int) -> TickResult:
    now = clock()
    result = TickResult()
    async with rt.transaction() as session:
        expired = await session.execute(
            update(Invite)
            .where(Invite.status == "active", Invite.expires_at.is_not(None), Invite.expires_at <= now)
            .values(status="expired", updated_at=now)
            .returning(Invite.invite_id)
        )
        result.expired = len(expired.all())

    r, i = InviteRedemption, Invite
    key = (r.opened_at, r.invite_id, r.invitee_user_id)
    after: tuple[datetime, uuid.UUID, uuid.UUID] | None = None
    while True:
        stmt = (select(*key).join(i, i.invite_id == r.invite_id)
                .where(*_pending(now, remind_after, max_age)).order_by(*key).limit(batch_size))
        if after is not None:
            stmt = stmt.where(tuple_(*key) > tuple_(*after))
        async with rt.transaction() as session:
            page = [(o, iid, u) for o, iid, u in (await session.execute(stmt)).all()]
        if not page:
            break
        profiles = await _profiles(gateway, list(dict.fromkeys(u for _, _, u in page)))
        await _remind_page(rt, page, profiles, now=now, producer=producer, remind_after=remind_after,
                           max_age=max_age, family_max=family_max, result=result)
        if len(page) < batch_size:
            break
        after = page[-1]
    return result


async def _remind_page(rt: Runtime, page: Sequence[tuple[datetime, uuid.UUID, uuid.UUID]],
                       profiles: dict[uuid.UUID, PublicProfile | None], *, now: datetime, producer: str,
                       remind_after: timedelta, max_age: timedelta, family_max: int, result: TickResult) -> None:
    r, i = InviteRedemption, Invite
    pairs = [(iid, u) for _, iid, u in page]
    async with rt.transaction() as session:
        rows = (await session.execute(
            select(r, i)
            .join(i, i.invite_id == r.invite_id)
            .where(tuple_(r.invite_id, r.invitee_user_id).in_(pairs), *_pending(now, remind_after, max_age))
            .order_by(r.opened_at, r.invite_id, r.invitee_user_id)
            .with_for_update(of=r, skip_locked=True)
        )).all()
        for red, invite in rows:
            me = red.invitee_user_id
            person = await inv.person_for(session, me, profiles.get(me))
            if person is None or not person.consent_accepted:
                result.deferred += 1
                continue
            facts = await inv.viewer_facts(session, invite, me, family_max)
            if inv.preview_reason(invite, me, person, facts, now) is not None:
                result.deferred += 1
                continue
            red.reminded_at = now
            await emit(session, REMINDER_DUE, {
                "invite_id": str(red.invite_id), "inviter_user_id": str(invite.inviter_user_id),
                "invitee_user_id": str(me), "kind": invite.kind,
            }, producer=producer)
            result.reminders += 1
        await session.flush()

