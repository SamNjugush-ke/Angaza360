// ===========================================================================
// Simulated eTIMS provider (Task 4.1) — the development and test signer.
//
// It is NOT a stub and it does NOT fake a real signature's meaning. It is a
// deterministic LOCAL implementation that emits responses in KRA's OSCU WIRE
// SHAPE, so that every line of persistence, status mapping and retry logic in
// etims-signing.ts runs identically against the simulator and against KRA. The
// only thing that differs is who produced the bytes.
//
// Its "signature" is an HMAC over the invoice's own content, clearly marked
// SIM- so it can never be mistaken for a KRA artifact in a database or a report.
// That is the honest form of a simulator: deterministic, inspectable, and
// self-identifying — never a random string dressed up as fiscal evidence.
//
// ---------------------------------------------------------------------------
// STEERING THE OUTCOME (so the three paths are all testable)
//
// A test needs to exercise rejection and connectivity failure, not just success.
// Rather than a hidden env switch, the outcome is steered by MARKERS IN THE
// REQUEST ITSELF, which means a test states its intent in the data it sends:
//
//   customerPin starting "REJECT"  -> REJECTED (KRA reachable, payload refused)
//   customerPin starting "OFFLINE" -> CONNECTIVITY_FAILURE (KRA unreachable)
//   reason containing "[SIM:REJECT]" / "[SIM:OFFLINE]" -> the same, for credit
//                                     notes and for sales with no buyer PIN
//   ETIMS_SIM_OUTCOME=reject|offline -> a deployment-wide override, for driving a
//                                     whole scenario without touching the data
//
// Every marker is inert under the real provider: RealOscuProvider never reads
// them, so a stray test PIN cannot change production behaviour.
// ---------------------------------------------------------------------------
// ===========================================================================

import { createHmac } from "node:crypto";
import type { EtimsCredentialFields } from "../credentials/provider-schemas";
import {
  centsToKraAmount,
  kraDate,
  kraDateTime,
  OSCU_SUCCESS_CODE,
  type EtimsInitResult,
  type EtimsProvider,
  type EtimsSignRequest,
  type EtimsSignResult,
} from "./provider";

export type SimulatedOutcomeOverride = "sign" | "reject" | "offline";

export interface SimulatedEtimsOptions {
  /** Deployment-wide override, from ETIMS_SIM_OUTCOME. "sign" is the default. */
  readonly outcomeOverride: SimulatedOutcomeOverride;
}

export class SimulatedEtimsProvider implements EtimsProvider {
  readonly name = "simulated" as const;

  private readonly outcomeOverride: SimulatedOutcomeOverride;

  constructor(options: SimulatedEtimsOptions) {
    this.outcomeOverride = options.outcomeOverride;
  }

  async initializeDevice(creds: EtimsCredentialFields): Promise<EtimsInitResult> {
    // A deterministic key derived from the device's own identity, so the same
    // device always initializes to the same cmcKey and a test can re-run without
    // the stored credential appearing to change for no reason. SIM- prefixed, so
    // a simulated communication key is never mistaken for a KRA-issued one.
    const cmcKey = `SIM-CMC-${hmacHex(`${creds.tin}|${creds.bhfId}|${creds.dvcSrlNo}`, "cmc").slice(0, 32).toUpperCase()}`;

    const rawResponse = JSON.stringify({
      resultCd: OSCU_SUCCESS_CODE,
      resultMsg: "Successful",
      resultDt: kraDateTime(new Date()),
      data: {
        info: {
          tin: creds.tin,
          bhfId: creds.bhfId,
          dvcSrlNo: creds.dvcSrlNo,
          // The real selectInitOsdcInfo returns the communication key here. It is
          // echoed in the raw response exactly as KRA does, and the signing
          // service is what keeps it out of persistence — see the note there.
          cmcKey,
          sdcId: `SIM-SDC-${creds.bhfId}`,
          mrcNo: `SIM-MRC-${creds.dvcSrlNo}`,
        },
      },
    });

    return { cmcKey, rawResponse };
  }

