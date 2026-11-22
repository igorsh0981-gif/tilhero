"""Цели согласия как выключатели функций (P-3) и согласие родителя за подростка 14–17 с доказательством и отзывом
(P-4): INTERNAL_API §11, bff.ts GuardianConsentGrant."""

from __future__ import annotations

import asyncio
import io
import logging
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from conftest import ALL_PURPOSES, REQUIRED
from sqlalchemy import select, text

from tilhero_common.internal_auth import HEADER
from tilhero_common.logging import JsonFormatter
from tilhero_identity.domain.evidence import evidence_hash
from tilhero_identity.domain.policy import get_policy
from tilhero_identity.domain.purposes import consent_accepted, delivery_categories, effective_purposes
from tilhero_identity.models import Consent, GuardianConsentRequest

GRANTS = "/internal/v1/me/guardian-consents"
ALL_CATEGORIES = {"reminders": True, "missed": True, "social": True, "support": True, "product": True,
                  "game": True}


async def _consents(env, uid: str) -> list[Consent]:
    async with env.runtime.transaction() as s:
        return list((await s.execute(
            select(Consent).where(Consent.user_id == uuid.UUID(uid)).order_by(Consent.accepted_at, Consent.basis)
        )).scalars())


async def _active(env, uid: str, basis: str) -> Consent | None:
    return next((c for c in await _consents(env, uid) if c.basis == basis and c.revoked_at is None), None)


async def _gc_row(env, teen: str) -> GuardianConsentRequest:
    async with env.runtime.transaction() as s:
        return (await s.execute(
            select(GuardianConsentRequest).where(GuardianConsentRequest.teen_user_id == uuid.UUID(teen))
            .order_by(GuardianConsentRequest.created_at.desc()).limit(1)
        )).scalar_one()


async def _link(env, teen: str) -> str:
    r = await env.call("POST", "/internal/v1/me/guardian-consent-requests", teen)
    assert r.status_code == 200, r.text
    return r.json()["token"]


async def _decide(env, token: str, parent: str, decision: str = "accept"):
    return await env.call("POST", f"/internal/v1/guardian-consents/{token}/{decision}", parent)


async def _granted_teen(env, parent: str, **kw) -> str:
    teen = await env.teen(**kw)
    r = await _decide(env, await _link(env, teen), parent)
    assert r.status_code == 200 and r.json()["status"] == "granted", r.text
    return teen


async def _revoke(env, parent: str | None, teen: str, issuer: str = "telegram-bff"):
    return await env.call("POST", f"{GRANTS}/{teen}:revoke", parent, issuer=issuer)


async def _grants(env, parent: str) -> list[dict]:
    r = await env.call("GET", GRANTS, parent)
    assert r.status_code == 200, r.text
    return r.json()["items"]


async def _set_categories(env, uid: str, **categories: bool) -> None:
    r = await env.call("PATCH", "/internal/v1/me/settings", uid, {"notifications": {"categories": categories}})
    assert r.status_code == 200, r.text


# ---------------------------------------------------------------- домен (без БД)

def test_purpose_rules() -> None:
    assert consent_accepted(["terms", "privacy"]) and consent_accepted(REQUIRED)
    assert not consent_accepted(["terms", "learning"]) and not consent_accepted([])
    optional = ["voice_recording", "social", "product_news"]
    assert effective_purposes(ALL_PURPOSES, optional=optional, optional_allowed=True) == ALL_PURPOSES
    assert effective_purposes(ALL_PURPOSES, optional=optional, optional_allowed=False) == REQUIRED
    cats = ["reminders", "missed", "social", "support", "product"]
    assert delivery_categories(cats, REQUIRED) == ["reminders", "missed", "support"]
    assert delivery_categories(cats, [*REQUIRED, "social"]) == ["reminders", "missed", "social", "support"]
    assert delivery_categories(cats, [*REQUIRED, "product_news"]) == ["reminders", "missed", "support", "product"]
    assert delivery_categories(["support"], []) == ["support"]


