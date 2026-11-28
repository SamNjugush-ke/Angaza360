"use client";

import { useId, useState, type FormEvent } from "react";
import { TextField } from "@/components/auth/form-bits";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/states";
import { Done, SelectField, TabPanel, Tabs, type Tab } from "@/components/stock/kit";
import { Button } from "@/components/ui/button";
import { ApiHttpError } from "@/lib/dashboard/fetch";
import { formatDateTime } from "@/lib/datetime";
import {
  AUDIT_LABEL,
  changeRole,
  deactivateUser,
  DELIVERY_LABEL,
  EMAIL,
  inviteUser,
  isTenantRole,
  reactivateUser,
  revokeInvitation,
  ROLE_LABEL,
  ROLE_MEANING,
  TENANT_ROLES,
  useAudit,
  useInvalidatePeople,
  usePendingInvitations,
  useStaff,
  type AuditEntry,
  type Invitation,
  type InviteResult,
  type Staff,
  type TenantRole,
} from "@/lib/people/people";
import { cn } from "@/lib/utils";

// PEOPLE & ACCESS — the owner's view of who can sign in to the business and as what. The server
// holds every rule (who may grant which role; a business never loses its last active owner) and
// its refusals are shown in its own words. Changing a role or deactivating someone signs them out
// everywhere, because the old role is inside their session.
//
// INVITATIONS: the API never returns an invitation's code — it is a single-use secret delivered
// only to the invitee, by email (and SMS when a phone is given). So this screen shows how the
// message went and the invite page's address; the invitee enters the code from their message
// there. There is no list of open invitations in the API either, so the ones sent from this screen
// are kept for this visit, to be revoked if need be.

const message = (failure: unknown, fallback: string) => (failure instanceof ApiHttpError ? failure.message : fallback);

function ErrorLine({ children }: { children: string }) {
  return (
    <p role="alert" className="text-sm text-destructive">
      {children}
    </p>
  );
}

function RoleBadge({ role }: { role: Staff["role"] }) {
  return <span className="inline-block rounded-full border px-2 py-0.5 text-xs font-medium">{ROLE_LABEL[role]}</span>;
}

function ActiveBadge({ active }: { active: boolean }) {
  return (
    <span className={cn("inline-block rounded-full border px-2 py-0.5 text-xs font-medium", active ? "border-emerald-700/40 bg-emerald-700/10" : "border-destructive/40 bg-destructive/10")}>
      {active ? "Active" : "Deactivated"}
    </span>
  );
}

type Pending = { kind: "role"; role: TenantRole } | { kind: "deactivate" } | { kind: "reactivate" };

