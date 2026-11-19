"""CATALOG_URL обязателен в stage/prod (решение по независимому ревью спринта 3, как у BFF): без него траектория
строилась бы против адреса по умолчанию; dev/test — локальный стенд."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from tilhero_learning_plan.settings import Settings

SECURE = {"internal_jwt_secret": "p" * 40, "internal_jwt_private_key": "A" * 43, "_env_file": None}


def test_catalog_url_required_in_stage_and_prod(monkeypatch) -> None:
    monkeypatch.delenv("CATALOG_URL", raising=False)
    for env_name in ("stage", "prod"):
        with pytest.raises(ValidationError, match="CATALOG_URL is required"):
            Settings(env=env_name, **SECURE)
        with pytest.raises(ValidationError, match="CATALOG_URL is required"):
            Settings(env=env_name, catalog_url="  ", **SECURE)
        s = Settings(env=env_name, catalog_url="http://catalog.railway.internal:8110", **SECURE)
        assert s.catalog_url == "http://catalog.railway.internal:8110"
    with pytest.raises(ValidationError, match="http"):
        Settings(env="prod", catalog_url="catalog:8110", **SECURE)
    monkeypatch.setenv("CATALOG_URL", "https://catalog.example.internal")
    assert Settings(env="prod", **SECURE).catalog_url == "https://catalog.example.internal"
    monkeypatch.delenv("CATALOG_URL")
    assert Settings(env="test", internal_jwt_secret="t" * 40, _env_file=None).catalog_url == "http://127.0.0.1:8110"