# ---------------------------------------------------------------- /users/{id}/public (P-3)

async def test_public_profile_consent_and_purposes(env) -> None:
    adult = await env.adult()
    body = (await env.public(adult)).json()
    assert (body["consent_accepted"], body["purposes"]) == (False, [])  # ещё не принимал условия
    await env.consent(adult, [*REQUIRED, "social"])
    for caller in ("social", "notifications"):
        body = (await env.public(adult, issuer=caller)).json()
        assert (body["consent_accepted"], body["purposes"]) == (True, [*REQUIRED, "social"]), caller
    await env.consent(adult, [*REQUIRED, "product_news"])  # снял social, добавил product_news
    assert (await env.public(adult)).json()["purposes"] == [*REQUIRED, "product_news"]
    await env.call("DELETE", "/internal/v1/me/consent", adult)
    body = (await env.public(adult)).json()
    assert (body["consent_accepted"], body["purposes"]) == (False, [])

    # подросток: принимает обязательные сам; согласие родителя — разрешение, а не согласие подростка
    teen = await env.teen()
    parent = await env.parent()
    await _decide(env, await _link(env, teen), parent)
    body = (await env.public(teen)).json()
    assert (body["guardian_consent"], body["consent_accepted"], body["purposes"]) == ("granted", False, [])
    await env.consent(teen, [*REQUIRED, "social"])
    body = (await env.public(teen)).json()
    assert (body["consent_accepted"], body["purposes"]) == (True, [*REQUIRED, "social"])

    # детский профиль: согласие родителя (основание guardian) — принято, только обязательные цели
    child = await env.child(parent)
    body = (await env.public(child["learner_id"])).json()
    assert (body["kind"], body["consent_accepted"], body["purposes"]) == ("child", True, REQUIRED)
    [event] = await env.events("consent.accepted.v1", child["learner_id"])
    assert (event.payload["basis"], event.payload["granted_by_user_id"]) == ("guardian", parent)


async def test_public_profile_hides_optional_purposes_not_allowed(env) -> None:
    """Защитно: необязательная цель в записи, которая сейчас не разрешена (подросток без согласия родителя), наружу
    не отдаётся и доставку не включает."""
    teen = await env.teen()
    parent = await env.parent()
    await _decide(env, await _link(env, teen), parent)
    await env.consent(teen, [*REQUIRED, "social"])
    await _set_categories(env, teen, social=True)
    async with env.runtime.transaction() as s:  # состояние «как будто» без согласия родителя
        await s.execute(text("UPDATE users SET guardian_consent = 'pending' WHERE user_id = :u"), {"u": teen})
    assert (await env.public(teen)).json()["purposes"] == REQUIRED
    assert "social" not in (await env.delivery(teen)).json()["categories"]


# ---------------------------------------------------------------- DeliveryInfo.categories (P-3, D-02)

