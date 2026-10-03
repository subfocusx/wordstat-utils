// src/content/fetcher-menu.ts
// Batch UI: input list, run button, output textarea, progress bar.
// [M5] uses createRateLimitedQueue.
// [M10] only caches successful fetches; errors stay in controller.results.
// [Adaptive] creates an AdaptiveRateLimiter per run for self-tuning speed.

import {
  CELL_STATE,
  CELL_STATE_GLYPH,
  CSS_CLASSES,
  DATASET_KEYS,
  FETCHER_VARIANTS,
  FETCHER_VARIANT_ORDER,
  LS_FETCHER_CHECKBOX_KEY,
  RATE_LIMIT,
  UI_TEXT,
  type FetcherVariantKey
} from '../config.ts';
import { logger } from './logger.ts';
import { fetchVariantWithRetry } from './api.ts';
import { FetcherError } from './cache.ts';
import {
  createButton,
  getApiQueryForVariant,
  getCurrentDeviceTypes,
  getCurrentRegion
} from './utils.ts';
import { getVariantFromCache, saveVariantToCache } from './cache.ts';
import { createRateLimitedQueue } from './queue.ts';
import { AdaptiveRateLimiter } from './rate-limiter.ts';
import {
  downloadExport,
  filenameFor,
  toCSV,
  toTSV,
  toXLS,
  type ExportFormat,
  type ExportRow
} from './export.ts';

interface FetcherControls {
  checkboxes?: Record<string, HTMLInputElement>;
  button?: HTMLButtonElement;
  clearButton?: HTMLButtonElement;
  cancelButton?: HTMLButtonElement;
  retryButton?: HTMLButtonElement;
  exportButtons?: Partial<Record<ExportFormat, HTMLButtonElement>>;
  inputArea?: HTMLTextAreaElement;
  outputArea?: HTMLTextAreaElement;
  progressContainer?: HTMLElement;
  progressBar?: HTMLElement;
  progressText?: HTMLElement;
  progressErrors?: HTMLElement;
}

interface FetcherTask {
  query: string;
  variantKey: FetcherVariantKey;
  apiQuery: string;
  jobIndex: number;
  region: string | null;
  deviceTypes: string | null;
  limiter: AdaptiveRateLimiter | null;
}

interface FetcherResultJob {
  originalQuery: string;
  originalIndex: number;
  values: Record<string, string | number | null>;
}

export class FetcherController {
  isProcessing = false;
  fetchQueue: FetcherTask[] = [];
  results: FetcherResultJob[] = [];
  failedTasks: FetcherError[] = [];
  controls: FetcherControls = {};
  selectedVariants: FetcherVariantKey[] = [];
  currentRegion: string | null = null;
  currentDeviceTypes: string | null = null;
  totalTasks = 0;
  completedTasks = 0;
  private _outputRenderPending = false;
  private _queueHandle: { cancel: () => void } | null = null;
  private _cancelRequested = false;
  /**
   * Monotonic run id. Cancelling the queue stops *scheduling*, but requests
   * already in flight still resolve; every result carries the generation it
   * was started in and is dropped when it no longer matches, so a late reply
   * cannot repopulate a cancelled or already-cleared batch.
   */
  private _generation = 0;

  saveFetcherCheckboxStates() {
    const states: Record<string, boolean> = {};
    const cbs = this.controls?.checkboxes;
    if (!cbs) return;
    Object.values(cbs).forEach((cb: HTMLInputElement) => {
      const variant = cb.dataset[DATASET_KEYS.FETCHER_VARIANT];
      if (variant) states[variant] = cb.checked;
    });
    try {
      localStorage.setItem(LS_FETCHER_CHECKBOX_KEY, JSON.stringify(states));
    } catch (e) {
      logger.error('Error saving fetcher checkbox states:', e);
    }
  }

