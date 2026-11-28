"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { startActingAs, stopActingAs } from "@/lib/admin/console";
import type { AdminPermissions } from "@/lib/admin/admin";
import { Panel } from "./console/kit";
import { Confirm, ErrorLine } from "./shared";

// ACT AS A BUSINESS — standing god-mode (M4.5 W5). A SUPER_ADMIN enters a business's own workspace
// and operates as it: reading and writing through the ordinary merchant screens, above every
// tenant-role gate, with no grant and no approval. There is nothing to request or schedule — it is
// standing access. The business's owners are not asked and cannot block it, but EVERY action is
// recorded where they can see it (attributed to the platform operator), so this is not covert. A
// banner across the top of the workspace shows the operator they are acting, with a way to stop.

export function ActAsBusiness({ tenantId, businessName, businessActive, permissions }: { tenantId: string; businessName: string; businessActive: boolean; permissions: AdminPermissions }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!permissions.isSuperAdmin) {
    return (
      <Panel title="Act as this business">
        <p className="text-sm text-muted-foreground">Only a super-administrator can enter a business’s workspace to act on its behalf.</p>
      </Panel>
    );
  }

  async function enter() {
    setBusy(true);
    setError(null);
    try {
      await startActingAs(tenantId, businessName);
      // Into the business's own workspace; refresh so the server re-reads the act-as cookie.
      router.push("/dashboard");
      router.refresh();
    } catch {
      setBusy(false);
      setError("Could not start acting as this business. Please try again.");
    }
  }

  return (
    <Panel title="Act as this business" description="Standing operator access: enter this business’s workspace and act on its behalf.">
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          You will operate as <span className="font-medium text-foreground">{businessName}</span> through its own screens — reading and writing its records. There is no approval and nothing expires. Every action you take is recorded in this business’s activity log, attributed to “Platform operator”, and in the internal audit log under your name. The owners cannot see your name, but always see that an operator acted.
        </p>
        {error ? <ErrorLine>{error}</ErrorLine> : null}
        {!businessActive ? (
          <p className="text-muted-foreground">This business is not active, so its workspace cannot be entered.</p>
        ) : confirming ? (
          <Confirm title={`Act as ${businessName}?`} yes="Enter the workspace" busy={busy} onBack={() => setConfirming(false)} onYes={() => void enter()}>
            <p>You will be taken into {businessName}’s workspace and act on its behalf until you stop. Everything you do is logged.</p>
          </Confirm>
        ) : (
          <Button type="button" className="h-11" onClick={() => setConfirming(true)}>
            Act as this business
          </Button>
        )}
      </div>
    </Panel>
  );
}

/** The banner shown across a workspace while an operator is acting as a business. */
export function ActingAsBanner({ name }: { name: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function stop() {
    setBusy(true);
    await stopActingAs();
    router.push("/admin");
    router.refresh();
  }
  return (
    <div role="status" className="flex flex-wrap items-center justify-between gap-2 border-b border-angaza-gold/50 bg-angaza-gold/15 px-4 py-2 text-sm print:hidden">
      <span>
        You are acting as <span className="font-semibold">{name}</span> as a platform operator. Everything you do is recorded in this business’s activity log.
      </span>
      <Button type="button" variant="outline" size="sm" className="h-8" disabled={busy} onClick={() => void stop()}>
        {busy ? "Stopping…" : "Stop acting as this business"}
      </Button>
    </div>
  );
}
