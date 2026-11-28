"use client";

import { Plus } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { TextField } from "@/components/auth/form-bits";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/states";
import { Done, SelectField } from "@/components/stock/kit";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { formatDate } from "@/lib/datetime";
import { formatKES } from "@/lib/money";
import {
  addMember,
  closeProject,
  createProject,
  removeMember,
  useAggregate,
  useInvalidateAdmin,
  useProject,
  useProjects,
  useTenants,
  type Member,
  type Project,
} from "@/lib/admin/admin";
import { Confirm, ErrorLine, message, Page } from "./shared";

// DONOR PROJECTS — cohorts of businesses a donor funds. A business added to a project is a member
// PENDING its owner's consent; its books are opened (each read logged for the owner) ONLY while that
// consent stands, so the cohort aggregate counts consented businesses alone and says how many were
// left out. Closing a project is final.

const CONSENT: Readonly<Record<Member["consentStatus"], string>> = { PENDING: "Awaiting the owner’s consent", CONSENTED: "Consented", WITHDRAWN: "Consent withdrawn" };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

function NewProject({ onDone, onCancel }: { onDone: (note: string) => void; onCancel: () => void }) {
  const ids = { code: useId(), name: useId(), donor: useId(), description: useId() };
  const invalidate = useInvalidateAdmin();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [donor, setDonor] = useState("");
  const [description, setDescription] = useState("");
  const [problems, setProblems] = useState<{ code?: string; name?: string; donor?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const next: typeof problems = {};
    if (code.trim().length < 2) next.code = "Give the project a short code, e.g. GROW-26.";
    if (name.trim() === "") next.name = "Name the project.";
    if (donor.trim() === "") next.donor = "Name the donor.";
    setProblems(next);
    if (Object.keys(next).length > 0) return;
    setSaving(true);
    setError(null);
    try {
      const done = await createProject({ code: code.trim(), name: name.trim(), donor: donor.trim(), ...(description.trim() ? { description: description.trim() } : {}) });
      await invalidate();
      onDone(`${done.project.name} created${done.seeded > 0 ? ` with ${done.seeded.toString()} businesses already tagged with ${done.project.code} — each awaits its owner’s consent` : ""}.`);
    } catch (failure) {
      setError(message(failure, "The project could not be created. Please try again."));
    } finally {
      setSaving(false);
    }
  }
  return (
    <form noValidate aria-label="New donor project" onSubmit={(e) => void submit(e)} className="space-y-3">
      <TextField id={ids.code} label="Code" autoComplete="off" hint="Businesses onboarded with this code join it automatically." value={code} error={problems.code} onChange={(e) => setCode(e.target.value)} />
      <TextField id={ids.name} label="Project name" autoComplete="off" value={name} error={problems.name} onChange={(e) => setName(e.target.value)} />
      <TextField id={ids.donor} label="Donor" autoComplete="off" value={donor} error={problems.donor} onChange={(e) => setDonor(e.target.value)} />
      <TextField id={ids.description} label="Description" optional autoComplete="off" value={description} onChange={(e) => setDescription(e.target.value)} />
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      <div className="flex flex-col-reverse gap-2 sm:flex-row">
        <Button type="button" variant="outline" className="h-11" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" className="h-11" disabled={saving}>
          {saving ? "Creating…" : "Create the project"}
        </Button>
      </div>
    </form>
  );
}