async def test_delivery_categories_follow_consent_purposes(env) -> None:
    uid = await env.adult()
    assert (await env.consent(uid)).status_code == 200
    await _set_categories(env, uid, **ALL_CATEGORIES)
    # настройки хранятся как выбрал пользователь, в доставке social/product — только при целях
    me = (await env.call("GET", "/internal/v1/me", uid)).json()
    assert me["settings"]["categories"] == ALL_CATEGORIES
    assert (await env.delivery(uid)).json()["categories"] == ["reminders", "missed", "support", "game"]

    # повторный POST /me/consent с добавленной целью — новая запись согласия, consent.accepted.v1 и сброс кэша
    # адресации (user.notification_settings.changed.v1 с категориями доставки)
    added = await env.consent(uid, [*REQUIRED, "social"])
    assert added.status_code == 200 and added.json()["purposes"] == [*REQUIRED, "social"]
    assert (await env.delivery(uid)).json()["categories"] == ["reminders", "missed", "social", "support", "game"]
    await env.consent(uid, [*REQUIRED, "social", "product_news"])
    assert (await env.delivery(uid)).json()["categories"] == [
        "reminders", "missed", "social", "support", "product", "game"]
    removed = await env.consent(uid, [*REQUIRED, "product_news"])  # сняли social
    assert removed.json()["purposes"] == [*REQUIRED, "product_news"]
    assert (await env.delivery(uid)).json()["categories"] == ["reminders", "missed", "support", "product", "game"]
    await env.consent(uid, [*REQUIRED, "product_news"])  # тот же набор — без новой записи и событий
    await env.consent(uid, [*REQUIRED, "product_news", "voice_recording"])  # цель без категории доставки

    rows = await _consents(env, uid)
    assert [c.purposes for c in rows] == [REQUIRED, [*REQUIRED, "social"], [*REQUIRED, "social", "product_news"],
                                          [*REQUIRED, "product_news"], [*REQUIRED, "voice_recording",
                                                                        "product_news"]]
    assert [c.revoke_reason for c in rows] == ["superseded"] * 4 + [None]
    accepted = await env.events("consent.accepted.v1", uid)
    assert [e.payload["purposes"] for e in accepted] == [c.purposes for c in rows]
    assert {e.payload["basis"] for e in accepted} == {"self"}
    assert all("granted_by_user_id" not in e.payload for e in accepted)
    notify = [e.payload["categories"] for e in await env.events("user.notification_settings.changed.v1", uid)]
    assert notify == [
        ["support", "game"],  # первое согласие
        ["reminders", "missed", "support", "game"],  # включил все категории: social/product без целей не доставляются
        ["reminders", "missed", "social", "support", "game"],
        ["reminders", "missed", "social", "support", "product", "game"],
        ["reminders", "missed", "support", "product", "game"],
    ]  # voice_recording на доставку не влияет — события нет


async def test_teen_social_category_without_guardian_consent_is_not_delivered(env) -> None:
    """QA D-02 (сопутствующее): подросток без согласия родителя включил категорию «социальное» — в доставке её нет."""
    teen = await env.teen()
    await env.consent(teen)
    await _set_categories(env, teen, social=True, product=True, reminders=True)
    assert (await env.delivery(teen)).json()["categories"] == ["reminders", "support", "game"]
    [*_, last] = await env.events("user.notification_settings.changed.v1", teen)
    assert last.payload["categories"] == ["reminders", "support", "game"]


async def test_child_delivery_has_no_social_or_product(env) -> None:
    guardian = await env.parent()
    child = await env.child(guardian)
    r = await env.call("PATCH", f"/internal/v1/me/learners/{child['learner_id']}", guardian,
                       {"settings": {"categories": ALL_CATEGORIES}})
    assert r.status_code == 200 and r.json()["settings"]["categories"] == ALL_CATEGORIES
    assert (await env.delivery(child["learner_id"])).json()["categories"] == ["reminders", "missed", "support", "game"]


# ---------------------------------------------------------------- решение родителя по ссылке (P-4)

