"""«Что нового» TilHero (решение заказчика 18.11.2026, AT-11): заметки о новом в приложении.

При первой регистрации ученик видит знакомство со всем приложением (audience `new`), при каждом следующем входе — то,
что он ещё не видел (`existing` / `all`), с учётом языка интерфейса и возраста (сегменты). Отметки просмотра хранятся
на сервере (`release_note_views`) и переживают переустановку Mini App. Управление — staff API (admin-bff, спринт 2).

Жизненный цикл заметки: draft → published → archived (черновик можно и сразу архивировать). Правится только черновик
(оптимистическая блокировка по `version`); опубликованная заметка неизменна — исправление = архив + новая заметка
(закрепляет триггер в БД, миграция 0003). Тексты RU и UZ обязательны оба: пустой перевод → 422
RELEASE_NOTE_TRANSLATION_MISSING (и при сохранении черновика, и при публикации). Публикация →
`experience.release_note.published.v1`; каждое действие сотрудника — `admin.audit.recorded.v1` через outbox в той же
транзакции, что и изменение.

Статистика показов (спринт 2, AT-18): views_total — уникальные ученики с отметкой просмотра (PK user_id +
release_note_id); разрезы по языку и возрасту — по сегменту ученика на момент показа, который отметка хранит с миграции
0005 (старые отметки без сегмента в разрезах не учитываются).

Маршруты Mini App, иконки, иллюстрации, аудитории, сегменты и лимиты — общий каталог
`packages/contracts/release-notes.json` (сверка — контрактный тест). Тексты — простой текст без управляющих символов;
клиенты выводят их только как текст.

Иллюстрация (релиз 6.1, миграция 0006) — ключ из каталога (`welcome`, `s6-heroes`, …): картинка 16:9 сверху первой
карточки заметки в Mini App (`apps/telegram-miniapp/public/whatsnew/<key>.webp`). Ключ не из каталога → 422
VALIDATION_ERROR. У опубликованной заметки иллюстрация неизменна, как и тексты (триггер release_notes_guard).

Каждый релиз публикует свою заметку миграцией при выкладке (CONVENTIONS «Что нового в каждом релизе»): автор
`system:release`, событие публикации и аудит — те же функции, что у публикации сотрудником (`published_payload`,
`audit_record`).
"""

from __future__ import annotations

import base64
import json
import re
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, Any, Final, Literal, Protocol

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import ColumnElement, delete, exists, func, literal, or_, select, text, tuple_
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common import context
from tilhero_common.errors import ApiError, bad_request, conflict, not_found, unprocessable
from tilhero_common.internal_auth import Actor
from tilhero_common.messaging import emit
from tilhero_experience.models import DeletedUser, ReleaseNote, ReleaseNoteView

PRODUCER = "experience-config"
AUDIT_EVENT = "admin.audit.recorded.v1"
PUBLISHED_EVENT = "experience.release_note.published.v1"
DOMAIN_DELETED = "user.domain.deleted.v1"
DELETION_REQUESTED = "user.deletion.requested.v1"
OBJECT_TYPE = "release_note"
RELEASE_ACTOR = "system:release"  # публикация заметки релиза миграцией при выкладке

# ---------------------------------------------------------------- каталог (packages/contracts/release-notes.json)

