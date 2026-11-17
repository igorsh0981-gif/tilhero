"""Политика обработки персональных данных и цели согласия.

Тексты версионируются: опубликованная версия не меняется (её sha256 входит в evidence_hash согласия).
Новая редакция = новая версия + CURRENT_POLICY_VERSION; старые согласия остаются проверяемыми.

Версия 1.0 — ЧЕРНОВИК: короткие заглушки RU/UZ (латиница), окончательный текст готовят юристы. До публикации
окончательной редакции её текст не меняется задним числом — юристы выпускают версию 1.1.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

from tilhero_identity.domain.locale import Locale

REQUIRED_PURPOSES = ("terms", "privacy", "learning")
OPTIONAL_PURPOSES = ("voice_recording", "social", "product_news")


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

    @property
    def optional_purposes(self) -> frozenset[str]:
        return frozenset(p.code for p in self.purposes if not p.required)

    def text_sha256(self, lang: Locale) -> str:
        return hashlib.sha256(self.text[lang].encode("utf-8")).hexdigest()


_PURPOSES_V1 = (
    Purpose(
        code="terms",
        required=True,
        title={"ru": "Условия использования", "uz": "Foydalanish shartlari"},
        description={
            "ru": "Правила пользования TilHero. Черновик — текст готовят юристы.",
            "uz": "TilHero’dan foydalanish qoidalari. Qoralama — matnni yuristlar tayyorlamoqda.",
        },
    ),
    Purpose(
        code="privacy",
        required=True,
        title={"ru": "Политика конфиденциальности", "uz": "Maxfiylik siyosati"},
        description={
            "ru": "Какие данные мы храним и как защищаем. Черновик — текст готовят юристы.",
            "uz": "Qanday maʼlumotlarni saqlaymiz va qanday himoya qilamiz. Qoralama — matnni yuristlar "
                  "tayyorlamoqda.",
        },
    ),
    Purpose(
        code="learning",
        required=True,
        title={"ru": "Обучение и проверка навыков", "uz": "Taʼlim va koʻnikmalarni tekshirish"},
        description={
            "ru": "План занятий, ответы в уроках, результаты проверок и напоминания по вашему графику.",
            "uz": "Mashgʻulotlar rejasi, darslardagi javoblar, tekshiruv natijalari va jadvalingiz boʻyicha "
                  "eslatmalar.",
        },
    ),
    Purpose(
        code="voice_recording",
        required=False,
        title={"ru": "Хранить записи голоса 30 дней", "uz": "Ovoz yozuvlarini 30 kun saqlash"},
        description={
            "ru": "Чтобы точнее оценивать произношение. В детском профиле записи голоса не хранятся.",
            "uz": "Talaffuzni aniqroq baholash uchun. Bolalar profilida ovoz yozuvlari saqlanmaydi.",
        },
    ),
    Purpose(
        code="social",
        required=False,
        title={"ru": "Приглашения, семья и друзья", "uz": "Taklifnomalar, oila va doʻstlar"},
        description={
            "ru": "Приглашать близких и видеть их ответы. Ваше имя увидят только приглашённые.",
            "uz": "Yaqinlaringizni taklif qilish va javoblarini koʻrish. Ismingizni faqat taklif qilinganlar "
                  "koʻradi.",
        },
    ),
    Purpose(
        code="product_news",
        required=False,
        title={"ru": "Новости TilHero", "uz": "TilHero yangiliklari"},
        description={
            "ru": "Что нового в приложении. Можно выключить в любой момент.",
            "uz": "Ilovadagi yangiliklar. Istalgan vaqtda oʻchirib qoʻyish mumkin.",
        },
    ),
)

_TEXT_V1_RU = """# Политика обработки данных TilHero

Версия 1.0 · черновик (окончательный текст готовят юристы)

TilHero — приложение для изучения языков в Telegram. Мы обрабатываем данные, чтобы вести обучение, \
напоминать о занятиях по вашему графику и отвечать на обращения.

