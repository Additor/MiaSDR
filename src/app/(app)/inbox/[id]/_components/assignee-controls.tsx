"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { callApi } from "@/app/_lib/api-client";
import { memberItems, type MemberChoice } from "@/app/(app)/crm/_components/member-select";

const NOBODY = "__nobody__";

/**
 * Who handles the replies of this conversation. Take it when nobody does, or give it to another member, or to nobody.
 * Every change names who the person saw holding it, so a change made in the meantime answers 409 instead of being
 * overwritten, and the page reloads to show the current holder.
 */
export function AssigneeControls({ recordId, assignedTo, members, currentUserId }: { recordId: string; assignedTo: string | null; members: readonly MemberChoice[]; currentUserId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const items = memberItems(members, currentUserId, assignedTo, { value: NOBODY, label: "Nobody", at: "start" });

  async function change(body: { action: "claim" } | { action: "assign"; assignedTo: string | null; expectedAssignedTo: string | null }) {
    setPending(true);
    const result = await callApi(`/api/records/${recordId}/assignee`, "POST", body);
    setPending(false);
    if (!result.ok) {
      toast.error(result.error ?? "Could not change who handles this conversation.");
      // A refusal means the holder changed under us. Reload to show who holds it now.
      router.refresh();
      return;
    }
    router.refresh();
  }

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {assignedTo !== currentUserId && (
          <Button size="sm" variant="outline" disabled={pending || assignedTo !== null} onClick={() => change({ action: "claim" })} className="max-sm:h-11">
            Take it
          </Button>
        )}
        <Select
          items={items}
          value={assignedTo ?? NOBODY}
          onValueChange={(v) => {
            const next = v === NOBODY || v === null ? null : String(v);
            if (next !== assignedTo) void change({ action: "assign", assignedTo: next, expectedAssignedTo: assignedTo });
          }}
          disabled={pending}
        >
          <SelectTrigger size="sm" aria-label="Assign to" className="w-44 max-sm:h-11">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
