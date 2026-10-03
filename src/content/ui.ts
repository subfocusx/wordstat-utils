// src/content/ui.js
// DOM manipulation, header injection, checkbox persistence.
// [M7] cell.dataset.state replaces textContent-based state checks.
// [M9] in-memory cache map avoids re-parsing LS on every checkbox toggle.

import {
  CELL_STATE,
  CELL_STATE_GLYPH,
  CSS_CLASSES,
  COLUMN_CONFIGS,
  COLUMN_INDEX,
  DATASET_KEYS,
  DOM_SELECTORS,
  EVENTS,
  LS_CHECKBOX_KEY,
  REGEX,
  UI_TEXT,
  type CellState,
  type ColumnConfig
} from '../config.ts';
import {
  formatNumber,
  getColumnEnabledMap,
  getQueryForRow,
  isCellLoadingOrError,
  getCurrentRegion,
  getCurrentDeviceTypes,
  createButton
} from './utils.ts';
import { handleRowClick, fetchColumn } from './fetchLogic.ts';
import { getFromLocalStorage } from './cache.ts';
import { logger } from './logger.ts';

interface HeaderState {
  headerInitialized: boolean;
}

interface SetCellStateOpts {
  value?: string | number | null;
}

interface CheckboxStates {
  [index: string]: boolean;
}

function setCellState(cell: HTMLElement, state: CellState, opts: SetCellStateOpts = {}): void {
  if (!cell) return;
  cell.dataset[DATASET_KEYS.CELL_STATE] = state;
  if (state === CELL_STATE.VALUE) {
    // A stale ERROR / "column disabled" tooltip must not survive into a value.
    cell.title = '';
    if (opts.value === null || opts.value === undefined) {
      cell.dataset[DATASET_KEYS.CELL_STATE] = CELL_STATE.DISABLED;
      cell.textContent = CELL_STATE_GLYPH[CELL_STATE.DISABLED];
    } else {
      cell.textContent = formatNumber(opts.value);
    }
  } else {
    cell.textContent = CELL_STATE_GLYPH[state] ?? '';
  }
}

/**
 * Rewrite Yandex's base-frequency header cell in place.
 *
 * This used to `cloneNode(true)` + `replaceChild`, which detached the cell
 * from state Yandex keeps outside the DOM (framework props, keyed node maps),
 * so a later header re-render could resurrect the discarded node. Editing the
 * existing node preserves the identity Yandex expects.
 */
export function createBaseFrequencyHeaderCell(headerRow: HTMLTableRowElement): void {
  const cell = headerRow.children[COLUMN_INDEX.BASE_FREQUENCY] as HTMLElement | undefined;
  if (!cell) return;

  cell.innerHTML = '';
  cell.classList.remove(CSS_CLASSES.SORTABLE_COLUMN, CSS_CLASSES.SORTED_COLUMN);
  cell.classList.add(CSS_CLASSES.HEADER_CELL, CSS_CLASSES.HEADER_CELL_NO_SORT);
  cell.title = '';

  const label = document.createElement('span');
  label.textContent = UI_TEXT.BASE_FREQ_HEADER;
  cell.appendChild(label);

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = true;
  checkbox.classList.add(CSS_CLASSES.HEADER_CHECKBOX);
  checkbox.dataset[DATASET_KEYS.TABLE_CHECKBOX_INDEX] = String(COLUMN_INDEX.BASE_FREQUENCY);
  checkbox.title = UI_TEXT.BASE_FREQ_TITLE;
  checkbox.addEventListener(EVENTS.CHANGE, (e: Event) => {
    e.stopPropagation();
    const target = e.target as HTMLInputElement;
    toggleColumnState(COLUMN_INDEX.BASE_FREQUENCY, target.checked);
    saveCheckboxStates();
  });
  cell.appendChild(checkbox);
}

