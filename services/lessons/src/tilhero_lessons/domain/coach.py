"""Ведущий парного урока (INTERNAL_API §3.2, §4; скилл 11, ai.ts CooperativeCoachContext / CooperativeCoachOutput).

- engine `ai` — коуч `cooperative_lesson_coach` через ai-gateway (session_kind pair, session_id = room_id). Коуч видит
  только роли A/B (без user_id, ников и имён), последние ≤ 12 реплик комнаты, оставшиеся минуты, флаги безопасности.
  Ответ проверяется здесь (защита в глубину): эхо room_id, перечисления, длины, прогресс не убывает, доказательства —
  только реплики этой роли (чужой ответ молчащему не присваивается), варианты — только в режиме choices.
  Недоступен, отказ, бюджет комнаты исчерпан, ответ не по схеме → комната продолжается сценарием (`ai_degraded`).
- engine `script` — сценарий каталога с выбором реплик: реплика персонажа узла и варианты (`examples_en[0]` переходов,
  перемешаны по room_id) для ролей A и B по очереди (соло — оставшейся роли); конечный узел — итог сцены
  (success/alt_success — цель достигнута). Дети 6–13 — всегда сценарий (коуча не зовут).
"""

from __future__ import annotations

import math
import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_lessons.domain import pair
from tilhero_lessons.domain.common import answer_invalid, seeded_order
from tilhero_lessons.domain.content import distance_to_end
from tilhero_lessons.domain.pair import Effects, Room, add_event, put, set_turn, st
from tilhero_lessons.models import RoomEvent
from tilhero_lessons.settings import Settings

AGENT = "cooperative_lesson_coach"
CONTEXT_TURNS = 12
SCRIPT_ROLES = {"A": "You speak first in each pair of lines. Choose a line, then let your partner answer.",
                "B": "You answer after your partner. Choose a line and keep the scene going."}
STATUSES = frozenset({"in_progress", "paused", "fallback_text", "finished"})
NEXT = frozenset({"A", "B", "both"})


def other_role(role: str | None) -> str:
    return "B" if role == "A" else "A"


def script_goal(scn: dict[str, Any]) -> str:
    names = [str(c.get("name")) for c in scn.get("characters") or [] if c.get("name")]
    who = " and ".join(names[:2]) if names else "the characters"
    return f"Work together and finish the scene with {who}."[:200]


def scenario_skills(scn: dict[str, Any]) -> list[str]:
    return [str(x) for x in scn.get("skill_ids") or []][:8]


def ensure_roles(db: AsyncSession, room: Room, scn: dict[str, Any], now: datetime,
                 roles: dict[str, str] | None = None, goal: str | None = None) -> None:
    r = room.r
    if st(r).get("roles"):
        return
    put(r, roles=roles or dict(SCRIPT_ROLES), team_goal=goal or script_goal(scn), scenario_skills=scenario_skills(scn))
    add_event(db, room, "roles", now)


# ---------------------------------------------------------------- сценарий с выбором реплик


async def script_enter(db: AsyncSession, room: Room, scn: dict[str, Any], node_id: str, role: str | None,
                       now: datetime, settings: Settings) -> Effects:
    """Узел графа: реплика персонажа в ленту; конечный — итог сцены; иначе варианты для роли, чей ход."""
    r = room.r
    s = st(r)
    node = scn["nodes"][node_id]
    count = int(s.get("count", 0)) + 1
    add_event(db, room, "coach", now, text=str(node["line_en"]), turn=True)
    dist = distance_to_end(scn, node_id)
    progress = max(float(s.get("progress", 0.0)), (count - 1) / max(count - 1 + dist, 1))
    base = {"node": node_id, "path": [*s.get("path", []), node_id], "count": count, "prompt": node["line_en"],
            "prompt_gloss": dict(node.get("gloss") or {}) or None}
    end = node.get("end")
    if end is not None:
        outcome = str(end.get("outcome"))
        reached = outcome in ("success", "alt_success")
        put(r, **base, outcome=outcome, progress=1.0 if reached else progress, options=None, option_map=None)
        solo = bool(s.get("solo"))
        return await pair.finish(db, room, "abandoned" if solo else "finished",
                                 "participant_left" if solo else "completed", now, settings, goal_reached=reached)
    ordered = seeded_order(str(r.room_id), f"choices:{node_id}", list(node.get("transitions") or []),
                           key=lambda t: str(t["intent"]))
    options = [{"choice_id": f"c{i + 1}", "text_en": str((t.get("examples_en") or [""])[0])[:160]}
               for i, t in enumerate(ordered)]
    option_map = {f"c{i + 1}": {"to": str(t["to"]), "text": str((t.get("examples_en") or [""])[0])[:160]}
                  for i, t in enumerate(ordered)}
    put(r, **base, progress=progress, options=options, option_map=option_map)
    set_turn(room, role or "A", now)
    return Effects(notify=True)


