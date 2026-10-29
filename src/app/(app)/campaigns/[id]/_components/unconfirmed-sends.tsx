"use client";

import { CircleHelpIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Time } from "@/components/shell/time";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { ScrollableTable } from "@/components/ui/scrollable-table";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { runApiAction } from "@/app/_lib/api-action";
import { callApi } from "@/app/_lib/api-client";
import { useApiAction } from "@/app/_lib/use-api-action";
import { CampaignSection } from "./campaign-section";
import { countOf, formatCount } from "@/shared/format-number";

export interface UnconfirmedRow {
  sendId: string;
  personName: string | null;
  email: string | null;
  stepNumber: number;
  mailboxEmail: string | null;
  claimedAt: string;
  note: string | null;
}

/**
 * Sends that may or may not have gone out. The state is uncertain, so the heading carries the warning color on its icon
 * and label; the rest stays neutral, and only the resend confirmation is red.
 */
export function UnconfirmedSends({ campaignId, total, rows, canResolve }: { campaignId: string; total: number; rows: UnconfirmedRow[]; canResolve: boolean }) {
  const router = useRouter();
  // Both answers of one send share its key; the tag says which runs. Other sends run on their own.
  const { isBusy, busyTag, run } = useApiAction();
  // Per send: whose "It was not delivered" waits for the Sent-folder confirmation, and whose box is checked.
  const [confirming, setConfirming] = useState<ReadonlySet<string>>(() => new Set());
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (set: ReadonlySet<string>, id: string, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  };

  const resolve = (sendId: string, outcome: "delivered" | "not_delivered") =>
    run(
      sendId,
      async () => {
        const body = { outcome, ...(outcome === "not_delivered" ? { checkedSentFolder: checked.has(sendId) } : {}) };
        const result = await runApiAction(callApi(`/api/campaigns/${campaignId}/sends/${sendId}/resolve`, "POST", body));
        // Someone else may have answered for this send, so the list reloads either way.
        router.refresh();
        if (!result.ok) return void toast.error(result.error);
        setConfirming((cur) => toggle(cur, sendId, false));
        setChecked((cur) => toggle(cur, sendId, false));
        toast.success(outcome === "delivered" ? "Recorded as delivered. The lead moves to the next step." : "Recorded as not delivered. The step will be sent again.");
      },
      outcome,
    );

  return (
    <CampaignSection
      testId="unconfirmed-sends"
      icon={<CircleHelpIcon aria-hidden className="size-4 shrink-0 text-warning" />}
      title={
        <span className="text-warning">
          {countOf(total, "send is", "sends are")} unconfirmed
        </span>
      }
      description={
        <>
          {total === 1 ? "This email" : "These emails"} may or may not have gone out. Check the mailbox&apos;s Sent folder and tell MiaSDR what happened.
          {!canResolve && " Only an owner or admin can answer."}
        </>
      }
    >
      <ScrollableTable>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Lead</TableHead>
              <TableHead className="text-right">Step</TableHead>
              <TableHead>Mailbox</TableHead>
              <TableHead>Claimed</TableHead>
              <TableHead>Note</TableHead>
              {canResolve && <TableHead>Was it delivered?</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.sendId}>
                <TableCell>
                  <div className="font-medium">{row.personName ?? ""}</div>
                  <div className="text-xs text-muted-foreground">{row.email}</div>
                </TableCell>
                <TableCell className="text-right tabular-nums">{row.stepNumber}</TableCell>
                <TableCell>{row.mailboxEmail ?? ""}</TableCell>
                <TableCell className="text-muted-foreground">
                  <Time value={row.claimedAt} />
                </TableCell>
                <TableCell className="max-w-64 whitespace-normal text-xs text-muted-foreground">{row.note}</TableCell>
                {canResolve && (
                  <TableCell>
                    <div className="grid gap-2">
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" disabled={isBusy(row.sendId)} onClick={() => void resolve(row.sendId, "delivered")}>
                          {busyTag(row.sendId) === "delivered" ? "Saving…" : "It was delivered"}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={isBusy(row.sendId)}
                          onClick={() => {
                            setConfirming((cur) => toggle(cur, row.sendId, !cur.has(row.sendId)));
                            setChecked((cur) => toggle(cur, row.sendId, false));
                          }}
                        >
                          It was not delivered
                        </Button>
                      </div>
                      {confirming.has(row.sendId) && (
                        <div className="grid gap-2 text-xs">
                          <p>MiaSDR will send this step again. If the email is in the Sent folder, the lead gets a duplicate.</p>
                          <Field orientation="horizontal">
                            <Checkbox id={`sent-folder-${row.sendId}`} checked={checked.has(row.sendId)} onCheckedChange={(c) => setChecked((cur) => toggle(cur, row.sendId, c === true))} />
                            <FieldLabel htmlFor={`sent-folder-${row.sendId}`} className="text-xs font-normal">
                              I looked in the Sent folder
                            </FieldLabel>
                          </Field>
                          <Button size="sm" variant="destructive" disabled={!checked.has(row.sendId) || isBusy(row.sendId)} onClick={() => void resolve(row.sendId, "not_delivered")}>
                            {busyTag(row.sendId) === "not_delivered" ? "Saving…" : "Send this step again"}
                          </Button>
                        </div>
                      )}
                    </div>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ScrollableTable>
      {total > rows.length && <p className="text-xs text-muted-foreground">Showing the oldest {formatCount(rows.length)}. Settle these and reload for the rest.</p>}
    </CampaignSection>
  );
}
