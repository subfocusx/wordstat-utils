// src/content/export.ts
// Pure functions for exporting fetcher results to CSV / TSV / XLS.
// No DOM dependencies beyond the download trigger — easy to unit test.
//
// Three honest formats:
//   * CSV — RFC 4180 with an optional UTF-8 BOM (Excel-friendly)
//   * TSV — tab-separated; quotes are data, never doubled (paste-into-Excel)
//   * XLS — Excel 2003 HTML workbook, served as application/vnd.ms-excel and
//     named `.xls`. Excel opens it natively; we no longer claim `.xlsx` for a
//     file that is not a zipped OOXML package.
//
// Rows = one per query; columns = original query + the selected variants.
// Empty / null values render as empty cells.

import { FETCHER_VARIANTS, type FetcherVariantKey } from '../config.ts';

export interface ExportRow {
  originalQuery: string;
  values: Partial<Record<FetcherVariantKey, string | number | null>>;
}

export type ExportFormat = 'csv' | 'tsv' | 'xls';

export interface ExportOptions {
  selectedVariants: FetcherVariantKey[];
  /** Prepend a UTF-8 BOM (CSV/TSV default true; XLS always gets one). */
  bom?: boolean;
}

const UTF8_BOM = '\uFEFF';

/**
 * Neutralize spreadsheet formula injection (CSV injection).
 *
 * A keyword like `=cmd|'/c calc'!A1` becomes a live formula when the file is
 * opened, and `+`/`-`/`@` are also interpreted by Excel and LibreOffice.
 * Prefixing with an apostrophe forces the cell to text.
 */
function guardFormulaInjection(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/**
 * Escape one CSV cell per RFC 4180: quote when it contains the delimiter, a
 * quote, a CR or an LF, and double internal quotes.
 */
function escapeCSV(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/**
 * Escape one TSV cell. TSV has no quoting convention worth relying on — Excel
 * treats a literal `"` as data, and doubling it corrupts the value. Embedded
 * tabs and newlines would split the row, so they collapse to a space instead.
 */
function escapeTSV(value: string): string {
  return value.replace(/[\t\r\n]+/g, ' ');
}

/**
 * Serialize rows + headers to CSV (comma) or TSV (tab).
 */
function serializeDelimited(rows: ExportRow[], opts: ExportOptions, delim: ',' | '\t'): string {
  const escape = delim === '\t' ? escapeTSV : escapeCSV;
  const headers = ['Query', ...opts.selectedVariants.map((v) => variantLabel(v))];
  const lines: string[] = [headers.map((h) => escape(guardFormulaInjection(h))).join(delim)];
  for (const row of rows) {
    const cells: string[] = [escape(guardFormulaInjection(row.originalQuery))];
    for (const v of opts.selectedVariants) {
      const val = row.values[v];
      const cell = val == null ? '' : guardFormulaInjection(String(val));
      cells.push(escape(cell));
    }
    lines.push(cells.join(delim));
  }
  const body = lines.join('\r\n');
  return (opts.bom ? UTF8_BOM : '') + body;
}

export function toCSV(rows: ExportRow[], opts: ExportOptions): string {
  return serializeDelimited(rows, opts, ',');
}

export function toTSV(rows: ExportRow[], opts: ExportOptions): string {
  return serializeDelimited(rows, opts, '\t');
}

function escapeHTML(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Excel 2003 HTML workbook (.xls). Excel reads this natively and keeps numeric
 * cells numeric, which plain CSV cannot guarantee. Always UTF-8 (declared in
 * the meta tag and prefixed with a BOM so Excel does not fall back to CP1251).
 */
export function toXLS(rows: ExportRow[], opts: ExportOptions): string {
  const headers = ['Query', ...opts.selectedVariants.map((v) => variantLabel(v))];
  const isNumeric = (s: string) => /^-?\d+(\.\d+)?$/.test(s);

  const headerCells = headers
    .map((h) => `<th class="gfd-h">${escapeHTML(h)}</th>`)
    .join('');
  const bodyRows = rows
    .map((row) => {
      const cells = [`<td class="gfd-s">${escapeHTML(row.originalQuery)}</td>`];
      for (const v of opts.selectedVariants) {
        const val = row.values[v];
        if (val == null || val === '') {
          cells.push('<td class="gfd-n"></td>');
          continue;
        }
        const s = String(val);
        cells.push(
          isNumeric(s)
            ? `<td class="gfd-n" x:num="${escapeHTML(s)}"></td>`
            : `<td class="gfd-s">${escapeHTML(s)}</td>`
        );
      }
      return `<tr>${cells.join('')}</tr>`;
    })
    .join('');

  return `${UTF8_BOM}<html xmlns:x="urn:schemas-microsoft-com:office:excel">
<head>
<meta charset="UTF-8" />
<!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet>
<x:Name>WordStat</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions>
</x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->
<style>
table.gfd-export{border-collapse:collapse;font-family:sans-serif;font-size:11pt}
table.gfd-export th.gfd-h{background:#eee;font-weight:bold;border:1px solid #999;padding:4px}
table.gfd-export td{border:1px solid #ccc;padding:4px}
td.gfd-n{mso-number-format:"\\@";text-align:right}
</style>
</head>
<body>
<table class="gfd-export">
<thead><tr>${headerCells}</tr></thead>
<tbody>${bodyRows}</tbody>
</table>
</body>
</html>`;
}

/** Trigger a browser download for the given content. */
export function downloadExport(filename: string, mime: string, content: string): void {
  const blob = new Blob([content], { type: mime + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    // Revoke on next tick so the click has time to register.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

export function filenameFor(format: ExportFormat, queries: ExportRow[]): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  const count = queries.length;
  return `wordstat-${count}queries-${stamp}.${format}`;
}

function variantLabel(v: FetcherVariantKey): string {
  return FETCHER_VARIANTS[v]?.label ?? v;
}