"""Магазин (§1.7): косметика (фон главной, рамка героя — токены темы или картинка) и заморозка (цена и запас — из
правил). Покупка — одна транзакция под блокировкой ученика и `FOR UPDATE` кошелька: проверки → списание тилов
(+ заморозка) → владение → покупка → outbox game.purchase.completed.v1. Повтор Idempotency-Key — тот же ответ без
новых операций; тот же ключ с другим телом — 422 IDEMPOTENCY_KEY_REUSED. Снятие с продажи купленное не отбирает.
Тилы за деньги не продаются (спринт 8): при нехватке — 409 INSUFFICIENT_TILS {purchase_available: false}.
Предметы не влияют на учёбу: виды — только косметика и заморозка (схема и CHECK)."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Final

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.errors import ApiError, conflict, unprocessable
from tilhero_common.internal_auth import Actor
from tilhero_gamification.domain import assets
from tilhero_gamification.domain.common import (
    PURCHASE_COMPLETED,
    emit_audit,
    emit_event,
    idempotency_reused,
    insufficient_tils,
    iso,
    item_not_available,
    item_not_found,
    request_hash,
)
from tilhero_gamification.domain.engine import Turn, bump
from tilhero_gamification.models import Asset, Ownership, Purchase, ShopItem

FREEZE: Final = "streak_freeze"
# Ключи токенов цвета темы Mini App (packages/ui-tokens/token-names.json, вид color): не CSS, а ссылки на токены
THEME_TOKENS: Final = frozenset({
    "--paper", "--grid", "--ink", "--ink2", "--line", "--card", "--pen", "--pen-ink", "--pen-soft", "--mark",
    "--margin", "--err", "--err-soft", "--ok", "--ok-soft", "--warn", "--warn-soft", "--scrim"})
EDITABLE_PUBLISHED: Final = frozenset({"available_until", "order"})


def on_sale(item: ShopItem, now: datetime, audience: str) -> bool:
    return (item.status == "published" and audience in (item.audiences or [])
            and (item.available_from is None or item.available_from <= now)
            and (item.available_until is None or item.available_until > now))


def item_ref(item: ShopItem, images: dict[uuid.UUID, dict[str, Any]]) -> dict[str, Any]:
    """ShopItemRef (bff.ts)."""
    return {"code": item.code, "kind": item.kind, "title": item.title,
            "image": images.get(item.asset_id) if item.asset_id else None,
            "theme": {"bg": item.theme["bg"], "accent": item.theme["accent"]} if item.theme else None}


async def equipment_view(session: AsyncSession, turn: Turn) -> dict[str, Any]:
    codes = [c for c in (turn.learner.background_code, turn.learner.frame_code) if c]
    items = {i.code: i for i in (await session.execute(select(ShopItem).where(ShopItem.code.in_(codes))))
             .scalars().all()} if codes else {}
    images = await assets.learner_images(session, [i.asset_id for i in items.values() if i.asset_id])

    def ref(code: str | None) -> dict[str, Any] | None:
        return item_ref(items[code], images) if code and code in items else None

    return {"background": ref(turn.learner.background_code), "frame": ref(turn.learner.frame_code)}


async def shop_view(session: AsyncSession, turn: Turn) -> dict[str, Any]:
    """{items: ShopItemView[], til_balance, freeze_stock, freeze_max}: в продаже своей аудитории + заморозка."""
    rows = (await session.execute(select(ShopItem).order_by(ShopItem.order, ShopItem.code))).scalars().all()
    owned = set((await session.execute(select(Ownership.item_code).where(Ownership.user_id == turn.user_id)))
                .scalars().all())
    items = [i for i in rows if on_sale(i, turn.now, turn.audience)]
    images = await assets.learner_images(session, [i.asset_id for i in items if i.asset_id])
    balance, stock, fmax = int(turn.wallet.til_balance), int(turn.wallet.freeze_stock), turn.rules.freeze_max
    out = []
    for i in items:
        price = turn.rules.freeze_price if i.kind == FREEZE else i.price_til
        is_owned = i.kind != FREEZE and i.code in owned
        reason: str | None = None
        if is_owned:
            reason = "owned"
        elif i.kind == FREEZE and stock >= fmax:
            reason = "freeze_full"
        elif balance < price:
            reason = "not_enough_tils"
        out.append({**item_ref(i, images), "description": i.description, "price_til": price, "owned": is_owned,
                    "equipped": i.code in (turn.learner.background_code, turn.learner.frame_code),
                    "can_buy": reason is None, "reason_unavailable": reason,
                    "available_until": iso(i.available_until)})
    return {"items": out, "til_balance": balance, "freeze_stock": stock, "freeze_max": fmax}


async def purchase(session: AsyncSession, turn: Turn, item_code: str, key: str) -> tuple[int, dict[str, Any]]:
    """→ (HTTP-статус, PurchaseResult): 201 — новая покупка, 200 — повтор ключа."""
    h = request_hash({"item_code": item_code})
    prior = (await session.execute(select(Purchase).where(Purchase.user_id == turn.user_id,
                                                          Purchase.idempotency_key == key))).scalar_one_or_none()
    if prior is not None:
        if prior.request_hash != h:
            raise idempotency_reused()
        return 200, dict(prior.response)
    item = await session.get(ShopItem, item_code)
    if item is None:
        raise item_not_found()
    if not on_sale(item, turn.now, turn.audience):
        raise item_not_available()
    freeze = item.kind == FREEZE
    price = turn.rules.freeze_price if freeze else int(item.price_til)
    if not freeze and await session.get(Ownership, (turn.user_id, item.code)) is not None:
        raise conflict("ALREADY_OWNED", "Этот предмет уже куплен")
    if freeze and turn.wallet.freeze_stock >= turn.rules.freeze_max:
        raise conflict("FREEZE_STOCK_FULL", "Запас заморозок полный", {"max": turn.rules.freeze_max})
    if turn.wallet.til_balance < price:
        raise insufficient_tils(price, int(turn.wallet.til_balance))
    purchase_id = uuid.uuid4()
    ops = [await turn.post(currency="til", amount=-price, reason="shop", key=f"shop:{purchase_id}:til",
                           source_kind="command", source_ref=str(purchase_id), actor="learner", use_session=False,
                           rules_version=turn.rules.version if freeze else None)]
    if freeze:
        ops.append(await turn.post(currency="freeze", amount=1, reason="shop", key=f"shop:{purchase_id}:freeze",
                                   source_kind="command", source_ref=str(purchase_id), actor="learner",
                                   use_session=False, rules_version=turn.rules.version))
    else:
        session.add(Ownership(user_id=turn.user_id, item_code=item.code, purchase_id=purchase_id, price_til=price,
                              purchased_at=turn.now))
    response = {"purchase_id": str(purchase_id), "item_code": item.code, "price_til": price,
                "til_balance": int(turn.wallet.til_balance), "freeze_stock": int(turn.wallet.freeze_stock),
                "purchased_at": iso(turn.now)}
    session.add(Purchase(purchase_id=purchase_id, user_id=turn.user_id, item_code=item.code, item_kind=item.kind,
                         price_til=price, op_ids=[str(op.op_id) for op in ops if op is not None], status="completed",
                         idempotency_key=key, request_hash=h, response=response, created_at=turn.now))
    await bump(session, turn.stats_day, turn.audience, "purchases")
    await emit_event(session, PURCHASE_COMPLETED, {
        "purchase_id": str(purchase_id), "user_id": str(turn.user_id), "item_code": item.code,
        "item_kind": item.kind, "price_til": price, "purchased_at": iso(turn.now)})
    return 201, response


def not_owned(kind: str) -> ApiError:
    return conflict("NOT_OWNED", "Сначала купите этот предмет", {"kind": kind})


async def equip(session: AsyncSession, turn: Turn, background: str | None, frame: str | None) -> None:
    """Только свои купленные предметы нужного вида (иначе 409 NOT_OWNED); null — снять."""
    for code, kind in ((background, "background"), (frame, "hero_frame")):
        if code is None:
            continue
        item = await session.get(ShopItem, code)
        if item is None or item.kind != kind or await session.get(Ownership, (turn.user_id, code)) is None:
            raise not_owned(kind)
    turn.learner.background_code = background
    turn.learner.frame_code = frame
    turn.learner.updated_at = turn.now


# ---------------------------------------------------------------- админка


def item_state(status: str) -> ApiError:
    return conflict("ITEM_STATE", "Действие недоступно в текущем статусе предмета", {"status": status})


async def admin_view(session: AsyncSession, item: ShopItem, freeze_price: int, owners: int | None = None,
                     images: dict[uuid.UUID, dict[str, Any]] | None = None) -> dict[str, Any]:
    if images is None:
        images = await assets.admin_images(session, [item.asset_id] if item.asset_id else [])
    if owners is None:
        owners = await _owners(session, item)
    return {"code": item.code, "kind": item.kind, "title": item.title, "description": item.description,
            "image": images.get(item.asset_id) if item.asset_id else None,
            "theme": {"bg": item.theme["bg"], "accent": item.theme["accent"]} if item.theme else None,
            "price_til": freeze_price if item.kind == FREEZE else item.price_til, "audiences": list(item.audiences),
            "available_from": iso(item.available_from), "available_until": iso(item.available_until),
            "status": item.status, "order": item.order, "owners": owners, "updated_at": iso(item.updated_at)}


async def _owners(session: AsyncSession, item: ShopItem) -> int:
    if item.kind == FREEZE:  # расходуемый предмет: сколько учеников покупали
        return int(await session.scalar(select(func.count(func.distinct(Purchase.user_id))).where(
            Purchase.item_code == item.code, Purchase.status == "completed")) or 0)
    return int(await session.scalar(select(func.count()).select_from(Ownership).where(
        Ownership.item_code == item.code)) or 0)


async def admin_list(session: AsyncSession, freeze_price: int) -> dict[str, Any]:
    """Все предметы тремя запросами (картинки и владельцы — пачкой, без N+1)."""
    rows = (await session.execute(select(ShopItem).order_by(ShopItem.order, ShopItem.code))).scalars().all()
    images = await assets.admin_images(session, [i.asset_id for i in rows if i.asset_id])
    owned = {r[0]: int(r[1]) for r in (await session.execute(
        select(Ownership.item_code, func.count()).group_by(Ownership.item_code))).all()}
    buyers = {r[0]: int(r[1]) for r in (await session.execute(
        select(Purchase.item_code, func.count(func.distinct(Purchase.user_id)))
        .where(Purchase.item_kind == FREEZE, Purchase.status == "completed").group_by(Purchase.item_code))).all()}
    return {"items": [await admin_view(session, i, freeze_price, images=images,
                                       owners=(buyers if i.kind == FREEZE else owned).get(i.code, 0))
                      for i in rows]}


async def _item(session: AsyncSession, code: str) -> ShopItem:
    item = await session.get(ShopItem, code, with_for_update=True, populate_existing=True)
    if item is None:
        raise item_not_found()
    return item


async def _check_asset(session: AsyncSession, asset_id: uuid.UUID | None) -> None:
    if asset_id is None:
        return
    purpose = await session.scalar(select(Asset.purpose).where(Asset.asset_id == asset_id))
    if purpose != "shop_item":
        raise unprocessable("ASSET_INVALID", "Картинка не найдена или не для магазина", {"reason": "asset"})


def check_theme(theme: dict[str, str] | None) -> dict[str, str] | None:
    """Ключи токенов цвета темы (`--ok-soft` или `ok-soft`) → канонический ключ allowlist; иначе 422 ITEM_INVALID."""
    if theme is None:
        return None
    out: dict[str, str] = {}
    for key in ("bg", "accent"):
        raw = str(theme.get(key) or "")
        token = raw if raw.startswith("--") else f"--{raw}"
        if token not in THEME_TOKENS:
            raise unprocessable("ITEM_INVALID", "Тема — только ключи токенов цвета", {"reason": "theme",
                                                                                       "field": key})
        out[key] = token
    return out


async def create(session: AsyncSession, actor: Actor, data: dict[str, Any], now: datetime,
                 freeze_price: int) -> dict[str, Any]:
    if await session.get(ShopItem, data["code"]) is not None:
        raise conflict("ITEM_CODE_TAKEN", "Предмет с таким кодом уже есть", {"code": data["code"]})
    await _check_asset(session, data.get("asset_id"))
    theme = check_theme(data.get("theme"))
    item = ShopItem(code=data["code"], kind=data["kind"], title=data["title"], description=data["description"],
                    asset_id=data.get("asset_id"), theme=theme, price_til=data["price_til"],
                    audiences=data["audiences"], available_from=data.get("available_from"),
                    available_until=data.get("available_until"), status="draft", order=data["order"],
                    created_by=actor.id[:64], created_at=now, updated_at=now)
    session.add(item)
    await session.flush()
    await emit_audit(session, actor, "game.shop_item.created", "game_shop_item", item.code,
                     after={"kind": item.kind, "price_til": item.price_til, "status": "draft"})
    return await admin_view(session, item, freeze_price, owners=0)


async def patch(session: AsyncSession, actor: Actor, code: str, changes: dict[str, Any], now: datetime,
                freeze_price: int) -> dict[str, Any]:
    item = await _item(session, code)
    if item.status != "draft" or item.kind == FREEZE:
        extra = set(changes) - EDITABLE_PUBLISHED
        if extra:
            raise conflict("ITEM_NOT_EDITABLE", "У опубликованного предмета меняются только срок и порядок",
                           {"status": item.status, "fields": sorted(extra)})
    if "kind" in changes and changes["kind"] not in ("background", "hero_frame"):
        raise unprocessable("ITEM_INVALID", "Недопустимый вид предмета", {"reason": "kind"})
    if "asset_id" in changes:
        await _check_asset(session, changes["asset_id"])
    if "theme" in changes:
        changes = {**changes, "theme": check_theme(changes["theme"])}
    before = {"price_til": item.price_til, "available_until": iso(item.available_until), "order": item.order}
    for key, value in changes.items():
        setattr(item, key, value)
    if item.available_from and item.available_until and item.available_until <= item.available_from:
        raise unprocessable("ITEM_INVALID", "Конец продажи раньше начала", {"reason": "window"})
    item.updated_at = now
    await emit_audit(session, actor, "game.shop_item.updated", "game_shop_item", code, before=before,
                     after={"price_til": item.price_til, "available_until": iso(item.available_until),
                            "order": item.order, "fields": sorted(changes)})
    return await admin_view(session, item, freeze_price)


async def set_status(session: AsyncSession, actor: Actor, code: str, target: str, comment: str | None,
                     now: datetime, freeze_price: int) -> dict[str, Any]:
    item = await _item(session, code)
    allowed = {"published": ("draft", "retired"), "retired": ("published",)}[target]
    if item.status not in allowed:
        raise item_state(item.status)
    if target == "published" and item.kind != FREEZE and item.asset_id is None and item.theme is None:
        raise unprocessable("ITEM_INVALID", "Нужна картинка или тема", {"reason": "appearance"})
    before = item.status
    item.status = target
    item.updated_at = now
    await emit_audit(session, actor, f"game.shop_item.{'published' if target == 'published' else 'retired'}",
                     "game_shop_item", code, before={"status": before}, after={"status": target}, reason=comment)
    return await admin_view(session, item, freeze_price)
