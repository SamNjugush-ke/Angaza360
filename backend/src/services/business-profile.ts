// ===========================================================================
// BUSINESS PROFILE (Task 5.1) — the per-tenant business-configuration singleton.
//
// THIS IS THE ONLY MODULE PERMITTED TO WRITE `business_profile`. It writes no
// other table, posts no journal entry and moves no stock: it stores facts ABOUT
// THE BUSINESS, which other services then read to decide how to post.
//
// WHY A SINGLETON AND NOT SETTINGS SCATTERED ACROSS COLUMNS: whether the tenant
// is VAT-registered is not a property of a product, a supplier or a transaction —
// it is a property of the business, and every posting path that needs it needs
// the SAME answer. One row, one answer, and a CHECK in migration 0017 that makes
// a second row unrepresentable.
//
// THIS IS WHERE STATUTORY FLAGS LIVE FROM NOW ON. Payroll will add NSSF / SHA /
// housing-levy applicability and its effective-dated rate sets here; the
// reporting module will read the regime to decide which tax reports apply. Adding
// one is a column plus a CHECK — never a new table, and never a constant in code
// (the engineering ledger "Configurable Statutory & Regulatory Values").
//
// RELATIONSHIP TO public.tenants.taxRegime: that field is REGISTRY METADATA for
// routing, billing and cohort segmentation, and no accounting code reads it. THIS
// table is AUTHORITATIVE FOR POSTING, and a posting path must never reach across
// schemas for the platform field — see the note on the model in
// prisma/tenant/schema.prisma.
// ===========================================================================

import type { PrismaClient as TenantPrismaClient } from "../generated/tenant/client";
import type { TenantTaxRegime } from "../generated/tenant/enums";
import type { LedgerTx } from "./ledger";

/**
 * The pinned primary key. There is exactly one row and this is its id; migration
 * 0017's `business_profile_is_singleton` CHECK makes any other id impossible, so
 * this constant is the whole addressing scheme.
 */
const SINGLETON_ID = "singleton";

export interface BusinessProfileRow {
  taxRegime: TenantTaxRegime;
  /** DERIVED from taxRegime and CHECK-guaranteed to agree with it. */
  isVatRegistered: boolean;
  kraPin: string | null;
  /** Receipt / display identity (Task T-A13). Display only — nothing posts from these. */
  legalName: string | null;
  addressLine: string | null;
  phone: string | null;
  email: string | null;
  receiptFooter: string | null;
  showLogoOnReceipt: boolean;
  createdAt: Date;
  updatedAt: Date;
}

type RawProfile = BusinessProfileRow;