async def test_parent_needs_own_consent_to_decide(env) -> None:
    teen = await env.teen()
    token = await _link(env, teen)
    parent = await env.adult()  # 18+, но условия и политику ещё не принимал
    for decision in ("accept", "decline"):
        r = await _decide(env, token, parent, decision)
        assert r.status_code == 403 and r.json()["code"] == "CONSENT_REQUIRED", r.text
        assert r.json()["details"] == {"purpose": "terms"}
    # отозвал своё согласие — тоже нельзя
    other = await env.parent()
    await env.call("DELETE", "/internal/v1/me/consent", other)
    r = await _decide(env, token, other)
    assert r.status_code == 403 and r.json()["code"] == "CONSENT_REQUIRED"
    row = await _gc_row(env, teen)
    assert (row.status, row.guardian_user_id, row.consent_id) == ("pending", None, None)
    assert (await env.user_row(teen)).guardian_consent == "pending"
    assert await _active(env, teen, "guardian") is None
    # сначала возраст, потом согласие: без возраста — ADULT_REQUIRED (Mini App предлагает выбрать 18+)
    r = await _decide(env, token, await env.new_user())
    assert r.status_code == 403 and r.json()["code"] == "ADULT_REQUIRED"
    # устаревшая ссылка — сразу 410, без требования принять условия
    newer = await _link(env, teen)
    r = await _decide(env, token, parent)
    assert r.status_code == 410 and r.json()["code"] == "GUARDIAN_CONSENT_EXPIRED"
    # принял условия — решение проходит
    assert (await env.consent(parent)).status_code == 200
    assert (await _decide(env, newer, parent)).json()["status"] == "granted"
    # решённая ссылка — статус и без своего согласия (ничего не записывается)
    r = await _decide(env, newer, await env.adult())
    assert r.status_code == 200 and r.json()["status"] == "granted"
    assert len(await env.events("consent.accepted.v1", teen)) == 1


async def test_accept_records_guardian_consent_with_evidence(env) -> None:
    teen = await env.teen(first_name="Подросток")
    await env.consent(teen)  # своё согласие подростка (обязательные цели)
    parent = await env.parent(language_code="uz")
    token = await _link(env, teen)
    r = await _decide(env, token, parent)
    assert r.status_code == 200 and r.json()["status"] == "granted"

    grant = await _active(env, teen, "guardian")
    assert grant is not None
    policy = get_policy("1.2")
    assert grant.purposes == list(policy.purpose_codes)  # разрешение родителя — на все цели политики
    assert (grant.basis, str(grant.granted_by_user_id), grant.age_band) == ("guardian", parent, "14-17")
    # доказательство: версия и текст политики на языке родителя (он читал), время, канал
    assert (grant.policy_version, grant.locale, grant.channel) == ("1.2", "uz", "telegram")
    assert grant.policy_text_sha256 == policy.text_sha256("uz")
    assert grant.evidence_hash == evidence_hash(
        user_id=grant.user_id, policy_version=grant.policy_version, purposes=grant.purposes,
        accepted_at=grant.accepted_at, channel=grant.channel, locale=grant.locale,
        policy_text_sha256=grant.policy_text_sha256, age_band=grant.age_band, basis=grant.basis,
        granted_by=grant.granted_by_user_id,
    )
    assert (await _gc_row(env, teen)).consent_id == grant.consent_id
    # своё согласие подростка не заменяется: он выбирает необязательные цели сам
    own = await _active(env, teen, "self")
    assert own is not None and own.purposes == REQUIRED
    me = (await env.call("GET", "/internal/v1/me", teen)).json()
    assert me["consent"]["purposes"] == REQUIRED and me["user"]["guardian_consent"] == "granted"

    events = await env.events("consent.accepted.v1", teen)
    assert [e.payload["basis"] for e in events] == ["self", "guardian"]
    assert events[1].payload == {
        "user_id": teen, "consent_id": str(grant.consent_id), "policy_version": "1.2",
        "purposes": grant.purposes, "age_band": "14-17", "basis": "guardian", "granted_by_user_id": parent,
    }
    assert "Подросток" not in await env.outbox_dump()
    # повтор решения (и обратное решение) по той же ссылке — 200 с прежним статусом, без новой записи и событий
    for decision in ("accept", "decline"):
        assert (await _decide(env, token, parent, decision)).json()["status"] == "granted"
    assert len([c for c in await _consents(env, teen) if c.basis == "guardian"]) == 1
    assert len(await env.events("consent.accepted.v1", teen)) == 2


