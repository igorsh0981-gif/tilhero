"""Политика обработки персональных данных и цели согласия.

Тексты версионируются: опубликованная версия не меняется (её sha256 входит в evidence_hash согласия).
Новая редакция = новая версия + CURRENT_POLICY_VERSION; старые согласия остаются проверяемыми.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Literal

Lang = Literal["ru", "en"]


@dataclass(frozen=True)
class Purpose:
    code: str
    required: bool
    title: dict[str, str]
    description: dict[str, str]


@dataclass(frozen=True)
class Policy:
    version: str
    purposes: tuple[Purpose, ...]
    text: dict[str, str]

    @property
    def purpose_codes(self) -> tuple[str, ...]:
        return tuple(p.code for p in self.purposes)

    @property
    def required_purposes(self) -> frozenset[str]:
        return frozenset(p.code for p in self.purposes if p.required)

    def text_sha256(self, lang: Lang) -> str:
        return hashlib.sha256(self.text[lang].encode("utf-8")).hexdigest()


_PURPOSES_V1 = (
    Purpose(
        code="personalization",
        required=True,
        title={"ru": "Персонализация", "en": "Personalisation"},
        description={
            "ru": "Подбор событий, расчёт поездок и рекомендации по вашим интересам, географии, бюджету "
                  "и городам вылета.",
            "en": "Picking events, pricing trips and recommendations based on your interests, regions, "
                  "budget and departure cities.",
        },
    ),
    Purpose(
        code="notifications",
        required=False,
        title={"ru": "Уведомления в Telegram", "en": "Telegram notifications"},
        description={
            "ru": "Важные изменения по выбранным событиям и дайджест. Можно выключить в любой момент.",
            "en": "Important changes to events you follow and a digest. You can turn them off at any time.",
        },
    ),
)

_TEXT_V1_RU = """# Политика обработки данных TilHero

Версия 1.0

TilHero обрабатывает данные только для подбора событий, расчёта поездок и уведомлений. Сервис предназначен \
для пользователей старше 18 лет.

## Какие данные мы используем
- Telegram ID, имя и username — получаем от Telegram после проверки подписи.
- Интересы, география, формат событий, бюджет и горизонт поиска.
- Города вылета и предпочтения по перелётам.
- Реакции, сохранённые события и слежения.
- Настройки уведомлений и безопасности (PIN хранится только в виде хеша).

## Чего мы не собираем
- Точную геолокацию.
- Банковские данные и транзакции. Для банковского этапа TilHero потребуется отдельное согласие.

Мы не продаём данные и не передаём переписку с AI-консьержем операторам поддержки без вашего согласия.

## Цели обработки
- **Персонализация** (обязательно): подбор событий и поездок по вашему профилю.
- **Уведомления в Telegram** (по желанию): важные изменения и дайджест.

## Ваши права
- Изменить настройки и предпочтения в разделе «Профиль».
- Отозвать согласие — персонализация остановится, профиль сохранится.
- Отключить TilHero или удалить профиль. Удаление выполняется во всех сервисах TilHero; запись о данном \
согласии хранится без персональных данных как подтверждение законности обработки.
"""

_TEXT_V1_EN = """# TilHero data processing policy

Version 1.0

TilHero processes data only to pick events, price trips and send notifications. The service is intended \
for users aged 18 or older.

## What data we use
- Telegram ID, name and username — received from Telegram after the signature check.
- Interests, regions, event formats, budget and search horizon.
- Departure cities and flight preferences.
- Reactions, saved events and watches.
- Notification and security settings (the PIN is stored only as a hash).

## What we do not collect
- Precise location.
- Banking data or transactions. The banking stage of TilHero will require a separate consent.

We do not sell data and do not share AI Concierge conversations with support operators without your consent.

## Purposes
- **Personalisation** (required): picking events and trips for your profile.
- **Telegram notifications** (optional): important changes and a digest.

## Your rights
- Change settings and preferences in Profile.
- Revoke consent — personalisation stops, your profile is kept.
- Turn off TilHero or delete your profile. Deletion runs across all TilHero services; the record of this \
consent is kept without personal data as proof that processing was lawful.
"""

POLICIES: dict[str, Policy] = {
    "1.0": Policy(version="1.0", purposes=_PURPOSES_V1, text={"ru": _TEXT_V1_RU, "en": _TEXT_V1_EN}),
}


def get_policy(version: str) -> Policy:
    return POLICIES[version]


def normalize_purposes(policy: Policy, purposes: list[str]) -> tuple[list[str], list[str], list[str]]:
    """→ (нормализованные цели в порядке политики, неизвестные, недостающие обязательные)."""
    requested = {p.strip() for p in purposes}
    unknown = sorted(requested - set(policy.purpose_codes))
    missing = sorted(policy.required_purposes - requested)
    normalized = [code for code in policy.purpose_codes if code in requested]
    return normalized, unknown, missing
