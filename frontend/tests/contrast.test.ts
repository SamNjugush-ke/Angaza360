import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// WCAG 2.2 AA contrast, computed from app/globals.css — the ONE token source — for every
// foreground/background pair the UI uses, in the light theme AND the dark theme. (axe cannot
// measure contrast in jsdom, which loads no CSS; this is the check that does.)
// Text needs 4.5:1; focus rings and form-field edges (non-text, WCAG 1.4.11) need 3:1.

type RGB = [number, number, number];

const css = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");

function block(selector: RegExp): Record<string, string> {
  const match = selector.exec(css);
  if (!match) throw new Error(`no block ${selector}`);
  const body = css.slice(match.index + match[0].length, css.indexOf("}", match.index + match[0].length));
  const vars: Record<string, string> = {};
  for (const [, name, value] of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) vars[name] = value.replace(/\/\*.*?\*\//g, "").trim();
  return vars;
}

const light = block(/^:root \{/m);
const dark = { ...light, ...block(/^\.dark \{/m) };
const darkMedia = { ...light, ...block(/:root:not\(\.light\) \{/) };

function resolve(theme: Record<string, string>, name: string): RGB {
  let value = theme[name];
  for (let i = 0; i < 5 && value?.startsWith("var("); i += 1) value = theme[value.slice(6, -1)];
  if (!value) throw new Error(`unknown token --${name}`);
  const parts = value.split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) throw new Error(`--${name} is not a channel triplet: ${value}`);
  return parts as RGB;
}

const over = (top: RGB, alpha: number, under: RGB): RGB => top.map((c, i) => c * alpha + under[i] * (1 - alpha)) as RGB;

function luminance([r, g, b]: RGB): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function ratio(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT = 4.5;
const NON_TEXT = 3;

// [foreground, background, minimum]
const SEMANTIC_PAIRS: [string, string, number][] = [
  ["foreground", "background", TEXT],
  ["card-foreground", "card", TEXT],
  ["popover-foreground", "popover", TEXT],
  ["muted-foreground", "background", TEXT],
  ["muted-foreground", "card", TEXT],
  ["muted-foreground", "muted", TEXT],
  ["primary-foreground", "primary", TEXT],
  ["secondary-foreground", "secondary", TEXT],
  ["accent-foreground", "accent", TEXT],
  ["destructive-foreground", "destructive", TEXT],
  ["primary", "background", TEXT], // links, the active bottom-bar tab
  ["primary", "card", TEXT],
  ["destructive", "background", TEXT], // error text
  ["destructive", "card", TEXT],
  ["success-text", "background", TEXT],
  ["success-text", "card", TEXT],
  ["ring", "background", NON_TEXT],
  ["ring", "card", NON_TEXT],
  ["input", "background", NON_TEXT],
  ["input", "card", NON_TEXT],
  // Chart series are graphical objects (WCAG 1.4.11).
  ["chart-revenue", "card", NON_TEXT],
  ["chart-net", "card", NON_TEXT],
  ["chart-revenue", "background", NON_TEXT],
  ["chart-net", "background", NON_TEXT],
];

describe("AA contrast from the design tokens", () => {
  it.each([
    ["light", light],
    ["dark (class)", dark],
    ["dark (system preference)", darkMedia],
  ] as const)("every semantic pair passes in the %s theme", (_, theme) => {
    const failures = SEMANTIC_PAIRS.filter(([fg, bg, min]) => ratio(resolve(theme, fg), resolve(theme, bg)) < min).map(
      ([fg, bg, min]) => `${fg} on ${bg}: ${ratio(resolve(theme, fg), resolve(theme, bg)).toFixed(2)} < ${min}`,
    );
    expect(failures).toEqual([]);
  });

  it("the navy sidebar passes: white, white/85, white/70 text, on navy and on the active white/10 fill; the gold focus ring", () => {
    const navy = resolve(light, "angaza-navy");
    const white = resolve(light, "angaza-white");
    const activeFill = over(white, 0.1, navy);
    expect(ratio(white, navy)).toBeGreaterThanOrEqual(TEXT);
    expect(ratio(over(white, 0.85, navy), navy)).toBeGreaterThanOrEqual(TEXT);
    expect(ratio(over(white, 0.7, navy), navy)).toBeGreaterThanOrEqual(TEXT);
    expect(ratio(white, activeFill)).toBeGreaterThanOrEqual(TEXT);
    expect(ratio(resolve(light, "angaza-gold"), navy)).toBeGreaterThanOrEqual(NON_TEXT);
  });

  it("reproduces a ratio recorded in globals.css (white on primary 7.13:1), so the arithmetic is right", () => {
    expect(ratio(resolve(light, "primary-foreground"), resolve(light, "primary")).toFixed(2)).toBe("7.13");
  });
});

describe("the landing page's forced Precision palette", () => {
  const landing = block(/^\.landing \{/m);

  it("re-declares exactly the light theme's values, so it is light (and AA) whatever the visitor's preference", () => {
    expect(Object.keys(landing).length).toBeGreaterThan(15);
    for (const [name, value] of Object.entries(landing)) expect([name, value]).toEqual([name, light[name]]);
  });

  it("the hero's one gold metric is AA text on navy; the panel's white/75 notes are too", () => {
    const navy = resolve(light, "angaza-navy");
    expect(ratio(resolve(light, "angaza-gold"), navy)).toBeGreaterThanOrEqual(TEXT);
    expect(ratio(over(resolve(light, "angaza-white"), 0.75, navy), navy)).toBeGreaterThanOrEqual(TEXT);
  });
});
