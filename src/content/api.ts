// src/content/api.ts
// Sends messages to the background service worker for HTTP fetches.
// [MIRRORS ORIGINAL v1.3.2.2 modules/api.js] — cookies are collected from
// document.cookie (filtered to REQUIRED_COOKIES) and sent as a string in the
// payload. The background then sets the Cookie header verbatim. This mirrors
// the original extension's behavior exactly. Using chrome.cookies.getAll()
// was tried in v1.4.0.0 and caused Yandex to return HTML instead of JSON.

import {
  getAPIRequestDefaults,
  API_URL,
  FETCH_MAX_RETRIES,
  FETCH_MAX_RETRY_DELAY_MS,
  FETCH_RETRY_DELAY_MS,
  HTTP_METHOD,
  PREFIX,
  REQUIRED_COOKIES
} from '../config.ts';
import { logger } from './logger.ts';
import {
  type RequestOutcome,
  type WSRequestBody,
  type WSResponse
} from '../lib/types.ts';

const MESSAGE_TYPE_FETCH = `${PREFIX}fetchAPI`;

interface FetchRequest {
  url: string;
  method?: string;
  body?: string | null;
  onResult?: (r: RequestOutcome) => void;
}

interface FetchError extends Error {
  status?: number;
  statusText?: string;
  retryAfterMs?: number;
}

function makeFetchError(status: number, name: string, message: string): FetchError {
  const err = new Error(message) as FetchError;
  err.status = status;
  err.name = name;
  return err;
}

interface BackgroundErrorPayload {
  message?: string;
  status?: number;
  name?: string;
  retryAfterMs?: number;
}

/**
 * The API occasionally answers 200 with an HTML error page or a reshaped
 * payload. Accepting it silently stored `undefined` frequencies as if they
 * were real values, so the shape is validated before it reaches the cache.
 * `totalValue: null` stays valid — Yandex returns it for genuinely empty
 * queries.
 */
function assertValidWSResponse(data: unknown): WSResponse {
  if (!data || typeof data !== 'object' || Array.isArray(data) || !('totalValue' in data)) {
    throw makeFetchError(502, 'MalformedResponse', 'Malformed API response: totalValue is missing');
  }
  const total = data.totalValue;
  // `totalValue: null` stays valid — Yandex returns it for empty queries.
  if (total === null) return data as WSResponse;
  if (typeof total === 'number' && Number.isFinite(total)) return data as WSResponse;
  throw makeFetchError(502, 'MalformedResponse', 'Malformed API response: totalValue is not a number');
}

/**
 * Collect Yandex auth cookies from document.cookie and filter down to the
 * REQUIRED_COOKIES whitelist. Returns a "name=value; name=value" string
 * suitable for the Cookie header.
 *
 * [PERF] Cached after first read. Cookies don't change during a session
 * unless the user logs in/out — and Yandex reloads the page on auth
 * changes, which re-runs the content script and busts the cache. Reading
 * + filtering + joining on every fetch (called by every queued task) was
 * measurable overhead for large batches (200+ queries → 600+ reads).
 */
let _cookiesCache: string | null = null;
function getCookies(): string {
  if (_cookiesCache !== null) return _cookiesCache;
  try {
    _cookiesCache = document.cookie
      .split(';')
      .map((c) => c.trim())
      // Split on the FIRST '=' only: cookie values legitimately contain '='
      // (base64 padding, tokens). `split('=')` truncated them and produced
      // pairs like ['Session_id', 'abc', 'def'] whose joined value was wrong.
      .map((pair) => {
        const eq = pair.indexOf('=');
        if (eq < 0) return null;
        return [pair.slice(0, eq).trim(), pair.slice(eq + 1).trim()] as const;
      })
      .filter((pair): pair is readonly [string, string] =>
        pair !== null && pair[0].length > 0 && REQUIRED_COOKIES.includes(pair[0])
      )
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  } catch {
    _cookiesCache = '';
  }
  return _cookiesCache;
}

/** Invalidate the cookie cache. Call this when Yandex returns 401/403,
 *  indicating our cached cookies are stale. The next fetch will re-read
 *  document.cookie fresh. */
export function invalidateCookiesCache(): void {
  _cookiesCache = null;
}