export function createFetchableHeaderCell(config: ColumnConfig): HTMLTableHeaderCellElement {
  const th = document.createElement('th');
  th.classList.add(CSS_CLASSES.HEADER_CELL);

  const label = document.createElement('span');
  label.textContent = config.text;
  th.appendChild(label);

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = true;
  checkbox.classList.add(CSS_CLASSES.HEADER_CHECKBOX);
  checkbox.dataset[DATASET_KEYS.TABLE_CHECKBOX_INDEX] = String(config.index);
  checkbox.title = UI_TEXT.FETCHABLE_TITLE_TEMPLATE.replace('{TEXT}', config.text);
  checkbox.addEventListener(EVENTS.CHANGE, (e: Event) => {
    e.stopPropagation();
    const target = e.target as HTMLInputElement;
    toggleColumnState(config.index, target.checked);
    saveCheckboxStates();
  });
  th.appendChild(checkbox);

  const fetchButton = createButton(
    UI_TEXT.FETCH_COLUMN_BTN,
    (e) => {
      e.stopPropagation();
      fetchColumn(config.index);
    },
    '',
    UI_TEXT.FETCH_MISSING_TITLE_TEMPLATE.replace('{TEXT}', config.text)
  );
  th.appendChild(fetchButton);
  return th;
}

export function createActionsHeaderCell(): HTMLTableHeaderCellElement {
  const actionsTh = document.createElement('th');
  actionsTh.textContent = UI_TEXT.ACTIONS_HEADER;
  actionsTh.classList.add(CSS_CLASSES.HEADER_CELL);
  return actionsTh;
}

export function modifyHeader(headerRow: HTMLTableRowElement, state: HeaderState): void {
  if (headerRow.dataset[DATASET_KEYS.HEADER_MODIFIED] === 'true') return;
  createBaseFrequencyHeaderCell(headerRow);
  COLUMN_CONFIGS.forEach((config) => {
    const th = createFetchableHeaderCell(config);
    headerRow.appendChild(th);
  });
  const actionsTh = createActionsHeaderCell();
  headerRow.appendChild(actionsTh);
  headerRow.dataset[DATASET_KEYS.HEADER_MODIFIED] = 'true';
  state.headerInitialized = true;
}

export function ensureCellCount(row: HTMLTableRowElement): void {
  while (row.children.length <= COLUMN_INDEX.ACTIONS) {
    const newCell = document.createElement('td');
    newCell.textContent = CELL_STATE_GLYPH[CELL_STATE.DISABLED];
    newCell.dataset[DATASET_KEYS.CELL_STATE] = CELL_STATE.DISABLED;
    newCell.classList.add(CSS_CLASSES.DATA_CELL);
    row.appendChild(newCell);
  }
}

export function setupKeywordCell(cell: HTMLElement): void {
  if (!cell || cell.dataset[DATASET_KEYS.CLICK_LISTENER]) return;
  const link = cell.querySelector<HTMLAnchorElement>(DOM_SELECTORS.KEYWORD_LINK);
  if (link?.hasAttribute('href')) {
    // Keep WordStat's own navigation intact — a click on the keyword should
    // open the phrase page, not be swallowed by our row handler. We only make
    // it open in a new tab so the results table survives, and stash the
    // original href so it can always be restored.
    if (!link.dataset[DATASET_KEYS.ORIGINAL_HREF]) {
      link.dataset[DATASET_KEYS.ORIGINAL_HREF] = link.getAttribute('href') ?? '';
    }
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  }
  cell.classList.add(CSS_CLASSES.KEYWORD_CELL);
  cell.title = UI_TEXT.KEYWORD_CELL_TITLE;
  cell.addEventListener(EVENTS.CLICK, handleRowClick);
  cell.dataset[DATASET_KEYS.CLICK_LISTENER] = 'true';
}

export function setupActionsCell(cell: HTMLElement, row: HTMLTableRowElement): void {
  if (!cell) return;
  cell.classList.add(CSS_CLASSES.ACTIONS_CELL);
  if (!cell.querySelector(`.${CSS_CLASSES.ACTION_BUTTON}`)) {
    cell.innerHTML = '';
    const copyButton = createButton(
      UI_TEXT.COPY_BTN,
      (e) => {
        e.stopPropagation();
        copyRowToClipboard(row);
        const target = e.target as HTMLButtonElement;
        target.textContent = UI_TEXT.COPY_SUCCESS_BTN;
        setTimeout(() => {
          target.textContent = UI_TEXT.COPY_BTN;
        }, 1000);
      },
      '',
      UI_TEXT.COPY_ROW_TITLE
    );
    cell.appendChild(copyButton);
  }
}

