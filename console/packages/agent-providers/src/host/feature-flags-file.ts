import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Where a controller keeps the feature flags its workspace last sent it, in its
 * data directory.
 *
 * Switch sends a workspace's flags on every controller connection and again
 * whenever an admin changes one. The controller writes them here whole, so
 * Console (which runs the controller as a child process) reads them without a
 * connection of its own, and a controller that comes back while the server is
 * unreachable still has the last values it was told.
 */
export const FEATURE_FLAGS_FILE = 'feature-flags.json';

export const featureFlagsFileSchema = z.object({
  flags: z.record(z.string().min(1), z.boolean()),
  receivedAt: z.string(),
});

export type FeatureFlagsFile = z.infer<typeof featureFlagsFileSchema>;

/**
 * The flags in `dataDir`, or null when the controller has not been sent any
 * yet. A file that is there but unreadable is an error, not "no flags".
 */
export async function readFeatureFlagsFile(dataDir: string): Promise<FeatureFlagsFile | null> {
  let raw: string;
  try {
    raw = await readFile(join(dataDir, FEATURE_FLAGS_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return featureFlagsFileSchema.parse(JSON.parse(raw));
}
