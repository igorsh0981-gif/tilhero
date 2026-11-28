"""Стенд dev/test (INTERNAL_API §1.2, PLAN решение 21): при старте сервиса, если активного каталога нет, черновик
(каталог v1 из миграции) получает тестовые цены в Stars и активируется системным seed (аудит `actor_type system`).
В stage/prod ничего не делает — каталог активирует только сотрудник (цены Stars — О1, реквизиты сайта — О4).

Тестовые цены — заведомо условные (не рекомендация финансам): подписка 30 дней — нативная подписка Stars (≤ 10 000)."""

from __future__ import annotations

import copy
import logging
from typing import Any, Final

from sqlalchemy import select

from tilhero_billing.domain import catalog
from tilhero_billing.domain.common import canonical_hash, now_of
from tilhero_billing.models import CatalogVersion
from tilhero_billing.settings import Settings
from tilhero_common.app import Runtime

log = logging.getLogger("tilhero.billing.stand")

TEST_STARS_PRICES: Final[dict[str, int]] = {"plus_30d": 250, "plus_90d": 650, "til_100": 15, "til_550": 75,
                                             "til_1200": 150}
SEED_COMMENT: Final = "Стенд dev/test: тестовые цены в Stars (системный seed)"


def with_test_prices(payload: dict[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(payload)
    for product in out.get("products") or []:
        if isinstance(product, dict) and product.get("price_stars") is None \
                and product.get("code") in TEST_STARS_PRICES:
            product["price_stars"] = TEST_STARS_PRICES[str(product["code"])]
    return out


async def seed(rt: Runtime) -> bool:
    """→ True — каталог активирован сейчас."""
    settings: Settings = rt.settings  # type: ignore[assignment]
    if settings.is_secure_env or not settings.stand_catalog_on_start:
        return False
    now = now_of(rt)
    async with rt.transaction() as db:
        if await db.scalar(select(CatalogVersion.version).where(CatalogVersion.status == "active")) is not None:
            return False
        draft = await db.scalar(select(CatalogVersion).where(CatalogVersion.status == "draft").with_for_update())
        if draft is None:
            return False
        payload = with_test_prices(dict(draft.payload))
        errors, _ = catalog.validate(payload, settings)
        if errors:
            log.warning("stand catalog invalid", extra={"code": "STAND_CATALOG_INVALID", "errors": len(errors)})
            return False
        h = canonical_hash(payload)
        draft.payload, draft.payload_hash, draft.validated_hash, draft.updated_at = payload, h, h, now
        await db.flush()
        await catalog._activate(db, draft, None, now, SEED_COMMENT, action="billing.catalog_activated")
    log.info("stand catalog activated", extra={"version": draft.version})
    return True


async def on_start(rt: Runtime) -> None:
    try:
        await seed(rt)
    except Exception as exc:  # стенд не должен ронять старт
        log.warning("stand catalog seed failed", extra={"error_type": type(exc).__name__})
