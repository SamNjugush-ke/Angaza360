// ===========================================================================
// THE MENTORSHIP ACCESS GATE (Module 14, Task 14.1).
//
// THE ONE SANCTIONED CROSS-TENANT READ IN THE SYSTEM — the "explicit, separately
// reviewed aggregation service" the engineering ledger requires for any read across tenant schemas.
// It is the ONLY place in the codebase that opens a tenant database from a MENTOR
// context, and the ONLY writer of `mentorship_access_logs`. Everything a mentor sees of
// a business passes through `withEngagedTenant`.
//
// WHAT MAKES IT SAFE — and none of it may be weakened:
//
//   1. THE TENANT COMES FROM THE ENGAGEMENT, NEVER FROM THE CALLER. The only inputs are
//      the mentor's id (from the verified session) and an engagement id. There is no
//      parameter through which a tenant, schema or business could be named; the schema
//      opened is the one recorded on the engagement's tenant.
//   2. ONLY AN ACTIVE ENGAGEMENT OF THIS MENTOR OPENS ANYTHING. No engagement, someone
//      else's engagement, an INVITED (unconsented) one, an ENDED one, or a business that
//      is no longer ACTIVE: all fail IDENTICALLY as not-found, so the gate never reveals
//      which relationships exist.
//   3. EVERY READ IS LOGGED before any data is returned — mentor, business, engagement,
//      resource, time — in an append-only table the business owner can read. The
//      database itself refuses a log row for anything but an ACTIVE engagement's own
//      mentor and business.
//   4. THE READ CANNOT WRITE. The mentee's schema is opened inside a `READ ONLY`
//      transaction — since Task T-A12 by the shared gate, src/services/tenant-read-gate.ts,
//      which the donor-cohort aggregate uses too — so a mentor path that tried to post,
//      edit or delete anything in the business's books would be refused by PostgreSQL
//      itself, not merely by the absence of a write in this code.
//   5. NO NEW CROSS-SCHEMA SQL. The read callback receives an ordinary Module 13
//      `ReportSource` for the one engaged schema, so mentors see figures computed by the
//      same proven, reconciling engine the owner's reports use — never a parallel
//      calculation that could disagree.
// ===========================================================================

import { platformDb } from "../../db/platform";
import { assertValidSchemaName } from "../../db/tenant";
import type { ReportSource } from "../reports";
import { withConsentedTenantReadOnly } from "../tenant-read-gate";
import { MentorshipNotFoundError } from "./engagements";

export interface EngagedTenant {
  engagementId: string;
  tenantId: string;
  businessName: string;
}

interface ResolvedTenant extends EngagedTenant {
  dbSchema: string;
}

/**
 * Resolve the business a mentor may read through ONE engagement.
 * Throws `MentorshipNotFoundError` (404) for every failure, without saying which.
 */
async function resolveEngagedTenant(mentorId: string, engagementId: string): Promise<ResolvedTenant> {
  const engagement = await platformDb.mentorshipEngagement.findUnique({
    where: { id: engagementId },
    select: {
      id: true,
      mentorId: true,
      status: true,
      tenantId: true,
      tenant: { select: { name: true, dbSchema: true, status: true } },
    },
  });
  if (
    engagement === null ||
    engagement.mentorId !== mentorId ||
    engagement.status !== "ACTIVE" ||
    engagement.tenant.status !== "ACTIVE"
  ) {
    throw new MentorshipNotFoundError();
  }
  assertValidSchemaName(engagement.tenant.dbSchema);
  return {
    engagementId: engagement.id,
    tenantId: engagement.tenantId,
    businessName: engagement.tenant.name,
    dbSchema: engagement.tenant.dbSchema,
  };
}

/**
 * Run ONE read against the business an ACTIVE engagement grants. The read is logged
 * first, then runs inside a READ ONLY transaction on that business's schema through the
 * shared gate (src/services/tenant-read-gate.ts); the callback receives a Module 13
 * `ReportSource` for exactly that schema and nothing else.
 */
export async function withEngagedTenant<T>(
  mentorId: string,
  engagementId: string,
  resource: string,
  read: (source: ReportSource, tenant: EngagedTenant) => Promise<T>,
): Promise<T> {
  const resolved = await resolveEngagedTenant(mentorId, engagementId);
  const tenant: EngagedTenant = {
    engagementId: resolved.engagementId,
    tenantId: resolved.tenantId,
    businessName: resolved.businessName,
  };
  return withConsentedTenantReadOnly(
    resolved.dbSchema,
    async () => {
      await platformDb.mentorshipAccessLog.create({
        data: { engagementId: resolved.engagementId, mentorId, tenantId: resolved.tenantId, resource },
      });
    },
    (source) => read(source, tenant),
  );
}
