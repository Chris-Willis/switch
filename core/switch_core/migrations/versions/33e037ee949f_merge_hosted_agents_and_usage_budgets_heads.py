"""Merge the hosted-agent and usage-budget migration heads.

Runs after `b9e4d2a71c05` dropped the old server-side session tables, in the
same transaction, so it refuses that drop unless the gate
`hosted-cutover-upgrade` checks before it upgrades still holds; this is what
stops an ungated `alembic upgrade head`, the one Core runs at boot among them.
`migrations/env.py` has already checked the whole gate before the drop; what
it reads from the old tables cannot be checked again here. A database with no
hosted launches passes.
"""

from alembic import op

from switch_core.db.hosted_cutover_gate import refuse_incomplete_cutover

revision = "33e037ee949f"
down_revision = ("a3c9e5f71d28", "e3b7c9d2a415")
branch_labels = None
depends_on = None


def upgrade() -> None:
    refuse_incomplete_cutover(op.get_bind())


def downgrade() -> None:
    pass
