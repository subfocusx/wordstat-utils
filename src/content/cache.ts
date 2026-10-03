// src/content/cache.js
// Context-aware localStorage cache for WordStat frequencies.
// Adds LRU eviction (M3 fix) and explicit error/empty separation (M10 partial).

import {
  CACHE_DURATION_MS,
  CACHE_MAX_ENTRIES,
  CACHE_NULL_PLACEHOLDER,
  CACHE_QUOTA_CLEANUP_RATIO,
  COLUMN_CONFIGS,
  FETCHER_VARIANTS,
  LS_CACHE_KEY,
  type FetcherVariantKey
} from '../config.ts';

/** Strongly-typed cache entry shape (lives with the cache, not in config). */
export interface CacheEntry {
  date: string;
  lastAccessedAt: number;
  base: string | number | null;
  variants: Array<string | number | null>;
  errored?: boolean;
}

/** Strongly-typed cache map. */
export interface CacheShape {
  [query: string]: {
    [region: string]: {
      [device: string]: CacheEntry;
    };
  };
}
import { logger } from './logger.ts';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

interface FlattenedEntry {
  query: string;
  region: string;
  device: string;
  date: number;
  lastAccessedAt: number;
}

interface EvictOpts {
  ratio?: number;
  hardCap?: boolean;
}

export interface CachedResult {
  base: string | number | null;
  variants: Array<string | number | null>;
  errored?: boolean;
  date: string;
}

/** Error type для fetcher state — отделяет ошибки сети от пустых значений кэша. */
export class FetcherError extends Error {
  query: string;
  variantKey: FetcherVariantKey;
  apiQuery: string;
  jobIndex: number;
  region: string | null;
  deviceTypes: string | null;
  timestamp: number;
  
  constructor(
    message: string,
    query: string,
    variantKey: FetcherVariantKey,
    apiQuery: string,
    jobIndex: number,
    region: string | null,
    deviceTypes: string | null
  ) {
    super(message);
    this.name = 'FetcherError';
    this.query = query;
    this.variantKey = variantKey;
    this.apiQuery = apiQuery;
    this.jobIndex = jobIndex;
    this.region = region;
    this.deviceTypes = deviceTypes;
    this.timestamp = Date.now();
  }
  
  static is(err: unknown): err is FetcherError {
    return err instanceof FetcherError;
  }
}

export { FetcherError as FETCH_ERROR }; // alias для обратной совместимости

let _cacheRaw: string | null = null;
let _cacheParsed: CacheShape = {};

function _loadCache(storage?: StorageLike): CacheShape {
  const raw = readCacheRaw(storage);
  if (raw !== _cacheRaw) {
    _cacheRaw = raw;
    _cacheParsed = parseCacheData(raw);
  }
  return _cacheParsed;
}

/**
 * Structural copy two levels deep: every query/region map becomes a fresh
 * object, entry objects are shared (they are replaced, never mutated).
 * Used so a failed localStorage write cannot leave evicted/modified state
 * behind in the shared in-memory cache.
 */
function _cloneCacheShallow(cacheData: CacheShape): CacheShape {
  const out: CacheShape = {};
  for (const query in cacheData) {
    if (!Object.prototype.hasOwnProperty.call(cacheData, query)) continue;
    const regionMap = cacheData[query];
    if (!regionMap || typeof regionMap !== 'object') continue;
    const regionCopy: Record<string, Record<string, CacheEntry>> = {};
    for (const region in regionMap) {
      if (!Object.prototype.hasOwnProperty.call(regionMap, region)) continue;
      const deviceMap = regionMap[region];
      if (!deviceMap || typeof deviceMap !== 'object') continue;
      regionCopy[region] = { ...deviceMap };
    }
    out[query] = regionCopy;
  }
  return out;
}

export function parseCacheData(rawJson: string | null): CacheShape {
  if (!rawJson) return {};
  try {
    const data = JSON.parse(rawJson);
    return typeof data === 'object' && data !== null ? data : {};
  } catch {
    return {};
  }
}

export function invalidateCache(): void {
  _cacheRaw = null;
}

export function readCacheRaw(storage?: StorageLike): string {
  const s = storage ?? localStorage;
  return s.getItem(LS_CACHE_KEY) || '{}';
}

