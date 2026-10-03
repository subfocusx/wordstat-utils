// src/content/fetchLogic.ts
// Row-click and column-header fetch orchestration.
// CLONED FROM ORIGINAL v1.3.2.2 modules/fetchLogic.js — same logic, TypeScript
// types added. Any divergence from the original is unintentional; please diff
// against /c/Users/admin/AppData/Local/Google/Chrome/User Data/Default/Extensions/pfocjoohpmikggjeoldecjmiajjekfoj/1.3.2.2_0/modules/fetchLogic.js
// before changing anything in this file.

import {
  CELL_STATE,
  COLUMN_CONFIGS,
  COLUMN_INDEX,
  CSS_CLASSES,
  DATASET_KEYS,
  DOM_SELECTORS,
  RATE_LIMIT,
  UI_TEXT,
  type ColumnConfig,
  type FetcherVariantKey
} from '../config.ts';
import { logger } from './logger.ts';
import { fetchVariantWithRetry } from './api.ts';
import { type WSResponse } from '../lib/types.ts';
import {
  getApiQueryForVariant,
  getCurrentDeviceTypes,
  getCurrentRegion,
  getQueryForRow,
  isCellLoadingOrError,
  isColumnEnabled
} from './utils.ts';
import { getFromLocalStorage, saveToLocalStorage, type CachedResult } from './cache.ts';
import { setCellState, updateRowDisplayFromCache } from './ui.ts';
import { AdaptiveRateLimiter } from './rate-limiter.ts';
import { createRateLimitedQueue } from './queue.ts';

// Column and row fetches share one adaptive limiter, so pacing, concurrency
// and the reaction to 429/5xx are global rather than hardcoded per call site.
const sharedLimiter = new AdaptiveRateLimiter(RATE_LIMIT);

// A row click fans out at most this many variant requests at once, so clicking
// several rows cannot bypass the shared limiter's pacing entirely.
const ROW_CLICK_MAX_CONCURRENCY = 3;


const FETCHER_VARIANTS_KEY: Record<string, { resultIndex: number }> = {
  quoted: { resultIndex: 0 },
  bracketed: { resultIndex: 1 },
  excluded: { resultIndex: 2 }
};

/**
 * Terminal UI state for a finished fetch.
 *
 * Success → CELL_STATE.VALUE. Failure → a non-busy state (the disabled glyph
 * with the reason in the tooltip), deliberately NOT CELL_STATE.ERROR:
 * `isCellLoadingOrError` counts ERROR as busy, so one failed request locked
 * the cell forever and no later row click or column fetch could retry it.
 */
function _updateCellUIState(
  cell: HTMLElement,
  resultValue: number | null,
  isSuccess: boolean,
  errorMessage: string = '',
  columnStillEnabled: boolean = true
): void {
  if (!cell || !cell.isConnected) return;
  if (!columnStillEnabled) {
    setCellState(cell, CELL_STATE.DISABLED);
    cell.classList.add(CSS_CLASSES.DISABLED);
    cell.title = UI_TEXT.DISABLED_TITLE;
    return;
  }
  if (isSuccess && resultValue !== null) {
    setCellState(cell, CELL_STATE.VALUE, { value: resultValue });
    cell.title = '';
    return;
  }
  setCellState(cell, CELL_STATE.VALUE);
  cell.title = isSuccess
    ? UI_TEXT.ERROR_FETCH_FAILED
    : `${UI_TEXT.ERROR_FETCH_FAILED}: ${errorMessage}`;
}

/**
 * Re-resolve a task's row *after* an await. The node captured before the fetch
 * may have been detached by a Yandex re-render, so fall back to searching the
 * table for the row that now carries the same keyword.
 */
function resolveLiveRow(
  baseQuery: string,
  row: HTMLTableRowElement
): HTMLTableRowElement | null {
  if (row.isConnected && getQueryForRow(row) === baseQuery) return row;
  const rows = Array.from(
    document.querySelectorAll(DOM_SELECTORS.BODY_ROW)
  ) as HTMLTableRowElement[];
  return rows.find((candidate) => getQueryForRow(candidate) === baseQuery) ?? null;
}

function resolveLiveCell(
  row: HTMLTableRowElement,
  baseQuery: string,
  columnIndex: number
): HTMLElement | null {
  const liveRow = resolveLiveRow(baseQuery, row);
  if (!liveRow) return null;
  return (liveRow.children[columnIndex] as HTMLElement | undefined) ?? null;
}

