"""«Что нового» в центре уведомлений (experience.release_note.published.v1 → только центр, категория product).

В событии нет адресатов, а рассылать в Telegram — задача кампаний спринта 2. Поэтому заметка сохраняется один раз
(`broadcasts`), а запись центра ученику создаётся при его чтении центра (`sync`): заметки, полученные после
водяного знака ученика (`inbox_state`), проверяются по политике (статус ACTIVE, категория product включена,
audience existing|all, сегменты age/ui_lang) и записываются как in_app_only. При первом чтении центра знак
ставится на «сейчас» — старые заметки новичку показывает «Что нового», а не центр. Сбой identity-consent не
ломает чтение центра: знак не двигается, попытка повторится при следующем чтении.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, cast

from tilhero_common.app import Runtime
from tilhero_notifications import store
from tilhero_notifications.delivery import DeliveryInfo, get_delivery
from tilhero_notifications.models import Broadcast
from tilhero_notifications.settings import Settings
from tilhero_notifications.templates import TEMPLATES, TextOverride, lang_of

if TYPE_CHECKING:
    from tilhero_notifications.template_versions import ActiveTemplates

log = logging.getLogger("tilhero.notifications.broadcasts")
TEMPLATE = "release_note.published"


def notification_id_for(dedup_key: str) -> uuid.UUID:
    """Детерминированный id записи по ключу дедупликации: повтор события даёт тот же id."""
    return uuid.uuid5(uuid.NAMESPACE_URL, f"tilhero:notifications:{dedup_key}")


def age_group(d: DeliveryInfo) -> str:
    if d.is_kid:
        return "kids"
    if d.age_band == "14-17":
        return "teens"
    return "adults"  # 18+ и возраст ещё не выбран (как BFF для «Что нового»)


def eligible(b: Broadcast, d: DeliveryInfo) -> bool:
    if d.status != "ACTIVE" or "product" not in d.categories or b.audience not in ("existing", "all"):
        return False
    segments = b.segments if isinstance(b.segments, dict) else {}
    ages, langs = segments.get("age"), segments.get("ui_lang")
    if isinstance(ages, list) and ages and age_group(d) not in ages:
        return False
    return not (isinstance(langs, list) and langs and lang_of(d.locale) not in langs)


async def _override(templates: ActiveTemplates | None) -> TextOverride | None:
    if templates is None:
        return None
    try:
        return await templates.get(TEMPLATE)
    except Exception as exc:  # версии недоступны — текст из кода
        log.warning("template versions unavailable, code text used", extra={"error_type": type(exc).__name__})
        return None


async def sync(
    rt: Runtime, user_id: uuid.UUID, now: datetime | None = None, templates: ActiveTemplates | None = None
) -> int:
    """Создать записи центра по новым заметкам «Что нового» (текст — активная версия шаблона, если есть).
    → сколько создано."""
    s = cast(Settings, rt.settings)
    now = now or datetime.now(UTC)
    not_older = now - timedelta(days=s.retention_days)
    async with rt.transaction() as session:
        mark = await store.inbox_watermark(session, user_id)
        if mark is None:
            await store.lock_user(session, user_id)  # не создать состояние параллельно с удалением ученика
            if not await store.is_deleted(session, user_id):
                await store.set_inbox_watermark(session, user_id, now)
            return 0
        latest = await store.latest_broadcast_at(session)
        if latest is None or latest <= mark:
            return 0
        pending = await store.broadcasts_after(session, mark, not_older=not_older)
        if not pending:
            await store.set_inbox_watermark(session, user_id, latest)
            return 0
    try:
        delivery = await get_delivery(rt, prefix=s.redis_key_prefix, ttl=s.delivery_cache_ttl_seconds, user_id=user_id)
    except Exception as exc:
        log.warning("broadcast sync postponed", extra={"error_type": type(exc).__name__})
        return 0
    if delivery is None:
        return 0
    spec = TEMPLATES[TEMPLATE]
    override = await _override(templates)
    created = 0
    async with rt.transaction() as session:
        await store.lock_user(session, user_id)
        if await store.is_deleted(session, user_id):
            return 0
        for b in pending:
            if not eligible(b, delivery):
                continue
            params = {"release_note_id": str(b.broadcast_id), "slug": b.slug}
            rendered = spec.render(delivery.locale, params, override=override)
            dedup = f"release_note:{b.broadcast_id}:{user_id}"
            created += await store.insert_notification(
                session,
                notification_id=notification_id_for(dedup),
                user_id=user_id,
                category=spec.category,
                kind="standard",
                template=TEMPLATE,
                params=None,
                dedup_key=dedup,
                now=now,
                center_only=True,
                telegram_status="in_app_only",
                reason="center_only",
                title=rendered.title,
                body=rendered.body,
                startapp=rendered.startapp,
            )
        await store.set_inbox_watermark(session, user_id, max(b.received_at for b in pending))
    return created