export function writeCacheRaw(jsonString: string, storage?: StorageLike): boolean {
  const s = storage ?? localStorage;
  try {
    s.setItem(LS_CACHE_KEY, jsonString);
    return true;
  } catch (e: unknown) {
    const err = e as { name?: string };
    if (err?.name === 'QuotaExceededError' || err?.name === 'NS_ERROR_DOM_QUOTA_REACHED') {
      return false;
    }
    logger.error('Error saving to local storage:', e);
    return false;
  }
}

function flattenEntries(cacheData: CacheShape): FlattenedEntry[] {
  const entries: FlattenedEntry[] = [];
  for (const query in cacheData) {
    if (!Object.prototype.hasOwnProperty.call(cacheData, query)) continue;
    const regionMap = cacheData[query];
    if (!regionMap || typeof regionMap !== 'object') continue;
    for (const region in regionMap) {
      if (!Object.prototype.hasOwnProperty.call(regionMap, region)) continue;
      const deviceMap = regionMap[region];
      if (!deviceMap || typeof deviceMap !== 'object') continue;
      for (const device in deviceMap) {
        if (!Object.prototype.hasOwnProperty.call(deviceMap, device)) continue;
        const entry = deviceMap[device] as CacheEntry | undefined;
        if (!entry || typeof entry !== 'object' || typeof entry.date !== 'string') continue;
        const ts = new Date(entry.date).getTime();
        if (Number.isNaN(ts)) continue;
        entries.push({
          query,
          region,
          device,
          date: ts,
          lastAccessedAt:
            typeof entry.lastAccessedAt === 'number' && Number.isFinite(entry.lastAccessedAt)
              ? entry.lastAccessedAt
              : ts
        });
      }
    }
  }
  return entries;
}

export function evictOldestEntries(cacheData: CacheShape, opts: EvictOpts = {}): number {
  const ratio = opts.ratio ?? CACHE_QUOTA_CLEANUP_RATIO;
  const hardCap = opts.hardCap ?? false;
  const entries = flattenEntries(cacheData);
  if (entries.length === 0) return 0;

  let entriesToRemoveCount: number;
  if (hardCap && entries.length > CACHE_MAX_ENTRIES) {
    entriesToRemoveCount = entries.length - CACHE_MAX_ENTRIES;
  } else {
    entriesToRemoveCount = Math.max(1, Math.floor(entries.length * ratio));
  }
  entries.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
  const toRemove = entries.slice(0, entriesToRemoveCount);

  let removedCount = 0;
  for (const item of toRemove) {
    if (cacheData[item.query]?.[item.region]?.[item.device]) {
      delete cacheData[item.query][item.region][item.device];
      removedCount++;
      if (Object.keys(cacheData[item.query][item.region]).length === 0) {
        delete cacheData[item.query][item.region];
      }
      if (Object.keys(cacheData[item.query]).length === 0) {
        delete cacheData[item.query];
      }
    }
  }
  return removedCount;
}

export function getFromLocalStorage(
  query: string,
  region: string | null,
  deviceTypes: string | null,
  storage?: StorageLike
): CachedResult | null {
  if (!query) return null;
  const effectiveRegion = region ?? '';
  const effectiveDevice = deviceTypes ?? '';

  const allData = _loadCache(storage);
  const entry = allData[query]?.[effectiveRegion]?.[effectiveDevice] as CacheEntry | undefined;

  if (!entry || typeof entry !== 'object' || typeof entry.date !== 'string') return null;

  const entryTime = new Date(entry.date).getTime();
  if (Number.isNaN(entryTime)) return null;

  const cacheAge = Date.now() - entryTime;
  if (cacheAge >= CACHE_DURATION_MS) return null;

  // Corrupt/legacy payloads can hold anything here; normalize so a malformed
  // `variants` cannot poison every downstream index lookup.
  const rawVariants: unknown[] = Array.isArray(entry.variants) ? entry.variants : [];
  const variants: Array<string | number | null> = rawVariants.map((v) => {
    if (v === CACHE_NULL_PLACEHOLDER) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string' && v.trim() !== '') return v;
    return null;
  });
  const baseValue = entry.base === CACHE_NULL_PLACEHOLDER ? null : entry.base;
  const errored = entry.errored === true;

  // Real LRU: a cache hit is an access. Touch the in-memory entry so the next
  // eviction pass ranks it as recently used. Persistence is deferred to the
  // next write, so reads stay free of synchronous storage I/O.
  entry.lastAccessedAt = Date.now();

  return { base: baseValue, variants, errored, date: entry.date };
}

