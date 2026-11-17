"""Заметки о релизах «Что нового» (доработка 9.4).

Жизненный цикл: draft → published → archived (черновик можно и сразу архивировать). Правится только черновик
(оптимистическая блокировка по `version`); опубликованная заметка неизменна — исправление = архив + новая заметка.
Это же закрепляет триггер в БД (миграция 0003). Каждое действие пишет `admin.audit.recorded.v1` через outbox в той же
транзакции, что и изменение.

Белые списки маршрутов Mini App и иконок — общий каталог `packages/contracts/release-notes.json` (сверка — контрактный
тест). Тексты — простой текст без управляющих символов; клиенты выводят их только как текст (никакой разметки).
"""

from __future__ import annotations

import base64
import re
import uuid
from datetime import UTC, datetime
from typing import Annotated, Any, Final, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from tilhero_common import context
from tilhero_common.errors import ApiError, conflict, not_found
from tilhero_common.internal_auth import Actor
from tilhero_common.messaging import emit
from tilhero_experience.models import ReleaseNote

PRODUCER = "experience-config"
AUDIT_EVENT = "admin.audit.recorded.v1"
OBJECT_TYPE = "release_note"

ROUTES: Final[tuple[str, ...]] = ("home", "catalog", "watch", "news", "profile", "support")
ICONS: Final[tuple[str, ...]] = (
    "spark", "ticket", "globe", "pin", "bell", "radar", "news", "route", "star", "plane", "bed", "search", "shield",
    "chat", "cal", "phone",
)
SLUG_PATTERN = r"^[0-9A-Za-z][0-9A-Za-z.-]{0,31}$"
TITLE_MAX, ITEM_TITLE_MAX, ITEM_TEXT_MAX = 80, 80, 200
ITEMS_MIN, ITEMS_MAX = 1, 6
CLIENT_MAX_NOTES = 3
PUBLISHED_FEED_MAX = 20

Status = Literal["draft", "published", "archived"]
Audience = Literal["all", "existing"]
Route = Literal["home", "catalog", "watch", "news", "profile", "support"]
IconName = Literal["spark", "ticket", "globe", "pin", "bell", "radar", "news", "route", "star", "plane", "bed",
                   "search", "shield", "chat", "cal", "phone"]

# управляющие C0/C1, разделители строк, невидимые и bidi: U+061C, U+200B–U+200F (ZWSP, ZWNJ, ZWJ, LRM, RLM),
# U+2028–U+202E (в т. ч. LRE…RLO), U+2060–U+2064, U+2066–U+2069 (изоляты), U+FEFF (BOM) — ревью 9.4
_CONTROL = re.compile(
    "[\\x00-\\x1f\\x7f-\\x9f\\u061c\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff]"
)
_SPACES = re.compile(r"\s+")


def _plain(value: str) -> str:
    """Одна строка простого текста: пробелы схлопываются, управляющие и bidi-символы запрещены."""
    if _CONTROL.search(value):
        raise ValueError("недопустимые символы")
    value = _SPACES.sub(" ", value).strip()
    if not value:
        raise ValueError("пустой текст")
    return value


Plain = Annotated[str, AfterValidator(_plain)]
_IN = ConfigDict(extra="forbid", strict=True)


class LocalizedTitle(BaseModel):
    model_config = _IN

    ru: Plain = Field(min_length=1, max_length=TITLE_MAX)
    en: Plain = Field(min_length=1, max_length=TITLE_MAX)


class LocalizedItemTitle(BaseModel):
    model_config = _IN

    ru: Plain = Field(min_length=1, max_length=ITEM_TITLE_MAX)
    en: Plain = Field(min_length=1, max_length=ITEM_TITLE_MAX)


class LocalizedText(BaseModel):
    model_config = _IN

    ru: Plain = Field(min_length=1, max_length=ITEM_TEXT_MAX)
    en: Plain = Field(min_length=1, max_length=ITEM_TEXT_MAX)


class NoteItem(BaseModel):
    model_config = _IN

    title: LocalizedItemTitle
    text: LocalizedText
    link: Route | None = Field(default=None, description="маршрут Mini App из белого списка")
    icon: IconName | None = Field(default=None, description="иконка Mini App из набора")


class NoteContent(BaseModel):
    """Содержимое заметки — общее для создания и правки черновика."""

    model_config = _IN

    slug: str = Field(pattern=SLUG_PATTERN, description="версия/метка релиза, например 2026.11")
    title: LocalizedTitle
    items: list[NoteItem] = Field(min_length=ITEMS_MIN, max_length=ITEMS_MAX)
    audience: Audience = "existing"


# ---------------------------------------------------------------- представления


