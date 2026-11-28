"use client";

import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ErrorState, LoadingState } from "@/components/states/states";
import { Done } from "@/components/stock/kit";
import { adminKeys, fetchTenant, REGIME_LABEL, STRUCTURE_LABEL, TENANT_STATUS_LABEL, type AdminPermissions } from "@/lib/admin/admin";
import { PROVIDER_LABEL, useBusinessUsers, useHealth } from "@/lib/admin/console";
import { formatDateTime } from "@/lib/datetime";
import { ROLE_LABEL } from "@/lib/people/people";
import type { Role } from "@/lib/auth/landing";
import { Ago, Panel, StatusMark, healthTone } from "./console/kit";
import { InviteMentor } from "./shared";
import { ActAsBusiness } from "./act-as";
import { LifecycleActions, TenantBadge } from "./tenants";

// THE BUSINESS DETAIL (M4.5 W5) — /admin/tenants/{id}: everything the PLATFORM knows about one
// business, and nothing from its books. Its registry profile; its integration HEALTH from the mirror
// (the last check and error — never a credential, never the Go-Live switch: those are the owner's);
// its users from the platform directory; the lifecycle, each step confirmed and deactivation flagged
// as final (the business's name must be typed); and support access — the one consented, logged,
// time-bounded way into its records.

export function BusinessDetail({ tenantId, permissions }: { tenantId: string; permissions: AdminPermissions }) {
  const queryClient = useQueryClient();
  const tenant = useQuery({ queryKey: [...adminKeys.all, "tenant", tenantId], queryFn: () => fetchTenant(tenantId), staleTime: 0 });
  const health = useHealth({ tenantId });
  const users = useBusinessUsers(tenantId);
  const [notice, setNotice] = useState<string | null>(null);

  if (tenant.isPending) return <LoadingState label="Loading the business" lines={5} />;
  if (tenant.isError) return <ErrorState title="Couldn’t load the business" description={tenant.error.message} onRetry={() => void tenant.refetch()} />;
  const t = tenant.data;
  const facts: Array<[string, string | null]> = [
    ["Subdomain", t.subdomain],
    ["Plan", `${t.subscriptionTier.charAt(0)}${t.subscriptionTier.slice(1).toLowerCase()} · ${t.subscriptionStatus.toLowerCase().replace("_", " ")}`],
    ["Tax regime", REGIME_LABEL[t.taxRegime] ?? t.taxRegime],
    ["KRA PIN", t.kraPin],
    ["Structure", t.businessStructure ? (STRUCTURE_LABEL[t.businessStructure] ?? t.businessStructure) : null],
    ["Sector", t.businessSector],
    ["County", t.county],
    ["Joined", formatDateTime(t.createdAt)],
    ["Business id", t.id],
  ];

  return (
    <div className="space-y-5">
      <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
        <Link href="/admin/tenants" className="underline-offset-4 hover:underline">
          Tenants
        </Link>{" "}
        / <span aria-current="page">{t.name}</span>
      </nav>
      <header className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h1 className="font-display text-2xl font-semibold tracking-tight">{t.name}</h1>
          <p className="text-sm text-muted-foreground">Platform record only — this page reads nothing from the business’s books.</p>
        </div>
        <TenantBadge status={t.status} />
      </header>
      {notice ? <Done>{notice}</Done> : null}

      <div className="grid gap-5 lg:grid-cols-[2fr_3fr]">
        <Panel title="Profile">
          <dl className="text-sm">
            {facts.map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4 border-b py-1.5 last:border-b-0">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className={v ? "break-all text-right" : "text-right text-muted-foreground"}>{v ?? "Not recorded"}</dd>
              </div>
            ))}
          </dl>
        </Panel>

        <div className="space-y-5">
          <Panel title="Integration health" description="The owner’s last check of each integration. Credentials and going live are the owner’s alone.">
            {health.isPending ? <LoadingState label="Loading integration health" lines={2} /> : null}
            {health.isError ? <ErrorState title="Couldn’t load integration health" description={health.error.message} onRetry={() => void health.refetch()} /> : null}
            {health.data && health.data.data.length === 0 ? <p className="text-sm text-muted-foreground">The owner has not checked an integration yet.</p> : null}
            {health.data && health.data.data.length > 0 ? (
              <ul aria-label="Integration health" className="divide-y text-sm">
                {health.data.data.map((row) => (
                  <li key={`${row.provider}-${row.environment}`} className="flex flex-wrap items-start justify-between gap-2 py-2">
                    <span>
                      <span className="font-medium">{PROVIDER_LABEL[row.provider] ?? row.provider}</span> <span className="text-xs text-muted-foreground">{row.environment.toLowerCase()}</span>
                      {row.lastError ? <span className="block text-xs text-destructive">{row.lastError}</span> : null}
                    </span>
                    <span className="flex items-center gap-3 text-xs text-muted-foreground">
                      <StatusMark tone={healthTone(row.status)}>{row.status.toLowerCase()}</StatusMark>
                      <Ago at={row.lastCheckAt} />
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </Panel>

          <Panel title="Lifecycle" description={TENANT_STATUS_LABEL[t.status]}>
            <LifecycleActions
              tenant={t}
              confirmName
              onDone={(note) => {
                setNotice(note);
                void queryClient.invalidateQueries();
              }}
            />
            {t.status === "ACTIVE" ? (
              <div className="mt-3">
                <InviteMentor tenantId={t.id} businessName={t.name} />
              </div>
            ) : null}
          </Panel>
        </div>
      </div>

      <Panel title="Users" href={permissions.isSuperAdmin ? "/admin/users" : undefined} linkLabel="Directory">
        {users.isPending ? <LoadingState label="Loading users" lines={2} /> : null}
        {users.isError ? <ErrorState title="Couldn’t load the users" description={users.error.message} onRetry={() => void users.refetch()} /> : null}
        {users.data && users.data.data.length === 0 ? <p className="text-sm text-muted-foreground">No one can sign in to this business yet.</p> : null}
        {users.data && users.data.data.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">People who can sign in to {t.name}</caption>
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-2 pr-3 font-medium">Name</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Role</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Status</th>
                  <th scope="col" className="py-2 font-medium">Last sign-in</th>
                </tr>
              </thead>
              <tbody>
                {users.data.data.map((u) => (
                  <tr key={u.id} className="border-b last:border-b-0">
                    <th scope="row" className="py-2 pr-3 text-left font-normal">
                      <span className="block font-medium">{u.fullName}</span>
                      <span className="block text-xs text-muted-foreground">{u.email}</span>
                    </th>
                    <td className="py-2 pr-3">{ROLE_LABEL[u.role as Role] ?? u.role}</td>
                    <td className="py-2 pr-3">
                      <StatusMark tone={u.isActive ? "ok" : "idle"}>{u.isActive ? "active" : "deactivated"}</StatusMark>
                    </td>
                    <td className="py-2 text-xs text-muted-foreground">
                      <Ago at={u.lastLoginAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Panel>

      <ActAsBusiness tenantId={t.id} businessName={t.name} businessActive={t.status !== "DEACTIVATED"} permissions={permissions} />
    </div>
  );
}
