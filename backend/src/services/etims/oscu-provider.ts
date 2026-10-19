// ===========================================================================
// REAL KRA eTIMS OSCU provider (Task 4.1) — the production seam.
//
// THIS IS THE PRODUCTION IMPLEMENTATION AND IT IS WRITTEN FOR REAL. It performs
// genuine HTTP calls to the tenant's own eTIMS endpoint, sends the real OSCU
// request bodies, and parses the real responses. It FABRICATES NOTHING: there is
// no synthesized receipt number, no invented signature, no placeholder QR. Every
// artifact it returns came from KRA, and when KRA returns nothing the result is a
// rejection or a connectivity failure — never a manufactured success.
//
// ACTIVATED BY CONFIG ALONE: ETIMS_PROVIDER=oscu plus the tenant's stored
// credentials. No code below the EtimsProvider interface changes.
//
// NOT NETWORK-TESTED IN THIS TASK, and that is stated plainly rather than
// implied. Reaching KRA requires a real tenant's onboarding pack — a live TIN, a
// device registered with KRA, and a cmcKey KRA issued — which by design this
// system never holds centrally (Angaza is not the integrator). What IS verified
// here is everything verifiable without KRA: the request shapes, the money
// conversion, the response parsing, and above all the REJECTION-vs-CONNECTIVITY
// classification, which is exercised end to end against the simulator through the
// identical persistence path.
//
// ---------------------------------------------------------------------------
// WHERE THE SECRETS GO, AND WHERE THEY DO NOT
//
// The cmcKey and the authToken travel in HTTP HEADERS. They are NEVER placed in
// the request body, because the body is persisted on the invoice row for audit —
// so keeping them out of it is what makes that audit trail safe to store. Neither
// is ever logged, and neither appears in any thrown message: an error quotes the
// STATUS and the response text, and the response text comes from KRA.
// ---------------------------------------------------------------------------
// ===========================================================================

import type { EtimsCredentialFields } from "../credentials/provider-schemas";
import { buildOscuSalesPayload } from "./simulated-provider";
import {
  EtimsInitError,
  isOscuSuccess,
  kraDateTime,
  type EtimsInitResult,
  type EtimsProvider,
  type EtimsSignRequest,
  type EtimsSignResult,
  type OscuResponseEnvelope,
} from "./provider";

/**
 * How long to wait for KRA before calling it unreachable. A till cannot hold a
 * customer indefinitely, and an invoice that times out is QUEUED and retried with
 * the same number — so a short timeout costs nothing and a long one costs the
 * cashier's shift.
 */
const REQUEST_TIMEOUT_MS = 20_000;

export class RealOscuProvider implements EtimsProvider {
  readonly name = "oscu" as const;

  async initializeDevice(creds: EtimsCredentialFields): Promise<EtimsInitResult> {
    const body = {
      tin: creds.tin,
      bhfId: creds.bhfId,
      dvcSrlNo: creds.dvcSrlNo,
    };

    let response: FetchOutcome;
    try {
      response = await this.post(creds, "/selectInitOsdcInfo", body, false);
    } catch (error) {
      // Unreachable. Initialization is operator-triggered with nobody at a till,
      // so there is nothing to queue — it fails loudly and honestly, flagged as a
      // connectivity problem rather than a KRA refusal.
      throw new EtimsInitError(
        `Could not reach eTIMS at ${creds.apiBaseUrl} to initialize the device: ${describeNetworkError(error)}. This is a connectivity problem, not a rejection by KRA — check the endpoint and try again.`,
        false,
      );
    }

    const envelope = parseEnvelope(response.text);
    if (envelope === null) {
      throw new EtimsInitError(
        `eTIMS returned a non-JSON response to selectInitOsdcInfo (HTTP ${response.status.toString()}). The endpoint may be wrong for this environment.`,
        true,
      );
    }
    if (!isOscuSuccess(envelope.resultCd)) {
      throw new EtimsInitError(
        `eTIMS refused device initialization: ${describeResult(envelope)}. Check the TIN, branch id and device serial number against the KRA onboarding pack.`,
        true,
      );
    }

    const cmcKey = extractCmcKey(envelope);
    if (cmcKey === null) {
      // KRA said success but gave no communication key. Refusing to proceed is
      // the only honest option: inventing or defaulting one would produce a
      // credential that silently fails to sign every later sale.
      throw new EtimsInitError(
        "eTIMS reported successful initialization but returned no communication key (cmcKey). Nothing was stored — without that key no invoice can be signed.",
        true,
      );
    }

    return { cmcKey, rawResponse: response.text };
  }

