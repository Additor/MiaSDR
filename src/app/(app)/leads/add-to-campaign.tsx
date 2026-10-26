"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useSelection } from "@/components/shell/selection";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { acceptsEnrollments } from "@/contexts/outreach/domain/campaign";
import { callApi } from "@/app/_lib/api-client";
import { addCounts, type EnrollCounts as Counts, skipReasons, ZERO_COUNTS } from "./enroll-counts";

interface CampaignOption {
  id: string;
  name: string;
  status: string;
  channel: "email" | "linkedin";
  archivedAt: string | null;
}

const CHUNK = 500;

/** Bulk action of the lead list: enrolls the ticked leads, on any page, in a chosen email or LinkedIn campaign. */
export function AddToCampaign() {
  const { selectedIds, clear } = useSelection();
  // Clearing the selection hides the bar this component lives in, so the dialog calls it only when the person closes the result.
  return <CampaignAdder personIds={selectedIds} onAdded={clear} label="Add to campaign" variant="default" />;
}

/**
 * The same dialog for one lead, from the lead page. It refreshes the page so the Campaigns table shows the new row. With `open`
 * the page's More menu opens it and no button shows.
 */
export function AddLeadToCampaign({ personId, variant, open, onOpenChange }: { personId: string; variant?: "default" | "outline"; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  const router = useRouter();
  return <CampaignAdder personIds={[personId]} onAdded={() => router.refresh()} label="Add to campaign" variant={variant} open={open} onOpenChange={onOpenChange} />;
}

function CampaignAdder({
  personIds,
  onAdded,
  label,
  variant = "outline",
  open: controlled,
  onOpenChange,
}: {
  personIds: string[];
  onAdded: () => void;
  label: string;
  variant?: "default" | "outline";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [own, setOwn] = useState(false);
  const open = controlled ?? own;
  const setOpen = onOpenChange ?? setOwn;
  const [campaigns, setCampaigns] = useState<CampaignOption[] | null>(null);
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [progress, setProgress] = useState(0);

  // Each open starts clean; the open campaigns load once.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setError(null);
      setCounts(null);
    }
  }

  useEffect(() => {
    if (!open || campaigns) return;
    let live = true;
    void Promise.all([
      callApi<Array<Omit<CampaignOption, "channel">>>("/api/campaigns", "GET"),
      callApi<Array<Omit<CampaignOption, "channel">>>("/api/linkedin/campaigns", "GET"),
    ]).then(([email, linkedin]) => {
      if (!live) return;
      if (!email.ok || !linkedin.ok) setError(email.error ?? linkedin.error);
      const usable = (rows: Array<Omit<CampaignOption, "channel">> | null, channel: CampaignOption["channel"]) =>
        (rows ?? []).filter(acceptsEnrollments).map((c) => ({ ...c, channel }));
      setCampaigns([...usable(email.data, "email"), ...usable(linkedin.data, "linkedin")]);
    });
    return () => {
      live = false;
    };
  }, [open, campaigns]);

  const chosen = campaigns?.find((c) => `${c.channel}:${c.id}` === target);

  async function submit() {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    setProgress(0);
    let total = { ...ZERO_COUNTS };
    for (let i = 0; i < personIds.length; i += CHUNK) {
      const response = await callApi<Counts>(`${chosen.channel === "linkedin" ? "/api/linkedin" : "/api"}/campaigns/${chosen.id}/enroll`, "POST", { personIds: personIds.slice(i, i + CHUNK) });
      if (!response.ok || !response.data) {
        setError(response.error);
        setCounts(total);
        setBusy(false);
        return;
      }
      total = addCounts(total, response.data);
      setProgress(Math.min(i + CHUNK, personIds.length));
    }
    setCounts(total);
    setBusy(false);
  }

  function done() {
    setOpen(false);
    if (counts && counts.added > 0) onAdded();
  }

  const count = personIds.length.toLocaleString("en-US");

  const skipped = counts ? counts.requested - counts.added : 0;

  return (
    <>
      {controlled === undefined && (
        <Button variant={variant} onClick={() => setOpen(true)}>
          {label}
        </Button>
      )}
      <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add to campaign</DialogTitle>
            <DialogDescription>
              {counts
                ? "Done. Nothing is sent now: the campaign keeps its status."
                : `${count} ${personIds.length === 1 ? "lead" : "leads"} selected. Leads without the channel address, unsubscribed and do not contact leads, already added leads and contacts are skipped.`}
            </DialogDescription>
          </DialogHeader>
          {counts ? (
            <div className="grid gap-2 text-sm" role="status">
              <p>
                Added <strong>{counts.added.toLocaleString("en-US")}</strong> of {counts.requested.toLocaleString("en-US")}.
              </p>
              {skipped > 0 && (
                <ul className="list-disc pl-5 text-muted-foreground">
                  {skipReasons(counts, chosen?.channel).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              )}
              {error && (
                <p role="alert" className="text-destructive">
                  {error}
                </p>
              )}
            </div>
          ) : (
            <div className="grid gap-2">
              <Label htmlFor="add-campaign-target">Campaign</Label>
              <select
                id="add-campaign-target"
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                disabled={campaigns === null || busy}
                className="h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
              >
                <option value="">{campaigns === null ? "Loading…" : campaigns.length === 0 ? "No open campaign" : "Choose a campaign"}</option>
                {(campaigns ?? []).map((c) => (
                  <option key={`${c.channel}:${c.id}`} value={`${c.channel}:${c.id}`}>
                    {c.name} ({c.channel === "linkedin" ? "LinkedIn" : "Email"}, {c.status})
                  </option>
                ))}
              </select>
              {chosen?.status === "active" && <p className="text-xs text-muted-foreground">This campaign is live. New leads start receiving steps right away.</p>}
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
            </div>
          )}
          <DialogFooter>
            {counts ? (
              <>
                {chosen && (
                  <Link href={`/campaigns/${chosen.id}`} className={buttonVariants({ variant: "outline" })}>
                    Open campaign
                  </Link>
                )}
                <Button type="button" onClick={done}>
                  Done
                </Button>
              </>
            ) : (
              <>
                <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>
                  Cancel
                </Button>
                <Button type="button" onClick={submit} disabled={!chosen || busy || personIds.length === 0}>
                  {busy ? `Adding… ${progress.toLocaleString("en-US")} of ${count}` : `Add ${count} ${personIds.length === 1 ? "lead" : "leads"}`}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
