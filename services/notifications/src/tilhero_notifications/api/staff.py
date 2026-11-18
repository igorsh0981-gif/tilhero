"""Staff API шаблонов уведомлений и тестовой отправки (admin.ts «Шаблоны уведомлений»). Вызывает только admin-bff
с actor; право `notif.templates.manage` (step-up активации и сброса проверяет admin-bff). Пути совпадают с admin.ts.

GET  /admin/v1/notifications/templates                                    → {items: TemplateInfo[]}
GET  /admin/v1/notifications/templates/{key}                              → TemplateInfo & {versions}
POST /admin/v1/notifications/templates/{key}/versions                     → 201 TemplateVersion (draft)
POST /admin/v1/notifications/templates/{key}/versions/{v}/preview         → TemplatePreview
POST /admin/v1/notifications/templates/{key}/versions/{v}/activate        → TemplateVersion (active)
POST /admin/v1/notifications/templates/{key}/reset                        → TemplateInfo
GET  /admin/v1/notifications/test-recipients                              → {items: TestRecipient[]}
POST /admin/v1/notifications/templates/{key}/versions/{v}/test            → TestSendResult
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, Path, Request
from fastapi.responses import JSONResponse
from sqlalchemy.exc import IntegrityError

from tilhero_common.app import Runtime, get_runtime
from tilhero_common.errors import unprocessable
from tilhero_common.internal_auth import Principal
from tilhero_notifications import audit, test_send
from tilhero_notifications import template_versions as tv
from tilhero_notifications.api.common import IdempotencyKey, require_any, staff
from tilhero_notifications.domain.texts import FieldError, TextError, check_plain, has_control, normalize
from tilhero_notifications.models import TemplateVersion
from tilhero_notifications.schemas import PreviewIn, ReasonIn, TemplateVersionIn, TestSendIn
from tilhero_notifications.templates import (
    SAMPLE_CONTEXT,
    Lang,
    Rendered,
    TemplateSpec,
    clean_text,
    fill,
    sample_values,
)

router = APIRouter(prefix="/admin/v1/notifications", tags=["staff"])
MANAGE = "notif.templates.manage"
CAMPAIGNS_MANAGE = "notif.campaigns.manage"
VersionNo = Path(ge=1, le=1_000_000)


def preview_view(lang: str, r: Rendered) -> dict[str, Any]:
    return {
        "lang": lang,
        "title": r.title,
        "body": r.body,
        "button": r.button if r.startapp else None,
        "telegram_text": f"{r.title}\n{r.body}",
    }


def sample_for(spec_values: dict[str, str], allowed: tuple[str, ...], sample: dict[str, str] | None) -> dict[str, str]:
    """Образцы плейсхолдеров + значения сотрудника (только известные имена)."""
    values = dict(spec_values)
    if sample:
        unknown = [name for name in sample if name not in allowed]
        if unknown:
            raise unprocessable(
                "TEMPLATE_INVALID",
                "Неизвестный плейсхолдер в образце",
                {"fields": [{"path": f"sample.{name}", "reason": "unknown_placeholder"} for name in unknown]},
            )
        values.update({name: clean_text(value) for name, value in sample.items()})
    return values


def render_version(spec: TemplateSpec, row: TemplateVersion, lang: Lang, sample: dict[str, str] | None) -> Rendered:
    """Версия на образцах: startapp и кнопка по умолчанию — из кода."""
    base = spec.render(lang, spec.sample, SAMPLE_CONTEXT[lang])
    values = sample_for(sample_values(spec, lang), spec.placeholder_names, sample)
    item = row.texts.get(lang) if isinstance(row.texts, dict) else None
    try:
        if not isinstance(item, dict):
            raise TextError("language missing")
        return fill(item, values, default_button=base.button, startapp=base.startapp)
    except TextError:
        raise tv.template_invalid([{"path": f"texts.{lang}", "reason": "invalid_placeholder"}]) from None


def _note_errors(note: str) -> list[FieldError]:
    value = note.strip()
    if 0 < len(value) < 3:
        return [{"path": "note", "reason": "too_short"}]
    errors = check_plain(note, path="note", limit=300)
    return errors


@router.get("/templates")
async def list_templates(principal: Principal = Depends(staff), rt: Runtime = Depends(get_runtime)) -> dict:
    principal.require_permission(MANAGE)
    async with rt.transaction() as session:
        return {"items": await tv.list_infos(session)}


@router.get("/templates/{key}")
async def get_template(key: str, principal: Principal = Depends(staff), rt: Runtime = Depends(get_runtime)) -> dict:
    principal.require_permission(MANAGE)
    spec = tv.spec_or_404(key)
    async with rt.transaction() as session:
        return await tv.get_info(session, spec)


@router.post(
    "/templates/{key}/versions",
    status_code=201,
    responses={404: {"description": "TEMPLATE_NOT_FOUND"}, 422: {"description": "TEMPLATE_INVALID {fields}"}},
)
async def create_version(
    key: str,
    body: TemplateVersionIn,
    principal: Principal = Depends(staff),
    rt: Runtime = Depends(get_runtime),
    idempotency_key: str | None = IdempotencyKey,
) -> JSONResponse:
    actor = principal.require_permission(MANAGE)
    spec = tv.spec_or_404(key)
    raw = body.texts.model_dump()
    errors = tv.check(spec, raw) + _note_errors(body.note)
    if errors:
        raise tv.template_invalid(errors)
    texts = normalize(raw) or {}
    note = body.note.strip()
    fingerprint = tv.request_hash({"key": key, "texts": texts, "note": note})
    try:
        async with rt.transaction() as session:
            row, _ = await tv.create_version(
                session, spec, texts=texts, note=note, actor=actor, idempotency_key=idempotency_key,
                fingerprint=fingerprint, now=datetime.now(UTC),
            )
            out = tv.version_view(row)
    except IntegrityError:  # тот же ключ параллельно для другого шаблона
        raise unprocessable(
            "IDEMPOTENCY_KEY_REUSED", "Ключ идемпотентности уже использован с другими данными"
        ) from None
    return JSONResponse(out, status_code=201)


@router.post("/templates/{key}/versions/{version}/preview")
async def preview_version(
    key: str,
    body: PreviewIn,
    version: int = VersionNo,
    principal: Principal = Depends(staff),
    rt: Runtime = Depends(get_runtime),
) -> dict:
    principal.require_permission(MANAGE)
    spec = tv.spec_or_404(key)
    async with rt.transaction() as session:
        row = await tv.get_version(session, key, version)
    return preview_view(body.lang, render_version(spec, row, body.lang, body.sample))


@router.post("/templates/{key}/versions/{version}/activate")
async def activate_version(
    key: str,
    body: ReasonIn,
    request: Request,
    version: int = VersionNo,
    principal: Principal = Depends(staff),
    rt: Runtime = Depends(get_runtime),
) -> dict:
    """Активация (step-up — admin-bff): прежняя активная → archived; повтор — 200 без изменений. Новые
    уведомления сразу отрисовываются этой версией (кэш процесса сброшен)."""
    actor = principal.require_permission(MANAGE)
    spec = tv.spec_or_404(key)
    _reason_ok(body.reason)
    async with rt.transaction() as session:
        row, changed = await tv.activate(
            session, spec, version, reason=body.reason.strip(), actor=actor, now=datetime.now(UTC)
        )
        out = tv.version_view(row)
    if changed:
        request.app.state.templates.invalidate()
    return out


@router.post("/templates/{key}/reset")
async def reset_template(
    key: str,
    body: ReasonIn,
    request: Request,
    principal: Principal = Depends(staff),
    rt: Runtime = Depends(get_runtime),
) -> dict:
    """Сброс к тексту по умолчанию (step-up — admin-bff): активная версия → archived; нет активной — без изменений."""
    actor = principal.require_permission(MANAGE)
    spec = tv.spec_or_404(key)
    _reason_ok(body.reason)
    async with rt.transaction() as session:
        changed = await tv.reset(session, spec, reason=body.reason.strip(), actor=actor, now=datetime.now(UTC))
    if changed:
        request.app.state.templates.invalidate()
    async with rt.transaction() as session:
        return await tv.get_info(session, spec, with_versions=False)


@router.get("/test-recipients")
async def test_recipients(principal: Principal = Depends(staff), rt: Runtime = Depends(get_runtime)) -> dict:
    """Только индексы и маски (сами chat id в админку не отдаются); пусто — тест недоступен."""
    require_any(principal, MANAGE, CAMPAIGNS_MANAGE)
    return {"items": test_send.recipients(rt)}


@router.post(
    "/templates/{key}/versions/{version}/test",
    responses={422: {"description": "TEST_RECIPIENT_NOT_ALLOWED"}, 429: {"description": "RATE_LIMITED"}},
)
async def test_version(
    key: str,
    body: TestSendIn,
    version: int = VersionNo,
    principal: Principal = Depends(staff),
    rt: Runtime = Depends(get_runtime),
) -> dict:
    """AT-21: только в тестовый чат из ADMIN_TEST_CHAT_IDS (по индексу), «[ТЕСТ] » в заголовке, образцы
    плейсхолдеров; без центра уведомлений и лимитов ученика."""
    actor = principal.require_permission(MANAGE)
    spec = tv.spec_or_404(key)
    chat = test_send.chat_for(rt, body.recipient)
    async with rt.transaction() as session:
        row = await tv.get_version(session, key, version)
    rendered = render_version(spec, row, body.lang, None)
    await test_send.enforce_rate(rt, actor.id)
    result = await test_send.send(rt, chat, rendered)
    async with rt.transaction() as session:
        await audit.emit_audit(
            session,
            audit.record(
                "template.test_sent",
                audit.TEMPLATE,
                key,
                actor=actor,
                after={"version": version, "lang": body.lang, "recipient": body.recipient, "sent": result["sent"],
                       "delivery_id": result["delivery_id"]},
            ),
        )
    return result


def _reason_ok(reason: str) -> None:
    if len(reason.strip()) < 3 or has_control(reason, allow_newline=True):
        raise unprocessable("VALIDATION_ERROR", "Укажите причину (3–300 символов)",
                            {"errors": [{"loc": ["body", "reason"], "msg": "invalid", "type": "value_error"}]})
