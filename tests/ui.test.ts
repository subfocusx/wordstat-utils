// tests/ui.test.js
import {
  setCellState,
  ensureCellCount,
  modifyHeader,
  createFetchableHeaderCell,
  toggleCellDisabledState,
  saveCheckboxStates,
  loadAndApplyCheckboxStates,
  processRow
} from '../src/content/ui.ts';
import { CELL_STATE, CELL_STATE_GLYPH, CSS_CLASSES, COLUMN_INDEX, DATASET_KEYS } from '../src/config.ts';
import { makeStorage } from './helpers.ts';
import { saveToLocalStorage } from '../src/content/cache.ts';

describe('setCellState (M7)', () => {
  test('sets both dataset and textContent', () => {
    const cell = document.createElement('td');
    setCellState(cell, CELL_STATE.PENDING_QUEUE);
    expect(cell.dataset[DATASET_KEYS.CELL_STATE]).toBe(CELL_STATE.PENDING_QUEUE);
    expect(cell.textContent).toBe(CELL_STATE_GLYPH[CELL_STATE.PENDING_QUEUE]);
  });
  test('VALUE state uses formatNumber output', () => {
    const cell = document.createElement('td');
    setCellState(cell, CELL_STATE.VALUE, { value: 12345 });
    expect(cell.textContent).toBe('12 345');
    expect(cell.title).toBe('');
  });
  test('VALUE state with null falls back to DISABLED', () => {
    // setCellState(VALUE) without value option falls into the else branch
    const cell = document.createElement('td');
    setCellState(cell, CELL_STATE.VALUE);
    expect(cell.textContent).toBe(CELL_STATE_GLYPH[CELL_STATE.DISABLED]);
  });
});

describe('isCellLoadingOrError (uses dataset first)', () => {
  test('returns true for PENDING_QUEUE/FETCHING/ERROR', () => {
    const { isCellLoadingOrError } = require('../src/content/utils.ts');
    for (const state of [CELL_STATE.PENDING_QUEUE, CELL_STATE.FETCHING, CELL_STATE.ERROR]) {
      const cell = document.createElement('td');
      cell.dataset[DATASET_KEYS.CELL_STATE] = state;
      expect(isCellLoadingOrError(cell)).toBe(true);
    }
  });
  test('returns false for VALUE/DISABLED', () => {
    const { isCellLoadingOrError } = require('../src/content/utils.ts');
    for (const state of [CELL_STATE.VALUE, CELL_STATE.DISABLED]) {
      const cell = document.createElement('td');
      cell.dataset[DATASET_KEYS.CELL_STATE] = state;
      expect(isCellLoadingOrError(cell)).toBe(false);
    }
  });
});

describe('ensureCellCount', () => {
  test('adds cells until ACTION column exists', () => {
    const row = document.createElement('tr');
    ensureCellCount(row);
    expect(row.children.length).toBeGreaterThanOrEqual(COLUMN_INDEX.ACTIONS + 1);
    const last = row.lastElementChild;
    expect(last.textContent).toBe(CELL_STATE_GLYPH[CELL_STATE.DISABLED]);
    expect(last.dataset[DATASET_KEYS.CELL_STATE]).toBe(CELL_STATE.DISABLED);
  });
});

describe('createFetchableHeaderCell', () => {
  test('creates th with label, checkbox and fetch button', () => {
    const th = createFetchableHeaderCell({
      text: '«W»',
      index: 2,
      resultIndex: 0
    });
    expect(th.classList.contains(CSS_CLASSES.HEADER_CELL)).toBe(true);
    const cb = th.querySelector('input[type=checkbox]');
    expect(cb).not.toBeNull();
    expect(cb.dataset[DATASET_KEYS.TABLE_CHECKBOX_INDEX]).toBe('2');
    const button = th.querySelector('button');
    expect(button).not.toBeNull();
    expect(button.textContent).toBe('🔥');
  });
});

describe('modifyHeader', () => {
  test('adds headers and marks as modified', () => {
    const headerRow = document.createElement('tr');
    headerRow.innerHTML = `
      <th>Word</th><th>Base</th>
    `;
    const state = { headerInitialized: false };
    modifyHeader(headerRow, state);
    expect(headerRow.dataset[DATASET_KEYS.HEADER_MODIFIED]).toBe('true');
    expect(state.headerInitialized).toBe(true);
    expect(headerRow.children.length).toBeGreaterThanOrEqual(6);
  });
  test('is idempotent', () => {
    const headerRow = document.createElement('tr');
    headerRow.innerHTML = '<th>Word</th><th>Base</th>';
    const state = { headerInitialized: false };
    modifyHeader(headerRow, state);
    const lengthAfterFirst = headerRow.children.length;
    modifyHeader(headerRow, state);
    expect(headerRow.children.length).toBe(lengthAfterFirst);
  });
});

describe('toggleCellDisabledState', () => {
  test('toggles class and title', () => {
    const cell = document.createElement('td');
    toggleCellDisabledState(cell, true, 'disabled!');
    expect(cell.classList.contains(CSS_CLASSES.DISABLED)).toBe(true);
    expect(cell.title).toBe('disabled!');
    toggleCellDisabledState(cell, false, 'disabled!');
    expect(cell.classList.contains(CSS_CLASSES.DISABLED)).toBe(false);
  });
  test('does not change title when cell is busy', () => {
    const cell = document.createElement('td');
    cell.dataset[DATASET_KEYS.CELL_STATE] = CELL_STATE.FETCHING;
    cell.title = 'original';
    toggleCellDisabledState(cell, true, 'new title');
    expect(cell.title).toBe('original');
  });
});

describe('saveCheckboxStates / loadAndApplyCheckboxStates', () => {
  test('round-trips checkbox states via localStorage', () => {
    localStorage.clear();
    document.body.innerHTML = `
      <table>
        <thead><tr>
          <th><input class="gfd_header-checkbox" data-gfd-table-index="2" type="checkbox" checked /></th>
          <th><input class="gfd_header-checkbox" data-gfd-table-index="3" type="checkbox" /></th>
        </tr></thead>
        <tbody></tbody>
      </table>
    `;
    const cbs = document.querySelectorAll('.gfd_header-checkbox');
    expect(cbs.length).toBe(2);
    saveCheckboxStates();
    const stored = JSON.parse(localStorage.getItem('gfd_Checkbox_State') || '{}');
    expect(stored).toEqual({ '2': true, '3': false });
  });
});

describe('processRow', () => {
  test('attaches click listener and copies button', () => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td><a>x</a></td><td>1</td><td></td><td></td><td></td><td></td>
    `;
    processRow(row);
    const keyword = row.children[0];
    expect(keyword.classList.contains(CSS_CLASSES.KEYWORD_CELL)).toBe(true);
    expect(keyword.dataset[DATASET_KEYS.CLICK_LISTENER]).toBe('true');
    expect(keyword.querySelector('a').hasAttribute('href')).toBe(false);
    const actions = row.children[COLUMN_INDEX.ACTIONS];
    expect(actions.querySelector('button')).not.toBeNull();
  });
});