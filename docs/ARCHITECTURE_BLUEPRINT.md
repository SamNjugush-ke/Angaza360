# Angaza360 — End-to-End Architecture Blueprint

**Purpose.** This document is the single reference for how the *complete* Angaza360 platform
is meant to work, so every MVP task is fine-tuning a known design rather than inventing one.
It describes the full TechSpec vision end to end, then shows how the MVP sits on that
foundation such that every deferred feature plugs in additively — no data migrations across
live tenants, no "back up your data and update your past records" events. Upgrades should
reach a trading business as *new features, new tabs, new reports* — never as structural
surgery.

It is a companion to `the engineering ledger` (the enforceable rulebook). Where `the engineering ledger` says *what
must be true*, this document says *why the whole thing is shaped this way*.

Read alongside:
- `01_system_architecture.svg` — the five system layers and where each module lives.
- `02_data_model.svg` — the dual-schema data model and the per-tenant credential store.
- `03_flows.svg` — the authenticated request lifecycle and the per-tenant integration flow.
- `04_pos_mockup.html` — a concrete POS surface in the product's design language.

---

## 1. The one idea everything hangs on

Angaza360 is a **multi-tenant SaaS ERP** where each MSME is a genuinely separate business —
its own books, its own stock, its own money, its own tax identity — that happens to run on
shared software. Two consequences drive the entire architecture:

1. **Isolation is structural, not a column.** Each tenant's business data lives in its own
   PostgreSQL schema (`tenant_<slug>`), never in shared tables filtered by a `tenant_id`.
   A shared registry schema (`public`) holds only what must be resolved *before* a tenant
   schema can be chosen: the tenant list, users, sessions, and Angaza's own platform data.

