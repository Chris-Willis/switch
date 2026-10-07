"""agent controllers: persist the stream connection's liveness

Five nullable columns on `agent_controllers` recording the controller's
stream connection: which one, when it opened, its last persisted beat, and
when and why it closed. Whether a machine is online is read from them, so
it holds across replicas and server restarts. Existing rows start with all
five null and fill in when their controller next opens its stream.

Revision ID: 209e61418971
Revises: eb24eafa59a0
Create Date: 2026-10-07 08:29:11.512417

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "209e61418971"
down_revision: str | None = "eb24eafa59a0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "agent_controllers", sa.Column("connection_id", sa.Text(), nullable=True)
    )
    op.add_column(
        "agent_controllers",
        sa.Column("connected_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "agent_controllers",
        sa.Column("connection_beat_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "agent_controllers",
        sa.Column("disconnected_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "agent_controllers", sa.Column("disconnect_reason", sa.Text(), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("agent_controllers", "disconnect_reason")
    op.drop_column("agent_controllers", "disconnected_at")
    op.drop_column("agent_controllers", "connection_beat_at")
    op.drop_column("agent_controllers", "connected_at")
    op.drop_column("agent_controllers", "connection_id")
