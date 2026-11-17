"""Строгая схема payload версии конфигурации.

miniapp — форма ExperienceConfig из packages/contracts/src/bff.ts без app/version (их добавляет сервис):
  theme {id, version, tokens}, home {welcome_mode, sections[]}, flags {name: bool}, hotel_rating_min.
admin — форма для Admin UI (ТЗ Admin §7: токены темы, порядок/видимость виджетов дашборда, пресеты колонок,
флаги); контракт admin-bff появится в спринте 2, форма расширяема новой версией схемы.

Любое отклонение → ConfigInvalid(path, reason) → 422 EXPERIENCE_CONFIG_INVALID {path, reason, errors}.
"""

from __future__ import annotations

import hashlib
import json
from typing import Annotated, Any, Final, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError

from tilhero_experience.domain.tokens import (
    ADMIN_TOKENS,
    MINIAPP_TOKENS,
    TokenError,
    TokenSpec,
    validate_token,
)

App = Literal["miniapp", "admin"]
APPS: Final[tuple[str, ...]] = ("miniapp", "admin")
SEMVER = r"^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$"
MAX_PAYLOAD_BYTES = 32 * 1024
MAX_ERRORS = 20

SectionType = Literal["event_carousel", "watch_changes", "news_carousel", "ai_summary", "catalog_link"]
FlagName = Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_]{0,63}$")]
TokenName = Annotated[str, StringConstraints(max_length=64)]
DASHBOARD_WIDGETS: Final[tuple[str, ...]] = (
    "kpi_users", "kpi_ai", "kpi_support", "kpi_system", "kpi_commerce", "budget", "hourly", "cost_agents",
    "dau", "agents_table",
)
_STRICT = ConfigDict(extra="forbid", strict=True)


class Theme(BaseModel):
    model_config = _STRICT

    id: str  # уточняется в теме приложения
    version: str = Field(pattern=SEMVER)
    tokens: dict[TokenName, str] = Field(max_length=150)


class MiniAppTheme(Theme):
    # Базовые темы — CSS-файлы Mini App (ТЗ UI/CSS §2: themes/default.css, bank.css); новая тема требует кода.
    id: Literal["default", "bank"]


class AdminTheme(Theme):
    id: Literal["default", "high_contrast"]  # варианты темы прототипа Admin


class Section(BaseModel):
    model_config = _STRICT

    type: SectionType
    key: str = Field(pattern=r"^[a-z][a-z0-9_]{1,31}$")
    variant: Literal["large", "compact"]
    enabled: bool


class Home(BaseModel):
    model_config = _STRICT

    welcome_mode: Literal["first_visit_only", "always", "never"]
    sections: list[Section] = Field(min_length=1, max_length=20)


class MiniAppPayload(BaseModel):
    model_config = _STRICT

    theme: MiniAppTheme
    home: Home
    flags: dict[FlagName, bool] = Field(max_length=50)
    hotel_rating_min: float = Field(ge=7.0, le=10.0)


class AdminWidget(BaseModel):
    model_config = _STRICT

    id: Literal[DASHBOARD_WIDGETS]  # type: ignore[valid-type]
    enabled: bool


class AdminTablePresets(BaseModel):
    model_config = _STRICT

    users: Literal["support", "analytics"]
    audit: Literal["security", "full"]


class AdminLayout(BaseModel):
    model_config = _STRICT

    density: Literal["compact", "comfortable"]
    table_presets: AdminTablePresets
    dashboard_widgets: list[AdminWidget] = Field(min_length=1, max_length=len(DASHBOARD_WIDGETS))


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
        seen: set[str] = set()
        for i, section in enumerate(model.home.sections):
            if section.key in seen:
                errors.append({"path": f"payload.home.sections[{i}].key", "reason": "duplicate"})
            seen.add(section.key)
    elif isinstance(model, AdminPayload):
        seen_w: set[str] = set()
        for i, widget in enumerate(model.layout.dashboard_widgets):
            if widget.id in seen_w:
                errors.append({"path": f"payload.layout.dashboard_widgets[{i}].id", "reason": "duplicate"})
            seen_w.add(widget.id)
    if errors:
        raise ConfigInvalid(errors)
    return model.model_dump(mode="json")
