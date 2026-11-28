// ===========================================================================
// Daraja (real Safaricom) M-Pesa provider (Task 3.3; made per-tenant in 3.4).
// PRODUCTION SEAM — this is activated purely by config (MPESA_PROVIDER=daraja +
// the tenant's activated credential row; see factory.ts). It is
// written for real using the built-in fetch (Node 20+); it is NOT exercised
// against the network in this task's tests (no credentials), but it must be
// correct by inspection. No fake signatures, no mocked receipts.
//
// Authenticity (honest story): Daraja does NOT sign its callbacks. Security
// comes from (1) the callback URL carrying an unguessable path secret and the
// tenant slug (both server-generated — see routes), and (2) the service matching
// CheckoutRequestID against a known INITIATED transaction (an unknown id is
// rejected). parseAndVerifyCallback therefore validates STRUCTURE only; the real
// authenticity check (unknown checkoutRequestId => reject) lives in the service.
// ===========================================================================

import { businessDateTimeParts } from "../../lib/business-time";
import { formatCentsKes } from "../../lib/money";
import {
  MpesaCallbackAuthError,
  parseDarajaEnvelope,
  type MpesaCallback,
  type MpesaCallbackParser,
  type MpesaProvider,
  type ProviderProbeResult,
  type StkPushRequest,
  type StkPushResult,
  type StkQueryResult,
} from "./provider";

// Everything this provider needs for ONE tenant, for ONE environment (Task
// 3.4). The four secret-bearing fields come from that tenant's encrypted
// credential row; baseUrl is derived from the tenant's active environment and
// callbackUrl is server-generated per tenant. There is no process-wide Daraja
// credential anywhere in the system any more: under Option A a tenant's sales
// settle to that tenant's own shortcode.
export interface DarajaCredentials {
  readonly baseUrl: string;
  readonly consumerKey: string;
  readonly consumerSecret: string;
  readonly passkey: string;
  readonly shortcode: string;
  readonly callbackUrl: string;
}

interface OAuthResponse {
  access_token: string;
  expires_in: string;
}

interface StkPushResponse {
  MerchantRequestID?: string;
  CheckoutRequestID?: string;
  ResponseCode?: string;
  ResponseDescription?: string;
  errorCode?: string;
  errorMessage?: string;
}

// Daraja Amount is WHOLE SHILLINGS (integer KES); M-Pesa cannot charge cents.
// Convert cents -> shillings, rejecting a non-whole-shilling amount.
function centsToWholeShillings(amountCents: bigint): number {
  if (amountCents <= 0n) {
    throw new Error("STK amount must be positive.");
  }
  if (amountCents % 100n !== 0n) {
    throw new Error(
      `M-Pesa cannot charge cents: ${formatCentsKes(amountCents)} is not a whole shilling.`,
    );
  }
  return Number(amountCents / 100n);
}

/**
 * Daraja's `Timestamp` (YYYYMMDDHHmmss), which also seeds the request Password. Safaricom
 * documents it as LOCAL time — East Africa Time — so it is read from the business wall
 * clock (src/lib/business-time.ts), never from UTC parts. RESOLVES the H.1 watch item: the
 * UTC form read three hours behind EAT.
 */
export function darajaTimestamp(now: Date): string {
  const p = (n: number): string => n.toString().padStart(2, "0");
  const t = businessDateTimeParts(now);
  return `${t.year.toString()}${p(t.month)}${p(t.day)}${p(t.hour)}${p(t.minute)}${p(t.second)}`;
}

interface StkQueryResponse {
  ResponseCode?: string;
  ResultCode?: string | number;
  ResultDesc?: string;
  errorCode?: string;
  errorMessage?: string;
}

/** Daraja's "still being processed" answer to an STK query. */
const DARAJA_STILL_PROCESSING = "500.001.1001";

// Callback parsing needs NO credentials (Task 3.4) — it is pure shape work on
// Daraja's wire format. It lives in its own class so the public webhook can
// parse an inbound callback before any tenant (and therefore any credential)
// has been resolved, exactly as it did in 3.3.
export class DarajaCallbackParser implements MpesaCallbackParser {
  readonly name = "daraja" as const;

  parseAndVerifyCallback(rawBody: unknown): MpesaCallback {
    // Structural validation only — Daraja does not sign callbacks. The unknown-
    // checkoutRequestId rejection (the real authenticity gate) is in the service.
    try {
      return parseDarajaEnvelope(rawBody);
    } catch (error) {
      if (error instanceof MpesaCallbackAuthError) {
        throw error;
      }
      throw new MpesaCallbackAuthError(
        error instanceof Error ? error.message : "Malformed Daraja callback.",
      );
    }
  }
}

