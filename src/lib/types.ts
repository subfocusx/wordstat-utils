// src/lib/types.ts
// Типизированные интерфейсы, экспортированные из src/config.ts
// NOTE: `export { type X } from '...'` does NOT introduce a local binding,
// so types used inside this file (e.g. APIRequestDefaults in WSRequestBody)
// need a separate `import type` as well.
import { type APIRequestDefaults } from '../config.ts';

export { type CacheShape, type CacheEntry } from '../config.ts';
export { type APIRequestDefaults } from '../config.ts';
export { type RateLimitConfig } from '../config.ts';
export { type ColumnConfig } from '../config.ts';
export { type CellState } from '../config.ts';
export { type FetcherVariantKey } from '../config.ts';
export { type FetcherVariantInfo } from '../config.ts';

// Background types
export interface FetchPayload {
  url?: string;
  method?: string;
  body?: string | null;
  cookies?: string;
}
export interface RequestOutcome {
  latencyMs: number;
  status: number;
}
export interface WSRequestBody extends APIRequestDefaults {
  searchValue: string;
  currentDevice: string;
  filters?: { region?: string; tableType: string };
}
export interface WSResponse {
  totalValue: number | null;
  [k: string]: unknown;
}

// UI types
export type ElementLike = HTMLElement | null | undefined;
export type TableRow = HTMLTableRowElement;
export type TableHeaderRow = HTMLTableSectionElement;
export type TableCell = HTMLElement;
export type DOMEvent<T extends keyof HTMLElementEventMap> = HTMLElementEventMap[T];
export type AnyEvent = Event;
