#!/bin/bash
# usage: in-agent.sh <agent-id> <command...>
# Runs a command as the agent itself would: as switch-agent, inside the agent
# unit's cgroup (so its IPAddressDeny applies) and its mount namespace (so its
# TemporaryFileSystem, BindPaths, InaccessiblePaths and /proc apply).
set -euo pipefail
agent=$1; shift
unit="switch-agent@$agent.service"
pid=$(systemctl show -p MainPID --value "$unit")
[ "$pid" -gt 0 ] || { echo "$unit is not running" >&2; exit 125; }
group=$(systemctl show -p ControlGroup --value "$unit")
procs=$(find /sys/fs/cgroup -path "*$group/cgroup.procs" 2>/dev/null | head -1)
[ -n "$procs" ] || { echo "no cgroup for $unit" >&2; exit 125; }
exec sh -c 'echo $$ >"$1"; shift; pid=$1; shift; exec nsenter -t "$pid" -m -- setpriv --reuid=switch-agent --regid=switch-agent --clear-groups --no-new-privs -- "$@"' \
  in-agent "$procs" "$pid" "$@"
