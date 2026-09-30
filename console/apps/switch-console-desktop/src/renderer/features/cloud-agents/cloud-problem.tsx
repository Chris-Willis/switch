import { AlertTriangle, Moon } from 'lucide-react';
import { Button } from '@renderer/lib/ui/button';
import type {
  CloudLaunch,
  CloudMachine,
  CloudRelayProblem,
} from '@shared/core/cloud-agents/cloud-agents';
import { cloudAgentPhase } from '@shared/core/cloud-agents/cloud-agents';
import { useCloudWake } from './use-cloud-agents';

/** What a relay code means to the user, beside the server's own message. */
const PROBLEM_TITLES: Record<string, string> = {
  machine_stopped: 'The owner stopped the cloud machine.',
  worker_sleeping: 'The cloud machine is asleep.',
  worker_waking: 'The cloud machine is starting.',
  agent_stopped: 'The agent is stopped.',
  agent_crashed: 'The agent crashed.',
  worker_not_attached: 'The cloud worker is not attached.',
  worker_busy: 'The cloud worker is busy. Try again shortly.',
  generation_changed: 'The cloud worker restarted.',
  relay_timeout: 'The cloud worker did not answer in time.',
  refused_message: 'Switch refused the request.',
  too_large: 'The request is too large for the relay.',
  not_found: 'Switch does not know this cloud agent.',
};

/**
 * Why a cloud agent's worker cannot be reached, said as such: a sleeping
 * launch offers a wake, and every other refusal shows its code.
 */
export function CloudProblem({
  agentKey,
  launch,
  machine,
  problem,
  compact,
}: {
  agentKey: string;
  launch: CloudLaunch;
  machine: CloudMachine | null;
  problem: CloudRelayProblem;
  compact: boolean;
}) {
  const wake = useCloudWake();
  const phase = cloudAgentPhase(launch, machine);
  const sleeping = problem.code === 'worker_sleeping';
  const Icon = sleeping ? Moon : AlertTriangle;
  return (
    <div
      role={sleeping ? 'status' : 'alert'}
      className={`flex items-start gap-1.5 rounded-md bg-background-secondary text-xs ${compact ? 'px-2 py-1' : 'px-3 py-2'} ${sleeping ? 'text-foreground-muted' : 'text-foreground-destructive'}`}
    >
      <Icon className="mt-px size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        {PROBLEM_TITLES[problem.code] ?? 'The cloud worker could not be reached.'}{' '}
        {problem.message !== PROBLEM_TITLES[problem.code] && (
          <span className="text-foreground-muted">{problem.message} </span>
        )}
        <code className="text-foreground-muted">({problem.code})</code>
        {wake.error && (
          <span className="block text-foreground-destructive">
            Could not wake it: {String(wake.error)}
          </span>
        )}
      </span>
      {problem.wakeAvailable && phase !== 'waking' && (
        <Button
          size="xs"
          variant="outline"
          disabled={wake.isPending}
          onClick={() => wake.mutate(agentKey)}
        >
          {wake.isPending ? 'Waking…' : 'Wake'}
        </Button>
      )}
    </div>
  );
}
