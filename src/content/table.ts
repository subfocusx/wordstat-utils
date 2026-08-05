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
import { getFromLocalStorage } from './cache.ts';
import { getQueryForRow } from './utils.ts';
import { logger } from './logger.ts';

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
  if (!state.headerInitialized) modifyHeader(headerRow, state);
  if (state.headerInitialized && !table.dataset[DATASET_KEYS.CHECKBOXES_LOADED]) {
    loadAndApplyCheckboxStates();
    table.dataset[DATASET_KEYS.CHECKBOXES_LOADED] = 'true';
  }
}

/** Render every row's data cells from cache (or mark disabled). */
export function processTableRows(table: HTMLTableElement | null | undefined, region: string | null, deviceTypes: string) {
  if (!table) return;
  const rows = table.querySelectorAll(DOM_SELECTORS.BODY_ROW);
  rows.forEach((el: Element) => {
    const row = el as HTMLTableRowElement;
    ensureCellCount(row);
    processRow(row);
    const query = getQueryForRow(row);
    if (query !== null) {
      const cached = getFromLocalStorage(query, region, deviceTypes);
      updateRowDisplayFromCache(row, cached);
    }
  });
}