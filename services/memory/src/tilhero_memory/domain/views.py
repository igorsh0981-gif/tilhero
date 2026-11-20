"""Формы ответов по карточкам: ученику (bff.ts DictionaryCard) и админке (admin.ts AdminCardRow), снимок FSRS для
истории планирования. Цитата ошибки (evidence) — только ученику в его карточке, в админке не показывается."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from tilhero_memory.domain import fsrs
from tilhero_memory.domain.common import iso
from tilhero_memory.models import Card

HIDDEN_DUE = frozenset({"known", "frozen", "archived"})


def memory_of(card: Card) -> fsrs.Memory:
    return fsrs.Memory(card.fsrs_state, card.stability, card.difficulty, card.reps, card.lapses,
                       card.last_review_at, card.due_at)


def apply_memory(card: Card, m: fsrs.Memory) -> None:
    card.fsrs_state = m.state
    card.stability = m.stability
    card.difficulty = m.difficulty
    card.reps = m.reps
    card.lapses = m.lapses
    card.last_review_at = m.last_review_at
    card.due_at = m.due_at


def snapshot(card: Card) -> dict[str, Any]:
    """FsrsSnapshot (admin.ts): было/стало в истории планирования."""
    return {"state": card.fsrs_state,
            "stability": round(card.stability, 6) if card.stability is not None else None,
            "difficulty": round(card.difficulty, 6) if card.difficulty is not None else None,
            "due_at": iso(card.due_at), "status": card.status}


def retrievability(card: Card, now: datetime) -> float | None:
    return fsrs.current_retrievability(memory_of(card), now)


def strength(card: Card, now: datetime) -> str:
    """new — ещё не повторялась; weak — R < 0.7 или lapses ≥ 2; ok — S < 21 дня; strong."""
    if card.fsrs_state == "new" or card.stability is None:
        return "new"
    r = retrievability(card, now)
    if (r is not None and r < 0.7) or card.lapses >= 2:
        return "weak"
    if card.stability < 21:
        return "ok"
    return "strong"


def dictionary_card(card: Card, now: datetime) -> dict[str, Any]:
    return {
        "card_id": str(card.card_id), "kind": card.kind, "text_en": card.text_en, "gloss": dict(card.gloss),
        "gloss_source": card.gloss_source, "status": card.status, "strength": strength(card, now),
        "due_at": None if card.status in HIDDEN_DUE else iso(card.due_at),
        "last_reviewed_at": iso(card.last_review_at), "created_at": iso(card.created_at),
    }


def admin_row(card: Card, now: datetime) -> dict[str, Any]:
    """AdminCardRow: у карточек ошибок text_en = null — исправление выведено из свободного текста ученика (в админке
    только error_code и его подпись)."""
    r = retrievability(card, now)
    return {
        "card_id": str(card.card_id), "kind": card.kind, "text_en": None if card.kind == "error" else card.text_en,
        "gloss": dict(card.gloss),
        "status": card.status,
        "stability": round(card.stability, 4) if card.stability is not None else None,
        "difficulty": round(card.difficulty, 4) if card.difficulty is not None else None,
        "retrievability": round(r, 4) if r is not None else None,
        "reps": card.reps, "lapses": card.lapses, "due_at": iso(card.due_at),
        "last_review_at": iso(card.last_review_at), "error_code": card.error_code,
    }
