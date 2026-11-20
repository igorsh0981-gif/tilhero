"""Админ-API игры (`/internal/v1/admin/game/*`, §1.11; вызывающий — только admin-bff с actor). Права проверяются
здесь по actor (защита в глубину): game.read — чтение; game.manage — черновики правил, герои, картинки, магазин,
события; game.publish + step-up — активация и откат правил, публикация героев, предметов и событий; wallet.adjust
+ step-up — ручные операции, обратные записи, возвраты. Каждая команда — аудит admin.audit.recorded.v1."""

from __future__ import annotations

import uuid
from typing import Any, Literal

from fastapi import APIRouter, Body, Depends, Header, Query, Request, Response
from fastapi.responses import JSONResponse

from tilhero_common.app import Runtime, get_runtime
from tilhero_common.internal_auth import Principal
from tilhero_gamification.api.common import (
    idempotency_key,
    now,
    require,
    require_any,
    settings_of,
    staff_auth,
    staff_idempotent,
)
from tilhero_gamification.api.upload import upload_of
from tilhero_gamification.domain import admin_rules, assets, game_events, heroes, shop, stats, wallets
from tilhero_gamification.domain.common import DASHBOARD_READ, GAME_MANAGE, GAME_PUBLISH, GAME_READ, WALLET_ADJUST
from tilhero_gamification.domain.rules import active_rules
from tilhero_gamification.schemas import (
    ActivateIn,
    AdjustmentIn,
    CommentIn,
    GameEventIn,
    GameEventPatchIn,
    HeroDraftIn,
    ReasonIn,
    RulesDraftIn,
    ShopItemCreateIn,
    ShopItemPatchIn,
)

router = APIRouter(prefix="/internal/v1/admin/game", tags=["staff"])

_AUTH: dict[int | str, dict[str, Any]] = {
    401: {"description": "INTERNAL_TOKEN_*"},
    403: {"description": "PERMISSION_DENIED | STAFF_CONTEXT_REQUIRED | CALLER_NOT_ALLOWED | STEP_UP_REQUIRED"}}


def _comment(body: CommentIn | None) -> str | None:
    return body.comment if body is not None else None


# ---------------------------------------------------------------- обзор


