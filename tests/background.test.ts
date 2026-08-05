// tests/background.test.js
// Mirrors the original v1.3.2.2 background.js: pass-through fetch with
// cookies supplied by the caller via payload. No URL whitelist, no
// chrome.cookies.getAll(). The handler treats `payload.cookies` as the
// Cookie header verbatim.
import { installChromeShim, dispatchMessage } from './helpers.ts';
import { FETCH_TIMEOUT_MS } from '../src/config.ts';

describe('background service worker', () => {
  let chrome;

  beforeEach(async () => {
    jest.resetModules();
    chrome = installChromeShim();
    await import('../src/background.ts');
  });

  test('registers an onMessage listener', () => {
    expect(chrome.runtime.onMessage.addListener).toHaveBeenCalled();
  });

  test('forwards to fetch with cookies passed via payload', async () => {
    const realFetch = global.fetch;
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ totalValue: 7 })
    }));
    global.fetch = fetchMock;

    const response = await dispatchMessage({
      type: 'gfd_fetchAPI',
      payload: {
        url: 'https://wordstat.yandex.ru/wordstat/api/search',
        method: 'POST',
        body: '{"searchValue":"x"}',
        cookies: 'sid=abc; yandexuid=xyz'
      }
    });

    global.fetch = realFetch;

    expect(response.success).toBe(true);
    expect(response.data).toEqual({ totalValue: 7 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, opts] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe('https://wordstat.yandex.ru/wordstat/api/search');
    expect(opts.headers.Cookie).toBe('sid=abc; yandexuid=xyz');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(opts.method).toBe('POST');
    expect(opts.body).toBe('{"searchValue":"x"}');
  });

  test('forwards upstream error status', async () => {
    const realFetch = global.fetch;
    const fetchMock = jest.fn(async () => ({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway'
    }));
    global.fetch = fetchMock;

    const response = await dispatchMessage({
      type: 'gfd_fetchAPI',
      payload: {
        url: 'https://wordstat.yandex.ru/wordstat/api/search',
        method: 'POST',
        body: '{}',
        cookies: ''
      }
    });

    global.fetch = realFetch;

    expect(response.success).toBe(false);
    expect(response.error.status).toBe(502);
    expect(response.error.name).toBe('APIError');
  });

  test('handles missing URL', async () => {
    const response = await dispatchMessage({
      type: 'gfd_fetchAPI',
      payload: { method: 'POST' }
    });
    expect(response.success).toBe(false);
    expect(response.error.status).toBe(400);
    expect(response.error.name).toBe('BadRequest');
  });

  test('aborts a hanging fetch after FETCH_TIMEOUT_MS', async () => {
    jest.useFakeTimers();
    const realFetch = global.fetch;
    try {
      global.fetch = jest.fn((_url, opts) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        })
      );

      const responsePromise = dispatchMessage({
        type: 'gfd_fetchAPI',
        payload: {
          url: 'https://wordstat.yandex.ru/wordstat/api/search',
          method: 'POST',
          body: '{}',
          cookies: ''
        }
      });

      await jest.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS);
      const response = await responsePromise;

      expect(response.success).toBe(false);
      expect(response.error.name).toBe('AbortError');
    } finally {
      global.fetch = realFetch;
      jest.useRealTimers();
    }
  });

  test('does not abort a fast fetch', async () => {
    jest.useFakeTimers();
    const realFetch = global.fetch;
    try {
      global.fetch = jest.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ totalValue: 3 })
      }));

      const responsePromise = dispatchMessage({
        type: 'gfd_fetchAPI',
        payload: {
          url: 'https://wordstat.yandex.ru/wordstat/api/search',
          method: 'POST',
          body: '{}',
          cookies: ''
        }
      });
      await jest.advanceTimersByTimeAsync(10);
      const response = await responsePromise;

      expect(response.success).toBe(true);
      expect(response.data).toEqual({ totalValue: 3 });
    } finally {
      global.fetch = realFetch;
      jest.useRealTimers();
    }
  });
});
