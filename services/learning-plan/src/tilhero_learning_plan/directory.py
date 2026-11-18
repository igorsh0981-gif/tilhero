"""Справочники онбординга (сид спринта 1): 6 целей (коды = `Goal` в bff.ts) и 12 тем, подписи RU/UZ (латиница).

Иконки — ключи иконок клиента; новая тема — запись здесь (со спринта 3 справочник переедет в catalog).
"""

from __future__ import annotations

from typing import Final, TypedDict


class Label(TypedDict):
    ru: str
    uz: str


class Item(TypedDict):
    code: str
    label: Label
    icon: str | None


GOALS: Final[tuple[Item, ...]] = (
    {"code": "work", "label": {"ru": "Работа", "uz": "Ish"}, "icon": "briefcase"},
    {"code": "career", "label": {"ru": "Карьера и собеседования", "uz": "Karyera va ish suhbatlari"},
     "icon": "trophy"},
    {"code": "travel", "label": {"ru": "Путешествия", "uz": "Sayohat"}, "icon": "globe"},
    {"code": "daily", "label": {"ru": "Общение и быт", "uz": "Muloqot va kundalik hayot"}, "icon": "chat"},
    {"code": "study", "label": {"ru": "Учёба", "uz": "Oʻqish"}, "icon": "book"},
    {"code": "exam", "label": {"ru": "Экзамены", "uz": "Imtihonlar"}, "icon": "star"},
)

TOPICS: Final[tuple[Item, ...]] = (
    {"code": "small_talk", "label": {"ru": "Знакомство и разговор", "uz": "Tanishuv va suhbat"}, "icon": "chat"},
    {"code": "travel", "label": {"ru": "Поездки и транспорт", "uz": "Sayohat va transport"}, "icon": "globe"},
    {"code": "food", "label": {"ru": "Кафе и еда", "uz": "Kafe va taomlar"}, "icon": "food"},
    {"code": "shopping", "label": {"ru": "Покупки", "uz": "Xaridlar"}, "icon": "bag"},
    {"code": "work", "label": {"ru": "Работа и офис", "uz": "Ish va ofis"}, "icon": "briefcase"},
    {"code": "interview", "label": {"ru": "Собеседование", "uz": "Ish suhbati"}, "icon": "trophy"},
    {"code": "study", "label": {"ru": "Учёба", "uz": "Oʻqish"}, "icon": "book"},
    {"code": "health", "label": {"ru": "Здоровье и врач", "uz": "Salomatlik va shifokor"}, "icon": "heart"},
    {"code": "home", "label": {"ru": "Дом и семья", "uz": "Uy va oila"}, "icon": "home"},
    {"code": "hobbies", "label": {"ru": "Хобби и спорт", "uz": "Sevimli mashgʻulot va sport"}, "icon": "ball"},
    {"code": "movies", "label": {"ru": "Фильмы и музыка", "uz": "Kino va musiqa"}, "icon": "music"},
    {"code": "tech", "label": {"ru": "Технологии", "uz": "Texnologiyalar"}, "icon": "spark"},
)

GOAL_CODES: Final[frozenset[str]] = frozenset(i["code"] for i in GOALS)
TOPIC_CODES: Final[frozenset[str]] = frozenset(i["code"] for i in TOPICS)