export function processRow(row: HTMLTableRowElement): void {
  ensureCellCount(row);
  setupKeywordCell(row.children[COLUMN_INDEX.KEYWORD] as HTMLElement);
  for (let i = COLUMN_INDEX.BASE_FREQUENCY; i <= COLUMN_INDEX.EXCLUDED; i++) {
    const child = row.children[i];
    if (child) child.classList.add(CSS_CLASSES.DATA_CELL);
  }
  setupActionsCell(row.children[COLUMN_INDEX.ACTIONS] as HTMLElement, row);
}

export function updateRowDisplayFromCache(row: HTMLTableRowElement, cachedEntry: { base: string | number | null; variants: Array<string | number | null> } | null): void {
  if (!row || row.children.length <= COLUMN_INDEX.EXCLUDED) return;

  const enabledMap = getColumnEnabledMap();

  const baseFreqCell = row.children[COLUMN_INDEX.BASE_FREQUENCY] as HTMLElement | undefined;
  if (baseFreqCell) {
    toggleCellDisabledState(
      baseFreqCell,
      !enabledMap[COLUMN_INDEX.BASE_FREQUENCY],
      UI_TEXT.DISABLED_TITLE_NO_COPY
    );
  }

  COLUMN_CONFIGS.forEach((config) => {
    const { index: columnIndex, resultIndex } = config;
    const cell = row.children[columnIndex] as HTMLElement | undefined;
    if (!cell) return;

    const columnEnabled = enabledMap[columnIndex];
    toggleCellDisabledState(cell, !columnEnabled, UI_TEXT.DISABLED_TITLE);

    const busy = isCellLoadingOrError(cell);

    if (columnEnabled && !busy) {
      applyCachedValue(cell, cachedEntry, resultIndex);
    } else if (!columnEnabled && !busy) {
      setCellState(cell, CELL_STATE.DISABLED);
    }
  });
}

/**
 * Render one variant cell from its cache entry.
 *
 * The ERROR tooltip is only correct once we actually attempted this variant.
 * An absent cache entry means "never fetched" (or cache expired), which is not
 * an error — showing "Fetch failed" there told users their untouched rows had
 * failed. Only a recorded entry with a missing value counts as a failure.
 */
function applyCachedValue(
  cell: HTMLElement,
  cachedEntry: { variants?: Array<string | number | null>; errored?: boolean } | null | undefined,
  resultIndex: number
): void {
  const value = cachedEntry?.variants?.[resultIndex];
  if (value === null || value === undefined) {
    setCellState(cell, CELL_STATE.DISABLED);
    if (cachedEntry) cell.title = UI_TEXT.ERROR_FETCH_FAILED;
    else cell.title = '';
  } else {
    setCellState(cell, CELL_STATE.VALUE, { value });
  }
}

export function toggleCellDisabledState(cell: HTMLElement, isDisabled: boolean, disabledTitle: string): void {
  if (!cell) return;
  const busy = isCellLoadingOrError(cell);
  cell.classList.toggle(CSS_CLASSES.DISABLED, isDisabled);
  if (!busy) {
    if (isDisabled) {
      cell.title = disabledTitle;
    } else {
      const state = cell.dataset[DATASET_KEYS.CELL_STATE];
      if (state !== CELL_STATE.DISABLED && state !== CELL_STATE.ERROR) cell.title = '';
    }
  }
}

export function toggleColumnState(columnIndex: number, isEnabled: boolean): void {
  const table = document.querySelector(DOM_SELECTORS.TABLE) as HTMLTableElement | null;
  if (!table) return;
  const region = getCurrentRegion();
  const deviceTypes = getCurrentDeviceTypes();

  const headerCheckbox = Array.from(
    document.querySelectorAll(`.${CSS_CLASSES.HEADER_CHECKBOX}`)
  ).find(
    (cb) => (cb as HTMLElement).dataset[DATASET_KEYS.TABLE_CHECKBOX_INDEX] === String(columnIndex)
  ) as HTMLInputElement | undefined ?? null;
  const headerCell = headerCheckbox?.closest('th');
  if (headerCell) headerCell.classList.toggle(CSS_CLASSES.DISABLED, !isEnabled);

  const disabledTitle =
    columnIndex === COLUMN_INDEX.BASE_FREQUENCY
      ? UI_TEXT.DISABLED_TITLE_NO_COPY
      : UI_TEXT.DISABLED_TITLE;

  table.querySelectorAll(DOM_SELECTORS.BODY_ROW).forEach((row) => {
    const r = row as HTMLTableRowElement;
    if (r.children.length <= columnIndex) return;
    const cell = r.children[columnIndex] as HTMLElement | undefined;
    if (!cell) return;
    const busy = isCellLoadingOrError(cell);
    toggleCellDisabledState(cell, !isEnabled, disabledTitle);

    if (columnIndex === COLUMN_INDEX.BASE_FREQUENCY) return;

    if (isEnabled && !busy) {
      const query = getQueryForRow(r);
      if (!query) return;
      const cachedEntry = getFromLocalStorage(query, region, deviceTypes);
      const resultIndex = columnIndex - COLUMN_INDEX.QUOTED;
      applyCachedValue(cell, cachedEntry, resultIndex);
    } else if (!isEnabled && !busy) {
      setCellState(cell, CELL_STATE.DISABLED);
    }
  });
}

