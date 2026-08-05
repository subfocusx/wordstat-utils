// tests/fetcher-menu.test.js
import { FetcherController } from '../src/content/fetcher-menu.ts';
import { FetcherError } from '../src/content/cache.ts';
import { LS_FETCHER_CHECKBOX_KEY, FETCHER_VARIANT_ORDER, CELL_STATE_GLYPH, CELL_STATE } from '../src/config.ts';
import { installChromeShim, makeStorage } from './helpers.ts';

function makeController() {
  return new FetcherController();
}

describe('createFetcherMenuElements', () => {
  beforeEach(() => {
    installChromeShim();
    localStorage.clear();
  });

  test('creates all expected controls', () => {
    const controller = makeController();
    const container = document.createElement('div');
    controller.createFetcherMenuElements(container);
    expect(container.querySelector('textarea')).not.toBeNull();
    expect(controller.controls.inputArea).toBeDefined();
    expect(controller.controls.outputArea).toBeDefined();
    expect(controller.controls.button).toBeDefined();
    expect(controller.controls.clearButton).toBeDefined();
    expect(controller.controls.progressBar).toBeDefined();
    expect(FETCHER_VARIANT_ORDER.every((k) => controller.controls.checkboxes[k])).toBe(true);
  });

  test('creates cancel and retry buttons, initially hidden', () => {
    const controller = makeController();
    const container = document.createElement('div');
    controller.createFetcherMenuElements(container);
    expect(controller.controls.cancelButton).toBeDefined();
    expect(controller.controls.retryButton).toBeDefined();
    expect(controller.controls.cancelButton.style.display).toBe('none');
    expect(controller.controls.retryButton.style.display).toBe('none');
  });

  test('first-time load defaults all checkboxes to true', () => {
    const controller = makeController();
    const container = document.createElement('div');
    controller.createFetcherMenuElements(container);
    Object.values(controller.controls.checkboxes).forEach((cb) => {
      expect(cb.checked).toBe(true);
    });
  });

  test('respects stored checkbox state', () => {
    const stored = { base: false, quoted: true, bracketed: false, excluded: true };
    localStorage.setItem(LS_FETCHER_CHECKBOX_KEY, JSON.stringify(stored));
    const controller = makeController();
    const container = document.createElement('div');
    controller.createFetcherMenuElements(container);
    expect(controller.controls.checkboxes.base.checked).toBe(false);
    expect(controller.controls.checkboxes.quoted.checked).toBe(true);
    expect(controller.controls.checkboxes.bracketed.checked).toBe(false);
    expect(controller.controls.checkboxes.excluded.checked).toBe(true);
  });
});
describe('handleFetcherStartClick (M10: only cache successes)', () => {
  beforeEach(() => {
    installChromeShim();
    localStorage.clear();
    document.body.innerHTML = '';
  });

  function setupController(inputValue?: string) {
    const ctrl = makeController();
    const container = document.createElement('div');
    ctrl.createFetcherMenuElements(container);
    ctrl.controls.inputArea.value = inputValue ?? '';
    return ctrl;
  }

  test('shows warn toast when no checkboxes are selected', () => {
    const ctrl = setupController('foo\nbar');
    FETCHER_VARIANT_ORDER.forEach((k) => {
      ctrl.controls.checkboxes[k].checked = false;
    });
    ctrl.handleFetcherStartClick();
    const toast = document.querySelector('.gfd_toast_warn');
    expect(toast).not.toBeNull();
    expect(toast?.textContent).toMatch(/чекбокс/);
  });

  test('shows warn toast when input is empty', () => {
    const ctrl = setupController('');
    ctrl.handleFetcherStartClick();
    const toast = document.querySelector('.gfd_toast_warn');
    expect(toast).not.toBeNull();
    expect(toast?.textContent).toMatch(/ключевые слова/);
  });

  test('builds the queue and starts the run on valid input', async () => {
    const orig = global.setTimeout.bind(global);
    (global as any).setTimeout = (fn: (...args: unknown[]) => void, _ms?: number, ...args: unknown[]) => {
      return (orig as any)(fn, 0, ...args);
    };
    const ctrl = setupController('купить\nснять');
    global.chrome.runtime.sendMessage.mockResolvedValue({
      success: true,
      data: { totalValue: 42 }
    });
    ctrl.handleFetcherStartClick();
    expect(ctrl.fetchQueue.length).toBe(8);
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => orig(r, 0));
      if (!ctrl.isProcessing) break;
    }
    expect(ctrl.isProcessing).toBe(false);
    expect(ctrl.controls.outputArea.value).toContain('купить');
    (global as any).setTimeout = orig;
  });

  test('shows a completion toast with counts', async () => {
    const orig = global.setTimeout.bind(global);
    (global as any).setTimeout = (fn: (...args: unknown[]) => void, _ms?: number, ...args: unknown[]) => {
      return (orig as any)(fn, 0, ...args);
    };
    const ctrl = setupController('купить\nснять');
    global.chrome.runtime.sendMessage.mockResolvedValue({
      success: true,
      data: { totalValue: 42 }
    });
    ctrl.handleFetcherStartClick();
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => orig(r, 0));
      if (!ctrl.isProcessing) break;
    }
    expect(ctrl.isProcessing).toBe(false);
    const toast = document.querySelector('.gfd_toast_success');
    expect(toast?.textContent).toMatch(/Готово: 2\/2 запросов · ошибок 0/);
    (global as any).setTimeout = orig;
  });
});