LOCALES: Final[tuple[str, ...]] = ("ru", "uz")
AUDIENCES: Final[tuple[str, ...]] = ("new", "existing", "all")
AGE_SEGMENTS: Final[tuple[str, ...]] = ("kids", "teens", "adults")
UI_LANGS: Final[tuple[str, ...]] = ("ru", "uz")
ROUTES: Final[tuple[str, ...]] = (
    "home", "lessons", "review", "progress", "profile", "schedule", "notifications", "family", "support", "news",
    # спринт 3
    "diagnostics", "plan", "skills", "scenarios", "media", "media_requests", "languages",
    # релиз 6.1: игра (спринт 6), словарь и чтение (спринт 5)
    "heroes", "shop", "badges", "game_history", "game_settings", "dictionary", "reading",
    # спринт 7: друзья, лиги, дуэли, рефералы (парный урок — через «Друзья», отдельного маршрута нет)
    "friends", "leagues", "duels", "referrals",
    # спринт 8: «Подписка» и «Купить тилы» (за Stars)
    "subscription", "til_shop",
)
ICONS: Final[tuple[str, ...]] = (
    "spark", "hero", "calendar", "clock", "bell", "book", "chat", "mic", "star", "flame", "users", "gift", "shield",
    "globe", "trophy", "news",
)
# иллюстрации: ключ → (ширина, высота) файла apps/telegram-miniapp/public/whatsnew/<key>.webp
ILLUSTRATIONS: Final[dict[str, tuple[int, int]]] = {
    "welcome": (1200, 675),
    "s6-heroes": (1200, 675),
    "s7-social": (1200, 675),  # спринт 7: друзья, лиги, дуэли, урок вдвоём
    "s7-family": (1200, 675),  # спринт 7, детская заметка: семья учится вместе (без пьедестала — у детей нет лиг)
    # спринт 8: подписка за Stars — взрослым (14+) и детям (6–13, без цен и призывов)
    "s8-plus": (1200, 675),
    "s8-plus-kids": (1200, 675),
}
ILLUSTRATION_PATTERN = r"^[a-z0-9][a-z0-9-]{0,31}$"
SLUG_PATTERN = r"^[0-9A-Za-z][0-9A-Za-z.-]{0,31}$"
TITLE_MAX, ITEM_TITLE_MAX, ITEM_TEXT_MAX = 80, 80, 200
ITEMS_MIN, ITEMS_MAX = 1, 6
CLIENT_MAX_NOTES = 5
FOR_ME_SCAN = 500  # опубликованных заметок за всё время — десятки; предел защищает от неожиданного роста

Status = Literal["draft", "published", "archived"]
Audience = Literal["new", "existing", "all"]
AgeSegment = Literal["kids", "teens", "adults"]
UiLang = Literal["ru", "uz"]
Route = Literal["home", "lessons", "review", "progress", "profile", "schedule", "notifications", "family", "support",
                "news", "diagnostics", "plan", "skills", "scenarios", "media", "media_requests", "languages",
                "heroes", "shop", "badges", "game_history", "game_settings", "dictionary", "reading",
                "friends", "leagues", "duels", "referrals", "subscription", "til_shop"]
IconName = Literal["spark", "hero", "calendar", "clock", "bell", "book", "chat", "mic", "star", "flame", "users",
                   "gift", "shield", "globe", "trophy", "news"]
Illustration = Literal["welcome", "s6-heroes", "s7-social", "s7-family", "s8-plus", "s8-plus-kids"]

# управляющие C0/C1, разделители строк, невидимые и bidi: U+061C, U+200B–U+200F (ZWSP, ZWNJ, ZWJ, LRM, RLM),
# U+2028–U+202E (в т. ч. LRE…RLO), U+2060–U+2064, U+2066–U+2069 (изоляты), U+FEFF (BOM)
_CONTROL = re.compile(
    "[\\x00-\\x1f\\x7f-\\x9f\\u061c\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff]"
)
_SPACES = re.compile(r"\s+")


def _plain(value: str) -> str:
    """Одна строка простого текста: пробелы схлопываются, управляющие и bidi-символы запрещены. Пустая строка
    допустима на уровне схемы — её ловит проверка переводов (RELEASE_NOTE_TRANSLATION_MISSING)."""
    if _CONTROL.search(value):
        raise ValueError("недопустимые символы")
    return _SPACES.sub(" ", value).strip()


Plain = Annotated[str, AfterValidator(_plain)]
_IN = ConfigDict(extra="forbid", strict=True)


class LocalizedTitle(BaseModel):
    model_config = _IN

    ru: Plain = Field(default="", max_length=TITLE_MAX)
    uz: Plain = Field(default="", max_length=TITLE_MAX)


class LocalizedItemTitle(BaseModel):
    model_config = _IN

    ru: Plain = Field(default="", max_length=ITEM_TITLE_MAX)
    uz: Plain = Field(default="", max_length=ITEM_TITLE_MAX)


class LocalizedText(BaseModel):
    model_config = _IN

    ru: Plain = Field(default="", max_length=ITEM_TEXT_MAX)
    uz: Plain = Field(default="", max_length=ITEM_TEXT_MAX)


class NoteItem(BaseModel):
    model_config = _IN

    title: LocalizedItemTitle
    text: LocalizedText
    link: Route | None = Field(default=None, description="маршрут Mini App из каталога")
    icon: IconName | None = Field(default=None, description="иконка Mini App из каталога")


