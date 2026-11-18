"""Настройки: SCHEDULER_TOKEN в stage/prod (ревью P-8)."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from tilhero_notifications.settings import Settings

PROD = {"internal_jwt_secret": "p" * 40, "internal_jwt_private_key": "A" * 43}


def test_scheduler_token_length_guard_in_secure_env() -> None:
    """В stage/prod SCHEDULER_TOKEN пустой (вход выключен) или не короче 32 символов; dev/test — любой."""
    for env_name in ("stage", "prod"):
        for short in ("abc", "x" * 31, " " + "y" * 31 + " "):
            with pytest.raises(ValidationError, match="SCHEDULER_TOKEN"):
                Settings(env=env_name, scheduler_token=short, **PROD)
        assert Settings(env=env_name, scheduler_token="z" * 32, **PROD).scheduler_token.get_secret_value() == "z" * 32
        assert Settings(env=env_name, scheduler_token="", **PROD).scheduler_token.get_secret_value() == ""
    assert Settings(env="test", internal_jwt_secret="t" * 40, scheduler_token="abc").scheduler_token
