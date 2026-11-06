"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { useSelection } from "@/components/shell/selection";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { orThrow, runApiAction } from "@/app/_lib/api-action";
import { callApi } from "@/app/_lib/api-client";
import { useApiAction } from "@/app/_lib/use-api-action";
import { FIT_MAX_PEOPLE } from "@/contexts/mia/domain/mia-run";
import { formatCount } from "@/shared/format-number";

/** What today's tokens still cover, read on the server when the page renders. */
export interface FitRoom {
  people: number;
  perLead: number;
  tokensLeft: number;
}

const leads = (n: number) => `${formatCount(n)} ${n === 1 ? "lead" : "leads"}`;

function useStartFit() {
  const router = useRouter();
  return async (personIds: string[]) => {
    const data = orThrow(await runApiAction(callApi<{ queued: number; skipped: number }>("/api/mia/fit-batches", "POST", { personIds }), { refresh: () => router.refresh(), expectData: true }));
    const skipped = data.skipped > 0 ? ` ${leads(data.skipped)} already had a check going.` : "";
    toast.success(`Mia is checking ${leads(data.queued)}.${skipped}`);
  };
}

/**
 * The confirm names what a check reads and sends, and what it may cost against today's tokens. It refuses more than
 * today covers before anything starts, so a batch never stops halfway for a limit the person was not shown.
 */
function FitConfirm({
  open,
  onOpenChange,
  count,
  room,
  refused = null,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  count: number;
  room: FitRoom;
  /** Why no check can start, shown in place of the token line's error. */
  refused?: string | null;
  onConfirm: () => Promise<void>;
}) {
  const over = count > room.people;
  const reason = refused ?? (over ? (room.people === 0 ? "Today's tokens cover no more checks. Try again after midnight UTC." : `Today's tokens cover ${leads(room.people)}. Pick fewer.`) : null);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={count === 1 ? "Check this lead's fit?" : `Check the fit of ${leads(count)}?`}
      description={`Mia reads each lead's profile, company and latest messages with your ICP and qualification rules, and sends them to your AI provider. A person decides; nothing changes on the lead. Up to ${formatCount(count * room.perLead)} tokens, of ${formatCount(room.tokensLeft)} left today.`}
      confirmLabel={count === 1 ? "Check fit" : `Check ${leads(count)}`}
      pendingLabel="Starting…"
      confirmDisabled={reason !== null}
      onConfirm={onConfirm}
    >
      {reason && <FieldError>{reason}</FieldError>}
    </ConfirmDialog>
  );
}

/** What the lead list's Check fit needs: why Mia cannot check now, if so, and what today's tokens cover. */
export interface BulkFit {
  unavailable: string | null;
  room: FitRoom;
}

/**
 * Check fit from the selection bar's menu: checks the ticked leads, on any page. The menu item always opens this, and
 * a reason to refuse (Mia off, too many leads, today's tokens) shows here with Check turned off.
 */
export function BulkFitDialog({ open, onOpenChange, fit }: { open: boolean; onOpenChange: (open: boolean) => void; fit: BulkFit }) {
  const { selectedIds, clear } = useSelection();
  const start = useStartFit();
  const refused = fit.unavailable ?? (selectedIds.length > FIT_MAX_PEOPLE ? `Check up to ${FIT_MAX_PEOPLE} leads at a time.` : null);
  return (
    <FitConfirm
      open={open}
      onOpenChange={onOpenChange}
      count={selectedIds.length}
      room={fit.room}
      refused={refused}
      onConfirm={async () => {
        await start(selectedIds);
        clear();
      }}
    />
  );
}

/** The lead page's button: a first check, or one more after something changed. */
export function CheckLeadFit({ personId, unavailable, room, checked }: { personId: string; unavailable: string | null; room: FitRoom; checked: boolean }) {
  const [open, setOpen] = useState(false);
  const start = useStartFit();
  return (
    <>
      <Button size="sm" variant="outline" disabled={unavailable !== null} title={unavailable ?? undefined} onClick={() => setOpen(true)}>
        {checked ? "Check again" : "Check fit"}
      </Button>
      <FitConfirm open={open} onOpenChange={setOpen} count={1} room={room} onConfirm={() => start([personId])} />
    </>
  );
}

export interface FitBatchLineData {
  id: string;
  total: number;
  done: number;
  failed: number;
  cancelled: number;
  going: number;
  waiting: number;
  failedPersonIds: string[];
  firstError: string | null;
}

const POLL_MS = 3_000;

function lineOf(batch: FitBatchLineData): string {
  const checked = `${formatCount(batch.done)} of ${leads(batch.total)} checked`;
  if (batch.going > 0) return `Mia is checking fit: ${checked}.`;
  if (batch.waiting > 0) return `Fit check waiting for tomorrow's tokens: ${checked}.`;
  const failed = batch.failed > 0 ? ` ${formatCount(batch.failed)} failed${batch.firstError ? `: ${batch.firstError}` : "."}` : "";
  const stopped = batch.cancelled > 0 ? ` ${formatCount(batch.cancelled)} stopped.` : "";
  return `Fit check finished: ${checked}.${failed}${stopped}`;
}

/** The latest fit batch above the list. The page refreshes while checks run, since they run on the server. */
export function FitBatchLine({ batch }: { batch: FitBatchLineData }) {
  const router = useRouter();
  const { isBusy, run } = useApiAction<"stop" | "retry">();
  const [error, setError] = useState<string | null>(null);
  const start = useStartFit();
  const moving = batch.going > 0;
  useEffect(() => {
    if (!moving) return;
    const timer = setInterval(() => router.refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [moving, router]);

  const stop = () =>
    run("stop", async () => {
      setError(null);
      const result = await runApiAction(callApi(`/api/mia/fit-batches/${batch.id}/cancel`, "POST", {}), { refresh: () => router.refresh() });
      if (!result.ok) setError(result.error);
    });
  const retry = () =>
    run("retry", async () => {
      setError(null);
      try {
        await start(batch.failedPersonIds);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not start the checks.");
      }
    });
  const active = batch.going + batch.waiting > 0;
  return (
    <div role="status" className="flex flex-wrap items-center gap-2 text-sm" data-testid="fit-batch">
      <span className={batch.failed > 0 && !active ? "text-destructive" : "text-muted-foreground"}>{lineOf(batch)}</span>
      {active && (
        <Button size="sm" variant="ghost" disabled={isBusy("stop")} onClick={() => void stop()}>
          Stop
        </Button>
      )}
      {!active && batch.failedPersonIds.length > 0 && (
        <Button size="sm" variant="ghost" disabled={isBusy("retry")} onClick={() => void retry()}>
          Try the failed ones again
        </Button>
      )}
      {error && <FieldError>{error}</FieldError>}
    </div>
  );
}
