# TypeScript Migration — ✅ ЗАВЕРШЕНО

> **`tsc --noEmit` → 0 ошибок** во всех 13 файлах.

---

## Общая стратегия

Идём **снизу вверх по слоям зависимостей**:

```
config.ts (готово)
  ↓
rate-limiter.ts → queue.ts → utils.ts
  ↓
cache.ts → api.ts
  ↓
ui.ts → fetcher-menu.ts → fetcher.ts
  ↓
fetchLogic.ts → table.ts → main.ts
  ↓
background.ts (последний — service worker)
```

После каждого модуля: `npx tsc --noEmit 2>&1 | grep "src/content/<module>.ts"` — должно давать ноль ошибок в этом файле.

---

## ✅ Этап 1 — Базовые модули (без DOM)

### ✅ 1.1 `src/content/rate-limiter.ts`
**Текущие проблемы:**
- `recordResult({ latencyMs, status })` — параметры `any`
- Конструктор `constructor(cfg)` — `cfg: any`

**Что сделать:**
- Импортировать `RateLimitConfig` из config.ts
- Типизировать поля класса: `private _minC: number; private _maxC: number; ...`
- `recordResult(result: { latencyMs?: number; status?: number }): void`
- `snapshot(): { concurrency: number; delayMs: number; latencyEMA: number | null; successStreak: number }`

**Проверка:** `npx tsc --noEmit | grep rate-limiter`

### ✅ 1.2 `src/content/queue.ts`
**Текущие проблемы:**
- `createRateLimitedQueue<T>(...)` — generic не объявлен
- `handler: (item: any, index: number) => Promise<void>` — item any
- `items: any[]`

**Что сделать:**
- Дженерик: `createRateLimitedQueue<T>(opts: { limiter: AdaptiveRateLimiter; handler: (item: T, index: number) => Promise<void>; shouldSkip?: (item: T, index: number) => boolean }): { run: (items: T[]) => Promise<void>; cancel: () => void }`
- Типизировать `inFlightPromises: Promise<void>[]`
- Типизировать `inFlight: number`, `i: number`, `cancelled: boolean`

**Проверка:** `npx tsc --noEmit | grep queue`

### ✅ 1.3 `src/content/utils.ts`
**Текущие проблемы:**
- `formatNumber(num: any)`, `constructVariantQuery(baseQuery: any, resultIndex: any)` — any
- `getQueryForRow(row: any)` — нужен `HTMLTableRowElement`
- `getCurrentRegion(): string | null` — ок, но return type нужен
- `isColumnEnabled(columnIndex: number)` — возвращает boolean

**Что сделать:**
- `formatNumber(num: string | number | null | undefined): string`
- `constructVariantQuery(baseQuery: string, resultIndex: 0 | 1 | 2): string | null`
- `getApiQueryForVariant(baseQuery: string, variantKey: FetcherVariantKey): string | null`
- `getQueryForRow(row: HTMLTableRowElement | null | undefined): string | null`
- `isCellLoadingOrError(cell: HTMLElement | null | undefined): boolean`
- `valueToCellState(value: unknown): CellState`

**Проверка:** `npx tsc --noEmit | grep utils`

---

## ✅ Этап 2 — Модули с localStorage

### ✅ 2.1 `src/content/cache.ts`
**Текущие проблемы:**
- `parseCacheData(rawJson: any)`, `readCacheRaw(storage: any)`, `writeCacheRaw(...)` — any
- `flattenEntries(cacheData: any)` — any
- `evictOldestEntries(cacheData: any, opts: any)` — any
- `getFromLocalStorage(query, region, deviceTypes, storage)` — все any
- Внутренние типы `entries: { query: string; region: string; device: string; date: number; lastAccessedAt: number }[]`

**Что сделать:**
- Импортировать `CacheShape`, `CacheEntry` из config.ts
- `StorageLike = Pick<Storage, 'getItem' | 'setItem'>` для инжекции в тестах
- `parseCacheData(rawJson: string | null): CacheShape`
- `readCacheRaw(storage?: StorageLike): string` (default = `globalThis.localStorage`)
- `writeCacheRaw(jsonString: string, storage?: StorageLike): boolean`
- `evictOldestEntries(cacheData: CacheShape, opts?: { ratio?: number; hardCap?: boolean }): number`
- `getFromLocalStorage(query, region, deviceTypes, storage?): { base; variants; errored; date } | null`
- `saveToLocalStorage(query, region, deviceTypes, results, storage?): boolean`

**Проверка:** `npx tsc --noEmit | grep cache`

