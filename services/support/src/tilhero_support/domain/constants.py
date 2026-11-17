"""Справочники support-service: категории, приоритеты, статусы, типы эскалаций.

Коды хранятся в БД, подписи — здесь (как ticketLabels.ts в FinAdvisor: записи не становятся разноязычными).
"""

from __future__ import annotations

from typing import Final

CHANNEL_TELEGRAM: Final = "telegram"

# Категории (bff.ts TicketCategory). available=False — категория видна, но обращение по ней пока не создать
# (подписка и оплата — тех. долг, решение заказчика 07.10.2026).
CATEGORIES: Final[dict[str, dict[str, object]]] = {
    "EVENT_RECOMMENDATION": {
        "ru": "Событие или рекомендация",
        "en": "Event or recommendation",
        "available": True,
    },
    "TICKET_SOURCE": {"ru": "Билет или источник", "en": "Ticket or source", "available": True},
    "FLIGHT": {"ru": "Перелёт", "en": "Flight", "available": True},
    "HOTEL": {"ru": "Отель", "en": "Hotel", "available": True},
    "PRICE": {"ru": "Цена", "en": "Price", "available": True},
    "SUBSCRIPTION_PAYMENT": {"ru": "Подписка и оплата", "en": "Subscription and payment", "available": False},
    "ACCOUNT": {"ru": "Аккаунт", "en": "Account", "available": True},
    "PERSONAL_DATA": {"ru": "Персональные данные", "en": "Personal data", "available": True},
    "BUG": {"ru": "Ошибка", "en": "Bug", "available": True},
    "OTHER": {"ru": "Другое", "en": "Other", "available": True},
}
ANY_CATEGORY: Final = "*"

PRIORITIES: Final = ("low", "normal", "high", "urgent")
# Приоритет по умолчанию: аккаунт и персональные данные — high, остальное — normal.
DEFAULT_PRIORITY: Final[dict[str, str]] = {"PERSONAL_DATA": "high", "ACCOUNT": "high"}


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

# Эскалации: support не делает refund/override (BR-TG-011, ТЗ Admin «Support Operations» §6),
# только related request в другую команду.
ESCALATION_TYPES: Final[dict[str, dict[str, str]]] = {
    "billing_review": {"ru": "Проверка оплаты", "en": "Billing review", "team": "billing"},
    "provider_issue": {"ru": "Проблема провайдера", "en": "Provider issue", "team": "operations"},
    "content_review": {
        "ru": "Проверка события/контента",
        "en": "Event/content review",
        "team": "agent_manager",
    },
    "security_privacy": {
        "ru": "Безопасность и персональные данные",
        "en": "Security/privacy request",
        "team": "security",
    },
}

ANONYMIZED_TEXT: Final = "[удалено по запросу пользователя]"

SENDER_USER: Final = "user"
SENDER_OPERATOR: Final = "operator"
SENDER_SYSTEM: Final = "system"
VISIBILITY_PUBLIC: Final = "public"
VISIBILITY_INTERNAL: Final = "internal"


def ticket_number(number: int) -> str:
    return f"TCK-{number}"
