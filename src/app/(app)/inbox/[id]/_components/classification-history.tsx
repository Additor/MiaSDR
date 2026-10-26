"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Time } from "@/components/shell/time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { callApi } from "@/app/_lib/api-client";
import { groupLabel } from "@/contexts/conversations/domain/reply-handling";

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

/** "Interested: Demo request", or just "Other" when the subcategory repeats the category. */
const label = (c: { groupKey: string | null; name: string | null }) => {
  if (!c.groupKey) return "Unclassified";
  const category = groupLabel(c.groupKey);
  return c.name && c.name.trim().toLowerCase() !== category.toLowerCase() ? `${category}: ${c.name}` : category;
};

const STATUS: Record<string, string> = {
  proposed: "Held for review",
  auto_applied: "Applied by AI",
  accepted: "Accepted",
  overridden: "Changed by a person",
  rejected: "Undone",
  stale: "Out of date",
  failed: "Failed",
};

/**
 * What the AI decided about each reply, with Mark reviewed and Undo on the ones a person may still change. Only an entry
 * that waits for a person carries a badge; the rest of its facts read as one muted line. The caller frames it and leaves
 * it out when there are no entries.
 */
export function ClassificationHistory({ entries, currentConversationId }: { entries: Entry[]; currentConversationId?: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function act(id: string, action: "undo" | "acknowledge") {
    setBusy(id);
    setError(null);
    const result = await callApi(`/api/reply-type-picks/${id}/${action}`, "POST");
    setBusy(null);
    if (!result.ok) return setError(result.error);
    toast.success(action === "undo" ? "Classification undone." : "Classification marked as reviewed.");
    router.refresh();
  }

  return (
    <div className="grid gap-2" data-testid="thread-classifications">
      <ul className="divide-y">
        {entries.map((e) => {
          const waiting = e.status === "proposed" || (!e.acknowledged && e.status === "auto_applied");
          const meta = [
            waiting || e.status === "failed" ? null : STATUS[e.status] ?? e.status,
            e.confidence !== null && e.status !== "failed" ? `${Math.round(e.confidence * 100)}% confident` : null,
            e.latest ? "latest reply" : null,
          ].filter(Boolean);
          return (
            <li key={e.id} className="grid gap-1 py-group text-sm first:pt-0 last:pb-0" data-testid="classification-entry">
              <div className="flex flex-wrap items-center gap-2">
                {e.status === "failed" && <Badge variant="destructive">Failed</Badge>}
                {e.status === "proposed" && <Badge variant="outline">Held for review</Badge>}
                {!e.acknowledged && e.status === "auto_applied" && <Badge variant="outline">Not reviewed</Badge>}
                <span>{e.status === "proposed" ? `Suggests ${label(e.proposed)}` : e.status === "failed" ? "No category chosen." : `${label(e.previous)} to ${label(e.applied)}`}</span>
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
                    <Button size="xs" variant="outline" className="max-sm:h-11" disabled={busy !== null} onClick={() => act(e.id, "acknowledge")}>
                      Mark reviewed
                    </Button>
                  )}
                  {e.canUndo && (
                    <Button size="xs" variant="outline" className="max-sm:h-11" disabled={busy !== null} title="Restores the category from before the AI changed it" onClick={() => act(e.id, "undo")}>
                      Undo
                    </Button>
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
