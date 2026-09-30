/**
 * A cloud agent whose worker cannot be asked says why: a sleeping machine reads
 * as asleep and says a message wakes it, and any other relay refusal is an
 * alert that names its code. Neither offers a button: waking is the composer's.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { CloudProblem } from '@renderer/features/cloud-agents/cloud-problem';
import type { CloudRelayProblem } from '@shared/core/cloud-agents/cloud-agents';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function render(problem: CloudRelayProblem): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<CloudProblem problem={problem} compact />));
  return container;
}

it('reads a sleeping machine as asleep and says a message wakes it', async () => {
  const el = await render({
    code: 'worker_sleeping',
    message: 'The cloud machine is asleep.',
    wakeAvailable: true,
  });
  const status = el.querySelector('[role="status"]');
  expect(status?.textContent).toContain('asleep');
  expect(status?.textContent).toContain('Send a message to wake it.');
  expect(el.querySelector('[role="alert"]')).toBeNull();
  expect(el.querySelector('button')).toBeNull();
});

it('shows any other refusal as an alert with its code', async () => {
  const el = await render({
    code: 'worker_busy',
    message: 'The worker has too many requests in flight.',
    wakeAvailable: false,
  });
  const alert = el.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain('busy');
  expect(alert?.textContent).toContain('too many requests');
  expect(alert?.textContent).toContain('(worker_busy)');
  expect(alert?.textContent).not.toContain('wake');
  expect(el.querySelector('button')).toBeNull();
});