class Segments(BaseModel):
    """Кому показывать: возраст (kids 6–13, teens 14–17, adults 18+) и язык интерфейса. Пусто — всем."""

    model_config = _IN

    age: list[AgeSegment] = Field(default_factory=list, max_length=len(AGE_SEGMENTS))
    ui_lang: list[UiLang] = Field(default_factory=list, max_length=len(UI_LANGS))

    def normalized(self) -> dict[str, list[str]]:
        """Без повторов, в порядке каталога; пустые списки не хранятся ({} — всем)."""
        out: dict[str, list[str]] = {}
        for key, catalog in (("age", AGE_SEGMENTS), ("ui_lang", UI_LANGS)):
            chosen = set(getattr(self, key))
            if chosen:
                out[key] = [v for v in catalog if v in chosen]
        return out


class NoteContent(BaseModel):
    """Содержимое заметки — общее для создания и правки черновика."""

    model_config = _IN

    slug: str = Field(pattern=SLUG_PATTERN, description="метка: welcome-1, 2026.11")
    title: LocalizedTitle
    items: list[NoteItem] = Field(min_length=ITEMS_MIN, max_length=ITEMS_MAX)
    audience: Audience = "existing"
    segments: Segments | None = None
    illustration: Illustration | None = Field(
        default=None, description="ключ иллюстрации из каталога (картинка сверху первой карточки); нет — без картинки")


# ---------------------------------------------------------------- переводы


def missing_translations(title: dict[str, Any], items: Sequence[dict[str, Any]]) -> list[str]:
    """Пути пустых переводов: title.uz, items[2].text.ru …"""
    missing = [f"title.{loc}" for loc in LOCALES if not str(title.get(loc) or "").strip()]
    for i, item in enumerate(items):
        for part in ("title", "text"):
            texts = item.get(part) or {}
            missing += [f"items[{i}].{part}.{loc}" for loc in LOCALES if not str(texts.get(loc) or "").strip()]
    return missing


def ensure_translations(title: dict[str, Any], items: Sequence[dict[str, Any]]) -> None:
    missing = missing_translations(title, items)
    if missing:
        raise unprocessable("RELEASE_NOTE_TRANSLATION_MISSING",
                            "Заполните тексты на русском и узбекском — пустой перевод не публикуется",
                            {"missing": missing[:20]})


def ensure_publishable(n: ReleaseNote) -> None:
    """Защита в глубину перед публикацией (AT-19): черновик мог попасть в БД в обход API (сид, SQL) — пустой перевод →
    RELEASE_NOTE_TRANSLATION_MISSING; маршрут или иконка не из каталога, лишние поля, длины, управляющие символы →
    VALIDATION_ERROR (та же схема, что и при сохранении черновика)."""
    ensure_translations(n.title, n.items)
    try:
        NoteContent.model_validate({"slug": n.slug, "title": n.title, "items": n.items, "audience": n.audience,
                                    "segments": n.segments, "illustration": n.illustration})
    except ValidationError as exc:
        errors = [{"loc": ["note", *(str(p) for p in e["loc"])], "msg": e["msg"], "type": e["type"]}
                  for e in exc.errors()[:20]]
        raise unprocessable("VALIDATION_ERROR", "Заметка не прошла проверку — исправьте черновик",
                            {"errors": errors}) from None


# ---------------------------------------------------------------- представления