async def test_decline_records_only_status(env) -> None:
    teen = await env.teen()
    parent = await env.parent()
    token = await _link(env, teen)
    assert (await _decide(env, token, parent, "decline")).json()["status"] == "declined"
    assert [c.basis for c in await _consents(env, teen)] == []
    assert await env.events("consent.accepted.v1", teen) == []
    # повторное решение по той же ссылке — прежний статус, записи согласия нет
    assert (await _decide(env, token, parent)).json()["status"] == "declined"
    assert await _consents(env, teen) == []


async def test_grant_without_teen_own_consent(env) -> None:
    """Подросток ещё не принимал условия: запись родителя создаётся, но своё согласие он принимает сам."""
    teen = await env.teen()
    parent = await env.parent()
    await _decide(env, await _link(env, teen), parent)
    me = (await env.call("GET", "/internal/v1/me", teen)).json()
    assert me["consent"]["accepted"] is False and me["settings"]["enabled"] is False
    assert [c.basis for c in await _consents(env, teen)] == ["guardian"]
    r = await env.consent(teen, ALL_PURPOSES)
    assert r.status_code == 200 and r.json()["purposes"] == ALL_PURPOSES
    assert {c.basis for c in await _consents(env, teen) if c.revoked_at is None} == {"self", "guardian"}


# ---------------------------------------------------------------- GET /me/guardian-consents

async def test_list_guardian_consents(env) -> None:
    parent = await env.parent()
    first = await _granted_teen(env, parent, first_name="Аня")
    second = await env.teen(first_name="Бек")
    await _decide(env, await _link(env, second), parent, "decline")
    items = await _grants(env, parent)
    assert [(i["teen_user_id"], i["teen_display_name"], i["status"]) for i in items] == [
        (second, "Бек", "declined"), (first, "Аня", "granted")]  # новые первыми
    for item in items:
        assert abs(datetime.fromisoformat(item["decided_at"]) - datetime.now(UTC)) < timedelta(minutes=1)
    assert set(items[0]) == {"teen_user_id", "teen_display_name", "status", "decided_at"}

    # по подростку — последнее решение этого родителя: отказал, подросток прислал новую ссылку, дал согласие
    await _decide(env, await _link(env, second), parent)
    items = await _grants(env, parent)
    assert [(i["teen_user_id"], i["status"]) for i in items] == [(second, "granted"), (first, "granted")]

    # чужой родитель, сам подросток, взрослый без решений — пусто (IDOR)
    for other in (await env.parent(), second, await env.adult()):
        assert await _grants(env, other) == []
    # другой родитель решал за того же подростка позже — у первого остаётся его решение
    third = await env.teen()
    await _decide(env, await _link(env, third), parent, "decline")
    other_parent = await env.parent()
    await _decide(env, await _link(env, third), other_parent)
    assert {i["teen_user_id"]: i["status"] for i in await _grants(env, parent)}[third] == "declined"
    assert [(i["teen_user_id"], i["status"]) for i in await _grants(env, other_parent)] == [(third, "granted")]

    # удалённый подросток в списке не показывается
    r = await env.call("POST", "/internal/v1/me/deletion-request", first, {"confirm_word": "УДАЛИТЬ"})
    assert r.status_code == 202
    assert first not in {i["teen_user_id"] for i in await _grants(env, parent)}


async def test_guardian_consents_access(env) -> None:
    parent = await env.parent()
    teen = await _granted_teen(env, parent)
    assert (await env.client.get(GRANTS)).status_code == 401
    assert (await env.client.post(f"{GRANTS}/{teen}:revoke")).status_code == 401
    bad = await env.client.get(GRANTS, headers={HEADER: "garbage"})
    assert bad.status_code == 401
    for caller in ("social", "notifications", "telegram-bot-gateway"):
        r = await env.call("GET", GRANTS, parent, issuer=caller)
        assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED", caller
        r = await _revoke(env, parent, teen, issuer=caller)
        assert r.status_code == 403 and r.json()["code"] == "CALLER_NOT_ALLOWED", caller
    assert (await env.call("GET", GRANTS, str(uuid.uuid4()))).status_code == 404  # неизвестный sub
    r = await _revoke(env, parent, "not-a-uuid")
    assert r.status_code == 422 and r.json()["code"] == "VALIDATION_ERROR"
    assert (await env.user_row(teen)).guardian_consent == "granted"


