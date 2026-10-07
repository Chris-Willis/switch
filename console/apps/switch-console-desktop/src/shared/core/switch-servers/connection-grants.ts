import { z } from 'zod';

/** The most repositories one installation grant can name: the GitHub limit on a token's scope. */
export const MAX_GRANTED_REPOSITORIES = 500;

/**
 * What a cloud agent can reach through one GitHub App installation: every
 * repository the installation shares, or the listed repositories by id.
 */
export const installationGrantSchema = z.object({
  installation_id: z.number().int(),
  repositories: z.union([z.literal('all'), z.array(z.number().int())]),
});
export type InstallationGrant = z.infer<typeof installationGrantSchema>;

/**
 * A connection the owner grants a cloud agent, as its definition carries it
 * (`connections` in the agent definition). At most one per slug.
 */
export const connectionGrantSchema = z.object({
  slug: z.string(),
  installations: z.array(installationGrantSchema),
});
export type ConnectionGrant = z.infer<typeof connectionGrantSchema>;
