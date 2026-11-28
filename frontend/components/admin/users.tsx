"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { TextField } from "@/components/auth/form-bits";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/states";
import { Done, SelectField } from "@/components/stock/kit";
import { Button } from "@/components/ui/button";
import type { Role } from "@/lib/auth/landing";
import { formatDateTime } from "@/lib/datetime";
import { AUDIT_LABEL, DELIVERY_LABEL, ROLE_LABEL } from "@/lib/people/people";
import {
  changeRole,
  inviteUser,
  PLATFORM_ROLES,
  revokeInvitation,
  setUserActive,
  TENANT_ROLES,
  useAudit,
  useDirectory,
  useInvalidateAdmin,
  useTenants,
  type AuditEntry,
  type DirectoryUser,
  type InviteResult,
} from "@/lib/admin/admin";
import { Confirm, ErrorLine, message, Page } from "./shared";

// USERS (SUPER_ADMIN only — a programme officer has no user management) and the AUDIT LOG (platform
// staff). The platform directory (GET /v1/users/directory, T-B-ADMIN-USER-LIST) lists every user to
// act on; the audit log names who did what. An invitation's code is never returned: it goes to the
// invitee only, in the link in their email (and SMS).

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isPlatform = (role: Role) => (PLATFORM_ROLES as readonly Role[]).includes(role);

