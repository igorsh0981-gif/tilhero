"""safety_quality_gate (код, INTERNAL_API §1.3): проверка вывода агента после JSON-схемы версии и контракта ai.ts.

Нарушения → `retry_with_constraints` (коды уходят в rules повторного запроса), повторное — отказ (`invalid_output`).
Исправления без повтора (`redact`): подтверждённая ошибка оценщика, чьей цитаты нет дословно в реплике ученика
с этим turn_id, отбрасывается (как и в assessment) — предупреждение `evidence_dropped`.

Коды: link, email, phone, secret, certificate_claim, pronunciation_scored, too_long, too_many_words, wrong_language,
intent_unknown, criterion_unknown (+ разбор: not_json, schema_invalid, contract_mismatch).
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
    "wrong_language": "Объяснения — на языке объяснений ученика (ru/uz), учебные поля — только на английском.",
    "intent_unknown": "intent — только один из переходов текущего узла, либо unclear, либо off_topic.",
    "criterion_unknown": "scores — только критерии рубрики из контекста.",
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
                 secrets: tuple[str, ...] = ()) -> GateResult:
    """Правила §1.3 по выводу, уже прошедшему схему версии и контракт ai.ts."""
    result = GateResult(output=output)
    for path, text in _strings(output):
        # цитата ученика (evidence) — данные ученика, а не текст агента: проверяется только на ключи
        if agent_id == "independent_evaluator" and path.endswith(".evidence"):
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
    elif agent_id == "teaching_coach":
        _teaching_coach(output, context, result)
    elif agent_id == "independent_evaluator":
        _independent_evaluator(output, context, result)
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