  async signInvoice(
    req: EtimsSignRequest,
    creds: EtimsCredentialFields,
  ): Promise<EtimsSignResult> {
    // The payload is built by the SAME function the real provider uses, so the
    // simulator's stored audit payload has the shape KRA would have received.
    const submittedPayload = JSON.stringify(buildOscuSalesPayload(req, creds), null, 0);
    const outcome = this.decideOutcome(req);

    if (outcome === "offline") {
      return {
        outcome: "CONNECTIVITY_FAILURE",
        resultMsg:
          "Simulated connectivity failure: eTIMS could not be reached. The invoice keeps its allocated number and will be retried.",
        submittedPayload,
        rawResponse: JSON.stringify({
          error: "SIMULATED_NETWORK_UNREACHABLE",
          detail: "No response from the eTIMS endpoint.",
        }),
      };
    }

    if (outcome === "reject") {
      const rawResponse = JSON.stringify({
        resultCd: "894",
        resultMsg: "Invalid buyer PIN / item classification (simulated rejection)",
        resultDt: kraDateTime(new Date()),
        data: null,
      });
      return {
        outcome: "REJECTED",
        resultCode: "894",
        resultMsg: "Invalid buyer PIN / item classification (simulated rejection)",
        submittedPayload,
        rawResponse,
      };
    }

    // SIGNED. Every artifact is derived from the invoice's own content, so it is
    // reproducible and verifiable locally, and is SIM-marked so it can never pass
    // as a KRA artifact.
    const basis = `${creds.tin}|${creds.bhfId}|${req.invoiceNumber.toString()}|${req.invoiceType}|${req.total.toString()}`;
    const sdcDateTime = kraDateTime(new Date());
    const rcptSign = `SIM${hmacHex(basis, "sign").slice(0, 16).toUpperCase()}`;
    const intrlData = `SIM${hmacHex(basis, "intrl").slice(0, 16).toUpperCase()}`;
    const kraReceiptNumber = `SIM-${kraDate(req.salesDate)}-${req.invoiceNumber.toString().padStart(8, "0")}`;
    // The real OSCU QR verification URL shape, with SIM- marked data so following
    // it could never be mistaken for verifying a genuine invoice.
    const qrCodeUrl =
      `https://etims-sbx.kra.go.ke/common/link/etimsControllerApiSimulator/indexEtimsData` +
      `?Data=SIM-${creds.tin}${creds.bhfId}${rcptSign}`;

    const rawResponse = JSON.stringify({
      resultCd: OSCU_SUCCESS_CODE,
      resultMsg: "Successful",
      resultDt: sdcDateTime,
      data: {
        rcptNo: req.invoiceNumber,
        intrlData,
        rcptSign,
        vsdcRcptPbctDate: sdcDateTime,
        sdcId: `SIM-SDC-${creds.bhfId}`,
        mrcNo: `SIM-MRC-${creds.dvcSrlNo}`,
        curRcptNo: req.invoiceNumber,
        totRcptNo: req.invoiceNumber,
        qrCodeUrl,
      },
    });

    return {
      outcome: "SIGNED",
      artifacts: { kraReceiptNumber, rcptSign, intrlData, sdcDateTime, qrCodeUrl },
      submittedPayload,
      rawResponse,
    };
  }

  /**
   * Request markers first, deployment override second. Request markers win so a
   * single scenario can mix signed and failing invoices in one run, which is what
   * the acceptance tests need.
   */
  private decideOutcome(req: EtimsSignRequest): SimulatedOutcomeOverride {
    const pin = req.customerPin ?? "";
    const reason = req.reason ?? "";
    if (pin.toUpperCase().startsWith("REJECT") || reason.includes("[SIM:REJECT]")) {
      return "reject";
    }
    if (pin.toUpperCase().startsWith("OFFLINE") || reason.includes("[SIM:OFFLINE]")) {
      return "offline";
    }
    return this.outcomeOverride;
  }
}

function hmacHex(basis: string, purpose: string): string {
  // A FIXED simulator key, deliberately: these artifacts must be reproducible
  // across restarts, and there is nothing to protect — a simulated signature
  // proves nothing and is marked as such. It is never the credential key.
  return createHmac("sha256", `angaza-etims-simulator-${purpose}`).update(basis).digest("hex");
}

/**
 * Build the OSCU saveTrnsSalesOsdc request body.
 *
 * SHARED BY BOTH PROVIDERS, deliberately. The simulator persists the same
 * payload shape KRA would receive, so the audit trail written in development is
 * the audit trail written in production, and a payload bug shows up in testing
 * instead of at go-live.
 *
 * IT CARRIES NO SECRET. tin/bhfId/dvcSrlNo are identity, not credentials; the
 * cmcKey and authToken travel in the HTTP HEADERS (see oscu-provider.ts) and
 * never in this body — which is what makes it safe to persist on the invoice row
 * for audit.
 */