@router.get("/overview", responses=_AUTH)
async def overview(request: Request, period: Literal["7d", "30d"] = Query(default="7d"),
                   principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """GameOverview: итоги из обезличенной daily_stats, активная версия правил, активные события (game.read или
    dashboard.read — блок главной админки)."""
    require_any(principal, GAME_READ, DASHBOARD_READ)
    async with rt.transaction() as db:
        return await stats.overview(db, period, now(request), settings_of(request).stats_timezone)


# ---------------------------------------------------------------- правила


@router.get("/rules", responses=_AUTH)
async def rules_list(principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """{items: RulesVersionSummary[]} — без payload."""
    require(principal, GAME_READ)
    async with rt.transaction() as db:
        return await admin_rules.list_versions(db)


@router.get("/rules/{version}", responses={**_AUTH, 404: {"description": "RULES_VERSION_NOT_FOUND"}})
async def rules_get(version: int, principal: Principal = Depends(staff_auth),
                    rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """RulesVersion: payload + diff с активной [{path, from, to}]."""
    require(principal, GAME_READ)
    async with rt.transaction() as db:
        return await admin_rules.get_version(db, version)


@router.put("/rules/draft", responses={**_AUTH, 409: {"description": "DRAFT_CONFLICT {updated_at}"},
                                       422: {"description": "RULES_INVALID {errors}"}})
async def rules_put_draft(body: RulesDraftIn, request: Request,
                          if_match: str | None = Header(default=None, alias="If-Match", max_length=64),
                          principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)
                          ) -> dict[str, Any]:
    """Создать или заменить черновик (замена — If-Match: updated_at черновика)."""
    actor = require(principal, GAME_MANAGE)
    async with rt.transaction() as db:
        return await admin_rules.put_draft(db, actor, body.payload, body.comment, body.based_on, if_match,
                                           now(request))


@router.delete("/rules/draft", status_code=204, responses={**_AUTH, 404: {"description": "RULES_DRAFT_NOT_FOUND"}})
async def rules_delete_draft(principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)
                             ) -> Response:
    actor = require(principal, GAME_MANAGE)
    async with rt.transaction() as db:
        await admin_rules.delete_draft(db, actor)
    return Response(status_code=204)


@router.post("/rules/draft/validate", responses={**_AUTH, 404: {"description": "RULES_DRAFT_NOT_FOUND"}})
async def rules_validate(request: Request, principal: Principal = Depends(staff_auth),
                         rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """RulesValidation {ok, errors, warnings}; ok — ставит validated_at."""
    actor = require(principal, GAME_MANAGE)
    async with rt.transaction() as db:
        return await admin_rules.validate_draft(db, actor, now(request))


@router.post("/rules/draft/activate", responses={
    **_AUTH, 404: {"description": "RULES_DRAFT_NOT_FOUND"}, 409: {"description": "RULES_NOT_VALIDATED"},
    422: {"description": "RULES_INVALID | comment < 10"}})
async def rules_activate(body: ActivateIn, request: Request, principal: Principal = Depends(staff_auth),
                         rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """Активация черновика (game.publish + step-up): прежняя → archived, game.rules.activated.v1."""
    actor = require(principal, GAME_PUBLISH, request, step_up=True)
    async with rt.transaction() as db:
        return await admin_rules.activate_draft(db, actor, body.comment, now(request))


@router.post("/rules/{version}/rollback", responses={
    **_AUTH, 404: {"description": "RULES_VERSION_NOT_FOUND"}, 409: {"description": "RULES_STATE (только archived)"}})
async def rules_rollback(version: int, body: ActivateIn, request: Request,
                         principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)
                         ) -> dict[str, Any]:
    """Откат: новая версия n+1 с payload архивной, сразу active."""
    actor = require(principal, GAME_PUBLISH, request, step_up=True)
    async with rt.transaction() as db:
        return await admin_rules.rollback(db, actor, version, body.comment, now(request))


# ---------------------------------------------------------------- герои и картинки


@router.get("/heroes", responses=_AUTH)
async def heroes_list(principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)
                      ) -> dict[str, Any]:
    """{items: AdminHero[]} — живые поля и черновики, число выбравших учеников."""
    require(principal, GAME_READ)
    async with rt.transaction() as db:
        return await heroes.admin_list(db)


@router.put("/heroes/{code}/draft", responses={**_AUTH, 404: {"description": "HERO_NOT_FOUND"},
                                               422: {"description": "ASSET_INVALID {reason: asset}"}})
async def hero_draft(code: str, body: HeroDraftIn, request: Request, principal: Principal = Depends(staff_auth),
                     rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    actor = require(principal, GAME_MANAGE)
    async with rt.transaction() as db:
        return await heroes.put_draft(db, actor, code[:16], body.model_dump(mode="json"), now(request))


@router.post("/heroes/{code}/publish", responses={**_AUTH, 404: {"description": "HERO_NOT_FOUND"},
                                                  409: {"description": "HERO_DRAFT_MISSING"}})
async def hero_publish(code: str, request: Request, body: CommentIn | None = Body(default=None),
                       principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)
                       ) -> dict[str, Any]:
    """Публикация черновика героя (game.publish + step-up): version + 1; картинка ступени меняется без релиза."""
    actor = require(principal, GAME_PUBLISH, request, step_up=True)
    async with rt.transaction() as db:
        return await heroes.publish(db, actor, code[:16], _comment(body), now(request))


@router.post("/assets", status_code=201, responses={
    **_AUTH, 413: {"description": "ASSET_TOO_LARGE"}, 422: {"description": "ASSET_INVALID {reason}"}})
async def asset_upload(request: Request, purpose: Literal["hero_stage", "shop_item", "badge"] = Query(...),
                       principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)
                       ) -> JSONResponse:
    """Тело — байты image/webp | image/png (≤ 300 КБ, ≤ 1024×1024) → AdminGameImage: 201 новая, 200 — та же картинка
    уже есть (тот же asset_id)."""
    actor = require(principal, GAME_MANAGE)
    settings = settings_of(request)
    data, too_large = upload_of(request.scope)
    if too_large:
        raise assets.asset_too_large(settings.asset_max_bytes)
    async with rt.transaction() as db:
        out, created = await assets.upload(db, actor, data, request.headers.get("content-type"), purpose,
                                           now(request), max_bytes=settings.asset_max_bytes,
                                           max_px=settings.asset_max_px)
    return JSONResponse(out, status_code=201 if created else 200)


