"""Тексты бота RU/EN (из согласованного прототипа Mini App v9, 90-bot-console.js) и сборка deep link.

Бот — только транспорт (решение заказчика №8): команды открывают нужный раздел Mini App,
отдельного чат-бота нет.
"""

from __future__ import annotations

import html
import re
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

START_PARAM_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
RU_LANGS = frozenset({"ru", "uz", "kk"})

# команда → раздел Mini App (startapp)
COMMAND_SECTIONS: dict[str, str] = {
    "start": "home",
    "events": "catalog",
    "watch": "watch",
    "support": "support",
    "help": "home",
}

TEXTS: dict[str, dict[str, str]] = {
    "ru": {
        "hello": "Привет, {name}! Всё работает внутри мини-приложения TilHero — откройте его кнопкой ниже.",
        "hello_anon": "Привет! Всё работает внутри мини-приложения TilHero — откройте его кнопкой ниже.",
        "open": "Открыть TilHero",
        "events": "Каталог событий — в мини-приложении TilHero: поиск, фильтры и подборка под ваши интересы.",
        "events_btn": "Открыть каталог",
        "watch": "Ваши слежения — в мини-приложении TilHero. О критичных изменениях напишем сюда сразу.",
        "watch_btn": "Открыть слежения",
        "support": "Поддержка TilHero — в мини-приложении: создайте обращение или откройте историю. "
        "Ответ поддержки придёт сюда.",
        "support_btn": "Открыть поддержку",
        "help": "Отдельного чат-бота нет: бот только доставляет уведомления и открывает приложение.\n"
        "/start — главная\n/events — каталог\n/watch — слежения\n/support — поддержка",
        "soon": "Скоро",
    },
    "en": {
        "hello": "Hi {name}! Everything works inside the TilHero mini app — open it with the button below.",
        "hello_anon": "Hi! Everything works inside the TilHero mini app — open it with the button below.",
        "open": "Open TilHero",
        "events": "The event catalogue is in the TilHero mini app: search, filters and picks for you.",
        "events_btn": "Open catalogue",
        "watch": "Your watches are in the TilHero mini app. We will message you here about critical changes.",
        "watch_btn": "Open watches",
        "support": "TilHero support is in the mini app: create a request or open your history. "
        "The support reply arrives here.",
        "support_btn": "Open support",
        "help": "There is no separate chat bot: the bot only delivers notifications and opens the app.\n"
        "/start — home\n/events — catalogue\n/watch — watches\n/support — support",
        "soon": "Coming soon",
    },
}

BOT_COMMANDS: dict[str, list[dict[str, str]]] = {
    "ru": [
        {"command": "start", "description": "Открыть TilHero"},
        {"command": "events", "description": "Каталог событий"},
        {"command": "watch", "description": "Мои слежения"},
        {"command": "support", "description": "Поддержка"},
        {"command": "help", "description": "Как работает бот"},
    ],
    "en": [
        {"command": "start", "description": "Open TilHero"},
        {"command": "events", "description": "Event catalogue"},
        {"command": "watch", "description": "My watches"},
        {"command": "support", "description": "Support"},
        {"command": "help", "description": "How the bot works"},
    ],
}

DESCRIPTIONS: dict[str, dict[str, str]] = {
    "ru": {
        "description": (
            "TilHero находит события по вашим интересам и собирает поездку: билеты, перелёт и отель "
            "с точными ссылками на источник. Всё работает в мини-приложении — нажмите «Открыть TilHero». "
            "Бот присылает важные изменения и ответы поддержки."
        ),
        "short": "События и поездки под ваши интересы — в мини-приложении TilHero.",
    },
    "en": {
        "description": (
            "TilHero finds events that match your interests and builds the trip: tickets, flight and "
            "hotel with exact source links. Everything works in the mini app — tap “Open TilHero”. "
            "The bot sends important changes and support replies."
        ),
        "short": "Events and trips for your interests — in the TilHero mini app.",
    },
}


def lang_of(language_code: str | None) -> str:
    """ru/uz/kk → ru, иначе en (IETF-тег вида «ru-RU» тоже понимаем)."""
    if not language_code:
        return "en"
    base = language_code.split("-", 1)[0].strip().lower()
    return "ru" if base in RU_LANGS else "en"


def t(lang: str, key: str, **params: str) -> str:
    text = TEXTS.get(lang, TEXTS["en"])[key]
    return text.format(**{k: html.escape(v, quote=False) for k, v in params.items()}) if params else text


def webapp_url(base: str, startapp: str) -> str:
    """MINIAPP_URL?startapp=<раздел> с сохранением существующих параметров."""
    if not START_PARAM_RE.match(startapp):
        raise ValueError("invalid startapp")
    parts = urlsplit(base)
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if k != "startapp"]
    query.append(("startapp", startapp))
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))
