"""Что видит ученик и учебные сервисы (INTERNAL_API §1.4, bff.ts «Спринт 3»): только опубликованное (указатели).

- Снимок курса (CourseSnapshot) — курс, модули по порядку, уроки модулей (без ключей ответов: только типы
  контрольных заданий), навыки курса; `snapshot_version` — хеш опубликованных версий (ETag).
- Сценарии — карточки и превью (задача, персонажи, первая реплика и варианты ответа, исходы) без полного графа.
- Медиа — только опубликованные, с правами, действующими сегодня (Asia/Tashkent), с территорией UZ, источник
  разрешён флагом media.external_sources; транскрипт — только при allowed_uses ∋ show_transcript (перевод реплик —
  при ∋ translation), фразы — при ∋ dictionary, аудио — при ∋ listen.
  Аудитория — фильтр (детям 6–13 — только audience ∋ kids).
- Упражнения к медиа (спринт 4, для lessons) — опубликованные упражнения доступного ученику медиа (аудитория и права —
  как у карточки; лицензия разрешает exercises) **без ключей ответов**, с номерами версий для фиксации в сессии.
- Версия контента по номеру (спринт 4, для lessons и assessment) — полное тело **с ключами**: только опубликованная
  или архивная, бывшая опубликованной (черновик, на проверке, одобренная, вытесненная без публикации и
  приостановленная медиа — 404 VERSION_NOT_FOUND, без раскрытия существования). Тело версии неизменяемо (триггер
  content_versions_guard) — вызывающие кешируют ответ бессрочно; в ответе нет изменчивых полей (статус, даты).
  Без номера — текущая опубликованная версия (указатель; меняется — кеш с перепроверкой по ETag).
"""

from __future__ import annotations

import hashlib
import uuid
from datetime import date
from typing import Any, Final

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_catalog.content import band_rank
from tilhero_catalog.domain.common import decode_cursor, encode_cursor
from tilhero_catalog.domain.versions import published_rows
from tilhero_catalog.models import ContentVersion, MediaBlob
from tilhero_common.errors import ApiError, not_found

EXTERNAL_ORIGINS: Final = ("licensed", "platform_embed")
SOURCE_LABELS: Final = {"public_domain": "Общественное достояние"}


def course_not_found(course_id: str) -> ApiError:
    return not_found("COURSE_NOT_FOUND", f"Курс «{course_id}» не опубликован")


def scenario_not_found() -> ApiError:
    return not_found("SCENARIO_NOT_FOUND", "Сценарий не найден")


def media_not_available() -> ApiError:
    return not_found("MEDIA_NOT_AVAILABLE", "Материал недоступен: снят с публикации или права истекли")


# ---------------------------------------------------------------- снимок курса


def _lesson_card(p: dict[str, Any]) -> dict[str, Any]:
    return {
        "lesson_id": p["lesson_id"], "module_id": p["module_id"], "title": p["title"], "goal": p["goal"],
        "level": p["level"], "kind": p["kind"], "duration_min": p["duration_min"],
        "primary_skill_id": p["primary_skill_id"], "scenario_id": p["scenario_id"],
        "stages": [{"type": s["type"], "minutes": s["minutes"]} for s in p["stages"]],
    }