describe('processFetcherQueueItem (M10)', () => {
  beforeEach(() => {
    installChromeShim();
    localStorage.clear();
  });

  async function runProcessItem(overrides = {}) {
    const ctrl = makeController();
    ctrl.results = [{ originalQuery: 'x', originalIndex: 0, values: {} }];
    const task = {
      query: 'x', variantKey: 'quoted' as const, apiQuery: '"x"',
      jobIndex: 0, region: null, deviceTypes: 'desktop,phone,tablet',
      limiter: null,
      ...overrides
    };
    // Access private method via bracket notation for testing
    await (ctrl as any).processFetcherQueueItem(task);
    return ctrl;
  }

  test('saves only successful fetches to cache', async () => {
    global.chrome.runtime.sendMessage.mockResolvedValueOnce({
      success: true,
      data: { totalValue: null }
    });
    const ctrl = await runProcessItem();
    const stored = localStorage.getItem('gfd_WS_Cache');
    if (stored) {
      expect(stored).not.toContain('x');
    } else {
      expect(stored).toBeNull();
    }
    expect(ctrl.results[0].values.quoted).toBeNull();
  });

  test('persists successful value to cache', async () => {
    global.chrome.runtime.sendMessage.mockResolvedValue({
      success: true,
      data: { totalValue: 1234 }
    });
    const ctrl = makeController();
    ctrl.results = [{ originalQuery: 'купить', originalIndex: 0, values: {} }];
    const task = {
      query: 'купить', variantKey: 'quoted' as const, apiQuery: '"купить"',
      jobIndex: 0, region: null, deviceTypes: 'desktop,phone,tablet',
      limiter: null
    };
    await (ctrl as any).processFetcherQueueItem(task);
    const stored = JSON.parse(localStorage.getItem('gfd_WS_Cache'));
    expect(stored['купить']['']['desktop,phone,tablet'].variants[0]).toBe(1234);
    expect(ctrl.results[0].values.quoted).toBe(1234);
  });
});

describe('updateFetcherOutputDisplay (debounced)', () => {
  beforeEach(() => {
    installChromeShim();
    localStorage.clear();
  });

  test('renders once for multiple rapid updates in the same frame', async () => {
    const ctrl = makeController();
    const container = document.createElement('div');
    ctrl.createFetcherMenuElements(container);
    ctrl.results = [
      { originalQuery: 'a', originalIndex: 0, values: { quoted: 1 } },
      { originalQuery: 'b', originalIndex: 1, values: { quoted: 2 } }
    ];
    ctrl.selectedVariants = ['quoted'];
    const spy = jest.spyOn(ctrl as any, '_renderFetcherOutput');
    ctrl.updateFetcherOutputDisplay();
    ctrl.updateFetcherOutputDisplay();
    ctrl.updateFetcherOutputDisplay();
    expect(spy).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 20));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(ctrl.controls.outputArea.value).toContain('a');
    expect(ctrl.controls.outputArea.value).toContain('b');
  });

  test('enableFetcherUI flushes the pending render synchronously', () => {
    const ctrl = makeController();
    const container = document.createElement('div');
    ctrl.createFetcherMenuElements(container);
    ctrl.results = [{ originalQuery: 'x', originalIndex: 0, values: { quoted: 42 } }];
    ctrl.selectedVariants = ['quoted'];
    ctrl.updateFetcherOutputDisplay();
    ctrl.enableFetcherUI();
    expect(ctrl.controls.outputArea.value).toContain('42');
  });
});