def iso_z(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def staff_view(n: ReleaseNote, views_total: int = 0) -> dict[str, Any]:
    """StaffReleaseNote (admin.ts) без имён сотрудников (*_name добавляет admin-bff). views_total — уникальные
    ученики, видевшие заметку; у черновика всегда 0."""
    return {
        "release_note_id": str(n.id), "slug": n.slug, "title": n.title, "items": n.items, "audience": n.audience,
        "segments": n.segments, "illustration": n.illustration, "status": n.status, "version": n.version,
        "created_by": n.created_by, "created_at": iso_z(n.created_at),
        "updated_by": n.updated_by, "updated_at": iso_z(n.updated_at),
        "published_by": n.published_by, "published_at": iso_z(n.published_at),
        "archived_by": n.archived_by, "archived_at": iso_z(n.archived_at),
        "views_total": 0 if n.status == "draft" else views_total,
    }


async def views_by_note(session: AsyncSession, note_ids: Sequence[uuid.UUID]) -> dict[uuid.UUID, int]:
    """Показы (уникальные ученики) по заметкам — один GROUP BY на страницу списка (без N+1)."""
    if not note_ids:
        return {}
    rows = await session.execute(
        select(ReleaseNoteView.release_note_id, func.count())
        .where(ReleaseNoteView.release_note_id.in_(set(note_ids)))
        .group_by(ReleaseNoteView.release_note_id))
    return {note_id: int(count) for note_id, count in rows.all()}


async def staff_views(session: AsyncSession, notes: Sequence[ReleaseNote]) -> list[dict[str, Any]]:
    counted = [n.id for n in notes if n.status != "draft"]
    views = await views_by_note(session, counted)
    return [staff_view(n, views.get(n.id, 0)) for n in notes]


async def staff_view_of(session: AsyncSession, n: ReleaseNote) -> dict[str, Any]:
    return (await staff_views(session, [n]))[0]


def localized_view(n: ReleaseNote, lang: str) -> dict[str, Any]:
    """WhatsNewNote (bff.ts): тексты на языке ученика, без сотрудников и сегментов; иллюстрация — ключ каталога."""
    return {
        "release_note_id": str(n.id), "slug": n.slug, "title": n.title[lang],
        "items": [{"title": i["title"][lang], "text": i["text"][lang], "link": i.get("link"), "icon": i.get("icon")}
                  for i in n.items],
        "audience": n.audience, "illustration": n.illustration, "published_at": iso_z(n.published_at),
    }


def encode_cursor(seq: int) -> str:
    return base64.urlsafe_b64encode(str(seq).encode()).decode()


def decode_cursor(cursor: str) -> int:
    return int(base64.urlsafe_b64decode(cursor.encode()).decode())


def encode_feed_cursor(n: ReleaseNote) -> str:
    raw = json.dumps({"p": iso_z(n.published_at), "s": n.seq}, separators=(",", ":"))
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def decode_feed_cursor(cursor: str) -> tuple[datetime, int]:
    try:
        data = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode())
        published = datetime.fromisoformat(str(data["p"]).replace("Z", "+00:00"))
        seq = data["s"]
        if published.tzinfo is None or not isinstance(seq, int) or isinstance(seq, bool):
            raise ValueError("cursor")
        return published, seq
    except Exception as exc:
        raise bad_request("INVALID_CURSOR", "Некорректный курсор") from exc


def note_not_found() -> ApiError:
    return not_found("RELEASE_NOTE_NOT_FOUND", "Заметка не найдена")


# ---------------------------------------------------------------- выбор заметок для ученика (чистые правила)


class NoteLike(Protocol):
    @property
    def id(self) -> uuid.UUID: ...
    @property
    def audience(self) -> str: ...
    @property
    def segments(self) -> dict[str, Any]: ...
    @property
    def published_at(self) -> datetime | None: ...


def matches_segment(segments: dict[str, Any], lang: str, age: str) -> bool:
    ages, langs = segments.get("age") or [], segments.get("ui_lang") or []
    return (not ages or age in ages) and (not langs or lang in langs)


@dataclass(frozen=True)
class Pick:
    mode: Literal["welcome", "updates", "none"]
    notes: list[Any]


def pick_whats_new(published: Sequence[NoteLike], *, seen: set[uuid.UUID], seen_any_new: bool,
                   onboarded_at: datetime | None, lang: str, age: str) -> Pick:
    """INTERNAL_API §5, for-me. `published` — опубликованные заметки, новые первыми.

    - онбординг не завершён (нет onboarded_at) → none;
    - welcome: ученик ещё не видел ни одной заметки `new`, и для его сегмента такие опубликованы → все опубликованные
      `new` + последняя `all`, ещё не просмотренные;
    - updates: непросмотренные `existing` / `all`, опубликованные после onboarded_at;
    - фильтр по сегментам (язык интерфейса, возраст); не больше CLIENT_MAX_NOTES, новые первыми; пусто → none.
    """
    if onboarded_at is None:
        return Pick("none", [])
    visible = [n for n in published if matches_segment(n.segments, lang, age)]
    welcome = [n for n in visible if n.audience == "new"]
    if welcome and not seen_any_new:
        latest_all = next((n for n in visible if n.audience == "all"), None)
        chosen = [n for n in visible if (n.audience == "new" or n is latest_all) and n.id not in seen]
        mode: Literal["welcome", "updates"] = "welcome"
    else:
        chosen = [n for n in visible if n.audience in ("existing", "all") and n.id not in seen
                  and n.published_at is not None and n.published_at > onboarded_at]
        mode = "updates"
    chosen = chosen[:CLIENT_MAX_NOTES]
    return Pick(mode, chosen) if chosen else Pick("none", [])


