/**
 * Wording and batching for the Create deal dialogs. The effects text comes from `POST /api/leads/convert/preview`
 *: one sentence per effect, and a line with a zero count is left out.
 */

import type { BulkCreateResult, BulkSkipReason } from "@/contexts/deals/application/deal-create";
import { MAX_BULK_CONVERT_IDS } from "@/contexts/deals/application/deal-limits";
import type { ConvertPreview } from "@/contexts/people/application/convert-to-contact";
import { MAX_CONVERT_PREVIEW_IDS } from "@/contexts/people/application/conversion-terms";

export type { ConvertPreview, BulkSkipReason };
export type BulkReport = BulkCreateResult;

/** The UI sends bulk creates and previews in chunks of the server's caps, one after another. */
export const CREATE_CHUNK = MAX_BULK_CONVERT_IDS;
export const PREVIEW_CHUNK = MAX_CONVERT_PREVIEW_IDS;

export const EMPTY_PREVIEW: ConvertPreview = { people: 0, alreadyContacts: 0, enrollments: 0, runs: 0, followUpDraftsToRetire: 0, skippedPersonalCampaign: 0 };

export function sumPreviews(previews: readonly ConvertPreview[]): ConvertPreview {
  return previews.reduce<ConvertPreview>(
    (sum, p) => ({
      people: sum.people + p.people,
      alreadyContacts: sum.alreadyContacts + p.alreadyContacts,
      enrollments: sum.enrollments + p.enrollments,
      runs: sum.runs + p.runs,
      followUpDraftsToRetire: sum.followUpDraftsToRetire + p.followUpDraftsToRetire,
      skippedPersonalCampaign: sum.skippedPersonalCampaign + p.skippedPersonalCampaign,
    }),
    EMPTY_PREVIEW,
  );
}

export function mergeReports(reports: readonly BulkReport[]): BulkReport {
  return { created: reports.flatMap((r) => r.created), skipped: reports.flatMap((r) => r.skipped) };
}

/** Ids a chunk reported `retryable`: a lock it met twice, or ids its time budget did not reach. The dialog sends them once more. */
export function retryableIds(report: BulkReport): string[] {
  return report.skipped.filter((s) => s.reason === "retryable").map((s) => s.personId);
}

