// src/content/shortcuts.ts
// Keyboard shortcuts for the fetcher.
//
//   Ctrl+Enter / Cmd+Enter — start the fetcher batch
//   Esc                       — cancel the running batch
//
// Both shortcuts are page-global, so they must stay out of the user's way while
// typing: Ctrl+Enter is ignored when the caret is in a text field we do not own,
// and Esc cancels from any field (a half-typed keyword list is still cancellable).
// Returning a teardown function keeps the listener from leaking if the content
// script is re-injected on the same page.

import { CSS_CLASSES } from '../config.ts';
import { FetcherController } from './fetcher-menu.ts';

const FETCHER_INPUT_CLASS = CSS_CLASSES.FETCHER_INPUT;
const FETCHER_OUTPUT_CLASS = CSS_CLASSES.FETCHER_OUTPUT;

function isFetcherFieldFocused(): boolean {
  const active = document.activeElement;
  if (!active) return false;
  const tag = active.tagName;
  if (tag !== 'TEXTAREA' && tag !== 'INPUT') return false;
  return (
    (active as HTMLElement).classList.contains(FETCHER_INPUT_CLASS) ||
    (active as HTMLElement).classList.contains(FETCHER_OUTPUT_CLASS)
  );
}

/**
 * The element the caret is actually in. `event.target` is unreliable for a
 * document-level listener: a keydown can arrive with document (or the
 * listener's container) as its target while the user types in a field, so
 * focus — not the event target — is the source of truth here.
 */
function typingElement(): HTMLElement | null {
  const active = document.activeElement;
  return active && active !== document.body ? (active as HTMLElement) : null;
}

/**
 * True when the user is typing into something we do not own: WordStat's own
 * keyword filters, any page input, or a contenteditable region. Swallowing
 * Ctrl+Enter there broke the user's own form — Enter inserted a line break or
 * submitted a field, and our handler took it over.
 */
function isForeignTextEntry(): boolean {
  if (isFetcherFieldFocused()) return false;
  const el = typingElement();
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return true;
  return el.isContentEditable === true;
}

/** Teardown for the global listener; call it to unbind. */
export type ShortcutsDisposer = () => void;

export function initializeShortcuts(controller: FetcherController): ShortcutsDisposer {
  const onKeyDown = (e: KeyboardEvent): void => {
    // Ctrl+Enter or Cmd+Enter — start a batch, unless a batch is already
    // running or the user is typing in a field we don't own.
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      if (controller.isProcessing || isForeignTextEntry()) return;
      e.preventDefault();
      // Focus our input first so the user can see what they are firing on.
      controller.controls?.inputArea?.focus();
      controller.handleFetcherStartClick();
      return;
    }

    // Esc — cancel the running batch, from any field.
    if (e.key === 'Escape' && controller.isProcessing) {
      e.preventDefault();
      controller.cancelRunningBatch();
    }
  };

  document.addEventListener('keydown', onKeyDown);
  return () => document.removeEventListener('keydown', onKeyDown);
}