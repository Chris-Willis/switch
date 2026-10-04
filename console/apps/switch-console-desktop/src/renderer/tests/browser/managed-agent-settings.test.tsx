/**
 * A managed agent's settings are the server's: the page shows what the server
 * holds, and Save sends only what changed back to it. A refusal is shown and
 * changes nothing.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';

const managedAgents = vi.hoisted(() => ({ machines: vi.fn(), update: vi.fn() }));
const workspaces = vi.hoisted(() => ({
  updateAgentDisplayName: vi.fn(),
  updateAgentIcon: vi.fn(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { managedAgents, workspaces },
}));
vi.mock(
  '@renderer/features/locations/components/settings-view/sections/addressing-policy-settings-section',
  () => ({ AddressingPolicyRow: () => null })
);
vi.mock(
  '@renderer/features/locations/components/settings-view/sections/can-manage-agents-settings-section',
  () => ({ CanManageAgentsRow: () => null })
);
vi.mock('@renderer/lib/components/agent-icon-picker', () => ({ AgentIconPicker: () => null }));

import { ManagedAgentSettings } from '@renderer/features/managed-agents/managed-agent-settings';

const AGENT: ManagedAgentView = {
  serverId: 'server-1',
  workspaceId: 'workspace-1',
  agentId: 'agent-1',
  name: 'pm-agent',
  displayName: null,
  iconUrl: null,
  description: 'Writes PRDs',
  machine: { id: 'controller-1', name: 'laptop', kind: 'console', state: 'online' },
  desiredState: 'running',
  revision: 1,
  definition: {
    provider: 'claude',
    model: 'opus',
    modelOptions: {},
    instructions: 'Be brief.',
    autoApprove: false,
    directory: '/work/pm',
    isolation: 'shared',
  },
  status: null,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  managedAgents.machines.mockResolvedValue([AGENT.machine]);
  managedAgents.update.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <ManagedAgentSettings agent={AGENT} />
      </QueryClientProvider>
    );
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function button(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((b) => b.textContent === name);
  if (!found) throw new Error(`no ${name} button`);
  return found;
}

it('shows what the server holds', () => {
  const inputs = [...container.querySelectorAll('input')].map((input) => input.value);
  expect(inputs).toContain('/work/pm');
  expect(inputs).toContain('opus');
  expect(container.querySelector('textarea')?.value).toBe('Be brief.');
  expect(button('Save').disabled).toBe(true);
});

it('saves only what changed', async () => {
  managedAgents.update.mockResolvedValue(undefined);
  const bypass = container.querySelector<HTMLElement>('[aria-label="Bypass permissions"]')!;
  await act(async () => bypass.click());
  await act(async () => button('Save').click());
  expect(managedAgents.update).toHaveBeenCalledWith({
    serverId: 'server-1',
    agentId: 'agent-1',
    changes: { definition: { autoApprove: true } },
  });
  expect(workspaces.updateAgentDisplayName).not.toHaveBeenCalled();
});

it('shows a refusal in the server’s words', async () => {
  managedAgents.update.mockRejectedValue(new Error('Codex is not installed on laptop.'));
  const bypass = container.querySelector<HTMLElement>('[aria-label="Bypass permissions"]')!;
  await act(async () => bypass.click());
  await act(async () => button('Save').click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'Codex is not installed on laptop.'
  );
});
