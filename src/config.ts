// src/config.ts
// Single source of truth for all constants.
// Bundled into both background.js and content.js by esbuild.

export const PREFIX = 'gfd_';

// --- API Configuration (shared between background + content) ---
export const API_URL = 'https://wordstat.yandex.ru/wordstat/api/search';

export const REQUIRED_COOKIES: readonly string[] = [
  'is_gdpr', 'is_gdpr_b', '_yasc', 'i', 'yandexuid', 'yashr',
  'receive-cookie-deprecation', 'bh', 'L', 'yandex_login', 'spravka',
  'sessionid2', 'yuidss', 'ya-wordstat-tour',
  'ya-wordstat-webmaster-banner-viewed', 'ys'
] as const;

export interface APIRequestDefaults {
  currentDevice: string;
  startDate: string;
  endDate: string;
}

// Local calendar dates, no toISOString(): Yandex expects the user's local
// day, and toISOString() rolls the date back in UTC+ zones.
export function getAPIRequestDefaults(): APIRequestDefaults {
  const now = new Date();
  const start = new Date(now.getFullYear() - 2, now.getMonth(), now.getDate());
  const ymd = (d: Date): string =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return {
    currentDevice: 'desktop,phone,tablet',
    startDate: ymd(start),
    endDate: ymd(now)
  };
}

export const HTTP_METHOD = { POST: 'POST' } as const;
export const CONTENT_TYPE = { JSON: 'application/json' } as const;

// --- Fetching Behavior ---
export const FETCH_MAX_RETRIES = 3;
export const FETCH_RETRY_DELAY_MS = 1000;
// Hard cap on the single-attempt backoff sleep. Defensive only: with
// FETCH_MAX_RETRIES=3 and FETCH_RETRY_DELAY_MS=1000 the largest computed
// backoff is 1000 * 2^2 = 4000 ms, so this cap never binds at current
// settings — it exists so raising the retry count cannot blow up a slot.
export const FETCH_MAX_RETRY_DELAY_MS = 5000;
// Abort a background fetch after this long. A request that Yandex throttles
// or drops silently otherwise occupies a concurrency slot indefinitely.
export const FETCH_TIMEOUT_MS = 30000;

// --- Logging ---
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
// Minimum level emitted to the console and recorded in the ring buffer.
export const LOG_LEVEL: LogLevel = 'info';
// Max entries kept in the in-memory ring buffer (and persisted on warn/error).
export const LOG_BUFFER_SIZE = 200;
export const LS_LOG_KEY = `${PREFIX}Logs`;

// --- Adaptive Rate Limiting (Tier-2) ---
// Soft corridor: 5..25 concurrent, 350..2000 ms between starts.
// Auto-adapts: speeds up on sustained successes with low latency,
// slows down hard on 429/5xx responses.
export interface RateLimitConfig {
  initialConcurrency: number;
  initialDelayMs: number;
  minConcurrency: number;
  maxConcurrency: number;
  minDelayMs: number;
  maxDelayMs: number;
  speedUpFactor: number;
  speedUpDelayFactor: number;
  slowDownFactor: number;
  slowDownDelayFactor: number;
  speedUpMinSuccesses: number;
  speedUpMaxLatencyMs: number;
  windowSize: number;
}

export const RATE_LIMIT: Readonly<RateLimitConfig> = Object.freeze({
  initialConcurrency: 18,
  initialDelayMs: 750,
  minConcurrency: 5,
  maxConcurrency: 25,
  minDelayMs: 350,
  maxDelayMs: 2000,
  speedUpFactor: 1.05,
  speedUpDelayFactor: 0.97,
  slowDownFactor: 0.7,
  slowDownDelayFactor: 1.6,
  speedUpMinSuccesses: 10,
  speedUpMaxLatencyMs: 800,
  windowSize: 20
});

// --- Caching ---
export const LS_CACHE_KEY = `${PREFIX}WS_Cache`;
export const CACHE_DURATION_MS = 24 * 60 * 60 * 1000;
export const CACHE_NULL_PLACEHOLDER = '-';
export const CACHE_QUOTA_CLEANUP_RATIO = 0.1;
export const CACHE_MAX_ENTRIES = 5000;

// --- Settings Storage ---
export const LS_FETCHER_BANNER_STATE = `${PREFIX}FetcherBannerState`;
export const LS_FETCHER_POS_KEY = `${PREFIX}FetcherPos`;
export const LS_FETCHER_SIZE_KEY = `${PREFIX}FetcherSize`;

export const LS_CHECKBOX_KEY = `${PREFIX}Checkbox_State`;
export const LS_FETCHER_CHECKBOX_KEY = `${PREFIX}Fetcher_Checkbox_State`;

