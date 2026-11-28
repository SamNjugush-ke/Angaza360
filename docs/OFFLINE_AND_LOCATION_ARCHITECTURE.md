# Angaza360 — Location-Owned Stock & Offline Architecture (Blueprint Addendum, v2)

**This supersedes the conflict-resolution model in the first offline draft.** The earlier
version *tolerated* cross-device stock conflicts and routed them to a resolution queue. That
failed the usability bar: an MSME owner should never adjudicate a database conflict. This
version makes conflicts **structurally impossible** by unifying offline with multi-location
inventory.

Read alongside `08_location_ownership.svg` and `09_lease_lifecycle.svg`, and the system
`ARCHITECTURE_BLUEPRINT.md`.

---

## 1. The core realisation: offline *is* multi-location

Offline stock leasing and multi-location warehousing are the same mechanism. A lease is a
stock allocation to a location; an offline POS is a location selling its own stock;
e-commerce running dry is a location depleting. So we build **one** thing — location-owned
stock — and offline, e-commerce stock separation, per-location reporting, and an AI
allocation seam all fall out of it.

**Consequence for the build:** Module 10 (multi-location), previously deferred, moves into
the MVP foundation. It is the prerequisite that makes offline conflict-free. Same total
work, pulled forward.

---

## 2. The one rule that removes all conflicts

> **Every location owns its stock exclusively. Nothing sells stock it does not own.**

A product's total stock is divided across locations (Main, a POS till, an e-commerce
channel, a branch). Each location's slice is owned by that location. The POS till sells only
its slice; the storefront sells only its slice. 20 at the till + 10 online = 30, never 31 —
because the stock was divided *before* either sold. There is nothing to reconcile because
there was never contention.

This is why an offline device is safe: it doesn't *check* stock against stale data, it
*owns* stock. It can sell its allocation with total confidence because no other channel can
touch it.

---

## 3. Locations (see `08_location_ownership.svg`)

One `Location` model with a type. MVP builds three functional types; the rest are the same
model, plug-ready:

**Functional in MVP:**
- **Main Warehouse** — the authoritative pool; the only place stock enters (purchases) and
  the default home for anything unallocated. Following NULL-means-default, all existing
  stock is Main by definition.
- **POS Location** (one till) — offline-capable; owns an allocated slice.
- **E-commerce Location** (one channel) — always online; owns its own slice; shows OUT OF
  STOCK when its slice depletes.

**Plug-ready (same model, no schema change to enable):** additional tills, additional
e-commerce pages, branch warehouses, per-attendant allocations.

**Reporting:** every transfer and sale is an immutable movement tagged with its location, so
stock-take reconciles per location and in total, and sales analysis rolls up by point of
sale. Moving stock between locations never loses history.

---

## 4. Transfers & allocation

