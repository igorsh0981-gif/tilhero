"""Итоги и независимая оценка (INTERNAL_API §2.2 п.5, §3.2): lessons собирает EvaluationRequest (ссылки на версии,
ответы, реплики, подсказки, исход, открытый ответ, practice_only) и НЕ оценивает проверку без подсказок сам —
правильность и навыки определяет assessment по ключам из catalog. Итог (LessonSummary) — из ответа assessment:
EvaluationView, изменения навыков (skill_outcomes + «было» из карты навыков diagnostics + названия из снимка курса).
"""

from __future__ import annotations

import copy
import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_lessons.clients import Evaluation
from tilhero_lessons.domain import flow
from tilhero_lessons.domain.common import iso
from tilhero_lessons.domain.content import Bundle, find_control_item
from tilhero_lessons.models import Session, Step, Turn
from tilhero_lessons.settings import Settings

VIEW_FIELDS = ("evaluation_id", "status", "passed", "task_completed", "scores", "key_errors", "items",
               "practice_only", "rubric_version", "evaluator", "superseded_by", "appeal", "created_at")


async def steps_of(db: AsyncSession, s: Session) -> list[Step]:
    return list((await db.execute(
        select(Step).where(Step.session_id == s.session_id).order_by(Step.seq)
    )).scalars().all())


async def turns_of(db: AsyncSession, s: Session) -> list[Turn]:
    return list((await db.execute(
        select(Turn).where(Turn.session_id == s.session_id).order_by(Turn.seq)
    )).scalars().all())


def build_request(s: Session, steps: list[Step], turns: list[Turn]) -> dict[str, Any]:
    """EvaluationRequest (INTERNAL_API §3.2). Ответы — только проверки без подсказок / упражнений / повтора
    (повторение и проверка понимания на освоение не влияют). answer — как дал ученик: индекс варианта в порядке
    контента | строка пропуска | слова/реплики по порядку (строки) | null («не знаю»). hinted — подсказка на шаге или
    верный ответ, уже показанный ученику в итогах прошлой сессии урока (R2-01, ref.key_seen)."""
    answers = []
    open_answer = None
    roleplay_hints = 0
    for step in steps:
        if step.answered_at is None:
            continue
        if step.type == "item" and step.ref.get("src") in ("lesson", "exercise", "reading"):
            a = step.answer if isinstance(step.answer, dict) else {}
            answers.append({"item_id": step.payload["item"]["item_id"],
                            "answer": None if a.get("dont_know") else a.get("answer"),
                            "hinted": step.hints > 0 or bool(step.ref.get("key_seen")),
                            "dont_know": bool(a.get("dont_know"))})
        elif step.type == "open_answer" and isinstance(step.answer, dict) and step.answer.get("text"):
            open_answer = {"text": step.answer["text"], "prompt": str(step.payload["prompt"]["ru"])[:300]}
        if step.type == "roleplay":
            roleplay_hints += step.hints
    has_roleplay = any(stage["type"] == "roleplay" and stage["units"] for stage in flow.stages(s))
    cv = s.content_versions
    refs: dict[str, Any] = {"lesson": cv.get("lesson"), "scenario": cv.get("scenario"), "rubric": cv.get("rubric"),
                            "media_asset": cv.get("media_asset"),
                            "media_exercises": list(cv.get("media_exercises") or [])}
    if cv.get("reading"):  # спринт 5: вопросы к тексту — по ключам версии текста (рубрика — встроенная assessment)
        refs["reading"] = cv["reading"]
    return {
        "session_id": str(s.session_id), "user_id": str(s.user_id), "kind": s.kind, "pair_id": s.pair_id,
        "audience": s.audience, "locale": s.locale,
        "content_refs": refs,
        "answers": answers,
        "turns": [{"turn_id": t.turn_id, "speaker": t.speaker, "text": t.text, "mode": t.mode, "hinted": t.hinted,
                   "node_id": t.node_id} for t in turns if t.text is not None],
        "roleplay": {"outcome": s.outcome, "hints": roleplay_hints} if has_roleplay else None,
        "open_answer": open_answer,
        "practice_only": s.practice_only,
    }


def sanitize_view(view: dict[str, Any], s: Session, now: datetime) -> dict[str, Any]:
    """EvaluationView (bff.ts) — только поля контракта."""
    out = {k: view.get(k) for k in VIEW_FIELDS}
    out["evaluation_id"] = str(view["evaluation_id"])
    for k in ("scores", "key_errors", "items"):
        value = out[k]
        out[k] = list(value) if isinstance(value, list) else []
    out["practice_only"] = bool(view.get("practice_only", s.practice_only))
    out["rubric_version"] = str(view.get("rubric_version") or "")
    out["created_at"] = view.get("created_at") or iso(now)
    return out