function Confirm({ person, pending, onBack, onDone }: { person: Staff; pending: Pending; onBack: () => void; onDone: (note: string) => void }) {
  const title = useId();
  const invalidate = useInvalidatePeople();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const words =
    pending.kind === "role"
      ? { ask: `Change ${person.fullName}’s role from ${ROLE_LABEL[person.role]} to ${ROLE_LABEL[pending.role]}?`, detail: "They are signed out everywhere and sign in again with the new role.", yes: "Yes, change the role" }
      : pending.kind === "deactivate"
        ? { ask: `Deactivate ${person.fullName}?`, detail: "They are signed out everywhere and can no longer sign in. Their history stays. You can reactivate them later.", yes: "Yes, deactivate" }
        : { ask: `Reactivate ${person.fullName}?`, detail: `They can sign in again as ${ROLE_LABEL[person.role]}.`, yes: "Yes, reactivate" };

  async function confirm() {
    setSaving(true);
    setError(null);
    try {
      const updated =
        pending.kind === "role" ? await changeRole(person.id, pending.role) : pending.kind === "deactivate" ? await deactivateUser(person.id) : await reactivateUser(person.id);
      await invalidate();
      onDone(
        pending.kind === "role"
          ? `${updated.fullName} is now ${ROLE_LABEL[updated.role]}. They have been signed out to pick up the new role.`
          : pending.kind === "deactivate"
            ? `${updated.fullName} is deactivated and signed out.`
            : `${updated.fullName} can sign in again.`,
      );
    } catch (failure) {
      setError(message(failure, "That could not be saved. Please try again."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div role="alertdialog" aria-labelledby={title} className="space-y-2 rounded-md border p-3 text-sm">
      <p id={title} className="font-medium">
        {words.ask}
      </p>
      <p>{words.detail}</p>
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      <div className="flex flex-col-reverse gap-2 sm:flex-row">
        <Button type="button" variant="outline" className="h-11" onClick={onBack} disabled={saving} data-autofocus>
          Back
        </Button>
        <Button type="button" className="h-11" onClick={() => void confirm()} disabled={saving} variant={pending.kind === "deactivate" ? "destructive" : "default"}>
          {saving ? "Saving…" : words.yes}
        </Button>
      </div>
    </div>
  );
}

function StaffRow({ person, self, onDone }: { person: Staff; self: boolean; onDone: (note: string) => void }) {
  const roleId = useId();
  const [role, setRole] = useState<TenantRole | "">("");
  const [pending, setPending] = useState<Pending | null>(null);
  const changeable = isTenantRole(person.role);

  return (
    <li aria-label={person.fullName} className="space-y-3 rounded-lg border p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">
            {person.fullName}
            {self ? <span className="font-normal text-muted-foreground"> (you)</span> : null}
          </p>
          <p className="break-all text-muted-foreground">{person.email}</p>
          <p className="text-xs text-muted-foreground">{person.lastLoginAt ? `Last signed in ${formatDateTime(person.lastLoginAt)}` : "Has not signed in yet"}</p>
        </div>
        <div className="flex flex-wrap gap-1">
          <RoleBadge role={person.role} />
          <ActiveBadge active={person.isActive} />
        </div>
      </div>
      {self ? (
        <p className="text-xs text-muted-foreground">You can’t change your own role or deactivate yourself here — another owner would do that, so the business is never left without one.</p>
      ) : pending ? (
        <Confirm
          person={person}
          pending={pending}
          onBack={() => setPending(null)}
          onDone={(note) => {
            setPending(null);
            setRole("");
            onDone(note);
          }}
        />
      ) : changeable ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          {person.isActive ? (
            <>
              <div className="sm:w-64">
                <SelectField id={roleId} label={`New role for ${person.fullName}`} value={role} onChange={(v) => setRole(v as TenantRole | "")}>
                  <option value="">Choose a role…</option>
                  {TENANT_ROLES.filter((r) => r !== person.role).map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABEL[r]}
                    </option>
                  ))}
                </SelectField>
              </div>
              <Button type="button" variant="outline" className="h-11" disabled={role === ""} onClick={() => role !== "" && setPending({ kind: "role", role })}>
                Change role
              </Button>
              <Button type="button" variant="outline" className="h-11" onClick={() => setPending({ kind: "deactivate" })}>
                Deactivate
              </Button>
            </>
          ) : (
            <Button type="button" variant="outline" className="h-11" onClick={() => setPending({ kind: "reactivate" })}>
              Reactivate
            </Button>
          )}
        </div>
      ) : null}
    </li>
  );
}

function StaffView({ selfId }: { selfId: string }) {
  const staff = useStaff();
  const [notice, setNotice] = useState<string | null>(null);
  if (staff.isPending) return <LoadingState label="Loading your staff" lines={4} />;
  if (staff.isError) return <ErrorState title="Couldn’t load your staff" description={staff.error.message} onRetry={() => void staff.refetch()} />;
  const people = staff.data.data;
  return (
    <div className="space-y-4">
      {notice ? <Done>{notice}</Done> : null}
      <p className="text-sm text-muted-foreground">Everyone who can sign in to this business. Changing a role or deactivating someone signs them out at once.</p>
      {people.length === 0 ? (
        <EmptyState title="No staff yet" description="Invite someone from the Invitations tab." />
      ) : (
        <ul aria-label="Staff" className="space-y-2">
          {people.map((person) => (
            <StaffRow key={person.id} person={person} self={person.id === selfId} onDone={setNotice} />
          ))}
        </ul>
      )}
    </div>
  );
}

