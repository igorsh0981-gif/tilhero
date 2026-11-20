"""Герои (§1.4): 9 героев по 3 ступени. Ступень общая для всех героев ученика и растёт только за подтверждённые
навыки (тилами не купить); смена героя бесплатна и не меняет XP, уровень и ступень. Детям первыми — дракончики.
Каталог: правка черновика (game.manage), публикация (game.publish + step-up) — черновик становится живым,
version + 1; картинка ступени заменяется без релиза. Скрыть героя из выбора — audiences = [] (у выбравших остаётся)."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.errors import ApiError, conflict, unprocessable
from tilhero_common.internal_auth import Actor
from tilhero_gamification.domain import assets
from tilhero_gamification.domain.common import emit_audit, hero_not_found, iso, staff_ref
from tilhero_gamification.domain.engine import Turn
from tilhero_gamification.models import Asset, Hero, Learner

LINE_ORDER_KIDS = {"pet": 0, "robot": 1, "human": 2}


def hero_not_available() -> ApiError:
    return conflict("HERO_NOT_AVAILABLE", "Этот герой сейчас недоступен для выбора")


def _asset_ids(stages: list[dict[str, Any]]) -> list[uuid.UUID]:
    out = []
    for s in stages or []:
        try:
            out.append(uuid.UUID(str(s.get("asset_id"))))
        except ValueError:
            continue
    return out


def ordered(heroes: list[Hero], audience: str) -> list[Hero]:
    if audience == "kids":
        return sorted(heroes, key=lambda h: (LINE_ORDER_KIDS.get(h.line, 9), h.order, h.code))
    return sorted(heroes, key=lambda h: (h.order, h.code))


async def published(session: AsyncSession) -> list[Hero]:
    return list((await session.execute(select(Hero).where(Hero.published_at.is_not(None)))).scalars().all())


def available(hero: Hero, audience: str) -> bool:
    return hero.published_at is not None and audience in (hero.audiences or [])


def hero_view(hero: Hero, images: dict[uuid.UUID, dict[str, Any]], thresholds: list[int]) -> dict[str, Any]:
    stages = []
    for s in sorted(hero.stages, key=lambda s: int(s["stage"])):
        stage = int(s["stage"])
        stages.append({"stage": stage, "name": s["name"], "image": images.get(uuid.UUID(str(s["asset_id"]))),
                       "skills_required": thresholds[stage - 1] if stage - 1 < len(thresholds) else 0})
    return {"code": hero.code, "line": hero.line, "name": hero.name, "tagline": hero.tagline, "stages": stages}


async def my_hero(session: AsyncSession, turn: Turn) -> dict[str, Any] | None:
    """MyHero (bff.ts): next_stage_at — сколько подтверждённых навыков осталось до следующей ступени (порог −
    confirmed_skills, не меньше 0; null — последняя ступень)."""
    code = turn.learner.hero_code
    if code is None:
        return None
    hero = await session.get(Hero, code)
    if hero is None or hero.published_at is None:
        return None
    stage = int(turn.learner.hero_stage)
    current = next((s for s in hero.stages if int(s["stage"]) == stage), hero.stages[0])
    images = await assets.learner_images(session, _asset_ids([current]))
    thresholds = turn.rules.stage_thresholds
    confirmed = int(turn.learner.confirmed_skills)
    left = max(0, thresholds[stage] - confirmed) if stage < 3 and stage < len(thresholds) else None
    return {"code": hero.code, "name": hero.name, "stage": stage, "stage_name": current["name"],
            "image": images.get(uuid.UUID(str(current["asset_id"]))), "confirmed_skills": confirmed,
            "next_stage_at": left}


async def learner_list(session: AsyncSession, turn: Turn) -> dict[str, Any]:
    """{items: HeroView[], selected, stage} — опубликованные своей аудитории (+ выбранный, даже скрытый)."""
    audience = turn.audience
    heroes = [h for h in await published(session)
              if available(h, audience) or h.code == turn.learner.hero_code]
    images = await assets.learner_images(session, [a for h in heroes for a in _asset_ids(h.stages)])
    thresholds = turn.rules.stage_thresholds
    return {"items": [hero_view(h, images, thresholds) for h in ordered(heroes, audience)],
            "selected": turn.learner.hero_code, "stage": int(turn.learner.hero_stage)}


async def select_hero(session: AsyncSession, turn: Turn, code: str) -> None:
    hero = await session.get(Hero, code)
    if hero is None or hero.published_at is None:
        raise hero_not_found()
    if code != turn.learner.hero_code and not available(hero, turn.audience):
        raise hero_not_available()
    turn.learner.hero_code = code
    turn.learner.updated_at = turn.now


# ---------------------------------------------------------------- админка


def _fields(src: dict[str, Any] | Hero) -> dict[str, Any]:
    if isinstance(src, Hero):
        return {"name": src.name, "tagline": src.tagline, "audiences": list(src.audiences),
                "stages": [{"stage": int(s["stage"]), "name": s["name"], "asset_id": str(s["asset_id"])}
                           for s in sorted(src.stages, key=lambda s: int(s["stage"]))]}
    return {"name": src["name"], "tagline": src["tagline"], "audiences": list(src["audiences"]),
            "stages": [{"stage": int(s["stage"]), "name": s["name"], "asset_id": str(s["asset_id"])}
                       for s in sorted(src["stages"], key=lambda s: int(s["stage"]))]}


def _images(fields: dict[str, Any], images: dict[uuid.UUID, dict[str, Any]]) -> list[dict[str, Any]]:
    return [{"stage": s["stage"], "image": images[uuid.UUID(s["asset_id"])]} for s in fields["stages"]
            if uuid.UUID(s["asset_id"]) in images]


def _all_asset_ids(hero: Hero) -> list[uuid.UUID]:
    return _asset_ids(hero.stages) + (_asset_ids(hero.draft["stages"]) if hero.draft else [])


async def admin_view(session: AsyncSession, hero: Hero, learners: int | None = None,
                     images: dict[uuid.UUID, dict[str, Any]] | None = None) -> dict[str, Any]:
    live = _fields(hero)
    draft = _fields(hero.draft) if hero.draft else None
    if images is None:
        images = await assets.admin_images(session, _all_asset_ids(hero))
    if learners is None:
        learners = int(await session.scalar(select(func.count()).select_from(Learner).where(
            Learner.hero_code == hero.code)) or 0)
    return {"code": hero.code, "line": hero.line, "order": hero.order, "version": hero.version,
            "published_at": iso(hero.published_at), "published_by": staff_ref(hero.published_by,
                                                                              hero.published_by_name),
            **live, "images": _images(live, images),
            "draft": ({**draft, "images": _images(draft, images), "updated_at": iso(hero.draft_updated_at)}
                      if draft else None),
            "learners": learners}


async def admin_list(session: AsyncSession) -> dict[str, Any]:
    heroes = (await session.execute(select(Hero).order_by(Hero.order, Hero.code))).scalars().all()
    counts = {r[0]: int(r[1]) for r in (await session.execute(select(Learner.hero_code, func.count()).where(
        Learner.hero_code.is_not(None)).group_by(Learner.hero_code))).all()}
    images = await assets.admin_images(session, [a for h in heroes for a in _all_asset_ids(h)])
    return {"items": [await admin_view(session, h, int(counts.get(h.code, 0)), images) for h in heroes]}


async def _hero(session: AsyncSession, code: str, *, lock: bool = False) -> Hero:
    hero = await session.get(Hero, code, with_for_update=lock, populate_existing=lock)
    if hero is None:
        raise hero_not_found()
    return hero


async def put_draft(session: AsyncSession, actor: Actor, code: str, fields: dict[str, Any],
                    now: datetime) -> dict[str, Any]:
    hero = await _hero(session, code, lock=True)
    ids = [uuid.UUID(str(s["asset_id"])) for s in fields["stages"]]
    found = {r[0]: r[1] for r in (await session.execute(select(Asset.asset_id, Asset.purpose).where(
        Asset.asset_id.in_(ids)))).all()}
    for i, asset_id in enumerate(ids):
        if found.get(asset_id) != "hero_stage":
            raise unprocessable("ASSET_INVALID", "Картинка ступени не найдена или не для героя",
                                {"reason": "asset", "stage": fields["stages"][i]["stage"]})
    hero.draft = _fields(fields)
    hero.draft_updated_at = now
    hero.updated_at = now
    await emit_audit(session, actor, "game.hero.draft_saved", "game_hero", code,
                     after={"audiences": hero.draft["audiences"],
                            "assets": [s["asset_id"] for s in hero.draft["stages"]]})
    return await admin_view(session, hero)


async def publish(session: AsyncSession, actor: Actor, code: str, comment: str | None,
                  now: datetime) -> dict[str, Any]:
    hero = await _hero(session, code, lock=True)
    if not hero.draft:
        raise conflict("HERO_DRAFT_MISSING", "У героя нет черновика для публикации")
    before = {"version": hero.version, "audiences": list(hero.audiences),
              "assets": [str(s["asset_id"]) for s in hero.stages]}
    draft = _fields(hero.draft)
    hero.name, hero.tagline, hero.audiences, hero.stages = draft["name"], draft["tagline"], draft["audiences"], \
        draft["stages"]
    hero.draft = None
    hero.draft_updated_at = None
    hero.version += 1
    hero.published_at, hero.published_by, hero.published_by_name = now, actor.id[:64], (actor.name or "")[:120]
    hero.updated_at = now
    await emit_audit(session, actor, "game.hero.published", "game_hero", code, before=before,
                     after={"version": hero.version, "audiences": list(hero.audiences),
                            "assets": [s["asset_id"] for s in hero.stages]}, reason=comment)
    return await admin_view(session, hero)