async def script_start(db: AsyncSession, room: Room, scn: dict[str, Any], now: datetime, settings: Settings,
                       *, first_role: str = "A") -> Effects:
    ensure_roles(db, room, scn, now)
    put(room.r, path=[], count=0, outcome=None, pending=None)
    return await script_enter(db, room, scn, str(scn["start_node"]), first_role, now, settings)


def chosen_option(room: Room, choice_id: str) -> dict[str, Any]:
    """Вариант текущего хода (сценарий — option_map; коуч в режиме choices — options) или 422 ANSWER_INVALID."""
    s = st(room.r)
    if room.r.engine == "script":
        opt = (s.get("option_map") or {}).get(choice_id)
        if isinstance(opt, dict):
            return {"text": str(opt["text"]), "to": opt.get("to")}
    else:
        for o in s.get("options") or []:
            if isinstance(o, dict) and o.get("choice_id") == choice_id:
                return {"text": str(o.get("text_en") or "")[:160], "to": None}
    raise answer_invalid("choice_id", "Такого варианта нет")


async def script_after_turn(db: AsyncSession, room: Room, scn: dict[str, Any], role: str | None, option: dict[str, Any],
                            now: datetime, settings: Settings) -> Effects:
    return await script_enter(db, room, scn, str(option["to"]), other_role(role), now, settings)


async def degrade(db: AsyncSession, room: Room, scn: dict[str, Any], now: datetime, settings: Settings,
                  *, next_role: str) -> Effects:
    """ИИ недоступен (сбой, отказ, бюджет комнаты, аварийная остановка) — сценарий с выбором реплик до конца."""
    r = room.r
    r.engine = "script"
    r.mode = "choices"
    r.ai_degraded = True
    put(r, pending=None)
    add_event(db, room, "mode_changed", now)
    return await script_start(db, room, scn, now, settings, first_role=next_role)


# ---------------------------------------------------------------- ИИ-коуч


def coach_audience(room: Room) -> str:
    return "teens" if any(p.audience == "teens" for p in room.parts.values()) else "adults"


async def context(db: AsyncSession, room: Room, scn: dict[str, Any], trigger: str, now: datetime,
                  settings: Settings) -> dict[str, Any]:
    r = room.r
    s = st(r)
    rows = list((await db.execute(select(RoomEvent).where(
        RoomEvent.room_id == r.room_id, RoomEvent.kind.in_(("turn", "coach")), RoomEvent.text.is_not(None),
        RoomEvent.turn_id.is_not(None)).order_by(RoomEvent.seq.desc()).limit(CONTEXT_TURNS))).scalars().all())
    rows.reverse()
    turns = []
    for ev in rows:
        if ev.kind == "turn" and ev.role not in ("A", "B"):
            continue
        turns.append({"turn_id": ev.turn_id, "speaker": ev.role if ev.kind == "turn" else "coach",
                      "text": (ev.text or "")[:300], "mode": ev.mode if ev.kind == "turn" else None})
    last = next((t["text"] for t in reversed(turns) if t["speaker"] != "coach"), None)
    participants = [{"role": p.role, "turns": p.turns, "speaking_seconds": p.speaking_seconds,
                     "network": "online" if pair.present(p) else "offline", "voice": bool(p.voice and r.mode == "free")}
                    for p in sorted(room.parts.values(), key=lambda x: x.role or "") if p.role in ("A", "B")]
    remaining = pair.remaining_seconds(r, settings, now)
    return {
        "room_id": str(r.room_id), "pair_id": r.pair_id, "scenario": scenario_en(scn),
        "mode": r.mode, "trigger": trigger, "participants": participants,
        "roles": s.get("roles"), "team_goal_en": s.get("team_goal"),
        "team_goal_progress": float(s.get("progress", 0.0)), "turns": turns,
        "remaining_minutes": math.ceil(remaining / 60), "safety_flags": pair.safety_flags(last),
    }