def iso_z(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def staff_view(n: ReleaseNote) -> dict[str, Any]:
    return {
        "release_note_id": str(n.id), "slug": n.slug, "title": n.title, "items": n.items, "audience": n.audience,
        "status": n.status, "version": n.version,
        "created_by": n.created_by, "created_at": iso_z(n.created_at),
        "updated_by": n.updated_by, "updated_at": iso_z(n.updated_at),
        "published_by": n.published_by, "published_at": iso_z(n.published_at),
        "archived_by": n.archived_by, "archived_at": iso_z(n.archived_at),
    }


def public_view(n: ReleaseNote) -> dict[str, Any]:
    """Для telegram-bff: только опубликованное содержимое, без сотрудников."""
    return {"release_note_id": str(n.id), "slug": n.slug, "title": n.title, "items": n.items,
            "audience": n.audience, "published_at": iso_z(n.published_at)}


def encode_cursor(seq: int) -> str:
    return base64.urlsafe_b64encode(str(seq).encode()).decode()


def decode_cursor(cursor: str) -> int:
    return int(base64.urlsafe_b64decode(cursor.encode()).decode())


def note_not_found() -> ApiError:
    return not_found("RELEASE_NOTE_NOT_FOUND", "Заметка о релизе не найдена")


# ---------------------------------------------------------------- аудит


def _audit(actor: Actor, action: str, note_id: uuid.UUID, slug: str, before: dict | None, after: dict | None,
           reason: str | None) -> dict[str, Any]:
    return {
        "record_id": str(uuid.uuid4()),
        "occurred_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "actor_type": "staff",
        "actor_id": actor.id[:64],
        "actor_role": actor.role[:64],
        "action": action,
        "object_type": OBJECT_TYPE,
        "object_id": str(note_id),
        "before": before,
        "after": {"slug": slug, **(after or {})},
        "reason": reason,
        "trace_id": context.get_trace_id()[:64],
    }


async def _emit_audit(session: AsyncSession, payload: dict[str, Any]) -> None:
    await emit(session, AUDIT_EVENT, payload, producer=PRODUCER)


# ---------------------------------------------------------------- команды


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
    останавливает уникальный индекс. Это тоже 409 RELEASE_NOTE_SLUG_EXISTS, а не 500 (ревью 9.4)."""
    try:
        await session.flush()
    except IntegrityError as exc:
        if SLUG_UNIQUE in str(exc.orig):
            raise _slug_exists(slug) from None
        raise


def _dump(content: NoteContent) -> dict[str, Any]:
    data = content.model_dump(mode="json")
    return {"slug": data["slug"], "title": data["title"], "items": data["items"], "audience": data["audience"]}


async def create(session: AsyncSession, content: NoteContent, actor: Actor) -> ReleaseNote:
    if await _slug_taken(session, content.slug):
        raise _slug_exists(content.slug)
    now = datetime.now(UTC)
    note = ReleaseNote(id=uuid.uuid4(), **_dump(content), status="draft", version=1, created_by=actor.id[:64],
                       created_at=now, updated_by=actor.id[:64], updated_at=now)
    session.add(note)
    await _flush_slug(session, content.slug)
    await _emit_audit(session, _audit(actor, "release_note.create", note.id, note.slug, None,
                                      {"status": "draft", "items": len(note.items), "audience": note.audience},
                                      None))
    return note


async def update(session: AsyncSession, note_id: uuid.UUID, expected_version: int, content: NoteContent,
                 actor: Actor) -> ReleaseNote:
    """Правка черновика. Повтор тех же данных — no-op (версия и аудит не меняются)."""
    note = await _get_for_update(session, note_id)
    if note.status != "draft":
        raise conflict("RELEASE_NOTE_NOT_DRAFT",
                       "Опубликованную заметку изменить нельзя — архивируйте её и создайте новую",
                       {"status": note.status})
    if note.version != expected_version:
        raise conflict("RELEASE_NOTE_VERSION_CONFLICT", "Заметку уже изменили — обновите страницу",
                       {"current_version": note.version})
    new = _dump(content)
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
    """draft → published (published_at = сейчас). Уже опубликованная → no-op (повтор после потерянного ответа)."""
    note = await _get_for_update(session, note_id)
    if note.status == "published":
        return note, False
    if note.status != "draft":
        raise conflict("RELEASE_NOTE_NOT_DRAFT", "Архивную заметку опубликовать нельзя — создайте новую",
                       {"status": note.status})
    if note.version != expected_version:
        raise conflict("RELEASE_NOTE_VERSION_CONFLICT", "Заметку уже изменили — проверьте её ещё раз перед публикацией",
                       {"current_version": note.version})
    now = datetime.now(UTC)
    note.status = "published"
    note.published_by = actor.id[:64]
    note.published_at = now
    note.version += 1
    note.updated_by = actor.id[:64]
    note.updated_at = now
    await session.flush()
    await _emit_audit(session, _audit(actor, "release_note.publish", note.id, note.slug, {"status": "draft"},
                                      {"status": "published", "audience": note.audience,
                                       "published_at": iso_z(now)}, reason))
    return note, True


async def archive(session: AsyncSession, note_id: uuid.UUID, reason: str,
                  actor: Actor) -> tuple[ReleaseNote, bool]:
    """published/draft → archived. Уже в архиве → no-op."""
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
