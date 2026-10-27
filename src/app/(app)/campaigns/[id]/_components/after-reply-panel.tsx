import Link from "next/link";
import { Time } from "@/components/shell/time";
import { ScrollableTable } from "@/components/ui/scrollable-table";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { AfterReplyView } from "@/contexts/conversations/after-reply/application/after-reply";
import { runStatusLabel } from "@/contexts/conversations/after-reply/domain/after-reply";
import { AfterReplyEditor } from "./after-reply-editor";
import { CampaignSection } from "./campaign-section";
import { earlierVersionNote, FIXED_STOPS_LINE, stopTypesLine } from "../_lib/after-reply-form";

/**
 * Settings section of a campaign: what happens after a lead replies. The form is the client editor. The blocks under it
 * (what stops follow-ups, follow-ups in progress) are read-only and render on the server. The reply types that stop
 * follow-ups are data, changed in Settings > Reply handling.
 */
export function AfterReplyPanel({ view, personal = false }: { view: AfterReplyView; personal?: boolean }) {
  const earlier = earlierVersionNote(view.earlierVersionCount);
  return (
    <CampaignSection id="after-reply" className="scroll-mt-4" title="Follow-ups after a reply" description="What happens to a lead who replies. The sequence stops for that lead either way.">
      <div className="stack-section">
        <AfterReplyEditor
          campaignId={view.campaignId}
          mode={view.mode}
          steps={view.steps}
          supported={view.supported}
          lockedReason={view.lockedReason}
          personal={personal}
          inProgress={view.inProgress.length}
        />

        {view.supported && (
          <div className="stack-field" data-testid="after-reply-stops">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h3 className="text-sm font-medium">Stops for these reply types</h3>
              <Link href="/settings/replies" className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground">
                Change in Settings
              </Link>
            </div>
            <p className="max-w-prose text-sm">{stopTypesLine(view.stopReplyTypes.map((t) => t.name))}</p>
            <p className="max-w-prose text-sm text-muted-foreground">{FIXED_STOPS_LINE}</p>
          </div>
        )}

        {view.supported && (
          <div className="stack-group">
            <h3 className="text-sm font-medium">Follow-ups in progress ({view.inProgress.length.toLocaleString("en-US")})</h3>
            {earlier && <p className="text-sm text-muted-foreground">{earlier}</p>}
            {view.inProgress.length === 0 ? (
              <p className="text-sm text-muted-foreground">No follow-ups are running for this campaign.</p>
            ) : (
              <ScrollableTable>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Lead</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Step</TableHead>
                      <TableHead>Next draft due</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {view.inProgress.map((run) => (
                      <TableRow key={run.runId}>
                        <TableCell className="font-medium">
                          <Link href={`/inbox/${run.conversationId}`} className="underline-offset-4 hover:underline">
                            {run.personName ?? "Unnamed lead"}
                          </Link>
                        </TableCell>
                        <TableCell>{runStatusLabel(run.status)}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {run.currentStep} of {run.totalSteps}
                        </TableCell>
                        <TableCell className="text-muted-foreground">{run.nextDueAt ? <Time value={run.nextDueAt} /> : "-"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </ScrollableTable>
            )}
          </div>
        )}
      </div>
    </CampaignSection>
  );
}
