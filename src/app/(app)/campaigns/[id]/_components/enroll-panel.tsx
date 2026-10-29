"use client";

import { PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { callApi } from "@/app/_lib/api-client";
import { countOf, formatCount } from "@/shared/format-number";
import { ENROLL_BATCH_LIMIT, ENROLL_CONFIRM_FROM, enrollNeedsConfirmation } from "@/contexts/outreach/domain/campaign-view";
import type { CrossCampaignNotices } from "@/contexts/outreach/application/cross-campaign-notices";
import { CampaignSection } from "./campaign-section";
import { CrossCampaignNoticeList } from "./cross-campaign-notices";

interface Result {
  /** People the search matched, before any skip. */
  requested: number;
  added: number;
  alreadyEnrolled: number;
  skippedDoNotContact: number;
  /** People who became contacts; a campaign does not enroll them. */
  skippedContact?: number;
  /** Email only. */
  skippedSuppressed?: number;
  skippedNoEmail?: number;
  /** LinkedIn only. */
  skippedNoProfile?: number;
  /** LinkedIn only: people also contacted in other campaigns. */
  notices?: CrossCampaignNotices;
  /** Dry run only: people the same call would add. */
  wouldAdd?: number;
}

/** The skipped total and its breakdown, the same wording before and after an add. */
function skippedSummary(result: Result, linkedin: boolean): { count: number; text: string } {
  const contacts = result.skippedContact ?? 0;
  const count = result.alreadyEnrolled + result.skippedDoNotContact + contacts + (result.skippedSuppressed ?? 0) + (result.skippedNoEmail ?? 0) + (result.skippedNoProfile ?? 0);
  const text = linkedin
    ? `${formatCount(result.alreadyEnrolled)} already added, ${formatCount(result.skippedDoNotContact)} do not contact, ${formatCount(contacts)} are contacts, ${formatCount(result.skippedNoProfile ?? 0)} without a LinkedIn URL`
    : `${formatCount(result.alreadyEnrolled)} already added, ${formatCount(result.skippedSuppressed ?? 0)} unsubscribed, ${formatCount(result.skippedDoNotContact)} do not contact, ${formatCount(contacts)} are contacts, ${formatCount(result.skippedNoEmail ?? 0)} without an email`;
  return { count, text };
}

/**
 * The Leads tab as one ruled section: the title and the Add leads button, the add panel under the header when open, then
 * the list (`children`). The count lives on the All chip and in the summary above, so the title carries none. The panel
 * starts open while the campaign has no leads.
 */
export function LeadsSection({ id, count, disabled, channel = "email", children }: { id: string; count: number; disabled: boolean; channel?: "email" | "linkedin"; children: ReactNode }) {
  const [open, setOpen] = useState(count === 0 && !disabled);
  return (
    <CampaignSection
      title="Leads in this campaign"
      testId="campaign-leads"
      // The tab bar above carries the rule, so the section starts without its own.
      className="border-t-0 pt-0"
      description={disabled ? "This campaign is completed, so no leads can be added." : undefined}
      action={
        <Button size="sm" variant={open ? "secondary" : "default"} aria-expanded={open} aria-controls="add-leads-panel" disabled={disabled} onClick={() => setOpen((o) => !o)}>
          <PlusIcon /> Add leads
        </Button>
      }
    >
      {open && !disabled && <EnrollPanel id={id} disabled={disabled} channel={channel} />}
      {children}
    </CampaignSection>
  );
}

export function EnrollPanel({ id, disabled, channel = "email" }: { id: string; disabled: boolean; channel?: "email" | "linkedin" }) {
  const linkedin = channel === "linkedin";
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  /** The dry run that waits for a yes: the search it counted and what it found. */
  const [review, setReview] = useState<{ query: string; found: Result } | null>(null);
  const url = `${linkedin ? "/api/linkedin" : "/api"}/campaigns/${id}/enroll`;

  async function enroll(query: string) {
    const response = await callApi<Result>(url, "POST", query ? { query } : {});
    if (!response.ok || !response.data) throw new Error(response.error ?? "Could not add the leads. Try again.");
    setResult(response.data);
    router.refresh();
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setResult(null);
    const query = String(new FormData(event.currentTarget).get("query") ?? "").trim();
    // Count first: an empty search or a large match asks before it enrolls anyone.
    const dry = await callApi<Result>(url, "POST", { ...(query ? { query } : {}), dryRun: true });
    if (!dry.ok || !dry.data) {
      setPending(false);
      setError(dry.error);
      return;
    }
    if (enrollNeedsConfirmation({ query, wouldAdd: dry.data.wouldAdd ?? 0 })) {
      setPending(false);
      setReview({ query, found: dry.data });
      return;
    }
    try {
      await enroll(query);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add the leads. Try again.");
    }
    setPending(false);
  }

  const summary = result ? skippedSummary(result, linkedin) : null;
  const found = review ? { adds: review.found.wouldAdd ?? 0, skipped: skippedSummary(review.found, linkedin) } : null;

  return (
    <section id="add-leads-panel" aria-labelledby="add-leads-title" className="stack-group border-y py-section transition-[opacity,translate] duration-(--duration-menu) ease-out starting:opacity-0 motion-safe:starting:-translate-y-1">
      <div className="stack-field">
        <h3 id="add-leads-title" className="heading-section">
          Add leads
        </h3>
        <p className="max-w-prose text-sm text-muted-foreground">
          {linkedin
            ? `Adds every lead in your database that matches and has a LinkedIn URL, up to 5,000 at a time. Leave the search empty to add all. You confirm first when the search is empty or matches ${ENROLL_CONFIRM_FROM} or more leads. Do not contact leads, contacts and already added leads are skipped.`
            : `Adds every lead in your database that matches, up to 5,000 at a time. Leave the search empty to add all. You confirm first when the search is empty or matches ${ENROLL_CONFIRM_FROM} or more leads. Unsubscribed and do not contact leads, contacts and already added leads are skipped.`}
        </p>
      </div>
      <div className="stack-group">
        <form onSubmit={onSubmit} className="flex flex-wrap gap-2">
          <Input name="query" aria-label="Search leads to add" placeholder={linkedin ? "Search name, title or company (optional)" : "Search name, email, title or company (optional)"} className="max-w-md" disabled={disabled || pending} />
          <Button type="submit" disabled={disabled || pending}>
            {pending ? "Checking…" : "Add matching leads"}
          </Button>
        </form>
        {disabled && <p className="text-sm text-muted-foreground">This campaign is completed.</p>}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {result && summary && (
          <p className="text-sm" role="status">
            Added {countOf(result.added, "lead")}.
            {summary.count > 0 && (
              <span className="text-muted-foreground">
                {" "}
                Skipped {formatCount(summary.count)}: {summary.text}.
              </span>
            )}
          </p>
        )}
        {result?.notices && <CrossCampaignNoticeList notices={result.notices} />}
      </div>
      <ConfirmDialog
        open={review !== null}
        onOpenChange={(open) => !open && setReview(null)}
        title={found ? `Add ${countOf(found.adds, "lead")} to this campaign?` : "Add leads to this campaign?"}
        description={review?.query ? `Leads in your database that match "${review.query}" and can be added.` : "The search is empty, so this adds every lead in your database that can be added."}
        confirmLabel={found ? `Add ${countOf(found.adds, "lead")}` : "Add leads"}
        pendingLabel="Adding…"
        onConfirm={async () => {
          await enroll(review?.query ?? "");
        }}
      >
        {review && found && (
          <div className="stack-field text-sm">
            <p>
              {countOf(review.found.requested, "lead matches", "leads match")}.
              {found.skipped.count > 0 && <span className="text-muted-foreground"> {formatCount(found.skipped.count)} will be skipped: {found.skipped.text}.</span>}
            </p>
            {found.adds >= ENROLL_BATCH_LIMIT && <p className="text-muted-foreground">One add takes at most {formatCount(ENROLL_BATCH_LIMIT)} leads. Run it again for the rest.</p>}
          </div>
        )}
      </ConfirmDialog>
    </section>
  );
}
