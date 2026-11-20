"""API ученика (`/internal/v1/game/*`, вызывающий — только telegram-bff; ученик — claim `lrn`, полоса — `age_band`).
Формы — bff.ts «Спринт 6». Клиент не задаёт ни сумм, ни причин начислений: всё начисляется по событиям занятий.
Удалённый ученик — 410 USER_DELETED. Картинки — только опубликованные, неизменяемые по sha256 (§1.12)."""

from __future__ import annotations

import uuid
from typing import Any, Literal

from fastapi import APIRouter, Depends, Header, Path, Query, Request, Response
from fastapi.responses import JSONResponse

from tilhero_common.app import Runtime, get_runtime
from tilhero_common.internal_auth import Principal
from tilhero_gamification.api.common import (
    LearnerRef,
    client_auth,
    current_learner,
    idempotency_key,
    learner_read,
    learner_turn,
)
from tilhero_gamification.domain import assets, heroes, quests, shop, views
from tilhero_gamification.schemas import EquipmentIn, PurchaseIn, SelectHeroIn, SettingsPatch

router = APIRouter(prefix="/internal/v1/game", tags=["learner"])

_AUTH: dict[int | str, dict[str, Any]] = {401: {"description": "INTERNAL_TOKEN_*"},
                                          403: {"description": "CALLER_NOT_ALLOWED"},
                                          410: {"description": "USER_DELETED"}}
IMMUTABLE_CACHE = "public, max-age=31536000, immutable"


