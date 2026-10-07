"""Registry of per-workspace feature flags.

A feature flag is a named on/off switch each workspace holds its own value
for, stored in the ``feature_flags`` table. Workspace admins flip it through
the gateway (``PUT /gateway/feature-flags/{key}``); agents and controllers may
only read it. Only keys listed here may be written or read — an unknown key is
rejected so the endpoint cannot be used to write arbitrary rows.

A workspace with no row for a flag follows the server-wide default: the value
below (OFF for every flag), unless the deployment lists the flag in
``FEATURE_FLAGS_DEFAULT_ON``. Admins can drop their workspace's row
(``DELETE /gateway/feature-flags/{key}``) to follow the default again.

Controller, Console and the gateway frontend keep their own copy of the keys
they act on, and treat a key they do not know, or one the server did not send,
as OFF.
"""

from __future__ import annotations

# Gate the ecosystem graph's "Show owners" overlay. When OFF the graph never
# exposes owner data, so the frontend toggle has nothing to reveal.
ECOSYSTEM_SHOW_OWNERS = "ecosystem.show_owners"

# All flags the server recognises, mapped to their default (off) state.
KNOWN_FEATURE_FLAGS: dict[str, bool] = {
    ECOSYSTEM_SHOW_OWNERS: False,
}


def is_known_flag(key: str) -> bool:
    return key in KNOWN_FEATURE_FLAGS
