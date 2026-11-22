"""Детерминированный провайдер `fake` (INTERNAL_API §1.6): тесты, стенд e2e и золотые тесты до появления ключа.

Читает только JSON сообщения пользователя (`{locale, context}`) — как и настоящая модель, получает реплику ученика
лишь данными; system/rules не влияют на ответ. Латентность ~0, стоимость 0 (модель `fake` с ценой 0/0).

- conversation_partner: намерение — по пересечению слов реплики с `examples_en` переходов узла (доля слов примера
  ≥ 0,5, без служебных слов; лучший переход, при равенстве — первый), иначе `unclear`. Инъекция в реплике
  («ignore previous instructions…») ничего не меняет — сравниваются только слова. reply_en — шаблон по намерению.
- teaching_coach: шаблон из контекста урока — следующий ещё не показанный пример, объяснение на explain_locale;
  `gloss_word` (спринт 5, INTERNAL_API §3.1) — `gloss = {ru: "[ru] <word>", uz: "[uz] <word>"}`, `lemma = word`,
  `part_of_speech: other`, `forms: [word]`, `confidence 0.9`.
- independent_evaluator: правила — задача по исходу (success 3, alt_success 2, fail 1), самостоятельность по
  подсказкам (0 → 3, 1 → 2, 2 → 1, 3+ → 0), грамматика по найденным ошибкам; ошибки — по словарю типичных ошибок
  A1–A2 с цитатой, дословно взятой из реплики ученика; без реплик ученика — insufficient_evidence.
- cooperative_lesson_coach (спринт 7): шаблон по триггеру — start: роли A/B и общая цель, первым говорит A;
  partner_offline — paused; end — finished с отчётом (подсказки — только ролям с вкладом); иначе in_progress, следующим
  говорит онлайн-роль с меньшим числом реплик (молчащему возвращается слово); доказательство — последняя реплика
  участника (её роль и turn_id); варианты — только в режиме choices; эскалация — по safety_flags (abuse → abuse,
  personal_data → safety). Тексты — английские шаблоны и переводы ru/uz, данные контекста в них не попадают.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from typing import Any, Final

from tilhero_ai_gateway.providers.base import ProviderError, ProviderName, ProviderRequest, ProviderResponse

WORD_RE: Final = re.compile(r"[a-z0-9']+")
STOPWORDS: Final = frozenset({
    "a", "an", "the", "i", "you", "it", "is", "am", "are", "to", "of", "and", "or", "please", "me", "my", "your",
    "can", "could", "would", "do", "does", "be", "for", "on", "in", "at", "this", "that", "some", "with", "we", "he",
    "she", "they", "s", "d", "m", "ll", "re", "ve", "oh", "well", "so",
})
MATCH_THRESHOLD: Final = 0.5
REPLY_RECOGNIZED: Final = "All right, thank you!"
REPLY_UNCLEAR: Final = "Sorry, I didn't catch that. Could you say it again?"


def _third(verb: str) -> str:
    v = verb.lower()
    if v == "have":
        return "has"
    if v in ("go", "do"):
        return v + "es"
    if v.endswith(("s", "sh", "ch", "x")):
        return v + "es"
    return v + "s"


# (шаблон, исправление по совпадению, error_code, severity) — типичные ошибки A1–A2
ERRORS: Final[tuple[tuple[re.Pattern[str], Callable[[re.Match[str]], str], str, str], ...]] = (
    (re.compile(r"\bI am agree\b", re.I), lambda m: "I agree", "extra_be", "medium"),
    (re.compile(r"\b(he|she|it) (go|want|like|have|do|work|live|play|need)\b", re.I),
     lambda m: f"{m.group(1)} {_third(m.group(2))}", "third_person_s", "medium"),
    (re.compile(r"\bI have (\d{1,3}) years\b", re.I), lambda m: f"I am {m.group(1)} years old",
     "wrong_construction", "medium"),
    (re.compile(r"\b(he|she|it) don't\b", re.I), lambda m: f"{m.group(1)} doesn't", "agreement", "medium"),
    (re.compile(r"\bI am (student|teacher|doctor|engineer|driver|manager)\b", re.I),
     lambda m: f"I am a {m.group(1)}", "article", "low"),
    (re.compile(r"\bI want go\b", re.I), lambda m: "I want to go", "missing_to", "low"),
    (re.compile(r"\bpeople is\b", re.I), lambda m: "people are", "agreement", "medium"),
    (re.compile(r"\bcan to (\w+)", re.I), lambda m: f"can {m.group(1)}", "modal_to", "low"),
    (re.compile(r"\bmore better\b", re.I), lambda m: "better", "double_comparative", "low"),
)


def _words(text: str) -> set[str]:
    return {w for w in WORD_RE.findall(text.lower().replace("’", "'")) if w not in STOPWORDS}


def classify_intent(learner_turn: str, transitions: list[dict[str, Any]]) -> str:
    said = _words(learner_turn)
    best, best_score = "unclear", 0.0
    for t in transitions:
        for example in t.get("examples_en", []):
            expected = _words(str(example))
            if not expected:
                continue
            score = len(said & expected) / len(expected)
            if score > best_score:
                best, best_score = str(t.get("intent")), score
    return best if best_score >= MATCH_THRESHOLD else "unclear"


def conversation_partner(ctx: dict[str, Any]) -> dict[str, Any]:
    transitions = (ctx.get("node") or {}).get("transitions", [])
    intent = classify_intent(str(ctx.get("learner_turn", "")), transitions)
    unclear = intent == "unclear"
    return {"intent": intent, "reply_en": REPLY_UNCLEAR if unclear else REPLY_RECOGNIZED,
            "hint_offered": unclear and int(ctx.get("attempts_on_node", 0)) >= 1}


def gloss_word(ctx: dict[str, Any]) -> dict[str, Any]:
    word = str(ctx.get("word", ""))[:60]
    return {"lemma": word, "part_of_speech": "other", "gloss": {"ru": f"[ru] {word}"[:80], "uz": f"[uz] {word}"[:80]},
            "forms": [word], "confidence": 0.9}


def teaching_coach(ctx: dict[str, Any]) -> dict[str, Any]:
    if ctx.get("request") == "gloss_word":
        return gloss_word(ctx)
    lesson = ctx.get("lesson") or {}
    examples = [str(e) for e in lesson.get("examples_en", [])]
    shown = set(ctx.get("already_shown", []))
    example = next((e for e in examples if e not in shown), examples[0] if examples else "Hello!")
    words = ", ".join(str(w) for w in lesson.get("key_words", [])[:3])
    if ctx.get("explain_locale") == "uz":
        explanation = "Misolga qarang va uni ovoz chiqarib takrorlang."
        if words:
            explanation += f" Kalit soʻzlar: {words}."
        gloss = "Darsdan misol"
    else:
        explanation = "Посмотрите на пример и повторите его вслух — так проще запомнить."
        if words:
            explanation += f" Ключевые слова: {words}."
        gloss = "Пример из урока"
    return {"explanation": explanation[:400], "example_en": example[:160], "example_gloss": gloss}


def find_errors(turns: list[dict[str, Any]]) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    for turn in turns:
        if turn.get("speaker") != "learner":
            continue
        text = str(turn.get("text", ""))
        for pattern, fix, code, severity in ERRORS:
            for m in pattern.finditer(text):
                found.append({"turn_id": str(turn.get("turn_id")), "evidence": m.group(0)[:120],
                              "correction": fix(m)[:200], "error_code": code, "severity": severity})
                if len(found) >= 5:
                    return found
    return found


def independent_evaluator(ctx: dict[str, Any]) -> dict[str, Any]:
    criteria = [str(c.get("code")) for c in (ctx.get("rubric") or {}).get("criteria", [])]
    turns = ctx.get("turns", [])
    hints = int((ctx.get("hint_usage") or {}).get("count", 0))
    learner = [t for t in turns if t.get("speaker") == "learner" and str(t.get("text", "")).strip()]
    outcome = (ctx.get("task") or {}).get("outcome")
    if not learner:
        return {"status": "insufficient_evidence", "scores": dict.fromkeys(criteria), "task_completed": None,
                "confirmed_errors": [], "support_used": hints > 0, "confidence": 0.0, "pronunciation_score": None,
                "cefr_certificate": False, "requires_human_review": False}
    errors = find_errors(turns)
    by_rule: dict[str, int | None] = {
        "task": {"success": 3, "alt_success": 2, "fail": 1}.get(str(outcome)) if outcome else None,
        "independence": max(0, 3 - hints),
        "grammar": max(1, 3 - len(errors)),
        "vocabulary": 2,
    }
    scores = {code: by_rule.get(code) for code in criteria}
    return {"status": "ok", "scores": scores,
            "task_completed": None if outcome is None else outcome in ("success", "alt_success"),
            "confirmed_errors": errors, "support_used": hints > 0, "confidence": 0.6, "pronunciation_score": None,
            "cefr_certificate": False, "requires_human_review": False}


COACH_GLOSS: Final = {"ru": "Ваш ход: ответьте партнёру по-английски.",
                      "uz": "Sizning navbatingiz: sherigingizga inglizcha javob bering."}
COACH_OPTIONS: Final = ({"choice_id": "c1", "text_en": "Hello! Can you help me, please?"},
                        {"choice_id": "c2", "text_en": "Sure, let's do it together."})
COACH_SUMMARY: Final = {"ru": "Отличная командная работа! Вы вместе продвинулись к цели.",
                        "uz": "Ajoyib jamoaviy ish! Birgalikda maqsadga yaqinlashdingiz."}
COACH_TIP: Final = {"ru": "Попробуйте отвечать полными предложениями.",
                    "uz": "Toʻliq gaplar bilan javob berishga harakat qiling."}


def cooperative_lesson_coach(ctx: dict[str, Any]) -> dict[str, Any]:
    trigger = ctx.get("trigger")
    participants = [p for p in ctx.get("participants", []) if isinstance(p, dict)]
    current = float(ctx.get("team_goal_progress", 0) or 0)
    flags = set(ctx.get("safety_flags") or [])
    out: dict[str, Any] = {
        "room_id": str(ctx.get("room_id", "")), "status": "in_progress", "next_speaker": None,
        "prompt": "", "prompt_gloss": None, "options": None, "roles": None, "team_goal_en": None,
        "team_goal_progress": current, "individual_evidence": [],
        "escalation": "abuse" if "abuse" in flags else "safety" if "personal_data" in flags else None,
        "report": None,
    }
    if trigger == "end":
        contributed = [str(p["role"]) for p in participants if int(p.get("turns", 0)) > 0]
        out.update(status="finished", prompt="Thank you both! The lesson is over. See you next time.",
                   report={"team_summary": dict(COACH_SUMMARY),
                           "tips": [{"role": r, "text": dict(COACH_TIP)} for r in contributed]})
        return out
    if trigger == "partner_offline":
        out.update(status="paused", prompt="Your partner lost the connection. Let's wait a moment.")
        return out
    online = [p for p in participants if p.get("network") == "online"] or participants
    nxt = min(online, key=lambda p: (int(p.get("turns", 0)), str(p.get("role")))) if online else None
    out["next_speaker"] = str(nxt["role"]) if nxt else "both"
    who = out["next_speaker"]
    if trigger == "start":
        out.update(roles={"A": "You start the conversation and ask the first question.",
                          "B": "You answer your partner and ask a question back."},
                   team_goal_en="Finish the scene task together, both of you speaking.",
                   prompt="Welcome! A, please start the conversation.")
    elif trigger == "wrap_up":
        out["prompt"] = f"Two minutes left. {who}, let's finish the task together."
    elif trigger == "silence":
        out["prompt"] = f"Take your time, {who}. You can say just a few words."
    else:
        out["prompt"] = f"Thank you! Now it's your turn, {who}."
    if trigger == "turn":
        out["team_goal_progress"] = round(min(1.0, current + 0.1), 2)
        last = next((t for t in reversed(ctx.get("turns", [])) if t.get("speaker") in ("A", "B")), None)
        if last is not None:
            out["individual_evidence"] = [{"role": last["speaker"], "turn_id": str(last["turn_id"]),
                                           "skill_id": None, "assist_used": last.get("mode") == "choice"}]
    out["prompt_gloss"] = dict(COACH_GLOSS)
    if ctx.get("mode") == "choices":
        out["options"] = [dict(o) for o in COACH_OPTIONS]
    return out


AGENTS: Final[dict[str, Callable[[dict[str, Any]], dict[str, Any]]]] = {
    "conversation_partner": conversation_partner,
    "teaching_coach": teaching_coach,
    "independent_evaluator": independent_evaluator,
    "cooperative_lesson_coach": cooperative_lesson_coach,
}


class FakeProvider:
    name: ProviderName = "fake"

    def ready(self) -> bool:
        return True

    async def complete(self, request: ProviderRequest) -> ProviderResponse:
        handler = AGENTS.get(request.agent_id)
        if handler is None:
            raise ProviderError("fake_agent_unknown")
        try:
            data = json.loads(request.user)
            context = data["context"]
        except (ValueError, KeyError, TypeError):
            raise ProviderError("bad_request") from None
        text = json.dumps(handler(context), ensure_ascii=False)
        # токены — оценка по длине (≈ 4 символа на токен); стоимость считает шлюз по цене модели fake (0/0)
        return ProviderResponse(text=text, input_tokens=(len(request.system) + len(request.user)) // 4 + 1,
                                output_tokens=len(text) // 4 + 1)

    async def aclose(self) -> None:
        return None