  loadFetcherCheckboxStates() {
    const cbs = this.controls?.checkboxes;
    if (!cbs) return;
    const stored = localStorage.getItem(LS_FETCHER_CHECKBOX_KEY);
    let states: Record<string, boolean> = {};
    if (stored) {
      try {
        states = JSON.parse(stored);
      } catch {
        states = {};
      }
    }
    const hasStored = Object.keys(states).length > 0;
    Object.entries(cbs).forEach(([variant, cb]: [string, HTMLInputElement]) => {
      cb.checked = hasStored ? !!states[variant] : true;
    });
    if (!hasStored) this.saveFetcherCheckboxStates();
  }

  updateProgressBarDisplay() {
    const c = this.controls;
    if (!c.progressContainer) return;
    if (this.totalTasks <= 0) {
      c.progressContainer.style.display = 'none';
      return;
    }
    const pct = Math.min(100, (this.completedTasks / this.totalTasks) * 100);
    if (c.progressBar) c.progressBar.style.width = pct + '%';
    if (c.progressText) {
      c.progressText.textContent = `${this.completedTasks}/${this.totalTasks} · ${pct.toFixed(0)}%`;
    }
    if (c.progressErrors) {
      if (this.failedTasks.length > 0) {
        c.progressErrors.style.display = 'inline';
        c.progressErrors.textContent = `❌${this.failedTasks.length}`;
      } else {
        c.progressErrors.style.display = 'none';
      }
    }
    c.progressContainer.classList.toggle(CSS_CLASSES.PROGRESS_HAS_ERRORS, this.failedTasks.length > 0);
    c.progressContainer.style.display = 'flex';
  }

  private _updateRetryButton() {
    if (!this.controls.retryButton) return;
    this.controls.retryButton.style.display =
      !this.isProcessing && this.failedTasks.length > 0 ? '' : 'none';
  }

  disableFetcherUI() {
    this.isProcessing = true;
    const c = this.controls;
    setElementDisabled(c.button, true);
    setElementDisabled(c.clearButton, true);
    setElementDisabled(c.inputArea, true);
    if (c.outputArea) {
      setElementDisabled(c.outputArea, true);
      c.outputArea.classList.add(CSS_CLASSES.FETCHER_PROCESSING);
      c.outputArea.placeholder = UI_TEXT.FETCHING_TITLE;
    }
    if (c.checkboxes) Object.values(c.checkboxes).forEach((cb) => setElementDisabled(cb, true));
    if (c.cancelButton) c.cancelButton.style.display = '';
    if (c.retryButton) c.retryButton.style.display = 'none';
    this.completedTasks = 0;
    this.updateProgressBarDisplay();
  }

  enableFetcherUI() {
    this.isProcessing = false;
    const c = this.controls;
    // Flush any debounced output render so the textarea is final the moment
    // processing ends (a queued rAF would only re-render the same content).
    this._renderFetcherOutput();
    setElementDisabled(c.button, false);
    setElementDisabled(c.clearButton, false);
    setElementDisabled(c.inputArea, false);
    if (c.outputArea) {
      setElementDisabled(c.outputArea, false);
      c.outputArea.classList.remove(CSS_CLASSES.FETCHER_PROCESSING);
      c.outputArea.placeholder = UI_TEXT.FETCHER_OUTPUT_PLACEHOLDER;
    }
    if (c.checkboxes) Object.values(c.checkboxes).forEach((cb) => setElementDisabled(cb, false));
    if (c.cancelButton) c.cancelButton.style.display = 'none';
    this._updateRetryButton();
    setTimeout(() => {
      if (c.progressContainer && !this.isProcessing) {
        c.progressContainer.style.display = 'none';
      }
    }, 500);
  }

    updateFetcherOutputDisplay() {
    if (this._outputRenderPending) return;
    this._outputRenderPending = true;
    const schedule = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (fn: () => void) => { fn(); return 0; };
    schedule(() => {
      this._outputRenderPending = false;
      this._renderFetcherOutput();
    });
  }