# ---------------------------------------------------------------- данные ученика

LOCK_CLASS = 0x45585056  # 'EXPV': пространство advisory-lock'ов отметок просмотра (вторая половина — hashtext(user))


async def lock_user(session: AsyncSession, user_id: uuid.UUID) -> None:
    await session.execute(text("SELECT pg_advisory_xact_lock(:c, hashtext(:u))"),
                          {"c": LOCK_CLASS, "u": str(user_id)})


def user_deleted() -> ApiError:
    return ApiError(410, "USER_DELETED", "Профиль удалён по запросу пользователя")


async def ensure_not_deleted(session: AsyncSession, user_id: uuid.UUID) -> None:
    if await session.get(DeletedUser, user_id) is not None:
        raise user_deleted()


def published_order() -> tuple[Any, Any]:
    return ReleaseNote.published_at.desc(), ReleaseNote.seq.desc()


async def for_me(session: AsyncSession, user_id: uuid.UUID, *, onboarded_at: datetime | None, lang: str,
                 age: str) -> dict[str, Any]:
    await ensure_not_deleted(session, user_id)
    if onboarded_at is None:
        return {"mode": "none", "notes": []}
    published = (await session.execute(
        select(ReleaseNote).where(ReleaseNote.status == "published").order_by(*published_order()).limit(FOR_ME_SCAN)
    )).scalars().all()
    seen = set((await session.execute(
        select(ReleaseNoteView.release_note_id).where(ReleaseNoteView.user_id == user_id)
    )).scalars().all())
    seen_any_new = bool((await session.execute(select(exists().where(
        ReleaseNoteView.user_id == user_id, ReleaseNoteView.release_note_id == ReleaseNote.id,
        ReleaseNote.audience == "new",
    )))).scalar())
    pick = pick_whats_new(published, seen=seen, seen_any_new=seen_any_new, onboarded_at=onboarded_at,
                          lang=lang, age=age)
    return {"mode": pick.mode, "notes": [localized_view(n, lang) for n in pick.notes]}


async def mark_seen(session: AsyncSession, user_id: uuid.UUID, note_ids: Sequence[uuid.UUID], *,
                    lang: str | None = None, age: str | None = None) -> int:
    """Отметки просмотра — идемпотентно (повтор не меняет seen_at и сегмент: в статистике — сегмент первого показа),
    неизвестные id и черновики игнорируются. lang/age — сегмент ученика сейчас (для разрезов статистики), не PII."""
    await lock_user(session, user_id)
    await ensure_not_deleted(session, user_id)
    source = select(literal(user_id, PG_UUID(as_uuid=True)), ReleaseNote.id,
                    literal(lang, ReleaseNoteView.ui_lang.type), literal(age, ReleaseNoteView.age_segment.type)).where(
        ReleaseNote.id.in_(set(note_ids)), ReleaseNote.status != "draft")
    stmt = insert(ReleaseNoteView).from_select(["user_id", "release_note_id", "ui_lang", "age_segment"],
                                               source).on_conflict_do_nothing()
    result = await session.execute(stmt)
    return int(getattr(result, "rowcount", 0) or 0)


async def feed(session: AsyncSession, *, lang: str, age: str, limit: int, cursor: str | None) -> dict[str, Any]:
    """Лента «Новости»: все опубликованные заметки для сегмента ученика, новые первыми (Page<WhatsNewNote>)."""
    segments = ReleaseNote.segments
    stmt = (select(ReleaseNote)
            .where(ReleaseNote.status == "published",
                   or_(~segments.has_key("age"), segments["age"].contains([age])),
                   or_(~segments.has_key("ui_lang"), segments["ui_lang"].contains([lang])))
            .order_by(*published_order()).limit(limit + 1))
    if cursor is not None:
        published_at, seq = decode_feed_cursor(cursor)
        stmt = stmt.where(tuple_(ReleaseNote.published_at, ReleaseNote.seq) < tuple_(published_at, seq))
    rows = (await session.execute(stmt)).scalars().all()
    next_cursor = encode_feed_cursor(rows[limit - 1]) if len(rows) > limit else None
    return {"items": [localized_view(n, lang) for n in rows[:limit]], "next_cursor": next_cursor}


