"use client";

import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import { useLeaveGuard } from "@/components/shell/use-leave-guard";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";

/**
 * The end of every Settings form: the error, then Save. Save stays off until something changed, and "Unsaved
 * changes" with Discard shows while it is on, so a person sees what a click would do. One size and one label, Save.
 */
export function SaveRow({ dirty, pending, error, baseChanged, onDiscard, label = "Save", pendingLabel = "Saving…" }: { dirty: boolean; pending: boolean; error?: string | null; baseChanged?: boolean; onDiscard?: () => void; label?: string; pendingLabel?: string }) {
  return (
    <>
      {error && <FieldError>{error}</FieldError>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={!dirty || pending}>
          {pending ? pendingLabel : label}
        </Button>
        {dirty && !pending && (
          <>
            <span role="status" className="text-sm text-muted-foreground">
              {baseChanged ? "Someone changed this since you opened it. Save replaces their change." : "Unsaved changes"}
            </span>
            {onDiscard && (
              <Button type="button" variant="ghost" onClick={onDiscard}>
                Discard
              </Button>
            )}
          </>
        )}
      </div>
    </>
  );
}

export { useLeaveGuard };

/** Move up and Move down for one row of an ordered list (custom fields, pipeline stages). `name` labels the buttons. */
export function ReorderButtons({ name, canUp, canDown, disabled, onMove }: { name: string; canUp: boolean; canDown: boolean; disabled?: boolean; onMove: (direction: -1 | 1) => void }) {
  return (
    <span className="flex items-center">
      <Button type="button" variant="ghost" size="icon-sm" aria-label={`Move ${name} up`} disabled={disabled || !canUp} onClick={() => onMove(-1)}>
        <ArrowUpIcon />
      </Button>
      <Button type="button" variant="ghost" size="icon-sm" aria-label={`Move ${name} down`} disabled={disabled || !canDown} onClick={() => onMove(1)}>
        <ArrowDownIcon />
      </Button>
    </span>
  );
}
