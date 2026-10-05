import { afterEach, expect, it } from 'vitest';
import { createLogger, routeConsoleTo } from './log';

const original = { ...console };
afterEach(() => Object.assign(console, original));

it('logs what is written with console at the level it was written at', () => {
  const lines: string[] = [];
  routeConsoleTo(createLogger({ level: 'info', write: (line) => lines.push(line) }));

  console.info('Room %s has a session again.', 'room-1');
  console.warn('Session stopped.');
  console.error(new Error('Session could not start.'));

  expect(lines[0]).toMatch(/^\S+ INFO Room room-1 has a session again\.\n$/);
  expect(lines[1]).toMatch(/^\S+ WARN Session stopped\.\n$/);
  expect(lines[2]).toMatch(/^\S+ ERROR Error: Session could not start\./);
});