def _en(value: Any) -> str | None:
    """Английский вариант поля контента: строка `*_en` или Localized с ключом `en`; русского/узбекского — никогда."""
    if isinstance(value, dict):
        value = value.get("en")
    return " ".join(value.split()) if isinstance(value, str) and value.strip() else None


def _slug_title(scenario_id: str) -> str:
    words = [w for w in scenario_id.removeprefix("sc-").split("-") if w]
    return " ".join(words).capitalize() or scenario_id


def scenario_en(scn: dict[str, Any]) -> dict[str, Any]:
    """Сценарий для коуча — только английский текст (ai.ts: *_en). Английские поля берутся из контента
    (`title_en`/`title.en`, `task_en`, `completion.criteria_en`, `characters[].role_en`); в ScenarioPayload каталога их
    пока нет (title, task, role, criteria — только ru/uz, content.ts), поэтому недостающее собирается из английских
    данных сценария (id, имена персонажей, реплики line_en), а не подставляется русский текст. ai-gateway требует эти
    поля (CoachScenario) — пропуск сделал бы каждый вызов invalid (запрос к общему коду в отчёте)."""
    nodes = scn.get("nodes") or {}
    start = nodes.get(scn.get("start_node")) or {}
    names = [str(c.get("name")) for c in scn.get("characters") or [] if c.get("name")]
    who = " and ".join(names[:2]) if names else "the characters"
    title = _en(scn.get("title_en")) or _en(scn.get("title")) or _slug_title(str(scn["scenario_id"]))
    first_line = _en(start.get("line_en"))
    task = _en(scn.get("task_en")) or _en(scn.get("task")) or (
        f"Talk with {who} in this scene" + (f', starting from: "{first_line}"' if first_line else "") + ".")
    completion = scn.get("completion") or {}
    criteria = _en(completion.get("criteria_en")) or _en(completion.get("criteria")) or (
        f"The learners reach a successful ending of the scene with {who}.")
    characters = []
    for c in scn.get("characters") or []:
        who_c = c.get("name") or c.get("id")
        role = _en(c.get("role_en")) or _en(c.get("role")) or f"{who_c}, a character in the scene"
        characters.append({"id": c["id"], "name": c["name"], "role_en": role[:200]})
    return {"scenario_id": scn["scenario_id"], "title_en": title[:200], "task_en": task[:600],
            "level": scn["level"], "characters": characters, "completion_criteria_en": criteria[:600]}


def _text(value: Any, limit: int) -> str | None:
    return " ".join(value.split())[:limit] if isinstance(value, str) and value.strip() else None


def _loc(value: Any, limit: int) -> dict[str, str] | None:
    if not isinstance(value, dict):
        return None
    ru, uz = _text(value.get("ru"), limit), _text(value.get("uz"), limit)
    return {"ru": ru, "uz": uz} if ru and uz else None


