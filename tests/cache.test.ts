// tests/cache.test.js
import {
  parseCacheData,
  readCacheRaw,
  writeCacheRaw,
  evictOldestEntries,
  getFromLocalStorage,
  saveToLocalStorage,
  getVariantFromCache,
  saveVariantToCache
} from '../src/content/cache.ts';
import {
  CACHE_DURATION_MS,
  CACHE_MAX_ENTRIES,
  CACHE_NULL_PLACEHOLDER,
  LS_CACHE_KEY
} from '../src/config.ts';
import { makeStorage } from './helpers.ts';

describe('parseCacheData', () => {
  test('returns {} for null/empty', () => {
    expect(parseCacheData(null)).toEqual({});
    expect(parseCacheData('')).toEqual({});
  });
  test('parses valid JSON', () => {
    const data = { foo: { bar: { baz: { date: '2024-01-01' } } } };
    expect(parseCacheData(JSON.stringify(data))).toEqual(data);
  });
  test('returns {} for malformed JSON', () => {
    expect(parseCacheData('{bad')).toEqual({});
  });
});

describe('writeCacheRaw / readCacheRaw', () => {
  test('roundtrip', () => {
    const s = makeStorage();
    writeCacheRaw('{"a":1}', s);
    expect(readCacheRaw(s)).toBe('{"a":1}');
    expect(s.setItem).toHaveBeenCalledWith(LS_CACHE_KEY, '{"a":1}');
  });
  test('returns false on QuotaExceededError', () => {
    const s = {
      setItem: () => {
        const e = new Error('quota');
        e.name = 'QuotaExceededError';
        throw e;
      }
    };
    expect(writeCacheRaw('{}', s)).toBe(false);
  });
});

describe('evictOldestEntries', () => {
  test('removes oldest entries by lastAccessedAt', () => {
    const data = {
      q1: { r1: { d1: { date: '2024-01-01', lastAccessedAt: 100 } } },
      q2: { r1: { d1: { date: '2024-01-02', lastAccessedAt: 200 } } },
      q3: { r1: { d1: { date: '2024-01-03', lastAccessedAt: 300 } } }
    };
    evictOldestEntries(data, { ratio: 0.34 }); // 1 of 3
    expect(data.q1).toBeUndefined();
    expect(data.q2).toBeDefined();
    expect(data.q3).toBeDefined();
  });
  test('hardCap enforces max entries', () => {
    const data = {};
    for (let i = 0; i < 10; i++) {
      data[`q${i}`] = {
        r: {
          d: { date: '2024-01-01', lastAccessedAt: i * 1000 }
        }
      };
    }
    // Reduce the cap for the test
    const removed = evictOldestEntries(data, { hardCap: true, ratio: 1.0 });
    expect(removed).toBeGreaterThan(0);
    // 10 entries - hardCap (CACHE_MAX_ENTRIES) = removed
    const remaining = Object.keys(data).length;
    expect(remaining).toBeLessThanOrEqual(CACHE_MAX_ENTRIES);
  });
});

describe('getFromLocalStorage / saveToLocalStorage', () => {
  test('round-trip a complete entry', () => {
    const s = makeStorage();
    saveToLocalStorage('купить', '213', 'desktop,phone', {
      base: 1000,
      variants: [500, 100, 50]
    }, s);
    const got = getFromLocalStorage('купить', '213', 'desktop,phone', s);
    expect(got).not.toBeNull();
    expect(got.base).toBe(1000);
    expect(got.variants).toEqual([500, 100, 50]);
    expect(got.errored).toBe(false);
  });
  test('returns null for missing query', () => {
    const s = makeStorage();
    expect(getFromLocalStorage('nope', null, null, s)).toBeNull();
  });
  test('returns null for expired entry', () => {
    const s = makeStorage();
    // Pre-seed with expired date
    const old = { q: { r: { d: { date: new Date(Date.now() - CACHE_DURATION_MS - 1000).toISOString(), base: 1, variants: [] } } } };
    s.setItem(LS_CACHE_KEY, JSON.stringify(old));
    expect(getFromLocalStorage('q', 'r', 'd', s)).toBeNull();
  });
  test('context-aware: same query, different region → different entries', () => {
    const s = makeStorage();
    saveToLocalStorage('q', '213', 'd', { base: 1, variants: [1] }, s);
    saveToLocalStorage('q', '98598', 'd', { base: 2, variants: [2] }, s);
    expect(getFromLocalStorage('q', '213', 'd', s).base).toBe(1);
    expect(getFromLocalStorage('q', '98598', 'd', s).base).toBe(2);
  });
  test('null placeholders round-trip as null', () => {
    const s = makeStorage();
    saveToLocalStorage('q', null, null, { base: null, variants: [null] }, s);
    const got = getFromLocalStorage('q', null, null, s);
    expect(got.base).toBeNull();
    expect(got.variants[0]).toBeNull();
  });
  test('handles QuotaExceededError by evicting and retrying', () => {
    let writeCount = 0;
    const s = {
      getItem: jest.fn(() => {
        // Pretend the cache is full of stale entries that eviction can remove.
        const data = {};
        for (let i = 0; i < 5; i++) {
          data[`old${i}`] = {
            r: {
              d: {
                date: '2024-01-01',
                lastAccessedAt: i,
                base: 0,
                variants: []
              }
            }
          };
        }
        return JSON.stringify(data);
      }),
      setItem: jest.fn((k, v) => {
        writeCount++;
        if (writeCount === 1) {
          const e = new Error('quota');
          e.name = 'QuotaExceededError';
          throw e;
        }
        s._data = s._data || {};
        s._data[k] = String(v);
      })
    };
    const ok = saveToLocalStorage('new', null, null, { base: 1, variants: [] }, s);
    expect(ok).toBe(true);
    // First setItem throws → eviction runs → second setItem succeeds.
    expect(writeCount).toBe(2);
    // Old entries should have been evicted.
    const finalRaw = s.getItem();
    // After eviction + resave, the stored value is the new one (writeCount=2 succeeded).
    // We can't see the post-eviction state via getItem (it returns the same seed),
    // but we can verify the second write succeeded.
    expect(s._data).toBeDefined();
    expect(s._data[LS_CACHE_KEY]).toContain('"new"');
  });
});

describe('getVariantFromCache / saveVariantToCache', () => {
  test('roundtrip base variant', () => {
    const s = makeStorage();
    saveVariantToCache('q', null, null, 'base', 1234, s);
    expect(getVariantFromCache('q', null, null, 'base', s)).toBe(1234);
  });
  test('roundtrip quoted variant (resultIndex 0)', () => {
    const s = makeStorage();
    saveVariantToCache('q', null, null, 'quoted', 567, s);
    expect(getVariantFromCache('q', null, null, 'quoted', s)).toBe(567);
  });
  test('returns null for unknown variant', () => {
    const s = makeStorage();
    expect(getVariantFromCache('q', null, null, 'nope', s)).toBeNull();
  });
  test('preserves existing entry on partial save', () => {
    const s = makeStorage();
    saveVariantToCache('q', null, null, 'base', 100, s);
    saveVariantToCache('q', null, null, 'quoted', 50, s);
    const entry = getFromLocalStorage('q', null, null, s);
    expect(entry.base).toBe(100);
    expect(entry.variants[0]).toBe(50);
  });
});