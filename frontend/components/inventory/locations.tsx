"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { FormAlert, TextField } from "@/components/auth/form-bits";
import { useWorkingLocation } from "@/components/shell/location";
import { EmptyState, ErrorState, LoadingState } from "@/components/states/states";
import { SelectField } from "@/components/stock/kit";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { ApiHttpError } from "@/lib/dashboard/fetch";
import {
  createLocation,
  inventoryKeys,
  LOCATION_TYPE_LABEL,
  setLocationActive,
  updateLocation,
  useLocations,
  type Location,
  type LocationCreateBody,
  type LocationType,
  type LocationUpdateBody,
} from "@/lib/inventory/inventory";
import { cn } from "@/lib/utils";

// Locations: every place that owns stock — the main store, tills, an online shop, branches. Each
// has a TYPE and a POLICY: whether it works offline, how long an offline lease lasts before unsold
// stock freezes (or never), and an optional daily session window. The policy is stored here and
// enforced by the offline server. MAIN is fixed: it cannot be created, retyped or deactivated, and
// a location still holding stock cannot be deactivated (the server says what it holds).

const CREATABLE: readonly LocationType[] = ["POS", "BRANCH", "ECOMMERCE", "ATTENDANT"];
const CODE = /^[A-Z0-9_-]{1,24}$/;
const BADGE = "inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium";

export function policyOf(location: Location): string {
  if (!location.isOfflineCapable) return "Online only";
  const lease = location.leaseWindowMinutes === null ? "lease never expires" : `lease ${location.leaseWindowMinutes.toString()} min`;
  const session = location.sessionStart && location.sessionEnd ? ` · open ${location.sessionStart}–${location.sessionEnd}` : "";
  return `Works offline · ${lease}${session}`;
}

