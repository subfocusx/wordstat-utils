// src/content/shortcuts.ts
// Keyboard shortcuts for the fetcher. Mirrors the original v1.3.2.2
// shortcuts.js behaviour but with the new toast UX and clear ownership.
//
// Currently wired:
//   Ctrl+Enter / Cmd+Enter — start the fetcher batch
//   Esc                       — cancel the running batch
//
// Shortcuts only fire when the user is *not* typing in the fetcher's own
// input/output areas — they pass through to the page elsewhere.

import { FetcherController } from './fetcher-menu.ts';

const FETCHER_INPUT_CLASS = 'gfd_fetcher-input';
const FETCHER_OUTPUT_CLASS = 'gfd_fetcher-output';

function isFetcherTextareaFocused(): boolean {
  const active = document.activeElement;
  if (!active) return false;
  const tag = active.tagName;
  if (tag !== 'TEXTAREA' && tag !== 'INPUT') return false;
  return (
    (active as HTMLElement).classList.contains(FETCHER_INPUT_CLASS) ||
    (active as HTMLElement).classList.contains(FETCHER_OUTPUT_CLASS)
  );
}

export function initializeShortcuts(controller: FetcherController): void {
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    // Ctrl+Enter or Cmd+Enter — start batch from anywhere on the page.
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      // Focus the input first so the user can see what they're firing on.
      const input = controller.controls?.inputArea;
      if (input) {
        input.focus();
      }
      controller.handleFetcherStartClick();
      return;
    }

    // Esc — cancel the running batch (only when fetcher input has focus).
    if (e.key === 'Escape' && controller.isProcessing && isFetcherTextareaFocused()) {
      e.preventDefault();
      controller.cancelRunningBatch();
    }
  });
}
