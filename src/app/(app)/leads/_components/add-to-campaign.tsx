"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useSelection } from "@/components/shell/selection";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { acceptsEnrollments } from "@/contexts/outreach/domain/campaign";
import { formatCount } from "@/shared/format-number";
import { runApiAction } from "@/app/_lib/api-action";
import { callApi } from "@/app/_lib/api-client";
import { addCounts, type EnrollCounts as Counts, skipReasons, ZERO_COUNTS } from "../_lib/enroll-counts";

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
  const items = (campaigns ?? []).map((c) => ({ value: `${c.channel}:${c.id}`, label: `${c.name} (${c.channel === "linkedin" ? "LinkedIn" : "Email"}, ${c.status})` }));

  /** Enrolls in chunks, then stays open on the report, so the person reads what was added and skipped. */
  async function submit(): Promise<boolean> {
    if (!chosen) return false;
    setError(null);
    setProgress(0);
    let total = { ...ZERO_COUNTS };
    for (let i = 0; i < personIds.length; i += CHUNK) {
      // The dialog reports the counts and calls `onAdded` when it closes, so no chunk reloads the page.
      const response = await runApiAction(callApi<Counts>(`${chosen.channel === "linkedin" ? "/api/linkedin" : "/api"}/campaigns/${chosen.id}/enroll`, "POST", { personIds: personIds.slice(i, i + CHUNK) }), { expectData: true });
      if (!response.ok) {
        setError(response.error);
        setCounts(total);
        return false;
      }
      total = addCounts(total, response.data);
      setProgress(Math.min(i + CHUNK, personIds.length));
    }
    setCounts(total);
    return false;
  }

  function change(next: boolean) {
    setOpen(next);
    if (!next && counts && counts.added > 0) onAdded();
  }

  const count = formatCount(personIds.length);
  const noun = personIds.length === 1 ? "lead" : "leads";

  const skipped = counts ? counts.requested - counts.added : 0;

  return (
    <>
      {controlled === undefined && (
        <Button variant={variant} onClick={() => setOpen(true)}>
          {label}
        </Button>
      )}
      <ConfirmDialog
        open={open}
        onOpenChange={change}
        title="Add to campaign"
        description={
          counts
            ? "Done. Nothing is sent now: the campaign keeps its status."
            : `${count} ${noun} selected. Leads without the channel address, unsubscribed and do not contact leads, already added leads and contacts are skipped.`
        }
        confirmLabel={`Add ${count} ${noun}`}
        pendingLabel={`Adding… ${formatCount(progress)} of ${count}`}
        cancelLabel={counts ? "Done" : "Cancel"}
        confirmDisabled={counts !== null || !chosen || personIds.length === 0}
        onConfirm={submit}
      >
        {counts ? (
          <div className="grid gap-2 text-sm" role="status">
            <p>
              Added <strong>{formatCount(counts.added)}</strong> of {formatCount(counts.requested)}.
            </p>
            {skipped > 0 && (
              <ul className="list-disc pl-5">
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
            {chosen && (
              <p>
                <Link href={`/campaigns/${chosen.id}`} className="rounded-sm underline underline-offset-4 focus-ring">
                  Open campaign
                </Link>
              </p>
            )}
          </div>
        ) : (
          <Field>
            <FieldLabel htmlFor="add-campaign-target">Campaign</FieldLabel>
            <Select items={items} value={target || null} onValueChange={(v) => v && setTarget(v)} disabled={campaigns === null || campaigns.length === 0}>
              <SelectTrigger id="add-campaign-target" className="w-full max-sm:h-11" aria-describedby={chosen?.status === "active" ? "add-campaign-live" : undefined}>
                <SelectValue placeholder={campaigns === null ? "Loading…" : campaigns.length === 0 ? "No open campaign" : "Choose a campaign"} />
              </SelectTrigger>
              <SelectContent>
                {items.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {chosen?.status === "active" && <FieldDescription id="add-campaign-live">This campaign is live. New leads start receiving steps right away.</FieldDescription>}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </Field>
        )}
      </ConfirmDialog>
    </>
  );
}