2. **Each tenant is its own legal and financial actor.** Nakuru Hardware's sales settle to
   Nakuru's own M-Pesa shortcode and sign under Nakuru's own KRA PIN. Angaza never holds a
   tenant's sale proceeds and never files a tenant's tax under Angaza's identity. Angaza is
   a *software provider*, not a payment aggregator or a tax agent. (This keeps Angaza out of
   CBK payment-service-provider licensing and keeps every tenant correctly visible to KRA
   under their own PIN — which is the platform's whole social purpose.)

Everything below is a consequence of these two facts.

---

## 2. The five layers (see `01_system_architecture.svg`)

**Layer 1 — Client interfaces.** MSME web portal, the offline-capable POS terminal, the B2C
storefront, the B2B marketplace, Angaza's Command Center, the donor dashboard, and a mobile
app. In the MVP only the POS terminal and a thin management portal are built; the rest are
deferred but the backend APIs they consume are designed now so the clients are additive.

**Layer 2 — Gateway, tenant context, and auth.** Fastify at the edge (Kong in production),
session JWTs with refresh-token rotation, the tenant-context middleware, and RBAC guards
across nine roles. **This is the single gate.** The tenant schema for a request is derived
only from the authenticated session's `tid` claim resolved against `public.tenants` — never
from the host header, a subdomain, a query string, or the request body. No module implements
its own tenant resolution or authorization.

**Layer 3 — Domain services.** Today this is a modular monolith; the module boundaries are
drawn exactly where the TechSpec's microservices are, so any service can be extracted later
without redrawing responsibilities. Two boundaries are absolute and never bend:
- Every operation that moves value posts through the **Ledger Engine** (the sole writer of
  journal tables).
- Every external call goes through the **Provider layer + Credential Store** (per-tenant,
  interface-based, config-swappable).

**Layer 4 — Data.** PostgreSQL schema-per-tenant via a dual Prisma topology (one client for
`public`, one for the tenant schema), Redis for cache/sessions/queues, Cloud Storage for
documents, and **encryption at rest for credentials** (application-level AES-256-GCM now,
Cloud KMS later — a config/re-encrypt upgrade, not a schema change).

**Layer 5 — Async pipeline & AI.** An event bus with workers (BullMQ now, Pub/Sub +
Dataflow later), **nightly reconcilers** (the M-Pesa transaction-status sweep and period
close — the `mpesa:expire` script is the first seam), the BigQuery analytics warehouse, and
the AI layer. The AI reads the *same* isolated tenant data through the *same* RBAC +
tenant-context gate — a tenant's AI coach can never see another tenant's data.

---

## 3. The data model (see `02_data_model.svg`)

### `public` — platform registry (shared)
`Tenant`, `User`, `Session` (all built), plus deferred `Subscription` / `DonorProject`, plus
the new **`PlatformCredential`** store (Task 3.4) holding *Angaza's own* shortcode and
integrator credentials — the ones used to charge subscriptions. These are separate from any
tenant's credentials by design.

### `tenant_<slug>` — isolated per MSME (identical structure in every tenant schema)
- **Financial core (built):** `Account` (44-account IFRS-aligned chart incl. 1015 M-Pesa
  clearing), `JournalEntry` / `JournalLine` (immutable, balance enforced by a deferred DB
  constraint), `AccountingPeriod` (period lock).
- **Inventory & POS (built):** `Product`, `StockMovement` (immutable; `locationId` NULL =
  MAIN plug), `Sale` / `SaleLine` / `SaleTender`, `Shift`, `Customer`, `MpesaTransaction`
  (terminal-state idempotent).
- **Per-tenant integrations (next):** **`TenantIntegrationCredential`** (Task 3.4) and
  `EtimsInvoice` (Task 4.1).
- **Location foundation (MVP, being built):** `Location` & **`ProductLocationStock`** — the
  per-location owned quantity. Promoted out of the deferred list by Task G.4: stock is
  location-owned, which is the prerequisite for conflict-free offline POS and for
  e-commerce stock separation. See `OFFLINE_AND_LOCATION_ARCHITECTURE.md`.
- **Deferred (plug ready):** `Supplier`/`PurchaseOrder`, `Employee`/`Payroll`,
  `StatutoryRate` (effective-dated), `B2BListing`, `TrustScore`, `StoreOrder`,
  `AiConversation`.

---

## 4. The credential store — the foundation this blueprint exists to lock in

> **Status: IMPLEMENTED in Task 3.4** (tenant migration 0010 + the platform table). M-Pesa is
> retrofitted onto it and now resolves per-tenant credentials per request. See section 10 for
> the two small differences between the sketch below and what was built.

### The shape
One table per tenant schema:

```
TenantIntegrationCredential
  id
  provider        MPESA | ETIMS | STRIPE | SMS | BANK   (enum, extend as providers are added)
  environment     sandbox | production
  encryptedBlob   AES-256-GCM ciphertext of the provider's credential set
  keyRef          which key encrypted it (enables KMS migration later)
  status          PENDING | ACTIVE | FAILED
  activeFrom      timestamp
  @@unique(provider, environment)
```

The `encryptedBlob` holds whatever that provider needs — for M-Pesa the consumer key/secret,
shortcode, passkey; for eTIMS the KRA PIN, branch id, device serial, OSCU token. The store
does not care about the shape inside the blob; each provider knows how to read its own.

### Why this shape scales without migrations
- **Per-tenant:** each tenant's row lives in *their* schema, so Nakuru's M-Pesa credentials
  are physically in `tenant_nakuru_hardware`. Cross-tenant leakage is structurally
  impossible.
- **Per-environment:** a tenant runs on `(MPESA, sandbox)` during MVP validation. Going live
  is inserting/activating a `(MPESA, production)` row and flipping their environment. **No
  schema change. No data migration. It appears to the shop as a "Go Live" button.**
- **Provider-generic:** eTIMS, then Stripe, then SMS, then bank feeds each add an enum value
  and a blob shape — never a new table. The store is the plug; each integration is
  plug-and-play.
- **Encryption-upgradeable:** because we store ciphertext + `keyRef`, moving from app-level
  AES to Cloud KMS is re-encrypting blobs under a KMS key and updating `keyRef` — not a
  structural change.

### How a provider is constructed (see `03_flows.svg`, section B)
The provider factory is per-request, not a global singleton:

```
factory(tenant, provider, environment)
  → load the tenant's ACTIVE credential row for (provider, environment)
  → decrypt the blob
  → construct SimulatedProvider (dev) OR Real{Daraja|Oscu|Stripe}Provider (config)
```

The reconciliation, idempotency, and ledger-posting code depends **only on the interface**
(`MpesaProvider`, `EtimsProvider`) and a normalized, provider-agnostic payload. This is why
the config-only swap is real: nothing above the factory knows or cares which concrete
provider or which credentials are in play.

---

## 5. How the two money-and-tax integrations actually work

### M-Pesa (built, being made per-tenant in 3.4)
- **Sale time:** an M-Pesa tender is only *promised*. The sale debits **1015 M-Pesa
  Clearing**, not the till (1010). Cash/bank/credit tenders post at sale time because that
  value is real immediately.
- **Confirmation:** Safaricom's callback (the only unauthenticated write path) moves it
  **Dr 1010 / Cr 1015**. Idempotency is a terminal-state guard on `checkoutRequestId`,
  backstopped by the database — a replayed callback is a 200 no-op.
- **Failure/timeout:** **Cr 1015 / Dr 1100 AR** (the shop delivered goods, so it is owed the
  money), tender → FAILED, sale payment status downgraded. A **nightly transaction-status
  sweep** catches callbacks Safaricom never successfully delivered — this is mandatory
  because Safaricom retries callbacks but not forever.
- **Tenant identity** on the callback comes from a **server-generated callback URL path**
  (`/webhooks/mpesa/:secret/:tenantSlug`), never the request body.

### eTIMS (Task 4.1 — identical shape)
Confirmed against current KRA rules (Feb 2025 self-onboarding update):
- Each tenant **self-onboards** on eTIMS under **their own KRA PIN** and obtains **their own
  OSCU device credentials** — stored in their credential row. KRA no longer gates this with
  manual approval, and a taxpayer may link more than one integrator.
- eTIMS is **opt-in per sale** (`fiscalStatus`: NOT_REQUESTED / PENDING_ETIMS / SIGNED /
  FAILED). Not every MSME sale is fiscally relevant — many are informal cash sales with no
  buyer PIN — so a sale finalizes validly without an eTIMS invoice. The cashier marks a sale
  for eTIMS when the customer needs it.
- When requested, the sale is signed via the **tenant's own** OSCU credentials, and the
  returned `EtimsInvoice` (KRA invoice number + QR + signature) attaches to the receipt.
  The receipt is attributed to the tenant's PIN and lands in the tenant's own KRA invoice
  sequence — **never Angaza's**.
- Same interface/factory/config-swap pattern as M-Pesa: a `SimulatedEtimsProvider` for
  deterministic development, a `RealOscuProvider` swapped in by config with sandbox then
  production credentials.

**These two are the same problem wearing two hats:** per-tenant, secret, onboarding-provided
credentials; an interface with simulated + real implementations; async or synchronous
confirmation; idempotency; and every financial effect posted through the ledger.

---

## 6. The AI layer, fit into the same skeleton

The TechSpec's AI is two-level, and both levels ride the isolation model already built:

- **MSME-level AI coach (RAG over the tenant's own data).** A conversational agent
  (Gemini + retrieval) pre-loaded with *only* the requesting tenant's sales, stock,
  expenses, and customers — scoped through the same `req.tenantDb` and RBAC gate as every
  other read. Revenue/demand forecasting, cash-flow alerts, churn and margin analysis, tax-
  readiness scoring. Every conversation is logged for the owner. **No cross-tenant reach.**
- **Angaza-level AI (Command Center).** Cohort analysis, failure-risk scoring, training-need
  prediction, and donor-impact reporting run over the **aggregated, anonymized** BigQuery
  layer — never ad hoc cross-schema queries. Individual tenant financials are never exposed
  cross-tenant without consent; this is a reviewed aggregation service, per `the engineering ledger`.
- **Predictive models & Trust Score engine** (demand, churn, the multi-dimensional Trust
  Score) are event-triggered off the same data pipeline.

The AI is deferred in the MVP, but the data it needs is already normalized, ledger-backed,
and isolated — so when it arrives it *reads* an existing foundation rather than requiring the
transactional core to change.

---

## 7. Microservices & the async pipeline — designed for, not prematurely built

The TechSpec envisions domain microservices on GKE with Pub/Sub eventing. The MVP is a
**modular monolith whose module boundaries are exactly the future service boundaries.** This
is deliberate:
- Extracting the POS service, the Ledger service, or the AI service later is lifting an
  already-isolated module behind its existing interface — not untangling a big ball of mud.
- The event bus is abstracted now (BullMQ) so moving to Pub/Sub + Dataflow is an adapter
  swap, mirroring the provider pattern.
- The nightly reconcilers exist as CLI scripts now (the seam), to become scheduled workers
  later without changing their logic.

Building microservices before there is load would buy operational complexity with no
benefit; drawing the boundaries correctly now buys the option to extract them for free.

---

## 8. The scale-up principle, stated once and applied everywhere

> **Defer capability, never foundation. Every deferred feature must plug into a dimension
> that already exists, so completing it is additive — new rows, new routes, new tabs — never
> an ALTER across live financial data.**

Concrete plugs already in place or planned:
- **Multi-location — the plug REDEEMED, and the best evidence the rule pays.**
  `StockMovement.locationId` was added nullable, NULL = MAIN, while multi-location was still
  deferred. Task G.4 then pulled it *forward* into the MVP foundation, because location-owned
  stock is what makes offline POS and e-commerce conflict-free. Because the plug was already
  laid, promoting it costs new tables and routes — `ProductLocationStock`, transfer and
  allocation flows — and **not** an ALTER across historical stock: those rows are never
  touched, they *are* MAIN by definition. This is precisely the payoff the principle
  promises: on the day a deferred capability is pulled forward, the foundation is already
  under it.
- **Statutory rates:** effective-dated config rows, never hardcoded constants. A finance-act
  change is an admin edit with history; past payroll stays correct against the rate then in
  force.
- **Sandbox → production:** one credential row activated. A "Go Live" button.
- **eTIMS:** the `fiscalStatus` seam already sits on `Sale` from the POS build.
- **App-level encryption → Cloud KMS:** ciphertext + `keyRef` already stored.

**The general rule (now law in `the engineering ledger`):** when a deferred dimension is plugged into a
table that already holds immutable or historical rows, the column is nullable and NULL is
*defined* to mean the sensible default. Historical rows are never backfilled or mutated;
new rows carry an explicit value; reads `COALESCE` NULL to the default. This preserves
immutability and avoids migrations across live data — for location today, for tax regime,
cost centre, or branch tomorrow.

---

## 9. What this means for a real business mid-flight

A shop onboarded during MVP testing is a real business trading real money. As development
continues, they must never experience a structural disruption. Because of the design above,
every planned upgrade reaches them as an **appearance**, not a **migration**:

| Upgrade | How the shop experiences it |
|---|---|
| eTIMS goes live | A "Issue KRA invoice" toggle appears on the POS |
| Their M-Pesa moves sandbox → production | A "Go Live" button on their payments settings |
| Multi-location (now MVP foundation) | An "Add a location" option appears; existing stock stays as "Main" and is never re-entered |
| Offline selling | Their till keeps selling its own allocated stock through an outage, and syncs when the network returns |
| Payroll module | A new "Payroll" tab; nothing about their sales changes |
| AI coach | A new "Ask" button; it reads data they already generated |
| E-commerce storefront | A new public URL toggles on; catalogue is already there |
| Financial statements | New "Reports" that derive from the ledger they've been filling |

Never: *"back up your data, we're adding columns, please re-enter your past records."*

---

## 10. Build sequence (authoritative order lives in `the engineering ledger`)

**Done:** Phase 0 (dual topology, provisioning, auth/RBAC) · Phase 2 (money-as-cents +
chart of accounts, double-entry ledger) · Phase 3.1 (inventory + WAC) · 3.2 (POS sale flow)
· 3.3 (M-Pesa STK + idempotent callback) · **3.4 — per-tenant encrypted credential store
(IMPLEMENTED)** · G.2 multi-location plug · G.3 schema-driven OpenAPI (`/docs`) · **G.4 —
location-owned stock + offline model made governance, Module 10 promoted to MVP
foundation**.

**3.4 as built** matches section 4 with two clarifications worth recording:
- The blob columns are stored split (`ciphertext` / `iv` / `authTag` / `keyRef`) rather than
  as one `encryptedBlob` string, so the GCM parts are individually addressable — which is
  what made the tamper test a one-column `UPDATE` and keeps a future KMS migration a
  per-column rewrite.
- `BANK` is not in the provider enum yet (`MPESA | ETIMS | STRIPE | SMS`), and only MPESA has
  a registered blob shape. The other enum values are declared slots; a provider's credential
  fields are defined by the task that builds it rather than guessed in advance. Adding one is
  still an enum value plus a shape — never a new table.

**Next:** **the location & offline foundation first** — (1) location & allocation
foundation (`Location`, `ProductLocationStock`, location-aware transfers, allocation and
request/approve, per-location lease config, alerts, per-location reporting), (2) the offline
server foundation (`Sale` offline dimensions, sync ingest, business-time posting,
idempotency, lease-expiry freeze, admin write-off), (3) device/PWA — then **4.1 — eTIMS OSCU
signing** (opt-in, per-tenant, born on the credential store) → procurement/AP → AR aging →
payroll + effective-dated statutory config → financial statements + tax reports → frontend →
AI/RAG → remaining growth modules (e-commerce storefront UI, B2B marketplace, Trust Score) →
Command Center.

Multi-location has LEFT the deferred-growth list: it is now the MVP foundation those first
three items build, and the e-commerce storefront's *stock* foundation lands with it (an
e-commerce location owning its own slice) — only the storefront UI remains a growth build.
See `OFFLINE_AND_LOCATION_ARCHITECTURE.md` for the reasoning and `the engineering ledger` for the
authoritative order.

Every item on that list already has its foundation in the schema and the service boundaries.
That is the point of this document: **from here on, we are adding flesh to bones that already
exist.**
