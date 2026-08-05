# WordStat Utils v2 — анализ расширения

> ⚠️ **УСТАРЕЛО.** Этот файл описывает состояние проекта ДО миграции на TypeScript.
> Сейчас все 14 исходных файлов переведены в `.ts`, добавлен `tsconfig.json`, сборка через esbuild.
> См. `TYPESCRIPT_TODO.md` и `package.json` для актуальной информации.

> Версия в manifest: **1.3.2.2**, `manifest_version: 3` (MV3).
> Назначение: автоматический сбор 4 типов частот из Яндекс WordStat — `W`, `«W»`, `[W]`, `«[!W]»` — прямо на странице результатов и в отдельном batch-фетчере.

## Краткая характеристика

| Метрика | Значение |
|---|---|
| Файлов JS | 11 (без `node_modules`, бандлеров нет) |
| Строк кода | ~2 338 JS + 340 CSS = **2 678 LOC** |
| Сборщик / TS | **Нет**. Папка называется `TypeScript`, но файлы `.js` и в `manifest.json` указаны как `.js`. Это обманчивое имя. |
| Фреймворки | Нет. Vanilla JS на content-script + service-worker. |
| Хранилище | `chrome.storage` объявлен в `permissions`, но фактически используется только `localStorage` страницы wordstat.yandex.ru. |
| Сторонние библиотеки | Нет. Никаких `npm` зависимостей. |
| Cookies / auth | Расширение читает 16 cookie с `wordstat.yandex.ru` и прокидывает их в background fetch к API. |

### Архитектура (одной картинкой)

```
┌─────────────────────────────────────────────────────────────┐
│ manifest.json (MV3)                                         │
│   ├─ service_worker: background.js                         │
│   │     └─ proxy fetch → wordstat.yandex.ru/wordstat/api…   │
│   └─ content_scripts (run_at: document_idle)                │
│        config.js → utils.js → cache.js → api.js → ui.js     │
│        → fetchLogic.js → fetcher-menu.js → fetcher.js       │
│        → shortcuts.js → content_script.js                   │
└─────────────────────────────────────────────────────────────┘
```

Поток данных: клик по строке/кнопке → `fetchLogic.js` собирает задачи → `api.fetchVariantWithRetry` шлёт сообщение в background → background делает `fetch` с cookies → результат идёт в кэш `cache.js` (`localStorage`) и обновляет DOM.

`fetcher-menu.js` — это второй параллельный движок: ввод списка ключей → пакетный fetch (15 конкуррентных, 750 ms задержка между стартами) → вывод в textarea → копирование.

---

## Сильные стороны

1. **Чистая модульность** для content-script. Каждый модуль — одна ответственность (config, utils, cache, api, ui, fetchLogic, fetcher). Хорошо читается, легко править по месту.
2. **Грамотная защита от гонок в `fetchLogic.js`** — `checkIfFetchIsStale` проверяет, что row живой, контекст (region/device) не сменился, колонка не дизейблена, запрос в строке тот же, никто не «перехватил» фетч. После устаревания задача аккуратно откатывается через `cleanupStaleFetch`. Это сильно выделяет проект на фоне типичных «расширений на коленке».
3. **Двухуровневая конкуррентность с rate-limit.** В `fetchLogic.processFetchQueue` и `runFetcherQueue` одинаково: `BATCH_FETCH_CONCURRENCY=15` + `BATCH_FETCH_DELAY_MS=750`. Это эмпирически подобрано под лимиты Яндекса, чтобы не получить 429/капчу.
4. **Реальный retry с backoff** в `api.fetchVariantWithRetry` (до 3 попыток, экспоненциально), с **пропуском 4xx-ошибок** (чтобы не долбить авторизационные ошибки бесконечно).
5. **Контекстный кэш** — `cache.js` хранит `query → region → device → { date, base, variants[] }`. Учитывается 24-часовая «свежесть» (`CACHE_DURATION_MS`) и автоочистка `LS` при `QuotaExceededError` (10% самых старых).
6. **Хорошее UX-кэширование в фетчере**: при повторном запуске списка ключей уже собранные частоты подтягиваются из кэша без обращения к API (`processFetcherQueueItem` → `getVariantFromCache`).
7. **Persist UI-состояния**: чекбоксы колонок, чекбоксы фетчера, состояние баннера (свернут/развернут) — всё переживает перезагрузку.

