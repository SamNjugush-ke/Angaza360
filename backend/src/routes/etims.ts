// ===========================================================================
// KRA eTIMS routes (Module 9, Task 4.1).
//
// These routes authorise and delegate. Every write goes through
// src/services/etims/etims-signing.ts, which is the sole writer of the eTIMS
// tables and the sole flipper of Sale.fiscalStatus — and which writes no journal
// table, no stock table, and posts nothing to the ledger.
//
// NO SECRET APPEARS ON THIS SURFACE. The cmcKey and the authToken live in the
// tenant's encrypted credential blob and are returned by nothing here: the
// initialize route reports only THAT a key was stored. The credential itself is
// managed through /v1/integrations (owner-only), where secrets are write-only.
//
// eTIMS IS OPT-IN AND THE MINORITY CASE. Every route here is for the sales a
// customer actually wanted a KRA invoice for; the ordinary informal sale never
// touches any of them.
// ===========================================================================

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  EtimsNotConfiguredError,
  EtimsStateError,
  EtimsValidationError,
  getDevice,
  getInvoice,
  initializeDevice,
  listInvoices,
  retryInvoice,
  signCreditNote,
  signSaleInvoice,
} from "../services/etims/etims-signing";
import { EtimsDisabledError } from "../services/etims/factory";
import {
  CredentialValidationError,
} from "../services/credentials/provider-schemas";
import { NoActiveCredentialError } from "../services/credentials/credential-store";
import {
  zEtimsDevice,
  zEtimsInitResult,
  zEtimsInvoice,
  zEtimsInvoiceStatus,
  zEtimsInvoiceType,
  zEtimsSignResult,
} from "../schemas/models";
import {
  badRequest,
  conflict,
  errorBody,
  errorResponses,
  notFound,
  SECURE,
  zIdParam,
} from "../schemas/common";

const zSaleIdParam = z.object({
  saleId: z.string().min(1).meta({ description: "The sale to file with KRA." }),
});

const zCreditNoteBody = z.object({
  reason: z.string().trim().min(1, "reason is required.").meta({
    description:
      "Why the sale is being reversed. KRA records it, and a credit note without a reason is unfileable.",
  }),
});

// Whether a tenant can sign, whether a device is initialized, and whether KRA
// accepted a payload all depend on stored state and on a remote party — never on
// the shape of the request — so they stay in the service and surface here.
function sendEtimsError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof EtimsStateError) {
    return reply.code(409).send(conflict(error.message));
  }
  if (
    error instanceof EtimsNotConfiguredError ||
    error instanceof EtimsDisabledError ||
    error instanceof EtimsValidationError ||
    error instanceof NoActiveCredentialError ||
    error instanceof CredentialValidationError
  ) {
    return reply.code(400).send(badRequest(error.message));
  }
  throw error;
}

