// src/background.ts
// MV3 service worker.
// [M8] Whitelist URL in background — закрывает SSRF-вектор.

import {
  BACKGROUND_ALLOWED_ORIGINS,
  BACKGROUND_ALLOWED_PATHS,
  CONTENT_TYPE,
  FETCH_TIMEOUT_MS,
  PREFIX
} from './config.ts';
import { type FetchPayload } from './lib/types.ts';

const MSG_FETCH = `${PREFIX}fetchAPI`;

/** Serialisable error shape sent back to the content script. */
interface WireError {
  message: string;
  status?: number;
  statusText?: string;
  name: string;
}
const ALLOWED_METHODS: Readonly<Record<string, true>> = { GET: true, POST: true };

/**
 * Exact-origin match against the allowlist. Deliberately no `endsWith`:
 * `https://evil-wordstat.yandex.ru.attacker.com` must not pass, and any
 * future subdomain has to be listed here explicitly.
 */
function isAllowedUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    BACKGROUND_ALLOWED_ORIGINS[parsed.origin] === true &&
    BACKGROUND_ALLOWED_PATHS[parsed.pathname] === true
  );
}

/**
 * Only messages from this extension's own content scripts may drive fetches.
 * `chrome.runtime.id` is always defined in a real extension; the guard is
 * skipped only in test environments where the shim omits it.
 */
function isTrustedSender(sender: chrome.runtime.MessageSender | undefined): boolean {
  if (!sender) return false;
  if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
    if (sender.id !== chrome.runtime.id) return false;
  }
  if (sender.url && !sender.url.startsWith('https://wordstat.yandex.')) {
    return false;
  }
  return true;
}

function fail(err: unknown, sendResponse: (r: unknown) => void): void {
  const e = err as Partial<WireError> & { message?: string };
  const wire: WireError = {
    message: e.message || 'Network error',
    name: e.name || 'FetchError'
  };
  if (e.status !== undefined) wire.status = e.status;
  if (e.statusText !== undefined) wire.statusText = e.statusText;
  sendResponse({ success: false, error: wire });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.type !== MSG_FETCH) {
    return false;
  }
  if (!isTrustedSender(sender)) {
    sendResponse({
      success: false,
      error: { message: 'Untrusted sender', status: 403, name: 'Forbidden' }
    });
    return false;
  }
  const payload = request.payload as FetchPayload | undefined;
  handleFetch(payload)
    .then((data) => sendResponse({ success: true, data }))
    .catch((err: unknown) => fail(err, sendResponse));
  return true; // indicates async sendResponse
});

async function handleFetch(payload: FetchPayload | undefined): Promise<unknown> {
  const { url, method = 'GET', body = null, cookies = '' } = payload ?? {};
  if (!url) {
    throw Object.assign(new Error('Missing URL'), { status: 400, name: 'BadRequest' });
  }
  if (typeof method !== 'string' || ALLOWED_METHODS[method] !== true) {
    throw Object.assign(new Error(`Method not allowed: ${method}`), {
      status: 405,
      name: 'BadRequest'
    });
  }
  if (body !== null && typeof body !== 'string') {
    throw Object.assign(new Error('Body must be a string'), {
      status: 400,
      name: 'BadRequest'
    });
  }

  if (!isAllowedUrl(url)) {
    throw Object.assign(new Error(`URL not allowed: ${url}`), { status: 403, name: 'Forbidden' });
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': CONTENT_TYPE.JSON
  };
  // An empty Cookie header is not the same as no Cookie header — some
  // backends treat the literal empty value as a malformed credential.
  if (cookies) headers.Cookie = cookies;

  // Abort long-hanging requests so a throttled/dropped connection can't
  // occupy a queue slot indefinitely. On abort fetch() rejects with
  // AbortError, which is reported to the content script and retried there.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
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

  return readJson(response);
}

/**
 * Yandex answers with an HTML login/captcha page instead of JSON when the
 * session cookies are stale. That is a distinct failure mode from a network
 * error, so it is reported with the upstream status and its own error name
 * — the content script decides whether retrying can possibly help.
 */
async function readJson(response: Response): Promise<unknown> {
  const contentType = response.headers?.get?.('content-type') ?? '';
  if (contentType && !contentType.includes('json')) {
    throw Object.assign(new Error(`Unexpected non-JSON response (${contentType})`), {
      status: response.status,
      statusText: response.statusText,
      name: 'InvalidResponseError'
    });
  }
  try {
    return await response.json();
  } catch {
    throw Object.assign(new Error('Malformed JSON response'), {
      status: response.status,
      statusText: response.statusText,
      name: 'InvalidResponseError'
    });
  }
}