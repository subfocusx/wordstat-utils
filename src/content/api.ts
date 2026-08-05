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

const MESSAGE_TYPE_FETCH = `${PREFIX}fetchAPI`;

interface FetchRequest {
  url: string;
  method?: string;
  body?: string | null;
  onResult?: (r: RequestOutcome) => void;
}

interface RequestOutcome {
  latencyMs: number;
  status: number;
}

interface WSRequestBody {
  currentDevice: string;
  startDate: string;
  endDate: string;
  searchValue: string;
  filters?: { region?: string; tableType: string };
}

export interface WSResponse {
  totalValue: number | null;
  [k: string]: unknown;
}

interface FetchError extends Error {
  status?: number;
  statusText?: string;
}

function makeFetchError(status: number, name: string, message: string): FetchError {
  const err = new Error(message) as FetchError;
  err.status = status;
  err.name = name;
  return err;
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
      .map((c) => c.split('=').map((s) => s.trim()))
      .filter((pair): pair is [string, string] =>
        pair.length >= 2 && REQUIRED_COOKIES.includes(pair[0])
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
    let response: { success: boolean; data: WSResponse; error?: { message?: string; status?: number; name?: string } };
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
      reportedStatus = 200;
      return response.data;
    }

    const err = makeFetchError(
      response.error?.status ?? 0,
      response.error?.name ?? 'FetchError',
      response.error?.message ?? 'Background fetch failed'
    );
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
    if (e.status && e.status >= 400 && e.status < 500) {
      throw error;
    }
    if (attempt < FETCH_MAX_RETRIES) {
      const delay = Math.min(
        FETCH_RETRY_DELAY_MS * Math.pow(2, attempt),
        FETCH_MAX_RETRY_DELAY_MS
      );
      await new Promise((r) => setTimeout(r, delay));
      return fetchVariantWithRetry(query, region, deviceTypes, attempt + 1, onResult);
    }
    throw error;
  }
}