# ---------------------------------------------------------------- статистика (сотрудники)


async def stats(session: AsyncSession, note_id: uuid.UUID) -> dict[str, Any]:
    """ReleaseNoteStats (admin.ts): один агрегирующий запрос по release_note_views. Разрезы — только по отметкам с
    известным сегментом (миграция 0005), поэтому сумма разреза может быть меньше views_total."""
    note = await session.get(ReleaseNote, note_id)
    if note is None:
        raise note_not_found()
    v = ReleaseNoteView
    cols: list[ColumnElement[Any]] = [func.count()]
    cols += [func.count().filter(v.ui_lang == lang) for lang in UI_LANGS]
    cols += [func.count().filter(v.age_segment == age) for age in AGE_SEGMENTS]
    cols += [func.min(v.seen_at), func.max(v.seen_at)]
    row = (await session.execute(select(*cols).where(v.release_note_id == note_id))).one()
    total, *rest = row
    by_lang, rest = rest[:len(UI_LANGS)], rest[len(UI_LANGS):]
    by_age, (first, last) = rest[:len(AGE_SEGMENTS)], rest[len(AGE_SEGMENTS):]
    return {
        "release_note_id": str(note.id),
        "views_total": int(total),
        "views_by_lang": {lang: int(c) for lang, c in zip(UI_LANGS, by_lang, strict=True)},
        "views_by_age": {age: int(c) for age, c in zip(AGE_SEGMENTS, by_age, strict=True)},
        "first_view_at": iso_z(first),
        "last_view_at": iso_z(last),
    }


async def summary(session: AsyncSession) -> dict[str, Any]:
    """DashboardWhatsNew (admin.ts): действующие опубликованные и черновики (архив не считается); последняя
    опубликованная (ещё не снятая) — с заголовком на RU (язык сотрудников) и показами."""
    counts = dict((await session.execute(
        select(ReleaseNote.status, func.count()).where(ReleaseNote.status.in_(("published", "draft")))
        .group_by(ReleaseNote.status))).all())
    latest = (await session.execute(
        select(ReleaseNote).where(ReleaseNote.status == "published").order_by(*published_order()).limit(1)
    )).scalar_one_or_none()
    latest_out = None
    if latest is not None:
        views = (await views_by_note(session, [latest.id])).get(latest.id, 0)
        latest_out = {"release_note_id": str(latest.id), "slug": latest.slug, "title": str(latest.title.get("ru", "")),
                      "views_total": views, "published_at": iso_z(latest.published_at)}
    return {"published": int(counts.get("published", 0)), "drafts": int(counts.get("draft", 0)),
            "latest": latest_out}


async def delete_user_data(session: AsyncSession, *, user_id: str, request_id: str) -> int:
    """Сага удаления: отметки просмотра ученика удаляются физически, отметка deleted_users закрывает новые;
    ACK user.domain.deleted.v1 {domain: experience-config, mode: deleted}. Повтор безопасен."""
    removed = 0
    try:
        uid: uuid.UUID | None = uuid.UUID(user_id)
    except ValueError:
        uid = None
    if uid is not None:
        try:
            request_uuid = uuid.UUID(request_id)
        except ValueError:
            request_uuid = uuid.UUID(int=0)
        await lock_user(session, uid)
        await session.execute(insert(DeletedUser).values(user_id=uid, request_id=request_uuid)
                              .on_conflict_do_nothing(index_elements=[DeletedUser.user_id]))
        result = await session.execute(delete(ReleaseNoteView).where(ReleaseNoteView.user_id == uid))
        removed = int(getattr(result, "rowcount", 0) or 0)
    await emit(session, DOMAIN_DELETED,
               {"user_id": user_id, "request_id": request_id, "domain": PRODUCER, "mode": "deleted"},
               producer=PRODUCER)
    return removed


# ---------------------------------------------------------------- аудит


