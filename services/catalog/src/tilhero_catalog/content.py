"""Форматы учебного контента — pydantic-модели 1:1 с `packages/contracts/src/content.ts` (источник истины).

Имена классов и полей совпадают с интерфейсами TS; контрактный тест (tests/test_catalog_contract.py) разбирает
content.ts и сверяет поля и перечисления. Здесь — только **схема** (типы, перечисления, форматы идентификаторов,
длины строк, мягкие верхние пределы списков против злоупотреблений): черновик может быть неполным. Точные диапазоны
(«4..12 опорных слов», «сумма весов = 1», «≥ 3 контрольных заданий», ссылки, локализации) — бизнес-правила
`domain/validation.py`, они проверяются при отправке на проверку и при публикации и дают коды ошибок INTERNAL_API §1.2.
"""

from __future__ import annotations

import re
from datetime import date, datetime
from typing import Annotated, Any, Final, Literal, get_args

from pydantic import AfterValidator, BaseModel, ConfigDict, Field

# ---------------------------------------------------------------------------------------------------------------- общее

Band = Literal["A0", "A1", "A2", "B1", "B2"]
BANDS: Final[tuple[str, ...]] = get_args(Band)
AudienceSegment = Literal["kids", "teens", "adults"]
GoalCode = Literal["work", "career", "travel", "daily", "study", "exam"]
TopicCode = Literal[
    "small_talk", "travel", "food", "shopping", "work", "interview", "study", "health", "home", "hobbies",
    "movies", "tech",
]
ContentKind = Literal[
    "course", "skill", "module", "lesson", "rubric", "scenario", "media_asset", "media_exercise",
    "reading",  # спринт 5
]
CONTENT_KINDS: Final[tuple[str, ...]] = get_args(ContentKind)
VersionStatus = Literal["draft", "in_review", "approved", "published", "suspended", "archived"]
LocaleCheck = Literal["missing", "draft", "checked"]
PairStatus = Literal["planned", "development", "review", "pilot", "published", "archived"]
SkillArea = Literal["vocabulary", "grammar", "reading", "listening", "speaking", "writing", "function"]
LessonStageType = Literal["retrieval", "explanation", "roleplay", "assessment", "summary"]
STAGE_ORDER: Final[tuple[str, ...]] = get_args(LessonStageType)
ControlItemType = Literal["single_choice", "gap_fill", "order_words", "translate_choice"]
MediaType = Literal["song", "movie", "interview", "dialogue", "own_scene"]
MediaOrigin = Literal["own_recording", "public_domain", "open_license", "licensed", "platform_embed"]
MediaUse = Literal["listen", "show_transcript", "exercises", "dictionary", "translation"]
MediaExerciseType = Literal["comprehension", "gap_fill", "order_lines", "phrase_meaning", "shadowing", "roleplay"]
MediaRequestStatus = Literal["new", "in_review", "authored_alternative", "licensed", "rejected", "duplicate"]
ScenarioIssueCode = Literal[
    "START_MISSING", "UNKNOWN_NODE", "UNREACHABLE_NODE", "DEAD_END", "NO_SUCCESS_END", "TRAP",
    "UNKNOWN_SPEAKER", "NO_RECOVERY_POINT", "RECOVERY_CANNOT_FINISH", "TOO_MANY_NODES",
]
LicenseType = Literal["own", "cc0", "cc_by", "cc_by_sa", "public_domain", "contract"]
Outcome = Literal["success", "alt_success", "fail"]
RubricCode = Literal["task", "vocabulary", "grammar", "independence", "pronunciation", "fluency", "comprehension"]
# спринт 5: чтение и словарь курса
ReadingQuestionType = Literal["single_choice", "true_false", "gap_fill"]
GlossarySource = Literal["course", "methodist", "ai"]
GlossaryReviewStatus = Literal["not_required", "pending", "approved", "rejected"]
PartOfSpeech = Literal[
    "noun", "verb", "adjective", "adverb", "pronoun", "preposition", "conjunction", "interjection", "determiner",
    "phrase", "other",
]
GlossaryRefKind = Literal["lesson", "media_asset", "reading", "scenario"]

