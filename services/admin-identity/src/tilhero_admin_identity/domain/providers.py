"""Провайдеры аутентификации. local — пароль в admin-identity (argon2id); ad — LDAP/AD банковского этапа
(интерфейс готов, реализация — заглушка: 501 AUTH_MODE_UNAVAILABLE)."""

from __future__ import annotations

from typing import Protocol

from tilhero_admin_identity.domain.crypto import Passwords
from tilhero_admin_identity.models import Staff
from tilhero_common.errors import ApiError


class AuthProvider(Protocol):
    name: str

    async def verify(self, staff: Staff | None, password: str) -> bool:
        """True — пароль верен. Для staff=None обязана потратить то же время, что и для существующей учётки."""
        ...


class LocalAuthProvider:
    name = "local"

    def __init__(self, passwords: Passwords) -> None:
        self.passwords = passwords

    async def verify(self, staff: Staff | None, password: str) -> bool:
        password_hash = staff.password_hash if staff is not None and staff.auth_provider == "local" else None
        return await self.passwords.verify(password_hash, password)


class LdapAuthProvider:
    name = "ad"

    async def verify(self, staff: Staff | None, password: str) -> bool:
        raise ApiError(501, "AUTH_MODE_UNAVAILABLE", "Вход через Active Directory пока недоступен")


def make_provider(auth_mode: str, passwords: Passwords) -> AuthProvider:
    return LdapAuthProvider() if auth_mode == "ad" else LocalAuthProvider(passwords)
