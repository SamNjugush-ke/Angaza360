// ===========================================================================
// THE CONSENTED, LOGGED, READ-ONLY TENANT GATE — the shared primitive (Task T-A12,
// extracted from the Module 14 mentorship gate, Task 14.1).
//
// The ONE way any platform-side feature reads a business's books. It is not a reader a
// caller can aim at an arbitrary tenant: its callers resolve the schema FROM A CONSENT
// RECORD (a mentorship engagement, a donor-project membership) and pass the access-log
// write for THAT record. It then
//   1. LOGS THE READ FIRST — the caller's append-only log row is written before any data
//      is returned (an admitted read is logged even if the read then fails);
//   2. opens the business's schema inside a `SET TRANSACTION READ ONLY` transaction, so
//      PostgreSQL itself refuses any INSERT, UPDATE or DELETE (SQLSTATE 25006);
//   3. hands the read a Module 13 `ReportSource` for exactly that schema, so the figures
//      come from the same proven engine as the owner's own reports — never a parallel
//      calculation.
// There is no second raw cross-schema reader anywhere; this is it.
// ===========================================================================

import { assertValidSchemaName, getTenantDb } from "../db/tenant";
import type { ReportSource } from "./reports";

export async function withConsentedTenantReadOnly<T>(
  dbSchema: string,
  logAccess: () => Promise<void>,
  read: (source: ReportSource) => Promise<T>,
): Promise<T> {
  assertValidSchemaName(dbSchema);
  await logAccess();
  const db = getTenantDb(dbSchema);
  return db.$transaction(async (tx) => {
    // MUST be the transaction's first statement: from here PostgreSQL refuses any write.
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    return read({ reader: tx, schema: dbSchema });
  });
}