ID_PATTERN: Final = r"^[a-z0-9][a-z0-9._-]{1,63}$"
SENTENCE_ID_PATTERN: Final = r"^[a-z0-9]{1,8}$"
PARAGRAPH_ID_PATTERN: Final = r"^[a-z0-9][a-z0-9_-]{0,15}$"
INTENT_PATTERN: Final = r"^[a-z][a-z0-9_]{0,39}$"
LANG_PATTERN: Final = r"^[a-z]{2,3}(-[A-Z]{2})?$"
TERRITORY_PATTERN: Final = r"^[A-Z]{2}$"

# управляющие C0/C1, разделители строк, невидимые и bidi (как в experience-config)
CONTROL_RE: Final = re.compile(
    "[\\x00-\\x1f\\x7f-\\x9f\\u061c\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff]"
)


def _no_control(value: str) -> str:
    if CONTROL_RE.search(value):
        raise ValueError("недопустимые управляющие символы")
    return value


def _iso_date(value: str) -> str:
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ValueError("дата в формате YYYY-MM-DD")
    date.fromisoformat(value)
    return value


def _iso_moment(value: str) -> str:
    """Дата YYYY-MM-DD или момент ISO-8601 (2026-12-01T09:00:00Z)."""
    datetime.fromisoformat(value.replace("Z", "+00:00"))
    return value


Text = Annotated[str, AfterValidator(_no_control)]
Id = Annotated[str, Field(pattern=ID_PATTERN)]
IsoDate = Annotated[str, AfterValidator(_iso_date)]
NonNeg = Annotated[int, Field(ge=0)]

# мягкие пределы схемы (точные диапазоны — бизнес-правила)
LIST_CAP: Final = 50
TEXT_MAX: Final = 1000

_IN = ConfigDict(extra="forbid", strict=True)


class _Model(BaseModel):
    model_config = _IN


class Localized(_Model):
    """Текст ученику на RU и UZ. Пустая строка допустима в черновике — её ловит LOCALE_MISSING при отправке."""

    ru: Annotated[Text, Field(max_length=TEXT_MAX)]
    uz: Annotated[Text, Field(max_length=TEXT_MAX)]


# ---------------------------------------------------------------------------------------------------- языки и пары


class LanguageName(_Model):
    ru: Annotated[Text, Field(min_length=1, max_length=80)]
    uz: Annotated[Text, Field(min_length=1, max_length=80)]
    en: Annotated[Text, Field(min_length=1, max_length=80)]


class LanguageAsr(_Model):
    provider: Annotated[Text, Field(min_length=1, max_length=60)]
    model: Annotated[Text, Field(min_length=1, max_length=120)]


class LanguageTts(_Model):
    provider: Annotated[Text, Field(min_length=1, max_length=60)]
    voices: list[Annotated[Text, Field(min_length=1, max_length=60)]] = Field(max_length=LIST_CAP)


class Language(_Model):
    code: Annotated[str, Field(pattern=LANG_PATTERN)]
    name: LanguageName
    script: Literal["Latn", "Cyrl"]
    variants: list[Annotated[str, Field(pattern=LANG_PATTERN)]] = Field(max_length=20)
    asr: LanguageAsr | None
    tts: LanguageTts | None
    limitations: Annotated[Text, Field(max_length=TEXT_MAX)] | None
    status: Literal["active", "planned"]


class LanguagePair(_Model):
    pair_id: Annotated[str, Field(pattern=r"^[a-z]{2,3}-[a-z]{2,3}$")]
    source: Annotated[str, Field(pattern=LANG_PATTERN)]
    target: Annotated[str, Field(pattern=LANG_PATTERN)]
    explanation_locales: list[Annotated[str, Field(pattern=LANG_PATTERN)]] = Field(min_length=1, max_length=5)
    ui_locales: list[Literal["ru", "uz"]] = Field(min_length=1, max_length=2)
    title: Localized
    status: PairStatus
    release_at: Annotated[str, Field(max_length=40), AfterValidator(_iso_moment)] | None
    course_id: Id | None


# ------------------------------------------------------------------------------------- курс, навыки, модули, уроки


class CoursePayload(_Model):
    course_id: Id
    pair_id: Annotated[str, Field(pattern=r"^[a-z]{2,3}-[a-z]{2,3}$")]
    title: Localized
    description: Localized
    level_start: Band
    level_end: Band
    module_ids: list[Id] = Field(max_length=LIST_CAP)