  private _renderFetcherOutput() {
    const out = this.controls.outputArea;
    if (!out) return;
    const lines = this.results
      .map((job) => {
        const row = [job.originalQuery];
        this.selectedVariants.forEach((variantKey) => {
          const v = job.values[variantKey];
          row.push(typeof v === 'number' && !Number.isNaN(v) ? String(v) : CELL_STATE_GLYPH[CELL_STATE.DISABLED]);
        });
        return row.join('\t');
      });
    
    // Also show failed tasks with error information in the output for visibility
    const failedLines = this.failedTasks
      .map((failed) => {
        const row = [`[${failed.apiQuery}] ${failed.query}`];
        this.selectedVariants.forEach((variantKey) => {
          if (variantKey === failed.variantKey) {
            row.push(`ERROR: ${failed.message}`);
          } else {
            row.push('');
          }
        });
        return row.join('\t');
      });
    
    out.value = [...lines, ...failedLines].join('\n');
  }
  /** Key identifying "this query, this variant" for failure dedup. */
  private _failedKey(err: FetcherError): string {
    return `${err.jobIndex} ${err.variantKey}`;
  }

  /**
   * Record a failure, replacing any earlier failure for the same query/variant.
   * The previous 5-second window let a slow batch record the same error many
   * times over; identity is stable for the whole run, so keying on it dedupes
   * correctly no matter when the retries land.
   */
  private addFailedTask(newError: FetcherError): boolean {
    const key = this._failedKey(newError);
    const existingIndex = this.failedTasks.findIndex((e) => this._failedKey(e) === key);
    if (existingIndex !== -1) {
      this.failedTasks[existingIndex] = newError;
      return false;
    }
    this.failedTasks.push(newError);
    this.updateFetcherOutputDisplay();
    return true;
  }

  private async processFetcherQueueItem(task: FetcherTask, generation = this._generation) {
    const { query, variantKey, apiQuery, jobIndex, region, deviceTypes, limiter } = task;
    let resultValue: string | number | null = null;
    // A newer run (or a cancel/clear) started while this request was in flight:
    // drop the answer instead of writing it into someone else's results.
    if (generation !== this._generation) return;
    try {
      const cached = getVariantFromCache(query, region, deviceTypes, variantKey);
      if (cached !== null) {
        resultValue = cached;
      } else {
        const fetchResult = await fetchVariantWithRetry(apiQuery, region, deviceTypes, 0, (r) =>
          limiter?.recordResult(r)
        );
        resultValue = fetchResult?.totalValue ?? null;
        if (resultValue !== null) {
          saveVariantToCache(query, region, deviceTypes, variantKey, resultValue);
        }
      }
      const job = this.results.find((j) => j.originalIndex === jobIndex);
      if (job) job.values[variantKey] = resultValue;
    } catch (error) {
      logger.error(`Fetcher item error for "${apiQuery}":`, error);
      const job = this.results.find((j) => j.originalIndex === jobIndex);
      if (job) job.values[variantKey] = null;
      
      // Store complete error information for debugging/monitoring.
      // addFailedTask dedupes repeated failures within a short window.
      this.addFailedTask(new FetcherError(
        error instanceof Error ? error.message : String(error),
        query,
        variantKey,
        apiQuery,
        jobIndex,
        region,
        deviceTypes
      ));
    } finally {
      this.completedTasks++;
      this.updateProgressBarDisplay();
      this.updateFetcherOutputDisplay();
    }
  }

