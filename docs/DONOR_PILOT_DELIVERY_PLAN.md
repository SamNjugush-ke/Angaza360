# Angaza360 — Donor Pilot Delivery Plan

**Status:** planning document · companion to `ARCHITECTURE_BLUEPRINT.md` and
`OFFLINE_AND_LOCATION_ARCHITECTURE.md`.

> **CORRECTION (Task 4.1).** §1's requirement mapping and §8's sign-off criteria
> stand and are authoritative. **§2's build ORDER does not** — it was withdrawn in
> favour of engineering-driven sequencing, and **the engineering ledger's "Linear task ledger →
> NEXT" is the single source of sequencing truth** (the engineering ledger says so, and a
> companion doc that contradicts it is corrected rather than followed). The
> donor's eight requirements are **order-independent ACCEPTANCE TARGETS met at MVP
> completion, not a build-order mandate**: they inform scope for a multi-donor
> platform. See §2 for what changed and why.

**Context:** first donor partner, a cloud bookkeeping platform for entrepreneurs.
This plan maps the donor's eight requirements onto the build, designs the one
genuinely new module (mentorship/coaching) end to end, and designs the frontend —
without weakening anything already built.

The governing principle is unchanged: **defer capability, never foundation.**
Everything the pilot needs now sits on the ledger, inventory, location, credential
and offline foundations already proven; nothing below requires re-litigating them.

---

## 1. The donor's eight requirements vs. the current build

| # | Requirement | Status today | What remains for the pilot |
|---|---|---|---|
| 1 | Embedded POS — sales, receipts, payment methods, credit sales | **Built** (3.2, 3.3, 3.2-LOC) | Frontend POS surface only |
| 2 | Inventory — products, purchases, stock levels, movements, low-stock alerts | **Built** (3.1, 3.1-FIX, 10.1, 10.2) | Frontend screens; alert *delivery* (optional) |
| 3 | Accounting — income, expenses, cash/bank, receivables, payables | **Core built** (2.2 ledger; AR partial) | AP workflow depth (receivables already move); frontend |
| 4 | Reports — P&L, cash-flow, balance-sheet, sales, expense, inventory | **Data ready, generation NOT built** | **Phase R1 — financial reporting** (this plan) |
| 5 | Mentorship & coaching dashboard — KPIs, goals, action plans | **Not built — new module** | **Phase R2 — mentorship module** (this plan) |
| 6 | Role-based access — entrepreneurs, employees, mentors, coaches, admins | **Framework built; MENTOR/COACH roles added in OFF.1** | Mentorship routes gate on them (Phase R2) |
| 7 | Mobile & web, offline capture where possible | **Offline server built (OFF.1); web/mobile ~0%** | **Phase R3 — frontend** + device/PWA (offline) |
| 8 | Over 40 users | **Architecturally satisfied** (schema-per-tenant, pooled, session auth) | Nothing — capacity is not the constraint; the app is |

