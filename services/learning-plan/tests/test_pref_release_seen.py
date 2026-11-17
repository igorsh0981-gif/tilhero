"""Доработка 9.4 «Что нового»: отметка последней просмотренной заметки о релизе в профиле.

Сервер (а не устройство) — шторка не повторяется на другом телефоне. Отметка только движется вперёд, не меняет версию
предпочтений и не публикует событий; удаляется вместе с профилем сагой удаления (ADR-009)."""

from __future__ import annotations

import asyncio
import uuid
from pathlib import Path

from sqlalchemy import text

from tilhero_common.messaging import make_envelope

SEEN = "/internal/v1/me/release-notes/seen"
PREFS = "/internal/v1/me/preferences"
T1, T2, T3 = "2026-11-01T06:00:00.000Z", "2026-11-08T06:00:00.000Z", "2026-12-01T06:00:00.000Z"


async def put(env, user, note_id: uuid.UUID, at: str, issuer: str = "telegram-bff"):
    return await env.c.put(SEEN, json={"release_note_id": str(note_id), "published_at": at},
                           headers=env.h(user, issuer=issuer))


async def test_default_then_forward_only_and_idempotent(env, user) -> None:
    r = await env.c.get(SEEN, headers=env.h(user))
    assert r.status_code == 200
    assert r.json() == {"release_note_id": None, "published_at": None, "onboarding_completed_at": None}
    a, b, old = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    r = await put(env, user, a, T2)
    assert r.status_code == 200 and r.json()["release_note_id"] == str(a) and r.json()["published_at"] == T2
    # повтор — то же; более старая заметка — no-op (другое устройство прислало позже)
    assert (await put(env, user, a, T2)).json()["release_note_id"] == str(a)
    assert (await put(env, user, old, T1)).json()["release_note_id"] == str(a)
    assert (await put(env, user, b, T3)).json() == {
        "release_note_id": str(b), "published_at": T3, "onboarding_completed_at": None}
    # время с поясом в другом формате — то же мгновение
    same = await put(env, user, uuid.uuid4(), "2026-12-01T11:00:00+05:00")
    assert same.json()["release_note_id"] == str(b)
    # onboarding_completed_at — для правила «новому пользователю старые заметки не показывать» в BFF
    await env.c.post("/internal/v1/me/onboarding/complete", headers=env.h(user))
    assert (await env.c.get(SEEN, headers=env.h(user))).json()["onboarding_completed_at"] is not None


async def test_not_a_preference_change(env, user) -> None:
    before = (await env.c.get(PREFS, headers=env.h(user))).json()
    await env.flush()
    await put(env, user, uuid.uuid4(), T2)
    after = (await env.c.get(PREFS, headers=env.h(user))).json()
    assert after["version"] == before["version"] and after["updated_at"] == before["updated_at"]
    assert "last_seen_release_note_id" not in after  # форма Preferences (bff.ts) не меняется
    await env.flush()
    assert env.events("user.preferences.updated.v1") == []


async def test_user_isolation_and_auth(env) -> None:
    """IDOR: пользователь — только из токена; поля user_id в теле нет (лишнее поле → 422)."""
    alice, bob = uuid.uuid4(), uuid.uuid4()
    note = uuid.uuid4()
    await put(env, alice, note, T2)
    assert (await env.c.get(SEEN, headers=env.h(bob))).json()["release_note_id"] is None
    smuggled = await env.c.put(SEEN, json={"release_note_id": str(note), "published_at": T3, "user_id": str(bob)},
                               headers=env.h(alice))
    assert smuggled.status_code == 422
    assert (await env.c.get(SEEN, headers=env.h(bob))).json()["release_note_id"] is None
    assert (await env.c.get(SEEN)).status_code == 401
    assert (await env.c.get(SEEN, headers=env.h(alice, issuer="admin-bff"))).status_code == 403
    assert (await env.c.get(SEEN, headers=env.h(issuer="telegram-bff"))).status_code == 401  # без sub
    for bad in ({"release_note_id": "x", "published_at": T2},
                {"release_note_id": str(note), "published_at": "2026-11-08T06:00:00"},  # без пояса
                {"release_note_id": str(note)}):
        assert (await env.c.put(SEEN, json=bad, headers=env.h(alice))).status_code == 422, bad


async def test_parallel_marks_keep_newest(env, user) -> None:
    ids = [uuid.uuid4() for _ in range(3)]
    await asyncio.gather(*[put(env, user, i, t) for i, t in zip(ids, (T3, T1, T2), strict=True)])
    assert (await env.c.get(SEEN, headers=env.h(user))).json()["release_note_id"] == str(ids[0])


async def test_deleted_with_profile_by_deletion_saga(env, user) -> None:
    await put(env, user, uuid.uuid4(), T2)
    ev = make_envelope("user.deletion.requested.v1",
                       {"user_id": str(user), "request_id": str(uuid.uuid4()),
                        "requested_at": "2026-11-08T09:00:00.000Z", "attempt": 1}, producer="identity-consent")
    await env.bus.publish(ev)
    await env.flush()
    async with env.runtime.transaction() as s:
        left = (await s.execute(text("SELECT count(*) FROM preference_profiles WHERE user_id = :u "
                                     "OR last_seen_release_note_id IS NOT NULL"), {"u": user})).scalar_one()
    assert left == 0
    gone = await put(env, user, uuid.uuid4(), T3)
    assert gone.status_code == 410 and gone.json()["code"] == "USER_DELETED"
    assert (await env.c.get(SEEN, headers=env.h(user))).status_code == 410


async def test_migration_down_and_up(env, user) -> None:
    from alembic import command
    from alembic.config import Config
    from conftest import SERVICE_DIR

    await put(env, user, uuid.uuid4(), T2)
    cfg = Config(str(Path(SERVICE_DIR) / "alembic.ini"))
    cfg.set_main_option("script_location", str(Path(SERVICE_DIR) / "migrations"))
    cfg.attributes["settings"] = env.settings
    await asyncio.to_thread(command.downgrade, cfg, "0002")
    async with env.runtime.transaction() as s:
        cols = (await s.execute(text(
            "SELECT count(*) FROM information_schema.columns WHERE table_schema = :s "
            "AND table_name = 'preference_profiles' AND column_name LIKE 'last_seen_release_note%'"),
            {"s": env.settings.db_schema})).scalar_one()
    assert cols == 0
    await asyncio.to_thread(command.upgrade, cfg, "head")
    assert (await env.c.get(SEEN, headers=env.h(user))).json()["release_note_id"] is None