function LocationForm({ location, onSaved }: { location: Location | null; onSaved: (saved: Location) => void }) {
  const ids = { name: useId(), code: useId(), type: useId(), offline: useId(), lease: useId(), minutes: useId(), start: useId(), end: useId(), error: useId() };
  const isMain = location?.type === "MAIN";
  const [name, setName] = useState(location?.name ?? "");
  const [code, setCode] = useState("");
  const [type, setType] = useState<LocationType>(location?.type ?? "POS");
  const [offline, setOffline] = useState(location?.isOfflineCapable ?? false);
  const [forever, setForever] = useState(location ? location.leaseWindowMinutes === null && location.isOfflineCapable : false);
  const [minutes, setMinutes] = useState(location?.leaseWindowMinutes?.toString() ?? "480");
  const [start, setStart] = useState(location?.sessionStart ?? "");
  const [end, setEnd] = useState(location?.sessionEnd ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const offlineAllowed = type !== "MAIN" && type !== "ECOMMERCE";

  async function submit(event: FormEvent) {
    event.preventDefault();
    const found: Record<string, string> = {};
    if (name.trim() === "") found.name = "Give the location a name.";
    if (!location && !CODE.test(code.trim().toUpperCase())) found.code = "1–24 letters, digits, - or _, e.g. TILL-2.";
    const useOffline = offlineAllowed && offline;
    if (useOffline && !forever && !/^[1-9]\d*$/.test(minutes.trim())) found.minutes = "Enter whole minutes above 0 (480 is 8 hours), or choose Never expires.";
    if ((start === "") !== (end === "")) found.session = "Set both the opening and closing time, or neither.";
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const lease = useOffline ? { leaseWindowMinutes: forever ? null : Number.parseInt(minutes.trim(), 10) } : {};
    const session = start !== "" ? { sessionStart: start, sessionEnd: end } : location?.sessionStart ? { sessionStart: null, sessionEnd: null } : {};
    setSaving(true);
    setError(null);
    try {
      if (location) {
        const body: LocationUpdateBody = { name: name.trim(), ...(isMain ? {} : { type, isOfflineCapable: useOffline }), ...lease, ...session };
        onSaved(await updateLocation(location.id, body));
      } else {
        const body: LocationCreateBody = { name: name.trim(), code: code.trim().toUpperCase(), type, isOfflineCapable: useOffline, ...lease, ...session };
        onSaved(await createLocation(body));
      }
    } catch (failure) {
      setError(failure instanceof ApiHttpError ? failure.message : "The location could not be saved. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form noValidate onSubmit={(e) => void submit(e)} className="space-y-4">
      {error ? <FormAlert id={ids.error}>{error}</FormAlert> : null}
      <TextField id={ids.name} label="Name" autoComplete="off" value={name} error={errors.name} onChange={(e) => setName(e.target.value)} data-autofocus />
      {location ? null : (
        <TextField id={ids.code} label="Code" hint="Short and permanent; it appears in stock history." autoComplete="off" value={code} error={errors.code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
      )}
      {isMain ? (
        <p className="text-sm text-muted-foreground">The main store&rsquo;s type is fixed, and it is always online.</p>
      ) : (
        <>
          <SelectField id={ids.type} label="Type" value={type} onChange={(v) => setType(v as LocationType)}>
            {CREATABLE.map((t) => (
              <option key={t} value={t}>
                {LOCATION_TYPE_LABEL[t]}
              </option>
            ))}
          </SelectField>
          <label htmlFor={ids.offline} className={cn("flex min-h-11 items-center gap-3 text-sm", !offlineAllowed && "opacity-60")}>
            <input id={ids.offline} type="checkbox" className="size-5" disabled={!offlineAllowed} checked={offlineAllowed && offline} onChange={(e) => setOffline(e.target.checked)} />
            Works offline {offlineAllowed ? "" : "(not for an online shop)"}
          </label>
          {offlineAllowed && offline ? (
            <fieldset className="space-y-2 rounded-md border p-3">
              <legend className="px-1 text-sm font-medium">Offline lease</legend>
              <p className="text-xs text-muted-foreground">If a device here stays offline past its lease, its unsold stock freezes until it syncs.</p>
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input type="radio" name={ids.lease} className="size-4" checked={!forever} onChange={() => setForever(false)} />
                Expires after a set time
              </label>
              {!forever ? <TextField id={ids.minutes} label="Lease length (minutes)" hint="480 minutes is 8 hours." inputMode="numeric" autoComplete="off" value={minutes} error={errors.minutes} onChange={(e) => setMinutes(e.target.value)} /> : null}
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input type="radio" name={ids.lease} className="size-4" checked={forever} onChange={() => setForever(true)} />
                Never expires (e.g. a permanent branch)
              </label>
            </fieldset>
          ) : null}
        </>
      )}
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Daily session (optional)</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField id={ids.start} label="Opens" type="time" value={start} onChange={(e) => setStart(e.target.value)} />
          <TextField id={ids.end} label="Closes" type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
        </div>
        {errors.session ? <p className="text-sm text-destructive">{errors.session}</p> : null}
      </fieldset>
      <Button type="submit" className="h-11" disabled={saving}>
        {saving ? "Saving…" : location ? "Save changes" : "Add location"}
      </Button>
    </form>
  );
}

function ActiveToggle({ location, onDone }: { location: Location; onDone: (saved: Location) => void }) {
  const ids = { title: useId(), body: useId() };
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const activating = !location.isActive;
  async function confirm() {
    setSaving(true);
    setError(null);
    try {
      onDone(await setLocationActive(location.id, activating));
      setAsking(false);
    } catch (failure) {
      setError(failure instanceof ApiHttpError ? failure.message : "That could not be saved. Please try again.");
    } finally {
      setSaving(false);
    }
  }
  if (!asking) {
    return (
      <Button type="button" variant="outline" className="h-11" onClick={() => setAsking(true)}>
        {activating ? "Activate" : "Deactivate"} {location.name}
      </Button>
    );
  }
  return (
    <div role="alertdialog" aria-labelledby={ids.title} aria-describedby={ids.body} className="space-y-2 rounded-md border p-3">
      <p id={ids.title} className="font-medium">
        {activating ? `Activate ${location.name}?` : `Deactivate ${location.name}?`}
      </p>
      <p id={ids.body} className="text-sm">
        {activating ? "It can hold, receive and sell stock again." : "It must hold no stock: transfer anything it holds elsewhere first. It can be activated again later."}
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-col-reverse gap-2 sm:flex-row">
        <Button type="button" variant="outline" className="h-11" onClick={() => setAsking(false)} disabled={saving} data-autofocus>
          Back
        </Button>
        <Button type="button" className="h-11" onClick={() => void confirm()} disabled={saving}>
          {saving ? "Saving…" : activating ? "Yes, activate" : "Yes, deactivate"}
        </Button>
      </div>
    </div>
  );
}

export function LocationsView({ canManage }: { canManage: boolean }) {
  const client = useQueryClient();
  const place = useWorkingLocation();
  const locations = useLocations();
  const [panel, setPanel] = useState<{ kind: "create" } | { kind: "edit"; location: Location } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function saved(location: Location, what: string) {
    void client.invalidateQueries({ queryKey: inventoryKeys.locations() });
    place?.retry();
    setNotice(`${location.name} ${what}.`);
  }

  let body: ReactNode;
  if (locations.isPending) body = <LoadingState label="Loading locations" lines={4} />;
  else if (locations.isError) body = <ErrorState title="Couldn’t load locations" description={locations.error.message} onRetry={() => void locations.refetch()} />;
  else if (locations.data.data.length === 0) body = <EmptyState title="No locations" description="Every business has a main store; it will appear here." />;
  else
    body = (
      <ul aria-label="Locations" className="space-y-2">
        {locations.data.data.map((l) => (
          <li key={l.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
            <div className="min-w-0 space-y-1">
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{l.name}</span>
                <span className="font-mono text-xs text-muted-foreground">{l.code}</span>
                <span className={cn(BADGE, "bg-muted")}>{LOCATION_TYPE_LABEL[l.type]}</span>
                <span className={cn(BADGE, l.isActive ? "border-emerald-700/40 bg-emerald-700/10" : "border-destructive/40 bg-destructive/10")}>{l.isActive ? "Active" : "Inactive"}</span>
              </p>
              <p className="text-sm text-muted-foreground">{policyOf(l)}</p>
            </div>
            {canManage ? (
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" className="h-11" onClick={() => setPanel({ kind: "edit", location: l })} aria-label={`Edit ${l.name}`}>
                  Edit
                </Button>
                {l.isDefault ? null : <ActiveToggle location={l} onDone={(s) => saved(s, s.isActive ? "is active again" : "is deactivated")} />}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    );

  return (
    <div className="space-y-4">
      {canManage ? (
        <Button type="button" className="h-11" onClick={() => setPanel({ kind: "create" })}>
          <Plus aria-hidden /> Add location
        </Button>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm">
          {notice}
        </p>
      ) : null}
      {body}
      {panel ? (
        <Sheet title={panel.kind === "create" ? "Add a location" : `Edit ${panel.location.name}`} onClose={() => setPanel(null)}>
          <LocationForm
            location={panel.kind === "edit" ? panel.location : null}
            onSaved={(s) => {
              saved(s, panel.kind === "create" ? "was added" : "was saved");
              setPanel(null);
            }}
          />
        </Sheet>
      ) : null}
    </div>
  );
}
