// tests/shortcuts.test.js
import { initializeShortcuts } from '../src/content/shortcuts.ts';
import { FetcherController } from '../src/content/fetcher-menu.ts';
import { installChromeShim } from './helpers.ts';

describe('initializeShortcuts', () => {
  const disposers: Array<() => void> = [];

  beforeEach(() => {
    installChromeShim();
    localStorage.clear();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    // Each test binds a document-level listener; without teardown the previous
    // controllers keep reacting and the assertions stop being about one case.
    while (disposers.length) disposers.pop()?.();
  });

  function setup() {
    const ctrl = new FetcherController();
    const container = document.createElement('div');
    ctrl.createFetcherMenuElements(container);
    document.body.appendChild(container);
    disposers.push(initializeShortcuts(ctrl));
    return ctrl;
  }

  test('Ctrl+Enter triggers handleFetcherStartClick and focuses the input', () => {
    const ctrl = setup();
    const spy = jest.spyOn(ctrl, 'handleFetcherStartClick').mockImplementation(() => {});
    const evt = new KeyboardEvent('keydown', {
      key: 'Enter',
      ctrlKey: true,
      bubbles: true,
      cancelable: true
    });
    document.dispatchEvent(evt);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(evt.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(ctrl.controls.inputArea);
  });

  test('Esc cancels a running batch when the fetcher textarea is focused', () => {
    const ctrl = setup();
    const cancelSpy = jest.spyOn(ctrl, 'cancelRunningBatch');
    ctrl.isProcessing = true;
    ctrl.controls.inputArea.focus();
    const evt = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true
    });
    document.dispatchEvent(evt);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(evt.defaultPrevented).toBe(true);
  });

  test('Esc does nothing when no batch is processing', () => {
    const ctrl = setup();
    const cancelSpy = jest.spyOn(ctrl, 'cancelRunningBatch');
    const evt = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true
    });
    document.dispatchEvent(evt);
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(evt.defaultPrevented).toBe(false);
  });

  test('Esc cancels from a foreign text field too', () => {
    const ctrl = setup();
    const cancelSpy = jest.spyOn(ctrl, 'cancelRunningBatch');
    ctrl.isProcessing = true;
    const foreign = document.createElement('input');
    document.body.appendChild(foreign);
    foreign.focus();
    const evt = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true
    });
    document.dispatchEvent(evt);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });

  test('Ctrl+Enter is ignored while typing in a foreign text field', () => {
    const ctrl = setup();
    const spy = jest.spyOn(ctrl, 'handleFetcherStartClick').mockImplementation(() => {});
    const foreign = document.createElement('input');
    document.body.appendChild(foreign);
    foreign.focus();
    const evt = new KeyboardEvent('keydown', {
      key: 'Enter',
      ctrlKey: true,
      bubbles: true,
      cancelable: true
    });
    document.dispatchEvent(evt);
    expect(spy).not.toHaveBeenCalled();
    expect(evt.defaultPrevented).toBe(false);
  });

  test('Ctrl+Enter is ignored while a batch is already running', () => {
    const ctrl = setup();
    const spy = jest.spyOn(ctrl, 'handleFetcherStartClick').mockImplementation(() => {});
    ctrl.isProcessing = true;
    const evt = new KeyboardEvent('keydown', {
      key: 'Enter',
      ctrlKey: true,
      bubbles: true,
      cancelable: true
    });
    document.dispatchEvent(evt);
    expect(spy).not.toHaveBeenCalled();
  });

  test('returns a disposer that unbinds the listener', () => {
    const ctrl = new FetcherController();
    const container = document.createElement('div');
    ctrl.createFetcherMenuElements(container);
    document.body.appendChild(container);
    const dispose = initializeShortcuts(ctrl);
    disposers.push(dispose);
    const spy = jest.spyOn(ctrl, 'handleFetcherStartClick').mockImplementation(() => {});
    dispose();
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      ctrlKey: true,
      bubbles: true,
      cancelable: true
    }));
    expect(spy).not.toHaveBeenCalled();
  });
});
