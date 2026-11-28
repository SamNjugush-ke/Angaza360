// ===========================================================================
// Simple expense capture (Task T-A9, tenant migration 0028).
//
// "Record an expense": an amount, a plain category (an operating-expense account), how it
// was PAID, and a description. Its financial effect is ONE balanced journal entry posted
// through the ledger service — the only writer of journal tables — in the SAME transaction
// as the Expense row, so the document and its accounting commit or fail together:
//
//     Dr <category: an operating-expense account, 6000–6999>      amount
//     Cr <how it was paid: CASH 1000 | MPESA 1010 | BANK 1020>    amount
//
// HONEST PAYMENT-METHOD SEMANTICS: the credit leg is where the money actually left from.
// PAID-NOW ONLY (product-owner decision): something bought on credit is a supplier bill
// (Accounts Payable takes EXPENSE lines and reconciles 2000), never an expense here.
//
// NO INPUT VAT YET (product-owner decision): the expense posts GROSS. Recognising input
// VAT here would widen input-VAT recovery while the mixed-supplies apportionment watch
// item is open; the `vatInputCents` column is the plug, pinned to 0 by CHECK.
//
// THE CATEGORY must be an operating-expense account (6000–6999) that no other module
// owns: 6020 / 6025 are payroll's (each ties to payslips), 6090 Depreciation is a non-cash
// book entry, 6110 Turnover Tax is accrued by the sale path; cost of sales (5xxx), assets,
// liabilities, equity and revenue are never an expense. Refused here (400) and by CHECK.
//
// A MISTAKE IS VOIDED, NEVER EDITED: the void posts a REVERSING journal entry (the
// original stays, immutable) and marks the row voided; the guard trigger permits that one
// change and nothing else.
// ===========================================================================

import { randomUUID } from "node:crypto";
import { tenantSchemaFor } from "../db/tenant";
import type { PrismaClient as TenantPrismaClient } from "../generated/tenant/client";
import type { ExpensePaymentMethod } from "../generated/tenant/enums";
import type { Cents } from "../lib/money";
import {
  LedgerValidationError,
  PeriodClosedError,
  postJournalEntryWithinTransaction,
  reverseJournalEntryWithinTransaction,
} from "./ledger";

/** Where the money left from, by payment method. */
export const EXPENSE_PAYMENT_ACCOUNT: Readonly<Record<ExpensePaymentMethod, string>> = {
  CASH: "1000",
  MPESA: "1010",
  BANK: "1020",
};

/** Operating-expense accounts another module owns; never charged by a captured expense. */
export const SYSTEM_EXPENSE_ACCOUNTS: ReadonlySet<string> = new Set(["6020", "6025", "6090", "6110"]);

export class ExpenseError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = "ExpenseError";
    this.status = status;
  }
}

export interface ExpenseView {
  readonly id: string;
  readonly expenseDate: Date;
  readonly category: string;
  readonly payee: string | null;
  readonly description: string;
  readonly paymentMethod: ExpensePaymentMethod;
  readonly amountCents: Cents;
  readonly vatInputCents: Cents;
  readonly reference: string | null;
  readonly journalEntryId: string;
  readonly isVoided: boolean;
  readonly voidedByEntryId: string | null;
  readonly voidedAt: Date | null;
  readonly voidReason: string | null;
  readonly createdBy: string;
  readonly createdAt: Date;
}

export interface RecordExpenseInput {
  /** The business date the expense was incurred (00:00 UTC of that day). */
  readonly expenseDate: Date;
  readonly category: string;
  readonly payee: string | null;
  readonly description: string;
  readonly paymentMethod: ExpensePaymentMethod;
  readonly amountCents: Cents;
  readonly reference: string | null;
  readonly createdBy: string;
}

async function assertChargeableCategory(db: TenantPrismaClient, category: string): Promise<string> {
  const account = await db.account.findUnique({
    where: { code: category },
    select: { code: true, name: true, accountClass: true, isActive: true },
  });
  if (account === null) {
    throw new ExpenseError(400, `There is no account ${category} in the chart.`);
  }
  if (account.accountClass !== "EXPENSE" || !/^6[0-9]{3}$/.test(account.code)) {
    throw new ExpenseError(400, `${account.code} ${account.name} is not an operating-expense account; an expense is charged to 6000–6999.`);
  }
  if (SYSTEM_EXPENSE_ACCOUNTS.has(account.code)) {
    throw new ExpenseError(400, `${account.code} ${account.name} is written by another module (payroll, depreciation or Turnover Tax) and cannot be charged by a captured expense.`);
  }
  if (!account.isActive) {
    throw new ExpenseError(400, `${account.code} ${account.name} is inactive.`);
  }
  return account.name;
}

