// src/content/main.ts
// Entry point for the content script.
// [M1] MutationObserver вместо setInterval — отсутствие ошибок 1 Гц, снижающее нагрузку.

import {
  EVENTS,
  SCRIPT_LOADED_FLAG,
  YANDEX_RATE_LIMIT_KEY,
  YANDEX_RATE_LIMIT_VALUE
} from '../config.ts';
import { TableViewManager } from './table-view.ts';
import { createFetcherBanner } from './fetcher.ts';
import { initializeShortcuts } from './shortcuts.ts';

const viewManager = new TableViewManager();

function applyYandexRateLimitFix(): void {
  // [MIRRORS ORIGINAL v1.3.2.2 content_script.js:143-144] — runs at
  // module load time (not inside run()) so it executes even if the page is
  // still "loading" and run() is queued for DOMContentLoaded. The original
  // extension does this on the top level of content_script.js, confirmed
  // working.
  try {
    localStorage.setItem(YANDEX_RATE_LIMIT_KEY, YANDEX_RATE_LIMIT_VALUE);
  } catch {
    // ignore quota / disabled storage
  }
}

function initializeOrUpdateTable(): void {
  viewManager.installLifecycleHooks();
  viewManager.initializeTable();
  viewManager.startPolling();
}

function run(): void {
  const controller = createFetcherBanner();
  if (controller) initializeShortcuts(controller);
}

// [MIRRORS ORIGINAL v1.3.2.2 content_script.js:143-144] — runs at
// module load time (not inside run()) so it executes even if the page is
// still "loading" and run() is queued for DOMContentLoaded. The original
// extension does this on the top level of content_script.js, confirmed
// working.
applyYandexRateLimitFix();

if (!(window as any)[SCRIPT_LOADED_FLAG]) {
  (window as any)[SCRIPT_LOADED_FLAG] = true;
  if (document.readyState === EVENTS.READY_STATE_LOADING) {
    document.addEventListener(EVENTS.DOM_CONTENT_LOADED, () => {
      initializeOrUpdateTable();
      run();
    });
  } else {
    setTimeout(() => {
      initializeOrUpdateTable();
      run();
    }, 0);
  }
}

// Exported for testing.
export { viewManager };