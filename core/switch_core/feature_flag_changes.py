"""Fan-out of workspace feature-flag changes to whoever keeps a copy.

The gateway writes a flag; the controllers of that workspace hold the flags
they were sent on connect and need the new values. Core runs as one process,
so the change only has to reach listeners registered here. A listener that
misses a change (a restart, a stream between connections) catches up in full
on its next connect.
"""

from __future__ import annotations

from collections.abc import Callable

FeatureFlagListener = Callable[[str, dict[str, bool]], None]


class FeatureFlagChanges:
    def __init__(self) -> None:
        self._listeners: list[FeatureFlagListener] = []

    def add_listener(self, listener: FeatureFlagListener) -> None:
        self._listeners.append(listener)

    def changed(self, tenant_id: str, flags: dict[str, bool]) -> None:
        """Announce `tenant_id`'s full effective flag set, after it committed."""
        for listener in self._listeners:
            listener(tenant_id, dict(flags))