// --- Fetcher panel size ---
// Used by the JS resize handle for clamping; the values are mirrored in
// styles/fetcher.css (min/max on .fetcher-banner-container).
export const PANEL_MIN_WIDTH = 260;
export const PANEL_MAX_WIDTH = 560;
export const PANEL_MIN_HEIGHT = 220;
export const PANEL_MAX_HEIGHT = 640;
export const PANEL_DEFAULT_WIDTH = 300;

// --- DOM Selectors & Classes ---
export const DOM_SELECTORS = {
  TABLE: '.wordstat__search-result-content table',
  SETTINGS_WRAPPER: '.wordstat__settings-wrapper',
  HEADER_ROW: 'thead > tr',
  BODY_ROW: 'tbody > tr',
  KEYWORD_LINK: 'a',
  SHOW_MORE_BUTTON: '.wordstat__show-more-button',
  POPULAR_TAB: '#popular',
  ASSOCIATIONS_TAB: '#associations',
  DEVICE_CHECKBOXES: ".wordstat__device-types input[type='checkbox']"
} as const;

export const VIEW_CLASSES = {
  TABLE: 'wordstat__settings-wrapper_view_table',
  GRAPH: 'wordstat__settings-wrapper_view_graph',
  MAP: 'wordstat__settings-wrapper_view_map'
} as const;

export const CSS_CLASSES = {
  PENDING_ROW: `${PREFIX}pending-row`,
  HEADER_CHECKBOX: `${PREFIX}header-checkbox`,
  ACTION_BUTTON: `${PREFIX}action-button`,
  DISABLED: `${PREFIX}disabled`,
  KEYWORD_CELL: `${PREFIX}keyword-cell`,
  HEADER_CELL: `${PREFIX}header-cell`,
  HEADER_CELL_NO_SORT: `${PREFIX}header-cell-no-sort`,
  DATA_CELL: `${PREFIX}data-cell`,
  ACTIONS_CELL: `${PREFIX}actions-cell`,
  FETCHER_BANNER_CONTAINER: `${PREFIX}fetcher-banner-container`,
  FETCHER_BANNER_ICON: `${PREFIX}fetcher-banner-icon`,
  FETCHER_BANNER_IMAGE: `${PREFIX}fetcher-banner-image`,
  FETCHER_BANNER_BUTTON: `${PREFIX}fetcher-banner-button`,
  FETCHER_BANNER_HIDE_BTN: `${PREFIX}fetcher-banner-hide-button`,
  FETCHER_BANNER_SHOW_BTN: `${PREFIX}fetcher-banner-show-button`,
  FETCHER_BANNER_HIDDEN: `${PREFIX}fetcher-banner-hidden`,
  FETCHER_MENU: `${PREFIX}fetcher-menu`,
  FETCHER_CONTROLS: `${PREFIX}fetcher-controls`,
  FETCHER_CHECKBOX: `${PREFIX}fetcher-checkbox`,
  FETCHER_INPUT: `${PREFIX}fetcher-input`,
  FETCHER_OUTPUT: `${PREFIX}fetcher-output`,
  FETCHER_BUTTON: `${PREFIX}fetcher-button`,
  FETCHER_PROCESSING: `${PREFIX}fetcher-processing`,
  FETCHER_OUTPUT_SUCCESS: `${PREFIX}fetcher-output-success`,
  FETCHER_OUTPUT_ERROR: `${PREFIX}fetcher-output-error`,
  FETCHER_BUTTON_ROW: `${PREFIX}fetcher-button-row`,
  FETCHER_EXPORT_ROW: `${PREFIX}fetcher-export-row`,
  FETCHER_FETCH_BUTTON: `${PREFIX}fetcher-fetch-button`,
  FETCHER_CLEAR_BUTTON: `${PREFIX}fetcher-clear-button`,
  FETCHER_CANCEL_BUTTON: `${PREFIX}fetcher-cancel-button`,
  FETCHER_RETRY_BUTTON: `${PREFIX}fetcher-retry-button`,
  FETCHER_EXPORT_BUTTON: `${PREFIX}fetcher-export-button`,
  PROGRESS_CONTAINER: `${PREFIX}fetcher-progress-container`,
  PROGRESS_BAR: `${PREFIX}fetcher-progress-bar`,
  PROGRESS_TEXT: `${PREFIX}fetcher-progress-text`,
  PROGRESS_ERRORS: `${PREFIX}fetcher-progress-errors`,
  PROGRESS_HAS_ERRORS: 'has-errors',
  // State classes applied to the output textarea (styles/fetcher.css targets
  // `.gfd_fetcher-output.success` / `.error`, so these stay unprefixed).
  FETCHER_OUTPUT_STATE_SUCCESS: 'success',
  FETCHER_OUTPUT_STATE_ERROR: 'error',
  TOAST: `${PREFIX}toast`,
  TOAST_VISIBLE: `${PREFIX}toast_visible`,
  TOAST_SUCCESS: `${PREFIX}toast_success`,
  TOAST_ERROR: `${PREFIX}toast_error`,
  TOAST_WARN: `${PREFIX}toast_warn`,
  TOAST_INFO: `${PREFIX}toast_info`,
  FETCHER_BANNER_CONTAINER_ID: 'fetcher-banner-container',
  FETCHER_BANNER_HEADER: 'fetcher-banner-header',
  FETCHER_BANNER_TITLE: 'fetcher-banner-title',
  FETCHER_BANNER_DRAG: 'fetcher-banner-drag',
  FETCHER_BANNER_HIDE: 'fetcher-banner-hide-button',
  FETCHER_BANNER_SHOW: 'fetcher-banner-show-button',
  FETCHER_BANNER_RESIZE_HANDLE: 'fetcher-banner-resize-handle',
  SORTABLE_COLUMN: 'table__column_sortable',
  SORTED_COLUMN: 'table__column_sorted'
} as const;