# ---------------------------------------------------------------- POST /me/guardian-consents/{teen}:revoke

async def test_revoke_guardian_consent(env) -> None:
    parent = await env.parent()
    teen = await env.teen(first_name="Подросток")
    await env.consent(teen)
    token = await _link(env, teen)
    await _decide(env, token, parent)
    granted_own = await env.consent(teen, ALL_PURPOSES)  # подросток включил необязательные цели
    assert granted_own.status_code == 200
    await _set_categories(env, teen, social=True, product=True, reminders=True)
    assert (await env.delivery(teen)).json()["categories"] == ["reminders", "social", "support", "product", "game"]
    own_before = await _active(env, teen, "self")
    grant = await _active(env, teen, "guardian")
    assert own_before is not None and grant is not None

    r = await _revoke(env, parent, teen)
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["teen_user_id"], body["teen_display_name"], body["status"]) == (teen, "Подросток", "declined")
    assert abs(datetime.fromisoformat(body["decided_at"]) - datetime.now(UTC)) < timedelta(minutes=1)

    # подросток: согласие родителя отозвано, необязательные цели сняты, обучение продолжается
    assert (await env.user_row(teen)).guardian_consent == "declined"
    rows = {c.consent_id: c for c in await _consents(env, teen)}
    assert rows[grant.consent_id].revoke_reason == "guardian" and rows[grant.consent_id].revoked_at is not None
    assert rows[own_before.consent_id].revoke_reason == "superseded"
    own = await _active(env, teen, "self")
    assert own is not None and own.purposes == REQUIRED
    # та же запись подростка без необязательных целей: время, язык, текст и основание — исходные, evidence свой
    assert (own.accepted_at, own.locale, own.basis, own.policy_text_sha256) == (
        own_before.accepted_at, own_before.locale, "self", own_before.policy_text_sha256)
    assert own.evidence_hash != own_before.evidence_hash
    assert own.evidence_hash == evidence_hash(
        user_id=own.user_id, policy_version=own.policy_version, purposes=own.purposes, accepted_at=own.accepted_at,
        channel=own.channel, locale=own.locale, policy_text_sha256=own.policy_text_sha256, age_band=own.age_band,
        basis=own.basis, granted_by=own.granted_by_user_id,
    )
    assert await _active(env, teen, "guardian") is None
    me = (await env.call("GET", "/internal/v1/me", teen)).json()
    assert me["consent"]["accepted"] is True and me["consent"]["purposes"] == REQUIRED
    assert me["settings"]["enabled"] is True
    public = (await env.public(teen)).json()
    assert (public["guardian_consent"], public["consent_accepted"], public["purposes"]) == (
        "declined", True, REQUIRED)
    assert (await env.delivery(teen)).json()["categories"] == ["reminders", "support", "game"]
    # необязательные цели снова только после нового согласия родителя
    r = await env.consent(teen, [*REQUIRED, "social"])
    assert r.status_code == 403 and r.json()["code"] == "GUARDIAN_CONSENT_REQUIRED"
    # ссылка, по которой давали согласие, показывает отказ; повторное решение по ней ничего не меняет
    assert (await env.call("GET", f"/internal/v1/guardian-consents/{token}", None)).json()["status"] == "declined"
    assert (await _decide(env, token, parent)).json()["status"] == "declined"
    assert (await env.user_row(teen)).guardian_consent == "declined"
    row = await _gc_row(env, teen)
    assert (row.status, row.revoked_at is not None, row.consent_id) == ("declined", True, grant.consent_id)

    # события
    [revoked] = await env.events("consent.revoked.v1", teen)
    assert revoked.payload == {"user_id": teen, "consent_id": str(grant.consent_id), "policy_version": "1.2",
                               "basis": "guardian", "revoked_by_user_id": parent}
    [*_, updated] = await env.events("user.profile.updated.v1", teen)
    assert (updated.payload["changed_fields"], updated.payload["guardian_consent"]) == (
        ["guardian_consent"], "declined")
    [*_, notify] = await env.events("user.notification_settings.changed.v1", teen)
    assert notify.payload == {"user_id": teen, "enabled": True, "categories": ["reminders", "support", "game"]}
    assert "Подросток" not in await env.outbox_dump()

    # список родителя: отказ со временем отзыва; повтор отзыва — 200, без изменений и событий
    [item] = await _grants(env, parent)
    assert (item["status"], item["decided_at"]) == ("declined", body["decided_at"])
    again = await _revoke(env, parent, teen)
    assert again.status_code == 200 and again.json() == body
    assert len(await env.events("consent.revoked.v1", teen)) == 1
    assert len([c for c in await _consents(env, teen) if c.revoked_at is None]) == 1


