"""Admin API языков и пар (admin.ts «Языки и пары»): чтение — content.read; правка — lang.manage (step-up в
admin-bff). Новый язык или пара — PUT по новому коду (upsert), без изменения кода (ADM-LANG-01/02)."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from tilhero_catalog.api.common import staff_auth
from tilhero_catalog.content import Language, LanguagePair
from tilhero_catalog.domain import languages
from tilhero_catalog.domain.common import CONTENT_READ, LANG_MANAGE
from tilhero_catalog.schemas import PairPutIn
from tilhero_common.app import Runtime, get_runtime
from tilhero_common.internal_auth import Principal

router = APIRouter(prefix="/admin/v1", tags=["staff"])


@router.get("/languages")
async def list_languages(principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)) -> dict:
    principal.require_permission(CONTENT_READ)
    async with rt.transaction() as session:
        return {"items": await languages.list_languages(session)}


@router.put("/languages/{code}", responses={422: {"description": "LANGUAGE_CODE_MISMATCH"}})
async def put_language(code: str, body: Language, principal: Principal = Depends(staff_auth),
                       rt: Runtime = Depends(get_runtime)) -> dict:
    actor = principal.require_permission(LANG_MANAGE)
    async with rt.transaction() as session:
        return await languages.put_language(session, code, body, actor)


@router.get("/language-pairs")
async def list_pairs(principal: Principal = Depends(staff_auth), rt: Runtime = Depends(get_runtime)) -> dict:
    """{items: PairCard[]}: готовность по опубликованному контенту курса пары (learners и тест диагностики
    дополняет admin-bff из diagnostics)."""
    principal.require_permission(CONTENT_READ)
    async with rt.transaction() as session:
        return {"items": await languages.pair_cards(session)}


@router.put("/language-pairs/{pair_id}",
            responses={422: {"description": "PAIR_NOT_READY {missing} | UNKNOWN_LANGUAGE | PAIR_INVALID"}})
async def put_pair(pair_id: str, body: PairPutIn, principal: Principal = Depends(staff_auth),
                   rt: Runtime = Depends(get_runtime)) -> dict:
    actor = principal.require_permission(LANG_MANAGE)
    pair = body.model_dump(exclude={"reason"})
    async with rt.transaction() as session:
        return await languages.put_pair(session, pair_id, LanguagePair.model_validate(pair), body.reason, actor)
