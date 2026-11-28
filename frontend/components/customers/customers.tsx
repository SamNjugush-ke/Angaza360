"use client";

import { Plus, Search } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { TextField } from "@/components/auth/form-bits";
import { AgingTable, StatementTable } from "@/components/money/shared";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/states";
import { SelectField, TabPanel, Tabs, type Tab } from "@/components/stock/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet } from "@/components/ui/sheet";
import type { Role } from "@/lib/auth/landing";
import { businessToday, formatDate } from "@/lib/datetime";
import { formatKES } from "@/lib/money";
import {
  METHOD_LABEL,
  receivablesPermissions,
  useArAging,
  useCustomers,
  useInvalidateReceivables,
  useOpen,
  useReceipts,
  useStatement,
  type Customer,
  type ReceiptMethod,
  type ReceivablesPermissions,
} from "@/lib/receivables/receivables";
import { cn } from "@/lib/utils";
import { CustomerForm } from "./customer-form";
import { ReceiptForm } from "./receipt-form";

// CUSTOMERS & RECEIVABLES. Who sees what follows the API's guards exactly:
//   * the DIRECTORY (GET /v1/customers) is the owner's, manager's and cashier's — a cashier sees only
//     this, with no balances owed, statements, receipts or aging;
//   * RECEIVABLES (open credit sales, statements, receipts, aging) are the owner's, manager's,
//     accountant's and auditor's. The accountant and auditor cannot read the directory, so their
//     customer list is the customers who owe — the AR aging.
// Recording a receipt is the owner's, manager's and accountant's.

const BADGE = "inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium";

interface Opened {
  id: string;
  name: string;
  customer: Customer | null;
}

