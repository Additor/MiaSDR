"use client";

import { PlayIcon, RotateCcwIcon, SquareIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { gridRequest, gridUrl } from "../_lib/data/client";
import { buildRunBody, DEFAULT_FIRST_N, retrySummary, runSummary, stopSummary, type RunScope } from "../_lib/data/run-request";
import type { GridColumn, JobCounts } from "../_lib/data/types";
import { ErrorText, Field } from "./form-bits";

interface RunReport {
  queued: number;
  rows: number;
  columns: string[];
  worstCaseCostCents: number;
}

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

interface DialogProps {
  tableId: string;
  /** The column to run, or null for every runnable column. */
  column: GridColumn | null;
  selectedRowIds: string[];
  /** Opens with "First N rows" chosen and N filled in. */
  initialFirstN?: number;
  onClose: () => void;
  onStarted: () => void;
}

/** Choose what to run: rows, whether to skip filled cells, and how much a run may cost. */
export function RunDialog({ tableId, column, selectedRowIds, initialFirstN, onClose, onStarted }: DialogProps) {
  const [scope, setScope] = useState<RunScope>(initialFirstN !== undefined ? "first" : selectedRowIds.length > 0 ? "selected" : "all");
  const [firstN, setFirstN] = useState(String(initialFirstN ?? DEFAULT_FIRST_N));
  const [onlyEmpty, setOnlyEmpty] = useState(true);
  const [maxRows, setMaxRows] = useState("1000");
  const [maxCost, setMaxCost] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    const built = buildRunBody({ columnKey: column?.key, scope, selectedRowIds, onlyEmpty, maxRows, firstN, maxCost });
    if ("error" in built) return setError(built.error);
    setBusy(true);
    setError(null);
    const res = await gridRequest<RunReport>(gridUrl.sub(tableId, "run"), "POST", built.body);
    if (!res.ok || !res.data) {
      setBusy(false);
      return setError(res.error);
    }
    toast.success(runSummary(res.data, dollars));
    onStarted();
    onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{column ? `Run ${column.name}` : "Run enrichments"}</DialogTitle>
          <DialogDescription>Calls your connected providers for each row. You can stop the run at any time. Calls already in progress finish.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <fieldset className="stack-field">
            <legend className="mb-1 text-sm font-medium">Rows</legend>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="run-scope" checked={scope === "all"} onChange={() => setScope("all")} /> All rows (up to the limit below)
            </label>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <label className="flex items-center gap-2">
                <input type="radio" name="run-scope" checked={scope === "first"} onChange={() => setScope("first")} /> First
              </label>
              <Input
                aria-label="Number of first rows"
                className="w-24"
                type="number"
                min={1}
                max={10000}
                value={firstN}
                onFocus={() => setScope("first")}
                onChange={(e) => {
                  setScope("first");
                  setFirstN(e.target.value);
                }}
              />
              <span>rows in table order</span>
            </div>
            <label className={`flex items-center gap-2 text-sm ${selectedRowIds.length === 0 ? "text-muted-foreground" : ""}`}>
              <input type="radio" name="run-scope" disabled={selectedRowIds.length === 0} checked={scope === "selected"} onChange={() => setScope("selected")} /> {selectedRowIds.length === 0 ? "Selected rows (select rows in the grid first)" : `${selectedRowIds.length.toLocaleString("en-US")} selected ${selectedRowIds.length === 1 ? "row" : "rows"}`}
            </label>
          </fieldset>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={onlyEmpty} onCheckedChange={(v) => setOnlyEmpty(v === true)} /> Skip cells that already have a value
          </label>
          <p className="-mt-1.5 text-xs text-muted-foreground">When you run the first rows, skipped cells do not count. The run goes on to the next row that has something to fill.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Row limit" htmlFor="run-rows" hint="Up to 10,000. A run that would cover more rows does not start. To run part of a table, choose the first rows option.">
              <Input id="run-rows" type="number" min={1} max={10000} value={maxRows} onChange={(e) => setMaxRows(e.target.value)} />
            </Field>
            <Field label="Cost cap (cents)" htmlFor="run-cost" hint="Optional. The run does not start if its worst case cost is above this.">
              <Input id="run-cost" type="number" min={0} value={maxCost} onChange={(e) => setMaxCost(e.target.value)} />
            </Field>
          </div>
          <ErrorText>{error}</ErrorText>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={start} disabled={busy}>
            <PlayIcon /> {busy ? "Queueing..." : "Run"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Progress of the queue with Stop and Retry failed. Hidden when the table has never run anything. */
export function RunProgress({ tableId, jobs, activeJobs, columnKey, onChanged }: { tableId: string; jobs: JobCounts | null; activeJobs: number; columnKey?: string; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  if (!jobs) return null;
  const pending = jobs.queued + jobs.running + jobs.waiting;
  const done = jobs.succeeded;
  const all = pending + done + jobs.failed;
  if (all === 0 && activeJobs === 0) return null;
  const pct = all === 0 ? 0 : Math.round(((done + jobs.failed) / all) * 100);

  async function stop() {
    setBusy(true);
    const res = await gridRequest<{ cancelled: number }>(gridUrl.sub(tableId, "run"), "DELETE");
    setBusy(false);
    if (!res.ok) toast.error(res.error ?? "Could not stop the run.");
    else toast.success(stopSummary(res.data?.cancelled ?? 0));
    onChanged();
  }
  async function retry() {
    setBusy(true);
    const res = await gridRequest<{ retried: number }>(gridUrl.sub(tableId, "run/retry"), "POST", columnKey ? { columnKey } : {});
    setBusy(false);
    if (!res.ok) toast.error(res.error ?? "Could not retry.");
    else toast.success(retrySummary(res.data?.retried ?? 0));
    onChanged();
  }

  return (
    <div className="flex items-center gap-2 rounded-lg border px-2.5 py-1 text-xs" role="status" aria-live="polite">
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Run progress">
        <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
      </div>
      <span className="tabular-nums">
        {pending > 0 ? `${pending.toLocaleString("en-US")} left` : "Done"} · {done.toLocaleString("en-US")} succeeded{jobs.failed > 0 ? ` · ${jobs.failed.toLocaleString("en-US")} failed` : ""}
      </span>
      {pending > 0 && (
        <Button type="button" size="xs" variant="outline" onClick={stop} disabled={busy}>
          <SquareIcon /> Stop
        </Button>
      )}
      {jobs.failed > 0 && (
        <Button type="button" size="xs" variant="outline" onClick={retry} disabled={busy}>
          <RotateCcwIcon /> Retry failed
        </Button>
      )}
    </div>
  );
}
