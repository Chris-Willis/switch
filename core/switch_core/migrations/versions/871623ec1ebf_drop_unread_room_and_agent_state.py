"""drop room settings, agent state and tables nothing reads

Every column and table here was written by something, or by nothing, and read
by nothing that changed what Switch does:

- `rooms.protection_config` and `rooms.observe_config`, set from the gateway
  and from `create_room`'s `security_config`, for protection checks and an
  observe pipeline that were never built.
- `rooms.admin_mode`, whose only effect was a line in an agent's room
  instructions promising elevated capabilities that nothing granted.

The downgrade puts every column back as `dad29005a7f7` created it: the
settings empty, `admin_mode` off. Their values are not restored.

Revision ID: 871623ec1ebf
Revises: 7c26ad1a2d81
Create Date: 2026-10-06 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "871623ec1ebf"
down_revision: str | None = "7c26ad1a2d81"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_column("rooms", "protection_config")
    op.drop_column("rooms", "observe_config")
    op.drop_column("rooms", "admin_mode")


def downgrade() -> None:
    op.add_column(
        "rooms",
        sa.Column("admin_mode", sa.Boolean(), server_default="false", nullable=False),
    )
    op.add_column(
        "rooms",
        sa.Column(
            "observe_config", postgresql.JSONB(astext_type=sa.Text()), nullable=True
        ),
    )
    op.add_column(
        "rooms",
        sa.Column(
            "protection_config",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
    )
