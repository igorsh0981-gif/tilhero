"""Строгая схема payload версии конфигурации.

miniapp — форма ExperienceConfig из packages/contracts/src/bff.ts без app/version (их добавляет сервис):
  theme {id: notebook | notebook_dark, version, tokens}, home {sections[]}, flags {name: bool}.
admin — форма для админки TilHero (прототип Admin.dc.html: тема, плотность, порядок и видимость разделов меню, флаги);
контракт admin-bff появится в спринте 2, форма расширяема новой версией схемы.

Любое отклонение → ConfigInvalid(path, reason) → 422 EXPERIENCE_CONFIG_INVALID {path, reason, errors}.
"""

from __future__ import annotations

import hashlib
import json
from typing import Annotated, Any, Final, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError

from tilhero_experience.domain.tokens import ADMIN_TOKENS, MINIAPP_TOKENS, TokenError, TokenSpec, validate_token

App = Literal["miniapp", "admin"]
APPS: Final[tuple[str, ...]] = ("miniapp", "admin")
SEMVER = r"^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$"
MAX_PAYLOAD_BYTES = 32 * 1024
MAX_ERRORS = 20

# bff.ts HomeSectionType: план на сегодня, урок дня, повторение, «Что нового», семья, новости
SECTION_TYPES: Final[tuple[str, ...]] = ("today_plan", "lesson_of_day", "review", "whats_new", "family", "news")
SectionType = Literal["today_plan", "lesson_of_day", "review", "whats_new", "family", "news"]
FlagName = Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_]{0,63}$")]
TokenName = Annotated[str, StringConstraints(max_length=64)]
# Разделы меню админки TilHero (прототип Admin.dc.html, NAV) — порядок и видимость; права проверяет admin-bff
# Спринт 5: + memory («Память»). Действующая версия 1.0.0 его не перечисляет — admin-web добавляет раздел после
# перечисленных; в новой версии конфигурации его можно поставить на место или выключить.
# Спринт 6 (INTERNAL_API спринта 6 §8): раздел «Игра» — heroes («Герои»), game («Геймификация»: правила, магазин,
# кошельки) и game_events («События и сезоны»). heroes и game были в прототипе; game_events — новый id раздела событий,
# events — его прежний id из прототипа (сид 1.0.0): admin-web понимает оба (MENU_ALIASES), в одной версии — только
# один из них (иначе раздел дважды → duplicate).
ADMIN_MENU: Final[tuple[str, ...]] = (
    "overview", "users", "content", "agents", "qa", "costs", "heroes", "game", "events", "news", "support", "config",
    "langs", "roles", "audit", "memory", "game_events",
)
# id прототипа → id раздела (для проверки дублей)
MENU_ALIASES: Final[dict[str, str]] = {"events": "game_events"}
_STRICT = ConfigDict(extra="forbid", strict=True)


class Theme(BaseModel):
    model_config = _STRICT

    id: str  # уточняется в теме приложения
    version: str = Field(pattern=SEMVER)
    tokens: dict[TokenName, str] = Field(max_length=60)


class MiniAppTheme(Theme):
    # Темы — CSS-слои Mini App (визуальный язык «Тетрадь»: светлая и тёмная); новая тема требует кода.
    id: Literal["notebook", "notebook_dark"]


class AdminTheme(Theme):
    id: Literal["admin_light"]


class Section(BaseModel):
    model_config = _STRICT

    type: SectionType
    key: str = Field(pattern=r"^[a-z][a-z0-9_]{1,31}$")
    variant: Literal["large", "compact"]
    enabled: bool


class Home(BaseModel):
    model_config = _STRICT

    sections: list[Section] = Field(min_length=1, max_length=len(SECTION_TYPES))


class MiniAppPayload(BaseModel):
    model_config = _STRICT

    theme: MiniAppTheme
    home: Home
    flags: dict[FlagName, bool] = Field(max_length=50)


class AdminMenuItem(BaseModel):
    model_config = _STRICT

    id: Literal[ADMIN_MENU]  # type: ignore[valid-type]
    enabled: bool