/** Identify variants (excluding base) that need fetching for a row click. */
export function identifyVariantsToFetchForRow(
  row: HTMLTableRowElement,
  baseQuery: string,
  region: string | null,
  deviceTypes: string,
  cachedEntry: CachedResult | null
): Array<{ variantKey: FetcherVariantKey; apiQuery: string; columnIndex: number; resultIndex: number; region: string | null; deviceTypes: string }> {
  const tasksToFetch: Array<{ variantKey: FetcherVariantKey; apiQuery: string; columnIndex: number; resultIndex: number; region: string | null; deviceTypes: string }> = [];

  COLUMN_CONFIGS.forEach((config) => {
    const { index: columnIndex, resultIndex } = config;
    const cell = row.children[columnIndex] as HTMLElement | undefined;
    const variantKey = (Object.keys(FETCHER_VARIANTS_KEY).find(
      (k) => FETCHER_VARIANTS_KEY[k].resultIndex === resultIndex
    ) || 'base') as FetcherVariantKey;
    const variantNeedsFetching = cachedEntry?.variants?.[resultIndex] == null;
    if (
      isColumnEnabled(columnIndex) &&
      variantNeedsFetching &&
      cell &&
      !isCellLoadingOrError(cell)
    ) {
      const apiQuery = getApiQueryForVariant(baseQuery, variantKey);
      if (apiQuery) {
        tasksToFetch.push({ variantKey, apiQuery, columnIndex, resultIndex, region, deviceTypes });
        setCellState(cell, CELL_STATE.PENDING_QUEUE);
        cell.title = UI_TEXT.PENDING_TITLE;
      } else if (cell) {
        setCellState(cell, CELL_STATE.CANNOT_GENERATE);
        cell.title = UI_TEXT.ERROR_CANNOT_GENERATE;
      }
    }
  });
  return tasksToFetch;
}