describe('cancelRunningBatch', () => {
  beforeEach(() => {
    installChromeShim();
    localStorage.clear();
    document.body.innerHTML = '';
  });

  test('cancels the queue, re-enables the UI and shows a toast', () => {
    const ctrl = makeController();
    const container = document.createElement('div');
    ctrl.createFetcherMenuElements(container);
    ctrl.disableFetcherUI();
    expect(ctrl.controls.cancelButton.style.display).not.toBe('none');

    const cancelSpy = jest.fn();
    (ctrl as any)._queueHandle = { cancel: cancelSpy };
    ctrl.cancelRunningBatch();

    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect((ctrl as any)._queueHandle).toBeNull();
    expect(ctrl.isProcessing).toBe(false);
    expect(ctrl.controls.cancelButton.style.display).toBe('none');
    const toast = document.querySelector('.gfd_toast_warn');
    expect(toast?.textContent).toBe('Пакет остановлен');
  });

  test('does nothing when no batch is running', () => {
    const ctrl = makeController();
    const container = document.createElement('div');
    ctrl.createFetcherMenuElements(container);
    const toastCount = document.querySelectorAll('.gfd_toast').length;
    ctrl.cancelRunningBatch();
    expect(document.querySelectorAll('.gfd_toast').length).toBe(toastCount);
  });
});

describe('handleRetryClick', () => {
  beforeEach(() => {
    installChromeShim();
    localStorage.clear();
    document.body.innerHTML = '';
  });

  test('rebuilds the queue from failed tasks and re-runs', () => {
    const ctrl = makeController();
    const container = document.createElement('div');
    ctrl.createFetcherMenuElements(container);
    ctrl.results = [{ originalQuery: 'x', originalIndex: 0, values: { quoted: null } }];
    ctrl.failedTasks = [
      new FetcherError('boom', 'x', 'quoted', '"x"', 0, null, 'desktop,phone,tablet')
    ];
    const runSpy = jest
      .spyOn(ctrl as any, 'runFetcherQueue')
      .mockImplementation(() => Promise.resolve());
    const disableSpy = jest.spyOn(ctrl as any, 'disableFetcherUI');

    (ctrl as any).handleRetryClick();

    expect(ctrl.fetchQueue).toHaveLength(1);
    expect(ctrl.fetchQueue[0].query).toBe('x');
    expect(ctrl.fetchQueue[0].variantKey).toBe('quoted');
    expect(ctrl.fetchQueue[0].apiQuery).toBe('"x"');
    expect(ctrl.fetchQueue[0].jobIndex).toBe(0);
    expect(ctrl.failedTasks).toHaveLength(0);
    expect(ctrl.results[0].values.quoted).toBeNull();
    expect(disableSpy).toHaveBeenCalled();
    expect(runSpy).toHaveBeenCalled();
  });

  test('shows an info toast when there are no failed tasks', () => {
    const ctrl = makeController();
    const container = document.createElement('div');
    ctrl.createFetcherMenuElements(container);
    (ctrl as any).handleRetryClick();
    const toast = document.querySelector('.gfd_toast_info');
    expect(toast?.textContent).toBe('Нет ошибок для повтора');
    expect(ctrl.fetchQueue).toHaveLength(0);
  });
});

describe('updateProgressBarDisplay', () => {
  beforeEach(() => {
    installChromeShim();
    localStorage.clear();
  });

  test('shows completed/total counter and percentage', () => {
    const ctrl = makeController();
    const container = document.createElement('div');
    ctrl.createFetcherMenuElements(container);
    ctrl.totalTasks = 4;
    ctrl.completedTasks = 1;
    ctrl.updateProgressBarDisplay();
    expect(ctrl.controls.progressText.textContent).toBe('1/4 · 25%');
    expect(ctrl.controls.progressContainer.style.display).toBe('flex');
  });

  test('adds an error badge and has-errors class when failures exist', () => {
    const ctrl = makeController();
    const container = document.createElement('div');
    ctrl.createFetcherMenuElements(container);
    ctrl.totalTasks = 4;
    ctrl.completedTasks = 3;
    ctrl.failedTasks = [
      new FetcherError('boom', 'x', 'quoted', '"x"', 0, null, 'desktop,phone,tablet')
    ];
    ctrl.updateProgressBarDisplay();
    expect(ctrl.controls.progressErrors.style.display).toBe('inline');
    expect(ctrl.controls.progressErrors.textContent).toBe('❌1');
    expect(ctrl.controls.progressContainer.classList.contains('has-errors')).toBe(true);
  });

  test('hides the progress when totalTasks is zero', () => {
    const ctrl = makeController();
    const container = document.createElement('div');
    ctrl.createFetcherMenuElements(container);
    ctrl.totalTasks = 0;
    ctrl.updateProgressBarDisplay();
    expect(ctrl.controls.progressContainer.style.display).toBe('none');
  });
});
