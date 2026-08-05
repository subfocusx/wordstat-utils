import {
  findTableAndHeader,
  resetStateIfTableMissing,
  ensureHeaderInitialized,
  processTableRows
} from '../src/content/table.ts';
import { DATASET_KEYS, DOM_SELECTORS, CSS_CLASSES } from '../src/config.ts';
import { makeStorage } from './helpers.ts';

function makeTable() {
  const wrapper = document.createElement('div');
  wrapper.className = 'wordstat__search-result-content';
  wrapper.innerHTML = `
    <table>
      <thead><tr><th>Word</th><th>Freq</th></tr></thead>
      <tbody>
        <tr><td><a>query1</a></td><td>100</td></tr>
        <tr><td><a>query2</a></td><td>200</td></tr>
      </tbody>
    </table>
  `;
  const table = wrapper.querySelector('table')!;
  return { table, wrapper };
}

function makeState() {
  return { headerInitialized: false, currentView: 'table', observer: null };
}

describe('findTableAndHeader', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  test('returns table and headerRow when table exists', () => {
    const { wrapper } = makeTable();
    document.body.appendChild(wrapper);
    const result = findTableAndHeader();
    expect(result).not.toBeNull();
    expect(result.table).toBe(document.querySelector(DOM_SELECTORS.TABLE));
    expect(result.headerRow).toBe(document.querySelector(DOM_SELECTORS.HEADER_ROW));
  });

  test('returns null when no table exists', () => {
    expect(findTableAndHeader()).toBeNull();
  });
});

describe('resetStateIfTableMissing', () => {
  test('resets headerInitialized when table is missing and view is table', () => {
    const state = makeState();
    state.headerInitialized = true;
    resetStateIfTableMissing(null, state);
    expect(state.headerInitialized).toBe(false);
  });

  test('does not reset when table exists', () => {
    const { table } = makeTable();
    const state = makeState();
    state.headerInitialized = true;
    resetStateIfTableMissing(table, state);
    expect(state.headerInitialized).toBe(true);
  });

  test('does not reset when view is not table', () => {
    const state = makeState();
    state.currentView = 'other';
    state.headerInitialized = true;
    resetStateIfTableMissing(null, state);
    expect(state.headerInitialized).toBe(true);
  });
});

describe('ensureHeaderInitialized', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
  });

  test('does nothing when table or headerRow is missing', () => {
    const state = makeState();
    ensureHeaderInitialized(null, null, state);
    expect(state.headerInitialized).toBe(false);
  });

  test('calls modifyHeader when not yet initialized', () => {
    const { table, wrapper } = makeTable();
    document.body.appendChild(wrapper);
    const headerRow = table.querySelector('tr');
    const state = makeState();
    ensureHeaderInitialized(table, headerRow, state);
    expect(state.headerInitialized).toBe(true);
    expect(table.dataset[DATASET_KEYS.CHECKBOXES_LOADED]).toBe('true');
  });
});

describe('processTableRows', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
  });

  test('does nothing when table is null', () => {
    processTableRows(null, null, '');
  });

  test('processes each row in the table', () => {
    const { table, wrapper } = makeTable();
    document.body.appendChild(wrapper);
    const rows = table.querySelectorAll(DOM_SELECTORS.BODY_ROW);
    expect(rows.length).toBe(2);
    processTableRows(table, null, '');
  });

  test('handles rows without query links', () => {
    const table = document.createElement('table');
    table.innerHTML = `
      <tbody>
        <tr><td>no link</td><td></td></tr>
      </tbody>
    `;
    processTableRows(table, null, '');
  });
});
