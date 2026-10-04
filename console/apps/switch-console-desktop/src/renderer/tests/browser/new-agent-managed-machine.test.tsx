/**
 * The create form's word on where a new agent runs, on a server with agent
 * management: managed on the chosen machine, a button to turn that machine on
 * when it cannot take one yet, and the providers the machine reports ready.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NewAgentMachine } from '@shared/core/agent-migration/agent-migration';
import type { OwnedMachine } from '@shared/core/managed-agents/managed-agents';

const embeddedEnable = vi.hoisted(() => vi.fn());
const hostEnable = vi.hoisted(() => vi.fn());
const modelCatalogue = vi.hoisted(() => vi.fn());

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: vi.fn() },
  rpc: {
    embeddedController: { enable: embeddedEnable },
    hostControllers: { enable: hostEnable },
    agents: { modelCatalogue },
  },
}));

vi.mock('@renderer/lib/components/agent-icon', () => ({ AgentIcon: () => null }));

import { MachineProviderPicker } from '@renderer/features/locations/components/add-agent-modal/machine-provider-picker';
import {
  CanManageAgentsField,
  ManagedModelField,
  ManagedRunLocationNotice,
} from '@renderer/features/locations/components/add-agent-modal/managed-run-location-notice';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  embeddedEnable.mockReset().mockResolvedValue(undefined);
  hostEnable.mockReset().mockResolvedValue(undefined);
  modelCatalogue
    .mockReset()
    .mockResolvedValue({ kind: 'available', models: [{ id: 'opus', variants: [] }] });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(node: React.ReactNode): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () =>
    root!.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
  );
  return container;
}

function notice(machine: NewAgentMachine, sshHost: string | null, onEnabled = vi.fn()) {
  return (
    <ManagedRunLocationNotice
      machine={machine}
      label={sshHost ?? 'This computer'}
      sshHost={sshHost}
      serverId="server-1"
      workspaceId="workspace-1"
      onEnabled={onEnabled}
    />
  );
}

describe('where a new agent runs', () => {
  it('says the agent runs managed on the machine', async () => {
    const el = await render(
      notice(
        {
          management: true,
          target: { kind: 'this-computer', serverId: 'server-1', machineName: 'laptop' },
          blocker: null,
          canEnable: false,
        },
        null
      )
    );
    expect(el.textContent).toMatch(/Runs as a managed agent on This computer \(machine “laptop”\)/);
    expect(el.querySelector('button')).toBeNull();
  });

  it('turns this computer on from the form, then looks again', async () => {
    const onEnabled = vi.fn();
    const el = await render(
      notice(
        { management: true, target: null, blocker: 'Turn it on first.', canEnable: true },
        null,
        onEnabled
      )
    );
    const button = el.querySelector('button')!;
    expect(button.textContent).toBe('Run managed agents on this computer');
    await act(async () => button.click());
    expect(embeddedEnable).toHaveBeenCalledWith({
      serverId: 'server-1',
      workspaceId: 'workspace-1',
    });
    expect(hostEnable).not.toHaveBeenCalled();
    expect(onEnabled).toHaveBeenCalled();
  });

  it('makes an SSH host a machine from the form', async () => {
    const el = await render(
      notice(
        { management: true, target: null, blocker: 'Make it a machine.', canEnable: true },
        'box'
      )
    );
    await act(async () => el.querySelector('button')!.click());
    expect(hostEnable).toHaveBeenCalledWith({
      sshHost: 'box',
      serverId: 'server-1',
      workspaceId: 'workspace-1',
    });
  });

  it('says Console runs the agent on a server without agent management', async () => {
    const el = await render(notice({ management: false }, null));
    expect(el.textContent).toMatch(/so this Console runs the agent/);
  });
});

describe('the managed model field', () => {
  it('suggests the machine’s models and says where its effort is set', async () => {
    const onChange = vi.fn();
    const el = await render(
      <ManagedModelField
        providerId="claude"
        sshHost={null}
        dir="/work/pm"
        value=""
        onChange={onChange}
      />
    );
    await vi.waitFor(() => expect(el.querySelector('datalist option')).not.toBeNull());
    expect(el.querySelector('datalist option')!.getAttribute('value')).toBe('opus');
    expect(modelCatalogue).toHaveBeenCalledWith({
      providerId: 'claude',
      sshHost: null,
      dir: '/work/pm',
    });
    expect(el.textContent).toMatch(
      /reasoning effort and other provider settings on the agent’s page/
    );
  });
});

describe('can manage agents, set as the agent is created', () => {
  it('starts off and turns on when switched', async () => {
    const onChange = vi.fn();
    const el = await render(<CanManageAgentsField checked={false} onChange={onChange} />);
    const toggle = el.querySelector('[aria-label="Can manage agents"]') as HTMLElement;
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await act(async () => toggle.click());
    expect(onChange).toHaveBeenCalledWith(true, expect.anything());
    expect(el.textContent).toMatch(/Agents it creates do not get this permission/);
  });
});

const BOX: OwnedMachine = {
  id: 'controller-7',
  name: 'build-box',
  kind: 'daemon',
  state: 'online',
  local: null,
  providers: [
    { provider: 'claude', ready: true, problem: null },
    { provider: 'codex', ready: false, problem: 'not logged in' },
    { provider: 'opencode', ready: false, problem: 'not installed' },
  ],
};

function tile(el: HTMLElement, name: string): HTMLButtonElement {
  const found = [...el.querySelectorAll('button')].find((button) =>
    button.textContent?.startsWith(name)
  );
  if (!found) throw new Error(`No tile for ${name}`);
  return found;
}

describe('the providers a server machine offers', () => {
  it('offers only the providers the machine reports ready, and says why the others are not', async () => {
    const onChange = vi.fn();
    const el = await render(
      <MachineProviderPicker
        machine={BOX}
        value="claude"
        onChange={onChange}
        defaultAgent="claude"
      />
    );
    expect(tile(el, 'Claude Code').disabled).toBe(false);
    expect(tile(el, 'Claude Code').textContent).toMatch(/Ready/);
    expect(tile(el, 'Codex').disabled).toBe(true);
    expect(tile(el, 'Codex').textContent).toMatch(/Not logged in/);
    expect(tile(el, 'OpenCode').textContent).toMatch(/Not installed/);
    expect(tile(el, 'Cursor').disabled).toBe(true);
    expect(tile(el, 'Cursor').textContent).toMatch(/Not checked yet/);
    await act(async () => tile(el, 'Codex').click());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('picks the one ready provider for the user', async () => {
    const onChange = vi.fn();
    await render(
      <MachineProviderPicker
        machine={BOX}
        value={null}
        onChange={onChange}
        defaultAgent={undefined}
      />
    );
    expect(onChange).toHaveBeenCalledWith('claude');
  });

  it('says when the machine has not reported its providers, and picks none', async () => {
    const onChange = vi.fn();
    const el = await render(
      <MachineProviderPicker
        machine={{ ...BOX, providers: [] }}
        value={null}
        onChange={onChange}
        defaultAgent="claude"
      />
    );
    expect(el.textContent).toMatch(/build-box has not reported its providers yet/);
    expect([...el.querySelectorAll('button')].every((button) => button.disabled)).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });
});