@router.get("/assets/{asset_id}", responses={**_AUTH, 404: {"description": "ASSET_NOT_FOUND"}})
async def asset_meta(asset_id: uuid.UUID, principal: Principal = Depends(staff_auth),
                     rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """Метаданные картинки (AdminGameImage + mime, purpose)."""
    require(principal, GAME_READ)
    async with rt.transaction() as db:
        return await assets.admin_meta(db, asset_id)


@router.get("/assets/{asset_id}/content", responses={**_AUTH, 404: {"description": "ASSET_NOT_FOUND"}})
async def asset_bytes(asset_id: uuid.UUID, request: Request, principal: Principal = Depends(staff_auth),
                      rt: Runtime = Depends(get_runtime)) -> Response:
    """Байты любой картинки (и черновой) для предпросмотра в админке."""
    require(principal, GAME_READ)
    async with rt.transaction() as db:
        data, mime, sha = await assets.content(db, asset_id)
    etag = f'"{sha}"'
    headers = {"ETag": etag, "Cache-Control": "private, max-age=3600"}
    inm = request.headers.get("if-none-match")
    if inm is not None and etag in [t.strip() for t in inm.split(",")]:
        return Response(status_code=304, headers=headers)
    return Response(data, media_type=mime, headers=headers)


# ---------------------------------------------------------------- магазин


async def _freeze_price(db: Any) -> int:
    return (await active_rules(db)).freeze_price


@router.get("/shop/items", responses=_AUTH)
async def shop_items(principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)
                     ) -> dict[str, Any]:
    require(principal, GAME_READ)
    async with rt.transaction() as db:
        return await shop.admin_list(db, await _freeze_price(db))


@router.post("/shop/items", status_code=201, responses={
    **_AUTH, 400: {"description": "IDEMPOTENCY_KEY_REQUIRED"}, 409: {"description": "ITEM_CODE_TAKEN"},
    422: {"description": "ITEM_INVALID | ASSET_INVALID | IDEMPOTENCY_KEY_REUSED"}})
async def shop_item_create(body: ShopItemCreateIn, request: Request,
                           key: str | None = Header(default=None, alias="Idempotency-Key"),
                           principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)
                           ) -> JSONResponse:
    """Новый предмет (draft); Idempotency-Key — повтор того же сотрудника возвращает тот же ответ."""
    actor = require(principal, GAME_MANAGE)
    k = idempotency_key(key)
    data = body.model_dump()
    data["theme"] = body.theme.model_dump() if body.theme else None
    async with rt.transaction() as db:
        async def run() -> tuple[int, dict[str, Any]]:
            return 201, await shop.create(db, actor, data, now(request), await _freeze_price(db))
        return await staff_idempotent(db, actor, "shop_item_create", k, body.model_dump(mode="json"), run)


@router.patch("/shop/items/{code}", responses={
    **_AUTH, 404: {"description": "ITEM_NOT_FOUND"}, 409: {"description": "ITEM_NOT_EDITABLE {fields}"}})
async def shop_item_patch(code: str, body: ShopItemPatchIn, request: Request,
                          principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)
                          ) -> dict[str, Any]:
    """Черновик — всё; опубликованный и снятый — только available_until и order."""
    actor = require(principal, GAME_MANAGE)
    async with rt.transaction() as db:
        return await shop.patch(db, actor, code[:40], body.changes(), now(request), await _freeze_price(db))


@router.post("/shop/items/{code}/publish", responses={**_AUTH, 404: {"description": "ITEM_NOT_FOUND"},
                                                      409: {"description": "ITEM_STATE"}})
