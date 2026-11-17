"""TilHero — общий каркас Python-сервисов. См. docs/CONVENTIONS.md."""

from tilhero_common.app import Runtime, create_app, get_runtime
from tilhero_common.errors import ApiError
from tilhero_common.internal_auth import Actor, InternalAuth, Principal
from tilhero_common.settings import ServiceSettings

__all__ = [
    "Actor",
    "ApiError",
    "InternalAuth",
    "Principal",
    "Runtime",
    "ServiceSettings",
    "create_app",
    "get_runtime",
]
