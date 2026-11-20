"""Pydantic-модели входа API catalog (extra="forbid"). Формы — admin.ts («Контент и диагностика») и bff.ts."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BaseModel, BeforeValidator, ConfigDict, Field, HttpUrl

from tilhero_catalog.content import CONTROL_RE, ID_PATTERN, GlossaryRefKind, LanguagePair, LocaleCheck, PartOfSpeech

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


# ---------------------------------------------------------------- спринт 5: словарь курса (admin.ts, INTERNAL_API §2.3)

PAIR_PATTERN = r"^[a-z]{2,3}-[a-z]{2,3}$"
PairId = Annotated[str, Field(pattern=PAIR_PATTERN)]
GlossText = Annotated[Plain, Field(min_length=1, max_length=80)]
EnText = Annotated[Plain, Field(min_length=1, max_length=60)]
FormText = Annotated[Plain, Field(min_length=1, max_length=120)]
ExampleText = Annotated[Plain, Field(min_length=1, max_length=200)]
NoteText = Annotated[Plain, Field(max_length=300)]


class GlossIn(BaseModel):
    """Перевод статьи (Localized): RU и UZ непустые, до 80 знаков."""

    model_config = _IN

    ru: GlossText
    uz: GlossText


class ContentRefIn(BaseModel):
    """ContentRef (bff.ts): locator — s_id (reading), индекс реплики (media_asset), ex:<i> / kw:<i> (lesson),
    node_id (scenario)."""

    model_config = _IN

    kind: GlossaryRefKind
    key: Annotated[str, Field(pattern=ID_PATTERN)]
    version: int = Field(ge=1, le=1_000_000)
    locator: Annotated[str, Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9:._-]+$")] | None = None


class GlossaryLookupIn(BaseModel):
    """POST /internal/v1/glossary/lookup (memory). text ≤ 120: карточка «в словарь» берёт фразу медиа до 120 знаков
    (AddCardRequest.text_en); перевод по тапу присылает ≤ 60."""

    model_config = _IN

    pair_id: PairId
    text: FormText
    content_ref: ContentRefIn


class AiEntryIn(BaseModel):
    """POST /internal/v1/glossary/ai-entries (memory): перевод teaching_coach gloss_word для слова из контента."""

    model_config = _IN

    pair_id: PairId
    surface: FormText
    lemma: EnText
    part_of_speech: PartOfSpeech | None = None
    gloss: GlossIn
    forms: list[EnText] = Field(default_factory=list, max_length=8)
    confidence: float = Field(ge=0, le=1)
    agent_version: Annotated[Plain, Field(min_length=1, max_length=64)]
    content_ref: ContentRefIn


class GlossaryCreateIn(BaseModel):
    """GlossaryCreate (admin.ts)."""

    model_config = _IN

    pair_id: PairId
    lemma: EnText
    forms: list[FormText] = Field(min_length=1, max_length=8)
    part_of_speech: PartOfSpeech | None = None
    gloss: GlossIn
    example_en: ExampleText | None = None
    reason: Annotated[Plain, Field(max_length=500)] | None = None


class OverrideIn(BaseModel):
    model_config = _IN

    gloss: GlossIn
    example_en: ExampleText | None = None


class GlossaryPatchIn(BaseModel):
    """GlossaryPatch (admin.ts): отсутствующее поле не меняется; override: null — снять правку статьи course."""

    model_config = _IN

    lemma: EnText | None = None
    forms: list[FormText] | None = Field(default=None, min_length=1, max_length=8)
    part_of_speech: PartOfSpeech | None = None
    gloss: GlossIn | None = None
    example_en: ExampleText | None = None
    override: OverrideIn | None = None
    reason: Annotated[Plain, Field(max_length=500)] | None = None


class GlossaryReviewIn(BaseModel):
    """GlossaryReview (admin.ts): correct — с новым переводом."""

    model_config = _IN

    decision: Literal["approve", "correct", "reject"]
    gloss: GlossIn | None = None
    note: NoteText | None = None


class GlossaryArchiveIn(BaseModel):
    model_config = _IN

    reason: Reason
