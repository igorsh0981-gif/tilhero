"""Ревью спринта 2, P2-3: согласие подростка в read-модели админки и версия снимка.

- Отзыв согласия родителем сужает собственное согласие подростка (снимаются необязательные цели) — это новое
  действующее согласие, и о нём выходит `consent.accepted.v1 {basis: self}` с новыми целями.
- Версия снимка `/admin/v1/users` (`users.updated_at`) — по тем же часам, что `occurred_at` событий: не раньше
  событий своей транзакции (user-admin сравнивает `снимок ≥ событие`) и не убывает.
"""

from __future__ import annotations

import random
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from admin_kit import NEWS, decide, delete_completely, guardian_link, set_categories, ua
from conftest import ALL_PURPOSES, REQUIRED, VALID_PIN
from sqlalchemy import select

from tilhero_common.messaging import envelope as envelope_module
from tilhero_identity.models import Consent

REVOKE = "/internal/v1/me/guardian-consents/{teen}:revoke"


async def _snapshot(env, uid: str) -> dict:
    r = await env.client.get(f"/admin/v1/users/{uid}", headers=ua(env))
    assert r.status_code == 200, r.text
    return r.json()


def _at(value: str) -> datetime:
    return datetime.fromisoformat(value)


async def _last_event_at(env, uid: str) -> datetime:
    await env.flush()
    times = [e.occurred_at for e in env.bus.published
             if e.producer == "identity-consent" and e.payload.get("user_id") == uid]
    assert times, uid
    return max(times)


async def _assert_version_covers_events(env, uid: str) -> datetime:
    """Версия снимка не раньше последнего события ученика — user-admin не отбросит снимок как устаревший."""
    version = _at((await _snapshot(env, uid))["updated_at"])
    assert version >= await _last_event_at(env, uid), uid
    return version


async def _active_own(env, uid: str) -> Consent:
    async with env.runtime.transaction() as s:
        return (await s.execute(select(Consent).where(
            Consent.user_id == uuid.UUID(uid), Consent.basis == "self", Consent.revoked_at.is_(None)))).scalar_one()


# ---------------------------------------------------------------- 1) сужение своего согласия подростка — событие

async def test_guardian_revoke_emits_narrowed_own_consent(env) -> None:
    parent = await env.parent()
    teen = await env.teen()
    assert (await env.consent(teen, list(REQUIRED))).status_code == 200
    await decide(env, await guardian_link(env, teen), parent)
    assert (await env.consent(teen, ALL_PURPOSES)).status_code == 200  # подросток включил необязательные цели
    before = len(await env.events("consent.accepted.v1", teen))

    r = await env.call("POST", REVOKE.format(teen=teen), parent)
    assert r.status_code == 200, r.text
    accepted = await env.events("consent.accepted.v1", teen)  # схема события проверяется в env.events
    assert len(accepted) == before + 1
    own = await _active_own(env, teen)
    assert accepted[-1].payload == {
        "user_id": teen, "consent_id": str(own.consent_id), "policy_version": "1.1", "purposes": REQUIRED,
        "age_band": "14-17", "basis": "self",
    }
    [revoked] = await env.events("consent.revoked.v1", teen)
    assert revoked.payload["basis"] == "guardian"
    assert revoked.occurred_at <= accepted[-1].occurred_at  # сначала закрыто разрешение родителя, затем новое своё

    # снимок identity совпадает с последним событием: своё согласие, цели без необязательных, действует
    snap = await _snapshot(env, teen)
    assert snap["consent"] == {
        "policy_version": "1.1", "purposes": REQUIRED, "accepted_at": snap["consent"]["accepted_at"],
        "revoked_at": None, "basis": "self",
    }
    assert snap["guardian_consent"] == "declined"
    assert _at(snap["updated_at"]) >= accepted[-1].occurred_at

    # повтор отзыва — без изменений и без новых событий
    assert (await env.call("POST", REVOKE.format(teen=teen), parent)).status_code == 200
    assert len(await env.events("consent.accepted.v1", teen)) == before + 1


