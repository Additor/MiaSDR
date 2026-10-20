"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { callApi } from "@/lib/api-client";

/** Close reply handling with a reason, or reopen it. Closing asks first because it stops the person's follow-ups and retires their unsent drafts. */
export function RecordControls({ recordId, personName, closed }: { recordId: string; personName: string; closed: boolean }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);

  async function reopen() {
    setPending(true);
    setError(null);
    const result = await callApi(`/api/crm/records/${recordId}/reopen`, "POST");
    setPending(false);
    if (!result.ok) return setError(result.error);
    toast.success("Reply handling reopened.");
    router.refresh();
  }

  async function close() {
    const result = await callApi(`/api/crm/records/${recordId}/close`, "POST", { reason: reason.trim() });
    if (!result.ok) throw new Error(result.error ?? "Could not close reply handling. Try again.");
    setReason("");
    toast.success("Reply handling closed.");
    router.refresh();
  }

  return (
    <div className="grid gap-2">
      {closed ? (
        <div>
          <Button size="sm" variant="outline" disabled={pending} onClick={reopen}>
            {pending ? "Reopening…" : "Reopen"}
          </Button>
        </div>
      ) : (
        <div className="grid gap-2">
          <div className="grid gap-1">
            <Label htmlFor="close-reason">Close with a reason</Label>
            <Input id="close-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="Went with a competitor" className="w-full" />
          </div>
          <Button size="sm" variant="outline" className="w-fit" disabled={reason.trim() === ""} onClick={() => setConfirmClose(true)}>
            Close reply handling
          </Button>
        </div>
      )}
      <p className="text-xs text-muted-foreground">Closes reply handling for this person on every channel.</p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={confirmClose}
        onOpenChange={setConfirmClose}
        title={`Close reply handling for ${personName}?`}
        description="Follow-ups stop and drafts that were not sent are retired. You can reopen reply handling later."
        confirmLabel="Close reply handling"
        pendingLabel="Closing…"
        destructive
        onConfirm={close}
      >
        <p className="text-sm text-muted-foreground">Reason: {reason.trim()}</p>
      </ConfirmDialog>
    </div>
  );
}