class SkillPayload(_Model):
    skill_id: Id
    course_id: Id
    area: SkillArea
    title: Localized
    description: Localized
    level: Band
    prerequisites: list[Id] = Field(max_length=LIST_CAP)
    rubric_id: Id | None
    diagnostic_tags: list[Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9._-]{0,63}$")]] = Field(max_length=LIST_CAP)


class ModulePayload(_Model):
    module_id: Id
    course_id: Id
    title: Localized
    goal: Localized
    theme: TopicCode
    lesson_ids: list[Id] = Field(max_length=LIST_CAP)


class LessonStage(_Model):
    type: LessonStageType
    minutes: Annotated[int, Field(ge=0, le=60)]
    instructions: Localized


class KeyWord(_Model):
    en: Annotated[Text, Field(max_length=60)]
    gloss: Localized
    example_en: Annotated[Text, Field(max_length=160)]


class Example(_Model):
    en: Annotated[Text, Field(max_length=200)]
    gloss: Localized


class ControlItem(_Model):
    item_id: Id
    type: ControlItemType
    skill_id: Id
    instruction: Localized
    prompt_en: Annotated[Text, Field(max_length=300)]
    options: list[Annotated[Text, Field(max_length=200)]] = Field(max_length=12)
    answer: Annotated[int, Field(ge=0)] | list[Annotated[Text, Field(max_length=200)]]


class LessonPayload(_Model):
    lesson_id: Id
    course_id: Id
    module_id: Id
    title: Localized
    goal: Localized
    level: Band
    kind: Literal["core", "optional"]
    audience: list[AudienceSegment] = Field(max_length=3)
    goals: list[GoalCode] = Field(max_length=6)
    topics: list[TopicCode] = Field(max_length=12)
    primary_skill_id: Id
    secondary_skill_ids: list[Id] = Field(max_length=10)
    prerequisite_skill_ids: list[Id] = Field(max_length=LIST_CAP)
    duration_min: Literal[10, 15, 20, 30]
    stages: list[LessonStage] = Field(max_length=10)
    key_words: list[KeyWord] = Field(max_length=LIST_CAP)
    examples: list[Example] = Field(max_length=LIST_CAP)
    scenario_id: Id | None
    rubric_id: Id
    control_items: list[ControlItem] = Field(max_length=LIST_CAP)
    hints: list[Localized] = Field(max_length=20)


# ---------------------------------------------------------------------------------------------------------- рубрики


class RubricBand(_Model):
    score: Literal[0, 1, 2, 3]
    descriptor: Localized


class RubricCriterion(_Model):
    code: RubricCode
    title: Localized
    weight: float
    bands: list[RubricBand] = Field(max_length=10)


class RubricPassRule(_Model):
    min_weighted: Annotated[float, Field(ge=0, le=3)]
    min_per_criterion: Literal[0, 1, 2]


class RubricPayload(_Model):
    rubric_id: Id
    title: Localized
    applies_to: list[Literal["lesson", "scenario", "media_exercise"]] = Field(max_length=3)
    criteria: list[RubricCriterion] = Field(max_length=10)
    pass_rule: RubricPassRule


# --------------------------------------------------------------------------------------------------------- сценарии


class ScenarioCharacter(_Model):
    id: Id
    name: Annotated[Text, Field(min_length=1, max_length=60)]
    role: Localized
    voice: Literal["en-GB", "en-US"]


class ScenarioTransition(_Model):
    intent: Annotated[str, Field(pattern=INTENT_PATTERN)]
    description: Localized
    examples_en: list[Annotated[Text, Field(max_length=200)]] = Field(max_length=10)
    to: Annotated[str, Field(max_length=64)]


class ScenarioEnd(_Model):
    outcome: Outcome
    summary: Localized


class ScenarioNode(_Model):
    speaker: Annotated[str, Field(max_length=64)]
    line_en: Annotated[Text, Field(max_length=240)]
    gloss: Localized
    hint: Localized | None
    recovery_point: bool
    event: Annotated[str, Field(pattern=INTENT_PATTERN)] | None
    transitions: list[ScenarioTransition] = Field(max_length=10)
    end: ScenarioEnd | None


