"""Справочники support-service: категории, приоритеты, статусы, типы эскалаций.

Коды хранятся в БД, подписи — здесь (как ticketLabels.ts в FinAdvisor: записи не становятся разноязычными).
"""

from __future__ import annotations

from typing import Final

CHANNEL_TELEGRAM: Final = "telegram"

# Категории (bff.ts TicketCategory), подписи RU/UZ (латиница) — для экрана поддержки Mini App. available=False —
# категория видна, но обращение по ней пока не создать: оплата появится в спринте 8 (тарифы и минуты).
CATEGORIES: Final[dict[str, dict[str, object]]] = {
    "LESSON": {"ru": "Урок", "uz": "Dars", "available": True},
    "ASSESSMENT": {"ru": "Оценка урока", "uz": "Dars bahosi", "available": True},
    "SCHEDULE_REMINDERS": {"ru": "График и напоминания", "uz": "Jadval va eslatmalar", "available": True},
    "CHILD_PROFILE": {"ru": "Детский профиль", "uz": "Bola profili", "available": True},
    "ACCOUNT": {"ru": "Аккаунт и вход", "uz": "Akkaunt va kirish", "available": True},
    "SUBSCRIPTION_PAYMENT": {"ru": "Подписка и оплата", "uz": "Obuna va toʻlov", "available": False},
    "PERSONAL_DATA": {"ru": "Персональные данные", "uz": "Shaxsiy maʼlumotlar", "available": True},
    "BUG": {"ru": "Ошибка в приложении", "uz": "Ilovadagi xatolik", "available": True},
    "OTHER": {"ru": "Другое", "uz": "Boshqa", "available": True},
}
ANY_CATEGORY: Final = "*"

PRIORITIES: Final = ("low", "normal", "high", "urgent")
# Приоритет по умолчанию: аккаунт, персональные данные и детский профиль (CONVENTIONS §8) — high, остальное — normal.
DEFAULT_PRIORITY: Final[dict[str, str]] = {"PERSONAL_DATA": "high", "ACCOUNT": "high", "CHILD_PROFILE": "high"}


def default_priority(category: str) -> str:
    return DEFAULT_PRIORITY.get(category, "normal")


NEW: Final = "NEW"
IN_PROGRESS: Final = "IN_PROGRESS"
WAITING_CUSTOMER: Final = "WAITING_CUSTOMER"
RESOLVED: Final = "RESOLVED"
CLOSED: Final = "CLOSED"
STATUSES: Final = (NEW, IN_PROGRESS, WAITING_CUSTOMER, RESOLVED, CLOSED)
# «Открытые» — ждут действия поддержки или клиента (лимит незакрытых обращений, фильтр очереди open)
OPEN_STATUSES: Final = (NEW, IN_PROGRESS, WAITING_CUSTOMER)
# SLA-таймер идёт только когда мяч на стороне поддержки; WAITING_CUSTOMER — пауза, RESOLVED/CLOSED — выполнено
SLA_RUNNING_STATUSES: Final = (NEW, IN_PROGRESS)

# Переходы, доступные оператору командой PATCH (как TICKET_FLOW прототипа Admin v2).
# Неявные переходы: публичный ответ оператора NEW/IN_PROGRESS → WAITING_CUSTOMER;
# сообщение клиента WAITING_CUSTOMER/RESOLVED → IN_PROGRESS; клиент закрывает из любого статуса.
STAFF_TRANSITIONS: Final[dict[str, frozenset[str]]] = {
    NEW: frozenset({IN_PROGRESS}),
    IN_PROGRESS: frozenset({WAITING_CUSTOMER, RESOLVED}),
    WAITING_CUSTOMER: frozenset({IN_PROGRESS, RESOLVED}),
    RESOLVED: frozenset({CLOSED, IN_PROGRESS}),
    CLOSED: frozenset(),
}

# Эскалации: support не делает возвраты, смену тарифа и правку оценок — только related request в другую команду.
# Подписи — для админки (русский интерфейс сотрудников).
ESCALATION_TYPES: Final[dict[str, dict[str, str]]] = {
    "billing_review": {"ru": "Проверка оплаты", "team": "billing"},
    "assessment_review": {"ru": "Проверка оценки урока", "team": "methodology"},
    "content_review": {"ru": "Проверка урока или материалов", "team": "methodology"},
    "tech_issue": {"ru": "Технический сбой", "team": "engineering"},
    "security_privacy": {"ru": "Безопасность и персональные данные", "team": "security"},
}

ANONYMIZED_TEXT: Final = "[удалено по запросу пользователя]"

SENDER_USER: Final = "user"
SENDER_OPERATOR: Final = "operator"
SENDER_SYSTEM: Final = "system"
VISIBILITY_PUBLIC: Final = "public"
VISIBILITY_INTERNAL: Final = "internal"


def ticket_number(number: int) -> str:
    return f"TCK-{number}"