class AdminLayout(BaseModel):
    model_config = _STRICT

    density: Literal["compact", "comfortable"]
    menu: list[AdminMenuItem] = Field(min_length=1, max_length=len(ADMIN_MENU))


class AdminPayload(BaseModel):
    model_config = _STRICT

    theme: AdminTheme
    layout: AdminLayout
    flags: dict[FlagName, bool] = Field(max_length=50)


_MODELS: Final[dict[str, type[BaseModel]]] = {"miniapp": MiniAppPayload, "admin": AdminPayload}
_TOKENS: Final[dict[str, dict[str, TokenSpec]]] = {"miniapp": MINIAPP_TOKENS, "admin": ADMIN_TOKENS}


class ConfigInvalid(Exception):
    def __init__(self, errors: list[dict[str, str]]) -> None:
        super().__init__(errors[0]["path"] if errors else "payload")
        self.errors = errors[:MAX_ERRORS]

    @property
    def path(self) -> str:
        return self.errors[0]["path"]

    @property
    def reason(self) -> str:
        return self.errors[0]["reason"]


_REASONS = {
    "missing": "required",
    "extra_forbidden": "unknown_field",
    "literal_error": "not_allowed",
    "string_pattern_mismatch": "invalid_format",
    "greater_than_equal": "out_of_range",
    "less_than_equal": "out_of_range",
    "too_long": "too_many",
    "too_short": "too_few",
    "string_too_long": "too_long",
}


def _path(loc: tuple[Any, ...], root: str = "payload") -> str:
    out = root
    for part in loc:
        if isinstance(part, int):
            out += f"[{part}]"
        elif part == "[key]":
            continue
        else:
            out += f".{part}"
    return out


def _reason(etype: str) -> str:
    if etype in _REASONS:
        return _REASONS[etype]
    if etype.endswith("_type") or etype.endswith("_parsing"):
        return "invalid_type"
    return "invalid"


def canonical(payload: dict[str, Any]) -> str:
    return json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def checksum(payload: dict[str, Any]) -> str:
    return hashlib.sha256(canonical(payload).encode("utf-8")).hexdigest()


def _duplicates(values: list[str], path: str) -> list[dict[str, str]]:
    seen: set[str] = set()
    errors: list[dict[str, str]] = []
    for i, value in enumerate(values):
        if value in seen:
            errors.append({"path": path.format(i=i), "reason": "duplicate"})
        seen.add(value)
    return errors


def validate_payload(app: str, raw: Any) -> dict[str, Any]:
    """Нормализованный payload (model_dump) или ConfigInvalid со всеми найденными ошибками."""
    if not isinstance(raw, dict):
        raise ConfigInvalid([{"path": "payload", "reason": "invalid_type"}])
    if len(canonical(raw).encode("utf-8")) > MAX_PAYLOAD_BYTES:
        raise ConfigInvalid([{"path": "payload", "reason": "too_large"}])
    try:
        model = _MODELS[app].model_validate(raw)
    except ValidationError as exc:
        raise ConfigInvalid([{"path": _path(tuple(e["loc"])), "reason": _reason(e["type"])}
                             for e in exc.errors()]) from None

    errors: list[dict[str, str]] = []
    whitelist = _TOKENS[app]
    for name, value in model.theme.tokens.items():  # type: ignore[attr-defined]
        try:
            validate_token(name, value, whitelist)
        except TokenError as exc:
            errors.append({"path": f"payload.theme.tokens.{name}", "reason": exc.reason})
    if isinstance(model, MiniAppPayload):
        # одна секция каждого типа: Mini App рисует план, урок дня, повторение… по одному разу
        errors += _duplicates([s.type for s in model.home.sections], "payload.home.sections[{i}].type")
        errors += _duplicates([s.key for s in model.home.sections], "payload.home.sections[{i}].key")
    elif isinstance(model, AdminPayload):
        # один раздел — один пункт: id прототипа (events) и новый id (game_events) — тот же раздел
        errors += _duplicates([MENU_ALIASES.get(m.id, m.id) for m in model.layout.menu],
                              "payload.layout.menu[{i}].id")
    if errors:
        raise ConfigInvalid(errors)
    return model.model_dump(mode="json")
