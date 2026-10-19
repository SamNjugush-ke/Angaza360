// ===========================================================================
// THE IDENTITY AUDIT LOG IS APPEND-ONLY (Task T-A4; T-A5 writes to the same table).
//
// Attacked from OUTSIDE the service layer, like double-entry: raw UPDATE, DELETE and
// TRUNCATE are each refused by `audit_log_guard`, while an INSERT (the control) is
// accepted. Every attack runs in a rolled-back transaction.
// ===========================================================================

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { expectDbRefusal } from "../support/db-errors";
import { withPlatformTx } from "../support/platform-tx";

async function insertAuditRow(client: PoolClient): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO public.audit_logs ("id", "action", "actorUserId", "targetUserId", "ipAddress", "metadata")
     VALUES ($1, 'PASSWORD_CHANGED', $2, $2, '10.0.0.1', '{"note":"t-a4"}'::jsonb)`,
    [id, randomUUID()],
  );
  return id;
}

describe("audit_logs is append-only", () => {
  it("control: an INSERT is accepted", async () => {
    await withPlatformTx(async (client) => {
      const id = await insertAuditRow(client);
      const found = await client.query(`SELECT count(*)::int AS n FROM public.audit_logs WHERE "id" = $1`, [id]);
      expect(found.rows[0]).toEqual({ n: 1 });
    });
  });

  it("an UPDATE is refused", async () => {
    await withPlatformTx(async (client) => {
      const id = await insertAuditRow(client);
      await expectDbRefusal(client.query(`UPDATE public.audit_logs SET "ipAddress" = '10.9.9.9' WHERE "id" = $1`, [id]), {
        fn: "audit_log_guard",
        message: /append-only: UPDATE is refused/,
      });
    });
  });

  it("a DELETE is refused", async () => {
    await withPlatformTx(async (client) => {
      const id = await insertAuditRow(client);
      await expectDbRefusal(client.query(`DELETE FROM public.audit_logs WHERE "id" = $1`, [id]), {
        fn: "audit_log_guard",
        message: /append-only: DELETE is refused/,
      });
    });
  });

  it("a TRUNCATE is refused", async () => {
    await withPlatformTx(async (client) => {
      await expectDbRefusal(client.query(`TRUNCATE public.audit_logs`), {
        fn: "audit_log_guard",
        message: /append-only: TRUNCATE is refused/,
      });
    });
  });
});
