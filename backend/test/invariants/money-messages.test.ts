// T-B-ERR-MONEY-FMT: the API's refusals word money as shillings ("KES 1,250.50"), never raw cents.
// Two refusals that need no data behind them stand for the sweep (ledger, payables, receivables,
// payroll remittances, the POS credit and tender checks and M-Pesa all go through formatCentsKes).

import { describe, expect, it } from "vitest";
import { postJournalEntry } from "../../src/services/ledger";
import { recordCustomerReceipt } from "../../src/services/receivables";
import { tenantDb } from "../setup/tenant";
import { actorId } from "../support/fixtures";

describe("money in refusals", () => {
  it("an unbalanced journal entry names both sides and the difference in shillings", async () => {
    await expect(
      postJournalEntry(tenantDb(), {
        entryDate: new Date(),
        description: "unbalanced",
        source: "MANUAL",
        createdBy: actorId(),
        lines: [
          { accountCode: "1000", debit: 1_000_000n },
          { accountCode: "3000", credit: 999_999n },
        ],
      }),
    ).rejects.toThrow("debits KES 10,000.00 but credits KES 9,999.99 (out by KES 0.01)");
  });

  it("a receipt whose allocations do not add up names both totals in shillings", async () => {
    await expect(
      recordCustomerReceipt(tenantDb(), {
        customerId: "no-such-customer",
        receiptDate: new Date(),
        method: "CASH",
        amount: 125_050n,
        allocations: [{ saleId: "no-such-sale", amount: 100_000n }],
        createdById: actorId(),
      }),
    ).rejects.toThrow("The allocations total KES 1,000.00 but the receipt is KES 1,250.50.");
  });
});
