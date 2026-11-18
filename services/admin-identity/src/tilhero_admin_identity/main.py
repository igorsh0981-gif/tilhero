from __future__ import annotations

from tilhero_admin_identity.api.auth import router as auth_router
from tilhero_admin_identity.api.staff import router as staff_router
from tilhero_admin_identity.domain.auth import Identity
from tilhero_admin_identity.settings import Settings, get_settings
from tilhero_common.app import Runtime, create_app


def build_app(settings: Settings | None = None, runtime: Runtime | None = None):
    settings = settings or get_settings()
    runtime = runtime or Runtime(settings)
    identity = Identity(settings)

    async def _bootstrap(rt: Runtime) -> None:
        if rt.db is not None:
            await identity.bootstrap(rt)

    def configure(rt: Runtime) -> None:
        rt.on_startup(_bootstrap)

    app = create_app(settings, routers=[auth_router, staff_router], runtime=runtime, configure=configure,
                     title="TilHero admin-identity")
    app.state.identity = identity
    return app


app = build_app()
