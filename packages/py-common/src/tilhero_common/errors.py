"""Единый формат ошибок (ТЗ «API, Events, Support» §6):

    {"code": "SUPPORT_TICKET_NOT_FOUND", "message": "Обращение не найдено", "trace_id": "...", "details": {}}

HTTP-статус не заменяет бизнес-код: клиенты ветвятся и локализуют по `code`.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from tilhero_common import context

log = logging.getLogger("tilhero.errors")


class TransientError(Exception):
    """Временная ошибка обработки сообщения (зависимость недоступна): потребитель шины не подтверждает сообщение и
    повторяет доставку с задержкой (до 5 мин) без DLQ примерно сутки (TRANSIENT_MAX_DELIVER), затем — DLQ с ошибкой
    в логе. Не для ошибок данных: те падают обычным исключением и уходят в DLQ после max_deliver.

    retry_after (спринт 8): зависимость сама назвала срок (429 Telegram) — повтор не раньше него (не больше часа)."""

    def __init__(self, *args: object, retry_after: float | None = None) -> None:
        super().__init__(*args)
        self.retry_after = retry_after


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(f"{code}: {message}")
        self.status = status
        self.code = code
        self.message = message
        self.details = details or {}


def bad_request(code: str, message: str, details: dict[str, Any] | None = None) -> ApiError:
    return ApiError(400, code, message, details)


def unauthorized(code: str = "UNAUTHORIZED", message: str = "Требуется авторизация") -> ApiError:
    return ApiError(401, code, message)


def forbidden(
    code: str = "FORBIDDEN", message: str = "Недостаточно прав", details: dict[str, Any] | None = None
) -> ApiError:
    return ApiError(403, code, message, details)


def not_found(code: str, message: str) -> ApiError:
    return ApiError(404, code, message)


def conflict(code: str, message: str, details: dict[str, Any] | None = None) -> ApiError:
    return ApiError(409, code, message, details)


def unprocessable(code: str, message: str, details: dict[str, Any] | None = None) -> ApiError:
    return ApiError(422, code, message, details)


def too_many(code: str, message: str, retry_after: int | None = None) -> ApiError:
    return ApiError(429, code, message, {"retry_after": retry_after} if retry_after else None)


def unavailable(code: str, message: str, details: dict[str, Any] | None = None) -> ApiError:
    return ApiError(503, code, message, details)


def error_body(code: str, message: str, details: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"code": code, "message": message, "trace_id": context.get_trace_id(), "details": details or {}}


_STATUS_CODES = {
    400: "BAD_REQUEST",
    401: "UNAUTHORIZED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    405: "METHOD_NOT_ALLOWED",
    409: "CONFLICT",
    413: "PAYLOAD_TOO_LARGE",
    415: "UNSUPPORTED_MEDIA_TYPE",
    429: "RATE_LIMITED",
}


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError) -> JSONResponse:
        headers = {}
        if exc.status in (423, 429) and exc.details.get("retry_after"):
            headers["Retry-After"] = str(exc.details["retry_after"])
        return JSONResponse(error_body(exc.code, exc.message, exc.details), status_code=exc.status, headers=headers)

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        errors = [
            {"loc": [str(p) for p in err.get("loc", [])], "msg": err.get("msg"), "type": err.get("type")}
            for err in exc.errors()
        ]
        return JSONResponse(
            error_body("VALIDATION_ERROR", "Некорректные данные запроса", {"errors": errors}), status_code=422
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = _STATUS_CODES.get(exc.status_code, "HTTP_ERROR")
        return JSONResponse(error_body(code, str(exc.detail)), status_code=exc.status_code)

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        import traceback

        settings = getattr(getattr(request.app.state, "runtime", None), "settings", None)
        if settings is not None and settings.is_secure_env:
            # Текст исключения может содержать входные данные (PII) — пишем только тип и стек.
            log.error("unhandled error", extra={"error_type": type(exc).__name__,
                                                 "stack": "".join(traceback.format_tb(exc.__traceback__))[-4000:]})
        else:
            log.exception("unhandled error", extra={"error_type": type(exc).__name__})
        return JSONResponse(error_body("INTERNAL_ERROR", "Внутренняя ошибка сервиса"), status_code=500)