/** The report with the entries of the ids sent again replaced by what the second request said about them. */
export function applyRetry(report: BulkReport, retry: BulkReport): BulkReport {
  const retried = new Set([...retry.created, ...retry.skipped].map((r) => r.personId));
  return { created: [...report.created, ...retry.created], skipped: [...report.skipped.filter((s) => !retried.has(s.personId)), ...retry.skipped] };
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The stop lines shared by the single and the bulk dialog. */
function stopLines(p: ConvertPreview): string[] {
  const lines: string[] = [];
  if (p.enrollments > 0) lines.push(`Stops ${count(p.enrollments, "campaign enrollment", "campaign enrollments")}.`);
  if (p.runs > 0) lines.push(`Ends ${count(p.runs, "follow-up", "follow-ups")} in progress.`);
  if (p.followUpDraftsToRetire > 0) {
    lines.push(`Discards ${count(p.followUpDraftsToRetire, "follow-up draft that waits", "follow-up drafts that wait")} for approval.`);
  }
  return lines;
}

/** "Moves Ada Lovelace to Contacts. Stops 2 campaign enrollments. Ends 1 follow-up in progress." */
export function singleEffectsText(name: string, p: ConvertPreview): string {
  return [`Moves ${name} to Contacts.`, ...stopLines(p)].join(" ");
}

/**
 * The permanence line under the effects of a conversion, always shown. Create deal passes `withDeal`, Make
 * contact does not: "Ada Lovelace cannot go back to Leads or join a campaign again, even if you delete the deal."
 */
export function permanenceText(name: string, { withDeal }: { withDeal: boolean }): string {
  const line = `${name} cannot go back to Leads or join a campaign again`;
  return withDeal ? `${line}, even if you delete the deal.` : `${line}.`;
}

/**
 * Contact mode: "Adds a deal for Ada Lovelace." and, when the contact has open deals, "Ada Lovelace already has 2 open
 * deals." Outreach does not change, since a contact is in no campaign.
 */
export function contactDealText(name: string, openDeals: number): string {
  const line = `Adds a deal for ${name}.`;
  return openDeals > 0 ? `${line} ${name} already has ${count(openDeals, "open deal", "open deals")}.` : line;
}

/** The bulk permanence line, counted over the leads the preview converts: "These 430 people cannot go back to Leads ...". */
export function bulkPermanenceText(people: number): string {
  return people === 1
    ? "This person cannot go back to Leads or join a campaign again, even if you delete their deal."
    : `These ${people} people cannot go back to Leads or join a campaign again, even if you delete their deals.`;
}

/** Bulk conversion asks a second time above this many leads. */
export const SECOND_CONFIRM_ABOVE = 50;

export const needsSecondConfirm = (p: ConvertPreview): boolean => p.people > SECOND_CONFIRM_ABOVE;

/** The second confirm of a bulk conversion. `{n}` is `preview.people`, the leads the create converts. */
export function secondConfirmText(people: number): { question: string; lines: string[]; confirm: string } {
  return {
    question: `Make ${people} leads contacts for good?`,
    lines: [`These ${people} leads cannot go back to Leads or join a campaign again. Deleting their deals later does not bring them back.`, "This cannot be undone."],
    confirm: `Create ${people} deals`,
  };
}

/** "Moves 430 leads to Contacts. Stops 12 campaign enrollments. Skips 20 that are already contacts." */
export function bulkEffectsText(p: ConvertPreview): string {
  const lines = p.people > 0 ? [`Moves ${count(p.people, "lead", "leads")} to Contacts.`, ...stopLines(p)] : ["No lead here can get a deal."];
  if (p.alreadyContacts > 0) lines.push(`Skips ${count(p.alreadyContacts, "person who is already a contact", "people who are already contacts")}.`);
  if (p.skippedPersonalCampaign > 0) {
    lines.push(`Skips ${count(p.skippedPersonalCampaign, "lead", "leads")} in another member's personal campaign.`);
  }
  if (p.people > 0) lines.push(bulkPermanenceText(p.people));
  return lines.join(" ");
}

const SKIP_LABELS: Record<BulkSkipReason, [string, string]> = {
  already_converted: ["was already a contact", "were already contacts"],
  not_found: ["was not found", "were not found"],
  personal_campaign: ["is in another member's personal campaign", "are in another member's personal campaign"],
  failed: ["failed", "failed"],
  retryable: ["met another change and can be tried again", "met other changes and can be tried again"],
};

/** "Created 430 deals. Skipped 20: 15 were already contacts, 5 are in another member's personal campaign." */
export function bulkReportText(report: BulkReport): string {
  const created = `Created ${count(report.created.length, "deal", "deals")}.`;
  if (report.skipped.length === 0) return created;
  const byReason = new Map<BulkSkipReason, number>();
  for (const s of report.skipped) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
  const parts = [...byReason].map(([reason, n]) => `${n} ${SKIP_LABELS[reason]?.[n === 1 ? 0 : 1] ?? "skipped"}`);
  return `${created} Skipped ${report.skipped.length}: ${parts.join(", ")}.`;
}

/** The title a new deal gets when the person leaves the field as it is: "{Company}, {Name}", or the name alone. */
export function defaultTitle(name: string | null, companyName: string | null): string {
  const n = name?.trim() || null;
  const c = companyName?.trim() || null;
  return c && n ? `${c}, ${n}` : (n ?? c ?? "New deal");
}

/** One key per dialog open. `crypto.randomUUID` is missing outside secure contexts, so a random string backs it. */
export function newIdempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
