// src/content/fetcher.js
// Top-right banner with the Fetcher UI and a hide/show toggle.

import {
  CSS_CLASSES,
  LS_FETCHER_BANNER_STATE,
  LS_FETCHER_POS_KEY,
  LS_FETCHER_SIZE_KEY,
  PANEL_MIN_WIDTH,
  PANEL_MAX_WIDTH,
  PANEL_MIN_HEIGHT,
  PANEL_MAX_HEIGHT,
  PANEL_DEFAULT_WIDTH,
  UI_TEXT
} from '../config.ts';
import { FetcherController } from './fetcher-menu.ts';

/**
 * Create the fetcher banner and return the FetcherController so callers
 * (e.g. shortcuts.ts) can drive it programmatically.
 *
 * Returns null when the banner already exists without a controller we own, or
 * when document.body is not available yet — callers must not treat that as a
 * usable controller, which is what the previous `as unknown as` cast did.
 */
export function createFetcherBanner(): FetcherController | null {
  if (document.getElementById(CSS_CLASSES.FETCHER_BANNER_CONTAINER_ID)) {
    // Already created — hand back the controller only if we still have it.
    return _existingController;
  }
  if (!document.body) return null;

  const bannerContainer = document.createElement('div');
  bannerContainer.id = CSS_CLASSES.FETCHER_BANNER_CONTAINER_ID;
  // Both the unprefixed class (base styles in fetcher.css) and the prefixed
  // one (hide/show rules target `.gfd_fetcher-banner-container.gfd_fetcher-banner-hidden`)
  // are needed; without the prefixed class the collapse button does nothing.
  bannerContainer.classList.add(CSS_CLASSES.FETCHER_BANNER_CONTAINER);

  const controller = new FetcherController();

  const header = document.createElement('div');
  header.className = CSS_CLASSES.FETCHER_BANNER_HEADER;
  header.title = UI_TEXT.FETCHER_DRAG_HINT;

  const title = document.createElement('span');
  title.className = CSS_CLASSES.FETCHER_BANNER_TITLE;
  title.textContent = UI_TEXT.FETCHER_TITLE;
  header.appendChild(title);

  const dragHandle = document.createElement('span');
  dragHandle.className = CSS_CLASSES.FETCHER_BANNER_DRAG;
  dragHandle.textContent = '⠿';
  dragHandle.title = UI_TEXT.FETCHER_DRAG_HINT;
  header.appendChild(dragHandle);

  const hideButton = document.createElement('button');
  hideButton.textContent = UI_TEXT.FETCHER_BANNER_HIDE_TEXT;
  hideButton.classList.add(CSS_CLASSES.FETCHER_BANNER_BUTTON, CSS_CLASSES.FETCHER_BANNER_HIDE);
  hideButton.addEventListener('click', () => {
    bannerContainer.classList.add(CSS_CLASSES.FETCHER_BANNER_HIDDEN);
    localStorage.setItem(LS_FETCHER_BANNER_STATE, 'hidden');
  });
  header.appendChild(hideButton);

  const showButton = document.createElement('button');
  showButton.textContent = UI_TEXT.FETCHER_BANNER_SHOW_TEXT;
  showButton.classList.add(CSS_CLASSES.FETCHER_BANNER_BUTTON, CSS_CLASSES.FETCHER_BANNER_SHOW);
  showButton.addEventListener('click', () => {
    bannerContainer.classList.remove(CSS_CLASSES.FETCHER_BANNER_HIDDEN);
    localStorage.setItem(LS_FETCHER_BANNER_STATE, 'shown');
  });

  bannerContainer.appendChild(header);
  controller.createFetcherMenuElements(bannerContainer);
  bannerContainer.appendChild(showButton);

  const resizeHandle = document.createElement('div');
  resizeHandle.className = CSS_CLASSES.FETCHER_BANNER_RESIZE_HANDLE;
  resizeHandle.title = UI_TEXT.FETCHER_RESIZE_HINT;
  bannerContainer.appendChild(resizeHandle);

  const stored = localStorage.getItem(LS_FETCHER_BANNER_STATE);
  if (stored === 'hidden') bannerContainer.classList.add(CSS_CLASSES.FETCHER_BANNER_HIDDEN);

  _wireDragging(bannerContainer, header);
  _applyStoredPosition(bannerContainer);
  _wireResizing(bannerContainer, resizeHandle);
  _applyStoredSize(bannerContainer);

  document.body.appendChild(bannerContainer);
  // Only cache the controller once the banner is fully wired and in the DOM;
  // a failure above would otherwise leave later callers with a dead instance.
  _existingController = controller;
  return controller;
}

