// ===========================================================================
// SUBLEDGER CONTROL ACCOUNTS (Task T-B-JE-CONTROL-GUARD) — the accounts a MANUAL journal entry may
// never touch.
//
// Each is a control account whose GL balance is DEFINED by a subledger or a single writer, so a
// hand-posted line has no document behind it and breaks the identity on the spot:
//   1015 M-Pesa Clearing  — written only by the M-Pesa payment service; nets to zero per tender.
//   1100 Receivables      — the open credit sales (+ the named M-Pesa-failure residual).
//   1200 Inventory        — Σ Product.stockValue, moved only by the inventory service.
//   2000 Payables         — unpaid supplier bills (+ the named ad-hoc-receipt residual).
//   2050 GRNI             — received-not-yet-billed; one writer (receipts), one clearer (bills).
// 1100 / 1200 / 2000 / 2050 are exactly the four Module 13 control reconciliations. The VAT, TOT and
// payroll liabilities are NOT here: they remain correctable by an accountant's entry, and VAT / TOT
// remittance is still a manual posting until its task is built.
//
// The ledger service refuses (400) a POST /v1/ledger/entries line on any of them; migration 0032's
// trigger refuses a MANUAL-source line on them from any writer (a reversal is exempt, so a stray
// historical entry can still be undone).
// ===========================================================================

export const SUBLEDGER_CONTROL_ACCOUNTS: Readonly<Record<string, string>> = {
  "1015": "M-Pesa Clearing — it is written only by M-Pesa payments and confirmations",
  "1100": "Accounts Receivable — it is the customers’ credit sales; record a customer receipt instead",
  "1200": "Inventory — it is the stock records; receive, adjust or write off stock instead",
  "2000": "Accounts Payable — it is the supplier bills; post or pay a supplier bill instead",
  "2050": "Goods Received Not Invoiced — it is cleared only by supplier bills against goods receipts",
};

export function isSubledgerControlAccount(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(SUBLEDGER_CONTROL_ACCOUNTS, code);
}