def skill_to(frm: str, outcome: str) -> str:
    """Ожидаемое состояние навыка после оценки (правила diagnostics, INTERNAL_API §5): demonstrated ← демонстрация;
    learning не понижает demonstrated (понижает только переоценка); retained не трогается."""
    if frm == "retained":
        return frm
    if outcome == "demonstrated":
        return "demonstrated"
    if outcome == "learning":
        return "demonstrated" if frm == "demonstrated" else "learning"
    return frm


def skill_changes(outcomes: list[dict[str, Any]], before: dict[str, str] | None,
                  titles: dict[str, Any]) -> list[dict[str, Any]]:
    if before is None:  # карта навыков недоступна — «было» неизвестно, изменения не показываем
        return []
    out = []
    for o in outcomes:
        if o["outcome"] == "not_assessed":
            continue
        frm = before.get(o["skill_id"], "not_started")
        to = skill_to(frm, o["outcome"])
        if to != frm:
            title = titles.get(o["skill_id"]) or {"ru": o["skill_id"], "uz": o["skill_id"]}
            out.append({"skill_id": o["skill_id"], "title": title, "from": frm, "to": to})
    return out


def key_words(s: Session, b: Bundle) -> list[dict[str, Any]]:
    """Слова итогов: урок — ключевые слова; текст для чтения — глоссарий; медиа — фразы (если разрешён словарь)."""
    if b.reading is not None and s.kind == "reading":
        return [{"en": g["en"], "gloss": g["gloss"]} for g in b.reading.get("glossary") or []]
    if b.lesson is not None and s.kind in ("lesson", "review"):
        return [{"en": k["en"], "gloss": k["gloss"]} for k in b.lesson.get("key_words") or []]
    if b.media is not None and "dictionary" in ((b.media.get("rights") or {}).get("allowed_uses") or []):
        return [{"en": p["en"], "gloss": p["gloss"]} for p in b.media.get("phrases") or []]
    return []


def store(s: Session, result: Evaluation, now: datetime) -> dict[str, Any]:
    """Копия актуальной оценки для итогов (EvaluationView) и служебные флаги в summary (наружу не уходят)."""
    clean = sanitize_view(result.view, s, now)
    summary = dict(s.summary or {})
    if summary.get("texts_redacted"):
        clean = redact_evaluation(clean)
    s.evaluation_id = uuid.UUID(clean["evaluation_id"])
    s.evaluation = clean
    s.evaluation_status = "done"
    # повтор ошибок — для урока и медиа; у чтения верный ответ к ошибкам уже показан в итогах, повтора нет
    summary["can_review"] = s.kind != "reading" and any(
        isinstance(i, dict) and i.get("correct") is False for i in clean["items"])
    summary["requires_human_review"] = result.human_review
    s.summary = summary
    return clean


async def apply(db: AsyncSession, s: Session, b: Bundle, result: Evaluation, before: dict[str, str] | None,
                titles: dict[str, Any], now: datetime, settings: Settings) -> None:
    """Оценка получена: сохраняем EvaluationView и изменения навыков; ошибки проверки урока → очередь повторения."""
    clean = store(s, result, now)
    items = [i for i in clean["items"] if isinstance(i, dict)]
    summary = dict(s.summary or {})
    summary["skills"] = ([] if s.practice_only or clean["practice_only"]
                         else skill_changes(result.outcomes, before, titles))
    s.summary = summary
    if s.kind == "lesson" and b.lesson is not None:
        lref = s.content_versions.get("lesson") or {}
        for i in items:
            item = find_control_item(b.lesson, str(i.get("item_id")))
            if item is None or (i.get("correct") is not False and not i.get("hinted")):
                continue
            await flow.queue_review(db, s, lesson_id=str(lref.get("key")), version=int(lref.get("version", 1)),
                                    item_id=item["item_id"], skill_id=str(item.get("skill_id") or ""),
                                    reason="wrong" if i.get("correct") is False else "hinted", now=now,
                                    settings=settings)


def summary_view(s: Session, next_lesson: dict[str, Any] | None) -> dict[str, Any]:
    """LessonSummary (bff.ts)."""
    summary = s.summary or {}
    return {
        "session_id": str(s.session_id), "kind": s.kind, "title": s.title, "status": s.status,
        "outcome": s.outcome if s.status == "completed" else None, "minutes": s.minutes,
        "evaluation": copy.deepcopy(s.evaluation) if s.evaluation else None,
        "skills": list(summary.get("skills") or []),
        "key_words": list(summary.get("key_words") or []),
        "next_lesson": next_lesson,
        "can_review": bool(summary.get("can_review")) and s.status == "completed",
    }


def redact_evaluation(view: dict[str, Any]) -> dict[str, Any]:
    """Через 90 дней: цитаты ученика и исправления (восстанавливают его фразу) в копии оценки стираются (сама оценка
    остаётся в assessment)."""
    out = copy.deepcopy(view)
    for e in out.get("key_errors") or []:
        if isinstance(e, dict):
            e["evidence"] = ""
            e["correction"] = ""
    for i in out.get("items") or []:
        if isinstance(i, dict):
            i["your_answer"] = None
    return out
