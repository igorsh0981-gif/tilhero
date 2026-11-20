"""Тексты для чтения ученику и задания проверок удержания (INTERNAL_API §2.1, §2.4).

- Карточки и текст — только опубликованные версии (указатели), аудитория — фильтр (детям — только тексты [kids]).
  Ответов на вопросы в выдаче нет: ключи lessons и assessment берут из `/versions/reading/{key}/{version}`.
- Тексты на изучаемом английском: с `pair_id` выдаются только для пар с target = en.
- Задания проверки удержания (memory): контрольные задания опубликованных уроков курса пары с primary_skill_id =
  навык и подходящей аудиторией, с ключами. Сначала задания самого навыка, затем остальные задания этих уроков (у
  урока навыка их обычно 1–3 из 5, а проверке нужно 3) — по уроку и порядку в уроке; не больше 20.
"""

from __future__ import annotations

from typing import Any, Final

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_catalog.content import band_rank
from tilhero_catalog.domain.common import decode_cursor, encode_cursor
from tilhero_catalog.domain.text import word_count
from tilhero_catalog.domain.versions import published_rows
from tilhero_catalog.models import ContentVersion, LanguagePairRow
from tilhero_common.errors import ApiError, not_found

READING_TARGET: Final = "en"
MAX_CHECK_ITEMS: Final = 20
QUESTION_FIELDS: Final = ("question_id", "type", "instruction", "prompt_en", "options")


def reading_not_available() -> ApiError:
    return not_found("READING_NOT_AVAILABLE", "Текст недоступен")


def words_of(p: dict[str, Any]) -> int:
    return sum(word_count(str(s["text_en"])) for para in p["paragraphs"] for s in para["sentences"])


def _card(row: ContentVersion) -> dict[str, Any]:
    p = row.payload
    return {"reading_id": p["reading_id"], "version": row.version, "title": p["title"], "level": p["level"],
            "topics": p["topics"], "est_minutes": p["est_minutes"], "word_count": words_of(p)}


async def _pair_reads_english(session: AsyncSession, pair_id: str | None) -> bool:
    if pair_id is None:
        return True
    target = await session.scalar(select(LanguagePairRow.target).where(LanguagePairRow.pair_id == pair_id))
    return target == READING_TARGET


async def reading_cards(session: AsyncSession, *, audience: str, pair_id: str | None, level: str | None,
                        cursor: str | None, limit: int) -> dict[str, Any]:
    """Page<карточка>: {reading_id, version, title, level, topics, est_minutes, word_count} — уровень по возрастанию,
    затем ключ. last_result (ReadingCard в bff.ts) дополняет telegram-bff из lessons."""
    after = decode_cursor(cursor, 2)
    if not await _pair_reads_english(session, pair_id):
        return {"items": [], "next_cursor": None}
    out: list[tuple[list[Any], dict[str, Any]]] = []
    for row in await published_rows(session, "reading"):
        p = row.payload
        if audience not in p["audience"] or (level and p["level"] != level):
            continue
        out.append(([band_rank(p["level"]), row.key], _card(row)))
    out.sort(key=lambda t: t[0])
    if after is not None:
        out = [t for t in out if t[0] > after]
    page = out[:limit]
    next_cursor = encode_cursor(*page[-1][0]) if len(out) > limit and page else None
    return {"items": [card for _, card in page], "next_cursor": next_cursor}


async def reading_detail(session: AsyncSession, reading_id: str, audience: str) -> dict[str, Any]:
    """Опубликованная версия текста без ответов: абзацы с переводом предложений, глоссарий (подсветка), вопросы без
    `answer`. in_dictionary глоссария (ReadingView) дополняет telegram-bff из memory."""
    rows = await published_rows(session, "reading", [reading_id])
    if not rows or audience not in rows[0].payload["audience"]:
        raise reading_not_available()
    row = rows[0]
    p = row.payload
    questions = [{f: q[f] for f in QUESTION_FIELDS} for q in p["questions"]]
    return {
        **_card(row),
        "skill_ids": p["skill_ids"], "voice": p["voice"],
        "paragraphs": p["paragraphs"],
        "glossary": [{"en": g["en"], "gloss": g["gloss"], "note": g["note"]} for g in p["glossary"]],
        "questions": questions,
        "questions_count": len(questions),
        "question_types": list(dict.fromkeys(q["type"] for q in questions)),
    }


async def _courses_of_pair(session: AsyncSession, pair_id: str) -> set[str]:
    courses = {r.key for r in await published_rows(session, "course") if r.payload.get("pair_id") == pair_id}
    linked = await session.scalar(select(LanguagePairRow.course_id).where(LanguagePairRow.pair_id == pair_id))
    if linked:
        courses.add(str(linked))
    return courses


async def check_items(session: AsyncSession, skill_id: str, audience: str, pair_id: str | None) -> dict[str, Any]:
    """{skill_id, title, items: [{lesson_id, version, item: ControlItem с ключом}]} — для проверок удержания."""
    skills = await published_rows(session, "skill", [skill_id])
    if not skills:
        raise not_found("SKILL_NOT_FOUND", "Навык не опубликован")
    courses = await _courses_of_pair(session, pair_id) if pair_id else None
    lessons = sorted((r for r in await published_rows(session, "lesson")
                      if r.payload.get("primary_skill_id") == skill_id and audience in r.payload.get("audience", [])
                      and (courses is None or r.payload.get("course_id") in courses)), key=lambda r: r.key)
    own: list[dict[str, Any]] = []
    other: list[dict[str, Any]] = []
    for row in lessons:
        for item in row.payload.get("control_items") or []:
            entry = {"lesson_id": row.key, "version": row.version, "item": item}
            (own if item.get("skill_id") == skill_id else other).append(entry)
    return {"skill_id": skill_id, "title": skills[0].payload["title"], "items": [*own, *other][:MAX_CHECK_ITEMS]}
