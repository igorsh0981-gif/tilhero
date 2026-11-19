"""Справочник языков и языковых пар (ADM-LANG-01/02, APP-LANG-01/02, AT-31).

Новый язык или пара — запись (PUT, upsert; lang.manage, step-up в admin-bff), без изменения кода. Пара видна ученику
«скоро», пока не published; начать её нельзя (409 PAIR_NOT_AVAILABLE — в diagnostics/learning-plan по списку пар).
Перевод в published — только с опубликованным курсом этой пары, уроками, рубриками и проверенными локализациями
(422 PAIR_NOT_READY {missing}); готовность теста диагностики проверяет admin-bff (тест живёт в diagnostics) —
`readiness.diagnostic_test` и `learners` в PairCard заполняет он же.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_catalog.content import Language, LanguagePair
from tilhero_catalog.domain.common import audit_payload, emit_audit, utcnow
from tilhero_catalog.domain.versions import latest_payloads, lock_graph, published_rows
from tilhero_catalog.models import ContentVersion, LanguagePairRow, LanguageRow
from tilhero_common.errors import not_found, unprocessable
from tilhero_common.internal_auth import Actor


def language_view(r: LanguageRow) -> dict[str, Any]:
    return {"code": r.code, "name": r.name, "script": r.script, "variants": r.variants, "asr": r.asr, "tts": r.tts,
            "limitations": r.limitations, "status": r.status}


def pair_view(r: LanguagePairRow) -> dict[str, Any]:
    return {"pair_id": r.pair_id, "source": r.source, "target": r.target,
            "explanation_locales": r.explanation_locales, "ui_locales": r.ui_locales, "title": r.title,
            "status": r.status, "release_at": r.release_at, "course_id": r.course_id}


async def list_languages(session: AsyncSession) -> list[dict[str, Any]]:
    rows = (await session.execute(select(LanguageRow).order_by(LanguageRow.code))).scalars().all()
    return [language_view(r) for r in rows]


async def list_pairs(session: AsyncSession, *, include_archived: bool) -> list[LanguagePairRow]:
    stmt = select(LanguagePairRow).order_by(LanguagePairRow.pair_id)
    if not include_archived:
        stmt = stmt.where(LanguagePairRow.status != "archived")
    return list((await session.execute(stmt)).scalars().all())


async def put_language(session: AsyncSession, code: str, body: Language, actor: Actor) -> dict[str, Any]:
    if body.code != code:
        raise unprocessable("LANGUAGE_CODE_MISMATCH", "Код языка в теле не совпадает с адресом")
    row = (await session.execute(select(LanguageRow).where(LanguageRow.code == code).with_for_update())
           ).scalar_one_or_none()
    data = body.model_dump(mode="json")
    before = None if row is None else {"status": row.status, "script": row.script}
    now = utcnow()
    if row is None:
        row = LanguageRow(**data, updated_by=actor.id, created_at=now, updated_at=now)
        session.add(row)
    else:
        for name, value in data.items():
            setattr(row, name, value)
        row.updated_by = actor.id
        row.updated_at = now
    await session.flush()
    action = "lang.language_created" if before is None else "lang.language_updated"
    await emit_audit(session, audit_payload(actor, action, "language", code, before=before,
                                            after={"status": row.status, "script": row.script}))
    return language_view(row)


# ---------------------------------------------------------------- готовность пары


@dataclass
class ReadinessIndex:
    """Опубликованное по видам — один раз на запрос (для всех пар списка)."""

    by_kind: dict[str, list[ContentVersion]] = field(default_factory=dict)

    @classmethod
    async def load(cls, session: AsyncSession) -> ReadinessIndex:
        index = cls()
        for kind in ("course", "module", "lesson", "skill", "rubric", "scenario", "media_asset"):
            index.by_kind[kind] = await published_rows(session, kind)
        return index

    def readiness(self, pair: LanguagePairRow) -> dict[str, Any]:
        course_id = pair.course_id
        empty = {"skills": 0, "lessons_published": 0, "scenarios_published": 0, "rubrics_published": 0,
                 "media_published": 0, "diagnostic_test": None, "locales_checked_pct": 0}
        if not course_id:
            return {**empty, "media_published": self._media(pair, set())}
        courses = [r for r in self.by_kind["course"] if r.key == course_id]
        modules = [r for r in self.by_kind["module"] if r.payload.get("course_id") == course_id]
        lessons = [r for r in self.by_kind["lesson"] if r.payload.get("course_id") == course_id]
        skills = [r for r in self.by_kind["skill"] if r.payload.get("course_id") == course_id]
        skill_ids = {r.key for r in skills}
        lesson_scenarios = {r.payload.get("scenario_id") for r in lessons}
        scenarios = [r for r in self.by_kind["scenario"]
                     if r.key in lesson_scenarios or skill_ids & set(r.payload.get("skill_ids") or [])]
        rubric_ids = ({r.payload.get("rubric_id") for r in lessons + skills + scenarios})
        rubrics = [r for r in self.by_kind["rubric"] if r.key in rubric_ids]
        entities = courses + modules + lessons + skills
        checked = [r for r in entities if r.locale_checks.get("ru") == "checked"
                   and r.locale_checks.get("uz") == "checked"]
        pct = round(100 * len(checked) / len(entities), 1) if entities else 0
        return {"skills": len(skills), "lessons_published": len(lessons), "scenarios_published": len(scenarios),
                "rubrics_published": len(rubrics), "media_published": self._media(pair, skill_ids),
                "diagnostic_test": None, "locales_checked_pct": pct}

    def _media(self, pair: LanguagePairRow, skill_ids: set[str]) -> int:
        return sum(1 for r in self.by_kind["media_asset"]
                   if r.payload.get("language") == pair.target or skill_ids & set(r.payload.get("skill_ids") or []))

    def missing_for_publish(self, pair: LanguagePairRow) -> list[str]:
        missing: list[str] = []
        course = next((r for r in self.by_kind["course"] if r.key == pair.course_id), None)
        if course is None or course.payload.get("pair_id") != pair.pair_id:
            return ["course"]
        ready = self.readiness(pair)
        if ready["lessons_published"] == 0:
            missing.append("lessons")
        if ready["rubrics_published"] == 0:
            missing.append("rubrics")
        if ready["locales_checked_pct"] < 100:
            missing.append("locales")
        return missing


def pair_card(pair: LanguagePairRow, index: ReadinessIndex) -> dict[str, Any]:
    """PairCard (admin.ts): learners и readiness.diagnostic_test — из diagnostics, их дополняет admin-bff."""
    return {**pair_view(pair), "readiness": index.readiness(pair), "learners": 0}


async def pair_cards(session: AsyncSession) -> list[dict[str, Any]]:
    index = await ReadinessIndex.load(session)
    return [pair_card(p, index) for p in await list_pairs(session, include_archived=True)]


async def put_pair(session: AsyncSession, pair_id: str, body: LanguagePair, reason: str,
                   actor: Actor) -> dict[str, Any]:
    if body.pair_id != pair_id:
        raise unprocessable("PAIR_ID_MISMATCH", "Идентификатор пары в теле не совпадает с адресом")
    if body.source == body.target:
        raise unprocessable("PAIR_INVALID", "Язык объяснений и изучаемый язык совпадают")
    known = set((await session.execute(select(LanguageRow.code).where(
        LanguageRow.code.in_([body.source, body.target])))).scalars().all())
    for field_name, code in (("source", body.source), ("target", body.target)):
        if code not in known:
            raise unprocessable("UNKNOWN_LANGUAGE", f"Язык «{code}» не найден в справочнике", {"field": field_name})
    await lock_graph(session)  # готовность курса проверяется под общей блокировкой графа (снятие курса ждёт)
    if body.course_id is not None:
        course = (await latest_payloads(session, [("course", body.course_id)])).get(("course", body.course_id))
        if course is None:
            raise unprocessable("UNKNOWN_REF", f"Курс «{body.course_id}» не существует", {"field": "course_id"})
        if course.get("pair_id") != pair_id:
            raise unprocessable("PAIR_INVALID", "Курс относится к другой языковой паре", {"field": "course_id"})
    row = (await session.execute(select(LanguagePairRow).where(LanguagePairRow.pair_id == pair_id)
                                 .with_for_update())).scalar_one_or_none()
    data = body.model_dump(mode="json")
    before = None if row is None else {"status": row.status, "course_id": row.course_id}
    now = utcnow()
    if row is None:
        row = LanguagePairRow(**data, updated_by=actor.id, created_at=now, updated_at=now)
        session.add(row)
    else:
        for name, value in data.items():
            setattr(row, name, value)
        row.updated_by = actor.id
        row.updated_at = now
    index = await ReadinessIndex.load(session)
    # публикация пары и смена курса у опубликованной — одна и та же проверка готовности
    if body.status == "published" and (before is None or before["status"] != "published"
                                       or before["course_id"] != body.course_id):
        missing = index.missing_for_publish(row)
        if missing:
            raise unprocessable("PAIR_NOT_READY", "Пара не готова к публикации", {"missing": missing})
    await session.flush()
    action = "lang.pair_created" if before is None else "lang.pair_updated"
    await emit_audit(session, audit_payload(actor, action, "language_pair", pair_id, before=before,
                                            after={"status": row.status, "course_id": row.course_id}, reason=reason))
    return pair_card(row, index)


async def get_pair(session: AsyncSession, pair_id: str) -> LanguagePairRow:
    row = await session.get(LanguagePairRow, pair_id)
    if row is None:
        raise not_found("PAIR_NOT_FOUND", "Языковая пара не найдена")
    return row