---

## 🔴 Critical — нужно чинить

### C1. Каталог называется `TypeScript`, но это plain JS
- **Где:** корень проекта, `manifest.json` → `content_scripts.js`.
- **Проблема:** разработчик/команда может решить, что тут настроен TS, и начать писать типы, которых нет в сборке. Никакого `tsconfig.json`, бандлера и `import`-ов нет. Это банально JS-файлы, загружаемые в порядке `manifest.json`. Имя папки вводит в заблуждение.
- **Фикс:** либо переименовать папку в `WordStat Utils v2 JS`, либо действительно ввести TS (см. C2).

### C2. Глобальный namespace и хрупкий порядок загрузки
- **Где:** все модули используют глобальные `const`/`function` в IIFE-стиле, объявленные на верхнем уровне content-script.
- **Проблема:** `config.js` обязан грузиться первым (определяет `PREFIX`, `DOM_SELECTORS`, `COLUMN_INDEX`…). `cache.js` ждёт `LS_CACHE_KEY` из `config`. Любая попытка отрефакторить порядок в `manifest.json` ломает расширение молча. Background (`background.js`) дублирует константу `BG_PREFIX = 'gfd_'` хардкодом с комментарием «build step is common». То есть связка с content-script — на честном слове.
- **Фикс:** внедрить любой бандлер (esbuild / rollup) + TS или хотя бы ESM с `<script type="module">`. Это лечит и C1, и весь класс проблем с порядком.

### C3. Background-fetch не изолирован от CORS/CSRF политики и легко ломается при смене API
- **Где:** `background.js:24-40`.
- **Проблема:** `host_permissions: ["*://*.yandex.ru/*"]` уже даёт доступ к fetch с cookies, **но** в запросе хардкодом выставлен `Content-Type: application/json` и cookies собираются руками из `document.cookie` в `api.getCookies()`. Если Яндекс сменит:
  - формат payload (например, добавит CSRF-токен, `x-csrf-token`, fingerprint),
  - или `SameSite=Strict`/`HttpOnly` cookie (тогда `document.cookie` его не отдаст),
  
  расширение молча перестанет работать. Никаких алертов, никакой диагностики — пользователь увидит только `❗️` в ячейках.
- **Фикс:**
  1. Прокидывать cookies **через** `chrome.cookies.getAll({ domain: 'wordstat.yandex.ru' })` в background, а не через `document.cookie` — это обходит `HttpOnly`.
  2. Перед каждым запросом делать cheap-проверку доступности API: `GET https://wordstat.yandex.ru/wordstat/api/search?...` и парсить структуру ответа. На любой «нежданный» JSON-ответ — включать «degraded mode» + показать баннер «расширение требует обновления» (см. G1).
  3. Логировать версию API-формата в LS и поднимать её в баннер при изменении.

### C4. `shortcuts.js` фактически мёртвый код
- **Где:** `shortcuts.js` целиком.
- **Проблема:** функция подключается в `content_script.js:122` (`initializeShortcuts()`), но **все 4 ветки `switch` закомментированы**. То есть пользователь думает, что у него есть хоткеи, а их нет. Либо ввести в UI, что есть Ctrl+↑/↓/←/→, либо удалить файл, обработчик и упоминание в `manifest.json`.
- **Фикс:** удалить и сократить `content_script.js` на ~10 строк, либо реализовать: сейчас это явный техдолг.

### C5. `LS_CHECKBOX_KEY` объявлен без `const/let`
- **Где:** `config.js:40` — `LS_CHECKBOX_KEY = \`${PREFIX}Checkbox_State\`;`
- **Проблема:** в strict-режиме (а content-script в MV3 фактически работает в module-режиме для ESM, либо в strict для скриптов 2+) эта строка бросит `ReferenceError: LS_CHECKBOX_KEY is not defined` при первом обращении. Сейчас она «спасается» тем, что не подключена через `<script type="module">`. **Любой** переход на модули/бандлер уронит расширение целиком.
- **Фикс:** `const LS_CHECKBOX_KEY = …;`