export async function etimsRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const base = [app.requireAuth, app.requireTenant];

  // Initializing the device commits the business to filing under its own KRA PIN
  // and writes a secret into the credential store. That is an owner's decision.
  const ownerOnly = app.requireRole("MSME_OWNER");
  // Signing a sale is a till action: whoever served the customer asking for a KRA
  // invoice must be able to produce one.
  const signRoles = app.requireRole("MSME_OWNER", "MSME_MANAGER", "ACCOUNTANT", "CASHIER");
  // Resubmitting after a KRA rejection is an accounting correction.
  const retryRoles = app.requireRole("MSME_OWNER", "ACCOUNTANT");
  const readRoles = app.requireRole(
    "MSME_OWNER",
    "MSME_MANAGER",
    "ACCOUNTANT",
    "VIEWER_AUDITOR",
  );
  const deviceReadRoles = app.requireRole("MSME_OWNER", "ACCOUNTANT");

  // --- Device ---------------------------------------------------------------

  api.route({
    method: "POST",
    url: "/device/initialize",
    preHandler: [...base, ownerOnly],
    schema: {
      tags: ["eTIMS"],
      summary: "Initialize this tenant's OSCU device with KRA",
      description:
        "Calls KRA's `selectInitOsdcInfo(tin, bhfId, dvcSrlNo)` and stores the **communication key (cmcKey)** it returns back into this tenant's own encrypted credential blob. Every later invoice carries that key.\n\n" +
        "**STATEFUL AND OCCASIONAL** — run at setup, or when a key expires. It is never part of signing a sale.\n\n" +
        "**The key is never returned.** The response reports only that it was stored; the secret stays in the credential store, as every secret in this system does.\n\n" +
        "**Angaza is never the KRA integrator.** The TIN, branch and device serial all come from THIS tenant's credentials, stored under `/v1/integrations/ETIMS` — there is no Angaza-level eTIMS credential and no shared signer. **400** if the tenant has not stored active credentials, or if KRA refuses or cannot be reached.",
      security: SECURE,
      response: { 200: zEtimsInitResult, ...errorResponses(400, 401, 403) },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null) {
        return reply.code(401).send(errorBody(401, "Unauthorized", "Authentication required."));
      }
      try {
        const result = await initializeDevice(request.tenantDb, auth.userId);
        request.log.info(
          {
            userId: auth.userId,
            // The device identity is logged; the key it returned is NOT, and never is.
            tin: result.device.tin,
            bhfId: result.device.bhfId,
            environment: result.environment,
          },
          "eTIMS device initialized",
        );
        return reply.code(200).send(result);
      } catch (error) {
        return sendEtimsError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/device",
    preHandler: [...base, deviceReadRoles],
    schema: {
      tags: ["eTIMS"],
      summary: "This tenant's eTIMS device and its invoice counter",
      description:
        "The device's non-secret identity, whether it has been initialized, and the last invoice number it issued. **404** when the tenant has never initialized a device — which is the normal state for a business that does not use eTIMS.",
      security: SECURE,
      response: { 200: zEtimsDevice, ...errorResponses(401, 403, 404) },
    },
    handler: async (request, reply) => {
      const device = await getDevice(request.tenantDb);
      if (device === null) {
        return reply
          .code(404)
          .send(
            notFound(
              "No eTIMS device has been initialized for this tenant. Sales finalize normally without one; initialize a device only if the business files KRA invoices.",
            ),
          );
      }
      return reply.code(200).send(device);
    },
  });

  // --- Signing --------------------------------------------------------------

  api.route({
    method: "POST",
    url: "/sales/:saleId/sign",
    preHandler: [...base, signRoles],
    schema: {
      tags: ["eTIMS"],
      summary: "File a sale with KRA (opt-in, per sale)",
      description:
        "Signs ONE already-committed sale. Use it when a customer asks for a KRA invoice after the fact; the POS route's `requestEtims` flag does the same thing at the till.\n\n" +
        "**POST-COMMIT, ALWAYS.** The sale is already final — this can never alter its stock, its ledger entries or its totals, and it posts NOTHING to the ledger: the VAT was posted at sale time, and a fiscal invoice is an attestation, not a financial event. The only field it changes on the sale is `fiscalStatus`.\n\n" +
        "**The three outcomes, which are deliberately distinct:**\n" +
        "* **SIGNED** — KRA signed it. The receipt number, signature and QR are fiscal fact and are now immutable.\n" +
        "* **REJECTED** (`fiscalStatus` FAILED) — KRA was REACHABLE and refused the payload. **Never auto-retried**: retrying what KRA already refused just refuses again. Fix the cause and use `/invoices/:id/retry`.\n" +
        "* **QUEUED** (`fiscalStatus` PENDING_ETIMS) — KRA was UNREACHABLE. The invoice KEEPS its allocated number and is retried later. Reallocating a number would file the sale with KRA twice.\n\n" +
        "**Idempotent:** a sale that already has a SIGNED invoice returns it untouched. A sale is filed once.\n\n" +
        "**400** if the tenant has no active eTIMS credentials, if the device is not initialized, or if the sale is VOIDED (a sale that did not happen must not be declared).",
      security: SECURE,
      params: zSaleIdParam,
      response: { 200: zEtimsSignResult, ...errorResponses(400, 401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null) {
        return reply.code(401).send(errorBody(401, "Unauthorized", "Authentication required."));
      }
      try {
        const result = await signSaleInvoice(request.tenantDb, request.params.saleId, auth.userId);
        return reply.code(200).send(result);
      } catch (error) {
        if (error instanceof EtimsValidationError && /^Unknown sale/.test(error.message)) {
          return reply.code(404).send(notFound(error.message));
        }
        return sendEtimsError(reply, error);
      }
    },
  });

  api.route({
    method: "POST",
    url: "/sales/:saleId/credit-note",
    preHandler: [...base, retryRoles],
    schema: {
      tags: ["eTIMS"],
      summary: "File the credit note that reverses a SIGNED sale",
      description:
        "The fiscal reversal of a sale KRA has already accepted, referencing the original invoice — KRA requires a credit note to come from the same solution that filed the sale.\n\n" +
        "Voiding a signed sale RECORDS this obligation automatically and atomically with the void (see `POST /v1/pos/sales/:id/void`), because a refund must never wait on KRA being reachable. This route is what DISCHARGES it, and it may also be called directly.\n\n" +
        "**409** unless the original sale invoice is SIGNED: there is nothing to reverse if KRA never accepted the sale, and an unsigned invoice is corrected by fixing and resubmitting it instead.\n\n" +
        "A credit note never downgrades the sale's `fiscalStatus`: the sale IS signed, permanently. The reversal is its own fiscal record.",
      security: SECURE,
      params: zSaleIdParam,
      body: zCreditNoteBody,
      response: {
        200: z.object({ invoice: zEtimsInvoice, providerName: z.string() }),
        ...errorResponses(400, 401, 403, 404, 409),
      },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null) {
        return reply.code(401).send(errorBody(401, "Unauthorized", "Authentication required."));
      }
      try {
        const result = await signCreditNote(
          request.tenantDb,
          request.params.saleId,
          request.body.reason,
          auth.userId,
        );
        return reply.code(200).send(result);
      } catch (error) {
        if (error instanceof EtimsValidationError && /^Unknown sale/.test(error.message)) {
          return reply.code(404).send(notFound(error.message));
        }
        return sendEtimsError(reply, error);
      }
    },
  });

  // --- The failed-invoice dashboard ----------------------------------------

  api.route({
    method: "GET",
    url: "/invoices",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["eTIMS"],
      summary: "List fiscal invoices (the operator's dashboard)",
      description:
        "Newest first. **This is the failed-invoice dashboard**, and the two failure filters mean different things and need different actions:\n\n" +
        "* `?status=REJECTED` — KRA was reachable and refused these. Each carries KRA's own `resultCode` and `resultMsg`. **An operator must fix the cause and resubmit**; nothing retries them automatically, by design.\n" +
        "* `?status=QUEUED` — KRA was unreachable. These are retried automatically (`npm run etims:retry`) with the numbers they already hold, and usually clear themselves.\n" +
        "* `?status=FAILED` — connectivity retries were exhausted. These need an operator too.\n\n" +
        "Nothing in any of these lists has affected the books: every one of these sales is committed, correct and final, with its VAT already posted. What is outstanding is the attestation to KRA.",
      security: SECURE,
      querystring: z.object({
        status: zEtimsInvoiceStatus.optional(),
        invoiceType: zEtimsInvoiceType.optional(),
        saleId: z.string().min(1).optional(),
      }),
      response: {
        200: z.object({ data: z.array(zEtimsInvoice), count: z.number().int() }),
        ...errorResponses(400, 401, 403),
      },
    },
    handler: async (request, reply) => {
      const { status, invoiceType, saleId } = request.query;
      const data = await listInvoices(request.tenantDb, {
        ...(status !== undefined ? { status } : {}),
        ...(invoiceType !== undefined ? { invoiceType } : {}),
        ...(saleId !== undefined ? { saleId } : {}),
      });
      return reply.code(200).send({ data, count: data.length });
    },
  });

  api.route({
    method: "GET",
    url: "/invoices/:id",
    preHandler: [...base, readRoles],
    schema: {
      tags: ["eTIMS"],
      summary: "Get one fiscal invoice",
      description:
        "Includes KRA's artifacts when SIGNED, and KRA's rejection code and message when REJECTED. The submitted payload and raw response are held for audit but are not returned here.",
      security: SECURE,
      params: zIdParam,
      response: { 200: zEtimsInvoice, ...errorResponses(401, 403, 404) },
    },
    handler: async (request, reply) => {
      const invoice = await getInvoice(request.tenantDb, request.params.id);
      if (invoice === null) {
        return reply.code(404).send(notFound(`No eTIMS invoice with id "${request.params.id}".`));
      }
      return reply.code(200).send(invoice);
    },
  });

  api.route({
    method: "POST",
    url: "/invoices/:id/retry",
    preHandler: [...base, retryRoles],
    schema: {
      tags: ["eTIMS"],
      summary: "Resubmit an unsigned invoice",
      description:
        "The operator's \"I fixed the cause, try again\" action behind a REJECTED row, and the manual push behind a QUEUED one. Also how a recorded credit-note obligation is discharged.\n\n" +
        "**IT KEEPS THE INVOICE'S EXISTING NUMBER.** That is the no-double-file guarantee: if KRA never received the original submission it files now, and if KRA did receive it, KRA rejects the duplicate number and we learn the truth. Taking a fresh number would file the same sale twice under two numbers and overstate the tenant's declared revenue.\n\n" +
        "**409** if the invoice is already SIGNED — a signed invoice is a permanent fiscal record and cannot be resubmitted. Reverse it with a credit note if it was wrong.",
      security: SECURE,
      params: zIdParam,
      response: { 200: zEtimsInvoice, ...errorResponses(400, 401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      try {
        const invoice = await retryInvoice(request.tenantDb, request.params.id);
        return reply.code(200).send(invoice);
      } catch (error) {
        if (error instanceof EtimsValidationError && /^Unknown eTIMS invoice/.test(error.message)) {
          return reply.code(404).send(notFound(error.message));
        }
        return sendEtimsError(reply, error);
      }
    },
  });
}
