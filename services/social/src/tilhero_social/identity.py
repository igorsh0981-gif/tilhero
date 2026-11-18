"""Клиент identity-consent: `GET /internal/v1/users/{id}/public` → {user_id, display_name, kind, age_band, status,
guardian_consent, consent_accepted, purposes} (INTERNAL_API §1, §10, §11 P-3).

Имя — только для ответа (не хранится и не логируется). `guardian_consent` (14–17): если его нет в ответе — из
проекции profiles (user.profile.updated.v1). `consent_accepted` (действующее согласие с terms и privacy; у ребёнка —
согласие родителя) и `purposes` (цели действующего согласия): если полей нет в ответе (identity-consent старой
версии) — согласия нет (fail closed): приглашения недоступны, пока identity-consent не обновлён.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Iterable
from dataclasses import dataclass, field

from pydantic import BaseModel, ConfigDict

from tilhero_common.app import Runtime
from tilhero_common.errors import unavailable
from tilhero_common.http_client import UpstreamError

IDENTITY = "identity-consent"


class PublicProfile(BaseModel):
    model_config = ConfigDict(extra="ignore")

    user_id: str
    display_name: str = ""
    kind: str | None = None
    age_band: str | None = None
    status: str | None = None
    guardian_consent: str | None = None
    # нет в ответе (старая версия identity-consent) — None: согласия нет (fail closed)
    consent_accepted: bool | None = None
    purposes: list[str] | None = None


@dataclass(frozen=True)
class Person:
    """Что social знает о человеке для правил: вид профиля, возраст, статус, согласие родителя, согласие с политикой
    (`consent_accepted`) и его цели (`purposes`)."""

    user_id: uuid.UUID
    display_name: str
    kind: str | None
    age_band: str | None
    status: str | None
    guardian_consent: str | None
    consent_accepted: bool = False
    purposes: frozenset[str] = field(default_factory=frozenset)


class IdentityGateway:
    def __init__(self, runtime: Runtime) -> None:
        self.runtime = runtime

    async def public(self, user_id: uuid.UUID) -> PublicProfile | None:
        """None — пользователь не найден или удалён (404). Иначе ошибка → 503 UPSTREAM_UNAVAILABLE."""
        try:
            data = await self.runtime.client(IDENTITY).get(f"/internal/v1/users/{user_id}/public")
        except UpstreamError as exc:
            if exc.status == 404:
                return None
            # 5xx, разрыв, открытый breaker, а также 401/403 (ошибка ключей) — для вызывающего это недоступность
            # зависимости, а не его ошибка: код identity-consent наружу не пробрасываем
            raise unavailable("UPSTREAM_UNAVAILABLE", "Сервис профилей временно недоступен",
                              {"service": IDENTITY}) from exc
        return PublicProfile.model_validate(data)

    async def names(self, user_ids: Iterable[uuid.UUID]) -> dict[uuid.UUID, str | None]:
        ids = list(dict.fromkeys(user_ids))
        found = await asyncio.gather(*(self.public(u) for u in ids))
        return {u: (p.display_name if p is not None else None) for u, p in zip(ids, found, strict=True)}
