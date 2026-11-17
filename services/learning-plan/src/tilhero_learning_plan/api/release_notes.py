"""«Что нового» (доработка 9.4): отметка последней просмотренной заметки о релизе.

Вызывает только telegram-bff; пользователь — только из `sub` внутреннего токена (чужую отметку не прочитать и не
изменить). Заметку и её время публикации BFF берёт из ленты experience-config, а не из запроса Mini App.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends
from pydantic import AwareDatetime, BaseModel, ConfigDict

from tilhero_common.app import Runtime, get_runtime
from tilhero_learning_plan.api.client import current_user
from tilhero_learning_plan.domain import profiles
from tilhero_learning_plan.models import PreferenceProfile
from tilhero_learning_plan.schemas import UtcDateTime

router = APIRouter(prefix="/internal/v1/me/release-notes", tags=["client"])


class SeenIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    release_note_id: uuid.UUID
    published_at: AwareDatetime


class SeenOut(BaseModel):
    release_note_id: uuid.UUID | None
    published_at: UtcDateTime | None
    onboarding_completed_at: UtcDateTime | None


def _out(p: PreferenceProfile) -> SeenOut:
    return SeenOut(release_note_id=p.last_seen_release_note_id, published_at=p.last_seen_release_note_at,
                   onboarding_completed_at=p.onboarding_completed_at)


@router.get("/seen", response_model=SeenOut)
async def get_seen(user_id: uuid.UUID = Depends(current_user), rt: Runtime = Depends(get_runtime)) -> SeenOut:
    async with rt.transaction() as session:
        return _out(await profiles.get_release_seen(session, user_id))


@router.put("/seen", response_model=SeenOut)
async def put_seen(body: SeenIn, user_id: uuid.UUID = Depends(current_user),
                   rt: Runtime = Depends(get_runtime)) -> SeenOut:
    async with rt.transaction() as session:
        return _out(await profiles.mark_release_seen(session, user_id, body.release_note_id, body.published_at))
