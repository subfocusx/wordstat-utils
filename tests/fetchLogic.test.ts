// tests/fetchLogic.test.js
import { identifyVariantsToFetchForRow, handleRowClick, fetchColumn } from '../src/content/fetchLogic.ts';
import { CELL_STATE, COLUMN_INDEX, CSS_CLASSES, DATASET_KEYS } from '../src/config.ts';
import { makeStorage, installChromeShim } from './helpers.ts';
import { saveToLocalStorage } from '../src/content/cache.ts';

function makeRow(query, base = 100) {
  const row = document.createElement('tr');
  row.innerHTML = `
    <td><a>${query}</a></td>
    <td>${base}</td>
    <td></td><td></td><td></td><td></td>
  `;
  return row;
}

describe('identifyVariantsToFetchForRow', () => {
  beforeEach(() => {
    installChromeShim();
    document.body.innerHTML = '';
  });

  test('returns no tasks when all variants are cached', () => {
    const row = makeRow('купить');
    document.body.appendChild(row);
    // Pretend header checkbox exists and is enabled
    document.body.insertAdjacentHTML('beforeend', `
      <input class="gfd_header-checkbox" data-gfdTableIndex="2" type="checkbox" checked />
      <input class="gfd_header-checkbox" data-gfdTableIndex="3" type="checkbox" checked />
      <input class="gfd_header-checkbox" data-gfdTableIndex="4" type="checkbox" checked />
    `);
    const cached = { base: 100, variants: [10, 5, 1] };
    const tasks = identifyVariantsToFetchForRow(row, 'купить', '213', 'desktop', cached);
    expect(tasks).toEqual([]);
  });

  test('identifies missing variants', () => {
    const row = makeRow('купить');
    document.body.appendChild(row);
    document.body.insertAdjacentHTML('beforeend', `
      <input class="gfd_header-checkbox" data-gfdTableIndex="2" type="checkbox" checked />
      <input class="gfd_header-checkbox" data-gfdTableIndex="3" type="checkbox" checked />
      <input class="gfd_header-checkbox" data-gfdTableIndex="4" type="checkbox" checked />
    `);
    const cached = { base: 100, variants: [10, null, null] }; // quoted cached, others missing
    const tasks = identifyVariantsToFetchForRow(row, 'купить', '213', 'desktop', cached);
    // Two variants need fetching → two tasks
    expect(tasks).toHaveLength(2);
    // First task is for bracketed (resultIndex 1)
    expect(tasks[0].variantKey).toBe('bracketed');
    // Second is for excluded (resultIndex 2)
    expect(tasks[1].variantKey).toBe('excluded');
  });

  test('marks cell as PENDING_QUEUE', () => {
    const row = makeRow('купить');
    document.body.appendChild(row);
    document.body.insertAdjacentHTML('beforeend', `
      <input class="gfd_header-checkbox" data-gfdTableIndex="2" type="checkbox" checked />
      <input class="gfd_header-checkbox" data-gfdTableIndex="3" type="checkbox" checked />
      <input class="gfd_header-checkbox" data-gfdTableIndex="4" type="checkbox" checked />
    `);
    const tasks = identifyVariantsToFetchForRow(row, 'купить', '213', 'desktop', null);
    expect(tasks).toHaveLength(3);
    const cell = row.children[COLUMN_INDEX.QUOTED];
    expect(cell.dataset[DATASET_KEYS.CELL_STATE]).toBe(CELL_STATE.PENDING_QUEUE);
  });

  test('skips cells that are already busy', () => {
    const row = makeRow('купить');
    const cell = row.children[COLUMN_INDEX.QUOTED];
    cell.dataset[DATASET_KEYS.CELL_STATE] = CELL_STATE.FETCHING;
    document.body.appendChild(row);
    document.body.insertAdjacentHTML('beforeend', `
      <input class="gfd_header-checkbox" data-gfdTableIndex="2" type="checkbox" checked />
      <input class="gfd_header-checkbox" data-gfdTableIndex="3" type="checkbox" checked />
      <input class="gfd_header-checkbox" data-gfdTableIndex="4" type="checkbox" checked />
    `);
    const tasks = identifyVariantsToFetchForRow(row, 'купить', '213', 'desktop', null);
    // Quoted is busy → skipped; bracketed and excluded still missing → 2 tasks.
    expect(tasks).toHaveLength(2);
    expect(tasks.find((t) => t.columnIndex === COLUMN_INDEX.QUOTED)).toBeUndefined();
  });

  test('returns empty for empty base query', () => {
    const row = document.createElement('tr');
    const tasks = identifyVariantsToFetchForRow(row, null, null, null, null);
    expect(tasks).toEqual([]);
  });
});

describe('handleRowClick', () => {
  beforeEach(() => {
    installChromeShim();
    document.body.innerHTML = '';
  });

  test('does nothing when click target is the action button', () => {
    const row = makeRow('купить');
    document.body.appendChild(row);
    const actionBtn = document.createElement('button');
    actionBtn.className = CSS_CLASSES.ACTION_BUTTON;
    row.appendChild(actionBtn);
    const event = {
      target: actionBtn,
      currentTarget: row,
      closest: (sel) => (sel.includes('action-button') ? actionBtn : null)
    };
    handleRowClick(event);
    // No exception thrown means we returned early correctly
    expect(row.classList.contains(CSS_CLASSES.PENDING_ROW)).toBe(false);
  });

  test('returns when row cannot be found', () => {
    const event = {
      target: document.createElement('div'),
      currentTarget: document.createElement('div'),
      closest: () => null
    };
    handleRowClick(event);
    // No-op
  });
});

describe('fetchColumn entry point', () => {
  beforeEach(() => {
    installChromeShim();
    document.body.innerHTML = '';
  });

  test('does nothing if column checkbox is missing/unchecked', async () => {
    document.body.innerHTML = `
      <table class="wordstat__search-result-content">
        <tbody></tbody>
      </table>`;
    await fetchColumn(2); // no checkbox → returns silently
    // No exception, no fetch calls
    expect(global.chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });
});