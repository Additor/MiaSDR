"use client";

import { PlayIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Time } from "@/components/shell/time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { contractAction, type ContractKey } from "@/contexts/grid/enrichment/domain/enrichment-contracts";
import { runnerActionKey } from "@/contexts/grid/domain/verified-push";
import { OUTCOMES } from "../_lib/data/outcomes";
import { useProviders } from "../_lib/data/providers";
import { gridRequest, gridUrl } from "../_lib/data/client";
import { cellResultText, displayValue, editorText, RUN_OUTCOME_LABELS, runCost, typeLabel } from "../_lib/view/format";
import type { GridColumn, GridRow } from "../_lib/data/types";

interface Props {
  tableId: string;
  row: GridRow;
  column: GridColumn;
  rowNumber: number;
  /** Runs the cell again, for a cell a run fills. */
  onRun?: () => void;
  /** Every column of the table, to find the enrichment behind the cell and the fields it already shows. */
  columns?: GridColumn[];
  /** Adds one more field of an enrichment as its own column. */
  onAddOutput?: (runner: GridColumn, outputKey: string, outputName: string) => Promise<void>;
  onClose: () => void;
}

/**
 * The fields an enrichment behind this cell returns that have no column yet. Only the shared outcomes list their fields
 * here; another action's fields show in its dialog.
 */
function missingFields(source: GridColumn | undefined, columns: readonly GridColumn[]): Array<{ key: string; name: string }> {
  const actionKey = source ? runnerActionKey(source) : null;
  if (!source || !OUTCOMES.some((o) => o.actionKey === actionKey)) return [];
  const action = contractAction(actionKey as ContractKey);
  const shown = (source.config.outputs ?? {}) as Record<string, string>;
  return action.outputs.filter((o) => o.key !== action.primaryOutput && !(shown[o.key] && columns.some((c) => c.key === shown[o.key])));
}

interface Run {
  id: string;
  provider: string | null;
  outcome: string;
  costCents: number;
  credits: number | null;
  reused?: boolean;
  latencyMs: number | null;
  request: unknown;
  response: unknown;
  createdAt: string;
}

interface Details {
  sourceColumnKey: string;
  sourceColumnName: string;
  sourceColumnType: string;
  run: Run | null;
}

const OUTCOME_VARIANT: Record<string, "secondary" | "destructive" | "outline"> = { hit: "secondary", miss: "outline", error: "destructive", failed: "destructive" };

const pretty = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));

/** The reason a failed run gave, from its stored response. */
function runError(run: Run): string | null {
  if (run.outcome !== "error" && run.outcome !== "failed") return null;
  const r = run.response as { error?: unknown; detail?: unknown } | null;
  const text = typeof r?.error === "string" ? r.error : typeof r?.detail === "string" ? r.detail : null;
  return text?.trim() || null;
}

