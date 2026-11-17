"""Внутренний API для telegram-bff (INTERNAL_API §1): аккаунт, возраст, ученики (дети), согласие родителя 14–17,
настройки, код родителя, биометрия, политика и согласие, отключение, удаление. `sub` — аккаунт Telegram."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Path, Query

from tilhero_common.internal_auth import Principal
from tilhero_identity.api.deps import current_user_id, get_service, idempotency_key, telegram_bff
from tilhero_identity.domain.locale import locale_from_language_code
from tilhero_identity.domain.policy import get_policy
from tilhero_identity.schemas import (
    AgeRequest,
    BiometricEnableResponse,
    BiometricVerifyRequest,
    ConsentRequest,
    ConsentState,
    CreateChildRequest,
    DeletionRequestIn,
    DeletionResponse,
    GuardianConsentPreview,
    GuardianConsentRequestOut,
    LearnerDetail,
    LearnerList,
    LearnerPatch,
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
IdemKey = Depends(idempotency_key)
# Токен ссылки родителя в пути: в access-лог пишется шаблон маршрута, не путь. Некорректный — 404 (как неизвестный).
Token = Path(min_length=1, max_length=128)


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


@router.put("/me/age", response_model=MeResponse)
async def set_age(body: AgeRequest, user_id: uuid.UUID = Me, svc: IdentityService = Svc) -> MeResponse:
    return await svc.set_age(user_id, body)


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


# ---------- ученики (сам аккаунт + детские профили 6–13) ----------

@router.get("/me/learners", response_model=LearnerList)
async def list_learners(user_id: uuid.UUID = Me, svc: IdentityService = Svc) -> LearnerList:
    return await svc.list_learners(user_id)


@router.post("/me/learners", response_model=LearnerDetail, status_code=201)
async def create_child(
    body: CreateChildRequest, user_id: uuid.UUID = Me, key: str | None = IdemKey, svc: IdentityService = Svc
) -> LearnerDetail:
    return await svc.create_child(user_id, body, key)


@router.get("/me/learners/{learner_id}", response_model=LearnerDetail)
async def get_learner(learner_id: uuid.UUID, user_id: uuid.UUID = Me, svc: IdentityService = Svc) -> LearnerDetail:
    return await svc.get_learner(user_id, learner_id)


@router.patch("/me/learners/{learner_id}", response_model=LearnerDetail)
async def patch_learner(
    learner_id: uuid.UUID, body: LearnerPatch, user_id: uuid.UUID = Me, svc: IdentityService = Svc
) -> LearnerDetail:
    return await svc.patch_learner(user_id, learner_id, body)


# ---------- согласие родителя для 14–17 ----------

@router.post("/me/guardian-consent-requests", response_model=GuardianConsentRequestOut)
async def create_guardian_consent_request(
    user_id: uuid.UUID = Me, key: str | None = IdemKey, svc: IdentityService = Svc
) -> GuardianConsentRequestOut:
    return await svc.create_guardian_consent_request(user_id, key)


@router.get("/guardian-consents/{token}", response_model=GuardianConsentPreview)
async def guardian_consent_preview(
    token: str = Token, _: Principal = Depends(telegram_bff), svc: IdentityService = Svc
) -> GuardianConsentPreview:
    return await svc.guardian_consent_preview(token)


@router.post("/guardian-consents/{token}/accept", response_model=GuardianConsentPreview)
async def guardian_consent_accept(
    token: str = Token, user_id: uuid.UUID = Me, svc: IdentityService = Svc
) -> GuardianConsentPreview:
    return await svc.decide_guardian_consent(token, user_id, accept=True)


@router.post("/guardian-consents/{token}/decline", response_model=GuardianConsentPreview)
async def guardian_consent_decline(
    token: str = Token, user_id: uuid.UUID = Me, svc: IdentityService = Svc
) -> GuardianConsentPreview:
    return await svc.decide_guardian_consent(token, user_id, accept=False)


# ---------- код родителя (PIN) ----------

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
