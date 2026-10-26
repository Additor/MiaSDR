"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Time } from "@/components/shell/time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { callApi } from "@/app/_lib/api-client";
import { groupLabel } from "@/contexts/conversations/domain/reply-handling";
import { confidenceText, LOOKS_RIGHT_DONE, undoMessage } from "../_lib/type-line";

interface Entry {
  id: string;
  status: string;
  conversationId: string;
  previous: { groupKey: string | null; name: string | null };
  proposed: { groupKey: string | null; name: string | null };
  applied: { groupKey: string | null; name: string | null };
  confidence: number | null;
  reasoning: string | null;
  error: string | null;
  provider: string | null;
  acknowledged: boolean;
  createdAt: string;
  latest: boolean;
  canUndo: boolean;
  canAcknowledge: boolean;
}

/** "Demo request · Interested", or just "Other" when the type repeats its group. */
const label = (c: { groupKey: string | null; name: string | null }) => {
  if (!c.groupKey) return "No type";
  const group = groupLabel(c.groupKey);
  return c.name && c.name.trim().toLowerCase() !== group.toLowerCase() ? `${c.name} · ${group}` : group;
};

const STATUS: Record<string, string> = {
  proposed: "Held for a check",
  auto_applied: "Applied by the AI",
  accepted: "Accepted",
  overridden: "Changed by a person",
  rejected: "Undone",
  stale: "Out of date",
  failed: "Failed",
};

const UNDO_TIP = "Puts back the type from before the AI's pick. Open drafts retire and follow-ups end.";

/**
 * Each AI pick for this person's replies, with Looks right and Undo on the ones a person may still change. Only a pick that
 * waits for a person carries a badge; the rest of its facts read as one muted line. Undo says in its toast what it retired.
 * The caller frames it and leaves it out when there are no picks.
 */
export function AiPicksHistory({ entries, currentConversationId }: { entries: Entry[]; currentConversationId?: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function looksRight(id: string) {
    setBusy(id);
    setError(null);
    const result = await callApi(`/api/reply-type-picks/${id}/acknowledge`, "POST");
    setBusy(null);
    if (!result.ok) return setError(result.error);
    toast.success(LOOKS_RIGHT_DONE);
    router.refresh();
  }

  async function undo(id: string) {
    setBusy(id);
    setError(null);
    const result = await callApi<{ draftsRetired: number; runEnded: boolean; draftJobCancelled: boolean }>(`/api/reply-type-picks/${id}/undo`, "POST");
    setBusy(null);
    if (!result.ok || !result.data) return setError(result.error);
    toast.success(undoMessage(result.data));
    router.refresh();
  }

  return (
    <div className="grid gap-2" data-testid="ai-picks">
      <p id="undo-tip" className="sr-only">
        {UNDO_TIP}
      </p>
      <ul className="divide-y">
        {entries.map((e) => {
          const waiting = e.status === "proposed" || (!e.acknowledged && e.status === "auto_applied");
          const meta = [
            waiting || e.status === "failed" ? null : (STATUS[e.status] ?? e.status),
            e.confidence !== null && e.status !== "failed" && e.provider !== "human" ? confidenceText(e.confidence) : null,
            e.latest ? "latest reply" : null,
          ].filter(Boolean);
          return (
            <li key={e.id} className="grid gap-1 py-group text-sm first:pt-0 last:pb-0" data-testid="ai-pick">
              <div className="flex flex-wrap items-center gap-2">
                {e.status === "failed" && <Badge variant="destructive">Failed</Badge>}
                {e.status === "proposed" && <Badge variant="outline">Held for a check</Badge>}
                {!e.acknowledged && e.status === "auto_applied" && <Badge variant="outline">Not checked</Badge>}
                <span>{e.status === "proposed" ? `Picked ${label(e.proposed)}` : e.status === "failed" ? "No type picked." : `${label(e.previous)} to ${label(e.applied)}`}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                {meta.length > 0 && `${meta.join(" · ")} · `}
                <Time value={e.createdAt} />
              </p>
              {e.reasoning && <p className="text-muted-foreground">{e.reasoning}</p>}
              {e.error && <p className="text-destructive">{e.error}</p>}
              {(e.canAcknowledge || e.canUndo || (e.status === "proposed" && e.latest && e.conversationId !== currentConversationId)) && (
                <div className="flex flex-wrap gap-2 pt-1">
                  {e.status === "proposed" && e.latest && e.conversationId !== currentConversationId && (
                    <Link href={`/inbox/${e.conversationId}`} className="text-sm underline underline-offset-4 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center">
                      Review in that conversation
                    </Link>
                  )}
                  {e.canAcknowledge && (
                    <Button size="xs" variant="outline" className="max-sm:h-11" disabled={busy !== null} onClick={() => looksRight(e.id)}>
                      Looks right
                    </Button>
                  )}
                  {e.canUndo && (
                    <Tooltip>
                      <TooltipTrigger delay={150} render={<Button size="xs" variant="outline" className="max-sm:h-11" disabled={busy !== null} aria-describedby="undo-tip" onClick={() => undo(e.id)} />}>
                        Undo
                      </TooltipTrigger>
                      <TooltipContent className="block max-w-72 text-left leading-relaxed">{UNDO_TIP}</TooltipContent>
                    </Tooltip>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
