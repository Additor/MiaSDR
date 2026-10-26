"use client";

import { useRouter } from "next/navigation";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { callApi } from "@/app/_lib/api-client";
import { canRemoveEnrollment } from "@/contexts/outreach/domain/enrollment-status";

type Channel = "email" | "linkedin";

interface Selection {
  channel: Channel;
  campaignId: string;
  selected: Set<string>;
  toggle: (id: string, checked: boolean) => void;
  setMany: (ids: string[], checked: boolean) => void;
  clear: () => void;
}

const Context = createContext<Selection | null>(null);

const base = (channel: Channel, campaignId: string) => `${channel === "linkedin" ? "/api/linkedin" : "/api"}/campaigns/${campaignId}/enrollments`;

const useSelection = () => {
  const value = useContext(Context);
  if (!value) throw new Error("Enrollment selection components need an EnrollmentSelectionProvider");
  return value;
};

interface RemoveResult {
  removed: number;
  alreadyRemoved: number;
  skippedFinal: number;
  notFound: number;
}

async function removeIds(channel: Channel, campaignId: string, ids: string[]): Promise<RemoveResult | string> {
  const result = await callApi<RemoveResult>(`${base(channel, campaignId)}/remove`, "POST", { ids });
  return result.ok && result.data ? result.data : (result.error ?? "Could not remove the leads.");
}

/** Title, consequence and button of the remove dialog, for one named lead or a count of them. */
function removeCopy(count: number, name?: string | null) {
  const leads = `${count.toLocaleString("en-US")} ${count === 1 ? "lead" : "leads"}`;
  return {
    title: name ? `Remove ${name} from this campaign?` : `Remove ${leads} from this campaign?`,
    description: `Nothing more is sent to ${count === 1 ? "this lead" : "these leads"} from this campaign. The lead stays in Leads and the history stays here. You can restore a removed lead from the Removed filter unless the person has replied or is marked do not contact.`,
    confirmLabel: name ? "Remove lead" : `Remove ${leads}`,
  };
}

/** Holds the ticked rows of the campaign's lead table and shows the bulk remove bar above it. */
export function EnrollmentSelectionProvider({ channel, campaignId, children }: { channel: Channel; campaignId: string; children: ReactNode }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);

  const value = useMemo<Selection>(
    () => ({
      channel,
      campaignId,
      selected,
      toggle: (id, checked) =>
        setSelected((current) => {
          const next = new Set(current);
          if (checked) next.add(id);
          else next.delete(id);
          return next;
        }),
      setMany: (ids, checked) =>
        setSelected((current) => {
          const next = new Set(current);
          for (const id of ids) {
            if (checked) next.add(id);
            else next.delete(id);
          }
          return next;
        }),
      clear: () => setSelected(new Set()),
    }),
    [channel, campaignId, selected],
  );

  async function confirm() {
    const result = await removeIds(channel, campaignId, [...selected]);
    if (typeof result === "string") throw new Error(result);
    setSelected(new Set());
    toast.success(
      `Removed ${result.removed} ${result.removed === 1 ? "lead" : "leads"}.${result.alreadyRemoved > 0 ? ` ${result.alreadyRemoved} were already removed.` : ""}${result.skippedFinal > 0 ? ` ${result.skippedFinal} kept their final status (replied, bounced, unsubscribed, completed, failed or cancelled).` : ""}`,
    );
    router.refresh();
  }

  return (
    <Context.Provider value={value}>
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm" role="status">
          <span>{selected.size} selected.</span>
          <Button size="sm" variant="destructive" onClick={() => setConfirming(true)}>
            Remove from campaign
          </Button>
          <Button size="sm" variant="ghost" onClick={value.clear}>
            Clear selection
          </Button>
        </div>
      )}
      <ConfirmDialog open={confirming} onOpenChange={setConfirming} {...removeCopy(selected.size)} pendingLabel="Removing…" destructive onConfirm={confirm} />
      {children}
    </Context.Provider>
  );
}

/** Header checkbox: ticks every removable row of the page. `ids` are the enrollments that can still be removed. */
export function SelectAllRows({ ids }: { ids: string[] }) {
  const { selected, setMany } = useSelection();
  const all = ids.length > 0 && ids.every((id) => selected.has(id));
  const some = !all && ids.some((id) => selected.has(id));
  return <Checkbox checked={all} indeterminate={some} disabled={ids.length === 0} onCheckedChange={(checked) => setMany(ids, Boolean(checked))} aria-label="Select all leads on this page" />;
}

export function SelectRow({ id, name, disabled }: { id: string; name?: string | null; disabled?: boolean }) {
  const { selected, toggle } = useSelection();
  return <Checkbox checked={selected.has(id)} disabled={disabled} onCheckedChange={(checked) => toggle(id, Boolean(checked))} aria-label={`Select ${name ?? "lead"}`} />;
}

interface RestoreResult {
  restored: number;
  refused: Array<{ message: string; detail?: string }>;
  notFound: number;
}

/** Row action of a removed lead. Says why when the lead cannot come back. */
function RestoreRowButton({ id, name }: { id: string; name: string | null }) {
  const router = useRouter();
  const { channel, campaignId } = useSelection();
  const [busy, setBusy] = useState(false);

  async function restore() {
    setBusy(true);
    const result = await callApi<RestoreResult>(`${base(channel, campaignId)}/restore`, "POST", { ids: [id] });
    setBusy(false);
    if (!result.ok || !result.data) {
      toast.error(result.error ?? "Could not restore the lead.");
      return;
    }
    const refusal = result.data.refused[0];
    if (refusal) toast.error(`${name ?? "This lead"} stays removed. ${refusal.message}${refusal.detail ? ` Other campaign: ${refusal.detail}.` : ""}`);
    else if (result.data.restored > 0) toast.success("Lead restored to this campaign.");
    else toast.error("Lead not found in this campaign.");
    router.refresh();
  }

  return (
    <Button size="sm" variant="ghost" onClick={restore} disabled={busy} aria-label={`Restore ${name ?? "lead"} to this campaign`}>
      {busy ? "Restoring…" : "Restore"}
    </Button>
  );
}

/** Row action. Remove for a pending or active lead, Restore for a removed one. */
export function RemoveRowButton({ id, name, status }: { id: string; name: string | null; status: string }) {
  const router = useRouter();
  const { channel, campaignId } = useSelection();
  const [confirming, setConfirming] = useState(false);
  if (status === "removed") return <RestoreRowButton id={id} name={name} />;
  if (!canRemoveEnrollment(status)) return null;

  async function confirm() {
    const result = await callApi(`${base(channel, campaignId)}/${id}`, "DELETE");
    if (!result.ok) throw new Error(result.error ?? "Could not remove the lead.");
    toast.success("Lead removed from this campaign.");
    router.refresh();
  }

  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setConfirming(true)} aria-label={`Remove ${name ?? "lead"} from this campaign`}>
        Remove
      </Button>
      <ConfirmDialog open={confirming} onOpenChange={setConfirming} {...removeCopy(1, name ?? "this lead")} pendingLabel="Removing…" destructive onConfirm={confirm} />
    </>
  );
}
