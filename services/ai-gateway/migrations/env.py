from alembic import context

from tilhero_ai_gateway.models import Base
from tilhero_ai_gateway.settings import get_settings
from tilhero_common.messaging import messaging_metadata
from tilhero_common.migrations import run_migrations, settings_from_context

run_migrations(context, [Base.metadata, messaging_metadata], settings_from_context(context, get_settings()))
