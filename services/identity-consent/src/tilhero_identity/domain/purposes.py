"""Цели согласия как выключатели функций (INTERNAL_API §11, ревью P-3).

- Согласие считается принятым, если в действующей записи есть `terms` и `privacy` (у детского профиля — запись
  родителя с основанием guardian).
- Необязательные цели действуют, только пока они разрешены: 18+ — сам; 14–17 — при согласии родителя; детский
  профиль и возраст не выбран — никогда (age.optional_purposes_allowed).
- Категории доставки `social` и `product` учитываются только при целях `social` и `product_news`; остальные
  категории от целей не зависят.
"""

from __future__ import annotations

from collections.abc import Iterable

ACCEPTED_PURPOSES: tuple[str, ...] = ("terms", "privacy")
# категория уведомлений → цель согласия, без которой она не доставляется
CATEGORY_PURPOSES: dict[str, str] = {"social": "social", "product": "product_news"}


def consent_accepted(purposes: Iterable[str]) -> bool:
    present = set(purposes)
    return all(p in present for p in ACCEPTED_PURPOSES)


def effective_purposes(purposes: Iterable[str], *, optional: Iterable[str], optional_allowed: bool) -> list[str]:
    """Цели записи в её порядке; необязательные — только если сейчас разрешены."""
    blocked = set() if optional_allowed else set(optional)
    return [p for p in dict.fromkeys(purposes) if p not in blocked]


def delivery_categories(categories: Iterable[str], purposes: Iterable[str]) -> list[str]:
    """Включённые категории без тех, чья цель согласия не принята (порядок сохраняется)."""
    granted = set(purposes)
    return [c for c in categories if c not in CATEGORY_PURPOSES or CATEGORY_PURPOSES[c] in granted]