class ScenarioCompletion(_Model):
    criteria: Localized


class ScenarioPayload(_Model):
    scenario_id: Id
    title: Localized
    task: Localized
    goals: list[GoalCode] = Field(max_length=6)
    topics: list[TopicCode] = Field(max_length=12)
    level: Band
    difficulty: Literal[1, 2, 3, 4, 5]
    audience: list[AudienceSegment] = Field(max_length=3)
    access: Literal["free"]
    characters: list[ScenarioCharacter] = Field(max_length=10)
    start_node: Annotated[str, Field(max_length=64)]
    nodes: dict[Id, ScenarioNode] = Field(max_length=60)
    completion: ScenarioCompletion
    skill_ids: list[Id] = Field(max_length=LIST_CAP)
    rubric_id: Id


class ScenarioIssue(_Model):
    code: ScenarioIssueCode
    node_id: str | None
    detail: str


class ScenarioEnds(_Model):
    success: NonNeg
    alt_success: NonNeg
    fail: NonNeg


class ScenarioStats(_Model):
    nodes: NonNeg
    ends: ScenarioEnds
    max_depth: NonNeg
    paths_to_success: NonNeg


class ScenarioTestRun(_Model):
    ok: bool
    checked_at: str
    issues: list[ScenarioIssue]
    stats: ScenarioStats


# ------------------------------------------------------------------------------------------------------------ медиа


class MediaRights(_Model):
    owner: Annotated[Text, Field(max_length=200)]
    license_type: LicenseType
    license_ref: Annotated[Text, Field(max_length=500)] | None
    attribution: Annotated[Text, Field(max_length=500)] | None
    territories: list[Annotated[str, Field(pattern=TERRITORY_PATTERN)]] = Field(max_length=250)
    valid_from: IsoDate
    valid_to: IsoDate | None
    allowed_uses: list[MediaUse] = Field(max_length=5)


class TranscriptLine(_Model):
    t_start_ms: NonNeg
    t_end_ms: NonNeg
    speaker: Annotated[Text, Field(max_length=60)]
    text_en: Annotated[Text, Field(max_length=240)]
    gloss: Localized


class MediaPhrase(_Model):
    en: Annotated[Text, Field(max_length=120)]
    gloss: Localized
    t_ms: NonNeg


class MediaEmbed(_Model):
    provider: Literal["youtube"]
    video_id: Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{6,20}$")]
    start_s: NonNeg
    end_s: NonNeg


class MediaPayload(_Model):
    asset_id: Id
    type: MediaType
    origin: MediaOrigin
    title: Localized
    original_title: Annotated[Text, Field(max_length=200)] | None
    language: Annotated[str, Field(pattern=LANG_PATTERN)]
    level: Band
    topics: list[TopicCode] = Field(max_length=12)
    skill_ids: list[Id] = Field(max_length=LIST_CAP)
    audience: list[AudienceSegment] = Field(max_length=3)
    duration_s: Annotated[int, Field(ge=0, le=3600)]
    transcript: list[TranscriptLine] = Field(max_length=200)
    phrases: list[MediaPhrase] = Field(max_length=LIST_CAP)
    audio_blob_id: Annotated[str, Field(pattern=r"^[0-9a-f-]{36}$")] | None
    embed: MediaEmbed | None
    rights: MediaRights


class MediaExercisePayload(_Model):
    exercise_id: Id
    asset_id: Id
    type: MediaExerciseType
    skill_id: Id
    level: Band
    instruction: Localized
    prompt_en: Annotated[Text, Field(max_length=300)] | None
    options: list[Annotated[Text, Field(max_length=240)]] = Field(max_length=20)
    answer: (Annotated[int, Field(ge=0)] | list[Annotated[int, Field(ge=0)]]
             | list[Annotated[Text, Field(max_length=200)]] | None)
    line_index: NonNeg | None
    rubric_id: Id | None


# ---------------------------------------------------------------------------------- спринт 5: тексты для чтения


class ReadingSentence(_Model):
    s_id: Annotated[str, Field(pattern=SENTENCE_ID_PATTERN)]
    text_en: Annotated[Text, Field(max_length=240)]
    gloss: Localized