async def course_snapshot(session: AsyncSession, course_id: str) -> dict[str, Any]:
    courses = await published_rows(session, "course", [course_id])
    if not courses:
        raise course_not_found(course_id)
    course = courses[0]
    included = [("course", course.key, course.version)]
    modules = {r.key: r for r in await published_rows(session, "module", course.payload["module_ids"])}
    lesson_ids = [lid for mid in course.payload["module_ids"] if mid in modules
                  for lid in modules[mid].payload["lesson_ids"]]
    lessons = {r.key: r for r in await published_rows(session, "lesson", lesson_ids)}
    skills = [r for r in await published_rows(session, "skill") if r.payload.get("course_id") == course_id]
    out_modules, out_lessons = [], []
    for mid in course.payload["module_ids"]:
        m = modules.get(mid)
        if m is None or m.payload.get("course_id") != course_id:
            continue
        included.append(("module", m.key, m.version))
        out_modules.append({"module_id": m.key, "title": m.payload["title"], "goal": m.payload["goal"],
                            "theme": m.payload["theme"],
                            "lesson_ids": [lid for lid in m.payload["lesson_ids"] if lid in lessons]})
        for lid in m.payload["lesson_ids"]:
            les = lessons.get(lid)
            if les is None:
                continue
            p = les.payload
            included.append(("lesson", les.key, les.version))
            out_lessons.append({
                **_lesson_card(p), "audience": p["audience"], "goals": p["goals"], "topics": p["topics"],
                "secondary_skill_ids": p["secondary_skill_ids"], "prerequisite_skill_ids": p["prerequisite_skill_ids"],
                # ключи ответов ученику и сервисам не отдаются — только типы заданий
                "control_item_types": [item["type"] for item in p["control_items"]],
            })
    skills.sort(key=lambda r: (band_rank(r.payload.get("level")), r.key))
    out_skills = []
    for s in skills:
        included.append(("skill", s.key, s.version))
        p = s.payload
        out_skills.append({"skill_id": s.key, "area": p["area"], "title": p["title"], "level": p["level"],
                           "prerequisites": p["prerequisites"], "diagnostic_tags": p["diagnostic_tags"]})
    digest = hashlib.sha256("|".join(f"{k}:{key}:{v}" for k, key, v in sorted(included)).encode()).hexdigest()
    p = course.payload
    return {
        "course_id": course.key, "pair_id": p["pair_id"], "snapshot_version": digest[:32],
        "title": p["title"], "level_start": p["level_start"], "level_end": p["level_end"],
        "modules": out_modules, "skills": out_skills, "lessons": out_lessons,
    }


# ---------------------------------------------------------------- сценарии


def _scenario_card(p: dict[str, Any]) -> dict[str, Any]:
    return {
        "scenario_id": p["scenario_id"], "title": p["title"], "task": p["task"], "level": p["level"],
        "difficulty": p["difficulty"], "goals": p["goals"], "topics": p["topics"],
        "characters": [{"name": c["name"], "role": c["role"]} for c in p["characters"]],
        "access": p["access"],
    }


def _paginate(items: list[tuple[list[Any], dict[str, Any]]], cursor: str | None, limit: int,
              arity: int) -> dict[str, Any]:
    after = decode_cursor(cursor, arity)
    items.sort(key=lambda t: t[0])
    if after is not None:
        items = [t for t in items if t[0] > after]
    page = items[:limit]
    next_cursor = encode_cursor(*page[-1][0]) if len(items) > limit and page else None
    return {"items": [card for _, card in page], "next_cursor": next_cursor}


async def scenario_cards(session: AsyncSession, *, audience: str, goal: str | None, level: str | None,
                         topic: str | None, cursor: str | None, limit: int) -> dict[str, Any]:
    out: list[tuple[list[Any], dict[str, Any]]] = []
    for row in await published_rows(session, "scenario"):
        p = row.payload
        if audience not in p["audience"]:
            continue
        if (goal and goal not in p["goals"]) or (topic and topic not in p["topics"]) or (level and p["level"] != level):
            continue
        out.append(([band_rank(p["level"]), p["difficulty"], row.key], _scenario_card(p)))
    return _paginate(out, cursor, limit, 3)


async def scenario_detail(session: AsyncSession, scenario_id: str, audience: str) -> dict[str, Any]:
    rows = await published_rows(session, "scenario", [scenario_id])
    if not rows or audience not in rows[0].payload["audience"]:
        raise scenario_not_found()
    p = rows[0].payload
    names = {c["id"]: c["name"] for c in p["characters"]}
    start = p["nodes"][p["start_node"]]
    outcomes: list[dict[str, Any]] = []
    for node_id in sorted(p["nodes"]):
        end = p["nodes"][node_id].get("end")
        if end is not None:
            item = {"outcome": end["outcome"], "summary": end["summary"]}
            if item not in outcomes:
                outcomes.append(item)
    order = {"success": 0, "alt_success": 1, "fail": 2}
    outcomes.sort(key=lambda o: order.get(str(o["outcome"]), 3))
    return {
        **_scenario_card(p),
        "completion": p["completion"]["criteria"],
        "opening": {
            "speaker": names.get(start["speaker"], start["speaker"]), "line_en": start["line_en"],
            "gloss": start["gloss"],
            "replies": [{"description": t["description"], "example_en": (t["examples_en"] or [""])[0]}
                        for t in start["transitions"]],
        },
        "outcomes": outcomes,
    }


