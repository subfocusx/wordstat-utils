// src/background.js
// MV3 service worker.
// [M8] Whitelist URL in background — закрывает SSRF-вектор

import {
  BACKGROUND_ALLOWED_ORIGINS,
  BACKGROUND_ALLOWED_PATHS,
  CONTENT_TYPE,
  FETCH_TIMEOUT_MS,
  PREFIX
} from './config.ts';

const MSG_FETCH = `${PREFIX}fetchAPI`;

export interface FetchPayload {
  url?: string;
  method?: string;
  body?: string | null;
  cookies?: string;
}

function isAllowedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const originMatch = Array.from(BACKGROUND_ALLOWED_ORIGINS).some(
      (allowed) => parsed.origin === allowed || parsed.origin.endsWith(allowed)
    );
    const pathMatch = BACKGROUND_ALLOWED_PATHS.has(parsed.pathname);
    return originMatch && pathMatch;
  } catch {
    return false;
  }
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request?.type === MSG_FETCH) {
    handleFetch(request.payload as FetchPayload)
      .then((data) => sendResponse({ success: true, data }))
      .catch((err: { message?: string; status?: number; name?: string }) =>
        sendResponse({
          success: false,
          error: {
            message: err.message || 'Network error',
            status: err.status,
            name: err.name || 'FetchError'
          }
        })
      );
    return true; // indicates async sendResponse
  }
  return false;
});

async function handleFetch(payload: FetchPayload | undefined): Promise<unknown> {
  const { url, method = 'GET', body = null, cookies = '' } = payload || {};
  if (!url) {
    throw Object.assign(new Error('Missing URL'), { status: 400, name: 'BadRequest' });
  }

  if (!isAllowedUrl(url)) {
    throw Object.assign(new Error(`URL not allowed: ${url}`), { status: 403, name: 'Forbidden' });
  }

  // Abort long-hanging requests so a throttled/dropped connection can't
  // occupy a queue slot indefinitely. On abort fetch() rejects with
  // AbortError, which is reported to the content script and retried there.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': CONTENT_TYPE.JSON,
        Cookie: cookies
      },
      body,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw Object.assign(new Error(`API request failed with status ${response.status}`), {
      status: response.status,
      statusText: response.statusText,
      name: 'APIError'
    });
  }

  return response.json();
}
