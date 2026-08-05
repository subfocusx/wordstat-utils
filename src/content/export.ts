// src/content/export.ts
// Pure functions for exporting fetcher results to CSV / TSV / XLSX.
// No DOM dependencies — easy to unit test, easy to call from anywhere.
//
// File format: rows = one per query, columns = selected variants + original query.
// Empty / null values render as "" in CSV/TSV and as empty cells in XLSX.

import { type FetcherVariantKey } from '../config.ts';

export interface ExportRow {
  originalQuery: string;
  values: Partial<Record<FetcherVariantKey, string | number | null>>;
}

export type ExportFormat = 'csv' | 'tsv' | 'xlsx';

export interface ExportOptions {
  selectedVariants: FetcherVariantKey[];
  /** Optional BOM for Excel UTF-8 compatibility (CSV only). Default: false. */
  bom?: boolean;
}

/**
 * Escape a single CSV/TSV cell. Quotes the cell if it contains the delimiter,
 * a quote, or a newline. Doubles internal quotes per RFC 4180.
 */
function escapeCell(value: string, delim: string): string {
  if (value.includes(delim) || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Serialize rows + headers to CSV or TSV.
 * @param format 'csv' → comma, 'tsv' → tab
 */
function serializeDelimited(rows: ExportRow[], opts: ExportOptions, delim: ',' | '\t'): string {
  const headers = ['Query', ...opts.selectedVariants.map((v) => variantLabel(v))];
  const lines: string[] = [];
  lines.push(headers.map((h) => escapeCell(h, delim)).join(delim));
  for (const row of rows) {
    const cells: string[] = [escapeCell(row.originalQuery, delim)];
    for (const v of opts.selectedVariants) {
      const val = row.values[v];
      const cell = val == null ? '' : String(val);
      cells.push(escapeCell(cell, delim));
    }
    lines.push(cells.join(delim));
  }
  const body = lines.join('\r\n');
  return (opts.bom ? '\uFEFF' : '') + body;
}

export function toCSV(rows: ExportRow[], opts: ExportOptions): string {
  return serializeDelimited(rows, opts, ',');
}

export function toTSV(rows: ExportRow[], opts: ExportOptions): string {
  return serializeDelimited(rows, opts, '\t');
}

/**
 * Minimal XLSX writer. Produces an Office Open XML SpreadsheetML workbook
 * with a single sheet. Supports basic ASCII headers + cell values; no styling,
 * no formulas. File is saved as `.xls` (Excel reads SpreadsheetML in either
 * extension; for true .xlsx you'd need zipped XML — out of scope here).
 *
 * Trade-off: ~70 lines of inline XML vs pulling in SheetJS (700KB). For a
 * fetcher with up to ~200 queries and 4 columns this is plenty fast.
 */
export function toXLS(rows: ExportRow[], opts: ExportOptions): string {
  const headers = ['Query', ...opts.selectedVariants.map((v) => variantLabel(v))];
  const esc = (s: string) => s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const isNumeric = (s: string) => /^-?\d+(\.\d+)?$/.test(s);

  const headerCells = headers.map((h) =>
    `<Cell><Data ss:Type="String">${esc(h)}</Data></Cell>`
  ).join('');

  const dataRows = rows.map((row) => {
    const cells: string[] = [];
    cells.push(`<Cell><Data ss:Type="String">${esc(row.originalQuery)}</Data></Cell>`);
    for (const v of opts.selectedVariants) {
      const val = row.values[v];
      if (val == null || val === '') {
        cells.push('<Cell><Data ss:Type="String"></Data></Cell>');
      } else {
        const s = String(val);
        const t = isNumeric(s) ? 'Number' : 'String';
        cells.push(`<Cell><Data ss:Type="${t}">${esc(s)}</Data></Cell>`);
      }
    }
    return `<Row>${cells.join('')}</Row>`;
  }).join('');

  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
          xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
  <Worksheet ss:Name="WordStat">
    <Table>
      <Row>${headerCells}</Row>
      ${dataRows}
    </Table>
  </Worksheet>
</Workbook>`;
}

/**
 * Trigger a browser download for the given content. Uses an in-memory Blob
 * and object URL — no DOM strings leaking into global scope after the click.
 */
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
  switch (v) {
    case 'base': return 'W';
    case 'quoted': return '«W»';
    case 'bracketed': return '[W]';
    case 'excluded': return '«[!W]»';
    default: return v;
  }
}
