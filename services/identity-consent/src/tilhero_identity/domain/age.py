"""Возраст и согласие родителя (CONVENTIONS §8, решение заказчика №2).

- 6–13 — только детский профиль на аккаунте родителя (`kind=child`, без своего Telegram);
- 14–17 — свой аккаунт, необязательные функции — только после согласия родителя по ссылке (`guardian_consent=granted`);
- 18+ — сам.

Возраст хранит только identity-consent; другие сервисы получают `age_band` / `is_minor` (без даты рождения).
"""

from __future__ import annotations

from typing import Literal

AgeBand = Literal["6-9", "10-13", "14-17", "18+"]
GuardianConsent = Literal["not_required", "pending", "granted", "declined"]

AGE_BANDS: tuple[str, ...] = ("6-9", "10-13", "14-17", "18+")
ACCOUNT_AGE_BANDS: tuple[str, ...] = ("14-17", "18+")
CHILD_AGE_BANDS: tuple[str, ...] = ("6-9", "10-13")
MINOR_AGE_BANDS: frozenset[str] = frozenset({"6-9", "10-13", "14-17"})
TEEN = "14-17"
ADULT = "18+"
GUARDIAN_CONSENT_STATES: tuple[str, ...] = ("not_required", "pending", "granted", "declined")


def is_minor(age_band: str | None) -> bool:
    """Возраст не выбран — признак неизвестен: False (правила детей 6–13 применяются только по явному возрасту)."""
    return age_band in MINOR_AGE_BANDS


def is_adult(age_band: str | None) -> bool:
    return age_band == ADULT


def guardian_consent_for(age_band: str) -> str:
    """Начальное состояние согласия родителя после выбора возраста аккаунта."""
    return "pending" if age_band == TEEN else "not_required"


def optional_purposes_allowed(age_band: str | None, guardian_consent: str) -> bool:
    """Необязательные цели (запись голоса, социальное, новости): 18+ — сам; 14–17 — только после согласия родителя.
    Возраст не выбран — нельзя (иначе подросток обошёл бы правило, приняв согласие до выбора возраста)."""
    if age_band == ADULT:
        return True
    return age_band == TEEN and guardian_consent == "granted"
