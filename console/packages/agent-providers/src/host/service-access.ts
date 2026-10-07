import { z } from 'zod';

/**
 * An agent's access to its owner's outside services (GitHub, later Jira and
 * Google), as Switch grants it.
 *
 * A session reads the agent's grants when it starts or resumes, through the
 * agent's own Switch endpoint: its own key, or the agents controller's relay,
 * which forwards `/agents/{id}/...` as the controller. What a grant gives the
 * session here is its service's skill; a change of grants reaches a session
 * when it next starts.
 */

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const serviceGrantSchema = z.object({
  service: z.string().regex(SLUG),
  access: z.enum(['read', 'write']),
  tool_mode: z.enum(['allow', 'deny']),
  tools: z.array(z.string()),
  resources: z.record(z.string(), z.unknown()),
  skill: z.object({ name: z.string().regex(SLUG), content: z.string() }).nullable(),
});
export type ServiceGrant = z.infer<typeof serviceGrantSchema>;

const grantsResponseSchema = z.object({ grants: z.array(serviceGrantSchema) });

/** A granted service's skill: its name and its SKILL.md, frontmatter and all. */
export type ServiceSkill = { name: string; content: string };

/** Where the agent reaches Switch, and as whom. */
export type ServiceEndpoint = { endpoint: string; token: string; agentId: string };

/**
 * The agent's grants. A Switch from before service connections answers the
 * route with 404, which is the truth: it grants nothing.
 */
export async function readServiceGrants(
  switchEndpoint: ServiceEndpoint,
  fetchImpl: typeof fetch = fetch
): Promise<ServiceGrant[]> {
  const url =
    switchEndpoint.endpoint.replace(/\/$/, '') +
    `/agents/${encodeURIComponent(switchEndpoint.agentId)}/service-grants`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${switchEndpoint.token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error(
      `Switch could not be reached for this agent's service grants: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (response.status === 404) {
    await response.body?.cancel();
    return [];
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Switch refused this agent's service grants (HTTP ${response.status}).`);
  }
  return grantsResponseSchema.parse(await response.json()).grants;
}

/** The skills of the agent's grants, one per service. */
export function grantedSkills(grants: ServiceGrant[]): ServiceSkill[] {
  return grants.flatMap((grant) => (grant.skill ? [grant.skill] : []));
}

/** A skill as system context: its body, without the frontmatter a skills folder needs. */
export function skillContext(skill: ServiceSkill): string {
  return skill.content.replace(/^---\n[\s\S]*?\n---\n+/, '').trim();
}
