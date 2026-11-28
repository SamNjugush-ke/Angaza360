// ===========================================================================
// THE CSV FRAMEWORK (Task T-A6.3) — pure: RFC 4180 parsing and schema-checked reading.
// T-A11's imports reuse exactly this.
// ===========================================================================

import { describe, expect, it } from "vitest";
import { csvTemplate, CsvFileError, readCsv, type CsvSchema } from "../../src/services/csv/import";
import { csvLine, CsvSyntaxError, parseCsvRecords } from "../../src/services/csv/parse";

const SCHEMA: CsvSchema = {
  maxRows: 3,
  columns: [
    { name: "name", required: true, description: "" },
    { name: "note", required: false, description: "" },
  ],
};

describe("parseCsvRecords", () => {
  it("handles quotes, embedded commas, doubled quotes, CRLF, a BOM, and blank lines", () => {
    const text = '﻿name,note\r\n"Acme, Ltd","She said ""hi"""\r\n\r\nPlain,\n"multi\nline",x\n';
    expect(parseCsvRecords(text)).toEqual([
      { line: 1, fields: ["name", "note"] },
      { line: 2, fields: ["Acme, Ltd", 'She said "hi"'] },
      { line: 4, fields: ["Plain", ""] },
      { line: 5, fields: ["multi\nline", "x"] },
    ]);
  });

  it("refuses an unterminated quote and text after a closing quote, with the line", () => {
    expect(() => parseCsvRecords('a,b\n"open,c\n')).toThrow(CsvSyntaxError);
    expect(() => parseCsvRecords('a,b\n"x"y,c\n')).toThrow(/line 2: text after a closing quote/);
  });

  it("csvLine quotes only what needs it", () => {
    expect(csvLine(["a", "b,c", 'q"', "x\ny"])).toBe('a,"b,c","q""","x\ny"');
  });
});

describe("readCsv against a schema", () => {
  it("maps rows by column name, fills absent optional columns, and numbers data rows", () => {
    expect(readCsv(SCHEMA, "name\n Acme \nBeta\n")).toEqual([
      { rowNumber: 1, values: { name: "Acme", note: "" } },
      { rowNumber: 2, values: { name: "Beta", note: "" } },
    ]);
  });

  it.each([
    ["an unknown column", "name,colour\nx,red\n", /Unknown column/],
    ["a missing required column", "note\nx\n", /Missing required column\(s\): name/],
    ["a repeated column", "name,name\nx,y\n", /Repeated column/],
    ["no data rows", "name\n", /no data rows/],
    ["too many rows", "name\na\nb\nc\nd\n", /at most 3/],
    ["a row longer than the header", "name\na,b\n", /more fields than the header/],
    ["an empty file", "", /empty/],
  ])("refuses %s", (_label, text, message) => {
    expect(() => readCsv(SCHEMA, text)).toThrow(CsvFileError);
    expect(() => readCsv(SCHEMA, text)).toThrow(message);
  });

  it("the template is the schema's header", () => {
    expect(csvTemplate(SCHEMA)).toBe("name,note\r\n");
  });
});