function InviteForm({ onInvited }: { onInvited: (result: InviteResult) => void }) {
  const ids = { email: useId(), role: useId(), phone: useId() };
  const invalidate = useInvalidatePeople();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<TenantRole | "">("");
  const [phone, setPhone] = useState("");
  const [problems, setProblems] = useState<{ email?: string; role?: string; phone?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const next: typeof problems = {};
    if (!EMAIL.test(email.trim())) next.email = "Enter the person’s email address, e.g. jane@example.com.";
    if (role === "") next.role = "Choose the role they will have.";
    if (phone.trim() !== "" && !/^\+?\d{7,15}$/.test(phone.trim().replace(/\s/g, ""))) next.phone = "Enter a phone number of 7 to 15 digits, e.g. 0712345678, or leave it empty.";
    setProblems(next);
    if (Object.keys(next).length > 0 || role === "") return;
    setSaving(true);
    setError(null);
    try {
      const trimmedPhone = phone.trim().replace(/\s/g, "");
      const result = await inviteUser({ email: email.trim(), role, ...(trimmedPhone !== "" ? { phone: trimmedPhone } : {}) });
      await invalidate();
      setEmail("");
      setRole("");
      setPhone("");
      onInvited(result);
    } catch (failure) {
      // Keep everything typed; the server's words say what to change.
      setError(message(failure, "The invitation could not be sent. Please try again."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form noValidate onSubmit={(e) => void submit(e)} aria-label="Invite someone" className="max-w-lg space-y-3">
      <TextField id={ids.email} label="Email address" type="email" autoComplete="off" value={email} error={problems.email} onChange={(e) => setEmail(e.target.value)} />
      <div className="space-y-1">
        <SelectField id={ids.role} label="Role" value={role} onChange={(v) => setRole(v as TenantRole | "")} hint={role !== "" ? ROLE_MEANING[role] : "What they will be able to do in this business."}>
          <option value="">Choose a role…</option>
          {TENANT_ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </SelectField>
        {problems.role ? <p className="text-sm text-destructive">{problems.role}</p> : null}
      </div>
      <TextField id={ids.phone} label="Phone for an SMS copy" optional type="tel" autoComplete="off" value={phone} error={problems.phone} onChange={(e) => setPhone(e.target.value)} />
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      <Button type="submit" className="h-11" disabled={saving}>
        {saving ? "Sending…" : "Send invitation"}
      </Button>
    </form>
  );
}

function OpenInvitation({ invitation: i, delivery }: { invitation: Invitation; delivery: InviteResult["delivery"] | undefined }) {
  const title = useId();
  const invalidate = useInvalidatePeople();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  async function revoke() {
    setSaving(true);
    setError(null);
    try {
      await revokeInvitation(i.id);
      await invalidate();
      setAsking(false);
    } catch (failure) {
      setError(message(failure, "The invitation could not be revoked. Please try again."));
    } finally {
      setSaving(false);
    }
  }
  return (
    <li aria-label={`Invitation to ${i.email}`} className="space-y-2 rounded-lg border p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="break-all font-medium">{i.email}</p>
          <p className="text-muted-foreground">
            {ROLE_LABEL[i.role]} · open until {formatDateTime(i.expiresAt)}
          </p>
          {delivery ? (
            <p className="text-xs text-muted-foreground">
              Email {DELIVERY_LABEL[delivery.email]}
              {delivery.sms ? ` · SMS ${DELIVERY_LABEL[delivery.sms]}` : ""}
            </p>
          ) : null}
        </div>
      </div>
      {delivery && delivery.email === "FAILED" && (delivery.sms === null || delivery.sms === "FAILED") ? (
        <p className="text-sm text-destructive">The invitation could not be delivered, so they have no link. Revoke it, check the address, and invite again.</p>
      ) : null}
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      {asking ? (
          <div role="alertdialog" aria-labelledby={title} className="space-y-2 rounded-md border p-3">
            <p id={title} className="font-medium">
              Revoke the invitation to {i.email}?
            </p>
            <p>Their code stops working at once. You can invite them again afterwards.</p>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button type="button" variant="outline" className="h-11" onClick={() => setAsking(false)} disabled={saving} data-autofocus>
                Back
              </Button>
              <Button type="button" variant="destructive" className="h-11" onClick={() => void revoke()} disabled={saving}>
                {saving ? "Revoking…" : "Yes, revoke it"}
              </Button>
            </div>
          </div>
        ) : (
          <Button type="button" variant="outline" className="h-11" onClick={() => setAsking(true)}>
            Revoke
          </Button>
        )}
    </li>
  );
}

function InvitationsView({ sent, onSent }: { sent: readonly InviteResult[]; onSent: (result: InviteResult) => void }) {
  const heading = useId();
  const open = usePendingInvitations();
  const latest = sent.at(-1);
  const deliveryOf = (id: string) => sent.find((s) => s.invitation.id === id)?.delivery;
  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <p className="text-sm text-muted-foreground">
          The person gets a link by email — and by SMS if you add a phone. Opening it fills in their single-use code; they choose their own password. The code is never shown to you: only the person invited holds it.
        </p>
        <InviteForm onInvited={onSent} />
      </section>
      {latest ? (
        <p role="status" className="rounded-md border border-emerald-700/40 bg-emerald-700/10 p-3 text-sm">
          Invitation sent to <span className="font-medium">{latest.invitation.email}</span> as {ROLE_LABEL[latest.invitation.role]} — email {DELIVERY_LABEL[latest.delivery.email]}
          {latest.delivery.sms ? `, SMS ${DELIVERY_LABEL[latest.delivery.sms]}` : ""}. Their message carries the link to accept.
        </p>
      ) : null}
      <section aria-labelledby={heading} className="space-y-2">
        <h2 id={heading} className="font-medium">
          Open invitations
        </h2>
        <p className="text-xs text-muted-foreground">Invitations not yet accepted, revoked or expired. Someone who has accepted appears on the Staff tab.</p>
        {open.isPending ? <LoadingState label="Loading invitations" lines={2} /> : null}
        {open.isError ? <ErrorState title="Couldn’t load the invitations" description={open.error.message} onRetry={() => void open.refetch()} /> : null}
        {open.isSuccess && open.data.data.length === 0 ? <p className="text-sm text-muted-foreground">None open.</p> : null}
        {open.isSuccess && open.data.data.length > 0 ? (
          <ul aria-label="Open invitations" className="space-y-2">
            {open.data.data.map((invitation) => (
              <OpenInvitation key={invitation.id} invitation={invitation} delivery={deliveryOf(invitation.id)} />
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}

function auditDetail(entry: AuditEntry): string | null {
  const m = entry.metadata;
  if (typeof m !== "object" || m === null) return null;
  const meta = m as Record<string, unknown>;
  const role = (value: unknown) => (typeof value === "string" && value in ROLE_LABEL ? ROLE_LABEL[value as Staff["role"]] : null);
  const parts: string[] = [];
  if (typeof meta.email === "string") parts.push(meta.email);
  const from = role(meta.fromRole);
  const to = role(meta.toRole);
  if (from && to) parts.push(`${from} → ${to}`);
  else if (role(meta.role)) parts.push(role(meta.role) ?? "");
  if (typeof meta.reason === "string") parts.push(meta.reason);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function AuditView() {
  const [limit, setLimit] = useState(50);
  const audit = useAudit(limit);
  const staff = useStaff();
  const nameOf = (id: string | null) => (id === null ? null : (staff.data?.data.find((p) => p.id === id)?.fullName ?? "someone no longer listed"));
  if (audit.isPending) return <LoadingState label="Loading the audit log" lines={5} />;
  if (audit.isError) return <ErrorState title="Couldn’t load the audit log" description={audit.error.message} onRetry={() => void audit.refetch()} />;
  const entries = audit.data.data;
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Every invitation, role change, deactivation and password event in this business, newest first. It cannot be edited or deleted.</p>
      {entries.length === 0 ? (
        <EmptyState title="Nothing recorded yet" description="Inviting someone or changing a role is recorded here." />
      ) : (
        <ol aria-label="Audit log" className="divide-y rounded-lg border text-sm">
          {entries.map((entry) => {
            const actor = entry.actorUserId === null ? "Someone signed out" : (entry.actorName ?? nameOf(entry.actorUserId));
            const target = entry.targetUserId === null ? null : (entry.targetName ?? nameOf(entry.targetUserId));
            const detail = auditDetail(entry);
            return (
              <li key={entry.id} className="space-y-0.5 p-3">
                <p className="font-medium">{AUDIT_LABEL[entry.action] ?? entry.action}</p>
                <p className="text-muted-foreground">
                  {formatDateTime(entry.occurredAt)} · by {actor}
                  {target && entry.targetUserId !== entry.actorUserId ? ` · for ${target}` : ""}
                </p>
                {detail ? <p className="break-all text-xs text-muted-foreground">{detail}</p> : null}
              </li>
            );
          })}
        </ol>
      )}
      {entries.length === limit && limit < 200 ? (
        <Button type="button" variant="outline" className="h-11" onClick={() => setLimit(200)}>
          Show older entries
        </Button>
      ) : null}
    </div>
  );
}

const TABS: readonly Tab[] = [
  { id: "staff", label: "Staff" },
  { id: "invitations", label: "Invitations" },
  { id: "audit", label: "Audit log" },
];

export function People({ selfId }: { selfId: string }) {
  const [active, setActive] = useState("staff");
  const [sent, setSent] = useState<InviteResult[]>([]);
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="font-display text-2xl font-semibold">People & access</h1>
        <p className="text-sm text-muted-foreground">Who can sign in to the business, and what each person may do.</p>
      </div>
      <div>
        <Tabs tabs={TABS} active={active} onChange={setActive} label="People & access" />
        <TabPanel id={active}>
          {active === "staff" ? <StaffView selfId={selfId} /> : null}
          {active === "invitations" ? (
            <InvitationsView
              sent={sent}
              onSent={(result) => setSent((all) => [...all, result])}
            />
          ) : null}
          {active === "audit" ? <AuditView /> : null}
        </TabPanel>
      </div>
    </div>
  );
}