class ReadingParagraph(_Model):
    p_id: Annotated[str, Field(pattern=PARAGRAPH_ID_PATTERN)]
    sentences: list[ReadingSentence] = Field(max_length=20)


class ReadingQuestion(_Model):
    question_id: Id
    type: ReadingQuestionType
    instruction: Localized
    prompt_en: Annotated[Text, Field(max_length=200)]
    options: list[Annotated[Text, Field(max_length=200)]] = Field(max_length=8)
    answer: Annotated[int, Field(ge=0)] | list[Annotated[Text, Field(max_length=200)]]


class ReadingGlossaryItem(_Model):
    en: Annotated[Text, Field(max_length=60)]
    gloss: Localized
    note: Localized | None


class ReadingPayload(_Model):
    reading_id: Id
    title: Localized
    level: Band
    audience: list[AudienceSegment] = Field(max_length=3)
    topics: list[TopicCode] = Field(max_length=12)
    skill_ids: list[Id] = Field(max_length=10)
    paragraphs: list[ReadingParagraph] = Field(max_length=20)
    glossary: list[ReadingGlossaryItem] = Field(max_length=LIST_CAP)
    questions: list[ReadingQuestion] = Field(max_length=20)
    voice: Literal["en-GB", "en-US"]
    est_minutes: Annotated[int, Field(ge=0, le=120)]


# ------------------------------------------------------------------------ спринт 5: словарь курса (не версия)


class GlossaryRef(_Model):
    kind: GlossaryRefKind
    key: Id
    version: Annotated[int, Field(ge=1)]


class GlossaryOverride(_Model):
    gloss: Localized
    example_en: Annotated[Text, Field(max_length=200)] | None
    by: Annotated[str, Field(max_length=64)]
    at: str


class GlossaryEntry(_Model):
    """Статья словаря курса — форма ответа (строится сервисом, см. domain/glossary.py); не тело версии контента."""

    entry_id: str
    pair_id: str
    lemma: Annotated[Text, Field(max_length=60)]
    forms: list[Annotated[str, Field(max_length=120)]] = Field(min_length=1, max_length=8)
    part_of_speech: PartOfSpeech | None
    gloss: Localized
    example_en: Annotated[Text, Field(max_length=200)] | None
    source: GlossarySource
    review_status: GlossaryReviewStatus
    confidence: float | None
    agent_version: Annotated[str, Field(max_length=64)] | None
    refs: list[GlossaryRef] = Field(max_length=LIST_CAP)
    override: GlossaryOverride | None
    corrected: bool
    archived_at: str | None
    updated_by: str | None
    updated_at: str


# --------------------------------------------------------------------------------------------- вид → модель и ключ

PAYLOAD_MODELS: Final[dict[str, type[BaseModel]]] = {
    "course": CoursePayload,
    "skill": SkillPayload,
    "module": ModulePayload,
    "lesson": LessonPayload,
    "rubric": RubricPayload,
    "scenario": ScenarioPayload,
    "media_asset": MediaPayload,
    "media_exercise": MediaExercisePayload,
    "reading": ReadingPayload,
}

KEY_FIELDS: Final[dict[str, str]] = {
    "course": "course_id",
    "skill": "skill_id",
    "module": "module_id",
    "lesson": "lesson_id",
    "rubric": "rubric_id",
    "scenario": "scenario_id",
    "media_asset": "asset_id",
    "media_exercise": "exercise_id",
    "reading": "reading_id",
}


def payload_title(kind: str, payload: dict[str, Any]) -> dict[str, str]:
    """Заголовок строки списка: у упражнения к медиа заголовка нет — берётся инструкция."""
    raw = payload.get("instruction") if kind == "media_exercise" else payload.get("title")
    if isinstance(raw, dict):
        return {"ru": str(raw.get("ru", "")), "uz": str(raw.get("uz", ""))}
    return {"ru": "", "uz": ""}


def payload_level(kind: str, payload: dict[str, Any]) -> str | None:
    value = payload.get("level_start") if kind == "course" else payload.get("level")
    return value if isinstance(value, str) and value in BANDS else None


def band_rank(band: str | None) -> int:
    return BANDS.index(band) if band in BANDS else len(BANDS)
