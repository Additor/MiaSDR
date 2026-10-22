import { StatusBadge } from "@/components/shell/status-badge";
import { Time } from "@/components/shell/time";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { LeadDetail } from "@/contexts/people/application/lead-ports";
import { channelLabel } from "@/contexts/outreach/domain/campaign-view";
import { RecordSection } from "../record/record-header";

/** The empty line when the person got sends the viewer may not see (`LeadDetail.hiddenSends`, plan 5.9). */
export const HIDDEN_SENDS_TEXT = "No messages you can see. Another member's personal campaign wrote to this lead.";

/**
 * A person's send attempts, newest first. Without sends it prints `emptyText` as one muted line, or `HIDDEN_SENDS_TEXT` when
 * `hiddenSends` says another member's personal campaign wrote to the person.
 */
export function SendHistoryTable({
  sends,
  hiddenSends = false,
  emptyText = "Nothing sent to this lead yet.",
  level = "h2",
}: {
  sends: LeadDetail["sends"];
  hiddenSends?: boolean;
  emptyText?: string;
  /** h3 inside another section, such as the contact page's Outreach history. */
  level?: "h2" | "h3";
}) {
  if (sends.length === 0) {
    return (
      <RecordSection title="Send history" level={level} testId="sends-empty">
        <p className="text-sm text-muted-foreground">{hiddenSends ? HIDDEN_SENDS_TEXT : emptyText}</p>
      </RecordSection>
    );
  }
  return (
    <RecordSection title="Send history" count={sends.length} level={level} testId="sends">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Campaign</TableHead>
              <TableHead>Step</TableHead>
              <TableHead>Channel</TableHead>
              <TableHead>Subject</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sends.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="text-muted-foreground">
                  <Time value={s.sentAt ?? s.claimedAt} />
                </TableCell>
                <TableCell>{s.campaignName}</TableCell>
                <TableCell>{s.stepNumber}</TableCell>
                <TableCell>{channelLabel(s.channel)}</TableCell>
                <TableCell className="max-w-64 truncate">{s.subject ?? ""}</TableCell>
                <TableCell>
                  <StatusBadge status={s.status} />
                  {s.error && <span className="mt-1 block max-w-64 text-xs whitespace-normal text-destructive">{s.error}</span>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
    </RecordSection>
  );
}