def audit_record(*, actor_type: Literal["staff", "system"], actor_id: str, actor_role: str | None, action: str,
                 note_id: uuid.UUID, slug: str, before: dict | None, after: dict | None, reason: str | None,
                 trace_id: str | None, occurred_at: datetime | None = None) -> dict[str, Any]:
    """Payload admin.audit.recorded.v1 — без текстов заметки (журнал неизменяем). Общий для команд сотрудника и
    публикации заметки релиза миграцией (actor_type system, actor_id system:release)."""
    return {
        "record_id": str(uuid.uuid4()),
        "occurred_at": (occurred_at or datetime.now(UTC)).astimezone(UTC).isoformat().replace("+00:00", "Z"),
        "actor_type": actor_type,
        "actor_id": actor_id[:64],
        "actor_role": actor_role[:64] if actor_role is not None else None,
        "action": action,
        "object_type": OBJECT_TYPE,
        "object_id": str(note_id),
        "before": before,
        "after": {"slug": slug, **(after or {})},
        "reason": reason,
        "trace_id": trace_id[:64] if trace_id is not None else None,
    }


def _audit(actor: Actor, action: str, note_id: uuid.UUID, slug: str, before: dict | None, after: dict | None,
           reason: str | None) -> dict[str, Any]:
    return audit_record(actor_type="staff", actor_id=actor.id, actor_role=actor.role, action=action, note_id=note_id,
                        slug=slug, before=before, after=after, reason=reason, trace_id=context.get_trace_id())


def published_payload(note_id: uuid.UUID, slug: str, audience: str, segments: dict[str, Any],
                      published_at: datetime) -> dict[str, Any]:
    """Payload experience.release_note.published.v1 — у публикации сотрудником и у заметки релиза (миграция)."""
    return {"release_note_id": str(note_id), "slug": slug, "audience": audience, "segments": segments,
            "published_at": iso_z(published_at)}


async def _emit_audit(session: AsyncSession, payload: dict[str, Any]) -> None:
    await emit(session, AUDIT_EVENT, payload, producer=PRODUCER)


# ---------------------------------------------------------------- команды сотрудников


async def _get_for_update(session: AsyncSession, note_id: uuid.UUID) -> ReleaseNote:
    stmt = select(ReleaseNote).where(ReleaseNote.id == note_id).with_for_update()
    note = (await session.execute(stmt.execution_options(populate_existing=True))).scalar_one_or_none()
    if note is None:
        raise note_not_found()
    return note


async def _slug_taken(session: AsyncSession, slug: str, exclude: uuid.UUID | None = None) -> bool:
    stmt = select(ReleaseNote.id).where(ReleaseNote.slug == slug, ReleaseNote.status != "archived")
    if exclude is not None:
        stmt = stmt.where(ReleaseNote.id != exclude)
    return (await session.execute(stmt.limit(1))).scalar_one_or_none() is not None


def _slug_exists(slug: str) -> ApiError:
    return conflict("RELEASE_NOTE_SLUG_EXISTS", f"Заметка {slug} уже есть — архивируйте её или выберите другую метку",
                    {"slug": slug})


SLUG_UNIQUE = "uq_release_notes_slug_active"


async def _flush_slug(session: AsyncSession, slug: str) -> None:
    """Проверка метки выше — без блокировки: две одновременные команды с одной меткой обе её проходят, и вторую
    останавливает уникальный индекс. Это тоже 409 RELEASE_NOTE_SLUG_EXISTS, а не 500."""
    try:
        await session.flush()
    except IntegrityError as exc:
        if SLUG_UNIQUE in str(exc.orig):
            raise _slug_exists(slug) from None
        raise


def dump_content(content: NoteContent) -> dict[str, Any]:
    data = content.model_dump(mode="json")
    segments = content.segments.normalized() if content.segments is not None else {}
    return {"slug": data["slug"], "title": data["title"], "items": data["items"], "audience": data["audience"],
            "segments": segments, "illustration": data["illustration"]}


async def create(session: AsyncSession, content: NoteContent, actor: Actor) -> ReleaseNote:
    new = dump_content(content)
    ensure_translations(new["title"], new["items"])
    if await _slug_taken(session, content.slug):
        raise _slug_exists(content.slug)
    now = datetime.now(UTC)
    note = ReleaseNote(id=uuid.uuid4(), **new, status="draft", version=1, created_by=actor.id[:64],
                       created_at=now, updated_by=actor.id[:64], updated_at=now)
    session.add(note)
    await _flush_slug(session, content.slug)
    await _emit_audit(session, _audit(actor, "release_note.create", note.id, note.slug, None,
                                      {"status": "draft", "items": len(note.items), "audience": note.audience,
                                       "segments": note.segments, "illustration": note.illustration}, None))
    return note


