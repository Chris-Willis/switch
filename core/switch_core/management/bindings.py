"""Telling Core, at startup, which controller runs each managed agent.

Core keeps the bindings in memory (`ControllerPresence`), so a restart forgets
them, and they must be back before the agent bridge serves: until then a
controller-backed agent would read as directly connected, and its own API key
would be let in. They are read from every tenant, which is a question no
tenant can be scoped to, so the tenants come from the exemption
(`db/tenant_lookup.py`) and each tenant's definitions are then read under its
own policy.
"""

from __future__ import annotations

import logging

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.controller_presence import (
    Binding,
    ControllerPresence,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_definition_store import AgentDefinitionStore
from switch_core.db.tenant_lookup import all_tenant_ids
from switch_core.management.service import binding_of

logger = logging.getLogger(__name__)


async def load_bindings(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    definitions: AgentDefinitionStore,
    presence: ControllerPresence,
) -> int:
    """Load every placed definition into `presence`. Returns how many."""
    bindings: list[Binding] = []
    for tenant_id in await all_tenant_ids(session_factory):
        async with tenant_session(session_factory, tenant_id) as session:
            # Filtered on the row's own tenant as well as by the store: see
            # `db/tenant_lookup.py`, "a fan-out ... filters what it reads back".
            bindings.extend(
                binding_of(tenant_id, row)
                for row in await definitions.list_placed(session, tenant_id)
                if row.tenant_id == tenant_id
            )
    presence.load(bindings)
    logger.info("Loaded %d controller binding(s) into Core", len(bindings))
    return len(bindings)
