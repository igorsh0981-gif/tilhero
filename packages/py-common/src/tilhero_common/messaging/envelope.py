"""Конверт интеграционного события (ТЗ «API, Events, Support» §5)."""

from __future__ import annotations

import re
import uuid
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from tilhero_common import context

EVENT_TYPE_RE = re.compile(r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+\.v[0-9]+$")
SUBJECT_PREFIX = "tilhero"


class Envelope(BaseModel):
    model_config = ConfigDict(frozen=True)

    event_id: str
    event_type: str
    occurred_at: datetime
    producer: str
    correlation_id: str
    causation_id: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)

    @field_validator("event_type")
    @classmethod
    def _event_type(cls, v: str) -> str:
        if not EVENT_TYPE_RE.match(v):
            raise ValueError(f"invalid event_type: {v}")
        return v

    @property
    def subject(self) -> str:
        return subject_for(self.event_type)

    def to_json(self) -> str:
        return self.model_dump_json()


def subject_for(event_type: str) -> str:
    return f"{SUBJECT_PREFIX}.{event_type}"


def make_envelope(
    event_type: str,
    payload: dict[str, Any],
    *,
    producer: str,
    causation_id: str | None = None,
    correlation_id: str | None = None,
) -> Envelope:
    return Envelope(
        event_id=str(uuid.uuid4()),
        event_type=event_type,
        occurred_at=datetime.now(UTC),
        producer=producer,
        correlation_id=correlation_id or context.get_correlation_id(),
        causation_id=causation_id if causation_id is not None else context.causation_id_var.get(),
        payload=payload,
    )
