"""Дайджест (спринт 6, docs/sprint6/INTERNAL_API.md §5).

kind=digest (watch.price_drop, news.digest) не отправляется по одному: пункты копятся в digest_queue и раз в день
в digest_time пользователя (локальное время, timezone из identity-consent) собираются в одно сообщение
digest.daily с секциями «Слежения» и «Новости», не больше 10 пунктов; пусто — ничего не отправляется.

Запуск — POST /internal/v1/notifications:digest (n8n каждые 15 мин, SCHEDULER_TOKEN). Идемпотентность —
один дайджест на пользователя в локальный день: notification_id = uuid5(«digest.daily:<user>:<дата>»),
dedup_key UNIQUE в журнале; пункты захватываются FOR UPDATE под advisory-блокировкой пользователя, поэтому
повтор прогона и две реплики не дают второго сообщения. Дальше дайджест — обычное уведомление журнала:
тихие часы (отложить до конца), выключенные уведомления (skipped), повторы доставки — общий планировщик.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from typing import Any, cast
from zoneinfo import ZoneInfo

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.app import Runtime
from tilhero_notifications import store
from tilhero_notifications.delivery import get_delivery
from tilhero_notifications.dispatcher import Dispatcher
from tilhero_notifications.policy import parse_hhmm, zone
from tilhero_notifications.settings import Settings
from tilhero_notifications.templates import (
    DIGEST_MAX_ITEMS,
    TEMPLATES,
    DigestDailyParams,
    NewsDigestParams,
    PriceDropParams,
    TemplateError,
)

log = logging.getLogger("tilhero.notifications.digest")

DIGEST_TEMPLATE = "digest.daily"


# ---------------------------------------------------------------- чистые функции


def digest_slot(
    now: datetime, digest_time: time, tz: ZoneInfo, window: timedelta
) -> tuple[date | None, datetime]:
    """→ (локальная дата дайджеста, если `now` в окне [digest_time, digest_time + window); иначе None,
    ближайший будущий момент digest_time в UTC). Окно может переходить через полночь (23:30 + 2 ч)."""
    local_date = now.astimezone(tz).date()
    for day in (local_date - timedelta(days=1), local_date):
        start = datetime.combine(day, digest_time, tzinfo=tz).astimezone(UTC)
        if start <= now < start + window:
            nxt = datetime.combine(day + timedelta(days=1), digest_time, tzinfo=tz).astimezone(UTC)
            return day, nxt
    today = datetime.combine(local_date, digest_time, tzinfo=tz).astimezone(UTC)
    if now < today:
        return None, today
    return None, datetime.combine(local_date + timedelta(days=1), digest_time, tzinfo=tz).astimezone(UTC)


def user_digest_time(value: str | None, default: str) -> time:
    for candidate in (value, default, "09:00"):
        try:
            return parse_hhmm(candidate or "")
        except ValueError:
            continue
    return time(9, 0)


def digest_ids(user_id: uuid.UUID, day: date) -> tuple[uuid.UUID, str]:
    key = f"{DIGEST_TEMPLATE}:{user_id}:{day.isoformat()}"
    return uuid.uuid5(uuid.NAMESPACE_URL, f"tilhero:{key}"), key


def split_quota(n_watch: int, n_news: int, limit: int = DIGEST_MAX_ITEMS) -> tuple[int, int]:
    """Сколько пунктов каждой секции показать: обе секции, если есть, получают не меньше половины лимита,
    свободное место отдаётся другой секции."""
    half = limit // 2
    w = min(n_watch, max(limit - n_news, half))
    return w, min(n_news, limit - w)


def compose(items: list[store.PendingItem], day: date, limit: int = DIGEST_MAX_ITEMS) -> dict[str, Any] | None:
    """Пункты очереди → params digest.daily (None — показать нечего).

    Слежения: снижения цены одного события за период сливаются в один пункт (последняя цена, сумма снижений —
    базы детектора идут цепочкой), по убыванию снижения. Новости: новые сверху, без повторов (news_id/URL)."""
    drops: dict[uuid.UUID, dict[str, Any]] = {}
    news: list[dict[str, Any]] = []
    seen: set[str] = set()
    ordered = sorted(items, key=lambda i: (i.created_at, str(i.item_id)))
    for it in ordered:  # старые → новые: последняя цена побеждает
        if it.section != "watch":
            continue
        try:
            p = PriceDropParams.model_validate(it.params or {})
        except ValueError:
            log.warning("digest item skipped: invalid params", extra={"template": it.template})
            continue
        cur = drops.get(p.event_id)
        drops[p.event_id] = {
            "event_id": p.event_id,
            "event_title": p.event_title,
            "tier": p.tier,
            "price_usd": p.price_usd,
            "drop_usd": p.drop_usd + (cur["drop_usd"] if cur else Decimal(0)),
        }
    for it in reversed(ordered):  # новые сверху, внутри запроса — порядок издателя
        if it.section != "news":
            continue
        try:
            entries = NewsDigestParams.model_validate(it.params or {}).items
        except ValueError:
            log.warning("digest item skipped: invalid params", extra={"template": it.template})
            continue
        for entry in entries:
            key = str(entry.news_id) if entry.news_id else entry.source.url
            if key not in seen:
                seen.add(key)
                news.append(entry.model_dump(mode="json", exclude_none=True))
    watch = sorted(drops.values(), key=lambda d: d["drop_usd"], reverse=True)
    w, n = split_quota(len(watch), len(news), limit)
    if w + n == 0:
        return None
    params = DigestDailyParams(
        date=day,
        watch=watch[:w],  # type: ignore[arg-type]
        news=news[:n],  # type: ignore[arg-type]
        more=len(watch) + len(news) - w - n,
    )
    return params.model_dump(mode="json", exclude_none=True)


# ---------------------------------------------------------------- прогон


@dataclass
class DigestResult:
    users: int = 0
    digests: int = 0
    items: int = 0
    postponed: int = 0
    errors: int = 0


class DigestRunner:
    def __init__(self, runtime: Runtime, dispatcher: Dispatcher) -> None:
        self.rt = runtime
        self.dispatcher = dispatcher
        self._lock = asyncio.Lock()  # один прогон на процесс; между репликами — блокировки БД

    @property
    def settings(self) -> Settings:
        return cast(Settings, self.rt.settings)

    def _wake_after_commit(self, session: AsyncSession) -> None:
        event.listen(session.sync_session, "after_commit", lambda _s: self.dispatcher.wake(), once=True)

    async def run(self, now: datetime | None = None) -> DigestResult:
        s = self.settings
        now = now or datetime.now(UTC)
        result = DigestResult()
        async with self._lock:
            async with self.rt.transaction() as session:
                users = await store.digest_due_users(session, now=now, batch=s.digest_batch_users)
            result.users = len(users)
            semaphore = asyncio.Semaphore(s.digest_concurrency)

            async def one(user_id: uuid.UUID) -> None:
                async with semaphore:
                    try:
                        await self._user(user_id, now, result)
                    except Exception as exc:  # пользователь попадёт в следующий прогон
                        result.errors += 1
                        log.error("digest user failed", extra={"error_type": type(exc).__name__})

            await asyncio.gather(*(one(u) for u in users))
            async with self.rt.transaction() as session:
                await store.purge_consumed_digest(session, before=now - timedelta(days=s.digest_retention_days))
        log.info(
            "digest run",
            extra={"users": result.users, "digests": result.digests, "postponed": result.postponed,
                   "errors": result.errors},
        )
        return result

    async def _user(self, user_id: uuid.UUID, now: datetime, result: DigestResult) -> None:
        s = self.settings
        try:
            delivery = await get_delivery(
                self.rt, prefix=s.redis_key_prefix, ttl=s.delivery_cache_ttl_seconds, user_id=user_id
            )
        except Exception as exc:
            result.errors += 1
            log.warning("digest: delivery info unavailable", extra={"error_type": type(exc).__name__})
            return
        recheck = now + timedelta(minutes=s.digest_recheck_minutes)
        async with self.rt.transaction() as session:
            await store.lock_user(session, user_id)
            if delivery is None or await store.is_deleted(session, user_id):
                await store.drop_pending_digest(session, user_id)  # пользователя нет — копить незачем
                return
            tz = zone(delivery.timezone, s.default_timezone)
            at = user_digest_time(delivery.digest_time, s.digest_default_time)
            day, next_at = digest_slot(now, at, tz, timedelta(minutes=s.digest_window_minutes))
            if day is None:
                await store.postpone_digest(session, user_id, min(next_at, recheck))
                result.postponed += 1
                return
            digest_id, dedup_key = digest_ids(user_id, day)
            if await store.notification_exists(session, digest_id):
                # Дайджест за этот день уже собран (повтор прогона, другая реплика) — новые пункты ждут завтра
                await store.postpone_digest(session, user_id, min(next_at, recheck))
                result.postponed += 1
                return
            items = await store.pending_digest_items(session, user_id)
            if not items:
                return
            params = compose(items, day, s.digest_max_items)
            ids = [i.item_id for i in items]
            if params is None:  # пусто — не отправляем; невалидные пункты не копим
                await store.consume_digest_items(session, ids, digest_id=digest_id, now=now)
                return
            try:
                TEMPLATES[DIGEST_TEMPLATE].validate(params)
            except TemplateError:
                log.error("digest params invalid")
                result.errors += 1
                return
            inserted = await store.insert_notification(
                session,
                notification_id=digest_id,
                user_id=user_id,
                kind="digest",
                template=DIGEST_TEMPLATE,
                params=params,
                startapp=None,
                dedup_key=dedup_key,
                source_event_id=None,
                now=now,
            )
            if not inserted:
                await store.postpone_digest(session, user_id, min(next_at, recheck))
                result.postponed += 1
                return
            await store.consume_digest_items(session, ids, digest_id=digest_id, now=now)
            self._wake_after_commit(session)
            result.digests += 1
            result.items += len(params.get("watch", [])) + len(params.get("news", []))