function AggregateView({ projectId }: { projectId: string }) {
  const ids = { month: useId(), year: useId() };
  const now = new Date();
  const [month, setMonth] = useState(String(now.getUTCMonth() + 1));
  const [year, setYear] = useState(String(now.getUTCFullYear()));
  const [period, setPeriod] = useState<Record<string, string> | null>(null);
  const aggregate = useAggregate(projectId, period);
  const a = aggregate.data;
  return (
    <section aria-label="Cohort aggregate" className="space-y-3 rounded-md border p-3">
      <h3 className="font-medium">Cohort figures</h3>
      <p className="text-sm text-muted-foreground">Only businesses whose owners have consented are read — each read is logged for that owner.</p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="sm:w-40">
          <SelectField id={ids.month} label="Month" value={month} onChange={setMonth}>
            {MONTHS.map((m, i) => (
              <option key={m} value={String(i + 1)}>
                {m}
              </option>
            ))}
          </SelectField>
        </div>
        <div className="sm:w-32">
          <SelectField id={ids.year} label="Year" value={year} onChange={setYear}>
            {[now.getUTCFullYear() - 1, now.getUTCFullYear()].map((y) => (
              <option key={y} value={String(y)}>
                {y}
              </option>
            ))}
          </SelectField>
        </div>
        <Button type="button" className="h-11" onClick={() => setPeriod({ year, month })}>
          Compute
        </Button>
      </div>
      {period && aggregate.isPending ? <LoadingState label="Reading the consenting businesses" lines={2} /> : null}
      {aggregate.isError ? <ErrorLine>{aggregate.error.message}</ErrorLine> : null}
      {a ? (
        <div className="space-y-2 text-sm">
          <p>
            {formatDate(a.period.from)} – {formatDate(a.period.to)}: <strong>{a.businessesIncluded.toString()}</strong> of {a.members.total.toString()} businesses included ({a.members.pending.toString()} awaiting consent, {a.members.withdrawn.toString()} withdrawn
            {a.members.consentedButInactive > 0 ? `, ${a.members.consentedButInactive.toString()} consented but not active` : ""}).
          </p>
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {(
              [
                ["Total revenue", `KES ${formatKES(a.totalRevenue)}`],
                ["Median revenue", `KES ${formatKES(a.medianRevenue)}`],
                ["Total net profit", `KES ${formatKES(a.totalNetProfit)}`],
                ["Revenue growth", a.revenueGrowthPct === null ? "—" : `${a.revenueGrowthPct}%`],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="rounded-lg border p-2">
                <dt className="text-xs text-muted-foreground">{k}</dt>
                <dd className="font-semibold tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
          {a.consentedMembers.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[30rem]">
                <caption className="sr-only">Each consenting business, in Kenya shillings</caption>
                <thead>
                  <tr className="border-b text-right text-xs text-muted-foreground">
                    <th scope="col" className="py-1 text-left font-medium">
                      Business
                    </th>
                    <th scope="col" className="py-1 font-medium">
                      Revenue
                    </th>
                    <th scope="col" className="py-1 font-medium">
                      Before
                    </th>
                    <th scope="col" className="py-1 font-medium">
                      Net profit
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {a.consentedMembers.map((m) => (
                    <tr key={m.tenantId} className="border-b text-right tabular-nums last:border-b-0">
                      <th scope="row" className="py-1 text-left font-normal">
                        {m.businessName}
                      </th>
                      <td className="py-1">{formatKES(m.revenue)}</td>
                      <td className="py-1">{formatKES(m.comparativeRevenue)}</td>
                      <td className="py-1">{formatKES(m.netProfit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function MemberRow({ projectId, member, active }: { projectId: string; member: Member; active: boolean }) {
  const invalidate = useInvalidateAdmin();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  async function remove() {
    setSaving(true);
    setError(null);
    try {
      await removeMember(projectId, member.tenantId);
      await invalidate();
    } catch (failure) {
      setAsking(false);
      setError(message(failure, "The business could not be removed. Please try again."));
    } finally {
      setSaving(false);
    }
  }
  return (
    <li aria-label={member.businessName} className="space-y-2 rounded-lg border p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-medium">{member.businessName}</p>
          <p className="text-xs text-muted-foreground">
            Joined {formatDate(member.joinedAt)}
            {member.consentAt ? ` · consent ${formatDate(member.consentAt)}` : ""} · business {member.tenantStatus.toLowerCase()}
          </p>
        </div>
        <span className="rounded-full border px-2 py-0.5 text-xs">{CONSENT[member.consentStatus]}</span>
      </div>
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      {active ? (
        asking ? (
          <Confirm title={`Remove ${member.businessName} from the project?`} yes="Yes, remove it" busy={saving} destructive onBack={() => setAsking(false)} onYes={() => void remove()}>
            <p>Its figures stop counting in the cohort. Reads already logged stay in its owner’s log.</p>
          </Confirm>
        ) : (
          <Button type="button" variant="outline" className="h-11" onClick={() => setAsking(true)} aria-label={`Remove ${member.businessName}`}>
            Remove
          </Button>
        )
      ) : null}
    </li>
  );
}

function ProjectDetail({ projectId, onClosed }: { projectId: string; onClosed: (note: string) => void }) {
  const tenantId = useId();
  const invalidate = useInvalidateAdmin();
  const project = useProject(projectId);
  const tenants = useTenants("ACTIVE");
  const [adding, setAdding] = useState("");
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  if (project.isPending) return <LoadingState label="Loading the project" lines={4} />;
  if (project.isError) return <ErrorState title="Couldn’t load the project" description={project.error.message} onRetry={() => void project.refetch()} />;
  const { project: p, members } = project.data;
  const active = p.status === "ACTIVE";
  const candidates = (tenants.data?.data ?? []).filter((t) => !members.some((m) => m.tenantId === t.id));
  async function add() {
    if (adding === "") {
      setError("Choose a business to add.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const member = await addMember(p.id, adding);
      await invalidate();
      setAdding("");
      setNotice(`${member.businessName} added. Its figures are read only once its owner consents.`);
    } catch (failure) {
      setError(message(failure, "The business could not be added. Please try again."));
    } finally {
      setSaving(false);
    }
  }
  async function close() {
    setSaving(true);
    setError(null);
    try {
      await closeProject(p.id);
      await invalidate();
      onClosed(`${p.name} is closed.`);
    } catch (failure) {
      setClosing(false);
      setError(message(failure, "The project could not be closed. Please try again."));
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {p.code} · {p.donor} · {active ? "active" : `closed ${p.closedAt ? formatDate(p.closedAt) : ""}`}
      </p>
      {notice ? <Done>{notice}</Done> : null}
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      {active ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="sm:w-72">
            <SelectField id={tenantId} label="Add a business" value={adding} onChange={setAdding}>
              <option value="">Choose a business…</option>
              {candidates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </SelectField>
          </div>
          <Button type="button" className="h-11" disabled={saving} onClick={() => void add()}>
            Add
          </Button>
        </div>
      ) : null}
      {members.length === 0 ? <EmptyState title="No members yet" description="Add businesses; each owner is asked to consent." /> : null}
      <ul aria-label="Members" className="space-y-2">
        {members.map((m) => (
          <MemberRow key={m.id} projectId={p.id} member={m} active={active} />
        ))}
      </ul>
      {active ? <AggregateView projectId={p.id} /> : null}
      {active ? (
        closing ? (
          <Confirm title={`Close ${p.name}?`} yes="Yes, close it" busy={saving} destructive onBack={() => setClosing(false)} onYes={() => void close()}>
            <p>It is final: members are no longer read and consent no longer changes.</p>
          </Confirm>
        ) : (
          <Button type="button" variant="outline" className="h-11" onClick={() => setClosing(true)}>
            Close the project
          </Button>
        )
      ) : null}
    </div>
  );
}

export function DonorProjects() {
  const statusId = useId();
  const [status, setStatus] = useState<Project["status"] | "">("ACTIVE");
  const projects = useProjects(status);
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const done = (note: string) => {
    setOpen(null);
    setCreating(false);
    setNotice(note);
  };
  return (
    <Page
      title="Donor projects"
      intro="Cohorts of businesses a donor funds. A business’s figures count only once its owner consents."
      action={
        <Button type="button" className="h-11" onClick={() => setCreating(true)}>
          <Plus className="size-4" aria-hidden /> New project
        </Button>
      }
    >
      {notice ? <Done>{notice}</Done> : null}
      <div className="sm:w-56">
        <SelectField id={statusId} label="Status" value={status} onChange={(v) => setStatus(v as Project["status"] | "")}>
          <option value="">Every project</option>
          <option value="ACTIVE">Active</option>
          <option value="CLOSED">Closed</option>
        </SelectField>
      </div>
      {projects.isPending ? <LoadingState label="Loading projects" lines={3} /> : null}
      {projects.isError ? <ErrorState title="Couldn’t load the projects" description={projects.error.message} onRetry={() => void projects.refetch()} /> : null}
      {projects.isSuccess && projects.data.data.length === 0 ? <EmptyState title="No projects" description="Create a project for a donor’s cohort." /> : null}
      {projects.isSuccess && projects.data.data.length > 0 ? (
        <ul aria-label="Donor projects" className="space-y-2">
          {projects.data.data.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => setOpen(p.id)}
                className="flex min-h-11 w-full flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span>
                  <span className="font-medium">{p.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {p.code} · {p.donor}
                  </span>
                </span>
                <span className="rounded-full border px-2 py-0.5 text-xs">{p.status === "ACTIVE" ? "Active" : "Closed"}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {creating ? (
        <Sheet title="New donor project" onClose={() => setCreating(false)}>
          <NewProject onDone={done} onCancel={() => setCreating(false)} />
        </Sheet>
      ) : null}
      {open ? (
        <Sheet key={open} title="Donor project" onClose={() => setOpen(null)} wide>
          <ProjectDetail projectId={open} onClosed={done} />
        </Sheet>
      ) : null}
    </Page>
  );
}