function CustomerSheet({ opened, permissions, onClose, onSaved }: { opened: Opened; permissions: ReceivablesPermissions; onClose: () => void; onSaved: (customer: Customer) => void }) {
  const [mode, setMode] = useState<"view" | "edit" | "receipt">("view");
  const statement = useStatement(opened.id, permissions.canReadReceivables);
  const open = useOpen(opened.id, permissions.canReadReceivables);
  const c = opened.customer;

  let body: ReactNode;
  if (mode === "edit" && c) {
    body = (
      <CustomerForm
        customer={c}
        canSetCredit={permissions.canEditCustomer}
        onSaved={(saved) => {
          onSaved(saved);
          setMode("view");
        }}
      />
    );
  } else if (mode === "receipt") {
    body = (
      <div className="space-y-3">
        <ReceiptForm customerId={opened.id} />
        <Button type="button" variant="outline" className="h-11" onClick={() => setMode("view")}>
          Back to {opened.name}
        </Button>
      </div>
    );
  } else {
    const owes = open.data?.data ?? [];
    body = (
      <div className="space-y-5">
        <div className="flex flex-wrap gap-2">
          {permissions.canRecordReceipt && owes.length > 0 ? (
            <Button type="button" className="h-11" onClick={() => setMode("receipt")} data-autofocus>
              Record receipt
            </Button>
          ) : null}
          {permissions.canEditCustomer && c ? (
            <Button type="button" variant="outline" className="h-11" onClick={() => setMode("edit")}>
              Edit customer
            </Button>
          ) : null}
        </div>
        {c ? (
          <dl className="text-sm">
            {[
              ["Phone", c.phone ?? "—"],
              ["Email", c.email ?? "—"],
              ["KRA PIN", c.kraPin ?? "—"],
              ["Loyalty points", c.loyaltyPoints.toString()],
              ...(permissions.canReadReceivables ? [] : [["Status", c.isActive ? "Active" : "Inactive"]]),
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between gap-4 border-b py-1.5 last:border-b-0">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="text-right">{value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {permissions.canReadReceivables ? (
          statement.isPending ? (
            <LoadingState label="Loading the statement" />
          ) : statement.isError ? (
            <ErrorState title="Couldn’t load the statement" description={statement.error.message} onRetry={() => void statement.refetch()} />
          ) : (
            <>
              <section aria-label="Credit" className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border p-3">
                  <p className="text-sm text-muted-foreground">Owes now</p>
                  <p className="font-display text-2xl font-semibold tabular-nums">KES {formatKES(statement.data.closingBalance)}</p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-sm text-muted-foreground">Credit limit</p>
                  <p className="font-display text-2xl font-semibold tabular-nums">KES {formatKES(statement.data.creditLimit)}</p>
                  {c ? <p className="text-xs text-muted-foreground">KES {formatKES(c.creditBalance)} of it used</p> : null}
                </div>
              </section>
              <section aria-labelledby="statement-heading" className="space-y-2">
                <h3 id="statement-heading" className="font-medium">
                  Statement
                </h3>
                <StatementTable
                  caption={`Statement for ${opened.name}`}
                  chargedLabel="On credit"
                  creditedLabel="Paid"
                  lines={statement.data.entries.map((e, i) => ({
                    key: `${e.reference}-${i.toString()}`,
                    date: e.date,
                    reference: e.reference,
                    description: e.description,
                    charged: e.charged,
                    credited: e.received,
                    runningBalance: e.runningBalance,
                  }))}
                />
              </section>
              <section aria-labelledby="open-heading" className="space-y-2">
                <h3 id="open-heading" className="font-medium">
                  Still owed
                </h3>
                {owes.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Nothing — every credit sale is paid.</p>
                ) : (
                  <ul aria-label="Open credit sales" className="divide-y rounded-lg border text-sm">
                    {owes.map((s) => (
                      <li key={s.saleId} className="flex justify-between gap-3 px-3 py-2">
                        <span>
                          <span className="font-medium">{s.saleNumber}</span>{" "}
                          <span className="text-muted-foreground">
                            {formatDate(s.saleDate)} · {s.daysOutstanding.toString()} days
                          </span>
                        </span>
                        <span className="tabular-nums">KES {formatKES(s.outstanding)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )
        ) : (
          <p className="text-sm text-muted-foreground">Balances owed are kept by the owner, manager and accountant.</p>
        )}
      </div>
    );
  }
  return (
    <Sheet title={mode === "edit" ? `Edit ${opened.name}` : mode === "receipt" ? `Record a receipt — ${opened.name}` : opened.name} onClose={onClose} wide>
      {body}
    </Sheet>
  );
}

function Directory({ permissions, onOpen }: { permissions: ReceivablesPermissions; onOpen: (opened: Opened) => void }) {
  const ids = { search: useId() };
  const customers = useCustomers(true);
  const invalidate = useInvalidateReceivables();
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const needle = search.trim().toLowerCase();
  const rows = (customers.data?.data ?? []).filter((c) => needle === "" || c.name.toLowerCase().includes(needle) || (c.phone ?? "").includes(needle));
  const showMoney = permissions.canReadReceivables;

  let list: ReactNode;
  if (customers.isPending) list = <LoadingState label="Loading customers" lines={5} />;
  else if (customers.isError) list = <ErrorState title="Couldn’t load customers" description={customers.error.message} onRetry={() => void customers.refetch()} />;
  else if (customers.data.data.length === 0) list = <EmptyState title="No customers yet" description="Add a customer to sell to them on credit and track what they owe." />;
  else if (rows.length === 0)
    list = (
      <EmptyState
        title="No customers match"
        description={`Nobody matches “${search.trim()}”.`}
        action={
          <Button type="button" variant="outline" className="h-11" onClick={() => setSearch("")}>
            Clear the search
          </Button>
        }
      />
    );
  else
    list = (
      <ul aria-label="Customers" className="space-y-2">
        {rows.map((c) => (
          <li key={c.id}>
            <button type="button" onClick={() => onOpen({ id: c.id, name: c.name, customer: c })} className="flex min-h-11 w-full flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-2 font-medium">
                  {c.name}
                  {c.isActive ? null : <span className={cn(BADGE, "border-destructive/40 bg-destructive/10")}>Inactive</span>}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {c.phone ?? "No phone"} · {c.loyaltyPoints.toString()} points
                </span>
              </span>
              {showMoney ? (
                <span className="text-right text-sm tabular-nums">
                  <span className="block font-medium">Owes KES {formatKES(c.creditBalance)}</span>
                  <span className="block text-xs text-muted-foreground">limit KES {formatKES(c.creditLimit)}</span>
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="w-full max-w-sm space-y-2">
          <Label htmlFor={ids.search}>Search</Label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input id={ids.search} type="search" className="h-11 pl-9" placeholder="Name or phone" autoComplete="off" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
        {permissions.canCreateCustomer ? (
          <Button type="button" className="h-11" onClick={() => setAdding(true)}>
            <Plus aria-hidden /> Add customer
          </Button>
        ) : null}
      </div>
      {notice ? (
        <p role="status" className="text-sm">
          {notice}
        </p>
      ) : null}
      {list}
      {adding ? (
        <Sheet title="Add a customer" onClose={() => setAdding(false)}>
          <CustomerForm
            customer={null}
            canSetCredit={permissions.canEditCustomer}
            onSaved={(saved) => {
              void invalidate();
              setNotice(`${saved.name} was added.`);
              setAdding(false);
            }}
          />
        </Sheet>
      ) : null}
    </div>
  );
}

/** The accountant's and auditor's customer list: the customers who owe (they cannot read the directory). */
function Owing({ onOpen }: { onOpen: (opened: Opened) => void }) {
  const [today] = useState(() => businessToday());
  const aging = useArAging(today, true);
  if (aging.isPending) return <LoadingState label="Loading customers who owe" lines={4} />;
  if (aging.isError) return <ErrorState title="Couldn’t load customers" description={aging.error.message} onRetry={() => void aging.refetch()} />;
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">Customers who owe money on credit. The full directory is kept by the owner, manager and cashiers.</p>
      {aging.data.customers.length === 0 ? (
        <EmptyState title="Nobody owes anything" description="Every credit sale has been paid." />
      ) : (
        <ul aria-label="Customers" className="space-y-2">
          {aging.data.customers.map((c) => (
            <li key={c.customerId}>
              <button type="button" onClick={() => onOpen({ id: c.customerId, name: c.customerName, customer: null })} className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg border p-3 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span className="font-medium">{c.customerName}</span>
                <span className="text-right text-sm tabular-nums">
                  <span className="block font-medium">Owes KES {formatKES(c.total)}</span>
                  <span className="block text-xs text-muted-foreground">limit KES {formatKES(c.creditLimit)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AgingView({ onOpen }: { onOpen: (opened: Opened) => void }) {
  const ids = { asOf: useId() };
  const [today] = useState(() => businessToday());
  const [asOf, setAsOf] = useState(today);
  const aging = useArAging(asOf, /^\d{4}-\d{2}-\d{2}$/.test(asOf));
  return (
    <div className="space-y-4">
      <div className="max-w-xs">
        <TextField id={ids.asOf} label="As at" type="date" max={today} value={asOf} onChange={(e) => setAsOf(e.target.value)} hint="Aged from the day of each credit sale." />
      </div>
      {aging.isPending ? (
        <LoadingState label="Loading the aging" lines={4} />
      ) : aging.isError ? (
        <ErrorState title="Couldn’t load the aging" description={aging.error.message} onRetry={() => void aging.refetch()} />
      ) : aging.data.customers.length === 0 ? (
        <EmptyState title="Nothing owed" description="No customer owes money on credit as at this date." />
      ) : (
        <AgingTable
          caption="Receivables by age"
          currentLabel="Today"
          countLabel="open sales"
          rows={aging.data.customers.map((c) => ({ ...c, id: c.customerId, name: c.customerName, count: c.saleCount }))}
          totals={aging.data.totals}
          grandTotal={aging.data.grandTotal}
          onOpen={(row) => onOpen({ id: row.id, name: row.name, customer: null })}
        />
      )}
    </div>
  );
}

function ReceiptsView() {
  const ids = { method: useId() };
  const [method, setMethod] = useState<ReceiptMethod | "">("");
  const receipts = useReceipts(method, "", true);
  let list: ReactNode;
  if (receipts.isPending) list = <LoadingState label="Loading receipts" lines={4} />;
  else if (receipts.isError) list = <ErrorState title="Couldn’t load receipts" description={receipts.error.message} onRetry={() => void receipts.refetch()} />;
  else if (receipts.data.data.length === 0) list = <EmptyState title={method ? `No ${METHOD_LABEL[method]} receipts` : "No receipts yet"} description="Money customers pay against what they owe appears here." />;
  else
    list = (
      <ul aria-label="Receipts" className="space-y-2">
        {receipts.data.data.map((r) => (
          <li key={r.id} className="space-y-1 rounded-lg border p-3 text-sm">
            <p className="flex flex-wrap justify-between gap-3">
              <span className="font-medium">
                Receipt {r.receiptNumber.toString()} · {r.customerName}
              </span>
              <span className="tabular-nums">KES {formatKES(r.amount)}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              {formatDate(r.receiptDate)} · {METHOD_LABEL[r.method]}
              {r.reference ? ` · ${r.reference}` : ""} · against {r.allocations.map((a) => `${a.saleNumber} (KES ${formatKES(a.amount)})`).join(", ")}
            </p>
          </li>
        ))}
      </ul>
    );
  return (
    <div className="space-y-4">
      <div className="max-w-xs">
        <SelectField id={ids.method} label="Paid by" value={method} onChange={(v) => setMethod(v as ReceiptMethod | "")}>
          <option value="">Any method</option>
          {(["MPESA", "CASH", "BANK"] as const).map((m) => (
            <option key={m} value={m}>
              {METHOD_LABEL[m]}
            </option>
          ))}
        </SelectField>
      </div>
      {list}
      {receipts.data ? (
        <p className="text-sm font-medium" aria-live="polite">
          {receipts.data.count.toString()} {receipts.data.count === 1 ? "receipt" : "receipts"} · KES {formatKES(receipts.data.totalReceived)}
        </p>
      ) : null}
    </div>
  );
}

export function Customers({ role }: { role: Role }) {
  const permissions = receivablesPermissions(role);
  const invalidate = useInvalidateReceivables();
  const tabs: Tab[] = [{ id: "customers", label: "Customers" }, ...(permissions.canReadReceivables ? [{ id: "aging", label: "Aging" }, { id: "receipts", label: "Receipts" }] : [])];
  const [active, setActive] = useState("customers");
  const [opened, setOpenedRaw] = useState<Opened | null>(null);
  const [recording, setRecording] = useState(false);
  const directory = useCustomers(permissions.canReadDirectory);
  // A customer opened from the aging still gets their profile where the role can read the directory.
  const setOpened = (next: Opened) => setOpenedRaw(next.customer ? next : { ...next, customer: directory.data?.data.find((c) => c.id === next.id) ?? null });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="font-display text-2xl font-semibold">Customers & receivables</h1>
          <p className="text-sm text-muted-foreground">{permissions.canReadReceivables ? "Who your customers are, what they owe on credit, and what they have paid." : "Your customers and their contact details."}</p>
        </div>
        {permissions.canRecordReceipt ? (
          <Button type="button" className="h-11" onClick={() => setRecording(true)}>
            Record receipt
          </Button>
        ) : null}
      </div>
      <div>
        <Tabs tabs={tabs} active={active} onChange={setActive} label="Customers and receivables" />
        <TabPanel id={active}>
          {active === "customers" ? permissions.canReadDirectory ? <Directory permissions={permissions} onOpen={setOpened} /> : <Owing onOpen={setOpened} /> : null}
          {active === "aging" && permissions.canReadReceivables ? <AgingView onOpen={setOpened} /> : null}
          {active === "receipts" && permissions.canReadReceivables ? <ReceiptsView /> : null}
        </TabPanel>
      </div>
      {opened ? (
        <CustomerSheet
          opened={opened}
          permissions={permissions}
          onClose={() => setOpenedRaw(null)}
          onSaved={(saved) => {
            void invalidate();
            setOpened({ id: saved.id, name: saved.name, customer: saved });
          }}
        />
      ) : null}
      {recording ? (
        <Sheet title="Record a receipt" onClose={() => setRecording(false)} wide>
          <ReceiptForm />
        </Sheet>
      ) : null}
    </div>
  );
}
