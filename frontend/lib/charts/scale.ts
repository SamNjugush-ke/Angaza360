// A linear value -> pixel scale for money charts, computed on BigInt cents so the axis is exact
// at any magnitude. Only the final PIXEL coordinate becomes a JS number — a screen position,
// not money. Zero is always inside the domain, so a chart can draw its zero baseline (a month
// with a loss must read as below it).

export interface MoneyScale {
  /** The domain, widened to "nice" round bounds. */
  min: bigint;
  max: bigint;
  /** Tick values from min to max, evenly spaced on a 1/2/5 × 10^k step. */
  ticks: bigint[];
  /** Pixel y for a value: 0 at the top (max), `height` at the bottom (min). */
  y: (value: bigint) => number;
}

/** The smallest 1/2/5 × 10^k step that divides `span` into at most `maxTicks` intervals. */
function niceStep(span: bigint, maxTicks: number): bigint {
  const intervals = BigInt(maxTicks);
  const raw = span / intervals + (span % intervals === 0n ? 0n : 1n);
  let magnitude = 1n;
  while (magnitude * 10n <= raw) magnitude *= 10n;
  for (const factor of [1n, 2n, 5n, 10n]) {
    if (factor * magnitude >= raw) return factor * magnitude;
  }
  return 10n * magnitude;
}

const floorTo = (value: bigint, step: bigint) => {
  const q = value / step;
  return (value < 0n && q * step !== value ? q - 1n : q) * step;
};
const ceilTo = (value: bigint, step: bigint) => {
  const q = value / step;
  return (value > 0n && q * step !== value ? q + 1n : q) * step;
};

/** A scale over `values` (plus zero) for a plot `height` pixels tall. */
export function moneyScale(values: readonly bigint[], height: number, maxTicks = 4): MoneyScale {
  let lo = 0n;
  let hi = 0n;
  for (const value of values) {
    if (value < lo) lo = value;
    if (value > hi) hi = value;
  }
  // An all-zero series still needs a visible axis: KES 1,000 of headroom.
  if (lo === hi) hi = lo + 100_000n;
  const step = niceStep(hi - lo, maxTicks);
  const min = floorTo(lo, step);
  const max = ceilTo(hi, step);
  const ticks: bigint[] = [];
  for (let tick = min; tick <= max; tick += step) ticks.push(tick);
  // Pixels in thousandths, so rounding never drifts a bar off its baseline.
  const scaledHeight = BigInt(Math.round(height * 1000));
  const y = (value: bigint) => height - Number(((value - min) * scaledHeight) / (max - min)) / 1000;
  return { min, max, ticks, y };
}
