import { MAX_MATCHING_IDS, matchingSelection } from "@/contexts/people/domain/lead-filter";
import { countOf, formatCount as count } from "@/shared/format-number";

/*
 * What the Contacts selection bar shows and says. The bar holds at most four controls: Export selected, Mark do not
 * contact, Clear selection, and More actions while "Select all matching" can still add contacts.
 */

export type ContactsBarControl = "export" | "doNotContact" | "clear" | "more";

/** The person routes take 200 ids per request (`POST /api/people/dnc`), so the dialog sends chunks of this size. */
export const DNC_CHUNK = 200;

export interface DncReport {
  marked: number;
  skipped: Array<{ personId: string; reason: "already_marked" | "not_found" | "retryable" }>;
}


export function contactsBarModel(input: { selectedCount: number; total: number }): { visible: ContactsBarControl[]; selectAll: string | null } {
  if (input.selectedCount === 0) return { visible: [], selectAll: null };
  const matching = matchingSelection(input.selectedCount, input.total);
  const selectAll = matching.canSelectAll
    ? matching.reach < input.total
      ? `Select the first ${count(MAX_MATCHING_IDS)} of ${count(input.total)}`
      : `Select all ${count(input.total)} matching`
    : null;
  const visible: ContactsBarControl[] = ["export", "doNotContact", "clear"];
  if (selectAll) visible.push("more");
  return { visible, selectAll };
}

/** "{n} selected." or "{n} selected, across pages." once a ticked contact sits on another page. */
export function selectedText(selectedCount: number, offPage: boolean): string {
  return `${count(selectedCount)} selected${offPage ? ", across pages" : ""}.`;
}

export function bulkDncTitle(n: number): string {
  return `Mark ${countOf(n, "person", "people")} do not contact?`;
}

export function mergeDncReports(reports: readonly DncReport[]): DncReport {
  return { marked: reports.reduce((sum, r) => sum + r.marked, 0), skipped: reports.flatMap((r) => r.skipped) };
}

/** "Marked {n}." or "Marked {n}. Skipped {m}: ..." with each zero part dropped. */
export function dncReportText(report: DncReport): string {
  const marked = `Marked ${count(report.marked)}.`;
  if (report.skipped.length === 0) return marked;
  const by = (reason: DncReport["skipped"][number]["reason"]) => report.skipped.filter((s) => s.reason === reason).length;
  const [already, gone, retry] = [by("already_marked"), by("not_found"), by("retryable")];
  const parts = [
    already > 0 ? `${count(already)} already marked` : null,
    gone > 0 ? `${count(gone)} no longer ${gone === 1 ? "exists" : "exist"}` : null,
    retry > 0 ? `${count(retry)} changed and can be tried again` : null,
  ].filter((part): part is string => part !== null);
  return `${marked} Skipped ${count(report.skipped.length)}: ${parts.join(", ")}.`;
}

/** The phone line under a contact's name: "{Company} · {stage}", with each missing part dropped. The page adds the last activity. */
export function phoneLineParts(contact: { companyName: string | null; stageName: string | null }): string[] {
  return [contact.companyName, contact.stageName].filter((part): part is string => Boolean(part));
}
