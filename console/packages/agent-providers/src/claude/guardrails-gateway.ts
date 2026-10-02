const GUARDRAILS_GATEWAY_VARS = [
  'FLINTAI_GATEWAY_URL',
  'FLINTAI_API_KEY',
  'FLINTAI_GUARDRAILS_POLICY_ID',
] as const;

export interface GuardrailsGateway {
  /**
   * Where the session's model traffic goes. Holds no secret, so it may also be
   * passed as flag settings, which the SDK puts on the command line.
   */
  routing: Record<string, string>;
  /** The headers that carry the gateway key; environment only. */
  credentials: Record<string, string>;
}

/**
 * Sends a Claude Code session's model traffic through a guardrails gateway
 * when the execution host's environment names one, or returns null when it
 * names none. The settings are all-or-nothing: a partial set is refused rather
 * than started unguarded.
 *
 * The gateway speaks only the Anthropic API, so a guarded session is moved off
 * Vertex and Bedrock even when the user's own Claude Code settings pick one;
 * left on either, Claude Code ignores the base URL and never reaches the
 * gateway. The headers are assembled here, not inherited, because they span
 * lines and Console's login-shell capture keeps only the first line of a
 * value. No agent id is sent: the gateway counts any agent it is told about
 * against the plan's agent allowance and refuses every call once that is spent.
 */
export function guardrailsGateway(env: Record<string, string>): GuardrailsGateway | null {
  const missing = GUARDRAILS_GATEWAY_VARS.filter((name) => !env[name]);
  if (missing.length === GUARDRAILS_GATEWAY_VARS.length) return null;
  if (missing.length > 0)
    throw new Error(
      `The guardrails gateway is partly configured: set ${missing.join(', ')} as well, or unset all of ${GUARDRAILS_GATEWAY_VARS.join(', ')}.`
    );
  const headers = [
    `X-FlintAI-API-Key: ${env.FLINTAI_API_KEY}`,
    `X-Guardrails-Policy-Id: ${env.FLINTAI_GUARDRAILS_POLICY_ID}`,
  ];
  if (env.ANTHROPIC_CUSTOM_HEADERS) headers.unshift(env.ANTHROPIC_CUSTOM_HEADERS);
  return {
    routing: {
      ANTHROPIC_BASE_URL: `${env.FLINTAI_GATEWAY_URL.replace(/\/+$/, '')}/anthropic`,
      CLAUDE_CODE_USE_BEDROCK: '0',
      CLAUDE_CODE_USE_VERTEX: '0',
    },
    credentials: { ANTHROPIC_CUSTOM_HEADERS: headers.join('\n') },
  };
}