async def test_guardian_revoke_without_optional_purposes_emits_no_accept(env) -> None:
    """Сужать нечего (подросток не выбирал необязательные цели) — своё согласие то же, consent.accepted.v1 нет."""
    parent = await env.parent()
    teen = await env.teen()
    assert (await env.consent(teen, list(REQUIRED))).status_code == 200
    await decide(env, await guardian_link(env, teen), parent)
    own_before = await _active_own(env, teen)
    before = len(await env.events("consent.accepted.v1", teen))
    assert (await env.call("POST", REVOKE.format(teen=teen), parent)).status_code == 200
    assert len(await env.events("consent.accepted.v1", teen)) == before
    assert (await _active_own(env, teen)).consent_id == own_before.consent_id
    snap = await _snapshot(env, teen)
    assert snap["consent"]["basis"] == "self" and snap["consent"]["revoked_at"] is None
    assert _at(snap["updated_at"]) >= await _last_event_at(env, teen)


# ---------------------------------------------------------------- 2) версия снимка по часам событий

async def test_snapshot_version_not_before_events_of_each_command(env) -> None:
    """После каждой команды с событиями версия снимка ≥ occurred_at её событий (в т.ч. событий детского профиля,
    отдельной транзакции блокировки кода и обезличивания через consumer ACK)."""
    tg = random.randint(10**8, 10**10)
    parent = await env.new_user(telegram_user_id=tg)
    versions = [await _assert_version_covers_events(env, parent)]  # user.profile.created.v1

    async def step(coro, uid: str = parent) -> None:
        await coro
        version = await _assert_version_covers_events(env, uid)
        if uid == parent:
            assert version >= versions[-1]  # не убывает
            versions.append(version)

    await step(env.set_age(parent, "18+"))
    await step(env.consent(parent, NEWS))
    await step(set_categories(env, parent, product=True))
    await step(env.set_pin(parent, VALID_PIN))
    child = (await env.child(parent))["learner_id"]
    await _assert_version_covers_events(env, child)
    await step(env.call("PATCH", f"/internal/v1/me/learners/{child}", parent, {"display_name": "Тест"}), child)
    # 5 неверных кодов: блокировка пишется отдельной транзакцией после отката основной (user.security.changed.v1)
    for _ in range(env.settings.pin_max_attempts):
        await env.call("POST", "/internal/v1/me/pin/verify", parent, {"pin": "9137"})
    assert "pin_locked" in await env.security_changes(parent)
    await _assert_version_covers_events(env, parent)
    await env.redis.delete(f"pin:fail:{parent}", f"pin:lock:{parent}")
    # обезличивание — в транзакции consumer ACK
    await step(env.call("POST", "/internal/v1/me/deletion-request", parent, {"pin": VALID_PIN}))
    await delete_completely(env, parent)
    snap = await _snapshot(env, parent)
    assert snap["status"] == "DELETED"
    await _assert_version_covers_events(env, parent)


@pytest.mark.parametrize("skew", [timedelta(minutes=5), timedelta(minutes=-5)])
async def test_snapshot_version_same_clock_as_events_despite_skew(env, monkeypatch, skew) -> None:
    """Часы сервиса (occurred_at) и БД (now()) расходятся: версия всё равно не раньше событий и не убывает."""

    class Skewed(datetime):
        @classmethod
        def now(cls, tz=None):  # type: ignore[override]
            return datetime.now(tz) + skew

    parent = await env.parent()
    teen = await env.teen()
    assert (await env.consent(teen, list(REQUIRED))).status_code == 200
    monkeypatch.setattr(envelope_module, "datetime", Skewed)  # время выпуска событий — по «другим» часам
    await decide(env, await guardian_link(env, teen), parent)
    assert (await env.consent(teen, ALL_PURPOSES)).status_code == 200
    v1 = await _assert_version_covers_events(env, teen)
    assert (await env.call("POST", REVOKE.format(teen=teen), parent)).status_code == 200
    v2 = await _assert_version_covers_events(env, teen)
    assert v2 >= v1
    monkeypatch.undo()
    # изменение без событий (вход: last_seen_at) по часам БД — версия не уходит назад
    row = await env.user_row(teen)
    await env.login(telegram_user_id=row.telegram_user_id)
    v3 = _at((await _snapshot(env, teen))["updated_at"])
    assert v3 >= v2
    if skew < timedelta(0):
        assert v3 > v2  # часы БД впереди событий: вход двигает версию вперёд
    assert abs(v2 - datetime.now(UTC)) < abs(skew) + timedelta(minutes=1)


async def test_snapshot_version_not_bumped_by_read_only_calls(env) -> None:
    uid = await env.parent()
    version = (await _snapshot(env, uid))["updated_at"]
    for path in ("/internal/v1/me", "/internal/v1/me/learners"):
        assert (await env.call("GET", path, uid)).status_code == 200
    assert (await env.public(uid)).status_code == 200
    assert (await _snapshot(env, uid))["updated_at"] == version
