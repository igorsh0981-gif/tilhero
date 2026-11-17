from alembic import context

from tilhero_common.messaging import messaging_metadata
from tilhero_common.migrations import run_migrations, settings_from_context
from tilhero_identity.models import Base
from tilhero_identity.settings import get_settings

run_migrations(context, [Base.metadata, messaging_metadata], settings_from_context(context, get_settings()))
