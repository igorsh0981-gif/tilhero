"""Картинки (§1.1 assets, §1.12): webp | png ≤ 300 КБ и ≤ 1024×1024, формат — по сигнатуре байтов, размеры — по
заголовку (images.py). Та же картинка (sha256) того же назначения — тот же asset_id. Картинки не изменяются.
Ученику выдаются только используемые в опубликованном: живые ступени героев, предметы магазина в продаже и снятые
с продажи (купленное не отбирается), значки."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.errors import ApiError, not_found, unprocessable
from tilhero_common.internal_auth import Actor
from tilhero_gamification.domain.common import emit_audit
from tilhero_gamification.images import ImageInvalid, inspect_image
from tilhero_gamification.models import Asset, BadgeTemplate, Hero, ShopItem


def asset_not_found() -> ApiError:
    return not_found("ASSET_NOT_FOUND", "Картинка не найдена")


def asset_invalid(reason: str) -> ApiError:
    return unprocessable("ASSET_INVALID", "Картинка не подходит: нужен webp или png до 1024×1024", {"reason": reason})


def asset_too_large(limit: int) -> ApiError:
    return ApiError(413, "ASSET_TOO_LARGE", "Картинка больше допустимого размера", {"max_bytes": limit})


def learner_image(a: Asset) -> dict[str, Any]:
    """GameImage (bff.ts): url — публичный путь telegram-bff с sha256 (неизменяемая ссылка); sha256 — для BFF,
    который собирает url сам (в ответ Mini App не уходит)."""
    return {"asset_id": str(a.asset_id), "url": f"/v1/game/assets/{a.asset_id}/{a.sha256}", "sha256": a.sha256,
            "width": a.width, "height": a.height}


def admin_image(a: Asset) -> dict[str, Any]:
    """AdminGameImage (admin.ts)."""
    return {"asset_id": str(a.asset_id), "sha256": a.sha256, "url": f"/admin/v1/game/assets/{a.asset_id}/content",
            "width": a.width, "height": a.height, "size": a.size}


async def meta(session: AsyncSession, ids: list[uuid.UUID]) -> dict[uuid.UUID, Asset]:
    """Метаданные без байтов."""
    if not ids:
        return {}
    rows = (await session.execute(select(Asset.asset_id, Asset.sha256, Asset.mime, Asset.width, Asset.height,
                                         Asset.size, Asset.purpose, Asset.uploaded_by, Asset.created_at)
                                  .where(Asset.asset_id.in_(set(ids))))).all()
    out: dict[uuid.UUID, Asset] = {}
    for r in rows:
        out[r.asset_id] = Asset(asset_id=r.asset_id, sha256=r.sha256, mime=r.mime, width=r.width, height=r.height,
                                size=r.size, purpose=r.purpose, uploaded_by=r.uploaded_by, created_at=r.created_at)
    return out


async def learner_images(session: AsyncSession, ids: list[uuid.UUID]) -> dict[uuid.UUID, dict[str, Any]]:
    return {k: learner_image(v) for k, v in (await meta(session, ids)).items()}


async def admin_images(session: AsyncSession, ids: list[uuid.UUID]) -> dict[uuid.UUID, dict[str, Any]]:
    return {k: admin_image(v) for k, v in (await meta(session, ids)).items()}


async def upload(session: AsyncSession, actor: Actor, data: bytes, content_type: str | None, purpose: str,
                 now: datetime, *, max_bytes: int, max_px: int) -> tuple[dict[str, Any], bool]:
    """→ (AdminGameImage, создана ли новая). Повтор той же картинки — существующий asset_id без аудита."""
    if len(data) > max_bytes:
        raise asset_too_large(max_bytes)
    declared = (content_type or "").split(";")[0].strip().lower()
    if declared not in ("image/webp", "image/png"):
        raise asset_invalid("content_type")
    try:
        info = inspect_image(data, declared, max_px=max_px)
    except ImageInvalid as exc:
        raise asset_invalid(exc.reason) from None
    asset_id = uuid.uuid4()
    inserted = (await session.execute(insert(Asset).values(
        asset_id=asset_id, sha256=info.sha256, mime=info.mime, data=data, width=info.width, height=info.height,
        size=info.size, purpose=purpose, uploaded_by=actor.id[:64], created_at=now,
    ).on_conflict_do_nothing(index_elements=["sha256", "purpose"]).returning(Asset.asset_id))).scalar()
    if inserted is None:
        existing = (await session.execute(select(Asset.asset_id).where(
            Asset.sha256 == info.sha256, Asset.purpose == purpose))).scalar_one()
        return admin_image((await meta(session, [existing]))[existing]), False
    await emit_audit(session, actor, "game.asset.uploaded", "game_asset", str(asset_id),
                     after={"sha256": info.sha256, "purpose": purpose, "mime": info.mime, "width": info.width,
                            "height": info.height, "size": info.size})
    return admin_image((await meta(session, [asset_id]))[asset_id]), True


async def admin_meta(session: AsyncSession, asset_id: uuid.UUID) -> dict[str, Any]:
    found = (await meta(session, [asset_id])).get(asset_id)
    if found is None:
        raise asset_not_found()
    return {**admin_image(found), "mime": found.mime, "purpose": found.purpose}


async def content(session: AsyncSession, asset_id: uuid.UUID) -> tuple[bytes, str, str]:
    row = (await session.execute(select(Asset.data, Asset.mime, Asset.sha256).where(Asset.asset_id == asset_id))
           ).first()
    if row is None:
        raise asset_not_found()
    return bytes(row.data), row.mime, row.sha256


async def published_ids(session: AsyncSession) -> set[uuid.UUID]:
    """Картинки, используемые в опубликованном (без черновиков)."""
    out: set[uuid.UUID] = set()
    for stages in (await session.execute(select(Hero.stages).where(Hero.published_at.is_not(None)))).scalars():
        for s in stages or []:
            try:
                out.add(uuid.UUID(str(s.get("asset_id"))))
            except ValueError:
                continue
    out.update(a for a in (await session.execute(select(ShopItem.asset_id).where(
        ShopItem.status.in_(("published", "retired")), ShopItem.asset_id.is_not(None)))).scalars() if a)
    out.update(a for a in (await session.execute(select(BadgeTemplate.asset_id).where(
        BadgeTemplate.asset_id.is_not(None)))).scalars() if a)
    return out


async def is_published(session: AsyncSession, asset_id: uuid.UUID) -> bool:
    return asset_id in await published_ids(session)
