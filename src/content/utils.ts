// src/content/utils.js
// Formatting + helpers + single source of truth for variant-query generation.
// No DOM mutation, no chrome APIs — fully unit-testable.

import {
  CELL_STATE,
  CELL_STATE_GLYPH,
  COLUMN_INDEX,
  CSS_CLASSES,
  DATASET_KEYS,
  DEVICE_TYPE_ORDER,
  DOM_SELECTORS,
  REGEX
} from '../config.ts';

import { type FetcherVariantKey } from '../config.ts';
import { logger } from './logger.ts';

/** Group the integer part with thin spaces: 1234567 -> "1 234 567". */
function groupThousands(intPart: string): string {
  return intPart.replace(REGEX.THOUSANDS_SEP, ' ');
}

/**
 * Render a frequency for display.
 *
 * WordStat returns either a number or a space-grouped string. Non-breaking
 * spaces are stripped before parsing, but decimal fractions (both "1234.5" and
 * the Russian "1234,5") must survive — grouping is applied to the integer part
 * only. An empty or non-numeric value renders as the DISABLED glyph rather than
 * "0", which used to happen because Number('') === 0.
 */
export function formatNumber(num: string | number | null | undefined): string {
  if (num === null || num === undefined) return CELL_STATE_GLYPH[CELL_STATE.DISABLED];
  const cleaned = String(num).replace(REGEX.NON_DIGIT_SPACE, '').replace(',', '.');
  if (cleaned === '' || !/^-?\d*\.?\d+$/.test(cleaned)) {
    return CELL_STATE_GLYPH[CELL_STATE.DISABLED];
  }
  const numericValue = Number(cleaned);
  if (!Number.isFinite(numericValue)) return CELL_STATE_GLYPH[CELL_STATE.DISABLED];
  const dot = cleaned.indexOf('.');
  const intPart = dot === -1 ? cleaned : cleaned.slice(0, dot);
  const fracPart = dot === -1 ? '' : cleaned.slice(dot);
  return groupThousands(intPart) + fracPart;
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
    // URLSearchParams already percent-decodes; decoding again would mangle a
    // region that legitimately contains a '%' sequence.
    const region = regionParam.trim();
    return region === '' ? null : region;
  } catch {
    return null;
  }
}

/**
 * Read the checked device filters as a comma-separated list.
 *
 * The DOM order of WordStat's device checkboxes is not guaranteed across
 * redesigns, so each checkbox is labelled from its own attributes
 * (data-device / value / id / label text) and only falls back to positional
 * order when none of those identify it.
 */
export function getCurrentDeviceTypes(): string {
  const checkboxes = Array.from(
    document.querySelectorAll<HTMLInputElement>(DOM_SELECTORS.DEVICE_CHECKBOXES)
  );
  const selectedDevices: string[] = [];
  checkboxes.forEach((cb, index) => {
    if (!cb.checked) return;
    const device = deviceTypeForCheckbox(cb, index);
    if (device && !selectedDevices.includes(device)) selectedDevices.push(device);
  });
  if (selectedDevices.length === 0) {
    warnNoDevicesOnce();
    return DEVICE_TYPE_ORDER.join(',');
  }
  return selectedDevices.join(',');
}



function deviceTypeForCheckbox(cb: HTMLInputElement, index: number): string | null {
  const candidates = [
    cb.getAttribute('data-device'),
    cb.value,
    cb.id,
    cb.closest('label')?.textContent
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalized = candidate.trim().toLowerCase();
    const match = DEVICE_TYPE_ORDER.find((d) => normalized.includes(d));
    if (match) return match;
  }
  return DEVICE_TYPE_ORDER[index] ?? null;
}

/** getCurrentDeviceTypes runs on every 1 Hz tick; log its fallback only once. */
let warnedAboutDevices = false;
function warnNoDevicesOnce(): void {
  if (warnedAboutDevices) return;
  warnedAboutDevices = true;
  logger.warn('No device types selected, falling back to defaults.');
}
