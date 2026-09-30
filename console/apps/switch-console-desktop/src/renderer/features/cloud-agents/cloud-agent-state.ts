import type { SessionStateTone } from '@renderer/features/sessions/components/transcript/session-state';
import { type CloudAgent, cloudAgentPhase } from '@shared/core/cloud-agents/cloud-agents';

/**
 * A cloud agent's state when its worker cannot be asked, read the same way in
 * the sidebar and in a session's header; null while the worker answers.
 */
export function cloudAgentState(
  agent: CloudAgent
): { label: string; tone: SessionStateTone } | null {
  if (agent.launch.desired_state === 'deleted') return { label: 'removing…', tone: 'idle' };
  const phase = cloudAgentPhase(agent.launch, agent.machine);
  if (phase === 'sleeping') return { label: 'sleeping', tone: 'idle' };
  if (phase === 'machine_stopped') return { label: 'machine stopped', tone: 'idle' };
  if (phase === 'waking') return { label: 'waking…', tone: 'busy' };
  if (agent.launch.desired_state === 'stopped') return { label: 'stopped', tone: 'idle' };
  if (agent.launch.process_state === 'crashed' || agent.launch.error_code === 'agent_crashed')
    return { label: 'crashed', tone: 'bad' };
  if (agent.launch.state === 'error') return { label: 'error', tone: 'bad' };
  if (agent.problem) return { label: 'unreachable', tone: 'bad' };
  return null;
}
