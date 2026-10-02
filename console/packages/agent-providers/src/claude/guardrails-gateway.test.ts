import { describe, expect, it } from 'vitest';
import { guardrailsGateway } from './guardrails-gateway';

describe('guardrailsGateway', () => {
  const gateway = {
    FLINTAI_GATEWAY_URL: 'https://gateway.example.com/',
    FLINTAI_API_KEY: 'gateway-key',
    FLINTAI_GUARDRAILS_POLICY_ID: 'policy-1',
  };

  it('leaves the session alone when no gateway is configured', () => {
    expect(guardrailsGateway({ ANTHROPIC_BASE_URL: 'https://own.example.com' })).toBeNull();
  });

  it('routes through the gateway on the Anthropic API, one header per line, no agent id', () => {
    expect(guardrailsGateway({ ...gateway, CLAUDE_CODE_USE_VERTEX: '1' })).toEqual({
      routing: {
        ANTHROPIC_BASE_URL: 'https://gateway.example.com/anthropic',
        CLAUDE_CODE_USE_BEDROCK: '0',
        CLAUDE_CODE_USE_VERTEX: '0',
      },
      credentials: {
        ANTHROPIC_CUSTOM_HEADERS:
          'X-FlintAI-API-Key: gateway-key\nX-Guardrails-Policy-Id: policy-1',
      },
    });
  });

  it('keeps headers the user already sends', () => {
    const configured = guardrailsGateway({ ...gateway, ANTHROPIC_CUSTOM_HEADERS: 'X-Own: 1' });
    expect(configured?.credentials.ANTHROPIC_CUSTOM_HEADERS.split('\n')[0]).toBe('X-Own: 1');
  });

  it('refuses a partial configuration instead of running unguarded', () => {
    expect(() => guardrailsGateway({ FLINTAI_GATEWAY_URL: gateway.FLINTAI_GATEWAY_URL })).toThrow(
      /FLINTAI_API_KEY, FLINTAI_GUARDRAILS_POLICY_ID/
    );
  });
});
