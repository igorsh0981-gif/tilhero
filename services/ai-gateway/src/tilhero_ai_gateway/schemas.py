"""Pydantic-модели входа admin API ai-gateway (extra="forbid"). Формы — admin.ts «ИИ, контроль диалогов, затраты»."""

from __future__ import annotations

from typing import Annotated, Any

from pydantic import AfterValidator, BaseModel, BeforeValidator, ConfigDict, Field

from tilhero_ai_gateway.contracts import CONTROL_RE

_IN = ConfigDict(extra="forbid")


def _strip(value: object) -> object:
    return value.strip() if isinstance(value, str) else value


def _plain(value: str) -> str:
    if CONTROL_RE.search(value):
        raise ValueError("недопустимые символы")
    return value


Plain = Annotated[str, BeforeValidator(_strip), AfterValidator(_plain)]
Reason = Annotated[Plain, Field(min_length=3, max_length=500)]
Money = Annotated[float, Field(ge=0)]


class NewVersionIn(BaseModel):
    model_config = _IN
    from_version: int | None = Field(default=None, ge=1)


class ReasonIn(BaseModel):
    model_config = _IN
    reason: Reason


class CanaryIn(BaseModel):
    model_config = _IN
    version: int = Field(ge=1)
    percent: int = Field(ge=1, le=50)
    reason: Reason


class GoldenCaseIn(BaseModel):
    """GoldenCaseInput (admin.ts)."""

    model_config = _IN
    title: Annotated[Plain, Field(min_length=1, max_length=200)]
    input: dict[str, Any]
    checks: list[Any] = Field(min_length=1, max_length=50)
    mandatory: bool


class GoldenCasePatch(BaseModel):
    model_config = _IN
    title: Annotated[Plain, Field(min_length=1, max_length=200)] | None = None
    input: dict[str, Any] | None = None
    checks: list[Any] | None = Field(default=None, min_length=1, max_length=50)
    mandatory: bool | None = None


class ModelUpdateIn(BaseModel):
    """PUT /admin/v1/ai/models/{model_id}: цены токенов (LLM) и, для модели речи, цена часа аудио (спринт 5,
    ai.ts AiModel.audio_usd_per_hour; у речи цены токенов — 0; не передана — прежняя)."""

    model_config = _IN
    input_usd_per_mtok: float = Field(ge=0, le=1000)
    output_usd_per_mtok: float = Field(ge=0, le=1000)
    audio_usd_per_hour: float | None = Field(default=None, ge=0, le=1000)
    active: bool
    reason: Reason


class BudgetIn(BaseModel):
    """AiBudget-поля & {reason}: ai_enabled и updated_at — необязательны (updated_at — защита от гонки правок)."""

    model_config = _IN
    monthly_cap_usd: float = Field(ge=0, le=100_000)
    learner_daily_cap_usd: float = Field(ge=0, le=1000)
    lesson_cap_usd: float = Field(ge=0, le=1000)
    alert_percent: int = Field(ge=1, le=100)
    ai_enabled: bool | None = None
    updated_at: str | None = Field(default=None, max_length=40)
    reason: Reason


class EmergencyStopIn(BaseModel):
    """enabled=true — аварийная остановка включена (ИИ выключен), false — снята."""

    model_config = _IN
    enabled: bool
    reason: Reason
