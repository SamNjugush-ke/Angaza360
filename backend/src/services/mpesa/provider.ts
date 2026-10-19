// ===========================================================================
// M-Pesa provider interface (Task 3.3). The provider owns EXACTLY two
// provider-specific concerns: the outbound STK Push, and callback authenticity
// + parsing into a normalized shape. Everything else — idempotency, tender
// confirmation, ledger posting — is provider-agnostic and lives in payment.ts.
//
// Two implementations select by env (MPESA_PROVIDER): SimulatedMpesaProvider
// (default, dev) and DarajaMpesaProvider (real Safaricom). Switching to real
// Daraja is a CONFIG change only; no code below the interface changes.
//
// TASK 3.4: the interface is UNCHANGED in what it does. What changed is where
// a real implementation gets its credentials — the tenant's encrypted
// credential store, per request, instead of process-wide env. Nothing that
// depends on this interface (reconciliation, idempotency, ledger posting) knows
// or cares.
// ===========================================================================

export interface StkPushRequest {
  // checkoutRequestId is NOT passed in — the provider mints and returns it.
  phoneNumber: string;
  amountCents: bigint;
  accountReference: string;
  description: string;
}

export interface StkPushResult {
  merchantRequestId: string | null;
  checkoutRequestId: string; // correlation id used to match the callback
}

// Normalized, provider-agnostic callback. Both providers parse their raw
// (Daraja-shaped) payload into this one shape, which is all payment.ts ever sees.
export interface MpesaCallback {
  checkoutRequestId: string;
  merchantRequestId: string | null;
  resultCode: number; // 0 = success
  resultDesc: string;
  mpesaReceiptNumber: string | null;
  amountCents: bigint | null;
  phoneNumber: string | null;
  rawJson: string;
}

// The provider's two concerns are split because they have different
// prerequisites (Task 3.4). Verifying and parsing an INBOUND callback needs no
// credentials at all — it is pure shape work on the provider's wire format.
// Pushing an OUTBOUND STK needs the tenant's credentials. Separating them is
// what lets the webhook parse a callback before it has resolved a tenant (and
// therefore before any credential exists to load), exactly as it did in 3.3,
// while the outbound side became per-tenant.
export interface MpesaCallbackParser {
  // Verify a raw inbound callback is authentic and parse it to MpesaCallback.
  // Throws MpesaCallbackAuthError if inauthentic or malformed. The simulator
  // trusts structure; Daraja validates structure (Daraja does not sign
  // callbacks — see daraja-provider.ts for the honest authenticity story).
  parseAndVerifyCallback(
    rawBody: unknown,
    headers: Record<string, string | undefined>,
  ): MpesaCallback;
  readonly name: "simulated" | "daraja";
}

export interface MpesaProvider extends MpesaCallbackParser {
  initiateStkPush(req: StkPushRequest): Promise<StkPushResult>;
}

// Thrown by parseAndVerifyCallback when a callback is malformed or inauthentic.
// The webhook maps it to 400 with no side effects.
export class MpesaCallbackAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MpesaCallbackAuthError";
  }
}

// ---- Daraja stkCallback envelope shape (shared by both providers) ----
// The exact JSON Safaricom POSTs. The simulator produces byte-compatible JSON
// so the webhook parses ONE shape regardless of provider.
export interface DarajaCallbackItem {
  Name: string;
  Value?: string | number;
}

export interface DarajaStkCallbackEnvelope {
  Body: {
    stkCallback: {
      MerchantRequestID?: string;
      CheckoutRequestID: string;
      ResultCode: number;
      ResultDesc: string;
      CallbackMetadata?: { Item: DarajaCallbackItem[] };
    };
  };
}

// Parse and structurally validate a Daraja stkCallback envelope into the
// normalized MpesaCallback. Shared by both providers (authenticity is layered on
// top per provider). Throws MpesaCallbackAuthError on any structural problem.
export function parseDarajaEnvelope(rawBody: unknown): MpesaCallback {
  if (typeof rawBody !== "object" || rawBody === null) {
    throw new MpesaCallbackAuthError("Callback body is not an object.");
  }
  const body = (rawBody as { Body?: unknown }).Body;
  if (typeof body !== "object" || body === null) {
    throw new MpesaCallbackAuthError("Callback missing Body.");
  }
  const stk = (body as { stkCallback?: unknown }).stkCallback;
  if (typeof stk !== "object" || stk === null) {
    throw new MpesaCallbackAuthError("Callback missing Body.stkCallback.");
  }
  const sc = stk as {
    MerchantRequestID?: unknown;
    CheckoutRequestID?: unknown;
    ResultCode?: unknown;
    ResultDesc?: unknown;
    CallbackMetadata?: unknown;
  };
  if (typeof sc.CheckoutRequestID !== "string" || sc.CheckoutRequestID === "") {
    throw new MpesaCallbackAuthError("Callback missing CheckoutRequestID.");
  }
  if (typeof sc.ResultCode !== "number") {
    throw new MpesaCallbackAuthError("Callback missing numeric ResultCode.");
  }
  const resultDesc = typeof sc.ResultDesc === "string" ? sc.ResultDesc : "";

  let mpesaReceiptNumber: string | null = null;
  let amountCents: bigint | null = null;
  let phoneNumber: string | null = null;

  if (typeof sc.CallbackMetadata === "object" && sc.CallbackMetadata !== null) {
    const items = (sc.CallbackMetadata as { Item?: unknown }).Item;
    if (Array.isArray(items)) {
      for (const item of items) {
        if (typeof item !== "object" || item === null) {
          continue;
        }
        const name = (item as { Name?: unknown }).Name;
        const value = (item as { Value?: unknown }).Value;
        if (name === "MpesaReceiptNumber" && typeof value === "string") {
          mpesaReceiptNumber = value;
        } else if (name === "Amount" && (typeof value === "number" || typeof value === "string")) {
          amountCents = darajaAmountToCents(value);
        } else if (name === "PhoneNumber" && (typeof value === "string" || typeof value === "number")) {
          phoneNumber = String(value);
        }
      }
    }
  }

  return {
    checkoutRequestId: sc.CheckoutRequestID,
    merchantRequestId: typeof sc.MerchantRequestID === "string" ? sc.MerchantRequestID : null,
    resultCode: sc.ResultCode,
    resultDesc,
    mpesaReceiptNumber,
    amountCents,
    phoneNumber,
    rawJson: JSON.stringify(rawBody),
  };
}

// Daraja quotes Amount in WHOLE SHILLINGS (integer KES). Convert to cents
// (*100) with no floating point. Rejects a fractional shilling amount.
export function darajaAmountToCents(value: string | number): bigint {
  const text = typeof value === "number" ? value.toString() : value.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new MpesaCallbackAuthError(`Callback Amount "${String(value)}" is not a valid number.`);
  }
  const [wholeRaw, fracRaw = ""] = text.split(".");
  const whole = wholeRaw ?? "0";
  // Daraja amounts are whole shillings; a nonzero fraction is unexpected.
  if (/[1-9]/.test(fracRaw)) {
    throw new MpesaCallbackAuthError(`Callback Amount "${String(value)}" has fractional shillings.`);
  }
  return BigInt(whole) * 100n;
}