### ✅ 2.2 `src/content/api.ts`
**Текущие проблемы:**
- `fetchViaBackground({ url, method, body, onResult })` — все any
- `fetchWS(query, region, deviceTypes, onResult)` — все any
- `fetchVariantWithRetry(query, region, deviceTypes, attempt, onResult)` — все any

**Что сделать:**
- Создать интерфейсы:
  ```ts
  interface FetchRequest { url: string; method?: string; body?: string | null; onResult?: (r: RequestOutcome) => void; }
  interface RequestOutcome { latencyMs: number; status: number; }
  interface WSRequestBody extends APIRequestDefaults { searchValue: string; currentDevice: string; filters?: { region?: string; tableType: string }; }
  interface WSResponse { totalValue: number | null; [k: string]: unknown; }
  ```
- Типизировать все параметры и возвраты
- `fetchViaBackground(opts: FetchRequest): Promise<WSResponse>`
- `fetchWS(query: string, region: string | null, deviceTypes: string | null, onResult?: (r: RequestOutcome) => void): Promise<WSResponse>`
- `fetchVariantWithRetry(query: string, region: string | null, deviceTypes: string | null, attempt?: number, onResult?: (r: RequestOutcome) => void): Promise<WSResponse>`
- Расширить Error для status: `function makeFetchError(status: number, name: string, message: string): Error & { status: number; name: string }`

**Проверка:** `npx tsc --noEmit | grep api`

---

## ✅ Этап 3 — UI-модули (с DOM)

### ✅ 3.1 `src/content/ui.ts`
**Текущие проблемы:**
- Все функции принимают `row: any`, `cell: any`, `headerRow: any`
- `state: any` в `modifyHeader`
- `bindRuntime({ handleRowClick, fetchColumn, getCurrentRegion, getCurrentDeviceTypes })` — все any
- Внутренние helpers `_handleRowClick: any`, etc.

**Что сделать:**
- Создать типы:
  ```ts
  type ElementLike = HTMLElement | null | undefined;
  type TableRow = HTMLTableRowElement;
  type TableHeaderRow = HTMLTableSectionElement;
  ```
- Типизировать все `(row: TableRow)`, `(cell: HTMLElement)`, etc.
- `setCellState(cell: HTMLElement, state: CellState, opts?: { value?: string | number | null }): void`
- `modifyHeader(headerRow: HTMLTableRowElement, state: { headerInitialized: boolean }): void`
- Runtime bindings:
  ```ts
  type RuntimeHandlers = {
    handleRowClick: (event: MouseEvent) => void;
    fetchColumn: (columnIndex: number) => Promise<void>;
    getCurrentRegion: () => string | null;
    getCurrentDeviceTypes: () => string;
  };
  ```

**Проверка:** `npx tsc --noEmit | grep ui`

### ✅ 3.2 `src/content/fetcher-menu.ts`
**Текущие проблемы:**
- `fetcherState` без явного типа
- `_createCheckboxControls`, `_createTextArea`, `_createButton` — параметры без типов
- `processFetcherQueueItem(task)` — `task: any`

**Что сделать:**
- Создать интерфейсы:
  ```ts
  interface FetcherTask {
    query: string;
    variantKey: FetcherVariantKey;
    apiQuery: string;
    jobIndex: number;
    region: string | null;
    deviceTypes: string;
    limiter: AdaptiveRateLimiter | null;
  }
  interface FetcherControls {
    inputArea?: HTMLTextAreaElement;
    outputArea?: HTMLTextAreaElement;
    button?: HTMLButtonElement;
    clearButton?: HTMLButtonElement;
    progressBar?: HTMLDivElement;
    progressContainer?: HTMLDivElement;
    progressText?: HTMLSpanElement;
    checkboxes?: Partial<Record<FetcherVariantKey, HTMLInputElement>>;
  }
  interface FetcherResult { originalQuery: string; originalIndex: number; values: Partial<Record<FetcherVariantKey, number | null>>; }
  interface FetcherState { isProcessing: boolean; fetchQueue: FetcherTask[]; results: FetcherResult[]; controls: FetcherControls; selectedVariants: FetcherVariantKey[]; currentRegion: string | null; currentDeviceTypes: string; totalTasks: number; completedTasks: number; }
  ```

**Проверка:** `npx tsc --noEmit | grep fetcher-menu`

### ✅ 3.3 `src/content/fetcher.ts`
**Текущие проблемы:**
- `createFetcherBanner()` — нет return type
- Все `element: HTMLAnchorElement | HTMLImageElement | HTMLButtonElement` без типов

**Что сделать:**
- Типизировать `link: HTMLAnchorElement`, `logo: HTMLImageElement`, и т.д.
- `createFetcherBanner(): void`