Stock moves between locations via **transfers**, each an immutable `StockMovement`
(TRANSFER_OUT of source, TRANSFER_IN to destination — the movement types already exist).
Main → Till, Main → E-commerce, Branch → Branch. Transfers are value-neutral (no GL entry —
stock doesn't leave the entity), consistent with the existing inventory rules.

- **Allocation** is a transfer into a selling location.
- **Fixed buffer:** the inventory admin sets "reserve N of this product for this location."
- **Dynamic (deferred):** AI recommends N from sales velocity. Same allocation table; the
  number's *source* differs. The AI seam: "3 cement bags, 5 demand points — allocate to
  minimise lost sales."
- **Attendant requests more:** a request is a proposed transfer into the attendant's
  location; the admin approves, edits, or declines. An easy administrative task.
- **Alerts:** the inventory admin (or super-admin) receives low-stock and unsynced-lease
  alerts.

---

## 5. The lease window (see `09_lease_lifecycle.svg`)

Allocated stock to an *offline-capable* location carries a **lease window, set by the admin
per location**: hours, days, or **forever** (a permanent branch warehouse that never
freezes). Default 8 hours. The admin can also set session start/end per location.

Lifecycle:
1. **ALLOCATED** — admin transfers N to the till; Main ↓ N; the till owns N.
2. **LEASE ACTIVE** — the till sells its N offline; the lease clock runs.
3. **HARD STOP at 0** — when the till's owned quantity of an item hits 0, that item **cannot
   sell** until replenished (admin transfers more, or the attendant's request is approved).
   At the point of transaction the system shows *insufficient stock*. This is the guard that
   makes overselling impossible — there is no "sell anyway".
4. **End of lease window** — two outcomes:
   - **SYNCED in time** (normal) — the device reports sold X / unsold N−X. The server posts
     the X sales dated to their business time, and returns N−X to Main. Clean.
   - **PROACTIVE WARNING** — before expiry the device nags: "sync within 1h to keep
     selling." So freezing is the rare exception, not the daily case.

---

## 6. The frozen-stock safety mechanism (the hard case, solved)

If a lease **expires without the device syncing**, the unsold allocation goes to
**`PENDING_RECONCILIATION` — frozen**:
- It is removed from the till's *active* allocation (a recovered device cannot keep selling
  on a dead lease).
- It is **not** returned to sellable Main — because the server does not know what the
  offline device sold, and auto-returning could let another channel oversell.

**The server refuses to guess.** Frozen stock is released only by:
- **The device finally syncing** — the truth arrives (sold X at their real business dates,
  unsold N−X returns to Main). Resolved automatically, no human action.
- **An admin write-off (one click)** — for a genuinely lost/stolen/dead device: the admin
  marks the frozen allocation as an inventory loss (posts to 5300 Inventory Write-offs).
  Books stay correct.

This is the only honest resolution to "what did the offline device sell?" — and critically,
the worst case is a *business decision* (write off a lost till's stock), never a database
merge. The books never corrupt: auto-returning would risk overselling; locking forever would
strand a stolen till; freeze + one-click write-off is correct.

**Timing is the admin's policy, safety is invariant.** *When* freezing happens depends
entirely on the admin-set lease window (8h, days, or never). *That* freezing (rather than
guessing) happens is non-negotiable.

---

## 7. What works offline vs online — the crisp boundary (no in-between)

Applying "if it can conflict or needs a remote party, it's online-only":

**Offline (operates on owned resources — conflict-impossible):**
- Selling from the till's owned allocation · money/VAT/discount math (shared cents +
  roundHalfUp) · cash and manually-recorded M-Pesa reference · receipt printing · shift
  open/close.

**Online-only (shared state or external party — never faked):**
- **E-commerce storefront** — server-side, always online; sells its own location's slice.
- **M-Pesa STK push** — needs Safaricom; offline take cash / record reference.
- **eTIMS signing** — needs KRA; opt-in sales queue and sign on sync.
- **Selling beyond the owned allocation** — hard stop; must sync/replenish.
- **Transfers, inter-branch moves, live consolidated stock, cross-device credit limits.**
- **Purchase orders, payroll, server-aggregated reports.**

Stock is not *checked* offline, it is *owned* offline. That is the whole distinction.

---

## 8. The server on sync (unchanged financial core)

An offline sale becomes a real journal entry only on the server, through the **same atomic
sale transaction** as an online sale (stock ↓ from the till location, COGS, revenue, VAT),
under the same triggers protecting the books since Phase 2. Additions to `Sale`: `origin`
(ONLINE | OFFLINE_SYNCED), `businessTimestamp`, `syncedAt`, `deviceId`, unique
`idempotencyKey`. Business-time posting (a sale dates to when it happened, not when it
synced) and the period-close guard (a period won't close while a device holds unsynced sales
dated within it) are retained from the first draft — they still apply, but with leasing they
are exercised far less often.

Because the till only ever sold stock it *owned*, server-side stock re-validation on sync
**cannot fail** — the stock was reserved before the sale. This is the payoff: the risky
"server rejects a synced sale for insufficient stock" path from the first draft is gone.

---

## 9. Transparency

The attendant always sees: connectivity + queue count; per-item reasons for anything
online-only; owned-stock levels per item (and a clear "insufficient stock — request more" at
hard stop); a proactive "sync before your lease expires" prompt with the why. The admin
sees: pending allocation requests, low-stock alerts, and unsynced-lease/frozen-stock alerts
needing a decision.

---

## 10. Where AI plugs in (deferred, data ready now)

The allocation table and per-location velocity data exist from day one, so the AI advisor
slots in later with no schema change: optimal allocation per location under constrained
stock, restock/transfer recommendations, and lease-window tuning. The foundation *generates*
the data; the AI *reasons over* it.

---

## 11. Build sequence (revised)

1. **Location & allocation foundation** — `Location` model (Main/POS/E-com functional, rest
   plug), `ProductLocationStock` (per-location owned quantity), location-aware transfers on
   the existing inventory engine, allocation + request/approve flows, per-location lease
   config, low-stock/unsynced alerts, per-location reporting. Server-side, fully testable.
2. **Offline server foundation** — `Sale` offline dimensions, sync ingest endpoint, replay
   through the existing atomic transaction, business-time posting, idempotency, lease-expiry
   → freeze, admin write-off. Server-side.
3. **Device/PWA** — IndexedDB owned-stock mirror + outbox, local validation, sync engine,
   transparency + lease UI.
4. **E-commerce location** — the storefront selling its own slice (can come with or after
   the storefront module).
5. **Then eTIMS (4.1)** and other deferred online ops — as deferred-online operations on the
   finished foundation.

Each step is additive; none rebuilds a prior one. Offline, multi-location, e-commerce stock
separation, and the AI seam are now one coherent foundation rather than four features.