function toRow(profile: RawProfile): BusinessProfileRow {
  return {
    taxRegime: profile.taxRegime,
    isVatRegistered: profile.isVatRegistered,
    kraPin: profile.kraPin,
    legalName: profile.legalName,
    addressLine: profile.addressLine,
    phone: profile.phone,
    email: profile.email,
    receiptFooter: profile.receiptFooter,
    showLogoOnReceipt: profile.showLogoOnReceipt,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

/**
 * The derivation that the database then enforces. VAT_REGISTERED is the only
 * regime that recovers input VAT; turnover tax and exemption both mean the tax
 * paid on a purchase is part of its cost.
 *
 * It is written ONCE, here, so that the flag and the regime cannot be set
 * independently by any caller — and migration 0017's CHECK is what guarantees
 * that even a caller bypassing this function cannot store a contradictory pair.
 */
export function vatRegisteredFor(regime: TenantTaxRegime): boolean {
  return regime === "VAT_REGISTERED";
}

/**
 * Read the singleton. Upserts the default on the vanishing chance a schema
 * predates the seed (a tenant provisioned between the migration and its seed
 * block): the DEFAULTS ARE THE MEANING OF "no row" — a business that has not told
 * us it is VAT-registered is treated as not registered, which is also exactly how
 * its existing ledger was built. So a caller never has to handle null, and no
 * posting path can be left guessing.
 */
export async function getBusinessProfile(
  db: TenantPrismaClient,
): Promise<BusinessProfileRow> {
  const existing = await db.businessProfile.findUnique({ where: { id: SINGLETON_ID } });
  if (existing !== null) {
    return toRow(existing);
  }
  const created = await db.businessProfile.upsert({
    where: { id: SINGLETON_ID },
    create: { id: SINGLETON_ID },
    update: {},
  });
  return toRow(created);
}

/**
 * Read the VAT status inside a transaction the caller already owns.
 *
 * This is the hot path: the inventory service calls it while posting a purchase
 * receipt, and it must see the same profile the rest of that transaction does. It
 * returns only the one boolean the posting branch needs, because handing a posting
 * path the whole profile invites it to start branching on fields it has no
 * business reading.
 *
 * A missing row reads as NOT REGISTERED rather than throwing. That default is the
 * safe one in a specific way: treating a non-registered business as registered
 * would recover input VAT it is not entitled to and understate inventory, whereas
 * the reverse merely declines a recovery the owner can enable by saying so.
 */
/**
 * The tenant's tax regime, read inside the caller's transaction (Task 3B.2 — the sale
 * path needs the regime itself, not just "is it VAT-registered", to know whether to
 * accrue Turnover Tax). It REFUSES rather than defaulting when the profile is missing:
 * accruing a tax on an ASSUMED regime would be a guess about the business's liability.
 */
export async function taxRegimeWithinTransaction(tx: LedgerTx): Promise<TenantTaxRegime> {
  const profile = await tx.businessProfile.findUnique({
    where: { id: SINGLETON_ID },
    select: { taxRegime: true },
  });
  if (profile === null) {
    throw new Error("This tenant has no business profile, so its tax regime is unknown; refusing to price tax on an assumption.");
  }
  return profile.taxRegime;
}

export async function isVatRegisteredWithinTransaction(tx: LedgerTx): Promise<boolean> {
  const profile = await tx.businessProfile.findUnique({
    where: { id: SINGLETON_ID },
    select: { isVatRegistered: true },
  });
  return profile?.isVatRegistered ?? false;
}

export interface UpdateBusinessProfileInput {
  taxRegime?: TenantTaxRegime;
  kraPin?: string | null;
  // Receipt / display identity (Task T-A13). null clears a field.
  legalName?: string | null;
  addressLine?: string | null;
  phone?: string | null;
  email?: string | null;
  receiptFooter?: string | null;
  showLogoOnReceipt?: boolean;
}

/** The profile columns an update writes, from an input — the regime pair kept together. */
function profileData(current: BusinessProfileRow, input: UpdateBusinessProfileInput) {
  const nextRegime = input.taxRegime ?? current.taxRegime;
  return {
    taxRegime: nextRegime,
    // Derived, never taken from the caller.
    isVatRegistered: vatRegisteredFor(nextRegime),
    ...(input.kraPin !== undefined ? { kraPin: input.kraPin } : {}),
    ...(input.legalName !== undefined ? { legalName: input.legalName } : {}),
    ...(input.addressLine !== undefined ? { addressLine: input.addressLine } : {}),
    ...(input.phone !== undefined ? { phone: input.phone } : {}),
    ...(input.email !== undefined ? { email: input.email } : {}),
    ...(input.receiptFooter !== undefined ? { receiptFooter: input.receiptFooter } : {}),
    ...(input.showLogoOnReceipt !== undefined ? { showLogoOnReceipt: input.showLogoOnReceipt } : {}),
  };
}

/** The registry's spelling of a BusinessProfile regime (public."TaxRegime"). */
export function registryTaxRegime(regime: TenantTaxRegime): "VAT" | "TURNOVER_TAX" | "EXEMPT" {
  return regime === "VAT_REGISTERED" ? "VAT" : regime;
}

/**
 * Update the profile.
 *
 * `isVatRegistered` is NOT a settable field: it is derived from `taxRegime` here
 * so the two can never be set independently, and the CHECK in 0017 backs that up.
 * Letting a caller supply both would make an inconsistent pair expressible in the
 * API even though the database would reject it — a 500 where there should be a
 * clear contract.
 *
 * THE CHANGE IS NOT RETROACTIVE, deliberately. It applies to receipts posted from
 * this moment on; stock already received keeps the cost it was received at.
 * Restating the cost of inventory that has already been sold and reported would
 * rewrite settled financial records, which the engineering ledger forbids — the correction for
 * a genuinely mis-stated past is an adjusting entry, not a silent re-posting.
 */
export async function updateBusinessProfile(
  db: TenantPrismaClient,
  input: UpdateBusinessProfileInput,
): Promise<BusinessProfileRow> {
  const current = await getBusinessProfile(db);
  const updated = await db.businessProfile.update({
    where: { id: SINGLETON_ID },
    data: profileData(current, input),
  });
  return toRow(updated);
}

/**
 * THE SETTINGS UPDATE, WITH THE REGISTRY MIRROR (Task T-A13 — the decision recorded under
 * "BusinessProfile" for the taxRegime duplication).
 *
 * BusinessProfile.taxRegime stays AUTHORITATIVE: the posting path reads it and nothing
 * else. public.tenants."taxRegime" is REGISTRY METADATA, kept TRUTHFUL by mirroring: when
 * the regime changes here, this tenant's OWN registry row is updated in the SAME database
 * transaction — the platform table is written through the tenant transaction's
 * connection, by the session's tenant id — so the two copies can never be seen
 * disagreeing, and admin or cohort views never show a stale regime. No posting path ever
 * reads the registry copy.
 */
export async function updateBusinessProfileMirrored(
  db: TenantPrismaClient,
  tenantId: string,
  input: UpdateBusinessProfileInput,
): Promise<BusinessProfileRow> {
  const current = await getBusinessProfile(db);
  const data = profileData(current, input);
  return db.$transaction(async (tx) => {
    const updated = await tx.businessProfile.update({ where: { id: SINGLETON_ID }, data });
    if (input.taxRegime !== undefined) {
      const mirrored = await tx.$executeRawUnsafe(
        `UPDATE public."tenants" SET "taxRegime" = $1::public."TaxRegime", "updatedAt" = now() WHERE "id" = $2`,
        registryTaxRegime(data.taxRegime),
        tenantId,
      );
      if (mirrored !== 1) {
        throw new Error(`Tax regime mirror: no registry row for tenant ${tenantId}.`);
      }
    }
    return toRow(updated);
  });
}
