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

import {
  MpesaCallbackAuthError,
  parseDarajaEnvelope,
  type MpesaCallback,
  type MpesaCallbackParser,
  type MpesaProvider,
  type StkPushRequest,
  type StkPushResult,
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
      `M-Pesa cannot charge cents: amount ${amountCents.toString()} is not a whole shilling.`,
    );
  }
  return Number(amountCents / 100n);
}

function darajaTimestamp(now: Date): string {
  const p = (n: number, width = 2): string => n.toString().padStart(width, "0");
  return (
    `${now.getUTCFullYear()}` +
    `${p(now.getUTCMonth() + 1)}` +
    `${p(now.getUTCDate())}` +
    `${p(now.getUTCHours())}` +
    `${p(now.getUTCMinutes())}` +
    `${p(now.getUTCSeconds())}`
  );
}

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
}