function Invite({ onSent }: { onSent: (result: InviteResult) => void }) {
  const ids = { email: useId(), role: useId(), tenant: useId(), phone: useId() };
  const tenants = useTenants("ACTIVE");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role | "">("");
  const [tenantId, setTenantId] = useState("");
  const [phone, setPhone] = useState("");
  const [problems, setProblems] = useState<{ email?: string; role?: string; tenant?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const needsTenant = role !== "" && !isPlatform(role);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const next: typeof problems = {};
    if (!EMAIL.test(email.trim())) next.email = "Enter the person’s email address.";
    if (role === "") next.role = "Choose the role.";
    if (needsTenant && tenantId === "") next.tenant = "A business role needs its business.";
    setProblems(next);
    if (Object.keys(next).length > 0 || role === "") return;
    setSaving(true);
    setError(null);
    try {
      const result = await inviteUser({ email: email.trim(), role, ...(needsTenant ? { tenantId } : {}), ...(phone.trim() ? { phone: phone.trim().replace(/\s/g, "") } : {}) });
      setEmail("");
      setPhone("");
      onSent(result);
    } catch (failure) {
      setError(message(failure, "The invitation could not be sent. Please try again."));
    } finally {
      setSaving(false);
    }
  }
  return (
    <form noValidate aria-label="Invite a user" onSubmit={(e) => void submit(e)} className="max-w-xl space-y-3">
      <TextField id={ids.email} label="Email address" type="email" autoComplete="off" value={email} error={problems.email} onChange={(e) => setEmail(e.target.value)} />
      <div className="space-y-1">
        <SelectField id={ids.role} label="Role" value={role} onChange={(v) => setRole(v as Role | "")}>
          <option value="">Choose a role…</option>
          <optgroup label="Platform (no business)">
            {PLATFORM_ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </optgroup>
          <optgroup label="In a business">
            {TENANT_ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </optgroup>
        </SelectField>
        {problems.role ? <p className="text-sm text-destructive">{problems.role}</p> : null}
      </div>
      {needsTenant ? (
        <div className="space-y-1">
          <SelectField id={ids.tenant} label="Business" value={tenantId} onChange={setTenantId}>
            <option value="">Choose a business…</option>
            {(tenants.data?.data ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </SelectField>
          {problems.tenant ? <p className="text-sm text-destructive">{problems.tenant}</p> : null}
        </div>
      ) : null}
      <TextField id={ids.phone} label="Phone for an SMS copy" optional type="tel" autoComplete="off" value={phone} onChange={(e) => setPhone(e.target.value)} />
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      <Button type="submit" className="h-11" disabled={saving}>
        {saving ? "Sending…" : "Send invitation"}
      </Button>
    </form>
  );
}

function Sent({ sent, onRevoked }: { sent: InviteResult; onRevoked: (invitation: InviteResult["invitation"]) => void }) {
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const i = sent.invitation;
  async function revoke() {
    setSaving(true);
    setError(null);
    try {
      onRevoked(await revokeInvitation(i.id));
      setAsking(false);
    } catch (failure) {
      setError(message(failure, "The invitation could not be revoked."));
    } finally {
      setSaving(false);
    }
  }
  return (
    <li aria-label={`Invitation to ${i.email}`} className="space-y-2 rounded-lg border p-3 text-sm">
      <p className="break-all font-medium">{i.email}</p>
      <p className="text-xs text-muted-foreground">
        {ROLE_LABEL[i.role]} · {i.status === "PENDING" ? `open until ${formatDateTime(i.expiresAt)}` : i.status.toLowerCase()} · email {DELIVERY_LABEL[sent.delivery.email]}
      </p>
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      {i.status === "PENDING" ? (
        asking ? (
          <Confirm title={`Revoke the invitation to ${i.email}?`} yes="Yes, revoke it" busy={saving} destructive onBack={() => setAsking(false)} onYes={() => void revoke()}>
            <p>Their code stops working at once.</p>
          </Confirm>
        ) : (
          <Button type="button" variant="outline" className="h-11" onClick={() => setAsking(true)}>
            Revoke
          </Button>
        )
      ) : null}
    </li>
  );
}

type Act = { kind: "role"; role: Role } | { kind: "deactivate" } | { kind: "reactivate" };

/** One user in the directory, with the SUPER_ADMIN's actions on them. */
function DirectoryRow({ user }: { user: DirectoryUser }) {
  const roleId = useId();
  const invalidate = useInvalidateAdmin();
  const [role, setRole] = useState<Role | "">("");
  const [act, setAct] = useState<Act | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const roles: readonly Role[] = user.tenantId === null ? PLATFORM_ROLES : TENANT_ROLES;
  async function go() {
    if (!act) return;
    setSaving(true);
    setError(null);
    try {
      const next = act.kind === "role" ? await changeRole(user.id, act.role) : await setUserActive(user.id, act.kind === "reactivate");
      await invalidate();
      setAct(null);
      setRole("");
      setNotice(`${next.fullName} is ${ROLE_LABEL[next.role]}, ${next.isActive ? "active" : "deactivated"}.`);
    } catch (failure) {
      setAct(null);
      setError(message(failure, "That could not be done. Please try again."));
    } finally {
      setSaving(false);
    }
  }
  return (
    <li aria-label={user.fullName} className="space-y-2 rounded-lg border p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">{user.fullName}</p>
          <p className="break-all text-muted-foreground">{user.email}</p>
          <p className="text-xs text-muted-foreground">
            {ROLE_LABEL[user.role]} · {user.businessName ?? "Platform"}
            {user.lastLoginAt ? ` · last signed in ${formatDateTime(user.lastLoginAt)}` : " · has not signed in"}
          </p>
        </div>
        <span className="rounded-full border px-2 py-0.5 text-xs">{user.isActive ? "Active" : "Deactivated"}</span>
      </div>
      {notice ? <Done>{notice}</Done> : null}
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      {act ? (
        <Confirm
          title={act.kind === "role" ? `Change ${user.fullName} to ${ROLE_LABEL[act.role]}?` : act.kind === "deactivate" ? `Deactivate ${user.fullName}?` : `Reactivate ${user.fullName}?`}
          yes="Yes, do it"
          busy={saving}
          destructive={act.kind === "deactivate"}
          onBack={() => setAct(null)}
          onYes={() => void go()}
        >
          <p>{act.kind === "reactivate" ? "They can sign in again." : "They are signed out everywhere at once."}</p>
        </Confirm>
      ) : (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          {user.isActive ? (
            <>
              <div className="sm:w-56">
                <SelectField id={roleId} label={`New role for ${user.fullName}`} value={role} onChange={(v) => setRole(v as Role | "")}>
                  <option value="">Choose a role…</option>
                  {roles
                    .filter((r) => r !== user.role)
                    .map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABEL[r]}
                      </option>
                    ))}
                </SelectField>
              </div>
              <Button type="button" variant="outline" className="h-11" disabled={role === ""} onClick={() => role !== "" && setAct({ kind: "role", role })}>
                Change role
              </Button>
              <Button type="button" variant="outline" className="h-11" onClick={() => setAct({ kind: "deactivate" })}>
                Deactivate
              </Button>
            </>
          ) : (
            <Button type="button" variant="outline" className="h-11" onClick={() => setAct({ kind: "reactivate" })}>
              Reactivate
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

const PAGE = 25;

function Directory() {
  const ids = { q: useId(), role: useId() };
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  const [role, setRole] = useState<Role | "">("");
  const [page, setPage] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(typed.trim());
      setPage(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [typed]);
  const directory = useDirectory({ q, role, take: PAGE, skip: page * PAGE });
  const total = directory.data?.total ?? 0;
  return (
    <section aria-label="All users" className="space-y-3">
      <h2 className="font-medium">Everyone on the platform</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField id={ids.q} label="Search by name or email" type="search" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
        <SelectField
          id={ids.role}
          label="Role"
          value={role}
          onChange={(v) => {
            setRole(v as Role | "");
            setPage(0);
          }}
        >
          <option value="">Every role</option>
          {[...PLATFORM_ROLES, ...TENANT_ROLES].map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </SelectField>
      </div>
      {directory.isPending ? <LoadingState label="Loading users" lines={4} /> : null}
      {directory.isError ? <ErrorState title="Couldn’t load the users" description={directory.error.message} onRetry={() => void directory.refetch()} /> : null}
      {directory.isSuccess && directory.data.data.length === 0 ? <EmptyState title="No one matches" description="Try another name or role." /> : null}
      {directory.isSuccess && directory.data.data.length > 0 ? (
        <>
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {total.toString()} {total === 1 ? "user" : "users"}
          </p>
          <ul aria-label="Users" className="space-y-2">
            {directory.data.data.map((u) => (
              <DirectoryRow key={u.id} user={u} />
            ))}
          </ul>
          {total > PAGE ? (
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" className="h-11" disabled={page === 0} onClick={() => setPage(page - 1)}>
                Previous
              </Button>
              <span className="text-sm text-muted-foreground">
                Page {(page + 1).toString()} of {Math.ceil(total / PAGE).toString()}
              </span>
              <Button type="button" variant="outline" className="h-11" disabled={(page + 1) * PAGE >= total} onClick={() => setPage(page + 1)}>
                Next
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

export function Users() {
  const [sent, setSent] = useState<InviteResult[]>([]);
  return (
    <Page title="Users" intro="Invite platform staff, mentors and business users, and change a user’s role or access. Invitation codes go to the invitee only, by email (and SMS).">
      <Invite onSent={(r) => setSent((all) => [...all, r])} />
      {sent.length > 0 ? (
        <section aria-label="Invitations sent" className="space-y-2">
          <h2 className="font-medium">Sent from this screen</h2>
          <ul className="space-y-2">
            {[...sent].reverse().map((s) => (
              <Sent key={s.invitation.id} sent={s} onRevoked={(inv) => setSent((all) => all.map((x) => (x.invitation.id === inv.id ? { ...x, invitation: inv } : x)))} />
            ))}
          </ul>
        </section>
      ) : null}
      <Directory />
    </Page>
  );
}

function detail(entry: AuditEntry): string | null {
  const m = entry.metadata;
  if (typeof m !== "object" || m === null) return null;
  const meta = m as Record<string, unknown>;
  const parts = ["email", "fromRole", "toRole", "role", "reason", "from", "to"].filter((k) => typeof meta[k] === "string").map((k) => `${k}: ${String(meta[k])}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function Audit() {
  const tenantId = useId();
  const tenants = useTenants("");
  const [tenant, setTenant] = useState("");
  const [limit, setLimit] = useState(50);
  const audit = useAudit({ limit, tenantId: tenant });
  const nameOf = (id: string | null) => (id === null ? "the platform" : (tenants.data?.data.find((t) => t.id === id)?.name ?? id));
  return (
    <Page title="Audit" intro="The identity audit log: invitations, roles, sign-in recovery, onboarding and business lifecycle, newest first. It cannot be edited.">
      <div className="sm:w-72">
        <SelectField id={tenantId} label="Business" value={tenant} onChange={setTenant}>
          <option value="">Every business</option>
          {(tenants.data?.data ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </SelectField>
      </div>
      {audit.isPending ? <LoadingState label="Loading the audit log" lines={5} /> : null}
      {audit.isError ? <ErrorState title="Couldn’t load the audit log" description={audit.error.message} onRetry={() => void audit.refetch()} /> : null}
      {audit.isSuccess && audit.data.data.length === 0 ? <EmptyState title="Nothing recorded" description="Try another business." /> : null}
      {audit.isSuccess && audit.data.data.length > 0 ? (
        <ol aria-label="Audit log" className="divide-y rounded-lg border text-sm">
          {audit.data.data.map((e) => (
            <li key={e.id} className="space-y-0.5 p-3">
              <p className="font-medium">
                {AUDIT_LABEL[e.action] ?? e.action} <span className="font-normal text-muted-foreground">· {nameOf(e.tenantId)}</span>
              </p>
              <p className="text-xs text-muted-foreground">
                {formatDateTime(e.occurredAt)} · by {e.actorName ?? e.actorUserId ?? "someone signed out"}
                {e.targetUserId ? ` · for ${e.targetName ?? e.targetUserId}` : ""}
              </p>
              {detail(e) ? <p className="break-all text-xs text-muted-foreground">{detail(e)}</p> : null}
            </li>
          ))}
        </ol>
      ) : null}
      {audit.data && audit.data.data.length === limit && limit < 200 ? (
        <Button type="button" variant="outline" className="h-11" onClick={() => setLimit(200)}>
          Show older entries
        </Button>
      ) : null}
    </Page>
  );
}