export function saveToLocalStorage(
  query: string,
  region: string | null,
  deviceTypes: string | null,
  results: CachedResult,
  storage?: StorageLike
): boolean {
  if (!query || !results) {
    logger.warn('Attempted to save empty query or results to cache.');
    return false;
  }
  const effectiveRegion = region ?? '';
  const effectiveDevice = deviceTypes ?? '';

  // Copy-on-write: build the candidate state on a clone and publish it into
  // the shared in-memory cache only once the write actually succeeded.
  // Mutating `_cacheParsed` first meant a quota failure left the process
  // believing entries had been stored (and evicted) while storage still held
  // the old state.
  const candidate = _cloneCacheShallow(_loadCache(storage));
  const queryMap = candidate[query] ?? {};
  const regionMap = queryMap[effectiveRegion] ?? {};

  const placeholderOr = (v: unknown): string | number | null =>
    v === null || v === undefined ? CACHE_NULL_PLACEHOLDER : (v as string | number);

  // Merge variants by index against what is already stored: a caller that
  // only knows resultIndex 1 must not truncate indices 0 and 2.
  const existing = regionMap[effectiveDevice] as CacheEntry | undefined;
  const previousVariants: unknown[] = Array.isArray(existing?.variants)
    ? (existing!.variants as unknown[])
    : [];
  const incomingVariants: unknown[] = Array.isArray(results.variants)
    ? (results.variants as unknown[])
    : [];
  const mergedLength = Math.max(previousVariants.length, incomingVariants.length);
  const mergedVariants: Array<string | number | null> = [];
  for (let i = 0; i < mergedLength; i++) {
    mergedVariants.push(
      placeholderOr(i < incomingVariants.length ? incomingVariants[i] : previousVariants[i])
    );
  }

  const newEntry: CacheEntry = {
    date: new Date().toISOString(),
    lastAccessedAt: Date.now(),
    base: placeholderOr(results.base),
    variants: mergedVariants,
    errored: results.errored === true
  };

  regionMap[effectiveDevice] = newEntry;
  queryMap[effectiveRegion] = regionMap;
  candidate[query] = queryMap;

  const persist = (): boolean => {
    const json = JSON.stringify(candidate);
    if (!writeCacheRaw(json, storage)) return false;
    _cacheParsed = candidate;
    _cacheRaw = json;
    return true;
  };

  if (flattenEntries(candidate).length > CACHE_MAX_ENTRIES) {
    evictOldestEntries(candidate, { hardCap: true });
  }

  if (persist()) return true;

  evictOldestEntries(candidate);
  if (persist()) return true;

  logger.error('Error saving cache even after cleanup.');
  return false;
}

export function getVariantFromCache(
  baseQuery: string,
  region: string | null,
  deviceTypes: string | null,
  variantKey: FetcherVariantKey,
  storage?: StorageLike
): string | number | null {
  if (!baseQuery) return null;
  const entry = getFromLocalStorage(baseQuery, region, deviceTypes, storage);
  if (!entry) return null;
  if (variantKey === 'base') return entry.base;
  const info = FETCHER_VARIANTS[variantKey];
  if (!info || info.resultIndex < 0) return null;
  const value = entry.variants?.[info.resultIndex];
  return value === undefined ? null : value;
}

export function saveVariantToCache(
  baseQuery: string,
  region: string | null,
  deviceTypes: string | null,
  variantKey: FetcherVariantKey,
  value: string | number | null,
  storage?: StorageLike
): boolean {
  if (!baseQuery) return false;
  const current: CachedResult =
    getFromLocalStorage(baseQuery, region, deviceTypes, storage) || { base: null, variants: [], date: new Date().toISOString() };

  if (variantKey === 'base') {
    current.base = value;
  } else {
    const info = FETCHER_VARIANTS[variantKey];
    if (!info || info.resultIndex < 0) return false;
    if (!current.variants) current.variants = [];
    const maxIndex = COLUMN_CONFIGS.reduce((m, c) => Math.max(m, c.resultIndex), -1);
    while (current.variants.length <= maxIndex) current.variants.push(null);
    current.variants[info.resultIndex] = value;
  }
  return saveToLocalStorage(baseQuery, region, deviceTypes, current, storage);
}

// Export FetcherError from cache for cross-module communication