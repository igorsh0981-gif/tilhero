"""Помощники тестов админ-контура и аудитории рассылок (спринт 2)."""

from __future__ import annotations

import io
import logging
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Any

from conftest import REQUIRED
from deletion_kit import CONFIRM, ack_all, request_of
from sqlalchemy import select

from tilhero_common.internal_auth import Actor
from tilhero_common.logging import JsonFormatter
from tilhero_common.messaging import Envelope, make_envelope
from tilhero_common.testing import assert_event_conforms, internal_headers
from tilhero_identity.models import LearnerActivity

MASK6 = "•" * 6
NEWS = [*REQUIRED, "product_news"]
SUPPORT = Actor(id=str(uuid.uuid4()), role="support", permissions=frozenset({"users.read"}))
SENSITIVE = Actor(id=str(uuid.uuid4()), role="super_admin",
                  permissions=frozenset({"users.read", "users.sensitive.read"}))
AUDIENCE = "/internal/v1/audience"
AUDIENCE_COUNT = "/internal/v1/audience/count"

__all__ = ["CONFIRM", "NEWS"]


@contextmanager
def json_logs() -> Iterator[io.StringIO]:
    """Логи сервиса в JSON (как в проде, с полями extra) — проверка, что PII и секреты туда не попадают."""
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonFormatter("identity-consent"))
    root = logging.getLogger()
    level = root.level
    root.addHandler(handler)
    root.setLevel(logging.DEBUG)
    try:
        yield stream
    finally:
        root.removeHandler(handler)
        root.setLevel(level)


def ua(env: Any, **kw: Any) -> dict[str, str]:
    return internal_headers(env.settings, issuer="user-admin", **kw)


def bff(env: Any, actor: Actor | None = SENSITIVE, **kw: Any) -> dict[str, str]:
    return internal_headers(env.settings, issuer="admin-bff", actor=actor, **kw)


def notif(env: Any, **kw: Any) -> dict[str, str]:
    return internal_headers(env.settings, issuer="notifications", **kw)


async def set_categories(env: Any, uid: str, **categories: bool) -> None:
    r = await env.call("PATCH", "/internal/v1/me/settings", uid, {"notifications": {"categories": categories}})
    assert r.status_code == 200, r.text


async def set_locale(env: Any, uid: str, locale: str) -> None:
    r = await env.call("PATCH", "/internal/v1/me/settings", uid, {"locale": locale})
    assert r.status_code == 200, r.text


async def news_reader(env: Any, *, locale: str = "ru", **login: Any) -> str:
    """Взрослый, подходящий для рассылки: 18+, согласие с product_news, категория product включена."""
    uid = await env.adult(**login)
    r = await env.consent(uid, NEWS)
    assert r.status_code == 200, r.text
    await set_categories(env, uid, product=True)
    if locale != "ru":
        await set_locale(env, uid, locale)
    return uid


async def guardian_link(env: Any, teen: str) -> str:
    r = await env.call("POST", "/internal/v1/me/guardian-consent-requests", teen)
    assert r.status_code == 200, r.text
    return r.json()["token"]


async def decide(env: Any, token: str, parent: str, decision: str = "accept") -> None:
    r = await env.call("POST", f"/internal/v1/guardian-consents/{token}/{decision}", parent)
    assert r.status_code == 200, r.text


async def news_teen(env: Any, parent: str, *, granted: bool = True) -> str:
    """Подросток 14–17 с категорией product; с согласием родителя — ещё и цель product_news."""
    teen = await env.teen()
    await set_categories(env, teen, product=True)
    if granted:
        await decide(env, await guardian_link(env, teen), parent)
        r = await env.consent(teen, NEWS)
    else:
        r = await env.consent(teen, list(REQUIRED))
    assert r.status_code == 200, r.text
    return teen


async def delete_completely(env: Any, uid: str) -> None:
    """Запрос удаления аккаунта и ACK всех доменов по запросам аккаунта и его детей → обезличивание."""
    r = await env.call("POST", "/internal/v1/me/deletion-request", uid, CONFIRM)
    assert r.status_code == 202, r.text
    await ack_all(env, uid, r.json()["request_id"])


async def delete_child_completely(env: Any, child: str) -> None:
    req = await request_of(env, child)
    await ack_all(env, child, str(req.request_id))


# ---------------------------------------------------------------- события learning-plan

def plan_updated(user_id: str, *, onboarding_completed: bool | None = True, producer: str = "learning-plan",
                 at: datetime | None = None) -> Envelope:
    payload: dict[str, Any] = {"user_id": user_id, "changed_fields": ["onboarding_completed_at"], "goal": "travel",
                               "ui_lang": "ru", "onboarding_completed": onboarding_completed}
    env = make_envelope("learning.plan.updated.v1", payload, producer=producer)
    if at is not None:
        env = env.model_copy(update={"occurred_at": at})
    assert_event_conforms(env)
    return env


def activity_recorded(user_id: str, recorded_at: datetime, *, producer: str = "learning-plan") -> Envelope:
    env = make_envelope("learning.activity.recorded.v1", {
        "user_id": user_id, "activity_id": str(uuid.uuid4()), "local_date": recorded_at.date().isoformat(),
        "kind": "lesson", "minutes": 15, "recorded_at": recorded_at.astimezone(UTC).isoformat(),
    }, producer=producer)
    assert_event_conforms(env)
    return env


async def projection(env: Any, uid: str) -> LearnerActivity | None:
    async with env.runtime.transaction() as s:
        return (await s.execute(
            select(LearnerActivity).where(LearnerActivity.user_id == uuid.UUID(uid))
        )).scalar_one_or_none()
