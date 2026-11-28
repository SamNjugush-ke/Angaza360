// Quantities at the till — decimal STRINGS ("2", "1.5", "12.000"), compared and stepped as BigInt
// thousandths, the way the backend's inventory maths holds them. Never a JS number: a quantity is
// not money, but the till's arithmetic stays exact all the same.

const QUANTITY = /^\d+(\.\d{1,3})?$/;

/** A quantity a cashier may type: digits with up to 3 decimals. */
export function isQuantity(value: string): boolean {
  return QUANTITY.test(value.trim());
}

/** "1.5" → 1500n. Throws on anything but a non-negative decimal with ≤ 3 places. */
export function toMilli(value: string): bigint {
  const trimmed = value.trim();
  const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(trimmed);
  if (!match) throw new TypeError(`Not a quantity: "${value}"`);
  return BigInt(match[1] ?? "0") * 1000n + BigInt((match[2] ?? "").padEnd(3, "0"));
}

/** 1500n → "1.5"; 2000n → "2". */
export function fromMilli(milli: bigint): string {
  const whole = milli / 1000n;
  const fraction = (milli % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  return fraction === "" ? whole.toString() : `${whole.toString()}.${fraction}`;
}

/** A quantity stepped by a whole unit, never below zero. */
export function stepQuantity(value: string, delta: 1 | -1): string {
  const next = toMilli(isQuantity(value) ? value : "0") + BigInt(delta) * 1000n;
  return fromMilli(next < 0n ? 0n : next);
}

/** Whether `wanted` is more than `available` (both decimal strings). */
export function exceeds(wanted: string, available: string): boolean {
  return isQuantity(wanted) && isQuantity(available) && toMilli(wanted) > toMilli(available);
}

/** "12.000" → "12" for display. */
export function displayQuantity(value: string): string {
  return isQuantity(value) ? fromMilli(toMilli(value)) : value;
}