async def shop_item_publish(code: str, request: Request, body: CommentIn | None = Body(default=None),
                            principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)
                            ) -> dict[str, Any]:
    actor = require(principal, GAME_PUBLISH, request, step_up=True)
    async with rt.transaction() as db:
        return await shop.set_status(db, actor, code[:40], "published", _comment(body), now(request),
                                     await _freeze_price(db))


@router.post("/shop/items/{code}/retire", responses={**_AUTH, 404: {"description": "ITEM_NOT_FOUND"},
                                                     409: {"description": "ITEM_STATE"}})
async def shop_item_retire(code: str, request: Request, body: CommentIn | None = Body(default=None),
                           principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)
                           ) -> dict[str, Any]:
    """Снятие с продажи: купленное не отбирается."""
    actor = require(principal, GAME_PUBLISH, request, step_up=True)
    async with rt.transaction() as db:
        return await shop.set_status(db, actor, code[:40], "retired", _comment(body), now(request),
                                     await _freeze_price(db))


# ---------------------------------------------------------------- события недели


@router.get("/events", responses=_AUTH)
async def events_list(status: Literal["draft", "published", "cancelled", "finished"] | None = Query(default=None),
                      principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)
                      ) -> dict[str, Any]:
    require(principal, GAME_READ)
    async with rt.transaction() as db:
        return await game_events.admin_list(db, status)


@router.post("/events", status_code=201, responses={
    **_AUTH, 400: {"description": "IDEMPOTENCY_KEY_REQUIRED"}, 409: {"description": "EVENT_CODE_TAKEN"},
    422: {"description": "EVENT_INVALID {reason} | IDEMPOTENCY_KEY_REUSED"}})
async def event_create(body: GameEventIn, request: Request,
                       key: str | None = Header(default=None, alias="Idempotency-Key"),
                       principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)
                       ) -> JSONResponse:
    actor = require(principal, GAME_MANAGE)
    k = idempotency_key(key)
    async with rt.transaction() as db:
        async def run() -> tuple[int, dict[str, Any]]:
            return 201, await game_events.create(db, actor, body.data(), now(request))
        return await staff_idempotent(db, actor, "event_create", k, body.model_dump(mode="json"), run)


@router.patch("/events/{event_id}", responses={**_AUTH, 404: {"description": "EVENT_NOT_FOUND"},
                                               409: {"description": "EVENT_STATE (только draft)"}})
async def event_patch(event_id: uuid.UUID, body: GameEventPatchIn, request: Request,
                      principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)
                      ) -> dict[str, Any]:
    actor = require(principal, GAME_MANAGE)
    async with rt.transaction() as db:
        return await game_events.patch(db, actor, event_id, body.changes(), now(request))


@router.post("/events/{event_id}/publish", responses={
    **_AUTH, 404: {"description": "EVENT_NOT_FOUND"}, 409: {"description": "EVENT_OVERLAP {event_id} | EVENT_STATE"},
    422: {"description": "EVENT_STARTS_IN_PAST"}})
async def event_publish(event_id: uuid.UUID, request: Request, body: CommentIn | None = Body(default=None),
                        principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)
                        ) -> dict[str, Any]:
    actor = require(principal, GAME_PUBLISH, request, step_up=True)
    async with rt.transaction() as db:
        return await game_events.publish(db, actor, event_id, _comment(body), now(request))


@router.post("/events/{event_id}/cancel", responses={**_AUTH, 404: {"description": "EVENT_NOT_FOUND"},
                                                     409: {"description": "EVENT_STATE"}})
async def event_cancel(event_id: uuid.UUID, request: Request, body: CommentIn | None = Body(default=None),
                       principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)
                       ) -> dict[str, Any]:
    """Отмена: действовавшие начисления не пересчитываются."""
    actor = require(principal, GAME_PUBLISH, request, step_up=True)
    async with rt.transaction() as db:
        return await game_events.cancel(db, actor, event_id, _comment(body), now(request))


# ---------------------------------------------------------------- кошельки