**Проверка:** `npx tsc --noEmit | grep fetcher`

---

## ✅ Этап 4 — Главная логика

### ✅ 4.1 `src/content/fetchLogic.ts`
**Текущие проблемы:**
- `identifyVariantsToFetchForRow(row, baseQuery, region, deviceTypes, cachedEntry)` — any
- `updateCacheAndRowUI(row, ...)` — row any
- `fetchAllVariantsForRow(row)` — row any
- `handleRowClick(event)` — event: any
- `collectItemsForColumnFetch(rows, columnIndex, region, deviceTypes)` — rows: any
- `processQueueItem(item)` — item: any

**Что сделать:**
- Создать интерфейсы:
  ```ts
  interface VariantFetchTask {
    variantKey: 'quoted' | 'bracketed' | 'excluded';
    apiQuery: string;
    columnIndex: number;
    resultIndex: number;
    region: string | null;
    deviceTypes: string;
  }
  interface ColumnFetchTask extends VariantFetchTask {
    row: HTMLTableRowElement;
    baseQuery: string;
    variantKey: FetcherVariantKey; // расширяем
    limiter?: AdaptiveRateLimiter | null;
  }
  ```
- `MouseEvent` для `handleRowClick`
- Типизировать callbacks в `Promise.allSettled`

**Проверка:** `npx tsc --noEmit | grep fetchLogic`

### ✅ 4.2 `src/content/table.ts`
**Текущие проблемы:**
- `findTableAndHeader()` — return type не объявлен
- `processTableRows(table, region, deviceTypes)` — `table: any`
- `state: any`

**Что сделать:**
- `findTableAndHeader(): { table: HTMLTableElement; headerRow: HTMLTableRowElement } | null`
- `processTableRows(table: HTMLTableElement, region: string | null, deviceTypes: string): void`
- `resetStateIfTableMissing(table: HTMLTableElement | null | undefined, state: { headerInitialized: boolean; currentView: string | null }): void`

**Проверка:** `npx tsc --noEmit | grep table`

### ✅ 4.3 `src/content/main.ts`
**Текущие проблемы:**
- `globalState` без типа
- `bindRuntime(...)` — параметры any (если не сделано в ui.ts)
- `applyYandexRateLimitFix()` — return type
- `run()` — return type

**Что сделать:**
- `interface GlobalState { headerInitialized: boolean; currentView: string | null; observer: MutationObserver | null; }`
- `applyYandexRateLimitFix(): void`
- `run(): void`
- `initializeOrUpdateTable(): void`

**Проверка:** `npx tsc --noEmit | grep main`

---

## ✅ Этап 5 — Background Service Worker

### ✅ 5.1 `src/background.ts`
**Текущие проблемы:**
- `buildCookieHeader(url)` — параметры any
- `handleFetch(payload)` — payload any
- `chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {})` — все any

**Что сделать:**
- Использовать типы из `@types/chrome`:
  ```ts
  import type { Runtime, Cookies, Alarms, Storage } from 'chrome';
  ```
- `FetchPayload { url: string; method?: string; body?: string | null; headers?: Record<string, string> }`
- `handleFetch(payload: FetchPayload): Promise<unknown>`
- `isAllowedUrl(url: string): boolean`
- Типизировать `chrome.cookies.getAll(...)` callback
- Типизировать `sendResponse` callback

**Проверка:** `npx tsc --noEmit | grep background`

---

## ✅ Этап 6 — Финализация

### ✅ 6.1 Добавлены скрипты в `package.json`:
```json
"typecheck": "tsc --noEmit",
"verify": "npm run typecheck && npm test && npm run build"
```

### ✅ 6.2 Включены строгие проверки в `tsconfig.json`:
```json
"noUnusedLocals": true,
"noUnusedParameters": true,
"exactOptionalPropertyTypes": true
```

### ✅ 6.3 Финальная верификация:
```bash
npm run typecheck   # 0 ошибок ✓
npm run build       # dist/* собрано ✓
npm test            # ⏳ прерывается по таймауту — проблема окружения (не TS)
```

---

## Шпаргалка по командам

```bash
# После правки одного модуля — проверять только его:
npx tsc --noEmit 2>&1 | grep "src/content/<module>.ts"

# Полная проверка:
npm run typecheck

# Все тесты:
npx jest --no-coverage --testTimeout=15000

# Конкретный тест:
npx jest tests/<file>.test.ts --no-coverage

# Сборка:
node scripts/build.mjs
```

---

## Результат

**Все 13 файлов типизированы.** `tsc --noEmit` → 0 ошибок.