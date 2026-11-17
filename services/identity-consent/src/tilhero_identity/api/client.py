"""Внутренний API для telegram-bff: профиль, настройки, безопасность, согласие, отключение, удаление."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query

from tilhero_common.internal_auth import Principal
from tilhero_identity.api.deps import current_user_id, get_service, telegram_bff
from tilhero_identity.domain.locale import locale_from_language_code
from tilhero_identity.domain.policy import get_policy
from tilhero_identity.schemas import (
    BiometricEnableResponse,
    BiometricVerifyRequest,
    ConsentRequest,
    ConsentState,
    DeletionRequestIn,
    DeletionResponse,
    LoginResponse,
    MeResponse,
    OkResponse,
    PinRemoveRequest,
    PinResetConfirmRequest,
    PinResetRequestResponse,
    PinSetRequest,
    PinVerifyRequest,
    PolicyDocument,
    PolicyPurposeOut,
    SecurityState,
    SettingsPatch,
    TelegramLoginRequest,
)
from tilhero_identity.service import IdentityService

router = APIRouter(prefix="/internal/v1", tags=["internal"])

Me = Depends(current_user_id)
Svc = Depends(get_service)


# ---------- профиль ----------

@router.post("/users/telegram-login", response_model=LoginResponse)
async def telegram_login(
    body: TelegramLoginRequest, _: Principal = Depends(telegram_bff), svc: IdentityService = Svc
) -> LoginResponse:
    return await svc.telegram_login(body)


@router.get("/me", response_model=MeResponse)
async def get_me(user_id: uuid.UUID = Me, svc: IdentityService = Svc) -> MeResponse:
    return await svc.me(user_id)


@router.patch("/me/settings", response_model=MeResponse)
async def patch_settings(
    body: SettingsPatch, user_id: uuid.UUID = Me, svc: IdentityService = Svc
) -> MeResponse:
    return await svc.patch_settings(user_id, body)


@router.post("/me/disable", response_model=MeResponse)
async def disable(user_id: uuid.UUID = Me, svc: IdentityService = Svc) -> MeResponse:
    return await svc.set_status(user_id, "DISABLED")


@router.post("/me/enable", response_model=MeResponse)
async def enable(user_id: uuid.UUID = Me, svc: IdentityService = Svc) -> MeResponse:
    return await svc.set_status(user_id, "ACTIVE")


@router.post("/me/deletion-request", response_model=DeletionResponse, status_code=202)
async def deletion_request(
    body: DeletionRequestIn, user_id: uuid.UUID = Me, svc: IdentityService = Svc
) -> DeletionResponse:
    return await svc.request_deletion(user_id, body)


# ---------- PIN ----------

@router.put("/me/pin", response_model=SecurityState)
async def set_pin(body: PinSetRequest, user_id: uuid.UUID = Me, svc: IdentityService = Svc) -> SecurityState:
    return await svc.set_pin(user_id, body)


@router.delete("/me/pin", response_model=SecurityState)
async def remove_pin(
    body: PinRemoveRequest, user_id: uuid.UUID = Me, svc: IdentityService = Svc
) -> SecurityState:
    return await svc.remove_pin(user_id, body.current_pin)


@router.post("/me/pin/verify", response_model=OkResponse)
async def verify_pin(
    body: PinVerifyRequest, user_id: uuid.UUID = Me, svc: IdentityService = Svc
) -> OkResponse:
    await svc.verify_pin(user_id, body.pin)
    return OkResponse()


@router.post("/me/pin/reset-request", response_model=PinResetRequestResponse)
async def pin_reset_request(user_id: uuid.UUID = Me, svc: IdentityService = Svc) -> PinResetRequestResponse:
    return PinResetRequestResponse(expires_in=await svc.request_pin_reset(user_id))


@router.post("/me/pin/reset-confirm", response_model=SecurityState)
async def pin_reset_confirm(
    body: PinResetConfirmRequest, user_id: uuid.UUID = Me, svc: IdentityService = Svc
) -> SecurityState:
    return await svc.confirm_pin_reset(user_id, body.code, body.new_pin)


# ---------- биометрия ----------

@router.put("/me/biometric", response_model=BiometricEnableResponse)
async def enable_biometric(user_id: uuid.UUID = Me, svc: IdentityService = Svc) -> BiometricEnableResponse:
    return await svc.enable_biometric(user_id)


@router.delete("/me/biometric", response_model=SecurityState)
async def disable_biometric(user_id: uuid.UUID = Me, svc: IdentityService = Svc) -> SecurityState:
    return await svc.disable_biometric(user_id)


@router.post("/me/biometric/verify", response_model=OkResponse)
async def verify_biometric(
    body: BiometricVerifyRequest, user_id: uuid.UUID = Me, svc: IdentityService = Svc
) -> OkResponse:
    await svc.verify_biometric(user_id, body.biometric_token)
    return OkResponse()


# ---------- политика и согласие ----------

@router.get("/legal/policy", response_model=PolicyDocument)
async def legal_policy(
    lang: str = Query(default="ru", max_length=16, pattern=r"^[A-Za-z]{2,3}([-_][A-Za-z0-9]{1,8})*$"),
    _: Principal = Depends(telegram_bff),
    svc: IdentityService = Svc,
) -> PolicyDocument:
    locale = locale_from_language_code(lang)
    policy = get_policy(svc.settings.current_policy_version)
    return PolicyDocument(
        version=policy.version,
        purposes=[
            PolicyPurposeOut(
                code=p.code, required=p.required, title=p.title[locale], description=p.description[locale]
            )
            for p in policy.purposes
        ],
        text=policy.text[locale],
    )


@router.post("/me/consent", response_model=ConsentState)
async def accept_consent(
    body: ConsentRequest, user_id: uuid.UUID = Me, svc: IdentityService = Svc
) -> ConsentState:
    return await svc.accept_consent(user_id, body)


@router.delete("/me/consent", response_model=ConsentState)
async def revoke_consent(user_id: uuid.UUID = Me, svc: IdentityService = Svc) -> ConsentState:
    return await svc.revoke_consent(user_id)
