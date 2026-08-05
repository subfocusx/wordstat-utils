// tests/helpers.js
// Shared test helpers: localStorage stub, chrome.* stub, DOM factories.

import { LS_CACHE_KEY, PREFIX } from '../src/config.ts';

/** Create a localStorage stub backed by a plain object. */
export function makeStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: jest.fn((k) => (k in data ? data[k] : null)),
    setItem: jest.fn((k, v) => {
      data[k] = String(v);
    }),
    removeItem: jest.fn((k) => {
      delete data[k];
    }),
    clear: jest.fn(() => {
      for (const k of Object.keys(data)) delete data[k];
    }),
    _data: data
  };
}

/** Create a minimal jsdom table with N rows of given queries. */
export function makeTable(rows = 3) {
  const table = document.createElement('table');
  table.innerHTML = `
    <thead><tr><th>Word</th><th>Base</th><th>«W»</th><th>[W]</th><th>«[!W]»</th><th>Copy</th></tr></thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector('tbody');
  for (let i = 0; i < rows; i++) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><a>keyword ${i}</a></td>
      <td>${(i + 1) * 100}</td>
      <td></td><td></td><td></td><td></td>
    `;
    tbody.appendChild(tr);
  }
  return table;
}

/** Stub the chrome.* APIs that code touches. */
export function installChromeShim(overrides = {}) {
  const handlers = new Map();
  const cookies = { getAll: jest.fn(async () => []) };
  const runtime = {
    sendMessage: jest.fn(async () => ({ success: true, data: { totalValue: 0 } })),
    onMessage: {
      addListener: jest.fn((cb) => {
        handlers.set('onMessage', cb);
      })
    },
    onInstalled: { addListener: jest.fn() },
    onStartup: { addListener: jest.fn() },
    lastError: null,
    getURL: jest.fn((path: string) => `chrome-extension://test/${path}`)
  };
  const alarms = {
    create: jest.fn(),
    onAlarm: { addListener: jest.fn() }
  };
  const storage = {
    local: {
      get: jest.fn(async () => ({})),
      set: jest.fn(async () => undefined)
    }
  };
  global.chrome = {
    cookies,
    runtime,
    alarms,
    storage,
    ...overrides
  };
  return global.chrome;
}

/** Trigger a chrome.runtime.onMessage listener with the given payload. */
export function dispatchMessage(payload) {
  const handler = global.chrome.runtime.onMessage.addListener.mock.calls
    .map((c) => c[0])
    .pop();
  return new Promise((resolve) => {
    handler(payload, { id: 'test' }, resolve);
  });
}

export { LS_CACHE_KEY, PREFIX };