  private async runFetcherQueue() {
    const generation = ++this._generation;
    const total = this.fetchQueue.length;
    this.totalTasks = total;
    this.completedTasks = 0;
    if (total === 0) {
      this.enableFetcherUI();
      return;
    }
    const limiter = new AdaptiveRateLimiter(RATE_LIMIT);
    this.fetchQueue.forEach((t) => {
      t.limiter = limiter;
    });
    const runner = createRateLimitedQueue({
      limiter,
      handler: (task: FetcherTask) => this.processFetcherQueueItem(task, generation)
    });
    this._queueHandle = runner;
    this._cancelRequested = false;
    const runStart = Date.now();
    await runner.run(this.fetchQueue);
    this._queueHandle = null;
    // A cancel/clear or a newer run took over the UI while we were awaiting.
    if (generation !== this._generation) return;
    if (this._cancelRequested) {
      this._cancelRequested = false;
      this.enableFetcherUI();
      return;
    }
    const secs = Math.max(1, Math.round((Date.now() - runStart) / 1000));
    const okQueries = this.results.filter((j) =>
      this.selectedVariants.every((v) => j.values[v] != null)
    ).length;
    const failCount = this.failedTasks.length;
    const kind: 'success' | 'warn' | 'error' =
      failCount === 0 ? 'success' : okQueries === 0 ? 'error' : 'warn';
    showToast(
      UI_TEXT.FETCHER_COMPLETED_TEMPLATE
        .replace('{OK}', String(okQueries))
        .replace('{TOTAL}', String(this.results.length))
        .replace('{FAIL}', String(failCount))
        .replace('{SECS}', String(secs)),
      kind
    );
    this.enableFetcherUI();
  }

  cancelRunningBatch() {
    if (!this.isProcessing || !this._queueHandle) return;
    this._cancelRequested = true;
    // Invalidate in-flight results: the queue stops scheduling, but requests
    // already sent still resolve and must not land in the visible results.
    this._generation++;
    this._queueHandle.cancel();
    this._queueHandle = null;
    this.enableFetcherUI();
    showToast(UI_TEXT.FETCHER_CANCEL_TOAST, 'warn');
  }

  private handleRetryClick() {
    if (this.isProcessing) return;
    if (this.failedTasks.length === 0) {
      showToast(UI_TEXT.FETCHER_RETRY_NO_ERRORS, 'info');
      return;
    }
    this.fetchQueue = [];
    this.failedTasks.forEach((err) => {
      const job = this.results.find((j) => j.originalIndex === err.jobIndex);
      if (job) job.values[err.variantKey] = null;
      this.fetchQueue.push({
        query: err.query,
        variantKey: err.variantKey,
        apiQuery: err.apiQuery,
        jobIndex: err.jobIndex,
        region: err.region,
        deviceTypes: err.deviceTypes,
        limiter: null
      });
    });
    this.failedTasks = [];
    this.disableFetcherUI();
    this.runFetcherQueue();
  }

  private handleClearClick() {
    const c = this.controls;
    if (c.inputArea) c.inputArea.value = '';
    if (c.outputArea) {
      c.outputArea.value = '';
      c.outputArea.placeholder = UI_TEXT.FETCHER_OUTPUT_PLACEHOLDER;
      c.outputArea.classList.remove(
        CSS_CLASSES.FETCHER_OUTPUT_STATE_SUCCESS,
        CSS_CLASSES.FETCHER_OUTPUT_STATE_ERROR,
        CSS_CLASSES.FETCHER_PROCESSING
      );
    }
    // Clearing the visible output must also drop the state behind it, otherwise
    // the next render (or an export) resurrects the previous batch.
    this._generation++;
    this.fetchQueue = [];
    this.results = [];
    this.failedTasks = [];
    this.totalTasks = 0;
    this.completedTasks = 0;
    this.updateProgressBarDisplay();
  }