@router.get("/summary", responses=_AUTH)
async def summary(request: Request, ref: LearnerRef = Depends(current_learner),
                  rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """GameSummary: уровень, XP, тилы, заморозки, герой, задания дня (выпускаются при первом запросе дня), события,
    экипировка, настройки, purchase_available: false."""
    async with rt.transaction() as db:
        turn = await learner_read(db, request, ref, quests=True)
        return await views.summary(db, turn)


@router.get("/heroes", responses=_AUTH)
async def list_heroes(request: Request, ref: LearnerRef = Depends(current_learner),
                      rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """{items: HeroView[], selected, stage}; детям первыми — дракончики."""
    async with rt.transaction() as db:
        turn = await learner_read(db, request, ref)
        return await heroes.learner_list(db, turn)


@router.put("/hero", responses={**_AUTH, 404: {"description": "HERO_NOT_FOUND"},
                                409: {"description": "HERO_NOT_AVAILABLE"}})
async def select_hero(body: SelectHeroIn, request: Request, ref: LearnerRef = Depends(current_learner),
                      rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """Выбор героя → GameSummary. Смена бесплатна: XP, уровень и ступень сохраняются."""
    async with rt.transaction() as db:
        turn = await learner_turn(db, request, ref)
        await heroes.select_hero(db, turn, body.hero_code)
        return await views.summary(db, turn)


@router.get("/quests", responses=_AUTH)
async def daily_quests(request: Request, ref: LearnerRef = Depends(current_learner),
                       rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """DailyQuests (скрыты — items пусто)."""
    async with rt.transaction() as db:
        turn = await learner_read(db, request, ref, quests=True)
        return await quests.daily_view(turn)


@router.get("/badges", responses=_AUTH)
async def badge_list(request: Request, ref: LearnerRef = Depends(current_learner),
                     rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """{items: BadgeView[]} — выданные первыми (основание), затем невыданные (прогресс)."""
    async with rt.transaction() as db:
        turn = await learner_read(db, request, ref)
        return await views.badge_list(db, turn)


@router.get("/shop", responses=_AUTH)
async def shop_view(request: Request, ref: LearnerRef = Depends(current_learner),
                    rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """{items: ShopItemView[], til_balance, freeze_stock, freeze_max}."""
    async with rt.transaction() as db:
        turn = await learner_read(db, request, ref)
        return await shop.shop_view(db, turn)


@router.post("/purchases", status_code=201, responses={
    **_AUTH, 400: {"description": "IDEMPOTENCY_KEY_REQUIRED"}, 404: {"description": "ITEM_NOT_FOUND"},
    409: {"description": "INSUFFICIENT_TILS {price, balance, missing, purchase_available} | ALREADY_OWNED | "
                         "FREEZE_STOCK_FULL {max}"},
    410: {"description": "ITEM_NOT_AVAILABLE | USER_DELETED"},
    422: {"description": "IDEMPOTENCY_KEY_REUSED | IDEMPOTENCY_KEY_INVALID"}})
async def purchase(body: PurchaseIn, request: Request, key: str | None = Header(default=None, alias="Idempotency-Key"),
                   ref: LearnerRef = Depends(current_learner), rt: Runtime = Depends(get_runtime)) -> JSONResponse:
    """Покупка за тилы → PurchaseResult: 201 — новая, 200 — повтор ключа (тот же ответ, без новых операций)."""
    k = idempotency_key(key)
    async with rt.transaction() as db:
        turn = await learner_turn(db, request, ref)
        status, out = await shop.purchase(db, turn, body.item_code, k)
    return JSONResponse(out, status_code=status)


@router.put("/equipment", responses={**_AUTH, 409: {"description": "NOT_OWNED"}})
async def equipment(body: EquipmentIn, request: Request, ref: LearnerRef = Depends(current_learner),
                    rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """Экипировка (свои купленные предметы нужного вида; null — снять) → GameSummary."""
    async with rt.transaction() as db:
        turn = await learner_turn(db, request, ref)
        await shop.equip(db, turn, body.background_code, body.frame_code)
        return await views.summary(db, turn)


@router.get("/history", responses={**_AUTH, 400: {"description": "INVALID_CURSOR"}})
async def history(request: Request, currency: Literal["xp", "til", "freeze"] | None = Query(default=None),
                  cursor: str | None = Query(default=None, max_length=300),
                  limit: int = Query(default=30, ge=1, le=100),
                  ref: LearnerRef = Depends(current_learner), rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """Page<GameOperation>: новые сверху; ручные операции — reason manual, без комментария сотрудника."""
    async with rt.transaction() as db:
        turn = await learner_read(db, request, ref)
        return await views.history(db, turn, currency, cursor, limit)


@router.get("/rewards", responses=_AUTH)
async def rewards(request: Request, source_session_id: uuid.UUID = Query(...),
                  ref: LearnerRef = Depends(current_learner), rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """SessionRewards: pending | ready | none (чужая сессия — none, без 403)."""
    async with rt.transaction() as db:
        turn = await learner_read(db, request, ref)
        return await views.rewards(db, turn, source_session_id)


@router.get("/settings", responses=_AUTH)
async def get_settings(request: Request, ref: LearnerRef = Depends(current_learner),
                       rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    async with rt.transaction() as db:
        turn = await learner_read(db, request, ref)
        return views.settings_view(turn)


@router.patch("/settings", responses=_AUTH)
async def patch_settings(body: SettingsPatch, request: Request, ref: LearnerRef = Depends(current_learner),
                         rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """Partial<GameSettings> → GameSettings."""
    async with rt.transaction() as db:
        turn = await learner_turn(db, request, ref)
        views.apply_settings(turn, {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None})
        return views.settings_view(turn)


@router.get("/assets/{asset_id}", responses={**_AUTH, 304: {"description": "If-None-Match совпал"},
                                             404: {"description": "ASSET_NOT_FOUND"}})
async def asset_content(request: Request, asset_id: uuid.UUID = Path(...),
                        _: Principal = Depends(client_auth), rt: Runtime = Depends(get_runtime)) -> Response:
    """Байты опубликованной картинки: ETag = sha256, `Cache-Control: public, max-age=31536000, immutable`.
    Неопубликованная (черновик, неиспользуемая) — 404."""
    async with rt.transaction() as db:
        if not await assets.is_published(db, asset_id):
            raise assets.asset_not_found()
        data, mime, sha = await assets.content(db, asset_id)
    etag = f'"{sha}"'
    headers = {"ETag": etag, "Cache-Control": IMMUTABLE_CACHE}
    inm = request.headers.get("if-none-match")
    if inm is not None and etag in [t.strip() for t in inm.split(",")]:
        return Response(status_code=304, headers=headers)
    return Response(data, media_type=mime, headers=headers)
