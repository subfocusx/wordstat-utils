// tests/api.test.js
import { fetchViaBackground, fetchWS, fetchVariantWithRetry } from '../src/content/api.ts';
import { FETCH_MAX_RETRIES, FETCH_MAX_RETRY_DELAY_MS } from '../src/config.ts';
import { installChromeShim, dispatchMessage } from './helpers.ts';

describe('fetchViaBackground (M8 whitelist)', () => {
  beforeEach(() => {
    installChromeShim();
  });

  test('rejects non-whitelisted URL', async () => {
    await expect(
      fetchViaBackground({ url: 'https://evil.example.com/foo', method: 'POST', body: '{}' })
    ).rejects.toThrow(/non-whitelisted/);
  });

  test('passes through to background for whitelisted URL', async () => {
    global.chrome.runtime.sendMessage.mockResolvedValue({
      success: true,
      data: { totalValue: 100 }
    });
    const result = await fetchViaBackground({
      url: 'https://wordstat.yandex.ru/wordstat/api/search',
      method: 'POST',
      body: '{}'
    });
    expect(result).toEqual({ totalValue: 100 });
    expect(global.chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  test('throws on !success response', async () => {
    global.chrome.runtime.sendMessage.mockResolvedValue({
      success: false,
      error: { message: 'bad', status: 500, name: 'APIError' }
    });
    await expect(
      fetchViaBackground({
        url: 'https://wordstat.yandex.ru/wordstat/api/search',
        method: 'POST',
        body: '{}'
      })
    ).rejects.toMatchObject({ status: 500 });
  });

  test('throws when sendMessage returns undefined', async () => {
    global.chrome.runtime.sendMessage.mockResolvedValue(undefined);
    await expect(
      fetchViaBackground({
        url: 'https://wordstat.yandex.ru/wordstat/api/search',
        method: 'POST',
        body: '{}'
      })
    ).rejects.toThrow(/No response/);
  });
});

describe('fetchWS', () => {
  beforeEach(() => {
    installChromeShim();
  });

  test('sends payload with required fields', async () => {
    global.chrome.runtime.sendMessage.mockResolvedValue({
      success: true,
      data: { totalValue: 42 }
    });
    await fetchWS('купить', '213', 'desktop');
    const args = global.chrome.runtime.sendMessage.mock.calls[0][0];
    const body = JSON.parse(args.payload.body);
    expect(body.searchValue).toBe('купить');
    expect(body.currentDevice).toBe('desktop');
    expect(body.filters).toEqual({ region: '213', tableType: 'popular' });
  });

  test('uses default device when none provided', async () => {
    global.chrome.runtime.sendMessage.mockResolvedValue({
      success: true,
      data: { totalValue: 42 }
    });
    await fetchWS('купить', null, null);
    const args = global.chrome.runtime.sendMessage.mock.calls[0][0];
    const body = JSON.parse(args.payload.body);
    expect(body.currentDevice).toBe('desktop,phone,tablet');
  });

  test('throws on empty query', async () => {
    await expect(fetchWS('', null, null)).rejects.toThrow(/empty query/);
  });
});

describe('fetchVariantWithRetry', () => {
  beforeEach(() => {
    installChromeShim();
  });

  test('returns immediately on success', async () => {
    global.chrome.runtime.sendMessage.mockResolvedValue({
      success: true,
      data: { totalValue: 1 }
    });
    await expect(fetchVariantWithRetry('q', null, null)).resolves.toEqual({ totalValue: 1 });
    expect(global.chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  test('does NOT retry on 4xx errors', async () => {
    global.chrome.runtime.sendMessage.mockRejectedValue({
      status: 401,
      message: 'unauthorized'
    });
    await expect(fetchVariantWithRetry('q', null, null)).rejects.toMatchObject({
      status: 401
    });
    expect(global.chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  function hijackSetTimeout(): () => void {
    const orig = global.setTimeout.bind(global);
    (global as any).setTimeout = (fn: (...args: unknown[]) => void, _ms?: number, ...args: unknown[]) => {
      return (orig as any)(fn, 0, ...args);
    };
    return () => { (global as any).setTimeout = orig; };
  }

  test('retries up to FETCH_MAX_RETRIES times on 5xx errors', async () => {
    const restore = hijackSetTimeout();
    global.chrome.runtime.sendMessage.mockRejectedValue({
      status: 503,
      message: 'down'
    });
    await expect(fetchVariantWithRetry('q', null, null)).rejects.toMatchObject({
      status: 503
    });
    // 1 initial attempt + FETCH_MAX_RETRIES retries.
    expect(global.chrome.runtime.sendMessage).toHaveBeenCalledTimes(1 + FETCH_MAX_RETRIES);
    restore();
  });

  test('eventually succeeds after transient failure', async () => {
    const restore = hijackSetTimeout();
    let n = 0;
    global.chrome.runtime.sendMessage.mockImplementation(async () => {
      n++;
      if (n < 3) {
        const e = new Error('boom');
        e.status = 503;
        throw e;
      }
      return { success: true, data: { totalValue: 99 } };
    });
    const result = await fetchVariantWithRetry('q', null, null);
    expect(result).toEqual({ totalValue: 99 });
    expect(n).toBe(3);
    restore();
  });

  test('caps retry backoff delay at FETCH_MAX_RETRY_DELAY_MS', async () => {
    const delays: number[] = [];
    const orig = global.setTimeout.bind(global);
    (global as any).setTimeout = (fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      delays.push(ms ?? 0);
      return (orig as any)(fn, 0, ...args);
    };
    try {
      global.chrome.runtime.sendMessage.mockRejectedValue({
        status: 503,
        message: 'down'
      });
      await expect(fetchVariantWithRetry('q', null, null)).rejects.toMatchObject({
        status: 503
      });
      expect(global.chrome.runtime.sendMessage).toHaveBeenCalledTimes(1 + FETCH_MAX_RETRIES);
      // One backoff sleep before each retry: 1s, 2s, 4s (all <= the 5s cap).
      expect(delays).toEqual([1000, 2000, 4000]);
      delays.forEach((d) => expect(d).toBeLessThanOrEqual(FETCH_MAX_RETRY_DELAY_MS));
    } finally {
      (global as any).setTimeout = orig;
    }
  });
});