# StatDev (WordStat Utils)

Расширение для Chrome (MV3) и Firefox, собирающее частотности из Яндекс WordStat:
**W**, **«W»**, **[W]** и **«[!W]»** — прямо на странице результатов и в batch-режиме.

## Возможности

- Сбор 4 типов частотностей со страниц `wordstat.yandex.ru` / `wordstat.yandex.com`
- Batch-фетчер с очередью и rate-limiter'ом
- Кэширование запросов (`storage`)
- Табличное представление результатов
- Экспорт собранных данных
- Горячие клавиши
- Фоновый service worker (`alarms`)

## Требования

- Node.js 18+ (для сборки и тестов)

## Установка и сборка

```bash
npm install
npm run build   # собирает dist/ (esbuild)
```

Готовое расширение — в папке `dist/` (загружается как распакованное в
`chrome://extensions` или `about:debugging` в Firefox).

## Тесты и проверка

```bash
npm run typecheck   # tsc --noEmit
npm test            # jest
npm run verify      # typecheck + test + build
```

## Структура

```
src/            исходники на TypeScript
  background.ts service worker
  content/      content script: fetcher, queue, rate-limiter, cache, таблицы, UI
  lib/          общие типы
tests/          jest-тесты
scripts/        build.mjs (esbuild)
styles/         CSS
images/         иконки
```

## Лицензия

Не указана.
