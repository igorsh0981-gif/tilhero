"""Каталог тарифов и товаров (INTERNAL_API §1.2, ADM-MONEY-03, APP-BILL-01): версии как правила игры спринта 6 —
один черновик, одна активная; черновик → проверка → активация (step-up) → прежняя archived; откат — новая версия
max + 1 из архивной через валидатор. Заказ хранит снимок товара — оплаченное живёт по снимку, новая цена — для новых
заказов. Цены сайта (price_tiyin, сумы × 100) и Mini App (price_stars) — разные поля, пересчёта нет (ADR-0001)."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from urllib.parse import urlsplit

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_billing.domain.common import (
    CATALOG_ACTIVATED,
    FEATURES,
    canonical_hash,
    emit_audit,
    emit_event,
    iso,
    iso_req,
    staff_ref,
)
from tilhero_billing.models import CatalogVersion
from tilhero_billing.providers.base import FIAT_PROVIDERS, STARS_SUBSCRIPTION_MAX_PRICE
from tilhero_billing.settings import Settings
from tilhero_common.errors import ApiError, conflict, not_found, unprocessable
from tilhero_common.internal_auth import Actor

CODE_RE = re.compile(r"^[a-z0-9_]{2,40}$")
IKPU_RE = re.compile(r"^[0-9]{1,17}$")
PACKAGE_RE = re.compile(r"^[0-9]{1,20}$")
TIN_RE = re.compile(r"^(?:[0-9]{9}|[0-9]{14})$")
# анти-стиринг (решение В1): тексты товаров видны в Mini App — без названий фиатных провайдеров и адреса сайта оплаты
FIAT_NAMES_RE = re.compile(r"(?<![\w])(payme|paycom|click|uzum|пейми|пэйми|клик|узум)(?![\w])", re.IGNORECASE)
AUDIENCES = ("kids", "teens", "adults")
KINDS = ("subscription", "til_pack")
STARS_SUBSCRIPTION_DAYS = 30
# границы limits (§1.2): order_ttl больше 12 ч таймаута Payme; удержание переживает паузу урока до 72 ч
LIMITS: dict[str, tuple[int, int]] = {
    "min_start_minutes": (1, 60), "pair_min_minutes": (1, 120), "low_minutes_percent": (1, 50),
    "expiring_days": (1, 14), "order_ttl_minutes": (60, 2880), "stars_order_ttl_minutes": (10, 1440),
    "pending_orders_max": (1, 20), "hold_ttl_hours": (73, 168),
}

Issue = dict[str, str]


def catalog_not_validated() -> ApiError:
    return conflict("CATALOG_NOT_VALIDATED", "Черновик изменён после проверки — проверьте его снова")


def catalog_invalid(errors: list[Issue]) -> ApiError:
    return unprocessable("CATALOG_INVALID", "Каталог не прошёл проверку", {"errors": errors})


def draft_not_found() -> ApiError:
    return not_found("CATALOG_DRAFT_NOT_FOUND", "Черновика каталога нет")


def version_not_found() -> ApiError:
    return not_found("CATALOG_VERSION_NOT_FOUND", "Версия каталога не найдена")


def catalog_state(status: str) -> ApiError:
    del status
    return conflict("CATALOG_STATE", "Версия каталога в другом состоянии")


def draft_conflict() -> ApiError:
    return conflict("DRAFT_CONFLICT", "Черновик изменил другой сотрудник — обновите страницу")


# ---------------------------------------------------------------- снимок активной версии


@dataclass(frozen=True)
class Catalog:
    version: int
    payload: dict[str, Any]

    @property
    def limits(self) -> dict[str, int]:
        raw = self.payload.get("limits") or {}
        return {k: int(raw.get(k, lo)) for k, (lo, _) in LIMITS.items()}

    @property
    def trial(self) -> dict[str, Any]:
        return dict(self.payload.get("trial") or {})

    @property
    def offer(self) -> dict[str, str]:
        raw = self.payload.get("offer") or {}
        return {"version": str(raw.get("version") or ""), "url": str(raw.get("url") or "")}

    @property
    def merchant_tin(self) -> str | None:
        tin = (self.payload.get("merchant") or {}).get("tin")
        return str(tin) if tin else None

    def products(self) -> list[dict[str, Any]]:
        items = [p for p in self.payload.get("products") or [] if isinstance(p, dict)]
        return sorted(items, key=lambda p: (int(p.get("sort") or 0), str(p.get("code"))))

    def product(self, code: str) -> dict[str, Any] | None:
        return next((p for p in self.products() if p.get("code") == code), None)


async def active_catalog(db: AsyncSession) -> Catalog | None:
    row = await db.scalar(select(CatalogVersion).where(CatalogVersion.status == "active"))
    return Catalog(row.version, dict(row.payload)) if row is not None else None


def audience_of(age_band: str | None, child: bool) -> str:
    """Получатель: детский профиль и 6–13 — kids, 14–17 — teens, иначе adults."""
    if child or age_band in ("6-9", "10-13"):
        return "kids"
    if age_band == "14-17":
        return "teens"
    return "adults"


def channel_price(product: dict[str, Any], channel: str) -> int | None:
    """Цена канала: miniapp/renewal — Stars, web — тийины; None — в канале не продаётся."""
    if channel == "web":
        value = product.get("price_tiyin")
        return int(value) if isinstance(value, int) and not isinstance(value, bool) and product.get("providers") \
            else None
    value = product.get("price_stars")
    return int(value) if isinstance(value, int) and not isinstance(value, bool) else None


def snapshot(product: dict[str, Any], catalog: Catalog) -> dict[str, Any]:
    """Снимок товара в заказе (ADM-MONEY-03): цена, дни, минуты, тилы, функции, названия, реквизиты, ИНН."""
    keys = ("code", "kind", "title", "description", "days", "minutes", "features", "til", "audiences",
            "price_tiyin", "price_stars", "stars_mode", "stars_title", "fiscal")
    out = {k: product.get(k) for k in keys}
    out["merchant_tin"] = catalog.merchant_tin
    return out


# ---------------------------------------------------------------- валидатор (§1.2)


def _loc(value: Any, path: str, lo: int, hi: int, errors: list[Issue]) -> None:
    if not isinstance(value, dict):
        errors.append({"path": path, "code": "required"})
        return
    for lang in ("ru", "uz"):
        text = value.get(lang)
        if not isinstance(text, str) or not text.strip():
            errors.append({"path": f"{path}.{lang}", "code": "required"})
        elif not lo <= len(text) <= hi:
            errors.append({"path": f"{path}.{lang}", "code": "length"})
    extra = set(value) - {"ru", "uz"}
    if extra:
        errors.append({"path": path, "code": "unknown_language"})


def _int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _range(value: Any, path: str, lo: int, hi: int, errors: list[Issue]) -> bool:
    if not _int(value):
        errors.append({"path": path, "code": "required"})
        return False
    if not lo <= value <= hi:
        errors.append({"path": path, "code": "range"})
        return False
    return True


def _host(url: str) -> str:
    try:
        return (urlsplit(url).hostname or "").lower()
    except ValueError:
        return ""


def _steering(value: Any, path: str, settings: Settings, errors: list[Issue]) -> None:
    """Название, описание, заголовок счёта: нет Payme / Click / Uzum и адреса сайта оплаты (WEB_PAY_ORIGIN)."""
    if not isinstance(value, dict):
        return
    host = _host(settings.web_pay_origin)
    for lang, text in value.items():
        if not isinstance(text, str):
            continue
        low = text.lower()
        if FIAT_NAMES_RE.search(text) or (host and host in low) or settings.web_pay_origin.lower() in low:
            errors.append({"path": f"{path}.{lang}", "code": "anti_steering"})


def validate(payload: Any, settings: Settings) -> tuple[list[Issue], list[Issue]]:
    """→ (errors, warnings). В stage/prod фискальные реквизиты товара сайта в продаже обязательны (В6, О4), в dev/test
    — предупреждение; ограничения Bot API для Stars (подписка — 30 дней и ≤ 10 000 Stars) — всегда ошибки."""
    errors: list[Issue] = []
    warnings: list[Issue] = []
    strict = settings.is_secure_env
    fiscal_bucket = errors if strict else warnings
    if not isinstance(payload, dict):
        return [{"path": "", "code": "invalid"}], []

    merchant = payload.get("merchant")
    tin = merchant.get("tin") if isinstance(merchant, dict) else None
    if not isinstance(merchant, dict):
        errors.append({"path": "merchant", "code": "required"})

    offer = payload.get("offer")
    if not isinstance(offer, dict):
        errors.append({"path": "offer", "code": "required"})
    else:
        version = offer.get("version")
        if not isinstance(version, str) or not 1 <= len(version) <= 20:
            errors.append({"path": "offer.version", "code": "length"})
        url = offer.get("url")
        if not isinstance(url, str) or not url.startswith("https://") or len(url) > 500 or not _host(url):
            errors.append({"path": "offer.url", "code": "https_required"})
        else:
            if _host(url) == _host(settings.web_pay_origin):
                errors.append({"path": "offer.url", "code": "not_on_web_pay"})
            if _host(url).endswith(".invalid"):
                (errors if strict else warnings).append({"path": "offer.url", "code": "placeholder"})

    trial = payload.get("trial")
    if not isinstance(trial, dict):
        errors.append({"path": "trial", "code": "required"})
    else:
        if not isinstance(trial.get("enabled"), bool):
            errors.append({"path": "trial.enabled", "code": "required"})
        _range(trial.get("days"), "trial.days", 1, 30, errors)
        _range(trial.get("minutes"), "trial.minutes", 1, 1000, errors)
        feats = trial.get("features")
        if not isinstance(feats, list) or not feats or not set(feats) <= set(FEATURES) or len(set(feats)) != len(
                feats):
            errors.append({"path": "trial.features", "code": "invalid"})

    limits = payload.get("limits")
    if not isinstance(limits, dict):
        errors.append({"path": "limits", "code": "required"})
    else:
        for key, (lo, hi) in LIMITS.items():
            _range(limits.get(key), f"limits.{key}", lo, hi, errors)
        if set(limits) - set(LIMITS):
            errors.append({"path": "limits", "code": "unknown_field"})

    products = payload.get("products")
    if not isinstance(products, list) or not products:
        errors.append({"path": "products", "code": "required"})
        products = []
    seen: set[str] = set()
    subscriptions_on_sale = 0
    web_on_sale = False
    for i, p in enumerate(products):
        path = f"products[{i}]"
        if not isinstance(p, dict):
            errors.append({"path": path, "code": "invalid"})
            continue
        code = p.get("code")
        if not isinstance(code, str) or not CODE_RE.match(code):
            errors.append({"path": f"{path}.code", "code": "invalid"})
        elif code in seen:
            errors.append({"path": f"{path}.code", "code": "duplicate"})
        else:
            seen.add(code)
        kind = p.get("kind")
        if kind not in KINDS:
            errors.append({"path": f"{path}.kind", "code": "invalid"})
        status = p.get("status")
        if status not in ("on_sale", "hidden"):
            errors.append({"path": f"{path}.status", "code": "invalid"})
        if not _int(p.get("sort")):
            errors.append({"path": f"{path}.sort", "code": "required"})
        _loc(p.get("title"), f"{path}.title", 1, 60, errors)
        if p.get("description") is not None:
            _loc(p.get("description"), f"{path}.description", 1, 300, errors)
        for field_name in ("title", "description", "stars_title"):
            _steering(p.get(field_name), f"{path}.{field_name}", settings, errors)
        audiences = p.get("audiences")
        if not isinstance(audiences, list) or not audiences or not set(audiences) <= set(AUDIENCES):
            errors.append({"path": f"{path}.audiences", "code": "invalid"})

        price_tiyin = p.get("price_tiyin")
        if price_tiyin is not None and _range(price_tiyin, f"{path}.price_tiyin", 100, 100_000_000_000, errors) \
                and price_tiyin % 100 != 0:
            errors.append({"path": f"{path}.price_tiyin", "code": "multiple_of_100"})
        price_stars = p.get("price_stars")
        if price_stars is not None:
            _range(price_stars, f"{path}.price_stars", 1, 100_000, errors)
        if status == "on_sale" and price_tiyin is None and price_stars is None:
            errors.append({"path": path, "code": "price_required"})
        providers = p.get("providers")
        if not isinstance(providers, list) or not set(providers) <= set(FIAT_PROVIDERS) \
                or len(set(providers)) != len(providers):
            errors.append({"path": f"{path}.providers", "code": "invalid"})
            providers = []
        for provider in providers:
            if not settings.provider_enabled(provider):
                warnings.append({"path": f"{path}.providers", "code": f"provider_disabled:{provider}"})
        if price_tiyin is not None and not providers:
            warnings.append({"path": f"{path}.providers", "code": "no_providers"})

        stars_mode = p.get("stars_mode")
        if stars_mode not in ("one_time", "subscription"):
            errors.append({"path": f"{path}.stars_mode", "code": "invalid"})
        stars_title = p.get("stars_title")
        if stars_title is not None or price_stars is not None:
            _loc(stars_title, f"{path}.stars_title", 1, 32, errors)

        if kind == "subscription":
            _range(p.get("days"), f"{path}.days", 1, 366, errors)
            _range(p.get("minutes"), f"{path}.minutes", 1, 100_000, errors)
            feats = p.get("features")
            if not isinstance(feats, list) or not feats or not set(feats) <= set(FEATURES) \
                    or len(set(feats)) != len(feats):
                errors.append({"path": f"{path}.features", "code": "invalid"})
            if p.get("til") is not None:
                errors.append({"path": f"{path}.til", "code": "not_allowed"})
            if stars_mode == "subscription":
                # Bot API: subscription_period — только 2592000 с (30 дней), цена подписки ≤ 10 000 Stars
                if p.get("days") != STARS_SUBSCRIPTION_DAYS:
                    errors.append({"path": f"{path}.days", "code": "stars_subscription_days"})
                if isinstance(price_stars, int) and price_stars > STARS_SUBSCRIPTION_MAX_PRICE:
                    errors.append({"path": f"{path}.price_stars", "code": "stars_subscription_price"})
            if status == "on_sale":
                subscriptions_on_sale += 1
        elif kind == "til_pack":
            _range(p.get("til"), f"{path}.til", 1, 100_000, errors)
            if stars_mode != "one_time":
                errors.append({"path": f"{path}.stars_mode", "code": "one_time_required"})
            for k in ("days", "minutes"):
                if p.get(k) is not None:
                    errors.append({"path": f"{path}.{k}", "code": "not_allowed"})
            if p.get("features"):
                errors.append({"path": f"{path}.features", "code": "not_allowed"})

        if status == "on_sale" and price_tiyin is not None and providers:
            web_on_sale = True
            _fiscal(p.get("fiscal"), f"{path}.fiscal", fiscal_bucket, errors)

    if products and subscriptions_on_sale == 0:
        errors.append({"path": "products", "code": "subscription_on_sale_required"})
    if web_on_sale and (not isinstance(tin, str) or not TIN_RE.match(tin)):
        fiscal_bucket.append({"path": "merchant.tin", "code": "required"})
    elif tin is not None and (not isinstance(tin, str) or not TIN_RE.match(tin)):
        errors.append({"path": "merchant.tin", "code": "invalid"})
    unknown = set(payload) - {"merchant", "offer", "trial", "limits", "products"}
    if unknown:
        errors.append({"path": "", "code": "unknown_field"})
    return errors, warnings


def _fiscal(fiscal: Any, path: str, bucket: list[Issue], errors: list[Issue]) -> None:
    """Реквизиты позиции чека сайта (§1.9): пустые — в bucket (prod — ошибка, dev — предупреждение); неверный формат
    заданного значения — всегда ошибка."""
    if not isinstance(fiscal, dict):
        bucket.append({"path": path, "code": "required"})
        return
    checks = (("ikpu", IKPU_RE), ("package_code", PACKAGE_RE))
    for key, rx in checks:
        value = fiscal.get(key)
        if value is None:
            bucket.append({"path": f"{path}.{key}", "code": "required"})
        elif not isinstance(value, str) or not rx.match(value):
            errors.append({"path": f"{path}.{key}", "code": "invalid"})
    vat = fiscal.get("vat_percent")
    if vat is None:
        bucket.append({"path": f"{path}.vat_percent", "code": "required"})
    elif not _int(vat) or not 0 <= vat <= 100:
        errors.append({"path": f"{path}.vat_percent", "code": "range"})
    title = fiscal.get("receipt_title")
    if title is None:
        bucket.append({"path": f"{path}.receipt_title", "code": "required"})
    elif not isinstance(title, str) or not 1 <= len(title) <= 63:
        errors.append({"path": f"{path}.receipt_title", "code": "length"})
    units = fiscal.get("units")
    if units is not None and not _int(units):
        errors.append({"path": f"{path}.units", "code": "invalid"})


def fiscal_complete(fiscal: Any) -> bool:
    if not isinstance(fiscal, dict):
        return False
    return (isinstance(fiscal.get("ikpu"), str) and isinstance(fiscal.get("package_code"), str)
            and _int(fiscal.get("vat_percent")) and isinstance(fiscal.get("receipt_title"), str))


# ---------------------------------------------------------------- версии (админка)


def diff(base: Any, other: Any, path: str = "") -> list[dict[str, Any]]:
    """Отличия payload от активной версии: словари — по ключам, products — по code, прочие списки — целиком."""
    if isinstance(base, dict) and isinstance(other, dict):
        out: list[dict[str, Any]] = []
        for key in sorted(set(base) | set(other)):
            out += diff(base.get(key), other.get(key), f"{path}.{key}" if path else str(key))
        return out
    if path == "products" and isinstance(base, list) and isinstance(other, list):
        by_b = {p.get("code"): p for p in base if isinstance(p, dict)}
        by_o = {p.get("code"): p for p in other if isinstance(p, dict)}
        out = []
        for code in sorted(set(by_b) | set(by_o), key=str):
            out += diff(by_b.get(code), by_o.get(code), f"products[{code}]")
        return out
    if base != other:
        return [{"path": path, "from": base, "to": other}]
    return []


def summary_view(v: CatalogVersion) -> dict[str, Any]:
    return {
        "version": v.version, "status": v.status, "comment": v.comment,
        "created_by": staff_ref(v.created_by, v.created_by_name), "created_at": iso(v.created_at),
        "validated": v.validated_hash is not None and v.validated_hash == v.payload_hash,
        "activated_by": staff_ref(v.activated_by, v.activated_by_name), "activated_at": iso(v.activated_at),
    }


async def version_view(db: AsyncSession, v: CatalogVersion) -> dict[str, Any]:
    active = await db.scalar(select(CatalogVersion).where(CatalogVersion.status == "active"))
    base = active.payload if active is not None and active.version != v.version else v.payload
    return {**summary_view(v), "payload": v.payload, "diff": diff(base, v.payload), "updated_at": iso(v.updated_at)}


async def list_versions(db: AsyncSession) -> list[dict[str, Any]]:
    rows = (await db.execute(select(CatalogVersion).order_by(CatalogVersion.version.desc()))).scalars().all()
    return [summary_view(v) for v in rows]


async def get_version(db: AsyncSession, version: int) -> CatalogVersion:
    row = await db.get(CatalogVersion, version)
    if row is None:
        raise version_not_found()
    return row


async def _draft(db: AsyncSession, *, lock: bool = True) -> CatalogVersion | None:
    stmt = select(CatalogVersion).where(CatalogVersion.status == "draft")
    if lock:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    return await db.scalar(stmt)


async def _next_version(db: AsyncSession) -> int:
    return int(await db.scalar(select(func.coalesce(func.max(CatalogVersion.version), 0))) or 0) + 1


def _same_moment(header: str | None, value: datetime) -> bool:
    if header is None:
        return False
    try:
        got = datetime.fromisoformat(header.strip().strip('"').replace("Z", "+00:00"))
    except ValueError:
        return False
    return abs((got - value).total_seconds()) < 0.001


async def put_draft(db: AsyncSession, payload: dict[str, Any], comment: str | None, if_match: str | None,
                    actor: Actor, now: datetime) -> CatalogVersion:
    """Черновик (If-Match — updated_at черновика; без черновика If-Match не нужен — создаётся новый max + 1)."""
    draft = await _draft(db)
    h = canonical_hash(payload)
    if draft is None:
        draft = CatalogVersion(version=await _next_version(db), status="draft", payload=payload, payload_hash=h,
                               validated_hash=None, comment=comment, created_by=actor.id[:64],
                               created_by_name=(actor.name or "")[:120] or None, created_at=now, updated_at=now)
        db.add(draft)
        await db.flush()
        return draft
    if not _same_moment(if_match, draft.updated_at):
        raise draft_conflict()
    draft.payload, draft.payload_hash, draft.comment, draft.updated_at = payload, h, comment, now
    if draft.validated_hash != h:
        draft.validated_hash = None
    await db.flush()
    return draft


async def delete_draft(db: AsyncSession) -> None:
    draft = await _draft(db)
    if draft is None:
        raise draft_not_found()
    await db.execute(delete(CatalogVersion).where(CatalogVersion.version == draft.version))


async def validate_draft(db: AsyncSession, settings: Settings) -> dict[str, Any]:
    draft = await _draft(db)
    if draft is None:
        raise draft_not_found()
    errors, warnings = validate(draft.payload, settings)
    draft.validated_hash = draft.payload_hash if not errors else None
    return {"ok": not errors, "errors": errors, "warnings": warnings}


async def _activate(db: AsyncSession, version: CatalogVersion, actor: Actor | None, now: datetime,
                    comment: str, *, action: str) -> CatalogVersion:
    """Прежняя активная → archived, эта → active; событие и аудит (actor None — системный seed стенда)."""
    current = await db.scalar(select(CatalogVersion).where(CatalogVersion.status == "active").with_for_update())
    before = current.version if current is not None else None
    if current is not None:
        current.status = "archived"
        await db.flush()
    version.status = "active"
    version.activated_by = actor.id[:64] if actor is not None else "system"
    version.activated_by_name = (actor.name or "")[:120] or None if actor is not None else "Система"
    version.activated_at = now
    await db.flush()
    await emit_event(db, CATALOG_ACTIVATED, {"version": version.version, "activated_at": iso_req(now)})
    await emit_audit(db, actor, action, "billing_catalog", str(version.version),
                     before={"active_version": before}, after={"active_version": version.version},
                     reason=comment, at=now)
    return version


async def activate_draft(db: AsyncSession, settings: Settings, comment: str, actor: Actor | None,
                         now: datetime) -> CatalogVersion:
    """Активация проверенного черновика (409 CATALOG_NOT_VALIDATED — изменён после проверки); повторная проверка
    перед активацией (окружение могло смениться)."""
    draft = await _draft(db)
    if draft is None:
        raise draft_not_found()
    if draft.validated_hash != draft.payload_hash:
        raise catalog_not_validated()
    errors, _ = validate(draft.payload, settings)
    if errors:
        draft.validated_hash = None
        raise catalog_invalid(errors)
    if comment and not draft.comment:
        draft.comment = comment[:500]
    return await _activate(db, draft, actor, now, comment, action="billing.catalog_activated")


async def rollback(db: AsyncSession, settings: Settings, version: int, comment: str, actor: Actor,
                   now: datetime) -> CatalogVersion:
    """Откат: новая версия max + 1 из архивной (через валидатор), сразу активная; черновик не трогается."""
    source = await get_version(db, version)
    if source.status != "archived":
        raise catalog_state(source.status)
    payload = dict(source.payload)
    errors, _ = validate(payload, settings)
    if errors:
        raise catalog_invalid(errors)
    h = canonical_hash(payload)
    current = await db.scalar(select(CatalogVersion).where(CatalogVersion.status == "active").with_for_update())
    if current is not None:
        current.status = "archived"
        await db.flush()
    new = CatalogVersion(version=await _next_version(db), status="active", payload=payload, payload_hash=h,
                         validated_hash=h, comment=comment[:500], created_by=actor.id[:64],
                         created_by_name=(actor.name or "")[:120] or None, created_at=now, updated_at=now,
                         activated_by=actor.id[:64], activated_by_name=(actor.name or "")[:120] or None,
                         activated_at=now)
    db.add(new)
    await db.flush()
    await emit_event(db, CATALOG_ACTIVATED, {"version": new.version, "activated_at": iso_req(now)})
    await emit_audit(db, actor, "billing.catalog_rolled_back", "billing_catalog", str(new.version),
                     before={"active_version": current.version if current else None},
                     after={"active_version": new.version, "from_version": version}, reason=comment, at=now)
    return new
