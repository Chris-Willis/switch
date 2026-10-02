import { z } from 'zod';

/**
 * The wire messages between this controller and Management, as v1 uses them.
 * Field names and types follow `docs/design/controller-contract-v1.md`; where
 * v1 deliberately differs (the definition's shape, the stream carrying only
 * nudges) it follows `docs/design/agent-controllers-v1.md`.
 *
 * Received messages are parsed with `z.object`, which drops fields it does not
 * know: the contract has receivers ignore unknown fields. A value outside a
 * known enum is read as `unknown` rather than failing the whole message.
 */

export const PROTOCOL_VERSION = 1;

export const PROVIDERS = ['claude', 'codex', 'opencode', 'antigravity', 'cursor'] as const;
export type Provider = (typeof PROVIDERS)[number];

export function isProvider(value: string): value is Provider {
  return (PROVIDERS as readonly string[]).includes(value);
}

/** The contract's reason codes, plus the ones v1 adds. */
export const REASON_CODES = [
  'protocol_unsupported',
  'token_expired',
  'controller_revoked',
  'not_assigned',
  'taken_over',
  'stale_generation',
  'unknown_connection',
  'already_claimed',
  'cancelled',
  'lease_expired',
  'provider_not_installed',
  'provider_version_unsupported',
  'provider_login_missing',
  'provider_login_expired',
  'connector_not_connected',
  'connector_revoked',
  'definition_invalid',
  'repo_clone_failed',
  'crash_loop',
  'out_of_memory',
  'disk_full',
  'capacity_exceeded',
  'controller_offline',
  'relay_closed',
  'internal',
  'forbidden',
  'invalid_credential',
  'enrollment_code_invalid',
  'operation_unsupported',
  'not_found',
  'validation_error',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

/** An enum as a receiver reads it: a value it does not know is `unknown`, not an error. */
function receivedEnum<const T extends readonly [string, ...string[]]>(values: T) {
  return z
    .string()
    .transform((value): T[number] | 'unknown' =>
      (values as readonly string[]).includes(value) ? (value as T[number]) : 'unknown'
    );
}

const id = z.string().min(1);
const time = z.string().min(1);
const revision = z.number().int().nonnegative();

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    retryable: z.boolean(),
    retry_after_s: z.number().nonnegative().optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

export const platformSchema = z.object({
  os: z.string().min(1),
  arch: z.string().min(1),
  os_version: z.string(),
});
export type Platform = z.infer<typeof platformSchema>;

// §1 Enrollment and authentication

export const enrollRequestSchema = z.object({
  proof: z.object({ kind: z.literal('enrollment_code'), code: z.string().min(1) }),
  controller: z.object({
    kind: z.literal('daemon'),
    name: z.string().min(1),
    platform: platformSchema,
    version: z.string().min(1),
  }),
});
export type EnrollRequest = z.infer<typeof enrollRequestSchema>;

export const enrollResponseSchema = z.object({ controller_id: id, credential: id });
export type EnrollResponse = z.infer<typeof enrollResponseSchema>;

export const tokenRequestSchema = z.object({ credential: id });

export const tokenResponseSchema = z.object({ access_token: id, expires_at: time });
export type TokenResponse = z.infer<typeof tokenResponseSchema>;

export const credentialRotateResponseSchema = z.object({ credential: id });

// §2 Assignment (v1 definition)

export const agentDefinitionSchema = z.object({
  name: z.string().min(1),
  display_name: z.string().nullish(),
  icon_url: z.string().nullish(),
  /** Kept as a string so one agent with a provider this build does not know fails alone. */
  provider: z.string().min(1),
  model: z.string().nullable(),
  instructions: z.string(),
  auto_session: z.boolean(),
  auto_approve: z.boolean(),
  directory: z.string().nullable(),
});
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;

export const agentAssignmentSchema = z.object({
  agent_id: id,
  revision,
  desired_state: receivedEnum(['running', 'stopped']),
  definition: agentDefinitionSchema,
});
export type AgentAssignment = z.infer<typeof agentAssignmentSchema>;

export const assignmentSchema = z.object({
  revision,
  agents: z.array(agentAssignmentSchema),
});
export type Assignment = z.infer<typeof assignmentSchema>;

// §3 Status

export const PROCESS_STATES = [
  'pending',
  'starting',
  'running',
  'stopping',
  'stopped',
  'crashed',
  'failed',
] as const;
export type ProcessState = (typeof PROCESS_STATES)[number];

const reasonCode = z.enum(REASON_CODES);

export const providerStatusSchema = z.object({
  provider: z.enum(PROVIDERS),
  installed: z.boolean(),
  version: z.string().nullable(),
  auth: z.enum(['ok', 'expired', 'missing', 'unknown']),
  auth_source: z.enum(['local', 'sealed']).nullable(),
  checked_at: time,
  reason: reasonCode.optional(),
});
export type ProviderStatus = z.infer<typeof providerStatusSchema>;

export const toolStatusSchema = z.object({
  tool: z.string().min(1),
  state: z.enum(['ok', 'missing', 'unauthenticated', 'unknown']),
  reason: reasonCode.optional(),
});

export const agentStatusSchema = z
  .object({
    agent_id: id,
    applied_revision: revision.nullable(),
    process: z.enum(PROCESS_STATES),
    attached: z.boolean(),
    sessions: z.object({ active: z.number().int().nonnegative(), ids: z.array(z.string()) }),
    restarts_10m: z.number().int().nonnegative(),
    oom_kills: z.number().int().nonnegative(),
    since: time,
    reason: reasonCode.optional(),
    detail: z.string().optional(),
  })
  .refine(
    (status) => !['crashed', 'failed'].includes(status.process) || status.reason !== undefined,
    { message: 'A crashed or failed agent needs a reason.' }
  );
export type AgentStatus = z.infer<typeof agentStatusSchema>;

export const statusReportSchema = z.object({
  seq: z.number().int().positive(),
  observed_at: time,
  controller: z.object({
    version: z.string().min(1),
    protocol: z.literal(PROTOCOL_VERSION),
    assignment_revision: revision,
  }),
  machine: z.object({
    platform: platformSchema,
    disk_free_bytes: z.number().nonnegative(),
    disk_total_bytes: z.number().nonnegative(),
    mem_free_bytes: z.number().nonnegative(),
    mem_total_bytes: z.number().nonnegative(),
    sessions_running: z.number().int().nonnegative(),
    sessions_max: z.number().int().nonnegative(),
  }),
  providers: z.array(providerStatusSchema),
  tools: z.array(toolStatusSchema),
  agents: z.array(agentStatusSchema),
});
export type StatusReport = z.infer<typeof statusReportSchema>;

export const statusResponseSchema = z.object({
  assignment_revision: revision,
  report_within_s: z.number().int().positive(),
});
export type StatusResponse = z.infer<typeof statusResponseSchema>;

// §4 Operations

export const operationSchema = z.object({
  id,
  /** A string, not an enum: a kind this build does not run is answered `operation_unsupported`. */
  kind: z.string().min(1),
  agent_id: z.string().min(1).nullable(),
  params: z.record(z.string(), z.unknown()),
  created_at: time,
  lease_expires_at: time.nullish(),
});
export type Operation = z.infer<typeof operationSchema>;

export const operationListSchema = z.object({ operations: z.array(operationSchema) });

export const operationProgressSchema = z.object({ message: z.string() });

export const operationResultSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('succeeded'),
    output: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    outcome: z.literal('failed'),
    error: z.object({ code: z.string().min(1), message: z.string() }),
  }),
]);
export type OperationResult = z.infer<typeof operationResultSchema>;

// v1 only: the per-agent API key a controller fetches for each bound agent.

export const agentCredentialsSchema = z.object({ agent_id: id, api_key: id });
export type AgentCredentials = z.infer<typeof agentCredentialsSchema>;

// §6 The nudge stream (v1 carries nudges only)

export const connectionStateSchema = z.object({
  controller_id: id,
  assignment_revision: revision,
  report_within_s: z.number().int().positive(),
});
export type ConnectionState = z.infer<typeof connectionStateSchema>;

export const assignmentChangedSchema = z.object({ revision });

export const operationPendingSchema = z.object({
  operation_id: id,
  kind: z.string().min(1),
  agent_id: z.string().min(1).nullable(),
});
export type OperationPending = z.infer<typeof operationPendingSchema>;

export const credentialRevokedSchema = z.object({});
