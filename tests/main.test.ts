// tests/main.test.js
import { viewManager } from '../src/content/main.ts';

describe('polling loop (M1 mirror)', () => {
  beforeEach(() => {
    jest.resetModules();
    localStorage.clear();
    document.body.innerHTML = '';
  });

  test('main module exports viewManager', () => {
    expect(viewManager).toBeDefined();
    expect(typeof viewManager.startPolling).toBe('function');
    expect(typeof viewManager.stopPolling).toBe('function');
  });
});

describe('Yandex rate-limit key on page load', () => {
  beforeEach(() => {
    jest.resetModules();
    localStorage.clear();
  });

  test('writes _ym92461528:0_reqNum=1 (mirrors original v1.3.2.2 line 144)', async () => {
    await import('../src/content/main.ts');
    expect(localStorage.getItem('_ym92461528:0_reqNum')).toBe('1');
  });
});