export function buildOscuSalesPayload(
  req: EtimsSignRequest,
  creds: EtimsCredentialFields,
): Record<string, unknown> {
  const isCreditNote = req.invoiceType === "CREDIT_NOTE";

  // THE HEADER TOTALS BY TAX TYPE (Task 3B.1), summed from the code each line was
  // charged under. KRA's header declares taxable amount, rate and tax per category;
  // before 3B.1 this declared the whole sale as B, which would have mis-filed every
  // zero-rated, exempt or non-VAT line. E (the deleted 8% rate) is always zero. The
  // B rate is the one the sale's B lines actually applied — never a constant here.
  const byCode = { A: { taxable: 0n, tax: 0n }, B: { taxable: 0n, tax: 0n }, C: { taxable: 0n, tax: 0n }, D: { taxable: 0n, tax: 0n } };
  let standardRate = "0";
  for (const line of req.lines) {
    byCode[line.taxCode].taxable += line.lineNet;
    byCode[line.taxCode].tax += line.lineVat;
    if (line.taxCode === "B") {
      standardRate = line.vatRate;
    }
  }

  return {
    tin: creds.tin,
    bhfId: creds.bhfId,
    invcNo: req.invoiceNumber,
    // KRA's "original invoice number": 0 for a sale, the reversed invoice for a
    // credit note.
    orgInvcNo: req.originalInvoiceNumber ?? 0,
    custTin: req.customerPin,
    custNm: req.customerName,
    // S = sale, R = credit note (refund) in KRA's receipt typing.
    rcptTyCd: isCreditNote ? "R" : "S",
    // N = normal transaction; C = copy. Always normal here.
    pmtTyCd: "01",
    salesSttsCd: isCreditNote ? "05" : "02",
    cfmDt: kraDateTime(req.salesDate),
    salesDt: kraDate(req.salesDate),
    totItemCnt: req.lines.length,
    taxblAmtA: centsToKraAmount(byCode.A.taxable),
    taxblAmtB: centsToKraAmount(byCode.B.taxable),
    taxblAmtC: centsToKraAmount(byCode.C.taxable),
    taxblAmtD: centsToKraAmount(byCode.D.taxable),
    taxblAmtE: "0.00",
    taxRtA: "0",
    taxRtB: standardRate,
    taxRtC: "0",
    taxRtD: "0",
    taxRtE: "0",
    taxAmtA: centsToKraAmount(byCode.A.tax),
    taxAmtB: centsToKraAmount(byCode.B.tax),
    taxAmtC: centsToKraAmount(byCode.C.tax),
    taxAmtD: centsToKraAmount(byCode.D.tax),
    taxAmtE: "0.00",
    totTaxblAmt: centsToKraAmount(req.subtotal),
    totTaxAmt: centsToKraAmount(req.vatTotal),
    totAmt: centsToKraAmount(req.total),
    prchrAcptcYn: "N",
    remark: req.reason ?? null,
    regrId: req.saleNumber,
    regrNm: req.saleNumber,
    modrId: req.saleNumber,
    modrNm: req.saleNumber,
    receipt: {
      custTin: req.customerPin,
      custMblNo: null,
      rptNo: req.invoiceNumber,
      trdInvcNo: req.saleNumber,
      rcptPbctDt: kraDateTime(req.salesDate),
      intrlData: null,
      rcptSign: null,
    },
    itemList: req.lines.map((line) => ({
      itemSeq: line.lineNumber,
      itemCd: line.itemCode,
      itemClsCd: "5059690800",
      itemNm: line.description,
      pkgUnitCd: "NT",
      pkg: 1,
      qtyUnitCd: "U",
      qty: line.quantity,
      prc: centsToKraAmount(line.unitPrice),
      splyAmt: centsToKraAmount(line.lineNet),
      dcRt: "0",
      dcAmt: centsToKraAmount(line.discount),
      taxTyCd: line.taxCode,
      taxblAmt: centsToKraAmount(line.lineNet),
      taxAmt: centsToKraAmount(line.lineVat),
      totAmt: centsToKraAmount(line.lineTotal),
    })),
  };
}
