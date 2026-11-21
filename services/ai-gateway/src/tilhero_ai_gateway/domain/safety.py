"""safety_quality_gate (код, INTERNAL_API §1.3): проверка вывода агента после JSON-схемы версии и контракта ai.ts.

Нарушения → `retry_with_constraints` (коды уходят в rules повторного запроса), повторное — отказ (`invalid_output`).
Исправления без повтора (`redact`): подтверждённая ошибка оценщика, чьей цитаты нет дословно в реплике ученика
с этим turn_id, отбрасывается (как и в assessment) — предупреждение `evidence_dropped`.

Коды: link, email, phone, secret, certificate_claim, pronunciation_scored, too_long, too_many_words, wrong_language,
intent_unknown, criterion_unknown (+ разбор: not_json, schema_invalid, contract_mismatch).

teaching_coach `gloss_word` (спринт 5, INTERNAL_API §3.1): без ссылок, e-mail, телефонов и ключей (общие правила);
`gloss.ru` — кириллица без латиницы («без английского»), `gloss.uz` — латиница без кириллицы, `lemma` и `forms` —
без кириллицы → `wrong_language`; длины — схема версии и контракт ai.ts (≤ 60 / 80 / 6 форм). Апострофы узбекского
oʻ/gʻ, записанные ' ‘ ’ `, исправляются на ʻ (U+02BB) без повтора (`uz_apostrophe_fixed`). Провайдер fake
(`[ru] word`, решение §3.1) языковые правила gloss не проверяет — это заглушка стенда, не перевод.

cooperative_lesson_coach (спринт 7, INTERNAL_API §4, скилл 11):
- `room_id` — эхо context.room_id (`room_mismatch`); тексты проверяются только в человекочитаемых полях (prompt,
  переводы, варианты, роли, цель, отчёт): идентификаторы (room_id, turn_id, skill_id, choice_id) — не текст;
- согласованность (`coach_state`): finished ⇔ есть отчёт, next_speaker null; paused — next_speaker null;
  in_progress/fallback_text — next_speaker — роль из комнаты или both; trigger end → finished; trigger start — роли и
  цель, иначе null; варианты — только mode choices при ходе (≤ 3), иначе null; прогресс цели не убывает;
- язык (`wrong_language`): prompt, варианты, роли и цель — английский без кириллицы; prompt_gloss.ru и отчёт ru —
  кириллица, uz — латиница; апострофы oʻ/gʻ в uz исправляются (`uz_apostrophe_fixed`);
- исправления без повтора: доказательство, чей turn_id — не реплика этой роли в context.turns (ответ одного не
  присваивается другому, молчавший не оценивается), отбрасывается (`evidence_dropped`); подсказка отчёта роли без
  вклада или четвёртая подсказка роли отбрасывается (`tips_dropped`).
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any, Final

LINK_RE: Final = re.compile(r"https?:|\bwww\.|\bt\.me\b|telegram\.me", re.IGNORECASE)
EMAIL_RE: Final = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
PHONE_RE: Final = re.compile(r"\+?\d[\d\s\-().]{5,}\d")
# Вымышленные номера сценариев (шаблон сида): 555 01xx
ALLOWED_PHONE_RE: Final = re.compile(r"^\d{0,4}55501\d{2}$")
SECRET_RE: Final = re.compile(r"\bsk-[A-Za-z0-9_\-]{6,}|eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}")
CERT_RE: Final = re.compile(r"сертифик|certificat|sertifikat", re.IGNORECASE)
CYRILLIC_RE: Final = re.compile(r"[Ѐ-ӿ]")
LATIN_RE: Final = re.compile(r"[A-Za-z]")
UZ_APOSTROPHE_RE: Final = re.compile(r"(?<=[oOgG])['‘’`]")
LETTER_RE: Final = re.compile(r"[^\W\d_]")
WORD_RE: Final = re.compile(r"[^\s]+")
LOW_BANDS: Final = frozenset({"A0", "A1", "A2"})
REPLY_MAX_CHARS: Final = 240
REPLY_MAX_WORDS: Final = 25

# Человекочитаемые ограничения для повтора (уходят модели в rules, без данных ученика)
CONSTRAINTS: Final[dict[str, str]] = {
    "not_json": "Ответ должен быть одним JSON-объектом без Markdown и текста вокруг.",
    "schema_invalid": "Ответ не прошёл JSON-схему: соблюдай типы, обязательные поля, enum и ограничения длины.",
    "contract_mismatch": "Ответ не соответствует контракту полей агента: только поля схемы, точные типы.",
    "link": "Не используй ссылки (http, www., t.me).",
    "email": "Не указывай адреса электронной почты.",
    "phone": "Не указывай номера телефонов (в сценариях допустим только вымышленный формат 555 01xx).",
    "secret": "Не выводи ключи, токены и служебные строки.",
    "certificate_claim": "Не упоминай и не обещай сертификаты (CEFR и другие); cefr_certificate всегда false.",
    "pronunciation_scored": "Произношение по тексту не оценивается: pronunciation_score и scores.pronunciation — null.",
    "too_long": "Реплика персонажа — не длиннее 240 символов.",
    "too_many_words": "Для уровней A0–A2 реплика персонажа — не больше 25 слов, один вопрос.",
    "wrong_language": "Объяснения — на языке объяснений ученика (ru/uz), учебные поля — только на английском; "
                      "gloss.ru — только кириллица без латиницы, gloss.uz — только латиница, lemma и forms — "
                      "на английском.",
    "intent_unknown": "intent — только один из переходов текущего узла, либо unclear, либо off_topic.",
    "criterion_unknown": "scores — только критерии рубрики из контекста.",
    "room_mismatch": "room_id — точная копия context.room_id.",
    "coach_state": "Согласуй поля со статусом и триггером: finished — next_speaker null и report; paused — "
                   "next_speaker null; in_progress и fallback_text — next_speaker из комнаты (A, B или both); "
                   "trigger end — finished; roles и team_goal_en — только при trigger start; options — только в "
                   "режиме choices при ходе (≤ 3), иначе null; team_goal_progress не меньше текущего.",
}


@dataclass
class GateResult:
    violations: list[str] = field(default_factory=list)
    redactions: list[str] = field(default_factory=list)
    output: dict[str, Any] = field(default_factory=dict)

    def add(self, code: str) -> None:
        if code not in self.violations:
            self.violations.append(code)


def _strings(value: Any, path: str = "") -> Iterator[tuple[str, str]]:
    if isinstance(value, str):
        yield path, value
    elif isinstance(value, dict):
        for k, v in value.items():
            yield from _strings(v, f"{path}.{k}" if path else str(k))
    elif isinstance(value, list):
        for i, v in enumerate(value):
            yield from _strings(v, f"{path}.{i}" if path else str(i))


def _phone_violation(text: str) -> bool:
    for m in PHONE_RE.finditer(text):
        digits = re.sub(r"\D", "", m.group(0))
        if len(digits) >= 7 and not ALLOWED_PHONE_RE.match(digits):
            return True
    return False


def _cyrillic_share(text: str) -> float:
    letters = LETTER_RE.findall(text)
    if not letters:
        return 0.0
    return sum(1 for ch in letters if CYRILLIC_RE.match(ch)) / len(letters)


def check_text(text: str, secrets: tuple[str, ...] = ()) -> list[str]:
    codes: list[str] = []
    if LINK_RE.search(text):
        codes.append("link")
    if EMAIL_RE.search(text):
        codes.append("email")
    if _phone_violation(text):
        codes.append("phone")
    if SECRET_RE.search(text) or any(s and s in text for s in secrets):
        codes.append("secret")
    if CERT_RE.search(text):
        codes.append("certificate_claim")
    return codes


def check_output(agent_id: str, output: dict[str, Any], context: dict[str, Any], *,
                 secrets: tuple[str, ...] = (), provider: str | None = None) -> GateResult:
    """Правила §1.3 по выводу, уже прошедшему схему версии и контракт ai.ts. provider — имя провайдера ответа
    (fake: языковые правила gloss_word не применяются)."""
    result = GateResult(output=output)
    for path, text in _strings(output):
        # цитата ученика (evidence) — данные ученика, а не текст агента: проверяется только на ключи
        if agent_id == "independent_evaluator" and path.endswith(".evidence"):
            if "secret" in check_text(text, secrets):
                result.add("secret")
            continue
        # идентификаторы коуча (UUID комнаты, T{n}, коды) — не текст: цифры UUID похожи на телефон
        if agent_id == "cooperative_lesson_coach" and _coach_id_path(path):
            if "secret" in check_text(text, secrets):
                result.add("secret")
            continue
        for code in check_text(text, secrets):
            result.add(code)
    if "pronunciation_score" in output and output.get("pronunciation_score") is not None:
        result.add("pronunciation_scored")
    if output.get("cefr_certificate") not in (None, False):
        result.add("certificate_claim")
    if agent_id == "conversation_partner":
        _conversation_partner(output, context, result)
    elif agent_id == "teaching_coach" and context.get("request") == "gloss_word":
        _gloss_word(output, result, check_language=provider != "fake")
    elif agent_id == "teaching_coach":
        _teaching_coach(output, context, result)
    elif agent_id == "independent_evaluator":
        _independent_evaluator(output, context, result)
    elif agent_id == "cooperative_lesson_coach":
        _cooperative_coach(output, context, result)
    return result


def _conversation_partner(output: dict[str, Any], context: dict[str, Any], result: GateResult) -> None:
    reply = str(output.get("reply_en", ""))
    if len(reply) > REPLY_MAX_CHARS:
        result.add("too_long")
    level = str((context.get("scenario") or {}).get("level", ""))
    if level in LOW_BANDS and len(WORD_RE.findall(reply)) > REPLY_MAX_WORDS:
        result.add("too_many_words")
    if CYRILLIC_RE.search(reply):
        result.add("wrong_language")
    allowed = {t.get("intent") for t in (context.get("node") or {}).get("transitions", [])} | {"unclear", "off_topic"}
    if output.get("intent") not in allowed:
        result.add("intent_unknown")


def _teaching_coach(output: dict[str, Any], context: dict[str, Any], result: GateResult) -> None:
    if CYRILLIC_RE.search(str(output.get("example_en", ""))):
        result.add("wrong_language")
    locale = context.get("explain_locale")
    for name in ("explanation", "example_gloss"):
        share = _cyrillic_share(str(output.get(name, "")))
        # ru — объяснение кириллицей (английские слова-примеры внутри допустимы); uz — латиницей (CONVENTIONS)
        if (locale == "ru" and share < 0.5) or (locale == "uz" and share > 0.2):
            result.add("wrong_language")


def _gloss_word(output: dict[str, Any], result: GateResult, *, check_language: bool) -> None:
    gloss = output.get("gloss") or {}
    ru, uz = str(gloss.get("ru", "")), str(gloss.get("uz", ""))
    if check_language:
        english = [str(output.get("lemma", "")), *(str(f) for f in output.get("forms") or [])]
        if LATIN_RE.search(ru) or not CYRILLIC_RE.search(ru) or CYRILLIC_RE.search(uz) \
                or any(CYRILLIC_RE.search(t) for t in english):
            result.add("wrong_language")
            return
    fixed = UZ_APOSTROPHE_RE.sub("ʻ", uz)
    if fixed != uz:
        result.output = {**output, "gloss": {**gloss, "uz": fixed}}
        result.redactions.append("uz_apostrophe_fixed")


def _independent_evaluator(output: dict[str, Any], context: dict[str, Any], result: GateResult) -> None:
    criteria = {c.get("code") for c in (context.get("rubric") or {}).get("criteria", [])}
    scores = output.get("scores") or {}
    if any(code not in criteria for code in scores):
        result.add("criterion_unknown")
    if scores.get("pronunciation") is not None:
        result.add("pronunciation_scored")
    for err in output.get("confirmed_errors") or []:
        if CYRILLIC_RE.search(str(err.get("correction", ""))):
            result.add("wrong_language")
    learner = {t.get("turn_id"): str(t.get("text", "")) for t in context.get("turns", [])
               if t.get("speaker") == "learner"}
    kept = []
    for err in output.get("confirmed_errors") or []:
        source = learner.get(err.get("turn_id"))
        if source is not None and str(err.get("evidence", "")) and str(err.get("evidence")) in source:
            kept.append(err)
    if len(kept) != len(output.get("confirmed_errors") or []):
        result.output = {**output, "confirmed_errors": kept}
        result.redactions.append("evidence_dropped")


# ---------------------------------------------------------------- cooperative_lesson_coach (спринт 7)

COACH_ID_FIELDS: Final = frozenset({"room_id", "status", "next_speaker", "escalation", "turn_id", "skill_id",
                                     "choice_id", "role"})
COACH_TIPS_PER_ROLE: Final = 3
RU_MIN_CYRILLIC: Final = 0.4
UZ_MAX_CYRILLIC: Final = 0.2


def _coach_id_path(path: str) -> bool:
    return path.rsplit(".", 1)[-1] in COACH_ID_FIELDS


def _fix_uz(text: str) -> str:
    return UZ_APOSTROPHE_RE.sub("ʻ", text)


def _bilingual_ok(pair: Any) -> bool:
    """{ru, uz}: ru — кириллицей (английские слова-примеры внутри допустимы), uz — латиницей."""
    if not isinstance(pair, dict):
        return True
    return _cyrillic_share(str(pair.get("ru", ""))) >= RU_MIN_CYRILLIC \
        and _cyrillic_share(str(pair.get("uz", ""))) <= UZ_MAX_CYRILLIC


def _with_uz_fixed(pair: Any, changed: list[bool]) -> Any:
    """{ru, uz} с исправленными апострофами uz; changed[0] = True, если что-то исправлено."""
    if not isinstance(pair, dict) or not isinstance(pair.get("uz"), str):
        return pair
    fixed = _fix_uz(pair["uz"])
    if fixed != pair["uz"]:
        changed[0] = True
    return {**pair, "uz": fixed}


def _coach_state(output: dict[str, Any], context: dict[str, Any]) -> bool:
    """Согласованность вывода со статусом, триггером и комнатой (ai.ts CooperativeCoachOutput)."""
    status, speaker = output.get("status"), output.get("next_speaker")
    trigger, mode = context.get("trigger"), context.get("mode")
    roles = {str(p.get("role")) for p in context.get("participants", [])}
    report = output.get("report")
    if (status == "finished") != (report is not None):
        return False
    if status in ("finished", "paused") and speaker is not None:
        return False
    if status in ("in_progress", "fallback_text") and (speaker is None or (speaker != "both" and speaker not in roles)):
        return False
    if trigger == "end" and status != "finished":
        return False
    started = trigger == "start"
    if started != (output.get("roles") is not None) or started != (output.get("team_goal_en") is not None):
        return False
    options = output.get("options")
    turn_open = status in ("in_progress", "fallback_text")
    if mode == "choices" and turn_open:
        if not options:
            return False
    elif options is not None:
        return False
    progress = output.get("team_goal_progress")
    current = context.get("team_goal_progress")
    return not (isinstance(progress, int | float) and isinstance(current, int | float) and progress + 1e-9 < current)


def _cooperative_coach(output: dict[str, Any], context: dict[str, Any], result: GateResult) -> None:
    if str(output.get("room_id", "")).lower() != str(context.get("room_id", "")).lower():
        result.add("room_mismatch")
    if not _coach_state(output, context):
        result.add("coach_state")
    english = [str(output.get("prompt", "")), str(output.get("team_goal_en") or "")]
    english += [str(o.get("text_en", "")) for o in output.get("options") or []]
    english += [str(v) for v in (output.get("roles") or {}).values()]
    report = output.get("report") or {}
    bilingual = [output.get("prompt_gloss"), report.get("team_summary"),
                 *(t.get("text") for t in report.get("tips") or [])]
    if any(CYRILLIC_RE.search(t) for t in english) or not all(_bilingual_ok(b) for b in bilingual if b is not None):
        result.add("wrong_language")
    if result.violations:
        return
    fixed = dict(output)
    changed = [False]
    # доказательства — только реплики этой роли из context.turns (ответ одного не присваивается другому)
    owner = {str(t.get("turn_id")): str(t.get("speaker")) for t in context.get("turns", [])}
    seen: set[tuple[str, str]] = set()
    kept = []
    for ev in output.get("individual_evidence") or []:
        key = (str(ev.get("role")), str(ev.get("turn_id")))
        if owner.get(key[1]) == key[0] and key not in seen:
            seen.add(key)
            kept.append(ev)
    if len(kept) != len(output.get("individual_evidence") or []):
        fixed["individual_evidence"] = kept
        result.redactions.append("evidence_dropped")
    # отчёт: подсказки — только ролям с вкладом, не больше трёх на роль
    if output.get("report") is not None:
        contributed = {str(p.get("role")) for p in context.get("participants", []) if int(p.get("turns", 0)) > 0}
        per_role: dict[str, int] = {}
        tips = []
        for tip in report.get("tips") or []:
            role = str(tip.get("role"))
            per_role[role] = per_role.get(role, 0) + 1
            if role in contributed and per_role[role] <= COACH_TIPS_PER_ROLE:
                tips.append({**tip, "text": _with_uz_fixed(tip.get("text"), changed)})
        if len(tips) != len(report.get("tips") or []):
            result.redactions.append("tips_dropped")
        fixed["report"] = {**report, "team_summary": _with_uz_fixed(report.get("team_summary"), changed),
                           "tips": tips}
    if output.get("prompt_gloss") is not None:
        fixed["prompt_gloss"] = _with_uz_fixed(output.get("prompt_gloss"), changed)
    if changed[0]:
        result.redactions.append("uz_apostrophe_fixed")
    result.output = fixed