/** Everything known about one cell: its value, the state of its last run and the history of attempts. */
export function CellDrawer({ tableId, row, column, rowNumber, onRun, columns = [], onAddOutput, onClose }: Props) {
  const [adding, setAdding] = useState<string | null>(null);
  // Runs record the provider's key; the drawer names it as the provider list does. An AI run keeps its model label.
  const { providers } = useProviders();
  const providerName = (key: string) => providers.find((p) => p.key === key)?.name ?? key;
  const [details, setDetails] = useState<Details | null>(null);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [state, setState] = useState<"loading" | "none" | "failed" | "ready">("loading");
  const [attempt, setAttempt] = useState(0);
  // Focus lands on the drawer's body, not on Run this cell, so a stray Enter never starts a paid run.
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const params = new URLSearchParams({ rowId: row.id, columnKey: column.key });
      const d = await gridRequest<Details>(`${gridUrl.sub(tableId, "cell-details")}?${params}`, "GET");
      if (cancelled) return;
      // 404 means no run fills this cell; anything else is a failed load the person can retry.
      if (!d.ok || !d.data) return setState(d.status === 404 ? "none" : "failed");
      setDetails(d.data);
      const h = await gridRequest<{ runs: Run[] }>(`${gridUrl.sub(tableId, "cell-runs")}?${params}`, "GET");
      if (cancelled) return;
      if (!h.ok || !h.data) return setState("failed");
      setRuns(h.data.runs);
      setState("ready");
    })();
    return () => {
      cancelled = true;
    };
  }, [tableId, row.id, column.key, attempt]);

  const value = row.cells[column.key];
  // An output column's run state sits on the column that ran.
  const meta = row.cellMeta[column.key] ?? (details ? row.cellMeta[details.sourceColumnKey] : undefined);
  // Verdicts read in words (Catch-all); the stored code shows underneath when it differs.
  const shown = typeof value === "string" ? displayValue(value, column) : "";
  const text = shown || editorText(value);
  const latestError = meta?.error ?? (runs?.[0] ? runError(runs[0]) : null);

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent initialFocus={body} className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{column.name}</SheetTitle>
          <SheetDescription>
            Row {rowNumber} · {typeLabel(column.type)}
          </SheetDescription>
        </SheetHeader>
        <div ref={body} tabIndex={-1} className="grid gap-section px-4 pb-6 text-sm outline-none">
          <section aria-labelledby="cd-value" className="stack-group">
            <div className="flex min-h-7 items-center justify-between gap-3">
              <h3 id="cd-value" className="text-sm font-semibold">
                Value
              </h3>
              {onRun && (
                <Button size="sm" variant="outline" className="max-sm:h-11" onClick={onRun}>
                  <PlayIcon /> Run this cell
                </Button>
              )}
            </div>
            <p className="max-h-64 overflow-auto rounded-lg border bg-muted/40 p-2.5 [overflow-wrap:anywhere] whitespace-pre-wrap">{text || <span className="text-muted-foreground">Empty</span>}</p>
            {typeof value === "string" && shown !== value && <p className="text-xs text-muted-foreground">Stored as {value}</p>}
          </section>

          {(meta || latestError) && (
            <section aria-labelledby="cd-state" className="stack-group">
              <h3 id="cd-state" className="text-sm font-semibold">
                Last run
              </h3>
              {latestError && (
                <p role="status" className="text-destructive">
                  {latestError}
                </p>
              )}
              {meta && (
                <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-1">
                  {cellResultText(meta, shown !== "") && (
                    <>
                      <dt className="text-muted-foreground">Result</dt>
                      <dd>{cellResultText(meta, shown !== "")}</dd>
                    </>
                  )}
                  {(meta.costCents !== undefined || meta.credits !== undefined) && (
                    <>
                      <dt className="text-muted-foreground">Cost</dt>
                      <dd className="tabular-nums">{runCost({ costCents: meta.costCents ?? 0, credits: meta.credits ?? null })}</dd>
                    </>
                  )}
                  {meta.unanswered && meta.unanswered.length > 0 && (
                    <>
                      <dt className="text-muted-foreground">Did not answer</dt>
                      <dd>
                        <ul className="grid gap-0.5">
                          {meta.unanswered.map((line) => (
                            <li key={line}>{line}</li>
                          ))}
                        </ul>
                      </dd>
                    </>
                  )}
                  {meta.reason && meta.status === "queued" && (
                    <>
                      <dt className="text-muted-foreground">Waiting for</dt>
                      <dd>{meta.reason}</dd>
                    </>
                  )}
                  {meta.provider && (
                    <>
                      <dt className="text-muted-foreground">Provider</dt>
                      <dd>{providerName(meta.provider)}</dd>
                    </>
                  )}
                  {meta.runAt && (
                    <>
                      <dt className="text-muted-foreground">Ran at</dt>
                      <dd>
                        <Time value={meta.runAt} />
                      </dd>
                    </>
                  )}
                </dl>
              )}
            </section>
          )}

          {(() => {
            const source = details ? columns.find((c) => c.key === details.sourceColumnKey) : undefined;
            const fields = onAddOutput ? missingFields(source, columns) : [];
            if (!source || fields.length === 0) return null;
            return (
              <section aria-labelledby="cd-fields" className="stack-group">
                <h3 id="cd-fields" className="text-sm font-semibold">
                  More fields
                </h3>
                <p className="text-muted-foreground">{source.name} also returns these. A field added as a column fills from the answers the column already has, without a new call.</p>
                <ul className="divide-y rounded-lg border">
                  {fields.map((f) => (
                    <li key={f.key} className="flex items-center justify-between gap-3 px-3 py-1.5">
                      <span>{f.name}</span>
                      <Button
                        size="xs"
                        variant="outline"
                        className="max-sm:h-11"
                        disabled={adding !== null}
                        onClick={async () => {
                          setAdding(f.key);
                          await onAddOutput!(source, f.key, f.name);
                          setAdding(null);
                        }}
                      >
                        {adding === f.key ? "Adding..." : "Add as column"}
                      </Button>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })()}

          <section aria-labelledby="cd-runs" className="stack-group">
            <h3 id="cd-runs" className="text-sm font-semibold">
              Run history
            </h3>
            {state === "loading" && <p className="text-muted-foreground">Loading…</p>}
            {state === "none" && <p className="text-muted-foreground">This cell was typed or imported, so it has no runs.</p>}
            {state === "failed" && (
              <div role="alert" className="grid gap-2">
                <p>The run history did not load.</p>
                <div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="max-sm:h-11"
                    onClick={() => {
                      setState("loading");
                      setAttempt((n) => n + 1);
                    }}
                  >
                    Try again
                  </Button>
                </div>
              </div>
            )}
            {state === "ready" && details && (
              <>
                <p className="text-muted-foreground">
                  Produced by {details.sourceColumnName} ({typeLabel(details.sourceColumnType)}).
                </p>
                {runs && runs.length === 0 && <p className="text-muted-foreground">No recorded runs yet.</p>}
                {runs && runs.length > 0 && (
                  <ol className="divide-y border-t">
                    {runs.map((r) => {
                      const error = runError(r);
                      return (
                        <li key={r.id} className="grid gap-1 py-2.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant={OUTCOME_VARIANT[r.outcome] ?? "outline"}>{RUN_OUTCOME_LABELS[r.outcome] ?? r.outcome}</Badge>
                            {r.reused && <Badge variant="outline">Reused</Badge>}
                            {r.provider && <span>{providerName(r.provider)}</span>}
                            <Time value={r.createdAt} className="text-xs text-muted-foreground" />
                            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                              {runCost(r)}
                              {r.latencyMs !== null && !r.reused ? ` · ${r.latencyMs} ms` : ""}
                            </span>
                          </div>
                          {error && <p className="text-destructive">{error}</p>}
                          {r.response !== null && r.response !== undefined && (
                            <details>
                              <summary className="w-fit cursor-pointer rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring max-sm:py-2">Response</summary>
                              <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted/40 p-2 font-mono text-xs break-words whitespace-pre-wrap">{pretty(r.response)}</pre>
                            </details>
                          )}
                        </li>
                      );
                    })}
                  </ol>
                )}
              </>
            )}
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
