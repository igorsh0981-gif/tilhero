"""Ход занятия (оркестратор `learning_orchestrator` — код, не LLM): этапы плана, шаги s{n}, ответы, подсказки,
«объясни проще», ролевая ситуация по графу сценария.

План (sessions.plan) фиксируется при старте: {"stages": [{"type", "units": [...]}]}. Единицы:
  notice | item {src: retrieval|lesson|exercise} | explanation | meaning | roleplay | open_answer | listen | done;
  спринт 5 (чтение): reading (текст) | question {question_id} (вопрос на понимание — без подсказок, оценивает
  assessment по ключам версии текста).
Шаг материализуется, когда становится текущим (sessions.step_index), и дальше неизменяем: payload — ровно то, что
видит ученик (без ключей), ref — служебная ссылка (ключ проверки понимания, соответствие вариантов реплик).
Положение — sessions.state: {"cursor": {stage, unit}, "turns": n, "rp": {...}, "simpler": n, "ai_off": stage|"all"}.

Ролевая ситуация: узел графа → шаг roleplay (варианты = examples_en[0] переходов, перемешаны по seed сессии);
выбор → переход графа; свободный текст (ai_mode full, не ребёнок) → conversation_partner относит его к переходу
(или unclear/off_topic → уточнение, после 2 подряд — только варианты); ИИ недоступен → «Давайте выберем ответ»
(варианты), сессия ai_degraded, ИИ не вызывается до конца этапа. Конец графа → roleplay_end с исходом; fail →
одна повторная попытка с ближайшей точки восстановления. После паузы — продолжение с ближайшей точки восстановления.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common.errors import ApiError, conflict
from tilhero_lessons.clients import AgentResult
from tilhero_lessons.domain.common import (
    Localized,
    answer_invalid,
    hints_not_allowed,
    loc,
    seeded_order,
    session_state,
    step_not_current,
)
from tilhero_lessons.domain.content import (
    Bundle,
    character,
    control_item_view,
    correct_text,
    distance_to_end,
    exercise_view,
    find_control_item,
    find_question,
    grade_control_item,
    item_hint,
    item_view,
    question_view,
    reading_view,
    validate_answer,
    voices,
)
from tilhero_lessons.models import ReviewItem, Session, Step, Turn
from tilhero_lessons.settings import Settings

STAGES_BY_KIND: dict[str, list[str]] = {
    "lesson": ["retrieval", "explanation", "roleplay", "assessment", "summary"],
    "scenario": ["roleplay", "summary"],
    "media": ["listen", "exercises", "summary"],
    "review": ["assessment", "summary"],
    "reading": ["reading", "questions", "summary"],
    "duel": ["assessment", "summary"],
}
HISTORY_IN_STEP = 10
HISTORY_FOR_AI = 6
UNCLEAR_LIMIT = 2
OPEN_ANSWER_MAX = 300
REPLY_MAX = 240

NOTICE_NOTHING = loc("Повторять пока нечего — сразу переходим к новой теме.",
                     "Hozircha takrorlash uchun hech narsa yoʻq — yangi mavzuga oʻtamiz.")
LETS_CHOOSE_EN = "Let's choose an answer."
LETS_CHOOSE = loc("Давайте выберем ответ", "Keling, javobni tanlaymiz")
SAY_AGAIN_EN = "Sorry, could you say that again?"
MEANING_INSTRUCTION = loc("Что значит это слово или фраза? Выберите перевод.",
                          "Bu soʻz yoki ibora nimani anglatadi? Tarjimasini tanlang.")


# ---------------------------------------------------------------- состояние


def st(s: Session) -> dict[str, Any]:
    return dict(s.state or {})


def put(s: Session, **changes: Any) -> None:
    """JSONB state меняется только присваиванием нового словаря (отслеживание изменений SQLAlchemy)."""
    s.state = {**st(s), **changes}


def rp(s: Session) -> dict[str, Any]:
    return dict(st(s).get("rp") or {})


def put_rp(s: Session, **changes: Any) -> None:
    put(s, rp={**rp(s), **changes})


def stages(s: Session) -> list[dict[str, Any]]:
    return list(s.plan.get("stages") or [])


def cursor(s: Session) -> tuple[int, int]:
    c = st(s).get("cursor") or {}
    return int(c.get("stage", 0)), int(c.get("unit", 0))


def ai_off(s: Session, stage: str) -> bool:
    return st(s).get("ai_off") in (stage, "all")


def text_allowed(s: Session, unclear: int) -> bool:
    return s.ai_mode == "full" and s.audience != "kids" and not ai_off(s, "roleplay") and unclear < UNCLEAR_LIMIT


def stage_views(s: Session) -> list[dict[str, Any]]:
    """LessonSession.stages: done | current | pending | skipped (пустой этап, «повторять нечего»)."""
    out = []
    cur_stage, _ = cursor(s)
    started = s.step_index > 0
    for i, stage in enumerate(stages(s)):
        units = stage.get("units") or []
        empty = not units or (stage["type"] == "retrieval" and units[0].get("t") == "notice")
        if s.status == "completed":
            status = "skipped" if empty else "done"
        elif started and i < cur_stage:
            status = "skipped" if empty else "done"
        elif started and i == cur_stage:
            status = "current"
        else:
            status = "skipped" if empty else "pending"
        out.append({"type": stage["type"], "status": status})
    return out


# ---------------------------------------------------------------- шаги и реплики


async def step_at(db: AsyncSession, s: Session, seq: int) -> Step | None:
    if seq < 1:
        return None
    return await db.get(Step, (s.session_id, seq))


async def current_step(db: AsyncSession, s: Session) -> Step | None:
    return await step_at(db, s, s.step_index)


async def step_by_id(db: AsyncSession, s: Session, step_id: str) -> Step | None:
    return (await db.execute(
        select(Step).where(Step.session_id == s.session_id, Step.step_id == step_id)
    )).scalar_one_or_none()


def _add_step(db: AsyncSession, s: Session, stage: str, type_: str, payload: dict[str, Any], ref: dict[str, Any],
              now: datetime) -> Step:
    seq = s.step_index + 1
    step = Step(session_id=s.session_id, seq=seq, step_id=f"s{seq}", stage=stage, type=type_, payload=payload,
                ref=ref, hints=0, created_at=now)
    db.add(step)
    s.step_index = seq
    s.stage = stage
    return step


def _add_turn(db: AsyncSession, s: Session, *, step_seq: int, node_id: str, speaker: str, mode: str,
              text: str | None, now: datetime, intent: str | None = None, character_id: str | None = None,
              hinted: bool = False, ai_call_id: str | None = None) -> Turn:
    n = int(st(s).get("turns", 0)) + 1
    put(s, turns=n)
    turn = Turn(session_id=s.session_id, seq=n, turn_id=f"T{n}", step_seq=step_seq,
                attempt=int(rp(s).get("attempt", 1)), node_id=node_id, speaker=speaker, character_id=character_id,
                mode=mode, text=(text or "")[:500], intent=intent, hinted=hinted, ai_call_id=ai_call_id,
                created_at=now)
    db.add(turn)
    return turn


def mark_answered(step: Step, answer: Any, result: str | None, response: dict[str, Any], now: datetime) -> None:
    step.answer = answer
    step.result = result
    step.response = response
    step.answered_at = now


# ---------------------------------------------------------------- материализация


def _lesson_stage(b: Bundle, stage_type: str) -> dict[str, Any]:
    assert b.lesson is not None
    return next((x for x in b.lesson.get("stages") or [] if x.get("type") == stage_type),
                {"type": stage_type, "minutes": 1, "instructions": loc("", "")})


async def enter_unit(db: AsyncSession, s: Session, b: Bundle, stage_i: int, unit_i: int, now: datetime) -> Step:
    plan = stages(s)
    stage = plan[stage_i]
    units = stage["units"]
    unit = units[unit_i]
    if cursor(s)[0] != stage_i and st(s).get("ai_off") not in (None, "all"):
        put(s, ai_off=None)  # ИИ выключен только до конца этапа (INTERNAL_API §2.2)
    put(s, cursor={"stage": stage_i, "unit": unit_i})
    base = {"position": unit_i + 1, "stage_total": len(units)}
    t = unit["t"]
    stype = stage["type"]
    if t == "roleplay":
        assert b.scenario is not None
        put(s, rp={"attempt": 1, "path": [], "count": 0, "unclear": 0, "retry_used": False, "outcome": None})
        return await enter_node(db, s, b, str(b.scenario["start_node"]), now)
    if t == "notice":
        return _add_step(db, s, stype, "notice", {**base, "text": unit.get("text") or NOTICE_NOTHING}, {}, now)
    if t == "explanation":
        assert b.lesson is not None
        payload = {**base, "instructions": _lesson_stage(b, "explanation")["instructions"],
                   "examples": [{"en": e["en"], "gloss": e["gloss"]} for e in b.lesson.get("examples") or []],
                   "key_words": [{"en": k["en"], "gloss": k["gloss"], "example_en": k["example_en"]}
                                 for k in b.lesson.get("key_words") or []],
                   "can_simplify": bool(lesson_examples(b))}
        return _add_step(db, s, stype, "explanation", payload, {}, now)
    if t == "meaning":
        assert b.lesson is not None
        words = b.lesson["key_words"]
        word = words[int(unit["word"])]
        options = [str(words[int(i)]["gloss"][s.locale]) for i in unit["options"]]
        view = item_view(f"kw-{int(unit['word']) + 1}", "meaning_check", MEANING_INSTRUCTION, word["en"], options)
        return _add_step(db, s, stype, "item",
                         {**base, "item": view, "hint_available": True, "graded_later": False},
                         {"src": "meaning", "word": int(unit["word"]), "correct": int(unit["correct"])}, now)
    if t == "item":
        if unit["src"] == "retrieval":
            lesson = b.retrieval[(unit["key"], int(unit["version"]))]
            item = find_control_item(lesson, unit["item_id"])
            assert item is not None
            return _add_step(db, s, stype, "item",
                             {**base, "item": control_item_view(item, s.seed), "hint_available": True,
                              "graded_later": False},
                             {"src": "retrieval", "key": unit["key"], "version": int(unit["version"]),
                              "item_id": unit["item_id"], "skill_id": item.get("skill_id"),
                              "review_item_id": unit.get("review_item_id")}, now)
        assert b.lesson is not None
        item = find_control_item(b.lesson, unit["item_id"])
        assert item is not None
        # key_seen — верный ответ ученик видел в итогах прошлой сессии урока (R2-01): в оценку — как подсказка
        ref = {"src": "lesson", "item_id": unit["item_id"], **({"key_seen": True} if unit.get("key_seen") else {})}
        return _add_step(db, s, stype, "item",
                         {**base, "item": control_item_view(item, s.seed), "hint_available": False,
                          "graded_later": True}, ref, now)
    if t == "duel_item":
        # задание дуэли (спринт 7): без подсказок и ИИ, правильность не показывается; варианты перемешаны по seed
        # набора — у обоих участников одинаково
        n = int(unit["n"])
        item = b.duel[n]["item"]
        return _add_step(db, s, stype, "item",
                         {**base, "item": control_item_view(item, b.duel_seed), "hint_available": False,
                          "graded_later": True},
                         {"src": "duel", "n": n}, now)
    if t == "exercise":
        ex = b.exercises[unit["key"]]
        return _add_step(db, s, stype, "item",
                         {**base, "item": exercise_view(ex, s.seed), "hint_available": False,
                          "graded_later": True},
                         {"src": "exercise", "key": unit["key"]}, now)
    if t == "reading":
        assert b.reading is not None
        version = int((s.content_versions.get("reading") or {}).get("version", 1))
        return _add_step(db, s, stype, "reading", {**base, "reading": reading_view(b.reading, version)}, {}, now)
    if t == "question":
        # вопрос на понимание текста: без подсказок, правильность — только в итогах (оценивает assessment)
        assert b.reading is not None
        question = find_question(b.reading, unit["question_id"])
        assert question is not None
        return _add_step(db, s, stype, "item",
                         {**base, "item": question_view(question), "hint_available": False, "graded_later": True},
                         {"src": "reading", "question_id": unit["question_id"]}, now)
    if t == "open_answer":
        assert b.lesson is not None
        goal = b.lesson["goal"]
        # формулировка — как в золотых кейсах оценщика; ответ на английском, ≤ 300 символов
        prompt = loc(f"Напишите 2–3 предложения по задаче урока: «{goal['ru']}»",
                     f"Dars vazifasi boʻyicha 2–3 ta gap yozing: «{goal['uz']}»")
        return _add_step(db, s, stype, "open_answer", {**base, "prompt": prompt, "max_length": OPEN_ANSWER_MAX},
                         {}, now)
    if t == "listen":
        assert b.media is not None
        m = b.media
        uses = (m.get("rights") or {}).get("allowed_uses") or []
        transcript = None
        if "show_transcript" in uses:
            translate = "translation" in uses
            transcript = [{"speaker": str(x["speaker"]), "text_en": x["text_en"],
                           "gloss": x["gloss"] if translate else None} for x in m.get("transcript") or []]
        payload = {**base, "asset_id": m["asset_id"], "title": m["title"],
                   "has_audio": m.get("audio_blob_id") is not None and "listen" in uses,
                   "transcript": transcript, "voices": voices(m.get("transcript") or []),
                   "can_listen": "listen" in uses}
        return _add_step(db, s, stype, "listen", payload, {}, now)
    if t == "done":
        return _add_step(db, s, stype, "done", base, {}, now)
    raise ValueError(f"unknown unit {t}")


def next_position(s: Session) -> tuple[int, int] | None:
    plan = stages(s)
    stage_i, unit_i = cursor(s)
    if unit_i + 1 < len(plan[stage_i]["units"]):
        return stage_i, unit_i + 1
    for j in range(stage_i + 1, len(plan)):
        if plan[j]["units"]:
            return j, 0
    return None


async def advance(db: AsyncSession, s: Session, b: Bundle, now: datetime) -> Step:
    pos = next_position(s)
    if pos is None:  # после «done» шагов нет — защищено проверками выше
        raise session_state(s.status)
    return await enter_unit(db, s, b, pos[0], pos[1], now)


async def first_step(db: AsyncSession, s: Session, b: Bundle, now: datetime) -> Step:
    plan = stages(s)
    first = next(i for i, stage in enumerate(plan) if stage["units"])
    return await enter_unit(db, s, b, first, 0, now)


# ---------------------------------------------------------------- отображение


async def render(db: AsyncSession, s: Session, step: Step) -> dict[str, Any]:
    """LessonStep (bff.ts): только поля контракта — служебных (turn_mark, ref) нет."""
    p = step.payload
    out: dict[str, Any] = {"step_id": step.step_id, "stage": step.stage, "position": p["position"],
                           "stage_total": p["stage_total"], "type": step.type}
    if step.type == "notice":
        out["text"] = p["text"]
    elif step.type == "explanation":
        out.update({k: p[k] for k in ("instructions", "examples", "key_words", "can_simplify")})
    elif step.type == "item":
        out.update({"item": p["item"], "hint_available": p["hint_available"], "hints_used": step.hints,
                    "graded_later": p["graded_later"]})
    elif step.type == "roleplay":
        out.update({k: p[k] for k in ("node_id", "character", "line_en", "gloss", "choices", "free_text_allowed",
                                      "hint_available", "unclear_attempts")})
        out["hints_used"] = step.hints
        out["history"] = await history(db, s, int(p["attempt"]), int(p["turn_mark"]), HISTORY_IN_STEP)
    elif step.type == "roleplay_end":
        out.update({k: p[k] for k in ("outcome", "summary", "can_retry")})
    elif step.type == "listen":
        out.update({k: p[k] for k in ("asset_id", "title", "has_audio", "transcript", "voices", "can_listen")})
    elif step.type == "open_answer":
        out.update({"prompt": p["prompt"], "max_length": p["max_length"]})
    elif step.type == "reading":
        out["reading"] = p["reading"]
    return out


async def history(db: AsyncSession, s: Session, attempt: int, upto: int, limit: int) -> list[dict[str, Any]]:
    rows = (await db.execute(
        select(Turn).where(Turn.session_id == s.session_id, Turn.attempt == attempt, Turn.seq <= upto)
        .order_by(Turn.seq.desc()).limit(limit)
    )).scalars().all()
    return [{"turn_id": t.turn_id, "speaker": t.speaker, "text_en": t.text or "", "character_id": t.character_id}
            for t in reversed(rows)]


async def ai_history(db: AsyncSession, s: Session, step: Step) -> list[dict[str, str]]:
    """Контекст conversation_partner: ≤ 6 последних реплик сцены (только текущая попытка)."""
    rows = await history(db, s, int(step.payload["attempt"]), int(step.payload["turn_mark"]), HISTORY_FOR_AI)
    return [{"speaker": r["speaker"], "text": r["text_en"]} for r in rows if r["text_en"]]


# ---------------------------------------------------------------- ролевая ситуация


async def enter_node(db: AsyncSession, s: Session, b: Bundle, node_id: str, now: datetime,
                     *, announce: bool = True) -> Step:
    """Узел графа → шаг roleplay (или roleplay_end у конечного). announce — реплика узла записывается как реплика
    персонажа (не записывается при повторе узла после уточнения)."""
    assert b.scenario is not None
    scn = b.scenario
    node = scn["nodes"][node_id]
    state = rp(s)
    seq = s.step_index + 1
    turn_mark = int(st(s).get("turns", 0))
    if announce:
        _add_turn(db, s, step_seq=seq, node_id=node_id, speaker="character", mode="choice", text=node["line_en"],
                  character_id=node["speaker"], now=now)
        state["path"] = [*state.get("path", []), node_id]
    count = int(state.get("count", 0)) + 1
    state["count"] = count
    end = node.get("end")
    if end is not None:
        outcome = str(end["outcome"])
        state["outcome"] = outcome
        s.outcome = outcome
        can_retry = outcome == "fail" and not state.get("retry_used") and recovery_node(scn, state) is not None
        put(s, rp=state)
        return _add_step(db, s, "roleplay", "roleplay_end",
                         {"position": count, "stage_total": count, "outcome": outcome, "summary": end["summary"],
                          "can_retry": can_retry, "attempt": state.get("attempt", 1)},
                         {"node_id": node_id}, now)
    transitions = node.get("transitions") or []
    ordered = seeded_order(s.seed, f"choices:{node_id}", transitions, key=lambda t: str(t["intent"]))
    choices = [{"choice_id": f"c{i + 1}", "text_en": str((t.get("examples_en") or [""])[0])}
               for i, t in enumerate(ordered)]
    unclear = int(state.get("unclear", 0))
    put(s, rp=state)
    payload = {"position": count, "stage_total": count + distance_to_end(scn, node_id), "node_id": node_id,
               "character": character(scn, node["speaker"]), "line_en": node["line_en"], "gloss": node["gloss"],
               "choices": choices, "free_text_allowed": text_allowed(s, unclear), "hint_available": True,
               "unclear_attempts": unclear, "turn_mark": turn_mark, "attempt": int(state.get("attempt", 1))}
    ref = {"node_id": node_id, "choices": {f"c{i + 1}": str(t["intent"]) for i, t in enumerate(ordered)}}
    return _add_step(db, s, "roleplay", "roleplay", payload, ref, now)


def recovery_node(scn: dict[str, Any], state: dict[str, Any]) -> str | None:
    """Ближайшая (последняя пройденная) точка восстановления текущей попытки."""
    for node_id in reversed(state.get("path") or []):
        node = scn["nodes"].get(node_id) or {}
        if node.get("recovery_point") and node.get("end") is None:
            return str(node_id)
    return None


def _transition(scn: dict[str, Any], node_id: str, intent: str) -> dict[str, Any] | None:
    for t in scn["nodes"][node_id].get("transitions") or []:
        if t.get("intent") == intent:
            return dict(t)
    return None


async def roleplay_choice(db: AsyncSession, s: Session, b: Bundle, step: Step, choice_id: str,
                          now: datetime) -> tuple[dict[str, Any], Step]:
    assert b.scenario is not None
    intent = (step.ref.get("choices") or {}).get(choice_id)
    if intent is None:
        raise answer_invalid("choice_id", "Такого варианта ответа нет")
    node_id = step.payload["node_id"]
    t = _transition(b.scenario, node_id, intent)
    assert t is not None
    _add_turn(db, s, step_seq=step.seq, node_id=node_id, speaker="learner", mode="choice",
              text=str((t.get("examples_en") or [""])[0]), intent=intent, hinted=step.hints > 0, now=now)
    put_rp(s, unclear=0)
    nxt = await enter_node(db, s, b, str(t["to"]), now)
    target = b.scenario["nodes"][t["to"]]
    reply = {"character_id": target["speaker"], "text_en": target["line_en"], "gloss": target["gloss"],
             "clarification": False}
    return reply, nxt


async def roleplay_text(db: AsyncSession, s: Session, b: Bundle, step: Step, text: str, ai: AgentResult,
                        now: datetime) -> tuple[dict[str, Any], Step]:
    """Свободная реплика: переход по намерению conversation_partner; unclear/off_topic — уточнение на том же узле;
    unavailable/refused — «Давайте выберем ответ» (дальше только варианты до конца этапа).
    `hint_offered: true` (персонаж подсказал в ответе) — как явная подсказка (R1-06): реплика ученика и шаг
    отмечаются подсказанными и попадают в hint_usage оценки (подсказки ролевой ситуации, независимость)."""
    assert b.scenario is not None
    scn = b.scenario
    node_id = step.payload["node_id"]
    node = scn["nodes"][node_id]
    hinted = step.hints > 0
    if ai.status == "ok" and ai.output is not None:
        s.ai_used = True
        if ai.output.get("hint_offered") is True:
            step.hints += 1
            s.hints_used += 1
            hinted = True
        intent = str(ai.output.get("intent") or "unclear")[:64]
        reply_en = str(ai.output.get("reply_en") or "").strip()[:REPLY_MAX]
        t = _transition(scn, node_id, intent)
        _add_turn(db, s, step_seq=step.seq, node_id=node_id, speaker="learner", mode="text", text=text,
                  intent=intent if t is not None or intent in ("unclear", "off_topic") else "unclear",
                  hinted=hinted, ai_call_id=ai.request_id, now=now)
        if t is not None:
            put_rp(s, unclear=0)
            if reply_en:
                _add_turn(db, s, step_seq=step.seq, node_id=node_id, speaker="character", mode="text",
                          text=reply_en, character_id=node["speaker"], ai_call_id=ai.request_id, now=now)
            nxt = await enter_node(db, s, b, str(t["to"]), now)
            target = scn["nodes"][t["to"]]
            reply = ({"character_id": node["speaker"], "text_en": reply_en, "gloss": None, "clarification": False}
                     if reply_en else
                     {"character_id": target["speaker"], "text_en": target["line_en"], "gloss": target["gloss"],
                      "clarification": False})
            return reply, nxt
        question = reply_en or SAY_AGAIN_EN
        _add_turn(db, s, step_seq=step.seq, node_id=node_id, speaker="character", mode="text", text=question,
                  character_id=node["speaker"], ai_call_id=ai.request_id, now=now)
        put_rp(s, unclear=int(rp(s).get("unclear", 0)) + 1)
        nxt = await enter_node(db, s, b, node_id, now, announce=False)
        return {"character_id": node["speaker"], "text_en": question, "gloss": None, "clarification": True}, nxt
    # ИИ недоступен (выключен, бюджет, сбой) или отказал: продолжаем выбором реплик, ученик не видит ошибку
    _add_turn(db, s, step_seq=step.seq, node_id=node_id, speaker="learner", mode="text", text=text, intent=None,
              hinted=hinted, ai_call_id=ai.request_id, now=now)
    if ai.status == "refused":
        put(s, ai_off="all")
    else:
        s.ai_degraded = True
        put(s, ai_off="roleplay")
    nxt = await enter_node(db, s, b, node_id, now, announce=False)
    return {"character_id": node["speaker"], "text_en": LETS_CHOOSE_EN, "gloss": LETS_CHOOSE,
            "clarification": True}, nxt


async def roleplay_retry(db: AsyncSession, s: Session, b: Bundle, step: Step, now: datetime) -> Step:
    """Одна повторная попытка после исхода fail — с ближайшей точки восстановления (AT-43)."""
    assert b.scenario is not None
    if step.type != "roleplay_end" or step.answered_at is not None or not step.payload.get("can_retry"):
        raise conflict("RETRY_NOT_AVAILABLE", "Повторная попытка недоступна")
    target = recovery_node(b.scenario, rp(s))
    if target is None:
        raise conflict("RETRY_NOT_AVAILABLE", "Повторная попытка недоступна")
    mark_answered(step, {"retry": True}, None, {"feedback": None, "reply": None, "next_seq": step.seq + 1}, now)
    put(s, rp={"attempt": 2, "path": [], "count": 0, "unclear": 0, "retry_used": True, "outcome": None})
    s.outcome = None
    return await enter_node(db, s, b, target, now)


async def rewind_roleplay(db: AsyncSession, s: Session, b: Bundle, now: datetime) -> None:
    """После паузы ролевая ситуация продолжается с ближайшей точки восстановления (AT-42)."""
    step = await current_step(db, s)
    if step is None or step.type != "roleplay" or step.answered_at is not None or b.scenario is None:
        return
    scn = b.scenario
    node_id = str(step.payload["node_id"])
    if scn["nodes"][node_id].get("recovery_point"):
        return
    state = rp(s)
    path = list(state.get("path") or [])
    target, cut = str(scn["start_node"]), 0
    for i in range(len(path) - 1, -1, -1):
        if scn["nodes"].get(path[i], {}).get("recovery_point"):
            target, cut = str(path[i]), i
            break
    mark_answered(step, {"rewound": True}, "skipped", {"feedback": None, "reply": None, "next_seq": step.seq + 1},
                  now)
    put_rp(s, path=path[:cut], unclear=0)
    await enter_node(db, s, b, target, now)


# ---------------------------------------------------------------- задания, подсказки


async def queue_review(db: AsyncSession, s: Session, *, lesson_id: str, version: int, item_id: str,
                       skill_id: str, reason: str, now: datetime, settings: Settings) -> None:
    """Очередь повторения: ошибка или подсказка → задание вернётся через REVIEW_DELAY_DAYS (одна открытая запись)."""
    due = now + timedelta(days=settings.review_delay_days)
    stmt = insert(ReviewItem).values(
        id=uuid.uuid4(), user_id=s.user_id, pair_id=s.pair_id, lesson_id=lesson_id, lesson_version=version,
        item_id=item_id, skill_id=skill_id[:64], reason=reason, due_at=due, source_session_id=s.session_id,
        created_at=now)
    await db.execute(stmt.on_conflict_do_update(
        index_elements=["user_id", "pair_id", "lesson_id", "item_id"], index_where=ReviewItem.resolved_at.is_(None),
        set_={"due_at": due, "reason": reason, "lesson_version": version}))


async def answer_item(db: AsyncSession, s: Session, b: Bundle, step: Step, answer: Any, dont_know: bool,
                      now: datetime, settings: Settings) -> tuple[str | None, dict[str, Any] | None, dict[str, Any]]:
    """→ (result, feedback, сохраняемый ответ). Повторение и проверка понимания — проверка сразу; проверка без
    подсказок и упражнения — правильность не показывается (оценивает assessment)."""
    view = step.payload["item"]
    value = validate_answer(view["item_type"], view["options"], answer, dont_know)
    stored = {"answer": value, "dont_know": dont_know}
    src = step.ref.get("src")
    if src == "retrieval":
        lesson = b.retrieval[(step.ref["key"], int(step.ref["version"]))]
        item = find_control_item(lesson, step.ref["item_id"])
        assert item is not None
        correct = grade_control_item(item, value)
        result = "skipped" if dont_know else ("correct" if correct else "incorrect")
        hinted = step.hints > 0
        if correct and not hinted:
            if step.ref.get("review_item_id"):
                await db.execute(update(ReviewItem).where(
                    ReviewItem.id == uuid.UUID(step.ref["review_item_id"]), ReviewItem.user_id == s.user_id,
                    ReviewItem.resolved_at.is_(None)).values(resolved_at=now))
        else:
            await queue_review(db, s, lesson_id=step.ref["key"], version=int(step.ref["version"]),
                               item_id=step.ref["item_id"], skill_id=str(item.get("skill_id") or ""),
                               reason="wrong" if not correct else "hinted", now=now, settings=settings)
        return result, {"correct": correct, "correct_answer": None if correct else correct_text(item)}, stored
    if src == "duel":  # проверка по ключу снимка набора; ученику — без обратной связи (счёт — после дуэли)
        correct = grade_control_item(b.duel[int(step.ref["n"])]["item"], value)
        return ("skipped" if dont_know else ("correct" if correct else "incorrect")), None, stored
    if src == "meaning":
        correct = value == int(step.ref["correct"])
        result = "skipped" if dont_know else ("correct" if correct else "incorrect")
        right = view["options"][int(step.ref["correct"])]
        return result, {"correct": correct, "correct_answer": None if correct else right}, stored
    return None, None, stored


def lesson_examples(b: Bundle) -> list[tuple[str, Localized]]:
    """Примеры урока для «объясни проще» без ИИ: примеры, затем примеры ключевых слов."""
    if b.lesson is None:
        return []
    out = [(str(e["en"]), dict(e["gloss"])) for e in b.lesson.get("examples") or []]
    out += [(str(k["example_en"]), dict(k["gloss"])) for k in b.lesson.get("key_words") or []]
    return out


async def hint(db: AsyncSession, s: Session, b: Bundle, step: Step) -> Localized:
    """Подсказка текущего шага (отмечается): повторение, проверка понимания, ролевая ситуация.
    Проверка без подсказок, упражнения к медиа и прочие шаги — 409 HINTS_NOT_ALLOWED."""
    n = step.hints + 1
    text: Localized
    if step.type == "item" and step.payload.get("hint_available"):
        if step.ref.get("src") == "retrieval":
            lesson = b.retrieval[(step.ref["key"], int(step.ref["version"]))]
            item = find_control_item(lesson, step.ref["item_id"])
            assert item is not None
            text = item_hint(item, n)
        else:
            assert b.lesson is not None
            word = b.lesson["key_words"][int(step.ref["word"])]
            text = loc(f"Пример: {word['example_en']}", f"Misol: {word['example_en']}")
    elif step.type == "roleplay":
        assert b.scenario is not None
        node = b.scenario["nodes"][step.payload["node_id"]]
        if node.get("hint"):
            text = dict(node["hint"])
        else:
            first = (node.get("transitions") or [{}])[0]
            text = dict(first.get("description") or loc("Выберите один из вариантов.", "Variantlardan birini tanlang."))
    else:
        raise hints_not_allowed()
    step.hints = n
    s.hints_used += 1
    return text


def ensure_current(s: Session, step: Step | None, step_id: str) -> Step:
    if step is None or step.step_id != step_id or step.answered_at is not None:
        raise step_not_current(f"s{s.step_index}" if s.step_index else None)
    return step


def current_or_error(step: Step | None) -> ApiError:
    return step_not_current(step.step_id if step is not None else None)


async def answered_count(db: AsyncSession, s: Session) -> int:
    return int((await db.execute(
        select(func.count()).select_from(Step).where(Step.session_id == s.session_id, Step.answered_at.is_not(None))
    )).scalar_one())