async def test_revoke_only_by_granting_parent(env) -> None:
    parent = await env.parent()
    teen = await _granted_teen(env, parent)
    stranger = await env.parent()
    stranger_teen = await _granted_teen(env, stranger)
    decliner = await env.parent()
    declined_teen = await env.teen()
    await _decide(env, await _link(env, declined_teen), decliner, "decline")
    cases = [
        (stranger, teen),  # чужой родитель
        (teen, teen),  # сам подросток
        (parent, stranger_teen),  # свой родитель, чужой подросток
        (parent, str(uuid.uuid4())),  # несуществующий подросток
        (parent, parent),  # сам себя
        (decliner, declined_teen),  # отказал по ссылке — отзывать нечего
    ]
    for caller, target in cases:
        r = await _revoke(env, caller, target)
        assert r.status_code == 404 and r.json()["code"] == "GUARDIAN_CONSENT_NOT_FOUND", (caller, target)
    assert (await env.user_row(teen)).guardian_consent == "granted"
    assert (await env.user_row(stranger_teen)).guardian_consent == "granted"
    assert await env.events("consent.revoked.v1") == []


async def test_regrant_after_revoke_and_previous_parent(env) -> None:
    first = await env.parent()
    teen = await _granted_teen(env, first)
    assert (await _revoke(env, first, teen)).status_code == 200
    # подросток просит снова, решает другой родитель — новая запись согласия родителя
    second = await env.parent()
    assert (await _decide(env, await _link(env, teen), second)).json()["status"] == "granted"
    grant = await _active(env, teen, "guardian")
    assert grant is not None and str(grant.granted_by_user_id) == second
    assert (await env.consent(teen, [*REQUIRED, "social"])).status_code == 200
    # прежний родитель своё согласие уже отозвал: повтор — 200 без изменений, новое согласие не трогает
    old = await _revoke(env, first, teen)
    assert old.status_code == 200 and old.json()["status"] == "declined"
    assert (await env.user_row(teen)).guardian_consent == "granted"
    assert (await env.public(teen)).json()["purposes"] == [*REQUIRED, "social"]
    # отозвать может тот, кто дал действующее согласие
    assert (await _revoke(env, second, teen)).json()["status"] == "declined"
    assert (await env.public(teen)).json()["purposes"] == REQUIRED
    revoked = await env.events("consent.revoked.v1", teen)
    assert [e.payload["revoked_by_user_id"] for e in revoked] == [first, second]
    assert [c.revoke_reason for c in await _consents(env, teen) if c.basis == "guardian"] == ["guardian"] * 2