### C6. `content_script.js:144` пишет в чужой `localStorage` без проверки домена
- **Где:** `content_script.js` — `localStorage.setItem('_ym92461528:0_reqNum', '1');`
- **Проблема:** это «фикс» для отключения внутренней Яндекс-метрики/лимитера, но выполняется на каждой загрузке страницы. Это:
  - модифицирует данные чужого сайта (этически сомнительно, хоть и технически разрешено для content-script),
  - может быть перехвачено антивирусом/антиботом как suspicious,
  - поломается, если Яндекс переименует ключ (а это уже было не раз).
- **Фикс:** обернуть в try/catch и feature-detect (проверить, что ключ вообще существует и формат совпадает), плюс вынести в отдельный хелпер с явным комментарием «workaround for Yandex rate-limiter».

---

## 🟡 Medium — техдолг и code smell

### M1. `setInterval` с `UPDATE_INTERVAL_MS = 1000` — пустая трата ресурсов
- **Где:** `content_script.js:118`.
- **Проблема:** раз в секунду скрипт перечитывает DOM, проверяет view, проходит по всем строкам. На странице с 100+ строками это сотни `querySelector` в секунду. Современный WordStat часто динамически догружает строки — можно реагировать на `MutationObserver` на `tbody`.
- **Фикс:** заменить polling на `MutationObserver` (childList + subtree на `tbody`) и триггерить `processTableRows` только при появлении новых `<tr>`. Мгновенная отзывчивость + снижение CPU.

### M2. Дублирование логики `getApiQueryForVariant`
- **Где:** `utils.constructVariantQuery` + `fetchLogic.getApiQueryForVariant` + `fetcher-menu.getApiQueryForVariant` — **три** почти одинаковые реализации.
- **Проблема:** правишь в одной — забываешь в двух других. Классический баг при изменениях формата `«[!W]»`.
- **Фикс:** оставить одну реализацию в `utils.js`, остальные удалить.

### M3. Кэш и `localStorage` как single source of truth
- **Где:** `cache.js`.
- **Проблема:** LS WordStat ограничен ~5 MB. `CACHE_QUOTA_CLEANUP_RATIO = 0.1` снимает только 10% при переполнении, что вызовет повторное переполнение через несколько запросов. Нет LRU по факту использования (только по дате создания). Счётчик «попаданий» бы помог.
- **Фикс:**
  1. Хранить `lastAccessedAt` помимо `date`, использовать его для LRU-вытеснения.
  2. Мигрировать на `chrome.storage.local` (для расширения доступно ~10 MB на домен) или IndexedDB — но это требует переноса логики из content-script в background, что уже за рамками быстрой правки.

### M4. `_ym92461528:0_reqNum` хардкод без TTL
- **Где:** `content_script.js:144`.
- **Проблема:** даже если ключ не существует, `setItem` создаст его навсегда. Это дополнительная нагрузка на LS Яндекса.
- **Фикс:** перед записью проверить `localStorage.getItem('_ym92461528:0_reqNum') !== '1'`, иначе не трогать.

### M5. `processFetchQueue` и `runFetcherQueue` — почти копипаста
- **Где:** `fetchLogic.js:399-435` и `fetcher-menu.js:189-231`.
- **Проблема:** две одинаковые по сути реализации concurrency-лимитера с rate-limit. Любой багфикс нужно делать в двух местах.
- **Фикс:** вынести `createRateLimitedQueue({ concurrency, delayMs, onItem })` в отдельный модуль.

### M6. `formatNumber` ломается на отрицательных/NaN
- **Где:** `utils.js:5-10`.
- **Проблема:** `Number(num)` → `isNaN` — но если API вернёт строку `"1234"` это ок, а если `"1 234"` (с пробелом) — упадёт в `DISABLED`. Это не критично, но спорно: данные приходят с пробелами именно в таком виде.
- **Фикс:** сначала `String(num).replace(/\s/g, '')`, потом `Number(...)`.

### M7. Тяжёлый `cell.textContent` round-trip для определения состояния
- **Где:** `isCellLoadingOrError` + `toggleCellDisabledState` + `updateRowDisplayFromCache` — несколько раз читают `cell.textContent`.
- **Проблема:** при 100+ строках × 5 ячеек × 1 Hz polling = десятки тысяч сравнений строк в секунду.
- **Фикс:** ввести `cell.dataset.state` (`pending|fetching|error|disabled|value`) и проверять `dataset.state`, а не `textContent`.

