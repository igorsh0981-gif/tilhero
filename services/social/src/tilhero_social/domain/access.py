"""Кто может дружить (§0 «Аудитории», bff.ts «Спринт 7»): ученик API — активный ученик из токена (`lrn`, иначе `sub`);
детский профиль (`lrn ≠ sub`) или полоса 6–13 — дети: без друзей, заявок, жалоб, блокировок и общей лиги (только
семья). Подросток 14–17 — после согласия родителя (`guardian_consent = granted`). Друзья и заявки — ещё и при
действующем согласии с целью `social` (403 CONSENT_REQUIRED {purpose}). Возраст неизвестен или аккаунт не активен —
как дети (fail closed)."""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from tilhero_social.domain import rules
from tilhero_social.domain.common import KIDS_BANDS, friends_not_allowed, kids_not_allowed
from tilhero_social.identity import Person


@dataclass(frozen=True)
class Me:
    user_id: uuid.UUID  # активный ученик (lrn) — владелец профиля сообщества, друзей, жалоб, рефералов
    account_id: uuid.UUID  # sub — аккаунт Telegram
    age_band: str | None  # полоса активного ученика из claims (быстрая проверка детей без identity-consent)

    @property
    def child_profile(self) -> bool:
        return self.user_id != self.account_id

    @property
    def kids(self) -> bool:
        return self.child_profile or self.age_band in KIDS_BANDS

    def require_not_kids(self) -> None:
        if self.kids:
            raise kids_not_allowed()


def social_reason(person: Person | None) -> str | None:
    """None — друзья доступны; иначе kids | guardian_consent | consent (FriendsUnavailableReason)."""
    if (person is None or person.status != "ACTIVE" or person.kind != "account" or person.age_band is None
            or person.age_band in KIDS_BANDS):
        return "kids"
    if person.age_band == "14-17" and person.guardian_consent != "granted":
        return "guardian_consent"
    if not person.consent_accepted or rules.SOCIAL_PURPOSE not in person.purposes:
        return "consent"
    return None


def require_social(person: Person | None) -> None:
    """403 FRIENDS_NOT_ALLOWED {reason: kids | guardian_consent} или 403 CONSENT_REQUIRED {purpose: terms | social}."""
    reason = social_reason(person)
    if reason is None:
        return
    if reason == "consent":
        rules.check_consent(person, social=True)
        return
    raise friends_not_allowed(reason)


def audience(person: Person | None) -> str:
    """kids | teens | adults (§0) по профилю identity-consent; без возраста — adults (как gamification), но друзья
    без возраста недоступны (social_reason)."""
    if person is not None and (person.kind == "child" or person.age_band in KIDS_BANDS):
        return "kids"
    if person is not None and person.age_band == "14-17":
        return "teens"
    return "adults"
