import type { SVGProps } from "react";

// Hand-drawn glyphs for the landing page: one 32-unit grid, a 1.75 stroke, round joins, the
// current text colour. Decorative - every glyph sits beside words that say the same thing, so each
// is aria-hidden.

type GlyphProps = SVGProps<SVGSVGElement>;

function Glyph({ children, ...props }: GlyphProps) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={32}
      height={32}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

/** A phone with an incoming payment prompt. */
export function MpesaGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <rect x="9" y="3.5" width="14" height="25" rx="3" />
      <path d="M14 7h4" />
      <rect x="12" y="11" width="8" height="7" rx="1.5" />
      <path d="M14.5 14.6l1.2 1.2 2.3-2.6" />
      <path d="M14 23.5h4" />
    </Glyph>
  );
}

/** A receipt with a fiscal mark in its corner. */
export function ReceiptGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M8 3.5h16v25l-2.7-1.8-2.6 1.8-2.7-1.8-2.7 1.8-2.6-1.8L8 28.5z" />
      <path d="M11.5 9h9M11.5 13h9M11.5 17h5" />
      <rect x="18" y="19" width="4" height="4" rx="0.5" />
    </Glyph>
  );
}

/** A ledger: two columns that agree. */
export function LedgerGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <rect x="4.5" y="5.5" width="23" height="21" rx="2.5" />
      <path d="M16 5.5v21M4.5 11h23" />
      <path d="M8 15.5h5M8 19.5h5M19 15.5h5M19 19.5h5" />
      <path d="M8 23h5M19 23h5" strokeWidth={2.5} />
    </Glyph>
  );
}

/** Three locations joined by a route. */
export function LocationsGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M8 13.5c-2.5 0-4-1.9-4-4a4 4 0 018 0c0 2.1-1.5 4-4 4z" />
      <path d="M24 13.5c-2.5 0-4-1.9-4-4a4 4 0 018 0c0 2.1-1.5 4-4 4z" />
      <path d="M16 28c-2.5 0-4-1.9-4-4a4 4 0 018 0c0 2.1-1.5 4-4 4z" />
      <path d="M8 13.5v3.5l6 4.3M24 13.5v3.5l-6 4.3" strokeDasharray="1.5 2.5" />
    </Glyph>
  );
}

/** A till drawer with a coin and a note. */
export function SellGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <rect x="4" y="16" width="24" height="11" rx="2" />
      <path d="M4 21h24" />
      <rect x="7" y="6" width="13" height="7" rx="1" />
      <circle cx="13.5" cy="9.5" r="1.5" />
      <circle cx="24" cy="10" r="3" />
      <path d="M14 24h4" />
    </Glyph>
  );
}

/** Stacked cartons with a reorder flag. */
export function StockGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <rect x="4" y="16" width="11" height="11" rx="1" />
      <rect x="15" y="16" width="11" height="11" rx="1" />
      <rect x="9.5" y="5" width="11" height="11" rx="1" />
      <path d="M8 16v3.5M20.5 16v3.5M15 5v3.5" />
      <path d="M26 4v8M26 4h3.5l-1.2 2 1.2 2H26" />
    </Glyph>
  );
}

/** Two arrows passing money each way. */
export function MoneyFlowGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <rect x="10" y="10.5" width="12" height="11" rx="2" />
      <circle cx="16" cy="16" r="2.4" />
      <path d="M3.5 8h11M11 4.5L14.5 8 11 11.5" />
      <path d="M28.5 24h-11M21 20.5L17.5 24l3.5 3.5" />
    </Glyph>
  );
}

/** An open book of accounts with a tick. */
export function BooksGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M16 8.5C12.5 6 8 5.5 4 6.5v18c4-1 8.5-.5 12 2 3.5-2.5 8-3 12-2v-18c-4-1-8.5-.5-12 2z" />
      <path d="M16 8.5v18" />
      <path d="M7.5 12h5M7.5 16h5M19.5 15l2 2 3.5-4" />
    </Glyph>
  );
}

/** Two people and a payslip. */
export function TeamGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <circle cx="10" cy="9.5" r="3.5" />
      <path d="M3.5 24c0-4 2.9-7 6.5-7s6.5 3 6.5 7" />
      <circle cx="19" cy="8" r="2.8" />
      <path d="M17.5 13.6c.5-.1 1-.1 1.5-.1 2.6 0 4.6 1.6 5.4 4" />
      <rect x="19" y="18.5" width="9.5" height="10" rx="1.2" />
      <path d="M21.5 22h4.5M21.5 25.5h3" />
    </Glyph>
  );
}

/** The counter: a shopfront awning. */
export function ShopGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M4 12l2.5-6.5h19L28 12" />
      <path d="M4 12c0 1.9 1.6 3 3 3s3-1.1 3-3c0 1.9 1.6 3 3 3s3-1.1 3-3c0 1.9 1.6 3 3 3s3-1.1 3-3c0 1.9 1.6 3 3 3s3-1.1 3-3" />
      <path d="M6 15v12.5h20V15" />
      <rect x="13" y="19.5" width="6" height="8" />
    </Glyph>
  );
}

/** A balance: debits equal credits. */
export function BalanceGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M16 4.5v22M10 27.5h12M6.5 9h19" />
      <path d="M6.5 9L3 18h7zM25.5 9L22 18h7z" />
      <path d="M3 18a3.5 3 0 007 0M22 18a3.5 3 0 007 0" />
    </Glyph>
  );
}

/** A tick in a circle - paid, signed, balanced. */
export function CheckGlyph(props: GlyphProps) {
  return (
    <Glyph viewBox="0 0 20 20" width={20} height={20} strokeWidth={1.75} {...props}>
      <circle cx="10" cy="10" r="8" />
      <path d="M6.5 10.3l2.3 2.3 4.7-5" />
    </Glyph>
  );
}

/** A small fiscal QR mark, drawn on a 7×7 grid (illustrative, not a scannable code). */
export function QrMark(props: GlyphProps) {
  const cells = [
    "1111101",
    "1000101",
    "1011101",
    "1011100",
    "1000111",
    "1111001",
    "0010111",
  ];
  return (
    <svg viewBox="0 0 7 7" width={44} height={44} aria-hidden="true" focusable="false" shapeRendering="crispEdges" {...props}>
      {cells.flatMap((row, y) =>
        [...row].map((cell, x) => (cell === "1" ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill="currentColor" /> : null)),
      )}
    </svg>
  );
}
