// tests/utils.test.js
import {
  formatNumber,
  getQueryForRow,
  constructVariantQuery,
  getApiQueryForVariant,
  isColumnEnabled,
  getCurrentRegion,
  getCurrentDeviceTypes,
  valueToCellState
} from '../src/content/utils.ts';
import { CELL_STATE, CELL_STATE_GLYPH, COLUMN_INDEX, REGEX } from '../src/config.ts';

describe('formatNumber', () => {
  test('formats integers with thousand separators', () => {
    expect(formatNumber(1234567)).toBe('1 234 567');
  });
  test('handles numeric strings (with spaces)', () => {
    expect(formatNumber('1 234')).toBe('1 234');
  });
  test('returns DISABLED glyph for null/undefined/NaN', () => {
    const disabled = CELL_STATE_GLYPH[CELL_STATE.DISABLED];
    expect(formatNumber(null)).toBe(disabled);
    expect(formatNumber(undefined)).toBe(disabled);
    expect(formatNumber('not a number')).toBe(disabled);
  });
  test('handles zero', () => {
    expect(formatNumber(0)).toBe('0');
  });
});

describe('getQueryForRow', () => {
  test('extracts text from keyword cell', () => {
    const table = document.createElement('table');
    table.innerHTML = `
      <tbody>
        <tr>
          <td><a>купить квартиру</a></td>
          <td>1234</td>
        </tr>
      </tbody>`;
    const row = table.querySelector('tr');
    expect(getQueryForRow(row)).toBe('купить квартиру');
  });
  test('strips leading + or -', () => {
    const table = document.createElement('table');
    table.innerHTML = `
      <tbody>
        <tr>
          <td><a>+купить</a></td>
          <td>1</td>
        </tr>
        <tr>
          <td><a>‒снять</a></td>
          <td>1</td>
        </tr>
      </tbody>`;
    const rows = table.querySelectorAll('tr');
    expect(getQueryForRow(rows[0])).toBe('купить');
    expect(getQueryForRow(rows[1])).toBe('снять');
  });
  test('returns null for empty input', () => {
    const row = document.createElement('tr');
    expect(getQueryForRow(row)).toBeNull();
  });
});

describe('constructVariantQuery', () => {
  test('builds quoted variant (resultIndex=0)', () => {
    expect(constructVariantQuery('купить', 0)).toBe('"купить"');
  });
  test('builds bracketed variant (resultIndex=1)', () => {
    expect(constructVariantQuery('купить', 1)).toBe('"[купить]"');
  });
  test('builds excluded variant (resultIndex=2)', () => {
    expect(constructVariantQuery('купить квартиру', 2)).toBe('"[!купить !квартиру]"');
  });
  test('returns null for invalid resultIndex or empty query', () => {
    expect(constructVariantQuery('', 0)).toBeNull();
    expect(constructVariantQuery('купить', 99)).toBeNull();
  });
  test('replaces internal + with space', () => {
    expect(constructVariantQuery('купить+квартиру', 0)).toBe('"купить квартиру"');
  });
});

describe('getApiQueryForVariant', () => {
  test('base returns cleaned query', () => {
    expect(getApiQueryForVariant('купить', 'base')).toBe('купить');
    expect(getApiQueryForVariant('+купить', 'base')).toBe('купить');
  });
  test('quoted → "W"', () => {
    expect(getApiQueryForVariant('купить', 'quoted')).toBe('"купить"');
  });
  test('bracketed → [W]', () => {
    expect(getApiQueryForVariant('купить', 'bracketed')).toBe('"[купить]"');
  });
  test('excluded → "[!W]"', () => {
    expect(getApiQueryForVariant('a b', 'excluded')).toBe('"[!a !b]"');
  });
  test('unknown key returns null', () => {
    expect(getApiQueryForVariant('x', 'nope')).toBeNull();
  });
  test('empty query returns null', () => {
    expect(getApiQueryForVariant('', 'base')).toBeNull();
  });
});

describe('getCurrentRegion', () => {
  test('returns null when no region param', () => {
    // jsdom default location is about:blank — no search string
    expect(getCurrentRegion()).toBeNull();
  });
  test('decodes %2C to comma', () => {
    // jsdom ≥30 (jest 30) no longer allows replacing window.location with a
    // plain object; use the History API to set the search string instead.
    const original = window.location.href;
    window.history.replaceState({}, '', '/?region=213%2C98598');
    try {
      expect(getCurrentRegion()).toBe('213,98598');
    } finally {
      window.history.replaceState({}, '', original);
    }
  });
});

describe('getCurrentDeviceTypes', () => {
  test('falls back to all three when no checkboxes present', () => {
    expect(getCurrentDeviceTypes()).toBe('desktop,phone,tablet');
  });
  test('returns only checked devices', () => {
    document.body.innerHTML = `
      <div class="wordstat__device-types">
        <input type="checkbox" checked />
        <input type="checkbox" />
        <input type="checkbox" checked />
      </div>`;
    expect(getCurrentDeviceTypes()).toBe('desktop,tablet');
    document.body.innerHTML = '';
  });
});

describe('valueToCellState', () => {
  test('null/undefined → DISABLED', () => {
    expect(valueToCellState(null)).toBe(CELL_STATE.DISABLED);
    expect(valueToCellState(undefined)).toBe(CELL_STATE.DISABLED);
  });
  test('numeric → VALUE', () => {
    expect(valueToCellState(1234)).toBe(CELL_STATE.VALUE);
  });
  test('numeric string with spaces → VALUE', () => {
    expect(valueToCellState('1 234')).toBe(CELL_STATE.VALUE);
  });
  test('non-numeric → DISABLED', () => {
    expect(valueToCellState('abc')).toBe(CELL_STATE.DISABLED);
  });
});