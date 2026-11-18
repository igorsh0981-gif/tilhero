"""Вход сотрудника — вызывает только admin-bff (без actor). Ответы с challenge/секретом — Cache-Control: no-store."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Response

from tilhero_admin_identity.api.deps import NO_STORE, bff_only, get_identity
from tilhero_admin_identity.domain.auth import Identity
from tilhero_admin_identity.schemas import (
    ChallengeIn,
    CodeIn,
    LoginIn,
    LoginStepOut,
    LogoutIn,
    MfaEnrollStartOut,
    OkOut,
    PasswordIn,
    PrincipalOut,
    StepUpIn,
)
from tilhero_common.app import Runtime, get_runtime
from tilhero_common.internal_auth import Principal

router = APIRouter(prefix="/internal/v1", tags=["internal"])


@router.post("/auth/login", response_model=LoginStepOut)
async def login(body: LoginIn, response: Response, _: Principal = Depends(bff_only),
                rt: Runtime = Depends(get_runtime), idn: Identity = Depends(get_identity)) -> LoginStepOut:
    response.headers.update(NO_STORE)
    return await idn.login(rt, body)


@router.post("/auth/password", response_model=LoginStepOut)
async def password(body: PasswordIn, response: Response, _: Principal = Depends(bff_only),
                   rt: Runtime = Depends(get_runtime), idn: Identity = Depends(get_identity)) -> LoginStepOut:
    response.headers.update(NO_STORE)
    return await idn.change_password(rt, body)


@router.post("/auth/mfa/enroll/start", response_model=MfaEnrollStartOut)
async def enroll_start(body: ChallengeIn, response: Response, _: Principal = Depends(bff_only),
                       rt: Runtime = Depends(get_runtime), idn: Identity = Depends(get_identity)) -> MfaEnrollStartOut:
    response.headers.update(NO_STORE)
    return await idn.enroll_start(rt, body.challenge)


@router.post("/auth/mfa/enroll/confirm", response_model=LoginStepOut)
async def enroll_confirm(body: CodeIn, response: Response, _: Principal = Depends(bff_only),
                         rt: Runtime = Depends(get_runtime), idn: Identity = Depends(get_identity)) -> LoginStepOut:
    response.headers.update(NO_STORE)
    return await idn.enroll_confirm(rt, body.challenge, body.code)


@router.post("/auth/mfa/verify", response_model=LoginStepOut)
async def mfa_verify(body: CodeIn, response: Response, _: Principal = Depends(bff_only),
                     rt: Runtime = Depends(get_runtime), idn: Identity = Depends(get_identity)) -> LoginStepOut:
    response.headers.update(NO_STORE)
    return await idn.mfa_verify(rt, body.challenge, body.code)


@router.post("/auth/step-up", response_model=OkOut)
async def step_up(body: StepUpIn, _: Principal = Depends(bff_only), rt: Runtime = Depends(get_runtime),
                  idn: Identity = Depends(get_identity)) -> OkOut:
    await idn.step_up(rt, body.staff_id, body.code)
    return OkOut()


@router.get("/staff/{staff_id}/principal", response_model=PrincipalOut)
async def principal(staff_id: uuid.UUID, _: Principal = Depends(bff_only), rt: Runtime = Depends(get_runtime),
                    idn: Identity = Depends(get_identity)) -> PrincipalOut:
    return await idn.principal(rt, staff_id)


@router.post("/auth/logout", status_code=204)
async def logout(body: LogoutIn, _: Principal = Depends(bff_only), rt: Runtime = Depends(get_runtime),
                 idn: Identity = Depends(get_identity)) -> Response:
    await idn.logout(rt, body.staff_id, body.session_id)
    return Response(status_code=204)