# ---------------------------------------------------------------- медиа


def media_available(p: dict[str, Any], today: date, external_sources: bool) -> bool:
    """Права действуют сегодня, территория UZ, источник разрешён флагом (защита в глубину после публикации)."""
    rights = p.get("rights") or {}
    if "UZ" not in (rights.get("territories") or []):
        return False
    try:
        if date.fromisoformat(rights["valid_from"]) > today:
            return False
        if rights.get("valid_to") and date.fromisoformat(rights["valid_to"]) < today:
            return False
    except (KeyError, TypeError, ValueError):
        return False
    return external_sources or (p.get("origin") not in EXTERNAL_ORIGINS and p.get("embed") is None)


def _source_label(p: dict[str, Any]) -> str:
    return SOURCE_LABELS.get(p["origin"]) or str(p["rights"]["owner"])


def _media_card(p: dict[str, Any]) -> dict[str, Any]:
    return {
        "asset_id": p["asset_id"], "type": p["type"], "title": p["title"], "level": p["level"],
        "topics": p["topics"], "duration_s": p["duration_s"], "source_label": _source_label(p),
        "allowed_uses": p["rights"]["allowed_uses"],
        # файл есть и лицензия разрешает прослушивание (иначе плеер и синтез речи не показываются)
        "has_audio": p["audio_blob_id"] is not None and "listen" in p["rights"]["allowed_uses"],
    }


async def _available_media(session: AsyncSession, asset_id: str, audience: str | None, today: date,
                           external_sources: bool) -> ContentVersion:
    rows = await published_rows(session, "media_asset", [asset_id])
    if not rows:
        raise media_not_available()
    p = rows[0].payload
    if not media_available(p, today, external_sources) or (audience is not None and audience not in p["audience"]):
        raise media_not_available()
    return rows[0]


async def media_cards(session: AsyncSession, *, audience: str, media_type: str | None, level: str | None,
                      topic: str | None, cursor: str | None, limit: int, today: date,
                      external_sources: bool) -> dict[str, Any]:
    out: list[tuple[list[Any], dict[str, Any]]] = []
    for row in await published_rows(session, "media_asset"):
        p = row.payload
        if audience not in p["audience"] or not media_available(p, today, external_sources):
            continue
        if (media_type and p["type"] != media_type) or (level and p["level"] != level) or (
                topic and topic not in p["topics"]):
            continue
        out.append(([band_rank(p["level"]), row.key], _media_card(p)))
    return _paginate(out, cursor, limit, 2)


def _voices(transcript: list[dict[str, Any]]) -> dict[str, str]:
    """Голоса синтеза речи устройства по говорящим (в теле медиа голосов нет): по очереди en-GB / en-US."""
    voices: dict[str, str] = {}
    for line in transcript:
        speaker = str(line["speaker"])
        if speaker not in voices:
            voices[speaker] = "en-GB" if len(voices) % 2 == 0 else "en-US"
    return voices


async def media_detail(session: AsyncSession, asset_id: str, audience: str, today: date,
                       external_sources: bool) -> dict[str, Any]:
    row = await _available_media(session, asset_id, audience, today, external_sources)
    p = row.payload
    uses = p["rights"]["allowed_uses"]
    exercises = await published_rows(session, "media_exercise")
    has_exercises = "exercises" in uses and any(e.payload.get("asset_id") == asset_id for e in exercises)
    transcript = None
    if "show_transcript" in uses:
        translate = "translation" in uses  # перевод реплик — отдельное разрешение лицензии
        transcript = [{"t_start_ms": t["t_start_ms"], "t_end_ms": t["t_end_ms"], "speaker": t["speaker"],
                       "text_en": t["text_en"], "gloss": t["gloss"] if translate else None} for t in p["transcript"]]
    phrases = [{"en": ph["en"], "gloss": ph["gloss"]} for ph in p["phrases"]] if "dictionary" in uses else []
    return {
        **_media_card(p),
        "attribution": p["rights"]["attribution"],
        "transcript": transcript,
        "phrases": phrases,
        "voices": _voices(p["transcript"]),
        "exercises_available": has_exercises,
    }


