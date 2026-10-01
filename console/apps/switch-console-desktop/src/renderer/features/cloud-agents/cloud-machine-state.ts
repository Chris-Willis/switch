import type { CloudMachine } from '@shared/core/cloud-agents/cloud-agents';

/** Below this share of the disk free, the machine card warns that space is low. */
export const LOW_DISK_FRACTION = 0.1;

export type MachineAction = 'stop' | 'start' | 'retry';

export type MachineDisk = {
  usedPercent: number;
  availableBytes: number;
  totalBytes: number;
  low: boolean;
};

export type MachinePresentation = {
  label: string;
  problem: string | null;
  retainUntil: string | null;
  disk: MachineDisk | null;
  actions: MachineAction[];
};

function isRetained(machine: CloudMachine): boolean {
  return (
    machine.desired_state === 'retained' ||
    (machine.state === 'retained' && machine.desired_state !== 'running')
  );
}

function machineLabel(machine: CloudMachine): string {
  if (machine.state === 'error') return 'Error';
  if (isRetained(machine)) return 'Retained';
  if (machine.state === 'deleting' || machine.desired_state === 'deleted') return 'Deleting disk…';
  if (machine.sleeping) return 'Sleeping';
  if (machine.desired_state === 'stopped')
    return machine.state === 'stopped' ? 'Stopped' : 'Stopping…';
  if (machine.state === 'ready') return 'Ready';
  return 'Provisioning';
}

function machineProblem(machine: CloudMachine): string | null {
  if (machine.error_code === 'disk_full') return 'The machine’s disk is full.';
  if (machine.state !== 'error') return null;
  if (machine.error_code === 'machine_needs_attention')
    return 'The machine needs attention. Contact your server administrator.';
  if (machine.error_code === 'machine_connect_timeout')
    return 'The machine did not connect in time. Retry, and if it fails again contact your server administrator.';
  return machine.error ?? 'The machine could not start.';
}

function machineDisk(machine: CloudMachine): MachineDisk | null {
  if (!machine.disk || machine.disk.total_bytes === 0) return null;
  const { total_bytes: totalBytes, available_bytes: availableBytes } = machine.disk;
  return {
    usedPercent: Math.round(((totalBytes - availableBytes) / totalBytes) * 100),
    availableBytes,
    totalBytes,
    low: availableBytes < totalBytes * LOW_DISK_FRACTION,
  };
}

function machineActions(machine: CloudMachine): MachineAction[] {
  if (machine.state === 'error' && machine.error_code !== 'machine_needs_attention') {
    if (isRetained(machine) || machine.desired_state === 'deleted') return ['retry'];
  }
  if (
    isRetained(machine) ||
    machine.state === 'retained' ||
    machine.state === 'deleting' ||
    machine.state === 'deleted' ||
    machine.desired_state === 'deleted'
  )
    return [];
  const actions: MachineAction[] = [];
  if ((machine.desired_state === 'running' && machine.state !== 'error') || machine.sleeping)
    actions.push('stop');
  if (machine.desired_state === 'stopped') actions.push('start');
  if (machine.state === 'error' && machine.error_code !== 'machine_needs_attention')
    actions.push('retry');
  return actions;
}

/** What the machine card shows for a machine: its state, trouble, disk and actions. */
export function machinePresentation(machine: CloudMachine): MachinePresentation {
  return {
    label: machineLabel(machine),
    problem: machineProblem(machine),
    retainUntil: isRetained(machine) ? machine.retain_until : null,
    disk: machineDisk(machine),
    actions: machineActions(machine),
  };
}