export function saveCheckboxStates(): void {
  const states: CheckboxStates = {};
  document.querySelectorAll(`.${CSS_CLASSES.HEADER_CHECKBOX}`).forEach((cb) => {
    const input = cb as HTMLInputElement;
    const index = input.dataset[DATASET_KEYS.TABLE_CHECKBOX_INDEX];
    if (index) states[index] = input.checked;
  });
  try {
    localStorage.setItem(LS_CHECKBOX_KEY, JSON.stringify(states));
  } catch {
    logger.error('Error saving header checkbox states');
  }
}

export function loadAndApplyCheckboxStates(): void {
  const storedStatesJson = localStorage.getItem(LS_CHECKBOX_KEY);
  let states: CheckboxStates = {};
  if (storedStatesJson) {
    try {
      states = JSON.parse(storedStatesJson);
    } catch {
      logger.warn('Could not parse stored header checkbox states.');
    }
  }
  document.querySelectorAll(`.${CSS_CLASSES.HEADER_CHECKBOX}`).forEach((cb) => {
    const input = cb as HTMLInputElement;
    const indexStr = input.dataset[DATASET_KEYS.TABLE_CHECKBOX_INDEX];
    if (!indexStr) return;
    const index = parseInt(indexStr, 10);
    const shouldBeChecked =
      Object.prototype.hasOwnProperty.call(states, indexStr) ? states[indexStr] : true;
    input.checked = shouldBeChecked;
    toggleColumnState(index, input.checked);
  });
}

function getRowValues(row: HTMLTableRowElement): string[] {
  const values: string[] = [];
  const query = getQueryForRow(row);
  values.push(query || CELL_STATE_GLYPH[CELL_STATE.DISABLED]);
  const enabledMap = getColumnEnabledMap();
  if (enabledMap[COLUMN_INDEX.BASE_FREQUENCY]) {
    const cell = row.children[COLUMN_INDEX.BASE_FREQUENCY] as HTMLElement | undefined;
    const cellValue = cell
      ? cell.textContent!.replace(REGEX.NON_DIGIT_SPACE, '').trim()
      : CELL_STATE_GLYPH[CELL_STATE.DISABLED];
    values.push(cellValue || CELL_STATE_GLYPH[CELL_STATE.DISABLED]);
  }
  COLUMN_CONFIGS.forEach((config) => {
    const { index: columnIndex } = config;
    if (enabledMap[columnIndex]) {
      const cell = row.children[columnIndex] as HTMLElement | undefined;
      if (cell) {
        let cellValue = cell.textContent!.replace(REGEX.NON_DIGIT_SPACE, '').trim();
        const busyStates = new Set([
          CELL_STATE_GLYPH[CELL_STATE.FETCHING],
          CELL_STATE_GLYPH[CELL_STATE.PENDING_QUEUE],
          CELL_STATE_GLYPH[CELL_STATE.ERROR],
          CELL_STATE_GLYPH[CELL_STATE.CANNOT_GENERATE]
        ]);
        if (busyStates.has(cellValue)) cellValue = CELL_STATE_GLYPH[CELL_STATE.DISABLED];
        values.push(cellValue || CELL_STATE_GLYPH[CELL_STATE.DISABLED]);
      } else {
        values.push(CELL_STATE_GLYPH[CELL_STATE.DISABLED]);
      }
    }
  });
  return values;
}

function copyRowToClipboard(row: HTMLTableRowElement): void {
  const textToCopy = getRowValues(row).join('\t');
  navigator.clipboard.writeText(textToCopy).catch(() => {
    logger.error('Failed to copy row data to clipboard');
  });
}

export { setCellState };