def parse(out: dict[str, Any] | None, room: Room) -> dict[str, Any] | None:
    """Выход коуча по ai.ts (защита в глубину) → нормализованный словарь или None (как invalid_output)."""
    if not isinstance(out, dict) or out.get("room_id") != str(room.r.room_id):
        return None
    status = out.get("status")
    nxt = out.get("next_speaker")
    prompt = _text(out.get("prompt"), 300)
    progress = out.get("team_goal_progress")
    if status not in STATUSES or (nxt is not None and nxt not in NEXT) or prompt is None \
            or isinstance(progress, bool) or not isinstance(progress, int | float) or not 0 <= progress <= 1:
        return None
    options = None
    if room.r.mode == "choices" and isinstance(out.get("options"), list):
        options = [{"choice_id": str(o["choice_id"])[:8], "text_en": str(_text(o.get("text_en"), 160))}
                   for o in out["options"][:3] if isinstance(o, dict) and isinstance(o.get("choice_id"), str)
                   and _text(o.get("text_en"), 160)]
    roles_raw = out.get("roles")
    roles = None
    if isinstance(roles_raw, dict) and _text(roles_raw.get("A"), 120) and _text(roles_raw.get("B"), 120):
        roles = {"A": str(_text(roles_raw["A"], 120)), "B": str(_text(roles_raw["B"], 120))}
    evidence = [{"role": e["role"], "turn_id": str(e["turn_id"])[:8],
                 "skill_id": str(e["skill_id"])[:64] if isinstance(e.get("skill_id"), str) else None,
                 "assist_used": e.get("assist_used") is True}
                for e in out.get("individual_evidence") or []
                if isinstance(e, dict) and e.get("role") in ("A", "B") and isinstance(e.get("turn_id"), str)]
    report = None
    rep = out.get("report")
    if status == "finished" and isinstance(rep, dict) and _loc(rep.get("team_summary"), 200):
        report = {"team_summary": _loc(rep.get("team_summary"), 200),
                  "tips": [{"role": t["role"], "text": _loc(t.get("text"), 160)} for t in rep.get("tips") or []
                           if isinstance(t, dict) and t.get("role") in ("A", "B") and _loc(t.get("text"), 160)][:6]}
    return {"status": status, "next": nxt, "prompt": prompt, "gloss": _loc(out.get("prompt_gloss"), 300),
            "options": options or None, "roles": roles, "goal": _text(out.get("team_goal_en"), 200),
            "progress": float(progress), "evidence": evidence,
            "escalation": out.get("escalation") if out.get("escalation") in ("safety", "abuse") else None,
            "report": report}


async def apply(db: AsyncSession, room: Room, scn: dict[str, Any], out: dict[str, Any], trigger: str,
                cost: Decimal, now: datetime, settings: Settings) -> Effects:
    """Ответ коуча → лента, роли и цель, подсказка, доказательства по ролям, итог или пауза (escalation)."""
    r = room.r
    r.ai_cost_usd = (r.ai_cost_usd or Decimal("0")) + cost
    put(r, pending=None)
    if trigger == "start" or not st(r).get("roles"):
        ensure_roles(db, room, scn, now, out["roles"], out["goal"])
    # доказательства: только реплики этой роли (не присваивать чужой ответ молчащему партнёру)
    owned = {(tid, role) for tid, role in (await db.execute(select(RoomEvent.turn_id, RoomEvent.role).where(
        RoomEvent.room_id == r.room_id, RoomEvent.kind == "turn"))).all()}
    for e in out["evidence"]:
        p = room.by_role(e["role"])
        if p is None or (e["turn_id"], e["role"]) not in owned:
            continue
        if all(x.get("turn_id") != e["turn_id"] for x in p.evidence or []):
            p.evidence = [*(p.evidence or []), {k: e[k] for k in ("turn_id", "skill_id", "assist_used")}][:200]
    progress = max(float(st(r).get("progress", 0.0)), out["progress"])
    add_event(db, room, "coach", now, text=out["prompt"], turn=True)
    put(r, prompt=out["prompt"], prompt_gloss=out["gloss"], options=out["options"], progress=progress,
        **({"wrap_up": True} if trigger == "wrap_up" else {}), **({"report": out["report"]} if out["report"] else {}))
    if out["status"] == "finished":
        solo = bool(st(r).get("solo"))
        return await pair.finish(db, room, "abandoned" if solo else "finished",
                                 "participant_left" if solo else "completed", now, settings,
                                 goal_reached=progress >= 0.999)
    set_turn(room, out["next"] or "both", now)
    if out["escalation"] and r.status == "in_progress":
        put(r, escalations=int(st(r).get("escalations", 0)) + 1)
        pair.pause(db, room, "safety", now)
    return Effects(notify=True)


def request_id(room_id: uuid.UUID, trigger: str, turn_no: int) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"lessons:pair:{room_id}:{trigger}:{turn_no}"))
