"""Согласие как выключатель приглашений (INTERNAL_API §11, ревью P-3): создать и принять — при consent_accepted и
цели social (иначе 403 CONSENT_REQUIRED {purpose: social}, без согласия с политикой — {purpose: terms}); открыть,
посмотреть и отклонить (ответ — карточка) — при consent_accepted (иначе {purpose: terms}). Детские профили и
подростки без согласия родителя — по-прежнему INVITES_NOT_ALLOWED. identity-consent старой версии (полей согласия
нет в ответе) — согласия нет (fail closed)."""

from __future__ import annotations

TERMS = {"purpose": "terms"}
SOCIAL = {"purpose": "social"}
WITHOUT_SOCIAL = ("terms", "privacy", "learning")


def consent_error(r, details: dict) -> bool:
    return r.status_code == 403 and r.json()["code"] == "CONSENT_REQUIRED" and r.json()["details"] == details


async def test_create_requires_social_purpose(env) -> None:
    no_social = env.identity.add("Без цели", purposes=WITHOUT_SOCIAL)
    no_consent = env.identity.add("Без согласия", consent=False)
    legacy = env.identity.add("Старый identity", legacy=True)
    for kind in ("family", "friend", "referral"):
        assert consent_error(await env.create(no_social, kind), SOCIAL), kind
        assert consent_error(await env.create(no_consent, kind), TERMS), kind
        assert consent_error(await env.create(legacy, kind), TERMS), kind
    assert await env.sql("SELECT 1 FROM invites") == []
    assert await env.events("social.invite.created.v1") == []
    # после добавления цели social (повторный POST /v1/profile/consent) — можно
    env.identity.set_consent(no_social, True)
    assert (await env.create(no_social, "friend")).status_code == 201


async def test_profile_rules_come_before_consent(env) -> None:
    """Ребёнок и подросток без согласия родителя — INVITES_NOT_ALLOWED (шторка согласия им не поможет);
    семейное от не-18+ — ADULT_REQUIRED."""
    kid = env.identity.add("Мадина", age="10-13", kind="child", purposes=WITHOUT_SOCIAL)
    teen = env.identity.add("Тимур", age="14-17", purposes=WITHOUT_SOCIAL)
    assert (await env.create(kid, "friend")).json()["code"] == "INVITES_NOT_ALLOWED"
    assert (await env.create(teen, "friend")).json()["code"] == "INVITES_NOT_ALLOWED"
    assert (await env.create(teen, "family")).json()["code"] == "ADULT_REQUIRED"
    await env.grant_guardian_consent(teen)
    assert consent_error(await env.create(teen, "friend"), SOCIAL)  # родитель согласился, цели social нет


async def test_open_preview_decline_require_consent(env) -> None:
    inviter = env.identity.add("Азиза")
    guest = env.identity.add("Гость", consent=False)
    iid, token = await env.invite(inviter, "friend")
    # без согласия с политикой: ни открытия (и записи о нём), ни карточки, ни отказа — до любых данных приглашения
    assert consent_error(await env.open(guest, token), TERMS)
    assert consent_error(await env.open(guest, "x" * 32), TERMS)  # даже неизвестный токен — 403, а не 404
    assert await env.sql("SELECT 1 FROM invite_redemptions") == []
    assert await env.events("social.invite.opened.v1") == []
    assert consent_error(await env.c.get(f"/internal/v1/invites/{iid}/preview", headers=env.h(guest)), TERMS)
    assert consent_error(await env.decline(guest, iid), TERMS)
    # согласие есть, цели social нет: открыть и посмотреть можно, принять — нет (шторка «Разрешить приглашения»)
    env.identity.set_consent(guest, True, WITHOUT_SOCIAL)
    r = await env.open(guest, token)
    assert r.status_code == 200 and r.json()["can_accept"] is True and r.json()["reason"] is None
    r = await env.c.get(f"/internal/v1/invites/{iid}/preview", headers=env.h(guest))
    assert r.status_code == 200 and r.json()["inviter_display_name"] == "Азиза"
    assert consent_error(await env.accept(guest, iid), SOCIAL)
    assert await env.sql("SELECT 1 FROM friendships") == []
    assert await env.events("social.invite.accepted.v1") == []
    # цель добавлена — повтор принятия проходит
    env.identity.set_consent(guest, True)
    assert (await env.accept(guest, iid)).status_code == 200
    assert len(await env.events("social.invite.accepted.v1")) == 1


async def test_accept_after_consent_revoked_and_legacy_identity(env) -> None:
    inviter = env.identity.add("Азиза")
    guest, other = env.identity.add("Гость"), env.identity.add("Другой")
    f_id, f_token = await env.invite(inviter, "family")
    r_id, r_token = await env.invite(inviter, "referral")
    assert (await env.open(guest, f_token)).status_code == 200
    assert (await env.open(other, r_token)).status_code == 200
    env.identity.set_consent(guest, False)  # отозвал согласие после открытия
    assert consent_error(await env.accept(guest, f_id), TERMS)
    # identity-consent старой версии: в ответе нет consent_accepted/purposes — согласия нет
    for field in ("consent_accepted", "purposes"):
        env.identity.users[str(other)].pop(field)
    assert consent_error(await env.accept(other, r_id), TERMS)
    assert consent_error(await env.c.get(f"/internal/v1/invites/{r_id}/preview", headers=env.h(other)), TERMS)
    assert await env.sql("SELECT 1 FROM family_members") == []
    assert await env.sql("SELECT 1 FROM friendships") == []


async def test_expired_invite_reports_status_before_consent(env) -> None:
    """Состояние приглашения (истекло, отозвано) важнее шторки согласия: принимать уже нечего."""
    inviter = env.identity.add("Азиза")
    guest = env.identity.add("Гость", purposes=WITHOUT_SOCIAL)
    iid, token = await env.invite(inviter, "friend")
    await env.open(guest, token)
    await env.c.delete(f"/internal/v1/me/invites/{iid}", headers=env.h(inviter))
    r = await env.accept(guest, iid)
    assert r.status_code == 409 and r.json()["code"] == "INVITE_REVOKED"
