"""Чистые правила social: токены ссылок, кто может приглашать и принимать, роль в семье, статус и причина в карточке.

Дети и подростки (CONVENTIONS §8, ARCHITECTURE «Приглашения»): ребёнок 6–13 приглашений не создаёт и не получает
(только через родителя: детский профиль попадает в семью опекуна автоматически); подросток 14–17 — только после
согласия родителя (`guardian_consent = granted`); семейное приглашение создаёт только 18+.
Согласие (INTERNAL_API §11, P-3): открыть и посмотреть — при действующем согласии с политикой (`consent_accepted`),
создать и принять — ещё и с необязательной целью `social`. Сначала проверяются правила профиля (дети, подростки,
статус: INVITES_NOT_ALLOWED / ADULT_REQUIRED), затем согласие (CONSENT_REQUIRED).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import uuid
from datetime import datetime, timedelta
from typing import Final

from tilhero_common.errors import ApiError, forbidden
from tilhero_social.identity import Person

KINDS: Final = ("family", "friend", "referral")
KIDS: Final = frozenset({"6-9", "10-13"})
TOKEN_LEN: Final = 32
TOKEN_RE: Final = re.compile(r"^[A-Za-z0-9_-]{32}$")
MAX_USES: Final[dict[str, int | None]] = {"family": 1, "friend": 1, "referral": None}
SOCIAL_PURPOSE: Final = "social"  # необязательная цель согласия «Приглашения, семья и друзья»


# ---------------------------------------------------------------- токен и ссылка


def make_token(key: bytes, invite_id: uuid.UUID) -> str:
    digest = hmac.new(key, str(invite_id).encode("ascii"), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")[:TOKEN_LEN]


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("ascii")).hexdigest()


def is_token(value: str) -> bool:
    return bool(TOKEN_RE.match(value))


def invite_link(app_link: str, token: str) -> str:
    return f"{app_link}?startapp=inv_{token}"


def expires_at(kind: str, now: datetime, family_days: int, friend_days: int) -> datetime | None:
    if kind == "family":
        return now + timedelta(days=family_days)
    if kind == "friend":
        return now + timedelta(days=friend_days)
    return None  # referral — многоразовая, без срока


def effective_status(status: str, expires: datetime | None, now: datetime) -> str:
    """Статус для ответа: активное приглашение с прошедшим сроком — expired, даже если tick ещё не отметил."""
    if status == "active" and expires is not None and expires <= now:
        return "expired"
    return status


# ---------------------------------------------------------------- кто может


def invites_not_allowed() -> ApiError:
    return forbidden("INVITES_NOT_ALLOWED", "Приглашения недоступны для этого профиля")


def check_inviter(person: Person | None, kind: str) -> None:
    """403 INVITES_NOT_ALLOWED — детский профиль, ребёнок 6–13, возраст не выбран (кроме семейного), подросток без
    согласия родителя, аккаунт не активен; 403 ADULT_REQUIRED — семейное приглашение не от 18+."""
    if person is None or person.status != "ACTIVE" or person.kind != "account" or person.age_band in KIDS:
        raise invites_not_allowed()
    if kind == "family":
        if person.age_band != "18+":
            raise forbidden("ADULT_REQUIRED", "Пригласить в семью может только взрослый (18+)")
        return
    if person.age_band is None:
        raise invites_not_allowed()
    if person.age_band == "14-17" and person.guardian_consent != "granted":
        raise invites_not_allowed()


def can_receive(person: Person | None) -> bool:
    """Получатель: активный аккаунт 14+; подросток — после согласия родителя."""
    if person is None or person.status != "ACTIVE" or person.kind != "account":
        return False
    if person.age_band == "18+":
        return True
    return person.age_band == "14-17" and person.guardian_consent == "granted"


def consent_required(purpose: str) -> ApiError:
    return forbidden("CONSENT_REQUIRED", "Сначала примите условия использования и политику конфиденциальности"
                     if purpose == "terms" else "Разрешите приглашения, семью и друзей в настройках согласия",
                     {"purpose": purpose})


def check_consent(person: Person | None, *, social: bool) -> None:
    """INTERNAL_API §11 (P-3): открыть и посмотреть приглашение — при действующем согласии (terms, privacy), иначе
    403 CONSENT_REQUIRED {purpose: terms}; создать и принять (`social=True`) — ещё и с целью social, иначе
    403 CONSENT_REQUIRED {purpose: social}. Без согласия с политикой цель social не спрашиваем — сначала terms."""
    if person is None or not person.consent_accepted:
        raise consent_required("terms")
    if social and SOCIAL_PURPOSE not in person.purposes:
        raise consent_required("social")


def member_role(person: Person) -> str:
    return "adult" if person.age_band == "18+" else "teen"


def ordered_pair(a: uuid.UUID, b: uuid.UUID) -> tuple[uuid.UUID, uuid.UUID]:
    """Порядок пары дружбы = порядок uuid в PostgreSQL (побайтно, как int в Python)."""
    return (a, b) if a.int < b.int else (b, a)
