"use client";

import { CircleHelpIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ScrollableTable } from "@/components/ui/scrollable-table";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { callApi } from "@/app/_lib/api-client";
import { CampaignSection } from "./campaign-section";

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
  const [busy, setBusy] = useState<string | null>(null);
  // The row whose "It was not delivered" is waiting for the Sent-folder confirmation, and the checkbox state.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);

  async function resolve(sendId: string, outcome: "delivered" | "not_delivered") {
    setBusy(sendId);
    const result = await callApi(`/api/campaigns/${campaignId}/sends/${sendId}/resolve`, "POST", {
      outcome,
      ...(outcome === "not_delivered" ? { checkedSentFolder: checked } : {}),
    });
    setBusy(null);
    if (!result.ok) {
      toast.error(result.error ?? "Could not save the answer.");
      router.refresh();
      return;
    }
    setConfirming(null);
    setChecked(false);
    toast.success(outcome === "delivered" ? "Recorded as delivered. The lead moves to the next step." : "Recorded as not delivered. The step will be sent again.");
    router.refresh();
  }

  return (
    <CampaignSection
      testId="unconfirmed-sends"
      icon={<CircleHelpIcon aria-hidden className="size-4 shrink-0 text-warning" />}
      title={
        <span className="text-warning">
          {total} send{total === 1 ? " is" : "s are"} unconfirmed
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
              <TableHead>Claimed (UTC)</TableHead>
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
                <TableCell className="text-muted-foreground">{row.claimedAt.slice(0, 16).replace("T", " ")}</TableCell>
                <TableCell className="max-w-64 whitespace-normal text-xs text-muted-foreground">{row.note}</TableCell>
                {canResolve && (
                  <TableCell>
                    <div className="grid gap-2">
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" disabled={busy !== null} onClick={() => resolve(row.sendId, "delivered")}>
                          It was delivered
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy !== null}
                          onClick={() => {
                            setConfirming(confirming === row.sendId ? null : row.sendId);
                            setChecked(false);
                          }}
                        >
                          It was not delivered
                        </Button>
                      </div>
                      {confirming === row.sendId && (
                        <div className="grid gap-2 rounded-lg border border-destructive/40 p-2 text-xs">
                          <p>MiaSDR will send this step again. If the email is in the Sent folder, the lead gets a duplicate.</p>
                          <label className="flex items-center gap-2">
                            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />I looked in the Sent folder
                          </label>
                          <Button size="sm" variant="destructive" disabled={!checked || busy !== null} onClick={() => resolve(row.sendId, "not_delivered")}>
                            Send this step again
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
      {total > rows.length && <p className="text-xs text-muted-foreground">Showing the oldest {rows.length}. Settle these and reload for the rest.</p>}
    </CampaignSection>
  );
}
