"""Pydantic-модели входа API catalog (extra="forbid"). Формы — admin.ts («Контент и диагностика») и bff.ts."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BaseModel, BeforeValidator, ConfigDict, Field, HttpUrl

from tilhero_catalog.content import CONTROL_RE, ID_PATTERN, LanguagePair, LocaleCheck

_IN = ConfigDict(extra="forbid")


def _strip(value: object) -> object:
    """Пробелы по краям срезаются ДО проверки длины: «  a  » не проходит как двухсимвольное название."""
    return value.strip() if isinstance(value, str) else value


def _plain(value: str) -> str:
    """Одна строка простого текста: управляющие и bidi-символы запрещены."""
    if CONTROL_RE.search(value):
        raise ValueError("недопустимые символы")
    return value


def _https(value: str) -> str:
    """Ссылка ученика — только https://, хранится как текст: сервер её не открывает и не скачивает."""
    url = HttpUrl(value)
    if url.scheme != "https":
        raise ValueError("ссылка должна начинаться с https://")
    return value


Plain = Annotated[str, BeforeValidator(_strip), AfterValidator(_plain)]
Reason = Annotated[Plain, Field(min_length=3, max_length=500)]
Note = Annotated[Plain, Field(min_length=3, max_length=1000)]


class ContentCreateIn(BaseModel):
    model_config = _IN

    payload: dict[str, Any]


class NewVersionIn(BaseModel):
    model_config = _IN

    from_version: int = Field(ge=1)


class VersionUpdateIn(BaseModel):
    model_config = _IN

    payload: dict[str, Any]
    expected_hash: str = Field(pattern=r"^[0-9a-f]{64}$")


class LocaleChecksIn(BaseModel):
    model_config = _IN

    ru: LocaleCheck
    uz: LocaleCheck


class ReviewIn(BaseModel):
    """ContentReviewInput (admin.ts)."""

    model_config = _IN

    decision: Literal["approve", "return"]
    note: Note
    locale_checks: LocaleChecksIn


class PublishIn(BaseModel):
    model_config = _IN

    reason: Reason


class ArchiveIn(BaseModel):
    model_config = _IN

    reason: Reason


class RollbackIn(BaseModel):
    model_config = _IN

    to_version: int = Field(ge=1)
    reason: Reason


class RightsApproveIn(BaseModel):
    model_config = _IN

    note: Note


class AudioUploadIn(BaseModel):
    """AudioUpload (admin.ts): base64 ≤ 3 МБ (тело ≤ 4,5 МБ — только этот маршрут)."""

    model_config = _IN

    filename: Annotated[Plain, Field(min_length=1, max_length=200)]
    content_type: Literal["audio/mpeg", "audio/ogg", "audio/mp4"]
    data_base64: str = Field(min_length=4, max_length=4_400_000)


class MediaRequestDecisionIn(BaseModel):
    """MediaRequestDecision (admin.ts)."""

    model_config = _IN

    status: Literal["authored_alternative", "licensed", "rejected", "duplicate"]
    note: Annotated[Plain, Field(min_length=3, max_length=500)]
    linked_asset_id: Annotated[str, Field(pattern=ID_PATTERN)] | None = None


class MediaRequestCreateIn(BaseModel):
    """MediaRequestCreate (bff.ts) + ui_locale (язык интерфейса ученика для уведомления, дополняет telegram-bff)."""

    model_config = _IN

    kind: Literal["song", "movie", "series", "other"]
    title: Annotated[Plain, Field(min_length=2, max_length=200)]
    link: Annotated[str, BeforeValidator(_strip), Field(max_length=500), AfterValidator(_https)] | None = None
    comment: Annotated[Plain, Field(max_length=500)] | None = None
    ui_locale: Literal["ru", "uz"] = "ru"


class PairPutIn(LanguagePair):
    """LanguagePair & {reason} (admin.ts)."""

    model_config = ConfigDict(extra="forbid", strict=False)

    reason: Reason
