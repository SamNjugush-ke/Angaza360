import { centsToAmount, parseMajorToCents } from "@/lib/money";
import { isQuantity, stepQuantity, toMilli } from "./quantity";
import type { QuoteBody } from "./types";

// The till's cart — pure state and transitions, so the arithmetic is testable without a screen.
// A line holds what the cashier TYPED (quantity, a discount in shillings); the server's quote is
// the authority on every money figure. The cart never computes a price, a VAT or a total.

export interface CartProduct {
  id: string;
  sku: string;
  name: string;
  kind: "GOOD" | "SERVICE";
  unitOfMeasure: string;
  /** The shelf price in cents, for the search list only — the quote prices the sale. */
  price: string;
}

export interface CartLine {
  product: CartProduct;
  /** Decimal string, as typed. */
  quantity: string;
  /** Discount on the whole line, in shillings, as typed ("" for none). */
  discount: string;
}

export type CartAction =
  | { type: "add"; product: CartProduct }
  | { type: "quantity"; productId: string; quantity: string }
  | { type: "step"; productId: string; delta: 1 | -1 }
  | { type: "discount"; productId: string; discount: string }
  | { type: "remove"; productId: string }
  | { type: "clear" };

export function cartReducer(lines: readonly CartLine[], action: CartAction): CartLine[] {
  switch (action.type) {
    case "add": {
      const existing = lines.find((line) => line.product.id === action.product.id);
      if (existing) {
        return lines.map((line) => (line === existing ? { ...line, quantity: stepQuantity(line.quantity, 1) } : line));
      }
      return [...lines, { product: action.product, quantity: "1", discount: "" }];
    }
    case "quantity":
      return lines.map((line) => (line.product.id === action.productId ? { ...line, quantity: action.quantity } : line));
    case "step":
      return lines.map((line) => (line.product.id === action.productId ? { ...line, quantity: stepQuantity(line.quantity, action.delta) } : line));
    case "discount":
      return lines.map((line) => (line.product.id === action.productId ? { ...line, discount: action.discount } : line));
    case "remove":
      return lines.filter((line) => line.product.id !== action.productId);
    case "clear":
      return [];
  }
}

/** Why a line cannot be quoted as typed, or null. */
export function lineProblem(line: CartLine): string | null {
  if (!isQuantity(line.quantity) || toMilli(line.quantity) === 0n) return "Enter a quantity above 0 (up to 3 decimals).";
  if (line.discount.trim() !== "") {
    try {
      if (parseMajorToCents(line.discount) < 0n) return "A discount cannot be negative.";
    } catch {
      return "Enter the discount in shillings, e.g. 50 or 12.50.";
    }
  }
  return null;
}

/** The quote / sale lines — discounts as the API's decimal shilling strings — or null while any line is invalid. */
export function cartToLines(lines: readonly CartLine[]): QuoteBody["lines"] | null {
  if (lines.length === 0 || lines.some((line) => lineProblem(line) !== null)) return null;
  return lines.map((line) => {
    const discount = line.discount.trim() === "" ? 0n : parseMajorToCents(line.discount);
    return {
      productId: line.product.id,
      quantity: line.quantity.trim(),
      ...(discount > 0n ? { discount: centsToAmount(discount) } : {}),
    };
  });
}