function _wireDragging(bannerContainer: HTMLElement, header: HTMLElement): void {
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;
  let startScrollX = 0;
  let startScrollY = 0;
  let pointerId: number | null = null;

  header.addEventListener('pointerdown', (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    startScrollX = window.scrollX;
    startScrollY = window.scrollY;
    const rect = bannerContainer.getBoundingClientRect();
    startLeft = rect.left;
    startTop = rect.top;
    pointerId = e.pointerId;
    if (typeof header.setPointerCapture === 'function' && pointerId !== null) {
      try { header.setPointerCapture(pointerId); } catch { /* not capturable */ }
    }
    e.preventDefault();
  });

  header.addEventListener('pointermove', (e: PointerEvent) => {
    if (!dragging) return;
    // clientX/clientY are viewport-relative, so a scroll between pointerdown and
    // pointermove would otherwise shift the panel by the scrolled distance.
    const scrollDeltaX = window.scrollX - startScrollX;
    const scrollDeltaY = window.scrollY - startScrollY;
    const left = Math.min(
      window.innerWidth - 60,
      Math.max(4, startLeft + (e.clientX - startX) + scrollDeltaX)
    );
    const top = Math.max(4, startTop + (e.clientY - startY) + scrollDeltaY);
    bannerContainer.style.left = `${left}px`;
    bannerContainer.style.top = `${top}px`;
    bannerContainer.style.right = 'auto';
  });

  const stopDrag = (): void => {
    if (!dragging) return;
    dragging = false;
    if (pointerId !== null && typeof header.releasePointerCapture === 'function') {
      try { header.releasePointerCapture(pointerId); } catch { /* already released */ }
    }
    pointerId = null;
    if (bannerContainer.style.left && bannerContainer.style.top) {
      try {
        localStorage.setItem(LS_FETCHER_POS_KEY, JSON.stringify({
          left: bannerContainer.style.left,
          top: bannerContainer.style.top
        }));
      } catch { /* ignore quota errors */ }
    }
  };

  header.addEventListener('pointerup', stopDrag);
  header.addEventListener('pointercancel', stopDrag);

  header.addEventListener('dblclick', () => {
    bannerContainer.style.left = '';
    bannerContainer.style.top = '';
    bannerContainer.style.right = '';
    localStorage.removeItem(LS_FETCHER_POS_KEY);
  });
}

function _applyStoredPosition(bannerContainer: HTMLElement): void {
  try {
    const raw = localStorage.getItem(LS_FETCHER_POS_KEY);
    if (!raw) return;
    const pos = JSON.parse(raw) as { left?: string; top?: string } | null;
    if (pos && typeof pos.left === 'string' && typeof pos.top === 'string') {
      bannerContainer.style.left = pos.left;
      bannerContainer.style.top = pos.top;
      bannerContainer.style.right = 'auto';
    }
  } catch { /* ignore malformed persisted position */ }
}

function _clampPanelWidth(value: number): number {
  return Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, window.innerWidth - 24, value));
}

function _clampPanelHeight(value: number): number {
  return Math.max(PANEL_MIN_HEIGHT, Math.min(PANEL_MAX_HEIGHT, window.innerHeight - 24, value));
}

function _wireResizing(bannerContainer: HTMLElement, handle: HTMLElement): void {
  let resizing = false;
  let startX = 0;
  let startY = 0;
  let startWidth = 0;
  let startHeight = 0;
  let startScrollX = 0;
  let startScrollY = 0;

  handle.addEventListener('pointerdown', (e: PointerEvent) => {
    resizing = true;
    startX = e.clientX;
    startY = e.clientY;
    startScrollX = window.scrollX;
    startScrollY = window.scrollY;
    const rect = bannerContainer.getBoundingClientRect();
    startWidth = rect.width || PANEL_DEFAULT_WIDTH;
    startHeight = rect.height;
    // Pin the panel to a left/top anchor so the size grows right/down and the
    // default `right: 10px` doesn't make it jump while resizing.
    bannerContainer.style.left = `${rect.left}px`;
    bannerContainer.style.top = `${rect.top}px`;
    bannerContainer.style.right = 'auto';
    if (typeof handle.setPointerCapture === 'function' && e.pointerId !== null) {
      try { handle.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    }
    e.preventDefault();
    e.stopPropagation();
  });

  handle.addEventListener('pointermove', (e: PointerEvent) => {
    if (!resizing) return;
    // Account for page scroll between pointerdown and pointermove, otherwise the
    // panel jumps by the scrolled distance mid-resize.
    const dx = (e.clientX - startX) + (window.scrollX - startScrollX);
    const dy = (e.clientY - startY) + (window.scrollY - startScrollY);
    const width = _clampPanelWidth(startWidth + dx);
    const height = _clampPanelHeight(startHeight + dy);
    bannerContainer.style.width = `${width}px`;
    bannerContainer.style.height = `${height}px`;
  });

  const stopResize = (e: PointerEvent): void => {
    if (!resizing) return;
    resizing = false;
    if (typeof handle.releasePointerCapture === 'function' && e.pointerId !== null) {
      try { handle.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    }
    try {
      localStorage.setItem(LS_FETCHER_SIZE_KEY, JSON.stringify({
        width: bannerContainer.style.width,
        height: bannerContainer.style.height
      }));
    } catch { /* ignore quota errors */ }
  };

  handle.addEventListener('pointerup', stopResize);
  handle.addEventListener('pointercancel', stopResize);

  handle.addEventListener('dblclick', () => {
    bannerContainer.style.width = '';
    bannerContainer.style.height = '';
    localStorage.removeItem(LS_FETCHER_SIZE_KEY);
  });
}

function _applyStoredSize(bannerContainer: HTMLElement): void {
  try {
    const raw = localStorage.getItem(LS_FETCHER_SIZE_KEY);
    if (!raw) return;
    const size = JSON.parse(raw) as { width?: string; height?: string } | null;
    if (!size) return;
    const w = parseFloat(size.width ?? '');
    const h = parseFloat(size.height ?? '');
    if (!Number.isNaN(w) && w > 0) {
      bannerContainer.style.width = `${_clampPanelWidth(w)}px`;
    }
    if (!Number.isNaN(h) && h > 0) {
      bannerContainer.style.height = `${_clampPanelHeight(h)}px`;
    }
    if (size.width || size.height) bannerContainer.style.right = 'auto';
  } catch { /* ignore malformed persisted size */ }
}

// Module-level cache so repeat calls return the same instance.
// We can't put it inside createFetcherBanner because each module load creates
// a new closure; a top-level let works across calls within one page.
let _existingController: FetcherController | null = null;