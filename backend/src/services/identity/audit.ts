// ===========================================================================
// The identity audit log (Task T-A4; extended by T-A5).
//
// `audit_logs` is APPEND-ONLY — the database refuses UPDATE, DELETE and TRUNCATE —
// and this module is its ONLY writer. Every identity event is one row: who did it
// (NULL for an unauthenticated reset request), to whom, in which tenant, from which
// address, and a small metadata object.
//
// METADATA NEVER CARRIES A SECRET: no token, no password, no hash. It records facts
// an auditor needs (an email that was asked about, the role before and after).
//
// The ids are plain columns with no foreign key, deliberately: the record outlives
// the user and the tenant it describes.
// ===========================================================================

import { platformDb } from "../../db/platform";
import type { Prisma } from "../../generated/platform/client";
import type { AuditAction } from "../../generated/platform/enums";

/** The platform client or a transaction on it — an audit row commits WITH its event. */
export type PlatformTx = Prisma.TransactionClient | typeof platformDb;

export interface AuditEntry {
  readonly action: AuditAction;
  readonly actorUserId: string | null;
  readonly targetUserId: string | null;
  readonly tenantId: string | null;
  readonly ipAddress: string | null;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export async function recordAudit(db: PlatformTx, entry: AuditEntry): Promise<string> {
  const row = await db.auditLog.create({
    data: {
      action: entry.action,
      actorUserId: entry.actorUserId,
      targetUserId: entry.targetUserId,
      tenantId: entry.tenantId,
      ipAddress: entry.ipAddress,
      ...(entry.metadata !== undefined ? { metadata: { ...entry.metadata } } : {}),
    },
    select: { id: true },
  });
  return row.id;
}