  handleFetcherStartClick() {
    if (this.isProcessing) return;
    const c = this.controls;
    this.selectedVariants = FETCHER_VARIANT_ORDER.filter(
      (k) => c.checkboxes?.[k]?.checked
    );
    if (this.selectedVariants.length === 0) {
      showToast(UI_TEXT.FETCHER_NO_SELECTION, 'warn');
      return;
    }
    const raw = c.inputArea?.value.trim() ?? '';
    if (!raw) {
      showToast(UI_TEXT.FETCHER_NO_INPUT, 'warn');
      return;
    }
    const queries = raw.split('\n').map((q: string) => q.trim()).filter(Boolean);
    if (queries.length === 0) {
      showToast(UI_TEXT.FETCHER_NO_INPUT, 'warn');
      return;
    }
    this.disableFetcherUI();
    this.fetchQueue = [];
    this.failedTasks = [];
    this.results = queries.map((query: string, index: number) => ({
      originalQuery: query,
      originalIndex: index,
      values: {}
    }));
    this.currentRegion = getCurrentRegion();
    this.currentDeviceTypes = getCurrentDeviceTypes();
    this.results.forEach((job) => {
      this.selectedVariants.forEach((variantKey) => {
        const apiQuery = getApiQueryForVariant(job.originalQuery, variantKey);
        if (apiQuery !== null) {
          this.fetchQueue.push({
            query: job.originalQuery,
            variantKey,
            apiQuery,
            jobIndex: job.originalIndex,
            region: this.currentRegion,
            deviceTypes: this.currentDeviceTypes,
            limiter: null
          });
        } else {
          job.values[variantKey] = null;
        }
      });
    });
    this.updateFetcherOutputDisplay();
    this.runFetcherQueue();
  }

  private copyOutputToClipboard() {
    const out = this.controls.outputArea;
    if (this.isProcessing || !out?.value) return;
    navigator.clipboard.writeText(out.value).then(
      () => {
        const orig = out.placeholder;
        out.placeholder = UI_TEXT.FETCHER_COPY_SUCCESS;
        out.classList.add(CSS_CLASSES.FETCHER_OUTPUT_STATE_SUCCESS);
        out.classList.remove(CSS_CLASSES.FETCHER_OUTPUT_STATE_ERROR);
        setTimeout(() => {
          if (out.placeholder === UI_TEXT.FETCHER_COPY_SUCCESS) out.placeholder = orig;
          out.classList.remove(CSS_CLASSES.FETCHER_OUTPUT_STATE_SUCCESS);
        }, 1500);
      },
      () => {
        const orig = out.placeholder;
        out.placeholder = UI_TEXT.FETCHER_COPY_FAIL;
        out.classList.add(CSS_CLASSES.FETCHER_OUTPUT_STATE_ERROR);
        out.classList.remove(CSS_CLASSES.FETCHER_OUTPUT_STATE_SUCCESS);
        setTimeout(() => {
          if (out.placeholder === UI_TEXT.FETCHER_COPY_FAIL) out.placeholder = orig;
          out.classList.remove(CSS_CLASSES.FETCHER_OUTPUT_STATE_ERROR);
        }, 2000);
      }
    );
  }

  private _createCheckboxControls() {
    const controlsDiv = document.createElement('div');
    controlsDiv.className = CSS_CLASSES.FETCHER_CONTROLS;
    this.controls.checkboxes = {};
    FETCHER_VARIANT_ORDER.forEach((key) => {
      const info = FETCHER_VARIANTS[key];
      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = CSS_CLASSES.FETCHER_CHECKBOX;
      cb.dataset[DATASET_KEYS.FETCHER_VARIANT] = key;
      cb.addEventListener('change', () => this.saveFetcherCheckboxStates());
      label.appendChild(cb);
      label.appendChild(document.createTextNode(` ${info.label}`));
      controlsDiv.appendChild(label);
      this.controls.checkboxes![key] = cb;
    });
    return controlsDiv;
  }

