"""remove server-side connectors

Switch no longer dials out to agent hosts: every agent session is started by
Switch Console or its sidecar and connects in. This drops what the server-side
connectors kept:

- `server_connectors`, and with it `tenant_of_server_connector`, the lookup in
  the row-level-security exemption that resolved a connector's tenant at boot.
  `db/tenant_lookup.py` no longer names it, and
  `tests/switch_core/db/test_tenant_lookup.py` records this revision as the one
  that dropped it.
- The registration key each connector held. It stays as a row, retired the way
  `main.py` retires a stale bootstrap key, so nothing can register an agent
  with a credential that only a dropped table knew about.

The downgrade recreates the table and the lookup empty, as `c3f1a9d27e46` left
them, so a rollback lands on a schema that revision recognises. The rows and
the keys' registration type are not restored.

The lookup DDL is frozen, like the rest of this chain: the text `9c41a7b0e5d8`
ran, not whatever `db/tenant_lookup.py` would build today.

Revision ID: 7c26ad1a2d81
Revises: c3f1a9d27e46
Create Date: 2026-10-06 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "7c26ad1a2d81"
down_revision: str | None = "c3f1a9d27e46"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SECURE_SEARCH_PATH = "pg_catalog, public, pg_temp"
REQUIRE_TENANT_FUNCTION_NAME = "require_tenant_id"
POLICY_NAME = "tenant_isolation"
RETIRED_KEY_TYPE = "retired"

CREATE_TENANT_OF_SERVER_CONNECTOR = f"""CREATE OR REPLACE FUNCTION tenant_of_server_connector(p_connector_id text)
    RETURNS SETOF text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = {SECURE_SEARCH_PATH}
AS $$SELECT tenant_id FROM server_connectors WHERE id = p_connector_id$$"""

DROP_TENANT_OF_SERVER_CONNECTOR = (
    "DROP FUNCTION IF EXISTS tenant_of_server_connector(text)"
)

_PREDICATE = f'"tenant_id" = (SELECT {REQUIRE_TENANT_FUNCTION_NAME}())'


def _create_policy(table: str) -> str:
    return (
        f'CREATE POLICY {POLICY_NAME} ON "{table}"\n'
        f"    FOR ALL\n"
        f"    USING ({_PREDICATE})\n"
        f"    WITH CHECK ({_PREDICATE})"
    )


def _enable_rls(table: str) -> None:
    op.execute(f'ALTER TABLE "{table}" ENABLE ROW LEVEL SECURITY')
    op.execute(_create_policy(table))


def upgrade() -> None:
    op.execute(DROP_TENANT_OF_SERVER_CONNECTOR)
    op.execute(
        f"UPDATE api_keys SET type = '{RETIRED_KEY_TYPE}' "
        "WHERE (tenant_id, id) IN (SELECT tenant_id, api_key_id FROM server_connectors)"
    )
    op.drop_table("server_connectors")


def downgrade() -> None:
    op.create_table(
        "server_connectors",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("type", sa.Text(), nullable=False),
        sa.Column("display_name", sa.Text(), nullable=False),
        sa.Column(
            "connection_config", postgresql.JSONB(astext_type=sa.Text()), nullable=True
        ),
        sa.Column("api_key_id", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("id", name="server_connectors_pkey"),
        sa.ForeignKeyConstraint(
            ["tenant_id", "api_key_id"],
            ["api_keys.tenant_id", "api_keys.id"],
            name="fk_server_connectors_api_key",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name="fk_server_connectors_tenant"
        ),
    )
    op.create_index(
        "ix_server_connectors_tenant_id", "server_connectors", ["tenant_id"]
    )
    _enable_rls("server_connectors")
    op.execute(CREATE_TENANT_OF_SERVER_CONNECTOR)