export class DarajaMpesaProvider extends DarajaCallbackParser implements MpesaProvider {
  private readonly config: DarajaCredentials;

  constructor(config: DarajaCredentials) {
    super();
    this.config = config;
  }

  private async fetchAccessToken(): Promise<string> {
    const basic = Buffer.from(
      `${this.config.consumerKey}:${this.config.consumerSecret}`,
    ).toString("base64");
    const response = await fetch(
      `${this.config.baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
      { method: "GET", headers: { Authorization: `Basic ${basic}` } },
    );
    if (!response.ok) {
      throw new Error(`Daraja OAuth failed with HTTP ${response.status}.`);
    }
    const body = (await response.json()) as OAuthResponse;
    if (typeof body.access_token !== "string" || body.access_token === "") {
      throw new Error("Daraja OAuth response missing access_token.");
    }
    return body.access_token;
  }

  async initiateStkPush(req: StkPushRequest): Promise<StkPushResult> {
    const amountShillings = centsToWholeShillings(req.amountCents);
    const token = await this.fetchAccessToken();

    const timestamp = darajaTimestamp(new Date());
    const password = Buffer.from(
      `${this.config.shortcode}${this.config.passkey}${timestamp}`,
    ).toString("base64");

    const response = await fetch(
      `${this.config.baseUrl}/mpesa/stkpush/v1/processrequest`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          BusinessShortCode: this.config.shortcode,
          Password: password,
          Timestamp: timestamp,
          TransactionType: "CustomerPayBillOnline",
          Amount: amountShillings,
          PartyA: req.phoneNumber,
          PartyB: this.config.shortcode,
          PhoneNumber: req.phoneNumber,
          CallBackURL: this.config.callbackUrl,
          AccountReference: req.accountReference,
          TransactionDesc: req.description,
        }),
      },
    );

    const body = (await response.json()) as StkPushResponse;
    if (!response.ok || body.ResponseCode !== "0") {
      const detail = body.errorMessage ?? body.ResponseDescription ?? `HTTP ${response.status}`;
      throw new Error(`Daraja STK Push failed: ${detail}`);
    }
    if (typeof body.CheckoutRequestID !== "string" || body.CheckoutRequestID === "") {
      throw new Error("Daraja STK Push response missing CheckoutRequestID.");
    }

    return {
      merchantRequestId: typeof body.MerchantRequestID === "string" ? body.MerchantRequestID : null,
      checkoutRequestId: body.CheckoutRequestID,
    };
  }

  // STK Push Query (T-B2): what became of a push whose callback never arrived.
  async queryStkStatus(checkoutRequestId: string): Promise<StkQueryResult> {
    const token = await this.fetchAccessToken();
    const timestamp = darajaTimestamp(new Date());
    const password = Buffer.from(`${this.config.shortcode}${this.config.passkey}${timestamp}`).toString("base64");
    const response = await fetch(`${this.config.baseUrl}/mpesa/stkpushquery/v1/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        BusinessShortCode: this.config.shortcode,
        Password: password,
        Timestamp: timestamp,
        CheckoutRequestID: checkoutRequestId,
      }),
    });
    const body = (await response.json()) as StkQueryResponse;
    if (body.errorCode === DARAJA_STILL_PROCESSING) {
      return { kind: "PENDING", resultCode: null, resultDesc: body.errorMessage ?? "The transaction is being processed." };
    }
    if (!response.ok || body.ResponseCode !== "0" || body.ResultCode === undefined) {
      throw new Error(`Daraja STK query failed: ${body.errorCode ?? `HTTP ${response.status.toString()}`}.`);
    }
    const resultCode = Number(body.ResultCode);
    if (!Number.isInteger(resultCode)) {
      throw new Error("Daraja STK query returned a non-numeric ResultCode.");
    }
    return { kind: resultCode === 0 ? "SUCCESS" : "FAILED", resultCode, resultDesc: body.ResultDesc ?? "" };
  }

  // Credential probe (T-B1): an OAuth token proves the consumer key and secret. It moves
  // no money and pushes nothing to any phone.
  async verifyCredentials(): Promise<ProviderProbeResult> {
    await this.fetchAccessToken();
    return { ok: true, detail: "Daraja accepted the consumer key and secret." };
  }
}