### M8. `background.js` не валидирует входные данные
- **Где:** `background.js:19-58`.
- **Проблема:** `payload.url`, `method`, `body` приходят прямо из content-script без какой-либо валидации. URL может быть подменён (если в content-script попадёт инъекция через XSS на wordstat.yandex.ru) и уйти в background `fetch`. Это потенциальный SSRF-like вектор в контексте расширения.
- **Фикс:** whitelist allowed URL = `API_URL` из общего конфига.

### M9. `toggleColumnState` итерирует все строки при каждом клике чекбокса
- **Где:** `ui.js:225-286`.
- **Проблема:** клик по одному чекбоксу → `forEach` по всем `tbody > tr` → пересчёт cache lookup → перерисовка текста. На таблице в 200 строк это ~200 `getFromLocalStorage` подряд, при том что `parseCacheData()` читает и парсит весь LS-объект на каждом вызове (см. C× в `cache.js`).
- **Фикс:** кэшировать распарсенный `allData` в module-scope (Map) и обновлять только при `saveToLocalStorage`.

### M10. `processFetcherQueueItem` пишет в LS при каждом cache hit
- **Где:** `fetcher-menu.js:160-169`.
- **Проблема:** при cache HIT сохранения нет, это плюс. Но при cache MISS `fetchResult?.totalValue` **всегда** пишется в LS, даже если значение `null` (например, API вернул `totalValue: null`). После ошибки это `null` тоже сохраняется → следующие 24 часа мы будем показывать «❗» вместо попытки рефетча.
- **Фикс:** различать «нет данных» (null) и «ошибка сети». Сохранять в LS только успешные ответы или явный «нет данных». Ошибки держать только в `fetcherState.results` до конца сессии.

---

## 🟢 Low — полировка

| # | Что | Где |
|---|---|---|
| L1 | Хардкод `'_ym92461528:0_reqNum'` — вынести в `config.js` под именем `YANDEX_RATE_LIMIT_KEY` | `config.js` |
| L2 | `console.debug` спамит — добавить `DEBUG`-флаг в конфиг | глобально |
| L3 | Нет версионирования API-формата — добавить `API_FORMAT_VERSION` в payload и в LS, чтобы при изменениях Яндекса быстро диагностировать | `api.js`, `cache.js` |
| L4 | Баннер DigitalStrategy — ссылка нерелевантна расширению, можно вынести в `chrome.runtime.getURL('pages/donate.html')` или убрать совсем | `fetcher.js:14-26` |
| L5 | CSS `.gfd_fetcher-progress-text` объявляет `color: #333`, потом переопределяет на `#fff` — конфликт | `styles/fetcher.css:163-167` |
| L6 | Нет обработки случая, когда пользователь **не залогинен** в WordStat — расширение молча вернёт 401 | `api.js` |
| L7 | `SCRIPT_LOADED_FLAG` не учитывает перезагрузку content-script при SPA-навигации | `content_script.js:128` |
| L8 | `disabled` атрибут на `<textarea>` не блокирует `copyOutputToClipboard` (хотя в коде проверка `isProcessing` есть, но без `disabled` UX путает) | `fetcher-menu.js:311` |
| L9 | Нет i18n — все строки в `UI_TEXT` русские, нет переключения | `config.js:126-160` |
| L10 | `manifest.key` опубликован в публичном репо — если кто-то скопирует, у двух расширений будет один `key` и Chrome начнёт ругаться. **Удалить до публикации** | `manifest.json:21` |
| L11 | Нет CSP-метатега в `web_accessible_resources` — если будут грузиться inline-скрипты, MV3 зарубит | `manifest.json` |
| L12 | В `_metadata/` лежат `computed_hashes.json` и `verified_contents.json` — это артефакты сборки CRX, в публичном исходнике они не нужны | `_metadata/` |

---

## 🚀 Точки роста (приоритизированные)

### Tier 1 — даст быстрый эффект (1-3 дня)

