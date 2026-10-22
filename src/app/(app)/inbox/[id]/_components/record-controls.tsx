"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { callApi } from "@/lib/api-client";

export const CLOSE_REASON_REQUIRED = "Type a reason to close reply handling.";

/**
 * Close reply handling with a reason, or reopen it. Closed, it is one line with Reopen in the Reply category block, where
 * the missing Change category shows. Open, it is the quiet close at the foot of the panel: the button opens the reason and
 * what closing does in place, and only the confirm button is red. Closing stops follow-ups and retires unsent drafts.
 */
export function RecordControls({ recordId, closed, closedReason }: { recordId: string; closed: boolean; closedReason: string | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const fieldId = `close-reason-${recordId}`;

  async function send(path: "close" | "reopen") {
    setPending(true);
    setError(null);
    const result = await callApi(`/api/records/${recordId}/${path}`, "POST", path === "close" ? { reason: reason.trim() } : undefined);
    setPending(false);
    if (!result.ok) return setError(result.error ?? "Could not change reply handling. Try again.");
    setReason("");
    setOpen(false);
    toast.success(path === "close" ? "Reply handling closed." : "Reply handling reopened.");
    router.refresh();
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (reason.trim() === "") return setError(CLOSE_REASON_REQUIRED);
    void send("close");
  }

  return (
    <div className="grid gap-2" data-testid="reply-handling">
      {closed ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm">Reply handling closed{closedReason ? `: ${closedReason}.` : "."}</p>
          <Button size="sm" variant="outline" disabled={pending} className="max-sm:h-11" onClick={() => void send("reopen")}>
            {pending ? "Reopening…" : "Reopen"}
          </Button>
        </div>
      ) : !open ? (
        <div>
          <Button size="sm" variant="outline" className="max-sm:h-11" onClick={() => setOpen(true)}>
            Close reply handling
          </Button>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="grid gap-2" noValidate>
          <p className="text-sm">Closing stops follow-ups on every channel and retires unsent drafts. You can reopen it later.</p>
          <div className="stack-field">
            <Label htmlFor={fieldId}>Reason</Label>
            <Input
              id={fieldId}
              autoFocus
              value={reason}
              maxLength={500}
              placeholder="Went with a competitor"
              aria-invalid={error === CLOSE_REASON_REQUIRED ? true : undefined}
              aria-describedby={error ? `${fieldId}-error` : undefined}
              className="max-sm:h-11"
              onChange={(e) => {
                setReason(e.target.value);
                if (error === CLOSE_REASON_REQUIRED) setError(null);
              }}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" variant="destructive" disabled={pending} className="max-sm:h-11">
              {pending ? "Closing…" : "Confirm close"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={pending}
              className="max-sm:h-11"
              onClick={() => {
                setOpen(false);
                setReason("");
                setError(null);
              }}
            >
              Keep reply handling
            </Button>
          </div>
        </form>
      )}
      {error && (
        <p id={`${fieldId}-error`} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