**Reading:** five of eight are substantially met at the backend. The three that
are not — financial reports (#4), the mentorship dashboard (#5), and the usable
frontend (#7) — define the near-term plan. #6's roles were seeded in OFF.1 so #5
can gate on them cleanly.

---

## 2. Sequencing — SUPERSEDED, and why

This section originally proposed a donor-facing order (R1 reporting → R2
mentorship → R3 frontend) and deferred eTIMS past the pilot. **That ordering is
withdrawn.** The phases R1/R2/R3 described below in §3-§5 remain accurate as
DESIGNS of the work; only their position in the queue changed.

**What the correction is.** The donor's eight requirements are **order-independent
ACCEPTANCE TARGETS met at MVP completion, not a build-order mandate.** The
authoritative sequence is the engineering ledger's "Linear task ledger → NEXT":

1. Procurement / purchase orders + Accounts Payable
2. Accounts Receivable aging & statements
3. Payroll + Kenyan statutory deductions
4. Financial statements + operational reports (the R1 design below)
5. Mentorship & coaching module (the R2 design below)
6. Frontend, web + the offline POS PWA (the R3 design below)
7. AI / RAG advisory + remaining growth modules

**Why engineering order wins here.** Two concrete reasons, not a preference:

- **This is a multi-donor platform.** One partner's demo emphasis is an input to
  SCOPE, not to the schedule. Sequencing by a single partner's presentation order
  would mean re-sequencing for the next partner.
- **Reporting must come after the transactions it reports on.** A statement engine
  built before AP, AR and payroll post their entries gets rewritten as each one
  lands. Finish the transaction layer, then report over it, then build the module
  that consumes the reports (mentorship KPIs are computed from the reporting
  engine), then the UI. That ordering writes each layer once.

**eTIMS is no longer deferred — it is DONE (Task 4.1).** It turned out to be a
small, well-isolated task precisely because the foundations predicted it: a
provider interface, a credential blob shape, and an opt-in flag. It posts nothing
to the ledger and signs post-commit, so it could not destabilise anything already
built.

**Still deferred past the pilot** (foundations in place, additive later):
- Growth modules: e-commerce storefront UI, B2B marketplace, Trust Score, Command
  Center, AI RAG coach.
- The offline PWA *client* ships with the frontend (item 6); the offline *server*
  is done, so an online-first POS can ship first and the client follows as a
  drop-in against the proven ingest endpoint.

---

## 3. Phase R1 — Financial Reporting & Statements

*(Design unchanged and still accurate. Its position in the queue is item 4 — see
the correction in §2.)*

**Why it is low-risk:** the chart of accounts is IFRS-classified, the ledger is
immutable and balanced, inventory reconciles exactly to account 1200, and sales/
COGS/VAT all post correctly. Every figure these reports need already exists and
already reconciles. R1 is a **read layer**, not new financial logic — it must
never compute a balance, only aggregate posted journal lines.

**Hard rules for R1 (carry into the task specs):**
- Reports are pure reads over `journal_lines` + `journal_entries`, grouped by
  `accountClass` and account `code`. They never post, never mutate, never
  recompute a balance a different way than the ledger already holds it.
- Every report reconciles to the ledger by construction: the Balance Sheet
  balances (Assets = Liabilities + Equity) because it sums the same posted lines
  the trial balance does; a report that doesn't tie out is a bug, not a rounding
  choice.
- Money stays BigInt cents; serialised as strings; one rounding primitive.
- Date-ranged and as-of reports respect `businessTimestamp`/`entryDate`, so an
  offline-synced sale lands in the period it happened (consistent with OFF.1).
- Every route is Zod-schema-documented per the G.3 law; money as strings.

**R1 task breakdown:**
- **R1.1 — Statement engine.** A reporting service producing: **Profit & Loss**
  (revenue − COGS − expenses, by account class and code, for a period),
  **Balance Sheet** (assets/liabilities/equity as-of a date, proving the
  accounting equation), **Cash Flow** (from cash/bank/M-Pesa account movements;
  direct method for MVP). Adversarial acceptance: the three statements tie to
  each other and to the trial balance to the cent, across a period that includes
  an offline-synced backdated sale.
- **R1.2 — Operational reports.** **Sales report** (by period, product, location,
  tender, cashier — the data POS already captures), **Expense report** (by
  account/category/period), **Inventory report** (valuation, movement history,
  per-location levels, low-stock — from 10.1/10.2). These reuse existing read
  models; mostly aggregation and shaping.
- **R1.3 — Report API + export seam.** `/v1/reports/*` routes, fully Zod-documented;
  a structured JSON shape the frontend renders and a later PDF/Excel export can
  consume (export itself is a frontend/post-pilot concern — the seam is the
  structured response).

---

## 4. Phase R2 — Mentorship & Coaching Module (end-to-end design)

*(Design unchanged. Queue position: item 5 — it consumes R1's engine, so it still
follows reporting. This is Module 14 in the engineering ledger.)*

This is the only requirement with no existing foundation, so it is designed in
full here. Its defining architectural challenge: **a mentor must see several
mentee businesses, each of which lives in its own isolated tenant schema.** That
is a deliberate, consented, logged cross-tenant *read* — exactly the case
the engineering ledger already anticipates ("if cross-tenant reporting is genuinely required,
it must go through an explicit, separately reviewed aggregation service — never
through ad hoc queries in tenant-facing code"). R2 builds that service; it does
**not** loosen tenant isolation.

### 4.1 The access model (the sensitive part, designed carefully)

- A **mentor/coach is a platform-level user** (like SUPER_ADMIN / PROGRAM_OFFICER)
  with `tenantId = null`. The MENTOR and COACH roles exist as of OFF.1.
- Access to a mentee is **explicit and record-backed**: a `MentorshipEngagement`
  row (platform schema) links one mentor to one tenant, with a status
  (INVITED / ACTIVE / ENDED) and the **mentee's consent** captured
  (owner-approved). No engagement row ⇒ no access. This is the single gate;
  there is no code path where a mentor names a tenant and is trusted.
- Every mentor read of a mentee's data resolves the target schema **from the
  engagement record**, not from the request — the same discipline as the
  session-derived tenant context, extended to an explicitly-granted second party.
- Mentor reads are **read-only** over the mentee's tenant data and are **logged**
  (who viewed what, when) so the entrepreneur can see their mentor's access. A
  mentor never writes to a mentee's ledger, stock, or sales.
- Reads go through a dedicated **mentorship read service** that calls the same
  reporting/aggregation functions R1 builds, scoped to the engaged tenant —
  reusing proven, reconciling reads rather than new cross-schema SQL.

### 4.2 Data model (platform schema, additive)

- `MentorshipEngagement` — mentorId, tenantId, status, consent, startedAt/endedAt.
- `Goal` — per engagement: title, description, target metric, target value,
  target date, status (OPEN / ON_TRACK / AT_RISK / MET / MISSED).
- `PerformanceIndicator` — per engagement: a named KPI bound to a **computed
  source** (e.g. monthly revenue, gross margin %, cash position, inventory
  turnover, sales growth) with an agreed target. Actuals are *derived* from the
  mentee's ledger/sales via the R1 engine — never hand-entered, never duplicated.
- `ActionPlan` / `ActionItem` — items with owner, due date, status, notes; the
  agreed next steps.
- `CoachingSession` / note — a dated record of a check-in, observations, and
  commitments.

All of these are **platform-level** (they describe the mentoring relationship,
not the business's books), which keeps the mentee's tenant schema untouched and
the mentoring data portable across the mentor's whole cohort.

### 4.3 KPIs ride existing data

Every indicator the dashboard shows is computed from what the ledger and POS
already record — revenue trend, gross margin, cash/M-Pesa position, inventory
turnover, expense ratios, sales growth, credit exposure. The mentorship module
*consumes* the R1 reporting engine scoped to the mentee; it introduces no new
financial computation. This is why R1 comes first.

### 4.4 The dashboard API

`/v1/mentorship/*`: list engagements; for an engaged tenant, read its KPI set
(computed), goals, action plans, and session history; create/update goals,
action items and session notes (on the engagement, not the mentee's books).
Gated by requireRole(MENTOR, COACH) + an engagement check; fully Zod-documented;
money as strings. The entrepreneur's own view (MSME_OWNER) sees the same goals/
plans and who has access.

### 4.5 AI seam (deferred, data ready)

The agreed KPIs, goals and trends are exactly the inputs the later AI business
coach needs. R2 generates and structures that data now; the AI advisory module
reads it post-pilot with no schema change — the same defer-capability-not-
foundation discipline.

### 4.6 R2 task breakdown

- **R2.1 — Engagement + consent model** (platform migration; MENTOR/COACH already
  seeded). Adversarial: a mentor with no engagement gets 404 on a tenant; a
  mentor with an ENDED engagement loses access; every read is logged.
- **R2.2 — Goals, KPIs, action plans, sessions** (data + services), KPIs computed
  via the R1 engine scoped to the engaged tenant.
- **R2.3 — Mentorship dashboard API** + the entrepreneur's reciprocal view.

---

## 5. Phase R3 — Frontend

*(Design unchanged. Queue position: item 6.)*

The single largest unbuilt piece, and what turns a proven API into a product 40
users can actually use. Built against the settled, Zod-documented API — no
business logic in the frontend (the engineering ledger), it renders state and calls APIs.

- **R3.1 — Shell + auth + tenant theming.** Next.js 14 app, session/refresh auth,
  role-aware navigation, per-tenant branding.
- **R3.2 — POS terminal (the fast path).** The one screen that must be quick:
  cart, tenders (cash/M-Pesa STK/bank/credit), receipts, shift open/close, the
  per-sale eTIMS opt-in toggle (wired to its seam). Built online-first; the
  **offline PWA client (OFF.1's device side)** layers on — IndexedDB outbox,
  local validation mirror, the sync engine against the proven ingest endpoint,
  and the transparency/lease UI. If the timeline is tight, online-first POS ships
  for the pilot and the offline client follows as a drop-in.
- **R3.3 — Inventory, accounting & reports screens.** Products, stock, allocation/
  transfers, the R1 statements and operational reports.
- **R3.4 — Mentorship dashboard.** The mentor/coach view and the entrepreneur's
  reciprocal view, on the R2 API.

---

## 6. RBAC — mentor/coach

Done in OFF.1: MENTOR and COACH exist in the role enum, resolve through the RBAC
gate, and carry no tenant-write permission. R2 adds the engagement-scoped read
access that gives them meaning. No framework change is required — this is the
"defer capability, not foundation" rule paying off: the roles were plugged before
the module needed them.

---

## 7. What is deferred past the pilot, and why it is safe

| Deferred | Foundation already in place | Enabling it later is |
|---|---|---|
| ~~eTIMS live signing~~ **DONE (4.1)** | Provider interface + per-tenant credential store | Was exactly "a provider impl + config, opt-in per sale" — the prediction held |
| Offline device/PWA client | OFF.1 sync ingest, idempotency, freeze, business-time posting | A client against a proven endpoint |
| Procurement/PO, AP settlement | Supplier model, AP account (2000) posting | New rows + routes |
| AR aging & statements | Customer credit, AR (1100) posting | New read models |
| E-commerce storefront | E-commerce location owns its stock slice (location model) | UI on an existing stock foundation |
| AI RAG coach | KPIs/goals/ledger data normalised by R1/R2 | A read + model layer |

None of these is an ALTER across live financial data; each is additive. That is
the whole point of the foundation discipline.

---

## 8. Pilot sign-off criteria (requirement by requirement)

The pilot is donor-ready when:
1. **POS** — a cashier rings a sale (cash/M-Pesa/credit), prints a receipt, and
   voids correctly, from the web/PWA.
2. **Inventory** — products, stock levels, movements and low-stock all visible;
   allocation/transfer usable.
3. **Accounting** — income, expenses, cash/bank and receivables all post and
   display; payables recorded.
4. **Reports** — P&L, Balance Sheet, Cash Flow, sales, expense and inventory
   reports generate and tie to the ledger to the cent.
5. **Mentorship** — a mentor sees an engaged mentee's KPIs, goals and action
   plans; the entrepreneur sees the same and who has access.
6. **RBAC** — entrepreneur, employee, mentor, coach and admin each see exactly
   their permitted surface.
7. **Web + offline** — usable on web and mobile; the POS captures offline and
   syncs (or online-first with the offline client as the fast-follow).
8. **40+ users** — multiple tenants and users operate concurrently without
   cross-tenant leakage (already proven at the data and HTTP layers).

Each criterion maps to a phase above; none depends on an unbuilt foundation.
