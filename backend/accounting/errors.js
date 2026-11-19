// One error type for everything a provider can fail with, so the queue and the screens
// can decide what to do without knowing which provider it came from.

export class AccountingError extends Error {
  /**
   * @param {string} message   Hebrew, shown to the user
   * @param {object} [info]
   * @param {string} [info.code]       stable code, e.g. 'auth_failed', 'rate_limited'
   * @param {boolean} [info.retryable] true for temporary failures (rate limit, 5xx, network)
   * @param {number} [info.status]     HTTP status, when there was one
   * @param {number} [info.retryAfterMs] provider's own "try again after"
   */
  constructor(message, { code = 'error', retryable = false, status, retryAfterMs } = {}) {
    super(message);
    this.name = 'AccountingError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export const isRetryable = (err) => err instanceof AccountingError ? err.retryable : true; // unknown errors: try again
