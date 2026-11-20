"""Оценка произношения по распознанным словам (релиз 5.1, провайдер `whisper`): сравнение слов, распознанных
faster-whisper в сервисе tts, с эталоном. Это оценка **разборчивости слов** (понял ли распознаватель слово и насколько
уверенно), без оценки отдельных звуков; акцент не ошибка — советы те же правила (≤ 2, без «акцента»).

**Нормализация** (как сравнение ответа в memory, INTERNAL_API §1.6): NFC, нижний регистр, апострофы ’ ‘ ` ʼ → ',
пунктуация по краям слова снимается; слова через дефис и тире — части одного слова («twenty-five» → twenty five);
сокращения раскрываются в обе стороны (I'm = I am, can't = cannot = can not, …); числа цифрами — словами (25 → twenty
five, 10:40 → ten forty, 20th → twentieth): распознаватель пишет числа цифрами, эталон — как в контенте.

**Выравнивание** — расстояние Левенштейна по частям слов (совпадение 0, замена / пропуск / лишнее — 1), при равной цене
предпочитается диагональ (совпадение или замена). Слово эталона:
- все части совпали → `accuracy = round(средняя probability × 100)`; probability < 0,5 → `mispronunciation`
  (распознаватель едва узнал слово), иначе `none`;
- ни одна часть не прозвучала → `omission`, accuracy 0;
- иначе (замена другим словом, часть пропущена) → `mispronunciation`, accuracy = среднее по частям: совпала —
  probability × 100, заменена — 10 + 40 × похожесть написания (0..1, Левенштейн по буквам), пропущена — 0
  (замена всегда ≤ 50);
- лишнее распознанное слово (целиком не сопоставлено эталону) → `insertion`, accuracy null.

**Баллы** (0..100):
- accuracy — среднее accuracy слов эталона;
- completeness — доля слов эталона, распознанных целиком (все части совпали), × 100;
- fluency — по времени слов: 100 − паузы − медленный темп; пауза между словами ≥ 0,7 с — 10, ≥ 1,5 с — 20 (вместе не
  больше 60); темп ниже 1,5 слова/с по отрезку от начала первого до конца последнего слова — (1,5 − темп) × 40 (не
  больше 40); одно слово — 100;
- pron = 0,6 × accuracy + 0,2 × fluency + 0,2 × completeness.

confidence — средняя probability распознанных слов. Результат — в формате ответа Azure (`RecognitionStatus`,
`NBest[0]`), дальше общий разбор `domain/speech.py`: нет слов → `insufficient_evidence: not_recognized`,
confidence < 0,4 → `low_confidence`, completeness < 30 → `incomplete`.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from itertools import pairwise
from typing import Any, Final

APOSTROPHES: Final = str.maketrans({"’": "'", "‘": "'", "`": "'", "ʼ": "'", "ʻ": "'"})
EDGE: Final = " .,!?…:;\"«»“”„()[]{}*_"
SPLIT_WORDS: Final = re.compile(r"\s+")
SPLIT_PARTS: Final = re.compile(r"[-‐‑–—/:]+")
NUMBER: Final = re.compile(r"^(\d{1,3}(?:,\d{3})+|\d+)(st|nd|rd|th)?$")
MAX_WORDS: Final = 40
LOW_PROBABILITY: Final = 0.5
PAUSE_MS: Final = 700
HESITATION_MS: Final = 1500
SLOW_RATE: Final = 1.5  # слов в секунду

# сокращения memory (§1.6) и близкие частые формы — обе стороны раскрываются одинаково
CONTRACTIONS: Final[dict[str, str]] = {
    "i'm": "i am", "you're": "you are", "he's": "he is", "she's": "she is", "it's": "it is", "we're": "we are",
    "they're": "they are", "don't": "do not", "doesn't": "does not", "didn't": "did not", "can't": "can not",
    "cannot": "can not", "won't": "will not", "isn't": "is not", "aren't": "are not", "i've": "i have",
    "i'll": "i will", "let's": "let us", "what's": "what is", "that's": "that is", "there's": "there is",
    "wasn't": "was not", "weren't": "were not", "haven't": "have not", "hasn't": "has not", "couldn't": "could not",
    "wouldn't": "would not", "shouldn't": "should not", "you'll": "you will", "we'll": "we will",
    "they'll": "they will", "he'll": "he will", "she'll": "she will", "it'll": "it will", "i'd": "i would",
    "you'd": "you would", "we've": "we have", "you've": "you have", "they've": "they have", "where's": "where is",
    "who's": "who is", "here's": "here is", "how's": "how is",
}
ONES: Final = ("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen "
               "seventeen eighteen nineteen").split()
TENS: Final = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()
ORDINAL: Final[dict[str, str]] = {"one": "first", "two": "second", "three": "third", "five": "fifth", "eight": "eighth",
                                  "nine": "ninth", "twelve": "twelfth"}


def number_words(n: int) -> list[str]:
    """0..999 999 999 словами (без «and»); больше — по цифрам."""
    if n < 20:
        return [ONES[n]]
    if n < 100:
        return [TENS[n // 10]] + ([ONES[n % 10]] if n % 10 else [])
    if n < 1000:
        return [ONES[n // 100], "hundred"] + (number_words(n % 100) if n % 100 else [])
    for size, name in ((1_000_000, "million"), (1000, "thousand")):
        if n >= size and n < size * 1000:
            return number_words(n // size) + [name] + (number_words(n % size) if n % size else [])
    return [ONES[int(d)] for d in str(n)]


def _ordinal(words: list[str]) -> list[str]:
    last = words[-1]
    if last in ORDINAL:
        last = ORDINAL[last]
    elif last.endswith("y"):
        last = last[:-1] + "ieth"
    else:
        last += "th"
    return [*words[:-1], last]


def _part_tokens(part: str) -> list[str]:
    part = part.strip("'")
    if not part:
        return []
    m = NUMBER.match(part)
    if m:
        words = number_words(int(m.group(1).replace(",", "")))
        return _ordinal(words) if m.group(2) else words
    if part in CONTRACTIONS:
        return CONTRACTIONS[part].split()
    cleaned = re.sub(r"[^a-z0-9']", "", part).strip("'")
    if cleaned.isdigit():
        return number_words(int(cleaned))
    return [cleaned] if cleaned else []


@dataclass
class Token:
    display: str
    parts: list[str]
    probability: float = 1.0
    start_ms: int = 0
    end_ms: int = 0


def tokenize(text: str) -> list[Token]:
    """Слова для отображения (как в тексте, без краевой пунктуации) и их нормализованные части."""
    out: list[Token] = []
    for raw in SPLIT_WORDS.split(unicodedata.normalize("NFC", text).translate(APOSTROPHES)):
        display = raw.strip(EDGE)
        if not display:
            continue
        parts: list[str] = []
        for piece in SPLIT_PARTS.split(display.lower()):
            parts.extend(_part_tokens(piece.strip(EDGE)))
        if parts:
            out.append(Token(display=display[:60], parts=parts))
    return out


def _levenshtein(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def similarity(a: str, b: str) -> float:
    return 1.0 - _levenshtein(a, b) / max(len(a), len(b), 1)


def align(ref: list[str], hyp: list[str]) -> list[tuple[str, int | None, int | None]]:
    """Левенштейн по частям: [(match | sub | del | ins, индекс эталона, индекс распознанного)] по порядку."""
    n, m = len(ref), len(hyp)
    d = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        d[i][0] = i
    for j in range(1, m + 1):
        d[0][j] = j
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            d[i][j] = min(d[i - 1][j - 1] + (ref[i - 1] != hyp[j - 1]), d[i - 1][j] + 1, d[i][j - 1] + 1)
    ops: list[tuple[str, int | None, int | None]] = []
    i, j = n, m
    while i > 0 or j > 0:
        if i > 0 and j > 0 and d[i][j] == d[i - 1][j - 1] + (ref[i - 1] != hyp[j - 1]):
            ops.append(("match" if ref[i - 1] == hyp[j - 1] else "sub", i - 1, j - 1))
            i, j = i - 1, j - 1
        elif i > 0 and d[i][j] == d[i - 1][j] + 1:
            ops.append(("del", i - 1, None))
            i -= 1
        else:
            ops.append(("ins", None, j - 1))
            j -= 1
    ops.reverse()
    return ops


@dataclass
class WordResult:
    word: str
    accuracy: float | None
    error_type: str  # None | Omission | Insertion | Mispronunciation (как у Azure)
    recognized: bool = False
    scores: list[float] = field(default_factory=list)


def fluency(words: list[Token]) -> float:
    if len(words) < 2:
        return 100.0
    penalty = 0.0
    for prev, nxt in pairwise(words):
        gap = nxt.start_ms - prev.end_ms
        penalty += 20 if gap >= HESITATION_MS else 10 if gap >= PAUSE_MS else 0
    penalty = min(penalty, 60.0)
    span_s = max(words[-1].end_ms - words[0].start_ms, 1) / 1000
    rate = len(words) / span_s
    slow = min(max(0.0, SLOW_RATE - rate) * 40, 40.0)
    return max(0.0, min(100.0, 100.0 - penalty - slow))


def score(reference_text: str, recognized: list[dict[str, Any]]) -> dict[str, Any]:
    """Слова tts `/recognize` ({word, start_ms, end_ms, probability}) против эталона → ответ в формате Azure."""
    ref_words = tokenize(reference_text)
    hyp_words: list[Token] = []
    for item in recognized:
        for tok in tokenize(str(item.get("word", ""))):
            prob = item.get("probability")
            tok.probability = min(1.0, max(0.0, float(prob))) if isinstance(prob, int | float) else 0.0
            tok.start_ms = int(item.get("start_ms") or 0)
            tok.end_ms = int(item.get("end_ms") or tok.start_ms)
            hyp_words.append(tok)
    if not ref_words or not hyp_words:
        return {"RecognitionStatus": "NoMatch"}
    ref_parts = [(k, p) for k, w in enumerate(ref_words) for p in w.parts]
    hyp_parts = [(k, p) for k, w in enumerate(hyp_words) for p in w.parts]
    ops = align([p for _, p in ref_parts], [p for _, p in hyp_parts])

    results = [WordResult(word=w.display, accuracy=None, error_type="None") for w in ref_words]
    statuses: list[list[str]] = [[] for _ in ref_words]
    aligned_hyp: set[int] = set()
    for op, i, j in ops:
        if op in ("match", "sub") and i is not None and j is not None:
            owner, hyp_owner = ref_parts[i][0], hyp_parts[j][0]
            aligned_hyp.add(hyp_owner)
            statuses[owner].append(op)
            prob = hyp_words[hyp_owner].probability
            results[owner].scores.append(prob * 100 if op == "match"
                                         else 10 + 40 * similarity(ref_parts[i][1], hyp_parts[j][1]))
        elif op == "del" and i is not None:
            statuses[ref_parts[i][0]].append("del")
            results[ref_parts[i][0]].scores.append(0.0)
    for res, st in zip(results, statuses, strict=True):
        mean = sum(res.scores) / len(res.scores) if res.scores else 0.0
        if st and all(s == "match" for s in st):
            res.recognized = True
            res.accuracy = round(mean)
            res.error_type = "None" if mean >= LOW_PROBABILITY * 100 else "Mispronunciation"
        elif not st or all(s == "del" for s in st):
            res.accuracy, res.error_type = 0, "Omission"
        else:
            res.accuracy, res.error_type = round(min(mean, 59)), "Mispronunciation"

    # порядок вывода: слова эталона по порядку, лишние слова — там, где распознаны
    out: list[dict[str, Any]] = []
    emitted_ref: set[int] = set()
    emitted_hyp: set[int] = set()
    for op, i, j in ops:
        if i is not None and ref_parts[i][0] not in emitted_ref:
            k = ref_parts[i][0]
            emitted_ref.add(k)
            out.append({"Word": results[k].word, "AccuracyScore": results[k].accuracy,
                        "ErrorType": results[k].error_type})
        elif op == "ins" and j is not None:
            k = hyp_parts[j][0]
            if k not in aligned_hyp and k not in emitted_hyp:
                emitted_hyp.add(k)
                out.append({"Word": hyp_words[k].display, "AccuracyScore": None, "ErrorType": "Insertion"})
    while len(out) > MAX_WORDS and any(w["ErrorType"] == "Insertion" for w in out):
        last = max(idx for idx, w in enumerate(out) if w["ErrorType"] == "Insertion")
        out.pop(last)

    accuracy = sum(float(r.accuracy or 0) for r in results) / len(results)
    completeness = 100 * sum(1 for r in results if r.recognized) / len(results)
    flu = fluency(hyp_words)
    pron = 0.6 * accuracy + 0.2 * flu + 0.2 * completeness
    confidence = sum(w.probability for w in hyp_words) / len(hyp_words)
    return {"RecognitionStatus": "Success",
            "NBest": [{"Confidence": round(confidence, 4), "AccuracyScore": round(accuracy, 1),
                       "FluencyScore": round(flu, 1), "CompletenessScore": round(completeness, 1),
                       "PronScore": round(pron, 1), "Words": out[:MAX_WORDS]}]}
