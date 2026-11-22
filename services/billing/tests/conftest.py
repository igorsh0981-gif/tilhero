from __future__ import annotations

from pathlib import Path
from typing import Any

from tilhero_billing.settings import Settings
from tilhero_common.testing import TEST_REDIS_URL

SERVICE_DIR = str(Path(__file__).resolve().parents[1])
SCHEDULER_TOKEN = "s" * 40
# заведомо тестовые значения (не секреты): ключи провайдеров в тестах — только такие строки
EDGE_TOKEN = "test-edge-token-" + "e" * 24


def make_settings(**kw: Any) -> Settings:
    base: dict[str, Any] = {"env": "test", "internal_jwt_secret": "t" * 40, "scheduler_token": SCHEDULER_TOKEN,
                            "payments_edge_token": EDGE_TOKEN, "redis_url": TEST_REDIS_URL}
    base.update(kw)
    return Settings(**base)
