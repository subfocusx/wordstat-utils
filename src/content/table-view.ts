import {
  DOM_SELECTORS,
  VIEW_CLASSES,
  URL_PARAMS
} from '../config.ts';
import {
  getCurrentDeviceTypes,
  getCurrentRegion
} from './utils.ts';
import {
  findTableAndHeader,
  resetStateIfTableMissing,
  ensureHeaderInitialized,
  processTableRows
} from './table.ts';

interface TableViewState {
  headerInitialized: boolean;
  currentView: string | null;
  /** setInterval handle for the 1 Hz polling loop (mirrors original v1.3.2.2). */
  pollIntervalId: ReturnType<typeof setInterval> | null;
}

export class TableViewManager {
  private state: TableViewState = {
    headerInitialized: false,
    currentView: null,
    pollIntervalId: null
  };

  private getCurrentView(): string | null {
    const wrapper = document.querySelector(DOM_SELECTORS.SETTINGS_WRAPPER);
    if (wrapper) {
      if (wrapper.classList.contains(VIEW_CLASSES.TABLE)) return 'table';
      if (wrapper.classList.contains(VIEW_CLASSES.GRAPH)) return 'graph';
      if (wrapper.classList.contains(VIEW_CLASSES.MAP)) return 'map';
    }
    const viewParam = new URLSearchParams(window.location.search).get(URL_PARAMS.VIEW);
    if (viewParam === 'table' || viewParam === 'graph' || viewParam === 'map') return viewParam;
    return null;
  }

  initializeTable(): void {
    const newView = this.getCurrentView();
    // NOTE: we deliberately do NOT stopPolling() here. The original v1.3.2.2
    // kept `setInterval(initializeOrUpdateTable, 1000)` running forever; if we
    // stop the poll when leaving table view, nothing ever restarts it (startPolling
    // is only called once from main.ts) and returning to the table view silently
    // breaks the extension until a full page reload.
    this.state.currentView = newView;
    if (this.state.currentView !== 'table') return;

    const region = getCurrentRegion();
    const deviceTypes = getCurrentDeviceTypes();
    const elements = findTableAndHeader();
    const table = elements?.table as HTMLTableElement | undefined;
    const headerRow = elements?.headerRow as HTMLTableRowElement | undefined;
    resetStateIfTableMissing(table, this.state);
    if (!table || !headerRow) return;
    ensureHeaderInitialized(table, headerRow, this.state);
    processTableRows(table, region, deviceTypes);
  }

  /**
   * Start the 1 Hz polling loop that re-checks the table view and re-renders
   * rows. Mirrors the original v1.3.2.2 `setInterval(initializeOrUpdateTable, 1000)`.
   * MutationObserver on document.body was tried in v1.4.0.0 but fired too often
   * on Yandex's own streaming updates and saturated the main thread, causing
   * the page to feel hung.
   */
  startPolling(): void {
    if (this.state.pollIntervalId !== null) return;
    this.state.pollIntervalId = setInterval(() => this.initializeTable(), 1000);
  }

  stopPolling(): void {
    if (this.state.pollIntervalId !== null) {
      clearInterval(this.state.pollIntervalId);
      this.state.pollIntervalId = null;
    }
  }

  get headerInitialized(): boolean {
    return this.state.headerInitialized;
  }
}