  private _createActionButtons() {
    const row = document.createElement('div');
    row.className = CSS_CLASSES.FETCHER_BUTTON_ROW;
    this.controls.button = createButton(
      UI_TEXT.FETCHER_BUTTON_TEXT,
      () => this.handleFetcherStartClick(),
      '',
      '',
      false
    );
    this.controls.button.classList.add(CSS_CLASSES.FETCHER_BUTTON, CSS_CLASSES.FETCHER_FETCH_BUTTON);
    row.appendChild(this.controls.button);
    this.controls.clearButton = createButton(
      '❌',
      () => this.handleClearClick(),
      '',
      'Очистить поля ввода и вывода',
      false
    );
    this.controls.clearButton.classList.add(CSS_CLASSES.FETCHER_BUTTON, CSS_CLASSES.FETCHER_CLEAR_BUTTON);
    row.appendChild(this.controls.clearButton);
    this.controls.cancelButton = createButton(
      UI_TEXT.FETCHER_CANCEL_BTN,
      () => this.cancelRunningBatch(),
      '',
      'Остановить текущий пакет',
      false
    );
    this.controls.cancelButton.classList.add(CSS_CLASSES.FETCHER_BUTTON, CSS_CLASSES.FETCHER_CANCEL_BUTTON);
    this.controls.cancelButton.style.display = 'none';
    row.appendChild(this.controls.cancelButton);
    this.controls.retryButton = createButton(
      UI_TEXT.FETCHER_RETRY_BTN,
      () => this.handleRetryClick(),
      '',
      'Повторить только неудачные запросы',
      false
    );
    this.controls.retryButton.classList.add(CSS_CLASSES.FETCHER_BUTTON, CSS_CLASSES.FETCHER_RETRY_BUTTON);
    this.controls.retryButton.style.display = 'none';
    row.appendChild(this.controls.retryButton);
    return row;
  }

  private _createExportButtons(): HTMLElement {
    const row = document.createElement('div');
    row.className = CSS_CLASSES.FETCHER_EXPORT_ROW;
    this.controls.exportButtons = {};

    const buttons: Array<{ fmt: ExportFormat; label: string; title: string }> = [
      { fmt: 'csv', label: 'CSV', title: 'Скачать результаты как CSV (Excel-compatible UTF-8)' },
      { fmt: 'tsv', label: 'TSV', title: 'Скачать результаты как TSV (вставляется в Excel/Google Sheets без разделителей)' },
      { fmt: 'xls', label: 'XLS', title: 'Скачать результаты как Excel (.xls)' }
    ];

    for (const { fmt, label, title } of buttons) {
      const btn = createButton(label, () => this.handleExport(fmt), '', title, false);
      btn.classList.add(CSS_CLASSES.FETCHER_BUTTON, CSS_CLASSES.FETCHER_EXPORT_BUTTON, `gfd_fetcher-export-${fmt}`);
      row.appendChild(btn);
      this.controls.exportButtons![fmt] = btn;
    }
    return row;
  }

  private handleExport(format: ExportFormat): void {
    if (this.results.length === 0) {
      showToast('Нет результатов для экспорта', 'error');
      return;
    }
    if (this.isProcessing) {
      showToast('Дождитесь окончания текущего пакета', 'warn');
      return;
    }
    const rows: ExportRow[] = this.results.map((job) => ({
      originalQuery: job.originalQuery,
      values: { ...job.values }
    }));
    // Read the columns as they are at export time: the user may have toggled
    // checkboxes after the batch finished, and the file must match the UI.
    const selectedVariants = FETCHER_VARIANT_ORDER.filter(
      (k) => this.controls.checkboxes?.[k]?.checked
    );
    const opts = { selectedVariants, bom: format === 'csv' };
    let content: string;
    let mime: string;
    switch (format) {
      case 'csv': content = toCSV(rows, opts); mime = 'text/csv'; break;
      case 'tsv': content = toTSV(rows, opts); mime = 'text/tab-separated-values'; break;
      case 'xls': content = toXLS(rows, opts); mime = 'application/vnd.ms-excel'; break;
    }
    try {
      downloadExport(filenameFor(format, rows), mime, content);
      showToast(`Экспортировано: ${rows.length} запросов в ${format.toUpperCase()}`, 'success');
    } catch (err) {
      showToast(`Ошибка экспорта: ${(err as Error).message}`, 'error');
    }
  }

