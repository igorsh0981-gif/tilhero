"""FSRS-5 с параметрами по умолчанию (INTERNAL_API §1.4, версия `fsrs5-default-1`) — без внешних зависимостей.

Срок следующего повторения считает только этот модуль: клиент и ИИ сроки не задают; `easy` автоматически не
ставится (сюда приходят только again | hard | good — правила оценки в domain/grading.py).

- R(t, S) = (1 + FACTOR · t / S)^DECAY, t — дни с последнего повторения (дробные);
- I = round(S / FACTOR · (r^(1/DECAY) − 1)), 1..365 (при r = 0,9 I ≈ S);
- первая оценка: S₀ = w[G−1], D₀(G) = w4 − e^(w5·(G−1)) + 1 (1..10);
- t ≥ 1 дня: D″ = w7·D₀(4) + (1 − w7)·(D + ΔD·(10 − D)/9), ΔD = −w6·(G − 3);
  успех: S′ = S·(e^w8·(11 − D)·S^(−w9)·(e^(w10·(1 − R)) − 1)·(G=2 ? w15 : 1)·(G=4 ? w16 : 1) + 1);
  провал: S′ = min(S, w11·D^(−w12)·((S + 1)^w13 − 1)·e^(w14·(1 − R))), lapses + 1;
- t < 1 дня (повтор в тот же день): S′ = S·e^(w17·(G − 3 + w18)), D — как выше;
- состояние: new → learning (первая оценка); learning → review при G ≥ 2 и S′ ≥ 1; провал в review → learning.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from typing import Final

ALGORITHM: Final = "fsrs-5"
PARAMS_VERSION: Final = "fsrs5-default-1"
W: Final = (0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192, 1.01925, 1.9395,
            0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621)
DECAY: Final = -0.5
FACTOR: Final = 19 / 81
TARGET_RETENTION: Final = 0.9
MIN_INTERVAL: Final = 1
MAX_INTERVAL: Final = 365
MIN_STABILITY: Final = 0.001
GRADES: Final = {"again": 1, "hard": 2, "good": 3, "easy": 4}
DAY_SECONDS: Final = 86_400.0


@dataclass(frozen=True)
class Memory:
    """Состояние планировщика карточки."""

    state: str  # new | learning | review
    stability: float | None
    difficulty: float | None
    reps: int
    lapses: int
    last_review_at: datetime | None
    due_at: datetime | None


@dataclass(frozen=True)
class Outcome:
    memory: Memory
    elapsed_days: float | None  # None — первая оценка
    interval_days: int
    retrievability: float | None  # R на момент ответа (None — первая оценка)
    short_term: bool


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def grade_value(grade: str) -> int:
    if grade not in GRADES:
        raise ValueError(f"unknown grade {grade!r}")
    return GRADES[grade]


def retrievability(elapsed_days: float, stability: float) -> float:
    """R(t, S) = (1 + FACTOR · t / S)^DECAY."""
    t = max(elapsed_days, 0.0)
    return float((1 + FACTOR * t / stability) ** DECAY)


def interval_days(stability: float, retention: float = TARGET_RETENTION) -> int:
    """I = round(S / FACTOR · (r^(1/DECAY) − 1)), ограничено 1..365 (округление — половина вверх; допуск 1e-9 на
    погрешность float: при r = 0,9 множитель ровно 1)."""
    raw = stability / FACTOR * (retention ** (1 / DECAY) - 1)
    return int(_clamp(math.floor(raw + 0.5 + 1e-9), MIN_INTERVAL, MAX_INTERVAL))


def init_stability(g: int) -> float:
    return W[g - 1]


def init_difficulty(g: int) -> float:
    """D₀(G) = w4 − e^(w5·(G−1)) + 1, 1..10."""
    return _clamp(W[4] - math.exp(W[5] * (g - 1)) + 1, 1.0, 10.0)


def next_difficulty(d: float, g: int) -> float:
    """ΔD = −w6·(G − 3); D′ = D + ΔD·(10 − D)/9; D″ = w7·D₀(4) + (1 − w7)·D′; 1..10."""
    delta = -W[6] * (g - 3)
    d1 = d + delta * (10 - d) / 9
    d2 = W[7] * init_difficulty(4) + (1 - W[7]) * d1
    return _clamp(d2, 1.0, 10.0)


def stability_after_success(s: float, d: float, r: float, g: int) -> float:
    hard = W[15] if g == 2 else 1.0
    easy = W[16] if g == 4 else 1.0
    return s * (math.exp(W[8]) * (11 - d) * s ** (-W[9]) * (math.exp(W[10] * (1 - r)) - 1) * hard * easy + 1)


def stability_after_failure(s: float, d: float, r: float) -> float:
    return min(s, W[11] * d ** (-W[12]) * ((s + 1) ** W[13] - 1) * math.exp(W[14] * (1 - r)))


def stability_short_term(s: float, g: int) -> float:
    """Повтор в тот же день (t < 1 дня): S′ = S·e^(w17·(G − 3 + w18))."""
    return s * math.exp(W[17] * (g - 3 + W[18]))


def new_memory() -> Memory:
    return Memory("new", None, None, 0, 0, None, None)


def review(m: Memory, grade: str, now: datetime) -> Outcome:
    """Оценка ответа → новое состояние и срок (`due_at` = момент ответа + I дней)."""
    g = grade_value(grade)
    if m.state == "new" or m.stability is None or m.difficulty is None or m.last_review_at is None:
        s = init_stability(g)
        d = init_difficulty(g)
        interval = interval_days(s)
        nm = Memory("learning", s, d, m.reps + 1, m.lapses, now, now + timedelta(days=interval))
        return Outcome(nm, None, interval, None, False)
    elapsed = max((now - m.last_review_at).total_seconds() / DAY_SECONDS, 0.0)
    s0, d0 = m.stability, m.difficulty
    d = next_difficulty(d0, g)
    lapses = m.lapses
    r: float | None
    if elapsed < 1.0:
        short = True
        r = retrievability(elapsed, s0)
        s = stability_short_term(s0, g)
    else:
        short = False
        r = retrievability(elapsed, s0)
        if g == 1:
            s = stability_after_failure(s0, d0, r)
            lapses += 1
        else:
            s = stability_after_success(s0, d0, r, g)
    s = max(s, MIN_STABILITY)
    if m.state == "learning":
        state = "review" if g >= 2 and s >= 1.0 else "learning"
    else:  # review
        state = "learning" if g == 1 else "review"
    interval = interval_days(s)
    nm = replace(m, state=state, stability=s, difficulty=d, reps=m.reps + 1, lapses=lapses, last_review_at=now,
                 due_at=now + timedelta(days=interval))
    return Outcome(nm, elapsed, interval, r, short)


def current_retrievability(m: Memory, now: datetime) -> float | None:
    if m.state == "new" or m.stability is None or m.last_review_at is None:
        return None
    return retrievability((now - m.last_review_at).total_seconds() / DAY_SECONDS, m.stability)
