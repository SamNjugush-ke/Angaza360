// ===========================================================================
// The generic CSV IMPORT FRAMEWORK (Task T-A6.3; T-A11 reuses it for products, opening
// stock, customers and suppliers).
//
// An import is always VALIDATE -> PREVIEW -> COMMIT:
//   1. VALIDATE THE FILE here: parse (./parse.ts), check the header against a declared
//      column schema (every REQUIRED column present, no unknown or repeated column, no
//      row longer than the header), cap the row count, and map every data row to a
//      record keyed by column name, carrying its data-line number. A FILE-level problem
//      refuses the whole upload; nothing is stored.
//   2. PREVIEW is the domain's: it stores the rows as reviewable, correctable items and
//      runs its own row validation over them (onboarding's is the green-gate) — every row
//      GREEN or RED with its errors, plus an "all green?" flag.
//   3. COMMIT is the domain's too, and it is GATED: it refuses unless EVERY remaining row
//      is GREEN, and it is IDEMPOTENT — a row already committed is never committed again.
// The template a user downloads is generated from the same column schema the upload is
// checked against, so the two cannot disagree.
// ===========================================================================

import { csvLine, parseCsvRecords, type CsvRecord } from "./parse";

export interface CsvColumn {
  readonly name: string;
  readonly required: boolean;
  readonly description: string;
}

export interface CsvSchema {
  readonly columns: readonly CsvColumn[];
  /** The most data rows one upload may carry. */
  readonly maxRows: number;
}

export interface CsvRow {
  /** 1 = the first data row after the header. */
  readonly rowNumber: number;
  /** Every column of the schema; a column absent from the file, or an empty cell, is "". */
  readonly values: Readonly<Record<string, string>>;
}

export class CsvFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvFileError";
  }
}

/** The header line (and only the header) for a schema — the downloadable template. */
export function csvTemplate(schema: CsvSchema): string {
  return `${csvLine(schema.columns.map((column) => column.name))}\r\n`;
}

/** Validates a file against a schema and returns its data rows. Throws CsvFileError. */
export function readCsv(schema: CsvSchema, text: string): CsvRow[] {
  let records: CsvRecord[];
  try {
    records = parseCsvRecords(text);
  } catch (error) {
    throw new CsvFileError(error instanceof Error ? error.message : "The file is not valid CSV.");
  }
  const [header, ...data] = records;
  if (header === undefined) {
    throw new CsvFileError("The file is empty: it needs a header row naming its columns.");
  }
  const names = header.fields.map((name) => name.trim());
  const known = new Set(schema.columns.map((column) => column.name));
  const unknown = names.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new CsvFileError(`Unknown column(s): ${unknown.join(", ")}. Download the template for the expected columns.`);
  }
  const repeated = names.filter((name, index) => names.indexOf(name) !== index);
  if (repeated.length > 0) {
    throw new CsvFileError(`Repeated column(s): ${[...new Set(repeated)].join(", ")}.`);
  }
  const missing = schema.columns.filter((column) => column.required && !names.includes(column.name)).map((c) => c.name);
  if (missing.length > 0) {
    throw new CsvFileError(`Missing required column(s): ${missing.join(", ")}.`);
  }
  if (data.length === 0) {
    throw new CsvFileError("The file has a header but no data rows.");
  }
  if (data.length > schema.maxRows) {
    throw new CsvFileError(`The file has ${data.length.toString()} data rows; one upload may carry at most ${schema.maxRows.toString()}.`);
  }
  return data.map((record, index) => {
    if (record.fields.length > names.length) {
      throw new CsvFileError(`Line ${record.line.toString()} has more fields than the header.`);
    }
    const values: Record<string, string> = {};
    for (const column of schema.columns) {
      const position = names.indexOf(column.name);
      values[column.name] = position === -1 ? "" : (record.fields[position] ?? "").trim();
    }
    return { rowNumber: index + 1, values };
  });
}
