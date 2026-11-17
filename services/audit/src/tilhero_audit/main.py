from __future__ import annotations

from tilhero_audit.api.routes import router
from tilhero_audit.consumers import AUDIT_EVENT, on_admin_audit, on_security_event
from tilhero_audit.domain import EVENT_ACTIONS
from tilhero_audit.settings import Settings, get_settings
from tilhero_common.app import Runtime, create_app


def configure(runtime: Runtime) -> None:
    runtime.add_consumer("audit.admin_records", [AUDIT_EVENT], on_admin_audit)
    runtime.add_consumer("audit.security_events", list(EVENT_ACTIONS), on_security_event)


def build_app(settings: Settings | None = None, runtime: Runtime | None = None):
    settings = settings or get_settings()
    return create_app(settings, routers=[router], runtime=runtime or Runtime(settings), configure=configure,
                      title="TilHero audit-service")


app = build_app()