  private _createProgressBar() {
    this.controls.progressContainer = document.createElement('div');
    this.controls.progressContainer.className = CSS_CLASSES.PROGRESS_CONTAINER;
    this.controls.progressContainer.style.display = 'none';
    this.controls.progressBar = document.createElement('div');
    this.controls.progressBar.className = CSS_CLASSES.PROGRESS_BAR;
    this.controls.progressText = document.createElement('span');
    this.controls.progressText.className = CSS_CLASSES.PROGRESS_TEXT;
    this.controls.progressText.textContent = '0/0 · 0%';
    this.controls.progressErrors = document.createElement('span');
    this.controls.progressErrors.className = CSS_CLASSES.PROGRESS_ERRORS;
    this.controls.progressErrors.style.display = 'none';
    this.controls.progressContainer.appendChild(this.controls.progressBar);
    this.controls.progressContainer.appendChild(this.controls.progressText);
    this.controls.progressContainer.appendChild(this.controls.progressErrors);
    return this.controls.progressContainer;
  }

  createFetcherMenuElements(container: HTMLElement) {
    const menuDiv = document.createElement('div');
    menuDiv.className = CSS_CLASSES.FETCHER_MENU;
    menuDiv.appendChild(this._createCheckboxControls());
    this.controls.inputArea = _createTextArea(CSS_CLASSES.FETCHER_INPUT, UI_TEXT.FETCHER_INPUT_PLACEHOLDER);
    menuDiv.appendChild(this.controls.inputArea);
    menuDiv.appendChild(this._createActionButtons());
    menuDiv.appendChild(this._createExportButtons());
    this.controls.outputArea = _createTextArea(
      CSS_CLASSES.FETCHER_OUTPUT,
      UI_TEXT.FETCHER_OUTPUT_PLACEHOLDER,
      true,
      () => this.copyOutputToClipboard(),
      UI_TEXT.FETCHER_COPY_TOOLTIP
    );
    menuDiv.appendChild(this.controls.outputArea);
    container.appendChild(menuDiv);
    container.appendChild(this._createProgressBar());
    this.loadFetcherCheckboxStates();
  }
}

const TOAST_KIND_CLASSES = {
  success: CSS_CLASSES.TOAST_SUCCESS,
  error: CSS_CLASSES.TOAST_ERROR,
  warn: CSS_CLASSES.TOAST_WARN,
  info: CSS_CLASSES.TOAST_INFO
} as const;

const TOAST_STACK_ID = `${CSS_CLASSES.TOAST}_stack`;

/**
 * Lightweight toast notification. Replaces native alert() so the main thread
 * stays responsive while the user is mid-batch. Multiple toasts stack vertically.
 */
export function showToast(message: string, kind: 'success' | 'error' | 'warn' | 'info' = 'info', durationMs = 3500): void {
  const stack = _ensureToastStack();
  const toast = document.createElement('div');
  toast.className = `${CSS_CLASSES.TOAST} ${TOAST_KIND_CLASSES[kind]}`;
  toast.textContent = message;
  stack.appendChild(toast);
  // Trigger CSS transition by adding the visible class on next frame.
  requestAnimationFrame(() => toast.classList.add(CSS_CLASSES.TOAST_VISIBLE));
  setTimeout(() => {
    toast.classList.remove(CSS_CLASSES.TOAST_VISIBLE);
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
    // Failsafe in case transitionend doesn't fire (browser tab in background).
    setTimeout(() => toast.remove(), 600);
  }, durationMs);
}

function _ensureToastStack(): HTMLElement {
  let stack = document.getElementById(TOAST_STACK_ID);
  if (stack) return stack as HTMLElement;
  stack = document.createElement('div');
  stack.id = TOAST_STACK_ID;
  document.body.appendChild(stack);
  return stack;
}

function setElementDisabled(el: { disabled?: boolean } | null | undefined, isDisabled: boolean) {
  if (el) el.disabled = isDisabled;
}

function _createTextArea(className: string, placeholder: string, readOnly = false, clickHandler: (() => void) | null = null, title = '') {
  const ta = document.createElement('textarea');
  ta.className = className;
  ta.placeholder = placeholder;
  ta.readOnly = readOnly;
  if (title) ta.title = title;
  if (clickHandler) ta.addEventListener('click', clickHandler);
  return ta;
}
