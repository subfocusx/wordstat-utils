// tests/shortcuts.test.js
import { initializeShortcuts } from '../src/content/shortcuts.ts';
import { FetcherController } from '../src/content/fetcher-menu.ts';
import { installChromeShim } from './helpers.ts';

describe('initializeShortcuts', () => {
  beforeEach(() => {
    installChromeShim();
    localStorage.clear();
    document.body.innerHTML = '';
  });

  function setup() {
    const ctrl = new FetcherController();
    const container = document.createElement('div');
    ctrl.createFetcherMenuElements(container);
    document.body.appendChild(container);
    initializeShortcuts(ctrl);
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

  test('Esc does nothing when not processing or textarea not focused', () => {
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
});
