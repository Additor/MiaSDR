import { RowLink, rowLinkClasses } from "@/components/shell/row-link";
import { StatusBadge } from "@/components/shell/status-badge";
import { Time } from "@/components/shell/time";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { LeadDetail } from "@/contexts/leads/application/lead-ports";
import type { LeadCrossContext } from "@/contexts/outreach/application/cross-campaign-notices";
import { campaignStatusLabel, enrollmentDisplayStatus, stopReasonNote } from "@/contexts/outreach/domain/campaign-view";
import { heldByCampaign } from "@/contexts/outreach/domain/lead-status";
import { RecordSection } from "../record/record-header";

/**
 * A person's campaign enrollments with status, steps, send times and the stop reason ("Became a contact" for a
 * conversion). Without enrollments it prints `emptyText` as one muted line.
 */
export function CampaignsTable({
  enrollments,
  invitedFrom = [],
  emptyText = "This lead is not in any campaign. Use Add to campaign to start outreach.",
  level = "h2",
}: {
  enrollments: LeadDetail["enrollments"];
  /** LinkedIn accounts that already invited this person and do not invite them again. */
  invitedFrom?: LeadCrossContext["excludedAccounts"];
  emptyText?: string;
  /** h3 inside another section, such as the contact page's Outreach history. */
  level?: "h2" | "h3";
}) {
  if (enrollments.length === 0) {
    return (
      <RecordSection title="Campaigns" level={level} testId="campaigns-empty">
        <p className="text-sm text-muted-foreground">{emptyText}</p>
      </RecordSection>
    );
  }
  return (
    <RecordSection title="Campaigns" count={enrollments.length} level={level} testId="campaigns">
        {invitedFrom.length > 0 && (
          <p className="text-sm" data-testid="invited-from">
            <span className="text-muted-foreground">Already invited from:</span>{" "}
            {invitedFrom.map((a) => `${a.accountName ?? "a LinkedIn account"}${a.campaignName ? ` (${a.campaignName})` : ""}`).join(", ")}
            <span className="ml-2 text-xs text-muted-foreground">Those accounts do not invite this person again.</span>
          </p>
        )}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Campaign</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Steps done</TableHead>
              <TableHead>Last sent</TableHead>
              <TableHead>Next send</TableHead>
              <TableHead>Stop reason</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {enrollments.map((e) => {
              const shown = enrollmentDisplayStatus(e.status, e.campaignStatus);
              // The badge of a live enrollment already says its campaign is paused.
              const campaignNote = e.campaignStatus === "paused" && heldByCampaign(e.status, e.campaignStatus) ? null : campaignStatusLabel(e.campaignStatus).toLowerCase();
              return (
                <TableRow key={e.id} className={rowLinkClasses}>
                  <TableCell>
                    <RowLink href={`/campaigns/${e.campaignId}`}>{e.campaignName}</RowLink>
                    {campaignNote && <span className="text-xs text-muted-foreground"> ({campaignNote})</span>}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={shown.status} label={shown.label} />
                  </TableCell>
                  <TableCell>{e.currentStep}</TableCell>
                  <TableCell className="text-muted-foreground">{e.lastSentAt && <Time value={e.lastSentAt} />}</TableCell>
                  <TableCell className="text-muted-foreground">{e.nextSendAt && <Time value={e.nextSendAt} />}</TableCell>
                  <TableCell className="text-muted-foreground">{stopReasonNote(e.status, e.stopReason) ?? ""}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
    </RecordSection>
  );
}
