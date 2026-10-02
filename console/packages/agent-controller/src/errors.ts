import type { ReasonCode } from './schemas';

/** A failure that maps to one of the contract's reason codes, for status and operation results. */
export class ReasonedError extends Error {
  constructor(
    readonly reason: ReasonCode,
    message: string
  ) {
    super(message);
    this.name = 'ReasonedError';
  }
}
