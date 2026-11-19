// HTTP client for the Morning (Green Invoice) API, per the official spec
// (https://developers.morning.co/docs/openapi.bundled.json, v2.0.0):
// - token: POST {auth}/idp/v1/oauth/token, JSON { grant_type: 'client_credentials', client_id, client_secret }
//   -> { accessToken, tokenType: 'Bearer', expiresAt (unix seconds) }, valid for 1 hour
// - data:  {api}/... with "Authorization: Bearer <accessToken>"
import { AccountingError } from '../../errors.js';

export const ENVIRONMENTS = {
  production: { label: 'אמיתית (Production)', auth: 'https://api.morning.co', api: 'https://api.greeninvoice.co.il/api/v1' },
  sandbox: { label: 'בדיקות (Sandbox)', auth: 'https://api.sandbox.morning.dev', api: 'https://sandbox.d.greeninvoice.co.il/api/v1' },
};

// OAuth errors (RFC 6749) documented for the token endpoint.
const TOKEN_ERRORS = {
  invalid_client: 'Client ID או Client Secret שגויים, או שהחשבון חסום.',
  unauthorized_client: 'אין מינוי פעיל, או שהמינוי לא כולל גישה ל-API.',
  invalid_grant: 'מפתח ה-API פג תוקף, בוטל או ממתין לאישור.',
  invalid_request: 'בקשת ההתחברות לא תקינה.',
  unsupported_grant_type: 'סוג ההתחברות לא נתמך.',
};

const RETRY_DELAYS_MS = [1000, 3000, 9000];
const TOKEN_SAFETY_MS = 60_000; // renew a minute before expiry
const REQUEST_TIMEOUT_MS = 30_000;

// Tokens are cached per credentials and environment, for as long as the server runs.
const tokenCache = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class MorningClient {
  /**
   * @param {{ environment: string, clientId: string, clientSecret: string }} options
   * @param {{ fetch?: typeof fetch, sleep?: (ms: number) => Promise<void> }} [deps] injectable for tests
   */
  constructor({ environment, clientId, clientSecret }, deps = {}) {
    this.env = ENVIRONMENTS[environment];
    if (!this.env) throw new AccountingError(`סביבה לא מוכרת: ${environment}`, { code: 'bad_config' });
    if (!clientId || !clientSecret) throw new AccountingError('חסרים Client ID או Client Secret.', { code: 'bad_config' });
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.cacheKey = `${environment}:${clientId}`;
    this.fetch = deps.fetch ?? globalThis.fetch;
    this.sleep = deps.sleep ?? sleep;
  }

  /** Returns a valid access token, from cache when possible. */
  async token({ force = false } = {}) {
    const cached = tokenCache.get(this.cacheKey);
    if (!force && cached && cached.expiresAtMs - TOKEN_SAFETY_MS > Date.now()) return cached.accessToken;

    const res = await this.#send(`${this.env.auth}/idp/v1/oauth/token`, {
      method: 'POST',
      body: { grant_type: 'client_credentials', client_id: this.clientId, client_secret: this.clientSecret },
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.accessToken) {
      const known = TOKEN_ERRORS[json.error];
      throw new AccountingError(known ?? `ההתחברות ל-Morning נכשלה (${res.status}${json.error_description ? `: ${json.error_description}` : ''}).`, {
        code: res.status === 401 || json.error === 'invalid_client' ? 'auth_failed' : 'auth_error',
        status: res.status,
        retryable: res.status >= 500,
      });
    }
    tokenCache.set(this.cacheKey, { accessToken: json.accessToken, expiresAtMs: Number(json.expiresAt) * 1000 });
    return json.accessToken;
  }

  /**
   * Calls the data API. Renews the token once on 401; retries rate limits (429), server errors
   * and network failures with growing delays. Throws AccountingError.
   *
   * @param {{ creates?: boolean }} [options] creates: the call creates something at Morning (a client,
   *   a document). Morning offers no idempotency key, so after a network failure or a server error the
   *   record may already exist: such a call is NOT retried, and its error is marked uncertain
   *   (err.uncertain). Only answers that prove nothing was created are retried (401, 429).
   */
  async request(method, path, body, { creates = false } = {}) {
    let renewed = false;
    for (let attempt = 0; ; attempt++) {
      const accessToken = await this.token();
      let res;
      try {
        res = await this.#send(`${this.env.api}${path}`, { method, body, accessToken });
      } catch (err) {
        if (creates) { err.uncertain = true; throw err; }
        if (attempt < RETRY_DELAYS_MS.length) { await this.sleep(RETRY_DELAYS_MS[attempt]); continue; }
        throw err;
      }
      if (creates && res.status >= 500) {
        const json = await res.json().catch(() => ({}));
        const err = apiError(res.status, json);
        err.uncertain = true;
        throw err;
      }
      if (res.ok) return res.status === 204 ? null : res.json();

      const json = await res.json().catch(() => ({}));
      if (res.status === 401 && !renewed) {
        renewed = true;
        tokenCache.delete(this.cacheKey);
        continue;
      }
      const retryable = res.status === 429 || res.status >= 500;
      const retryAfterMs = Number(res.headers.get('retry-after')) * 1000 || undefined;
      if (retryable && attempt < RETRY_DELAYS_MS.length) {
        await this.sleep(Math.max(retryAfterMs ?? 0, RETRY_DELAYS_MS[attempt]));
        continue;
      }
      throw apiError(res.status, json, retryAfterMs);
    }
  }

  async #send(url, { method, body, accessToken }) {
    try {
      return await this.fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new AccountingError(`אין תקשורת עם Morning (${err.name === 'TimeoutError' ? 'פסק זמן' : err.message}).`, { code: 'network', retryable: true });
    }
  }
}

function apiError(status, json, retryAfterMs) {
  // Data API errors carry errorCode and a Hebrew message; the field name is not fixed in the spec.
  const message = json.errorMessage ?? json.message ?? json.error_description ?? json.error;
  const code = status === 429 ? 'rate_limited'
    : status === 401 ? 'auth_failed'
      : status === 403 ? 'forbidden'
        : status === 404 ? 'not_found'
          : status >= 500 ? 'server_error' : 'request_error';
  const text = status === 429 ? 'Morning מגבילה כרגע את קצב הבקשות. ננסה שוב מאוחר יותר.'
    : status === 401 ? 'Morning דחתה את ההרשאה. בדקו את פרטי החיבור.'
      : `Morning החזירה שגיאה ${json.errorCode ?? status}${message ? `: ${message}` : ''}.`;
  return new AccountingError(text, { code, status, retryable: status === 429 || status >= 500, retryAfterMs });
}

/** For tests: forget cached tokens. */
export const clearTokenCache = () => tokenCache.clear();
