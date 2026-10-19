// ===========================================================================
// RFC 4180 CSV parsing (Task T-A6.3) — part of the generic CSV import framework that
// T-A11 (product / stock / customer / supplier imports) reuses.
//
// Fields are separated by commas and records by CRLF or LF; a field may be wrapped in
// double quotes, inside which commas, line breaks and doubled quotes ("") are literal. A
// leading UTF-8 byte-order mark (what spreadsheet programs add) is dropped, and wholly
// blank lines are skipped. Malformed input — an unterminated quote, a quote in the middle
// of an unquoted field — is reported with its line number, never guessed at.
// ===========================================================================

export interface CsvRecord {
  /** 1-based physical line on which the record starts. */
  readonly line: number;
  readonly fields: readonly string[];
}

export class CsvSyntaxError extends Error {
  readonly line: number;
  constructor(line: number, message: string) {
    super(`CSV line ${line.toString()}: ${message}`);
    this.name = "CsvSyntaxError";
    this.line = line;
  }
}

/** Splits CSV text into records of raw string fields. Throws CsvSyntaxError on malformed input. */
export function parseCsvRecords(text: string): CsvRecord[] {
  const input = text.startsWith("﻿") ? text.slice(1) : text;
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldWasQuoted = false;
  let line = 1;
  let recordLine = 1;

  const endField = () => {
    fields.push(field);
    field = "";
    fieldWasQuoted = false;
  };
  const endRecord = () => {
    endField();
    const blank = fields.length === 1 && fields[0] === "";
    if (!blank) {
      records.push({ line: recordLine, fields });
    }
    fields = [];
  };

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === "\n") line += 1;
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      if (field !== "" || fieldWasQuoted) {
        throw new CsvSyntaxError(line, "a quote may only open a field.");
      }
      inQuotes = true;
      fieldWasQuoted = true;
    } else if (ch === ",") {
      endField();
    } else if (ch === "\r" && input[i + 1] === "\n") {
      // CRLF: the LF ends the record.
    } else if (ch === "\n" || ch === "\r") {
      endRecord();
      line += 1;
      recordLine = line;
    } else {
      if (fieldWasQuoted) {
        throw new CsvSyntaxError(line, "text after a closing quote.");
      }
      field += ch;
    }
  }
  if (inQuotes) {
    throw new CsvSyntaxError(recordLine, "a quoted field is never closed.");
  }
  if (field !== "" || fields.length > 0 || fieldWasQuoted) {
    endRecord();
  }
  return records;
}

/** One CSV field, quoted when it must be. */
export function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** A CSV line from values. */
export function csvLine(values: readonly string[]): string {
  return values.map(csvField).join(",");
}
