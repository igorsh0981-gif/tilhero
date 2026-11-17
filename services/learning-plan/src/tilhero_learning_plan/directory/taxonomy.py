"""Таксономия интересов (TG-FR-010): категории верхнего уровня и подкатегории.

Код подкатегории = `<parent>.<slug>`; icon — имя иконки из набора Mini App
(proto/miniapp/src/10-core.js ICONS).
Добавлять коды можно, переименовывать/удалять — только с миграцией данных профилей (коды хранятся в JSONB).
"""

from __future__ import annotations

from typing import Final, NamedTuple


class Category(NamedTuple):
    code: str
    parent: str | None
    ru: str
    en: str
    icon: str


TAXONOMY: Final[tuple[Category, ...]] = (
    Category("music", None, "Музыка", "Music", "music"),
    Category("music.concerts", "music", "Концерты", "Concerts", "music"),
    Category("music.jazz", "music", "Джаз", "Jazz", "music"),
    Category("music.classical", "music", "Классическая музыка", "Classical music", "music"),
    Category("music.electronic", "music", "Электронная музыка", "Electronic music", "music"),
    Category("music.pop_rock", "music", "Поп и рок", "Pop and rock", "music"),
    Category("sport", None, "Спорт", "Sport", "flag"),
    Category("sport.motorsport", "sport", "Автоспорт", "Motorsport", "flag"),
    Category("sport.football", "sport", "Футбол", "Football", "flag"),
    Category("sport.tennis", "sport", "Теннис", "Tennis", "flag"),
    Category("sport.basketball", "sport", "Баскетбол", "Basketball", "flag"),
    Category("sport.combat", "sport", "Единоборства", "Combat sports", "flag"),
    Category("sport.esports", "sport", "Киберспорт", "Esports", "monitor"),
    Category("sport.other", "sport", "Другой спорт", "Other sports", "flag"),
    Category("business", None, "Бизнес", "Business", "cpu"),
    Category("business.ai", "business", "AI", "AI", "cpu"),
    Category("business.fintech", "business", "FinTech", "FinTech", "wallet"),
    Category("business.startups", "business", "Стартапы", "Startups", "zap"),
    Category("business.conferences", "business", "Бизнес-форумы", "Business forums", "users"),
    Category("business.expo", "business", "Отраслевые выставки", "Trade shows", "tag"),
    Category("culture", None, "Культура", "Culture", "palette"),
    Category("culture.theatre", "culture", "Театр", "Theatre", "palette"),
    Category("culture.exhibitions", "culture", "Выставки", "Exhibitions", "image"),
    Category("culture.cinema", "culture", "Кино", "Cinema", "monitor"),
    Category("culture.opera_ballet", "culture", "Опера и балет", "Opera and ballet", "palette"),
    Category("education", None, "Образование", "Education", "doc"),
    Category("education.lectures", "education", "Лекции", "Lectures", "doc"),
    Category("education.workshops", "education", "Мастер-классы", "Workshops", "doc"),
    Category("festivals", None, "Фестивали", "Festivals", "star"),
    Category("festivals.music", "festivals", "Музыкальные фестивали", "Music festivals", "music"),
    Category("festivals.city", "festivals", "Городские фестивали", "City festivals", "globe"),
    Category("festivals.food", "festivals", "Гастрофестивали", "Food festivals", "star"),
)

CATEGORY_CODES: Final[frozenset[str]] = frozenset(c.code for c in TAXONOMY)

# Чипы согласованного прототипа (proto/miniapp/src/20-data.js INTERESTS) → коды таксономии.
PROTOTYPE_INTEREST_CHIPS: Final[dict[str, str]] = {
    "concerts": "music.concerts",
    "motorsport": "sport.motorsport",
    "football": "sport.football",
    "tennis": "sport.tennis",
    "ai": "business.ai",
    "fintech": "business.fintech",
    "forums": "business.conferences",
    "theatre": "culture.theatre",
    "exhibitions": "culture.exhibitions",
    "festivals": "festivals",
    "education": "education",
    "othersport": "sport.other",
}


def interest_items() -> list[dict]:
    """GET /directory/interests → InterestCategory[]."""
    return [{"code": c.code, "parent": c.parent, "label": {"ru": c.ru, "en": c.en}, "icon": c.icon}
            for c in TAXONOMY]