export const DATASET_KEYS = {
  HEADER_MODIFIED: 'gfdHeaderModified',
  CHECKBOXES_LOADED: 'gfdCheckboxesLoaded',
  COL_FETCHING: 'gfdColFetching',
  QUERY_TO_FETCH: 'gfdQueryToFetch',
  CLICK_LISTENER: 'gfdClickListener',
  TABLE_CHECKBOX_INDEX: 'gfdTableIndex',
  FETCHER_VARIANT: 'gfdFetcherVariant',
  /** Original Yandex keyword-link href, kept so we never destroy navigation. */
  ORIGINAL_HREF: `${PREFIX}originalHref`,
  CELL_STATE: `${PREFIX}cellState`
} as const;

// --- Device types ---
// WordStat exposes desktop/phone/tablet checkboxes. Their DOM order is not
// guaranteed across Yandex redesigns, so we read the device from the
// checkbox's own attributes first and only fall back to positional order.
export const DEVICE_TYPE_ORDER = ['desktop', 'phone', 'tablet'] as const;
export type DeviceType = typeof DEVICE_TYPE_ORDER[number];


export interface ColumnConfig {
  text: string;
  index: number;
  resultIndex: number;
}

export const COLUMN_CONFIGS: ReadonlyArray<ColumnConfig> = [
  { text: '«W»', index: 2, resultIndex: 0 },
  { text: '[W]', index: 3, resultIndex: 1 },
  { text: '«[!W]»', index: 4, resultIndex: 2 }
] as const;

export const COLUMN_INDEX = {
  KEYWORD: 0,
  BASE_FREQUENCY: 1,
  QUOTED: 2,
  BRACKETED: 3,
  EXCLUDED: 4,
  ACTIONS: 5
} as const;

export const CELL_STATE = {
  PENDING_QUEUE: 'pending',
  FETCHING: 'fetching',
  ERROR: 'error',
  DISABLED: 'disabled',
  CANNOT_GENERATE: 'cannot-generate',
  VALUE: 'value'
} as const;
export type CellState = typeof CELL_STATE[keyof typeof CELL_STATE];

export const CELL_STATE_GLYPH: Readonly<Record<CellState, string>> = {
  [CELL_STATE.PENDING_QUEUE]: '⏳',
  [CELL_STATE.FETCHING]: '🔄',
  [CELL_STATE.ERROR]: '❗️',
  [CELL_STATE.DISABLED]: '-',
  [CELL_STATE.CANNOT_GENERATE]: '❌',
  [CELL_STATE.VALUE]: ''
};

