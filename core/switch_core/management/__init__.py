"""Agent management: managed agent definitions and the controllers that run them.

Off unless `AGENT_MANAGEMENT_ENABLED` is set. Management is the source of
truth for which agents are managed, how each is defined, which controller
runs it, controller enrollment and credentials, controller status, and
operations. Core's messaging path does not depend on any of it: a managed
agent still holds its own per-agent connection to the agent bridge.

The boundary runs one way. This package may call into Core (agent
registration and API-key rotation through `AgentCore`), but nothing in
Core imports this package except the process wiring in `switch_core.main`;
`tests/switch_core/management/test_import_boundary.py` holds that.

The design is `docs/design/agent-controllers-v1.md`, and the wire contract is
`docs/design/controller-contract-v1.md`.
"""
