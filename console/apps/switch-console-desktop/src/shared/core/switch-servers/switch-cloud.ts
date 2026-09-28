/** The name a Switch Cloud connection is registered under. */
export const SWITCH_CLOUD_NAME = 'Switch Cloud';

/**
 * Where Switch Cloud is, as far as this build or run has been told.
 *
 * One URL, not the gateway/API pair an arbitrary server is registered with: a
 * hosted deployment serves the management API under `/gateway` and the agent
 * API at the root of the same origin, so both are that origin.
 */
export type SwitchCloudEndpoint = {
  url: string;
};