export const UI_TEXT = {
  COPY_BTN: '📋',
  COPY_SUCCESS_BTN: '✅',
  FETCH_COLUMN_BTN: '🔥',
  ACTIONS_HEADER: 'Copy 📎',
  BASE_FREQ_HEADER: 'W',
  BASE_FREQ_TITLE: 'Не копировать базовую частоту W',
  FETCHABLE_TITLE_TEMPLATE: 'Не собирать и не копировать частоту {TEXT}',
  FETCH_MISSING_TITLE_TEMPLATE: 'Собрать отсуствующую частоту {TEXT}',
  COPY_ROW_TITLE: 'Копировать эту строку',
  KEYWORD_CELL_TITLE: 'Кликните, чтобы собрать частоты',
  ERROR_FETCH_FAILED: 'ERROR: Fetch failed',
  ERROR_CANNOT_GENERATE: 'ERROR: Cannot generate query variant',
  ERROR_BATCH_FETCH_TEMPLATE: 'ERROR: Batch fetch error: {ERROR}',
  FETCHING_TITLE: 'Собирается...',
  PENDING_TITLE: 'В очереди...',
  QUEUED_TITLE: 'В очереди...',
  DISABLED_TITLE: 'Столбец отключен',
  DISABLED_TITLE_NO_COPY: 'Столбец отключен. Не копируется.',
  FETCHER_BUTTON_TEXT: '🦊 Собрать частоты',
  FETCHER_INPUT_PLACEHOLDER: 'Вставьте ключевые слова, по одному на строку...',
  FETCHER_OUTPUT_PLACEHOLDER: 'Ключи с частотами появятся здесь...',
  FETCHER_COPY_SUCCESS: 'Скопировано в буфер обмена!',
  FETCHER_COPY_FAIL: 'Не удалось скопировать! 😥',
  FETCHER_COPY_TOOLTIP: 'Кликните, чтобы скопировать в буфер обмена 🗒️',
  FETCHER_NO_SELECTION: 'Пожалуйста, выберите хотя бы один чекбокс с частотой 🥺',
  FETCHER_NO_INPUT: 'Сначала введите ключевые слова, по одному на строку 🥺',
  FETCHER_LABEL_BASE: 'W',
  FETCHER_LABEL_QUOTED: '«W»',
  FETCHER_LABEL_BRACKETED: '[W]',
  FETCHER_LABEL_EXCLUDED: '«[!W]»',
  FETCHER_BANNER_HIDE_TEXT: 'Свернуть »',
  FETCHER_BANNER_SHOW_TEXT: '« Fetcher',
  FETCHER_TITLE: '🦊 WordStat Fetcher',
  FETCHER_DRAG_HINT: 'Перетащите, чтобы переместить. Двойной клик — сброс позиции.',
  FETCHER_CANCEL_BTN: '⏹ Отмена',
  FETCHER_RETRY_BTN: '🔁 Повторить ошибки',
  FETCHER_CANCEL_TOAST: 'Пакет остановлен',
  FETCHER_RETRY_NO_ERRORS: 'Нет ошибок для повтора',
  FETCHER_COMPLETED_TEMPLATE: 'Готово: {OK}/{TOTAL} запросов · ошибок {FAIL} · {SECS} сек',
  FETCHER_RESIZE_HINT: 'Тяните за угол, чтобы изменить размер. Двойной клик — сброс.'
} as const;

export type FetcherVariantKey = 'base' | 'quoted' | 'bracketed' | 'excluded';

export interface FetcherVariantInfo {
  label: string;
  resultIndex: number;
}

export const FETCHER_VARIANTS: Readonly<Record<FetcherVariantKey, FetcherVariantInfo>> = {
  base: { label: UI_TEXT.FETCHER_LABEL_BASE, resultIndex: -1 },
  quoted: { label: UI_TEXT.FETCHER_LABEL_QUOTED, resultIndex: 0 },
  bracketed: { label: UI_TEXT.FETCHER_LABEL_BRACKETED, resultIndex: 1 },
  excluded: { label: UI_TEXT.FETCHER_LABEL_EXCLUDED, resultIndex: 2 }
};

export const FETCHER_VARIANT_ORDER: ReadonlyArray<FetcherVariantKey> = ['base', 'quoted', 'bracketed', 'excluded'];

export const REGEX = {
  LEADING_PLUS_HYPHEN: /^[+‒-]/,
  INTERNAL_PLUS: /\+/g,
  NON_DIGIT_SPACE: /\s/g,
  THOUSANDS_SEP: /\B(?=(\d{3})+(?!\d))/g
} as const;

export const EVENTS = {
  CLICK: 'click',
  CHANGE: 'change',
  KEYDOWN: 'keydown',
  DOM_CONTENT_LOADED: 'DOMContentLoaded',
  READY_STATE_LOADING: 'loading'
} as const;

export const URL_PARAMS = { VIEW: 'view' } as const;

// [MIRRORS ORIGINAL v1.3.2.2 content_script.js:143-144] — on page load we
// reset Yandex's rate-limit counter to 1. The original extension does this
// unconditionally and it works fine (user-confirmed), so we mirror the same
// behavior. Without this key present at value '1', Yandex may interpret the
// first legitimate search as a count anomaly and stall the spinner.
export const YANDEX_RATE_LIMIT_KEY = '_ym92461528:0_reqNum';
export const YANDEX_RATE_LIMIT_VALUE = '1';

export const SCRIPT_LOADED_FLAG = `${PREFIX}ScriptLoaded`;

// --- Fetcher Banner State ---
// [M8] Whitelist of allowed fetch targets inside the background service worker.
// Exact origins only — no suffix matching, so a subdomain must be listed here.
export const BACKGROUND_ALLOWED_ORIGINS: Readonly<Record<string, true>> = {
  'https://wordstat.yandex.ru': true
};
export const BACKGROUND_ALLOWED_PATHS: Readonly<Record<string, true>> = {
  '/wordstat/api/search': true
};