  async signInvoice(
    req: EtimsSignRequest,
    creds: EtimsCredentialFields,
  ): Promise<EtimsSignResult> {
    // The SAME payload builder the simulator uses, so the audited bytes and the
    // transmitted bytes are the same shape in both modes.
    const payload = buildOscuSalesPayload(req, creds);
    const submittedPayload = JSON.stringify(payload);

    // A device that was never initialized has no key to authenticate with. This
    // is a connectivity-class outcome rather than a rejection: KRA has not seen
    // the invoice and never refused it, so the invoice must be QUEUED (keeping its
    // number) rather than marked rejected and abandoned.
    if (creds.cmcKey === undefined || creds.cmcKey === "") {
      return {
        outcome: "CONNECTIVITY_FAILURE",
        resultMsg:
          "This eTIMS device has no communication key (cmcKey): it has not been initialized with KRA. Nothing was submitted. Run device initialization, then retry — the invoice keeps its allocated number.",
        submittedPayload,
        rawResponse: "",
      };
    }

    let response: FetchOutcome;
    try {
      response = await this.post(creds, "/saveTrnsSalesOsdc", payload, true);
    } catch (error) {
      // CONNECTIVITY FAILURE — and emphatically not a rejection. KRA has not seen
      // this invoice, so it keeps its number and is retried. Classifying this as
      // REJECTED would abandon an invoice KRA was always going to accept.
      return {
        outcome: "CONNECTIVITY_FAILURE",
        resultMsg: `Could not reach eTIMS: ${describeNetworkError(error)}. Nothing was submitted; the invoice keeps its number and will be retried.`,
        submittedPayload,
        rawResponse: "",
      };
    }

    // A 5xx means KRA's side is broken, not that our payload is wrong. Treating it
    // as a rejection would permanently abandon a perfectly good invoice because
    // KRA had an outage, so it is a connectivity failure and is retried.
    if (response.status >= 500) {
      return {
        outcome: "CONNECTIVITY_FAILURE",
        resultMsg: `eTIMS returned HTTP ${response.status.toString()} (a server-side fault, not a rejection of this invoice). It will be retried with the same number.`,
        submittedPayload,
        rawResponse: response.text,
      };
    }

    const envelope = parseEnvelope(response.text);
    if (envelope === null) {
      // Unparseable. We genuinely do not know whether KRA accepted it, and the
      // safe reading is "not signed, not refused": no artifacts exist, so the
      // invoice cannot be SIGNED, and KRA gave no refusal, so it is not REJECTED.
      // Queueing retries the same number, which is correct whether or not KRA saw
      // it — a duplicate number is rejected by KRA rather than double-filed.
      return {
        outcome: "CONNECTIVITY_FAILURE",
        resultMsg: `eTIMS returned an unparseable response (HTTP ${response.status.toString()}). Treated as not-yet-submitted and retried with the same number, since no signature was received.`,
        submittedPayload,
        rawResponse: response.text,
      };
    }

    if (!isOscuSuccess(envelope.resultCd)) {
      // REJECTED: KRA was reachable and refused. Never auto-retried.
      return {
        outcome: "REJECTED",
        resultCode: resultCodeOf(envelope),
        resultMsg: describeResult(envelope),
        submittedPayload,
        rawResponse: response.text,
      };
    }

    const artifacts = extractSignedArtifacts(envelope, req.invoiceNumber);
    if (artifacts === null) {
      // KRA said 000 but did not return a signature. We must NOT record this as
      // SIGNED: a signed invoice with no signature is a claim of compliance with
      // nothing behind it, and migration 0016's CHECK would refuse the row anyway.
      return {
        outcome: "REJECTED",
        resultCode: resultCodeOf(envelope),
        resultMsg:
          "eTIMS reported success but returned no receipt signature, so the invoice cannot be recorded as signed. Verify the device's status with KRA before resubmitting.",
        submittedPayload,
        rawResponse: response.text,
      };
    }

    return { outcome: "SIGNED", artifacts, submittedPayload, rawResponse: response.text };
  }