export async function fetchViaBackground({ url, method, body, onResult }: FetchRequest): Promise<WSResponse> {
  if (url !== API_URL) {
    throw new Error(`Refusing fetch to non-whitelisted URL: ${url}`);
  }

  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  let reportedStatus = 0;

  try {
    let response: { success: boolean; data: WSResponse; error?: BackgroundErrorPayload };
    try {
      response = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPE_FETCH,
        payload: {
          url,
          method,
          body,
          cookies: getCookies()
        }
      }) as typeof response;
    } catch (err: unknown) {
      const e = err as FetchError;
      const wrapped = makeFetchError(e.status ?? 0, e.name || 'Error', `Message passing error: ${e?.message ?? String(err)}`);
      reportedStatus = wrapped.status || 0;
      throw wrapped;
    }

    if (!response) {
      reportedStatus = 0;
      throw new Error('No response from background script');
    }

    if (response.success) {
      try {
        const validated = assertValidWSResponse(response.data);
        reportedStatus = 200;
        return validated;
      } catch (validationError: unknown) {
        const e = validationError as FetchError;
        reportedStatus = e.status || 502;
        throw e;
      }
    }

    const err = makeFetchError(
      response.error?.status ?? 0,
      response.error?.name ?? 'FetchError',
      response.error?.message ?? 'Background fetch failed'
    );
    // Retry-After may arrive as a header value in seconds or pre-normalized ms.
    const retryAfter = response.error?.retryAfterMs;
    if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0) {
      err.retryAfterMs = retryAfter;
    }
    reportedStatus = err.status || 0;
    // If Yandex tells us our auth is bad, drop the cached cookies so the
    // next fetch re-reads them. Common after a long tab being idle.
    if (err.status === 401 || err.status === 403) {
      invalidateCookiesCache();
    }
    throw err;
  } finally {
    if (onResult) {
      const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
      try {
        onResult({ latencyMs: t1 - t0, status: reportedStatus });
      } catch {
        logger.error('limiter observer error');
      }
    }
  }
}

export async function fetchWS(
  query: string,
  region: string | null,
  deviceTypes: string | null,
  onResult?: (r: RequestOutcome) => void
): Promise<WSResponse> {
  if (!query) throw new Error('Cannot fetch empty query');

  const defaults = getAPIRequestDefaults();
  const requestBody: WSRequestBody = {
    ...defaults,
    searchValue: query,
    currentDevice: deviceTypes || defaults.currentDevice,
    filters: region
      ? { region, tableType: 'popular' }
      : { tableType: 'popular' }
  };

  return fetchViaBackground({
    url: API_URL,
    method: HTTP_METHOD.POST,
    body: JSON.stringify(requestBody),
    ...(onResult !== undefined ? { onResult } : {})
  });
}

export async function fetchVariantWithRetry(
  query: string,
  region: string | null,
  deviceTypes: string | null,
  attempt = 0,
  onResult?: (r: RequestOutcome) => void
): Promise<WSResponse> {
  try {
    return await fetchWS(query, region, deviceTypes, onResult);
  } catch (error: unknown) {
    const e = error as FetchError;
    const status = typeof e.status === 'number' ? e.status : 0;

    // Retry only what a retry can actually fix: throttling, server-side
    // failures, and a malformed payload (surfaced as 502). A 4xx is a
    // deterministic rejection, and a statusless failure (dead service
    // worker, message-passing error) must NOT burn three retries — that just
    // triple-delays every cell in the batch.
    const retryable = status === 429 || (status >= 500 && status < 600);
    if (!retryable || attempt >= FETCH_MAX_RETRIES) {
      throw error;
    }

    // A server-supplied Retry-After wins over our own exponential backoff,
    // but stays capped so one bad header cannot stall a queue slot for
    // minutes.
    const backoff = Math.min(
      FETCH_RETRY_DELAY_MS * Math.pow(2, attempt),
      FETCH_MAX_RETRY_DELAY_MS
    );
    const serverHint =
      typeof e.retryAfterMs === 'number' && Number.isFinite(e.retryAfterMs)
        ? Math.min(Math.max(0, e.retryAfterMs), FETCH_MAX_RETRY_DELAY_MS)
        : 0;

    const { promise: slept, resolve: wake } = Promise.withResolvers<void>();
    setTimeout(wake, Math.max(backoff, serverHint));
    await slept;

    return fetchVariantWithRetry(query, region, deviceTypes, attempt + 1, onResult);
  }
}