function translateLedgerError(error: unknown): never {
  if (error instanceof PeriodClosedError) {
    throw new ExpenseError(409, error.message);
  }
  if (error instanceof LedgerValidationError) {
    throw new ExpenseError(400, error.message);
  }
  throw error;
}

export async function recordExpense(db: TenantPrismaClient, input: RecordExpenseInput): Promise<ExpenseView> {
  if (input.amountCents <= 0n) {
    throw new ExpenseError(400, "An expense amount must be positive.");
  }
  if (input.description.trim() === "") {
    throw new ExpenseError(400, "Describe the expense.");
  }
  const accountName = await assertChargeableCategory(db, input.category);
  const schema = tenantSchemaFor(db);
  const id = randomUUID();
  try {
    return await db.$transaction(async (tx) => {
      const entry = await postJournalEntryWithinTransaction(tx, schema, {
        entryDate: input.expenseDate,
        description: `Expense: ${input.description.trim()}`,
        reference: input.reference ?? undefined,
        source: "EXPENSE",
        sourceId: id,
        createdBy: input.createdBy,
        lines: [
          { accountCode: input.category, debit: input.amountCents, memo: accountName },
          { accountCode: EXPENSE_PAYMENT_ACCOUNT[input.paymentMethod], credit: input.amountCents, memo: `Paid by ${input.paymentMethod}` },
        ],
      });
      return tx.expense.create({
        data: {
          id,
          expenseDate: input.expenseDate,
          category: input.category,
          payee: input.payee,
          description: input.description.trim(),
          paymentMethod: input.paymentMethod,
          amountCents: input.amountCents,
          reference: input.reference,
          journalEntryId: entry.id,
          createdBy: input.createdBy,
        },
      });
    });
  } catch (error) {
    return translateLedgerError(error);
  }
}

export interface ExpenseFilter {
  readonly from: Date | null;
  readonly to: Date | null;
  readonly category: string | null;
  readonly includeVoided: boolean;
}

export async function listExpenses(db: TenantPrismaClient, filter: ExpenseFilter): Promise<ExpenseView[]> {
  return db.expense.findMany({
    where: {
      ...(filter.from !== null || filter.to !== null
        ? { expenseDate: { ...(filter.from !== null ? { gte: filter.from } : {}), ...(filter.to !== null ? { lte: filter.to } : {}) } }
        : {}),
      ...(filter.category !== null ? { category: filter.category } : {}),
      ...(filter.includeVoided ? {} : { isVoided: false }),
    },
    orderBy: [{ expenseDate: "desc" }, { createdAt: "desc" }],
  });
}

export async function getExpense(db: TenantPrismaClient, id: string): Promise<ExpenseView> {
  const expense = await db.expense.findUnique({ where: { id } });
  if (expense === null) {
    throw new ExpenseError(404, "No such expense.");
  }
  return expense;
}

export async function voidExpense(db: TenantPrismaClient, id: string, reason: string, userId: string): Promise<ExpenseView> {
  const schema = tenantSchemaFor(db);
  try {
    return await db.$transaction(async (tx) => {
      const expense = await tx.expense.findUnique({ where: { id } });
      if (expense === null) {
        throw new ExpenseError(404, "No such expense.");
      }
      if (expense.isVoided) {
        throw new ExpenseError(409, "The expense is already voided.");
      }
      // A NEW opposite entry; the original stays exactly as posted.
      const reversal = await reverseJournalEntryWithinTransaction(tx, schema, expense.journalEntryId, `void expense: ${reason}`, userId);
      return tx.expense.update({
        where: { id },
        data: { isVoided: true, voidedByEntryId: reversal.id, voidedAt: new Date(), voidReason: reason },
      });
    });
  } catch (error) {
    if (error instanceof ExpenseError) throw error;
    return translateLedgerError(error);
  }
}
