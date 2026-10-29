"use client";

import { PlayIcon, RotateCcwIcon, SquareIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { countOf, formatCount } from "@/shared/format-number";
import { gridRequest, gridUrl } from "../_lib/data/client";
import { buildRunBody, centsCapIsInert, DEFAULT_FIRST_N, estimateByProvider, estimateHeadline, retrySummary, runSummary, stopSummary, type RunEstimate, type RunScope } from "../_lib/data/run-request";
import type { GridColumn, JobCounts } from "../_lib/data/types";

interface RunReport extends RunEstimate {
  queued: number;
  columns: string[];
}

interface DialogProps {
  tableId: string;
  /** The column to run, or null for every runnable column. */
  column: GridColumn | null;
  selectedRowIds: string[];
  /** Opens with "First N rows" chosen and N filled in. */
  initialFirstN?: number;
  /** The table has never run: open on the first rows, so the first spend is a small test. */
  firstRun?: boolean;
  onClose: () => void;
  onStarted: () => void;
}

/** Choose what to run: rows, whether to skip filled cells, and how much a run may cost. */
export function RunDialog({ tableId, column, selectedRowIds, initialFirstN, firstRun, onClose, onStarted }: DialogProps) {
  const [scope, setScope] = useState<RunScope>(initialFirstN !== undefined ? "first" : selectedRowIds.length > 0 ? "selected" : firstRun ? "first" : "all");
  const [firstN, setFirstN] = useState(String(initialFirstN ?? DEFAULT_FIRST_N));
  const [onlyEmpty, setOnlyEmpty] = useState(true);
  const [maxRows, setMaxRows] = useState("1000");
  const [maxCost, setMaxCost] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<{ draft: string; report: RunReport | null; error?: string } | null>(null);

  // The worst case of the run as the form stands, asked of the server without queuing anything. An answer for an
  // older form never shows.
  const built = buildRunBody({ columnKey: column?.key, scope, selectedRowIds, onlyEmpty, maxRows, firstN, maxCost });
  const draft = "body" in built ? JSON.stringify(built.body) : null;
  const estimate = answer && answer.draft === draft ? answer.report : null;
  // The real run would refuse with the same words, such as a provider that is off or has no key.
  const estimateError = answer && answer.draft === draft ? answer.error : undefined;
  useEffect(() => {
    if (draft === null) return;
    let live = true;
    const timer = setTimeout(() => {
      void gridRequest<RunReport>(gridUrl.sub(tableId, "run"), "POST", { ...JSON.parse(draft), dryRun: true }).then((res) => {
        if (live) setAnswer({ draft, report: res.ok && res.data ? res.data : null, ...(res.ok ? {} : { error: res.error ?? "The estimate did not load." }) });
      });
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [draft, tableId]);

  async function start() {
    if ("error" in built) return setError(built.error);
    setBusy(true);
    setError(null);
    const res = await gridRequest<RunReport>(gridUrl.sub(tableId, "run"), "POST", built.body);
    if (!res.ok || !res.data) {
      setBusy(false);
      return setError(res.error);
    }
    toast.success(runSummary(res.data));
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
        <FieldGroup>
          <FieldSet>
            <FieldLegend variant="label">Rows</FieldLegend>
            <RadioGroup value={scope} onValueChange={(v) => setScope(v as RunScope)}>
              <Field orientation="horizontal">
                <RadioGroupItem value="all" id="run-scope-all" />
                <FieldLabel htmlFor="run-scope-all" className="font-normal">
                  All rows (up to the limit below)
                </FieldLabel>
              </Field>
              {/* The count field sits inside the option's sentence, so this row lays itself out. */}
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <RadioGroupItem value="first" id="run-scope-first" />
                <FieldLabel htmlFor="run-scope-first" className="font-normal">
                  First
                </FieldLabel>
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
              <Field orientation="horizontal">
                <RadioGroupItem value="selected" id="run-scope-selected" disabled={selectedRowIds.length === 0} />
                <FieldLabel htmlFor="run-scope-selected" className={`font-normal ${selectedRowIds.length === 0 ? "text-muted-foreground" : ""}`}>
                  {selectedRowIds.length === 0 ? "Selected rows (select rows in the grid first)" : countOf(selectedRowIds.length, "selected row")}
                </FieldLabel>
              </Field>
            </RadioGroup>
          </FieldSet>
          <Field orientation="horizontal">
            <Checkbox id="run-only-empty" checked={onlyEmpty} onCheckedChange={(v) => setOnlyEmpty(v === true)} />
            <FieldContent>
              <FieldLabel htmlFor="run-only-empty">Skip cells that already have a value</FieldLabel>
              <FieldDescription>When you run the first rows, skipped cells do not count. The run goes on to the next row that has something to fill.</FieldDescription>
            </FieldContent>
          </Field>
          <div className="grid gap-group sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="run-rows">Row limit</FieldLabel>
              <Input id="run-rows" type="number" min={1} max={10000} value={maxRows} onChange={(e) => setMaxRows(e.target.value)} aria-describedby="run-rows-hint" />
              <FieldDescription id="run-rows-hint">Up to 10,000. A run that would cover more rows does not start. To run part of a table, choose the first rows option.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="run-cost">Cost cap ($)</FieldLabel>
              <Input id="run-cost" type="number" min={0} step={0.01} value={maxCost} onChange={(e) => setMaxCost(e.target.value)} aria-describedby="run-cost-hint" />
              <FieldDescription id="run-cost-hint">
                {estimate && centsCapIsInert(estimate) ? "Your providers have no price, so a dollar cap cannot stop this run. Give a provider a price, or cap credits on the column." : "Optional. The run does not start if its worst case cost is above this."}
              </FieldDescription>
            </Field>
          </div>
          {/* The worst case reads as body text under the fields: a dialog's status region draws no box. */}
          <section aria-live="polite" aria-label="Worst case of this run" className="grid gap-1 text-sm">
            {estimate ? (
              <>
                <p className="font-medium tabular-nums">{estimate.cells === 0 ? "Nothing to run. Inputs are empty or the cells are already filled." : estimateHeadline(estimate)}</p>
                {estimate.cells > 0 && estimate.providers.length > 0 && <p className="text-xs text-muted-foreground tabular-nums">{estimateByProvider(estimate)}</p>}
                {estimate.cells > 0 && (estimate.aiCells ?? 0) > 0 && <p className="text-xs text-muted-foreground">AI calls use your organization&apos;s AI key and are billed by that provider.</p>}
                {!column && estimate.columnNames && estimate.columnNames.length > 0 && <p className="text-xs text-muted-foreground">Columns: {estimate.columnNames.join(", ")}.</p>}
                {estimate.dependents.length > 0 && <p className="text-xs text-muted-foreground">Includes the auto-run {estimate.dependents.length === 1 ? "column" : "columns"} {estimate.dependents.join(", ")}, which fill after this run.</p>}
                {estimate.problem && <p className="text-xs text-destructive">{estimate.problem}</p>}
              </>
            ) : (
              <p className={estimateError ? "text-destructive" : "text-muted-foreground"}>{draft === null ? "Fix the field above to see what this run costs." : (estimateError ?? "Counting what this run can cost…")}</p>
            )}
          </section>
          <FieldError>{error}</FieldError>
        </FieldGroup>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={start} disabled={busy || !!estimateError || estimate?.cells === 0 || !!estimate?.problem}>
            <PlayIcon /> {busy ? "Queueing…" : estimate && estimate.cells > 0 ? `Run ${countOf(estimate.rows, "row")}` : "Run"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Progress of the queue with Stop and Retry failed. Hidden when the table has never run anything. */
export function RunProgress({
  tableId,
  jobs,
  activeJobs,
  columnKey,
  onChanged,
  onShowFailed,
}: {
  tableId: string;
  jobs: JobCounts | null;
  activeJobs: number;
  columnKey?: string;
  onChanged: () => void;
  /** Filters the grid to the rows whose run failed. */
  onShowFailed?: () => void;
}) {
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
        <div className="h-full w-full origin-left bg-primary transition-transform duration-(--duration-drawer) ease-out" style={{ transform: `scaleX(${pct / 100})` }} />
      </div>
      <span className="tabular-nums">
        {pending > 0 ? `${formatCount(pending)} left` : "Done"} · {formatCount(done)} succeeded
        {jobs.failed > 0 && " · "}
        {jobs.failed > 0 &&
          (onShowFailed ? (
            <Tooltip>
              <TooltipTrigger
                render={<button type="button" className="font-medium text-destructive underline underline-offset-2 hover:no-underline focus-ring" onClick={onShowFailed} />}
              >
                {formatCount(jobs.failed)} failed
              </TooltipTrigger>
              <TooltipContent>Show only the rows whose run failed</TooltipContent>
            </Tooltip>
          ) : (
            `${formatCount(jobs.failed)} failed`
          ))}
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
