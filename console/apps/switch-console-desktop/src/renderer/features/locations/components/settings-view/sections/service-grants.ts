import type { GitHubConnection } from '@shared/core/switch-servers/github-connection';

/** The repository ids a GitHub grant names. */
export function grantedRepositoryIds(resources: Record<string, unknown>): number[] {
  const ids = resources.repository_ids;
  return Array.isArray(ids) ? ids.filter((id): id is number => typeof id === 'number') : [];
}

/**
 * The repositories a GitHub grant names, as `account/name` where the person
 * can still see them and by id where they no longer can.
 */
export function grantedRepositoryNames(
  github: GitHubConnection | undefined,
  resources: Record<string, unknown>
): string[] {
  const installation =
    github?.status === 'connected'
      ? github.installations.find((candidate) => candidate.id === resources.installation_id)
      : undefined;
  return grantedRepositoryIds(resources).map((id) => {
    const repository = installation?.repositories.find((candidate) => candidate.id === id);
    return repository && installation
      ? `${installation.account}/${repository.name}`
      : `repository ${id}`;
  });
}

/** What a GitHub grant changes on the machine the agent runs on, and what it does not. */
export const GITHUB_GRANT_NOTES = [
  'Pushes, pull requests and comments appear as the Switch GitHub App, not as you.',
  "For this agent's sessions, a GitHub grant replaces your own GitHub login for HTTPS access to github.com. SSH remotes still use your keys.",
  'On your own computer a grant limits what Switch hands the agent, not what the machine allows: the agent can still use anything you are signed in to there.',
  "Not yet on Windows: an agent running there uses the machine's own GitHub sign-in.",
] as const;
