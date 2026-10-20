"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Time } from "@/components/shell/time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { callApi } from "@/lib/api-client";
import { categoryLabel } from "@/app/(app)/crm/_components/labels";
import { AsideSection } from "@/app/(app)/crm/_components/record/record-header";

interface Entry {
  id: string;
  status: string;
  conversationId: string;
  previous: { categoryKey: string | null; name: string | null };
  proposed: { categoryKey: string | null; name: string | null };
  applied: { categoryKey: string | null; name: string | null };
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

const label = (c: { categoryKey: string | null; name: string | null }) => (c.categoryKey ? `${categoryLabel(c.categoryKey)}${c.name ? `: ${c.name}` : ""}` : "Unclassified");

const STATUS: Record<string, string> = {
  proposed: "Held for review",
  auto_applied: "Applied by AI",
  accepted: "Accepted",
  overridden: "Changed by a person",
  rejected: "Undone",
  stale: "Out of date",
  failed: "Failed",
};

/** What the AI decided about each reply, with acknowledge and undo on the ones a person may still change. */
export function ClassificationHistory({ entries, currentConversationId }: { entries: Entry[]; currentConversationId?: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function act(id: string, action: "undo" | "acknowledge") {
    setBusy(id);
    setError(null);
    const result = await callApi(`/api/crm/classifications/${id}/${action}`, "POST");
    setBusy(null);
    if (!result.ok) return setError(result.error);
    toast.success(action === "undo" ? "Classification undone." : "Classification marked as reviewed.");
    router.refresh();
  }

  return (
    <AsideSection title="Classification history" testId="thread-classifications">
      <p className="text-sm text-muted-foreground">Undo restores the category this person had before the AI changed it. Held suggestions are accepted or changed in the reply panel.</p>
      {entries.length === 0 && <p className="text-sm text-muted-foreground">Nothing classified yet.</p>}
      {entries.length > 0 && (
        <ul className="divide-y">
          {entries.map((e) => (
            <li key={e.id} className="grid gap-1 py-group text-sm first:pt-0 last:pb-0" data-testid="classification-entry">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={e.status === "failed" ? "destructive" : e.status === "proposed" ? "outline" : "secondary"}>{STATUS[e.status] ?? e.status}</Badge>
                {e.confidence !== null && e.status !== "failed" && <Badge variant="outline">{Math.round(e.confidence * 100)}%</Badge>}
                {e.latest && <Badge variant="outline">Latest reply</Badge>}
                {!e.acknowledged && e.status === "auto_applied" && <Badge variant="outline">Not reviewed</Badge>}
                <Time value={e.createdAt} className="text-xs text-muted-foreground" />
              </div>
              <div>
                {e.status === "proposed" ? `Suggests ${label(e.proposed)}` : e.status === "failed" ? "No category chosen." : `${label(e.previous)} to ${label(e.applied)}`}
              </div>
              {e.reasoning && <p className="text-muted-foreground">{e.reasoning}</p>}
              {e.error && <p className="text-destructive">{e.error}</p>}
              <div className="flex flex-wrap gap-2 pt-1">
                {e.status === "proposed" && e.latest && e.conversationId !== currentConversationId && (
                  <Link href={`/inbox/${e.conversationId}`} className="text-sm underline underline-offset-4">
                    Review in that conversation
                  </Link>
                )}
                {e.canAcknowledge && (
                  <Button size="xs" variant="outline" disabled={busy !== null} onClick={() => act(e.id, "acknowledge")}>
                    Mark reviewed
                  </Button>
                )}
                {e.canUndo && (
                  <Button size="xs" variant="outline" disabled={busy !== null} onClick={() => act(e.id, "undo")}>
                    Undo
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </AsideSection>
  );
}
