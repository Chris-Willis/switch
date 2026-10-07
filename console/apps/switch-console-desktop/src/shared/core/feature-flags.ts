/**
 * The workspace feature flags Console acts on.
 *
 * Flags are set per workspace on the Switch server by its admins. Console
 * learns them through the controller it runs for that server, which records
 * what the server last sent. A flag this list does not name is ignored, and
 * one the server has not sent (an older server, or no controller running) is
 * off.
 */
export const CONSOLE_FEATURE_FLAGS = ['ecosystem.show_owners'] as const;

export type ConsoleFeatureFlag = (typeof CONSOLE_FEATURE_FLAGS)[number];

export type ConsoleFeatureFlags = Record<ConsoleFeatureFlag, boolean>;

/** Console's flags from what the server sent: unknown keys dropped, missing ones off. */
export function resolveFeatureFlags(sent: Record<string, boolean> | null): ConsoleFeatureFlags {
  const resolved = {} as ConsoleFeatureFlags;
  for (const key of CONSOLE_FEATURE_FLAGS) resolved[key] = sent?.[key] === true;
  return resolved;
}
