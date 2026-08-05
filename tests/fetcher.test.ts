import { createFetcherBanner } from '../src/content/fetcher.ts';
import {
  CSS_CLASSES,
  LS_FETCHER_BANNER_STATE,
  LS_FETCHER_SIZE_KEY,
  PANEL_MIN_WIDTH,
  PANEL_MAX_WIDTH,
  PANEL_MIN_HEIGHT,
  PANEL_MAX_HEIGHT
} from '../src/config.ts';
import { installChromeShim } from './helpers.ts';

function mockBannerRect(rect: { width: number; height: number; left: number; top: number }): void {
  const container = document.getElementById('fetcher-banner-container') as HTMLElement;
  jest.spyOn(container, 'getBoundingClientRect').mockReturnValue({
    width: rect.width,
    height: rect.height,
    left: rect.left,
    top: rect.top,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    x: rect.left,
    y: rect.top,
    toJSON: () => ({})
  });
}

function fireDragEvent(
  element: Element,
  type: string,
  coords: { clientX: number; clientY: number }
): void {
  element.dispatchEvent(
    new MouseEvent(type, {
      clientX: coords.clientX,
      clientY: coords.clientY,
      bubbles: true,
      cancelable: true
    })
  );
}

describe('createFetcherBanner', () => {
  beforeEach(() => {
    installChromeShim();
    document.body.innerHTML = '';
    localStorage.clear();
  });

  test('creates banner container with all expected elements', () => {
    createFetcherBanner();
    const container = document.getElementById('fetcher-banner-container');
    expect(container).not.toBeNull();
    expect(container.querySelector('.fetcher-banner-hide-button')).not.toBeNull();
    expect(container.querySelector('.fetcher-banner-show-button')).not.toBeNull();
  });

  test('does not create duplicate banner', () => {
    createFetcherBanner();
    createFetcherBanner();
    const containers = document.querySelectorAll('#fetcher-banner-container');
    expect(containers.length).toBe(1);
  });

  test('hide button hides the banner and saves to localStorage', () => {
    createFetcherBanner();
    const container = document.getElementById('fetcher-banner-container');
    const hideBtn = container.querySelector('.fetcher-banner-hide-button') as HTMLButtonElement;
    hideBtn.click();
    expect(container.classList.contains(CSS_CLASSES.FETCHER_BANNER_HIDDEN)).toBe(true);
    expect(localStorage.getItem(LS_FETCHER_BANNER_STATE)).toBe('hidden');
  });

  test('show button un-hides the banner', () => {
    createFetcherBanner();
    const container = document.getElementById('fetcher-banner-container');
    const hideBtn = container.querySelector('.fetcher-banner-hide-button') as HTMLButtonElement;
    const showBtn = container.querySelector('.fetcher-banner-show-button') as HTMLButtonElement;
    hideBtn.click();
    showBtn.click();
    expect(container.classList.contains(CSS_CLASSES.FETCHER_BANNER_HIDDEN)).toBe(false);
    expect(localStorage.getItem(LS_FETCHER_BANNER_STATE)).toBe('shown');
  });

  test('applies hidden class when localStorage state is hidden', () => {
    localStorage.setItem(LS_FETCHER_BANNER_STATE, 'hidden');
    createFetcherBanner();
    const container = document.getElementById('fetcher-banner-container');
    expect(container.classList.contains(CSS_CLASSES.FETCHER_BANNER_HIDDEN)).toBe(true);
  });

  test('creates a resize handle inside the banner container', () => {
    createFetcherBanner();
    const container = document.getElementById('fetcher-banner-container');
    expect(container.querySelector('.fetcher-banner-resize-handle')).not.toBeNull();
  });

  test('applies a stored size from localStorage', () => {
    localStorage.setItem(LS_FETCHER_SIZE_KEY, JSON.stringify({ width: '500px', height: '400px' }));
    createFetcherBanner();
    const container = document.getElementById('fetcher-banner-container') as HTMLElement;
    expect(container.style.width).toBe('500px');
    expect(container.style.height).toBe('400px');
  });

  test('clamps a stored size to the panel limits', () => {
    localStorage.setItem(LS_FETCHER_SIZE_KEY, JSON.stringify({ width: '9999px', height: '10px' }));
    createFetcherBanner();
    const container = document.getElementById('fetcher-banner-container') as HTMLElement;
    expect(container.style.width).toBe(`${PANEL_MAX_WIDTH}px`);
    expect(container.style.height).toBe(`${PANEL_MIN_HEIGHT}px`);
  });

  test('resize handle drag resizes and persists the size', () => {
    createFetcherBanner();
    const container = document.getElementById('fetcher-banner-container') as HTMLElement;
    const handle = container.querySelector('.fetcher-banner-resize-handle') as HTMLElement;

    mockBannerRect({ width: 300, height: 400, left: 100, top: 80 });
    fireDragEvent(handle, 'pointerdown', { clientX: 100, clientY: 80 });
    fireDragEvent(handle, 'pointermove', { clientX: 350, clientY: 280 });
    fireDragEvent(handle, 'pointerup', { clientX: 350, clientY: 280 });

    expect(container.style.width).toBe('550px');
    expect(container.style.height).toBe('600px');
    const saved = JSON.parse(localStorage.getItem(LS_FETCHER_SIZE_KEY) as string);
    expect(saved.width).toBe('550px');
    expect(saved.height).toBe('600px');
  });

  test('resize handle drag clamps to panel limits', () => {
    createFetcherBanner();
    const container = document.getElementById('fetcher-banner-container') as HTMLElement;
    const handle = container.querySelector('.fetcher-banner-resize-handle') as HTMLElement;

    mockBannerRect({ width: 300, height: 400, left: 100, top: 80 });
    fireDragEvent(handle, 'pointerdown', { clientX: 100, clientY: 80 });
    fireDragEvent(handle, 'pointermove', { clientX: 10000, clientY: -10000 });
    fireDragEvent(handle, 'pointerup', { clientX: 10000, clientY: -10000 });

    expect(container.style.width).toBe(`${PANEL_MAX_WIDTH}px`);
    expect(container.style.height).toBe(`${PANEL_MIN_HEIGHT}px`);
  });

  test('double-click on the resize handle resets the size', () => {
    localStorage.setItem(LS_FETCHER_SIZE_KEY, JSON.stringify({ width: '500px', height: '400px' }));
    createFetcherBanner();
    const container = document.getElementById('fetcher-banner-container') as HTMLElement;
    const handle = container.querySelector('.fetcher-banner-resize-handle') as HTMLElement;

    handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

    expect(container.style.width).toBe('');
    expect(container.style.height).toBe('');
    expect(localStorage.getItem(LS_FETCHER_SIZE_KEY)).toBeNull();
  });
});
