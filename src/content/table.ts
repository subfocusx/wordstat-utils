// src/content/table.js
// Glue layer between the DOM, UI (column rendering) and cache.
// Owns table→cache→rendering glue, kept out of main.js for testability.

import {
  DATASET_KEYS,
  DOM_SELECTORS
} from '../config.ts';
import {
  ensureCellCount,
  loadAndApplyCheckboxStates,
  modifyHeader,
  processRow,
  updateRowDisplayFromCache
} from './ui.ts';
import { getFromLocalStorage, readCacheRaw } from './cache.ts';
import { getQueryForRow } from './utils.ts';
import { logger } from './logger.ts';

/**
 * Freeze the cache JSON for the duration of one render tick.
 *
 * getFromLocalStorage() reads localStorage on every call, so looking it up per
 * row meant reading (and comparing) the whole, potentially multi-MB cache blob
 * once per row per second. A storage stand-in that always returns the same
 * snapshot keeps the per-row lookup logic in cache.ts while reading once.
 */
function snapshotCacheStorage(): { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void } {
  const frozen = readCacheRaw();
  return { getItem: () => frozen, setItem: () => undefined };
}

/**
 * Yandex re-renders <thead> when the view or sort changes, dropping our
 * injected cells. headerRow.dataset.HEADER_MODIFIED then reads 'false'/absent
 * while state.headerInitialized still says true, so the header would never be
 * rebuilt. Treat a missing marker on a live header row as "must rebuild".
 */
function headerNeedsRebuild(headerRow: HTMLTableRowElement, state: { headerInitialized: boolean }): boolean {
  return state.headerInitialized && headerRow.dataset[DATASET_KEYS.HEADER_MODIFIED] !== 'true';
}

/** Locate the main search-result table and its header row. */
export function findTableAndHeader() {
  const table = document.querySelector(DOM_SELECTORS.TABLE);
  if (!table) return null;
  const headerRow = table.querySelector(DOM_SELECTORS.HEADER_ROW);
  return { table, headerRow };
}

/** If table vanished mid-table-view, reset headerInitialized flag. */
export function resetStateIfTableMissing(table: HTMLTableElement | null | undefined, state: { headerInitialized: boolean; currentView: string | null }) {
  if (!table && state.headerInitialized && state.currentView === 'table') {
    logger.debug('Table disappeared in table view. Resetting state.');
    state.headerInitialized = false;
  }
}

/** Modify the header once and load saved checkbox states. */
export function ensureHeaderInitialized(table: HTMLTableElement | null | undefined, headerRow: HTMLTableRowElement | null | undefined, state: { headerInitialized: boolean; currentView: string | null }) {
  if (!table || !headerRow) return;
  if (headerNeedsRebuild(headerRow, state)) {
    logger.debug('Header row was re-rendered by the page. Rebuilding.');
    state.headerInitialized = false;
  }
  if (!state.headerInitialized) modifyHeader(headerRow, state);
  if (state.headerInitialized && !table.dataset[DATASET_KEYS.CHECKBOXES_LOADED]) {
    loadAndApplyCheckboxStates();
    table.dataset[DATASET_KEYS.CHECKBOXES_LOADED] = 'true';
  }
}

/** Render every row's data cells from cache (or mark disabled). */
export function processTableRows(table: HTMLTableElement | null | undefined, region: string | null, deviceTypes: string) {
  if (!table) return;
  const cacheStorage = snapshotCacheStorage();
  const rows = table.querySelectorAll(DOM_SELECTORS.BODY_ROW);
  rows.forEach((el: Element) => {
    const row = el as HTMLTableRowElement;
    ensureCellCount(row);
    processRow(row);
    const query = getQueryForRow(row);
    if (query !== null) {
      const cached = getFromLocalStorage(query, region, deviceTypes, cacheStorage);
      updateRowDisplayFromCache(row, cached);
    }
  });
}