## Какие данные мы используем
- Telegram ID, имя и username — получаем от Telegram после проверки подписи.
- Возрастную группу (6–9, 10–13, 14–17, 18+) — без даты рождения.
- Цель, уровень, график занятий, ответы в уроках и результаты проверок.
- Настройки уведомлений и код родителя (хранится только в виде хеша).

## Дети и подростки
- 6–13 лет — детский профиль на аккаунте родителя, согласие даёт родитель. Записи голоса детей не хранятся.
- 14–17 лет — нужно согласие родителя по ссылке; до него необязательные функции выключены.

## Цели обработки
- Условия использования, политика конфиденциальности, обучение — обязательно.
- Хранение записей голоса 30 дней, приглашения и семья, новости TilHero — по желанию. Отказ не ограничивает \
обучение.

## Ваши права
- Отозвать согласие в разделе «Профиль → Данные и согласия».
- Удалить профиль: данные удаляются во всех сервисах TilHero вместе с детскими профилями; запись о согласии \
хранится без персональных данных как подтверждение законности обработки.
"""

_TEXT_V1_UZ = """# TilHero maʼlumotlarini qayta ishlash siyosati

Versiya 1.0 · qoralama (yakuniy matnni yuristlar tayyorlamoqda)

TilHero — Telegram’dagi til oʻrganish ilovasi. Maʼlumotlarni taʼlim berish, jadvalingiz boʻyicha \
mashgʻulotlarni eslatish va murojaatlarga javob berish uchun qayta ishlaymiz.

## Qanday maʼlumotlardan foydalanamiz
- Telegram ID, ism va username — imzo tekshirilgandan soʻng Telegram’dan olinadi.
- Yosh guruhi (6–9, 10–13, 14–17, 18+) — tugʻilgan sanasiz.
- Maqsad, daraja, mashgʻulotlar jadvali, darslardagi javoblar va tekshiruv natijalari.
- Bildirishnoma sozlamalari va ota-ona kodi (faqat xesh koʻrinishida saqlanadi).

## Bolalar va oʻsmirlar
- 6–13 yosh — ota-ona akkauntidagi bolalar profili, rozilikni ota-ona beradi. Bolalarning ovoz yozuvlari \
saqlanmaydi.
- 14–17 yosh — havola orqali ota-ona roziligi kerak; ungacha ixtiyoriy funksiyalar oʻchirilgan.

## Qayta ishlash maqsadlari
- Foydalanish shartlari, maxfiylik siyosati, taʼlim — majburiy.
- Ovoz yozuvlarini 30 kun saqlash, taklifnomalar va oila, TilHero yangiliklari — ixtiyoriy. Rad etish \
taʼlimni cheklamaydi.

## Huquqlaringiz
- Rozilikni «Profil → Maʼlumotlar va roziliklar» boʻlimida qaytarib olish.
- Profilni oʻchirish: maʼlumotlar TilHero’ning barcha xizmatlarida bolalar profillari bilan birga oʻchiriladi; \
rozilik haqidagi yozuv shaxsiy maʼlumotlarsiz qonuniylik dalili sifatida saqlanadi.
"""

POLICIES: dict[str, Policy] = {
    "1.0": Policy(version="1.0", purposes=_PURPOSES_V1, text={"ru": _TEXT_V1_RU, "uz": _TEXT_V1_UZ}),
}


def get_policy(version: str) -> Policy:
    return POLICIES[version]


def normalize_purposes(policy: Policy, purposes: list[str]) -> tuple[list[str], list[str], list[str]]:
    """→ (нормализованные цели в порядке политики, неизвестные, недостающие обязательные)."""
    requested = {p.strip() for p in purposes}
    unknown = sorted(requested - set(policy.purpose_codes))
    missing = [code for code in policy.purpose_codes if code in policy.required_purposes and code not in requested]
    normalized = [code for code in policy.purpose_codes if code in requested]
    return normalized, unknown, missing