EXERCISE_FIELDS: Final = ("exercise_id", "asset_id", "type", "skill_id", "level", "instruction", "prompt_en",
                          "options", "line_index", "rubric_id")
MAX_MEDIA_EXERCISES: Final = 100


async def media_exercises(session: AsyncSession, asset_id: str, audience: str, today: date,
                          external_sources: bool) -> dict[str, Any]:
    """{asset_id, asset_version, items}: опубликованные упражнения к медиа без `answer` (ключи lessons не нужны —
    оценивает assessment по версии из /versions). Медиа недоступно ученику (аудитория, права сегодня, источник) →
    404 MEDIA_NOT_AVAILABLE; лицензия не разрешает упражнения → пустой список (как exercises_available = false)."""
    row = await _available_media(session, asset_id, audience, today, external_sources)
    items: list[dict[str, Any]] = []
    if "exercises" in row.payload["rights"]["allowed_uses"]:
        for ex in await published_rows(session, "media_exercise"):
            if ex.payload.get("asset_id") != asset_id:
                continue
            item = {f: ex.payload.get(f) for f in EXERCISE_FIELDS}
            item["version"] = ex.version
            items.append(item)
    items.sort(key=lambda i: str(i["exercise_id"]))
    return {"asset_id": row.key, "asset_version": row.version, "items": items[:MAX_MEDIA_EXERCISES]}


RELEASED_STATUSES: Final = ("published", "archived")


async def released_version(session: AsyncSession, kind: str, key: str, version: int) -> ContentVersion:
    """Версия, бывшая опубликованной: published или archived с published_at (archived из approved — вытеснена без
    публикации — не считается). Иначе 404 VERSION_NOT_FOUND одним кодом для «нет» и «не выпущена»."""
    row = (await session.execute(select(ContentVersion).where(
        ContentVersion.kind == kind, ContentVersion.key == key, ContentVersion.version == version,
        ContentVersion.status.in_(RELEASED_STATUSES), ContentVersion.published_at.is_not(None)))).scalar_one_or_none()
    if row is None:
        raise not_found("VERSION_NOT_FOUND", f"Нет опубликованной версии {version} сущности {kind} «{key}»")
    return row


async def current_version(session: AsyncSession, kind: str, key: str) -> ContentVersion:
    """Текущая опубликованная версия ключа (указатель): lessons фиксирует номера версий при старте сессии. Снят с
    публикации, приостановлен (медиа), черновик или нет ключа — 404 VERSION_NOT_FOUND."""
    rows = await published_rows(session, kind, [key])
    if not rows:
        raise not_found("VERSION_NOT_FOUND", f"Сущность {kind} «{key}» не опубликована")
    return rows[0]


def released_view(row: ContentVersion) -> dict[str, Any]:
    """Неизменяемая часть версии: тело с ключами и его хеш (статус и даты меняются — их здесь нет)."""
    return {"kind": row.kind, "key": row.key, "version": row.version, "payload": row.payload,
            "payload_hash": row.payload_hash}


async def media_audio(session: AsyncSession, asset_id: str, audience: str | None, today: date,
                      external_sources: bool) -> MediaBlob:
    row = await _available_media(session, asset_id, audience, today, external_sources)
    p = row.payload
    if p["audio_blob_id"] is None or "listen" not in p["rights"]["allowed_uses"]:
        raise not_found("AUDIO_NOT_FOUND", "У материала нет аудиофайла — используется синтез речи")
    blob = (await session.execute(select(MediaBlob).where(MediaBlob.blob_id == uuid.UUID(p["audio_blob_id"])))
            ).scalar_one_or_none()
    if blob is None:
        raise not_found("AUDIO_NOT_FOUND", "У материала нет аудиофайла — используется синтез речи")
    return blob
