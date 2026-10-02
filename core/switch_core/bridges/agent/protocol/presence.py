"""Which agents have something of their own in a room, from live state only.

Presence is a session that connected to the room (`AgentConnectionRegistry`
placement) or a room slot claimed on one of the agent's connections, which is
what a standalone or MCP client leaves behind. Coverage is not presence: an
`all`-scope watcher covering a room is the delivery rule, not something in it.

Switch keeps no record of a session's liveness, so a session that has stopped
without leaving its room still counts until another takes the room or the
agent's controller connection goes.

A controller-backed agent has neither placements nor claims here: which room
each of its sessions works in stays with its controller. It is in no room as
far as `agents_present_in` can tell, and `rooms_occupied` answers with every
room it belongs to while its controller is live, because that is the most
Switch can say without wiping the state of a session it cannot see.
"""

from __future__ import annotations

from collections.abc import Iterable

from switch_core.bridges.agent.protocol.agent_connections import AgentConnectionRegistry


def agents_present_in(
    agent_ids: Iterable[str], room_id: str, connections: AgentConnectionRegistry
) -> set[str]:
    return {
        agent_id
        for agent_id in agent_ids
        if connections.session_in_room(agent_id, room_id) is not None
        or connections.claimant_of(agent_id, room_id) is not None
    }


def rooms_occupied(agent_id: str, connections: AgentConnectionRegistry) -> set[str]:
    """Every room this agent is in right now."""
    if connections.controllers.is_bound(agent_id):
        return connections.controllers.occupied_rooms(agent_id)
    occupied = connections.placed_rooms(agent_id)
    for conn in connections.for_agent(agent_id):
        occupied |= conn.rooms
    return occupied