async def update(session: AsyncSession, note_id: uuid.UUID, expected_version: int, content: NoteContent,
                 actor: Actor) -> ReleaseNote:
    """Правка черновика. Повтор тех же данных — no-op (версия и аудит не меняются). Поля illustration нет в теле
    (клиент до 6.1) — иллюстрация черновика остаётся; null — снимается."""
    note = await _get_for_update(session, note_id)
    if note.status != "draft":
        raise conflict("RELEASE_NOTE_NOT_DRAFT",
                       "Опубликованную заметку изменить нельзя — архивируйте её и создайте новую",
                       {"status": note.status})
    if note.version != expected_version:
        raise conflict("RELEASE_NOTE_VERSION_CONFLICT", "Заметку уже изменили — обновите страницу",
                       {"current_version": note.version})
    new = dump_content(content)
    if "illustration" not in content.model_fields_set:
        new["illustration"] = note.illustration
    ensure_translations(new["title"], new["items"])
    changed = [k for k, v in new.items() if getattr(note, k) != v]
    if not changed:
        return note
    if "slug" in changed and await _slug_taken(session, content.slug, exclude=note.id):
        raise _slug_exists(content.slug)
    before = {"version": note.version}
    for k in changed:
        setattr(note, k, new[k])
    note.version += 1
    note.updated_by = actor.id[:64]
    note.updated_at = datetime.now(UTC)
    await _flush_slug(session, note.slug)
    await _emit_audit(session, _audit(actor, "release_note.update", note.id, note.slug, before,
                                      {"version": note.version, "changed": changed}, None))
    return note


async def publish(session: AsyncSession, note_id: uuid.UUID, expected_version: int, reason: str,
                  actor: Actor) -> tuple[ReleaseNote, bool]:
    """draft → published (published_at = сейчас) + experience.release_note.published.v1. Уже опубликованная → no-op
    (повтор после потерянного ответа)."""
    note = await _get_for_update(session, note_id)
    if note.status == "published":
        return note, False
    if note.status != "draft":
        raise conflict("RELEASE_NOTE_NOT_DRAFT", "Архивную заметку опубликовать нельзя — создайте новую",
                       {"status": note.status})
    if note.version != expected_version:
        raise conflict("RELEASE_NOTE_VERSION_CONFLICT", "Заметку уже изменили — проверьте её ещё раз перед публикацией",
                       {"current_version": note.version})
    ensure_publishable(note)  # защита в глубину: черновик мог прийти в обход API (сид, SQL)
    now = datetime.now(UTC)
    note.status = "published"
    note.published_by = actor.id[:64]
    note.published_at = now
    note.version += 1
    note.updated_by = actor.id[:64]
    note.updated_at = now
    await session.flush()
    await emit(session, PUBLISHED_EVENT, published_payload(note.id, note.slug, note.audience, note.segments, now),
               producer=PRODUCER)
    await _emit_audit(session, _audit(actor, "release_note.publish", note.id, note.slug, {"status": "draft"},
                                      {"status": "published", "audience": note.audience, "segments": note.segments,
                                       "published_at": iso_z(now)}, reason))
    return note, True


async def archive(session: AsyncSession, note_id: uuid.UUID, reason: str,
                  actor: Actor) -> tuple[ReleaseNote, bool]:
    """Снятие: published/draft → archived (ученики её больше не видят ни в «Что нового», ни в ленте).
    Уже в архиве → no-op."""
    note = await _get_for_update(session, note_id)
    if note.status == "archived":
        return note, False
    before = note.status
    now = datetime.now(UTC)
    note.status = "archived"
    note.archived_by = actor.id[:64]
    note.archived_at = now
    note.version += 1
    note.updated_by = actor.id[:64]
    note.updated_at = now
    await session.flush()
    await _emit_audit(session, _audit(actor, "release_note.archive", note.id, note.slug, {"status": before},
                                      {"status": "archived"}, reason))
    return note, True

