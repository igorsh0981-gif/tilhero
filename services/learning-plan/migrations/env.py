from alembic import context

from tilhero_common.messaging import messaging_metadata
from tilhero_common.migrations import run_migrations, settings_from_context
from tilhero_learning_plan.models import Base
from tilhero_learning_plan.settings import get_settings

run_migrations(context, [Base.metadata, messaging_metadata], settings_from_context(context, get_settings()))
