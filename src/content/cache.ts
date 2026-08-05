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
  type CacheShape,
  type FetcherVariantKey
} from '../config.ts';
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
    for (const region in regionMap) {
      if (!Object.prototype.hasOwnProperty.call(regionMap, region)) continue;
      const deviceMap = regionMap[region];
      for (const device in deviceMap) {
        if (!Object.prototype.hasOwnProperty.call(deviceMap, device)) continue;
        const entry = deviceMap[device];
        if (entry?.date) {
          entries.push({
            query,
            region,
            device,
            date: new Date(entry.date).getTime(),
            lastAccessedAt: entry.lastAccessedAt ?? new Date(entry.date).getTime()
          });
        }
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
  const entry = allData[query]?.[effectiveRegion]?.[effectiveDevice];

  if (!entry?.date) return null;

  const cacheAge = Date.now() - new Date(entry.date).getTime();
  if (cacheAge >= CACHE_DURATION_MS) return null;

  const baseValue = entry.base === CACHE_NULL_PLACEHOLDER ? null : entry.base;
  const variants = (entry.variants ?? []).map((v: string | number | null) =>
    v === CACHE_NULL_PLACEHOLDER ? null : v
  );
  const errored = entry.errored === true;
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

  const allData = _loadCache(storage);
  if (!allData[query]) allData[query] = {};
  if (!allData[query][effectiveRegion]) allData[query][effectiveRegion] = {};

  const placeholderOr = (v: string | number | null | undefined): string | number | null =>
    v === null || v === undefined ? CACHE_NULL_PLACEHOLDER : v;

  allData[query][effectiveRegion][effectiveDevice] = {
    date: new Date().toISOString(),
    lastAccessedAt: Date.now(),
    base: placeholderOr(results.base),
    variants: (results.variants ?? []).map(placeholderOr),
    errored: results.errored === true
  };

  if (flattenEntries(allData).length > CACHE_MAX_ENTRIES) {
    evictOldestEntries(allData, { hardCap: true });
  }

  let ok = writeCacheRaw(JSON.stringify(allData), storage);
  if (ok) {
    _cacheRaw = null;
  } else {
    evictOldestEntries(allData);
    ok = writeCacheRaw(JSON.stringify(allData), storage);
    if (ok) {
      _cacheRaw = null;
    } else {
      logger.error('Error saving cache even after cleanup.');
    }
  }
  return ok;
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