  /**
   * One POST. Built-in fetch, no new dependency, with an AbortSignal timeout so a
   * hanging endpoint becomes a connectivity failure rather than a stuck request.
   *
   * SECRETS GO IN HEADERS, never the body — see the file header.
   */
  private async post(
    creds: EtimsCredentialFields,
    path: string,
    body: unknown,
    includeCmcKey: boolean,
  ): Promise<FetchOutcome> {
    const url = `${creds.apiBaseUrl.replace(/\/+$/, "")}${path}`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      // KRA's OSCU gateway identifies the calling device on every request.
      tin: creds.tin,
      bhfId: creds.bhfId,
      dvcSrlNo: creds.dvcSrlNo,
      "x-request-time": kraDateTime(new Date()),
    };
    if (includeCmcKey && creds.cmcKey !== undefined && creds.cmcKey !== "") {
      headers["cmcKey"] = creds.cmcKey;
    }
    if (creds.authToken !== undefined && creds.authToken !== "") {
      headers["authorization"] = `Bearer ${creds.authToken}`;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { status: response.status, text: await response.text() };
  }
}

interface FetchOutcome {
  status: number;
  text: string;
}

function parseEnvelope(text: string): OscuResponseEnvelope | null {
  if (text.trim() === "") {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    return parsed as OscuResponseEnvelope;
  } catch {
    return null;
  }
}

function resultCodeOf(envelope: OscuResponseEnvelope): string {
  const code = envelope.resultCd;
  if (typeof code === "string" && code.trim() !== "") {
    return code.trim();
  }
  if (typeof code === "number") {
    return code.toString();
  }
  return "UNKNOWN";
}

function describeResult(envelope: OscuResponseEnvelope): string {
  const msg = typeof envelope.resultMsg === "string" ? envelope.resultMsg.trim() : "";
  return msg === ""
    ? `resultCd ${resultCodeOf(envelope)} with no message`
    : `[${resultCodeOf(envelope)}] ${msg}`;
}

/**
 * Describe a thrown fetch/abort error WITHOUT leaking anything configured. A
 * timeout surfaces as AbortError; everything else keeps its message, which for
 * network faults is the OS-level reason (ENOTFOUND, ECONNREFUSED) and contains no
 * credential.
 */
function describeNetworkError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return `no response within ${(REQUEST_TIMEOUT_MS / 1000).toString()}s`;
    }
    return error.message;
  }
  return String(error);
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (typeof value === "string" && value.trim() !== "") {
    return value.trim();
  }
  if (typeof value === "number") {
    return value.toString();
  }
  return null;
}

function dataObject(envelope: OscuResponseEnvelope): Record<string, unknown> | null {
  if (typeof envelope.data !== "object" || envelope.data === null) {
    return null;
  }
  return envelope.data as Record<string, unknown>;
}

/**
 * Pull the communication key out of selectInitOsdcInfo's response. KRA has
 * returned it both at `data.info.cmcKey` and at `data.cmcKey` across OSCU
 * revisions, so both are read — and neither is defaulted. No key means no
 * initialization (see the caller).
 */
function extractCmcKey(envelope: OscuResponseEnvelope): string | null {
  const data = dataObject(envelope);
  if (data === null) {
    return null;
  }
  const direct = readString(data, "cmcKey");
  if (direct !== null) {
    return direct;
  }
  const info = data["info"];
  if (typeof info === "object" && info !== null) {
    return readString(info as Record<string, unknown>, "cmcKey");
  }
  return null;
}

/**
 * Pull KRA's signing artifacts out of saveTrnsSalesOsdc's response.
 *
 * rcptSign and intrlData are the fiscal signature and are REQUIRED — without them
 * there is no signed invoice, and this returns null so the caller refuses to
 * record one. The receipt number falls back to KRA's `curRcptNo`/`rcptNo` and,
 * failing those, to the invoice number we submitted, because KRA's own numbering
 * echoes it; the QR url and timestamp are reconstructed only in the documented
 * KRA format when KRA omits them. NOTHING SIGNATURE-BEARING IS EVER SYNTHESIZED.
 */
function extractSignedArtifacts(
  envelope: OscuResponseEnvelope,
  submittedInvoiceNumber: number,
): import("./provider").EtimsSignedArtifacts | null {
  const data = dataObject(envelope);
  if (data === null) {
    return null;
  }
  const rcptSign = readString(data, "rcptSign");
  const intrlData = readString(data, "intrlData");
  if (rcptSign === null || intrlData === null) {
    return null;
  }

  const kraReceiptNumber =
    readString(data, "curRcptNo") ??
    readString(data, "rcptNo") ??
    submittedInvoiceNumber.toString();
  const sdcDateTime =
    readString(data, "vsdcRcptPbctDate") ??
    readString(data, "sdcDateTime") ??
    (typeof envelope.resultDt === "string" ? envelope.resultDt : kraDateTime(new Date()));
  const qrCodeUrl = readString(data, "qrCodeUrl") ?? "";

  return { kraReceiptNumber, rcptSign, intrlData, sdcDateTime, qrCodeUrl };
}
