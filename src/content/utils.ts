// src/content/utils.js
// Formatting + helpers + single source of truth for variant-query generation.
// No DOM mutation, no chrome APIs — fully unit-testable.

import {
  CELL_STATE,
  CELL_STATE_GLYPH,
  COLUMN_INDEX,
  CSS_CLASSES,
  DOM_SELECTORS,
  REGEX,
  DATASET_KEYS
} from '../config.ts';

import { type CellState, type FetcherVariantKey } from '../config.ts';
import { logger } from './logger.ts';

export function formatNumber(num: string | number | null | undefined): string {
  if (num === null || num === undefined) return CELL_STATE_GLYPH[CELL_STATE.DISABLED];
  const cleaned = String(num).replace(REGEX.NON_DIGIT_SPACE, '');
  const numericValue = Number(cleaned);
  if (Number.isNaN(numericValue)) return CELL_STATE_GLYPH[CELL_STATE.DISABLED];
  return numericValue.toString().replace(REGEX.THOUSANDS_SEP, ' ');
}

export function getQueryForRow(row: HTMLTableRowElement | null | undefined): string | null {
  if (!row) return null;
  const firstCell = row.children[COLUMN_INDEX.KEYWORD] as HTMLElement | undefined;
  const link = firstCell?.querySelector(DOM_SELECTORS.KEYWORD_LINK);
  const raw = link ? link.textContent : firstCell?.textContent;
  const text = raw?.trim();
  return text ? text.replace(REGEX.LEADING_PLUS_HYPHEN, '').trim() : null;
}

export function constructVariantQuery(baseQuery: string, resultIndex: number): string | null {
  if (!baseQuery) return null;
  let cleanedQuery = baseQuery.replace(REGEX.LEADING_PLUS_HYPHEN, '').trim();
  cleanedQuery = cleanedQuery.replace(REGEX.INTERNAL_PLUS, ' ');
  switch (resultIndex) {
    case 0:
      return `"${cleanedQuery}"`;
    case 1:
      return `"[${cleanedQuery}]"`;
    case 2: {
      const words = cleanedQuery.split(/\s+/).filter(Boolean);
      if (words.length === 0) return null;
      return `"[${words.map((word) => `!${word.replace(/^!/, '')}`).join(' ')}]"`;
    }
    default:
      return null;
  }
}

export function getApiQueryForVariant(baseQuery: string, variantKey: FetcherVariantKey): string | null {
  if (!baseQuery) return null;
  if (variantKey === 'base') {
    return baseQuery
      .replace(REGEX.LEADING_PLUS_HYPHEN, '')
      .trim()
      .replace(REGEX.INTERNAL_PLUS, ' ');
  }
  if (variantKey === 'quoted') return constructVariantQuery(baseQuery, 0);
  if (variantKey === 'bracketed') return constructVariantQuery(baseQuery, 1);
  if (variantKey === 'excluded') return constructVariantQuery(baseQuery, 2);
  return null;
}

export function createButton(text: string, onClick: (e: MouseEvent) => void, className = '', title = '', addDefaultClass = true): HTMLButtonElement {
  const button = document.createElement('button');
  button.textContent = text;
  if (addDefaultClass) button.classList.add('gfd_action-button');
  if (className) button.classList.add(className);
  if (title) button.title = title;
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

export function isCellLoadingOrError(cell: HTMLElement | null | undefined): boolean {
  if (!cell) return false;
  const state = cell.dataset?.[DATASET_KEYS.CELL_STATE];
  if (state) {
    return (
      state === CELL_STATE.PENDING_QUEUE ||
      state === CELL_STATE.FETCHING ||
      state === CELL_STATE.ERROR
    );
  }
  const text = cell.textContent;
  return (
    text === CELL_STATE_GLYPH[CELL_STATE.FETCHING] ||
    text === CELL_STATE_GLYPH[CELL_STATE.PENDING_QUEUE] ||
    text === CELL_STATE_GLYPH[CELL_STATE.ERROR]
  );
}

export function isColumnEnabled(columnIndex: number): boolean {
  const checkbox = document.querySelector(
    `.${CSS_CLASSES.HEADER_CHECKBOX}[data-${DATASET_KEYS.TABLE_CHECKBOX_INDEX}="${columnIndex}"]`
  ) as HTMLInputElement | null;
  return checkbox ? checkbox.checked : true;
}

export function getColumnEnabledMap(): Record<number, boolean> {
  const map: Record<number, boolean> = {};
  document.querySelectorAll(`.${CSS_CLASSES.HEADER_CHECKBOX}`).forEach((cb) => {
    const input = cb as HTMLInputElement;
    const index = parseInt(input.dataset[DATASET_KEYS.TABLE_CHECKBOX_INDEX] || '', 10);
    if (!isNaN(index)) map[index] = input.checked;
  });
  return map;
}

export function getCurrentRegion(): string | null {
  try {
    const urlParams = new URLSearchParams(window.location.search);
    const regionParam = urlParams.get('region');
    if (!regionParam) return null;
    return decodeURIComponent(regionParam.replace(/%2C/g, ','));
  } catch {
    return null;
  }
}

export function getCurrentDeviceTypes(): string {
  const deviceCheckboxes = document.querySelectorAll(
    ".wordstat__device-types input[type='checkbox']"
  );
  const deviceMap = ['desktop', 'phone', 'tablet'] as const;
  const selectedDevices: string[] = [];
  for (let i = 0; i < deviceMap.length; i++) {
    const cb = deviceCheckboxes[i] as HTMLInputElement | undefined;
    if (cb && cb.checked) selectedDevices.push(deviceMap[i]);
  }
  if (selectedDevices.length === 0) {
    logger.warn('No device types selected, falling back to defaults.');
    return 'desktop,phone,tablet';
  }
  return selectedDevices.join(',');
}

export function valueToCellState(value: unknown): CellState {
  if (value === null || value === undefined) return CELL_STATE.DISABLED;
  const cleaned = String(value).replace(REGEX.NON_DIGIT_SPACE, '');
  const num = Number(cleaned);
  return Number.isNaN(num) ? CELL_STATE.DISABLED : CELL_STATE.VALUE;
}