function formatNumber(value: string | number | null | undefined): string {
  if (value == null) return '';
  const cleaned = String(value).replace(/\s/g, '');
  const num = Number(cleaned);
  if (Number.isNaN(num)) return '';
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** Update cache + UI after a row-click batch completes. */
export function updateCacheAndRowUI(
  row: HTMLTableRowElement,
  baseQuery: string,
  region: string | null,
  deviceTypes: string,
  fetchedTasks: Array<{ variantKey: FetcherVariantKey; apiQuery: string; columnIndex: number; resultIndex: number; region: string | null; deviceTypes: string }>,
  fetchResults: PromiseSettledResult<WSResponse>[],
  initialCachedEntry: CachedResult | null
): void {
  const updatedEntry: CachedResult = initialCachedEntry
    ? { ...initialCachedEntry, variants: [...(initialCachedEntry.variants ?? [])] }
    : { base: null, variants: [], date: new Date().toISOString() };
  if (!updatedEntry.variants) updatedEntry.variants = [];
  const maxResultIndex = COLUMN_CONFIGS.reduce((max, c) => Math.max(max, c.resultIndex), -1);
  while (updatedEntry.variants.length <= maxResultIndex) {
    updatedEntry.variants.push(null);
  }

  fetchResults.forEach((settledResult, i) => {
    const task = fetchedTasks[i];
    const isSuccess = settledResult.status === 'fulfilled';
    const resultValue = isSuccess
      ? (settledResult as PromiseFulfilledResult<WSResponse>).value?.totalValue ?? null
      : null;
    const errorMessage = isSuccess
      ? ''
      : (settledResult as PromiseRejectedResult).reason?.message || 'Unknown Error';

    if (task.resultIndex !== undefined && task.resultIndex >= 0) {
      while (updatedEntry.variants.length <= task.resultIndex) updatedEntry.variants.push(null);
      updatedEntry.variants[task.resultIndex] = resultValue;
    }

    // Re-resolve: the row captured when the batch started may have been
    // re-rendered away while the requests were in flight.
    const cell = resolveLiveCell(row, baseQuery, task.columnIndex);
    if (cell) {
      _updateCellUIState(
        cell,
        resultValue,
        isSuccess,
        errorMessage,
        isColumnEnabled(task.columnIndex)
      );
    }
  });

  saveToLocalStorage(baseQuery, region, deviceTypes, updatedEntry);
  const liveRow = resolveLiveRow(baseQuery, row);
  if (liveRow) {
    liveRow.classList.remove(CSS_CLASSES.PENDING_ROW);
    updateRowDisplayFromCache(liveRow, getFromLocalStorage(baseQuery, region, deviceTypes));
  }
}

/** Fetch all missing variants (excluding base) for a single row on click. */
export async function fetchAllVariantsForRow(row: HTMLTableRowElement): Promise<void> {
  const baseQuery = getQueryForRow(row);
  if (!baseQuery || row.classList.contains(CSS_CLASSES.PENDING_ROW)) return;

  const region = getCurrentRegion();
  const deviceTypes = getCurrentDeviceTypes();

  const cachedEntry = getFromLocalStorage(baseQuery, region, deviceTypes);
  const tasksToFetch = identifyVariantsToFetchForRow(row, baseQuery, region, deviceTypes, cachedEntry);

  if (tasksToFetch.length === 0) {
    updateRowDisplayFromCache(row, cachedEntry);
    return;
  }

  row.classList.add(CSS_CLASSES.PENDING_ROW);
  tasksToFetch.forEach((task) => {
    const cell = row.children[task.columnIndex] as HTMLElement;
    if (cell && cell.dataset[DATASET_KEYS.CELL_STATE] === CELL_STATE.PENDING_QUEUE) {
      setCellState(cell, CELL_STATE.FETCHING);
      cell.title = UI_TEXT.FETCHING_TITLE;
    }
  });

  try {
    // Fan out through a bounded worker pool instead of Promise.allSettled over
    // every variant: a row click used to launch all requests at once, ignoring
    // both the shared limiter's pacing and its adaptive concurrency.
    const results = await runRowClickBatch(tasksToFetch);
    updateCacheAndRowUI(row, baseQuery, region, deviceTypes, tasksToFetch, results, cachedEntry);
  } catch (error: unknown) {
    logger.error('Unexpected error during row fetch:', error);
    const errMsg = (error as Error).message || 'Unknown error';
    tasksToFetch.forEach((task) => {
      const cell = resolveLiveCell(row, baseQuery, task.columnIndex);
      if (cell) _updateCellUIState(cell, null, false, errMsg, isColumnEnabled(task.columnIndex));
    });
  } finally {
    // Always clear the pending marker, otherwise a single throw left the row
    // permanently unclickable.
    const liveRow = resolveLiveRow(baseQuery, row);
    if (liveRow) {
      liveRow.classList.remove(CSS_CLASSES.PENDING_ROW);
      updateRowDisplayFromCache(liveRow, getFromLocalStorage(baseQuery, region, deviceTypes));
    }
  }
}

interface RowClickTask {
  variantKey: FetcherVariantKey;
  apiQuery: string;
  columnIndex: number;
  resultIndex: number;
  region: string | null;
  deviceTypes: string;
}

/**
 * Run a row's variant requests with at most ROW_CLICK_MAX_CONCURRENCY in
 * flight, each start spaced by the shared limiter's jittered delay and each
 * result fed back into it.
 */
async function runRowClickBatch(
  tasks: RowClickTask[]
): Promise<PromiseSettledResult<WSResponse>[]> {
  const results: PromiseSettledResult<WSResponse>[] = new Array(tasks.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const idx = next++;
      if (idx >= tasks.length) return;
      const task = tasks[idx];

      const { promise: paced, resolve: release } = Promise.withResolvers<void>();
      setTimeout(release, sharedLimiter.nextDelayMs());
      await paced;

      try {
        results[idx] = {
          status: 'fulfilled',
          value: await fetchVariantWithRetry(
            task.apiQuery,
            task.region,
            task.deviceTypes,
            0,
            (outcome) => sharedLimiter.recordResult(outcome)
          )
        };
      } catch (reason: unknown) {
        results[idx] = { status: 'rejected', reason };
      }
    }
  };

  const workers = Array.from(
    { length: Math.min(ROW_CLICK_MAX_CONCURRENCY, tasks.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

/** Row click handler. Bound by main.ts. */
export function handleRowClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  if (
    target?.closest(`.${CSS_CLASSES.ACTION_BUTTON}`) ||
    (target?.tagName === 'A' && target.hasAttribute('href'))
  ) {
    return;
  }
  const row = (event.currentTarget as HTMLElement | null)?.closest('tr') as HTMLTableRowElement | null;
  if (row) fetchAllVariantsForRow(row);
}

/** Collect tasks for fetching a specific column across multiple rows. */
export function collectItemsForColumnFetch(
  rows: HTMLTableRowElement[],
  columnIndex: number,
  region: string | null,
  deviceTypes: string
): Array<{
  row: HTMLTableRowElement;
  baseQuery: string;
  variantKey: FetcherVariantKey;
  apiQuery: string;
  columnIndex: number;
  resultIndex: number;
  region: string | null;
  deviceTypes: string;
}> {
  const queue: Array<{
    row: HTMLTableRowElement;
    baseQuery: string;
    variantKey: FetcherVariantKey;
    apiQuery: string;
    columnIndex: number;
    resultIndex: number;
    region: string | null;
    deviceTypes: string;
  }> = [];
  const columnConfig = COLUMN_CONFIGS.find((c: ColumnConfig) => c.index === columnIndex);
  let variantKey: FetcherVariantKey | null = null;
  let resultIndex = -1;

  if (columnIndex === COLUMN_INDEX.BASE_FREQUENCY) {
    variantKey = 'base';
  } else if (columnConfig) {
    variantKey = (Object.keys(FETCHER_VARIANTS_KEY).find(
      (k) => FETCHER_VARIANTS_KEY[k].resultIndex === columnConfig.resultIndex
    ) || null) as FetcherVariantKey | null;
    resultIndex = columnConfig.resultIndex;
  } else {
    return queue;
  }
  if (!variantKey) return queue;

  rows.forEach((row) => {
    const baseQuery = getQueryForRow(row);
    const isGloballyPending = row.classList.contains(CSS_CLASSES.PENDING_ROW);
    const isColFetching = parseInt(row.dataset[DATASET_KEYS.COL_FETCHING] || '', 10) === columnIndex;

    if (!baseQuery || isGloballyPending || isColFetching) return;

    const cachedEntry = getFromLocalStorage(baseQuery, region, deviceTypes);
    const needsFetching =
      variantKey === 'base'
        ? cachedEntry?.base == null
        : cachedEntry?.variants?.[resultIndex] == null;

    const cell = row.children[columnIndex] as HTMLElement | undefined;

    if (needsFetching && cell && !isCellLoadingOrError(cell)) {
      const apiQuery = getApiQueryForVariant(baseQuery, variantKey);
      if (apiQuery) {
        queue.push({ row, baseQuery, variantKey, apiQuery, columnIndex, resultIndex, region, deviceTypes });
        setCellState(cell, CELL_STATE.PENDING_QUEUE);
        cell.title = UI_TEXT.QUEUED_TITLE;
        row.dataset[DATASET_KEYS.COL_FETCHING] = String(columnIndex);
        row.dataset[DATASET_KEYS.QUERY_TO_FETCH] = baseQuery;
      } else if (cell) {
        setCellState(cell, CELL_STATE.CANNOT_GENERATE);
        cell.title = UI_TEXT.ERROR_CANNOT_GENERATE;
      }
    } else if (!needsFetching && cell && !isCellLoadingOrError(cell)) {
      const value = variantKey === 'base' ? cachedEntry?.base : cachedEntry?.variants?.[resultIndex];
      if (cell.textContent !== formatNumber(value) && cell.textContent !== CELL_STATE.DISABLED) {
        updateRowDisplayFromCache(row, cachedEntry);
      }
    }
  });
  return queue;
}

function checkIfFetchIsStale(item: {
  row: HTMLTableRowElement;
  baseQuery: string;
  columnIndex: number;
  region: string | null;
  deviceTypes: string;
}): boolean {
  const { row, baseQuery, columnIndex, region, deviceTypes } = item;

  const currentRegion = getCurrentRegion();
  const currentDeviceTypes = getCurrentDeviceTypes();
  const allCheckboxes = document.querySelectorAll(`.${CSS_CLASSES.HEADER_CHECKBOX}`);
  const currentCheckbox = Array.from(allCheckboxes).find(
    (cb) => (cb as HTMLElement).dataset[DATASET_KEYS.TABLE_CHECKBOX_INDEX] === String(columnIndex)
  ) as HTMLInputElement | undefined ?? null;
  const currentQueryInRow = getQueryForRow(row);

  const isRowMissing = !row.isConnected;
  const isColumnDisabled = !currentCheckbox?.checked;
  const hasQueryChanged = currentQueryInRow !== baseQuery || row.dataset[DATASET_KEYS.QUERY_TO_FETCH] !== baseQuery;
  const hasContextChanged = currentRegion !== region || currentDeviceTypes !== deviceTypes;
  const isFetchTakenOver = parseInt(row.dataset[DATASET_KEYS.COL_FETCHING] || '', 10) !== columnIndex;

  const isStale = isRowMissing || isColumnDisabled || hasQueryChanged || hasContextChanged || isFetchTakenOver;
  if (isStale && !isRowMissing && parseInt(row.dataset[DATASET_KEYS.COL_FETCHING] || '', 10) === columnIndex && row.dataset[DATASET_KEYS.QUERY_TO_FETCH] === baseQuery) {
    cleanupStaleFetch(item);
  }
  return isStale;
}

function cleanupStaleFetch(item: {
  row: HTMLTableRowElement;
  baseQuery: string;
  columnIndex: number;
  region: string | null;
  deviceTypes: string;
}): void {
  const { row, baseQuery, columnIndex, region, deviceTypes } = item;
  if (!row.isConnected) return;
  if (parseInt(row.dataset[DATASET_KEYS.COL_FETCHING] || '', 10) === columnIndex && row.dataset[DATASET_KEYS.QUERY_TO_FETCH] === baseQuery) {
    delete row.dataset[DATASET_KEYS.COL_FETCHING];
    delete row.dataset[DATASET_KEYS.QUERY_TO_FETCH];
  }
  const cell = row.children[columnIndex] as HTMLElement | undefined;
  if (cell && (cell.dataset[DATASET_KEYS.CELL_STATE] === CELL_STATE.PENDING_QUEUE || cell.dataset[DATASET_KEYS.CELL_STATE] === CELL_STATE.FETCHING)) {
    updateRowDisplayFromCache(row, getFromLocalStorage(getQueryForRow(row) || '', region, deviceTypes));
  }
}

async function _fetchAndCacheQueueItem(item: {
  baseQuery: string;
  variantKey: FetcherVariantKey;
  apiQuery: string;
  resultIndex: number;
  region: string | null;
  deviceTypes: string;
}): Promise<{ value: number | null; success: boolean; error: string }> {
  const { baseQuery, variantKey, apiQuery, resultIndex, region, deviceTypes } = item;
  let fetchedValue: number | null = null;
  let fetchSuccess = false;
  let errorMessage = '';

  try {
    const fetchResult = await fetchVariantWithRetry(
      apiQuery,
      region,
      deviceTypes,
      0,
      (outcome) => sharedLimiter.recordResult(outcome)
    );
    fetchedValue = fetchResult?.totalValue ?? null;
    fetchSuccess = true;
  } catch (error: unknown) {
    logger.error(`Column fetch item error q="${apiQuery}" [R:${region}, D:${deviceTypes}]:`, error);
    fetchSuccess = false;
    errorMessage = (error as Error).message || 'Fetch Error';
    fetchedValue = null;
  }

  // Only a successful fetch may touch the cache. Writing the `null` fallback
  // on failure destroyed previously good frequencies for that cell, turning a
  // transient network blip into permanent data loss.
  if (fetchSuccess) {
    const currentCacheEntry = getFromLocalStorage(baseQuery, region, deviceTypes) || {
      base: null,
      variants: [],
      date: new Date().toISOString()
    };
    if (variantKey === 'base') {
      currentCacheEntry.base = fetchedValue;
    } else if (resultIndex !== -1) {
      while (currentCacheEntry.variants.length <= resultIndex) {
        currentCacheEntry.variants.push(null);
      }
      currentCacheEntry.variants[resultIndex] = fetchedValue;
    }
    saveToLocalStorage(baseQuery, region, deviceTypes, currentCacheEntry);
  }

  return { value: fetchedValue, success: fetchSuccess, error: errorMessage };
}

/** Clear a task's in-flight markers. Safe to call from any path. */
function _cleanupFetchDataset(item: { row: HTMLTableRowElement; baseQuery: string; columnIndex: number }): void {
  const { row, baseQuery, columnIndex } = item;
  const stillOurs =
    parseInt(row.dataset[DATASET_KEYS.COL_FETCHING] || '', 10) === columnIndex &&
    row.dataset[DATASET_KEYS.QUERY_TO_FETCH] === baseQuery;
  if (!stillOurs) return;
  delete row.dataset[DATASET_KEYS.COL_FETCHING];
  delete row.dataset[DATASET_KEYS.QUERY_TO_FETCH];
}

async function processQueueItem(item: {
  row: HTMLTableRowElement;
  baseQuery: string;
  variantKey: FetcherVariantKey;
  apiQuery: string;
  columnIndex: number;
  resultIndex: number;
  region: string | null;
  deviceTypes: string;
}): Promise<void> {
  const { row, columnIndex, baseQuery } = item;
  const cell = row.children[columnIndex] as HTMLElement | undefined;
  if (!cell) return;
  if (checkIfFetchIsStale(item)) return;

  if (cell.dataset[DATASET_KEYS.CELL_STATE] !== CELL_STATE.PENDING_QUEUE) {
    cleanupStaleFetch(item);
    return;
  }
  setCellState(cell, CELL_STATE.FETCHING);

  let result: { value: number | null; success: boolean; error: string } = {
    value: null,
    success: false,
    error: 'Fetch skipped or failed pre-check'
  };
  try {
    result = await _fetchAndCacheQueueItem(item);
  } catch (error: unknown) {
    logger.error('Unexpected error during queue item fetch/cache:', error);
    result = { value: null, success: false, error: (error as Error).message || 'Unexpected processing error' };
  } finally {
    // COL_FETCHING must go on EVERY path — including the stale early returns
    // and unexpected throws above. Leaving it set made
    // collectItemsForColumnFetch skip that row for the rest of the session.
    _cleanupFetchDataset(item);
    const liveRow = resolveLiveRow(baseQuery, row);
    if (liveRow) _cleanupFetchDataset({ row: liveRow, baseQuery, columnIndex });

    if (liveRow && !checkIfFetchIsStale(item)) {
      const liveCell = resolveLiveCell(row, baseQuery, columnIndex);
      if (liveCell) {
        _updateCellUIState(
          liveCell,
          result.value,
          result.success,
          result.error,
          isColumnEnabled(columnIndex)
        );
      }
    }
  }
}

async function processFetchQueue(queue: Array<{
  row: HTMLTableRowElement;
  baseQuery: string;
  variantKey: FetcherVariantKey;
  apiQuery: string;
  columnIndex: number;
  resultIndex: number;
  region: string | null;
  deviceTypes: string;
}>): Promise<void> {
  if (queue.length === 0) return;

  // Drive the batch through the shared AdaptiveRateLimiter instead of the
  // old fixed 15-in-flight / 750 ms sleep loop: that burst ignored the
  // adaptive concurrency entirely and had no jitter, so every column click
  // re-hit the API as an identical spike. shouldSkip re-runs the staleness
  // check at dispatch time (context may have changed while queued).
  const runner = createRateLimitedQueue({
    limiter: sharedLimiter,
    handler: (item: (typeof queue)[number]) => processQueueItem(item),
    shouldSkip: (item: (typeof queue)[number]) => checkIfFetchIsStale(item)
  });
  await runner.run(queue);
}

/** Public entry: fetch all missing values for a column. */
export async function fetchColumn(columnIndex: number): Promise<void> {
  // [FIX] CSS data-* attribute selectors are case-sensitive (our key is
  // `gfdTableIndex` in JS but `gfdtableindex` in the DOM). Use dataset
  // lookup instead of querySelector with a data-attr selector.
  const allCheckboxes = document.querySelectorAll(`.${CSS_CLASSES.HEADER_CHECKBOX}`);
  const headerCheckbox = Array.from(allCheckboxes).find(
    (cb) => (cb as HTMLElement).dataset[DATASET_KEYS.TABLE_CHECKBOX_INDEX] === String(columnIndex)
  ) as HTMLInputElement | undefined ?? null;
  if (!headerCheckbox?.checked) return;

  const table = document.querySelector(DOM_SELECTORS.TABLE) as HTMLTableElement | null;
  if (!table) return;

  const region = getCurrentRegion();
  const deviceTypes = getCurrentDeviceTypes();
  const rows = Array.from(table.querySelectorAll(DOM_SELECTORS.BODY_ROW)) as HTMLTableRowElement[];

  const queue = collectItemsForColumnFetch(rows, columnIndex, region, deviceTypes);
  if (queue.length === 0) return;
  await processFetchQueue(queue);
}