@router.get("/wallets/{user_id}", responses={**_AUTH, 404: {"description": "WALLET_NOT_FOUND"}})
async def wallet(user_id: uuid.UUID, request: Request, principal: Principal = Depends(staff_auth),
                 rt: Runtime = Depends(get_runtime)) -> dict[str, Any]:
    """AdminWallet: баланс, уровень, герой, инвентарь, задания сегодня, значки, рефералы (счётчики)."""
    require(principal, GAME_READ)
    async with rt.transaction() as db:
        return await wallets.wallet_view(db, settings_of(request), user_id, now(request))


@router.get("/wallets/{user_id}/ledger", responses={**_AUTH, 400: {"description": "INVALID_CURSOR"}})
async def wallet_ledger(user_id: uuid.UUID, currency: Literal["xp", "til", "freeze"] | None = Query(default=None),
                        cursor: str | None = Query(default=None, max_length=300),
                        limit: int = Query(default=30, ge=1, le=100),
                        principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)
                        ) -> dict[str, Any]:
    """Page<AdminLedgerOperation> — все поля, включая actor и comment."""
    require(principal, GAME_READ)
    async with rt.transaction() as db:
        rows, nxt = await wallets.page(db, user_id, currency=currency, cursor=cursor, limit=limit)
        return {"items": [wallets.admin_op(op) for op in rows], "next_cursor": nxt}


@router.post("/wallets/{user_id}/adjustments", status_code=201, responses={
    **_AUTH, 400: {"description": "IDEMPOTENCY_KEY_REQUIRED"}, 404: {"description": "WALLET_NOT_FOUND"},
    409: {"description": "BALANCE_NEGATIVE"}, 422: {"description": "amount/reason | IDEMPOTENCY_KEY_REUSED"}})
async def wallet_adjust(user_id: uuid.UUID, body: AdjustmentIn, request: Request,
                        key: str | None = Header(default=None, alias="Idempotency-Key"),
                        principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)
                        ) -> JSONResponse:
    """Ручное начисление или списание (wallet.adjust + step-up) → AdminLedgerOperation."""
    actor = require(principal, WALLET_ADJUST, request, step_up=True)
    k = idempotency_key(key)
    async with rt.transaction() as db:
        async def run() -> tuple[int, dict[str, Any]]:
            return 201, await wallets.adjust(db, settings_of(request), actor, user_id, body.currency, body.amount,
                                             body.reason, k, now(request))
        return await staff_idempotent(db, actor, f"adjust:{user_id}", k, body.model_dump(mode="json"), run)


@router.post("/wallets/{user_id}/ledger/{op_id}/reverse", responses={
    **_AUTH, 404: {"description": "WALLET_NOT_FOUND | OPERATION_NOT_FOUND"},
    409: {"description": "ALREADY_REVERSED | BALANCE_NEGATIVE | OPERATION_NOT_REVERSIBLE"}})
async def wallet_reverse(user_id: uuid.UUID, op_id: uuid.UUID, body: ReasonIn, request: Request,
                         principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)
                         ) -> dict[str, Any]:
    """Обратная запись (wallet.adjust + step-up) → AdminLedgerOperation (reversal)."""
    actor = require(principal, WALLET_ADJUST, request, step_up=True)
    async with rt.transaction() as db:
        return await wallets.reverse(db, settings_of(request), actor, user_id, op_id, body.reason, now(request))


@router.post("/wallets/{user_id}/purchases/{purchase_id}/refund", responses={
    **_AUTH, 404: {"description": "WALLET_NOT_FOUND | PURCHASE_NOT_FOUND"},
    409: {"description": "ALREADY_REVERSED | BALANCE_NEGATIVE"}})
async def wallet_refund(user_id: uuid.UUID, purchase_id: uuid.UUID, body: ReasonIn, request: Request,
                        principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)
                        ) -> dict[str, Any]:
    """Возврат покупки (wallet.adjust + step-up) → {operations: AdminLedgerOperation[]}."""
    actor = require(principal, WALLET_ADJUST, request, step_up=True)
    async with rt.transaction() as db:
        return await wallets.refund(db, settings_of(request), actor, user_id, purchase_id, body.reason, now(request))
