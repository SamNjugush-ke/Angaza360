import { centsToAmount, parseCents, parseMajorToCents } from "@/lib/money";

// Splitting a payment across open items, OLDEST FIRST — the default a person can then change. Pure
// and in BigInt cents through the money utils; never a number. The server re-checks everything
// (an allocation must not exceed what is owed, and they must sum to the payment exactly); this
// only proposes, so a cashier or accountant does not have to do the arithmetic by hand.

export interface OpenItem {
  id: string;
  /** What is still owed on it, in cents. */
  outstanding: string;
}

/** The payment spread over the items in the order given (oldest first): each takes up to what it owes. */
export function allocateOldestFirst(items: readonly OpenItem[], amountCents: bigint): Record<string, string> {
  const shares: Record<string, string> = {};
  let left = amountCents;
  for (const item of items) {
    const owed = parseCents(item.outstanding);
    const share = left < owed ? left : owed;
    shares[item.id] = share > 0n ? centsToAmount(share) : "";
    left -= share > 0n ? share : 0n;
  }
  return shares;
}

export interface AllocationCheck {
  /** Σ of what was typed against the items, in cents. */
  allocated: bigint;
  /** payment − allocated: must be 0 to save. */
  unallocated: bigint;
  /** A message per item that cannot be saved as typed. */
  problems: Readonly<Record<string, string>>;
  ok: boolean;
}

function typed(value: string): bigint | null {
  if (value.trim() === "") return 0n;
  try {
    return parseMajorToCents(value);
  } catch {
    return null;
  }
}

/** Checks typed shares against what each item owes and against the payment. */
export function checkAllocation(items: readonly OpenItem[], shares: Readonly<Record<string, string>>, amountCents: bigint | null): AllocationCheck {
  const problems: Record<string, string> = {};
  let allocated = 0n;
  for (const item of items) {
    const share = typed(shares[item.id] ?? "");
    if (share === null) {
      problems[item.id] = "Enter an amount in shillings.";
      continue;
    }
    if (share < 0n) problems[item.id] = "An amount cannot be negative.";
    else if (share > parseCents(item.outstanding)) problems[item.id] = "That is more than is owed on it.";
    allocated += share;
  }
  const unallocated = (amountCents ?? 0n) - allocated;
  return { allocated, unallocated, problems, ok: amountCents !== null && amountCents > 0n && allocated > 0n && unallocated === 0n && Object.keys(problems).length === 0 };
}

/** The allocations as the API takes them: only items with a share, in shillings. */
export function allocationsToBody<K extends string>(items: readonly OpenItem[], shares: Readonly<Record<string, string>>, key: K): Array<Record<K, string> & { amount: string }> {
  const rows: Array<Record<K, string> & { amount: string }> = [];
  for (const item of items) {
    const share = typed(shares[item.id] ?? "");
    if (share !== null && share > 0n) rows.push({ [key]: item.id, amount: centsToAmount(share) } as Record<K, string> & { amount: string });
  }
  return rows;
}