async def test_revoke_without_teen_own_consent_and_parallel(env) -> None:
    parent = await env.parent()
    teen = await _granted_teen(env, parent)  # подросток своё согласие ещё не принимал
    results = await asyncio.gather(*[_revoke(env, parent, teen) for _ in range(4)])
    assert {r.status_code for r in results} == {200}
    assert {r.json()["status"] for r in results} == {"declined"}
    assert len(await env.events("consent.revoked.v1", teen)) == 1
    assert len([e for e in await env.events("user.profile.updated.v1", teen)
                if e.payload["guardian_consent"] == "declined"]) == 1
    assert [c.revoked_at is not None for c in await _consents(env, teen)] == [True]
    assert (await env.call("GET", "/internal/v1/me", teen)).json()["consent"]["accepted"] is False


async def test_revoke_is_serialized_with_teen_consent(env) -> None:
    """Подросток включает цель, пока родитель отзывает: после обоих — либо отказ 403, либо цель снята отзывом."""
    parent = await env.parent()
    teen = await _granted_teen(env, parent)
    await env.consent(teen)
    consent, revoke = await asyncio.gather(env.consent(teen, [*REQUIRED, "social"]), _revoke(env, parent, teen))
    assert revoke.status_code == 200 and consent.status_code in (200, 403)
    assert (await env.public(teen)).json()["purposes"] == REQUIRED
    own = await _active(env, teen, "self")
    assert own is not None and own.purposes == REQUIRED


async def test_revoke_for_teen_being_deleted_is_not_found(env) -> None:
    parent = await env.parent()
    teen = await _granted_teen(env, parent)
    r = await env.call("POST", "/internal/v1/me/deletion-request", teen, {"confirm_word": "УДАЛИТЬ"})
    assert r.status_code == 202
    r = await _revoke(env, parent, teen)
    assert r.status_code == 404 and r.json()["code"] == "GUARDIAN_CONSENT_NOT_FOUND"


async def test_revoke_grant_recorded_before_evidence_link(env) -> None:
    """Строка решения без consent_id (решения до этой версии на dev-стендах): закрывается действующая запись
    родителя подростка."""
    parent = await env.parent()
    teen = await _granted_teen(env, parent)
    async with env.runtime.transaction() as s:
        await s.execute(text("UPDATE guardian_consent_requests SET consent_id = NULL"))
    assert (await _revoke(env, parent, teen)).status_code == 200
    assert await _active(env, teen, "guardian") is None
    [revoked] = await env.events("consent.revoked.v1", teen)
    assert revoked.payload["basis"] == "guardian"


async def test_one_active_consent_per_basis(env) -> None:
    parent = await env.parent()
    teen = await _granted_teen(env, parent)
    grant = await _active(env, teen, "guardian")
    assert grant is not None
    with pytest.raises(Exception, match="uq_consents_active"):
        async with env.runtime.transaction() as s:
            await s.execute(text(
                "INSERT INTO consents (consent_id, user_id, policy_version, purposes, accepted_at, locale, basis, "
                "granted_by_user_id, policy_text_sha256, evidence_hash) VALUES (:id, :u, '1.0', ARRAY['terms'], "
                "now(), 'ru', 'guardian', :p, repeat('a', 64), repeat('b', 64))"
            ), {"id": uuid.uuid4(), "u": teen, "p": parent})
    with pytest.raises(Exception, match="ck_guardian_consent_requests_revoked"):
        async with env.runtime.transaction() as s:
            await s.execute(text("UPDATE guardian_consent_requests SET revoked_at = now()"))


async def test_guardian_revoke_logs_have_no_pii(env) -> None:
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonFormatter("identity-consent"))
    logging.getLogger().addHandler(handler)
    try:
        parent = await env.parent(first_name="Секретный")
        teen = await _granted_teen(env, parent, first_name="Тайная", telegram_user_id=4_747_474_747)
        await _revoke(env, parent, teen)
        await _grants(env, parent)
    finally:
        logging.getLogger().removeHandler(handler)
    out = stream.getvalue()
    assert "guardian consent revoked" in out
    for secret in ("Секретный", "Тайная", "4747474747", teen, parent):
        assert secret not in out, secret