1. **Сборка через esbuild + TypeScript.** Это лечит сразу C1, C2, C5, M2, M5. Получаем tree-shaking, минификацию, тайп-чек, нормальный импорт. Bundle ≈ 20-30 KB.
2. **MutationObserver вместо `setInterval(1s)`** (M1) — отзывчивость ×10, CPU на длинных таблицах −70%.
3. **Whitelist URL в background** (M8) — закрывает SSRF-вектор.
4. **Удалить `manifest.key`** (L10) до публикации.
5. **Привести `LS_CHECKBOX_KEY` к `const`** (C5) — однострочник, убирает мину замедленного действия.

### Tier 2 — стабильность (1 неделя)

6. **Health-check API + баннер «нужно обновление»** (C3) — пользователь сразу видит, что сломалось, а не гадает.
7. **Разделение cache-hit vs cache-error** в `processFetcherQueueItem` (M10) — фетчер перестанет «кэшировать» ошибки.
8. **`cell.dataset.state`** (M7) — уход от строковых сравнений, заметный прирост на больших таблицах.
9. **LRU с `lastAccessedAt`** (M3) — реальное вытеснение вместо FIFO по дате создания.

### Tier 3 — UX/маркетинг (2 недели)

10. **Удалить/реализовать `shortcuts.js`** (C4) — закрывает техдолг.
11. **Прокидывать cookies через `chrome.cookies` API** (C3, fix #1) — обход `HttpOnly`.
12. **i18n** (L9) — добавить `chrome.i18n` + `_locales/{ru,en}/messages.json`. Сразу +20% потенциальной аудитории.
13. **Убрать рекламный баннер или сделать его опциональным** (L4) — текущий digitalstrategy выглядит чужеродно.
14. **IndexedDB через background** (M3, fix #2) — лимит 5–10 MB → 50+ MB, можно кэшировать месяцы данных.
15. **Web-accessible страница настроек** (`chrome.runtime.getURL('options.html')`) с управлением лимитами, регионами, темами.

### Tier 4 — большие фичи (1 месяц+)

16. **Альтернативные источники данных.** Яндекс однажды снова ужесточит лимиты (это уже случалось — вспомним историю с KeyCollector). Подложить провайдера данных: собственный backend-прокси (с пользовательским токеном), или парсер google suggest / trends. Расширение превращается из «ещё одного wordstat-парсера» в «агрегатор».
17. **Экспорт в CSV/XLSX** (сейчас только буфер обмена). Можно через `SheetJS` или `exceljs` в background.
18. **Профили/шаблоны запросов.** Сохранять наборы «регион + устройство + набор колонок» как пресеты.
19. **Автообновление через GitHub Releases** — текущий `update_url` указывает на стандартный `clients2.google.com/service/update2/crx`, можно оставить для Chrome Web Store или убрать, если планируется self-hosted.

---

## Что нужно для реальной пересборки

Если дойдёт до Tier 1.1 (esbuild + TS), минимальный план:

```bash
npm init -y
npm i -D typescript esbuild @types/chrome
# tsconfig.json — target ES2020, module ESNext, lib ["ES2020","DOM"]
# build.mjs — esbuild.build({
#   entryPoints: { background: 'src/background.ts',
#                  content: 'src/content/index.ts' },
#   bundle: true, format: 'iife', target: 'chrome100',
#   outdir: 'dist'
# })
```

И заменить `manifest.json`:

```jsonc
"background": { "service_worker": "dist/background.js" },
"content_scripts": [{
  "js": ["dist/content.js"],   // один файл вместо 10
  "css": ["styles/table.css", "styles/fetcher.css"],
  "matches": ["*://wordstat.yandex.ru/*", "*://wordstat.yandex.com/*"],
  "run_at": "document_idle"
}]
```

Это **сразу** убирает весь класс C1/C2/M2/M5 проблем.

---

## Итог в одной фразе

Расширение делает свою работу и сделано с заметной инженерной культурой (stale-check, retry, контекстный кэш), но упёрлось в три вещи: **хрупкий «glue» без бандлера, дрейф формата API Яндекса и мёртвый/полу-мёртвый код** (shortcuts, `_ym` хардкод, рекламный баннер). Первые 5 Tier-1 правок дадут 80% устойчивости за пару дней работы.