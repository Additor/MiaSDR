"use client";

import { useEffect, useState } from "react";
import { Time } from "@/components/shell/time";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { gridRequest, gridUrl } from "../_lib/data/client";
import { displayValue, editorText, typeLabel } from "../_lib/view/format";
import type { GridColumn, GridRow } from "../_lib/data/types";

interface Props {
  tableId: string;
  row: GridRow;
  column: GridColumn;
  rowNumber: number;
  onClose: () => void;
}

interface Run {
  id: string;
  provider: string | null;
  outcome: string;
  costCents: number;
  credits: number | null;
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

/** Everything known about one cell: its value, the state of its last run and the history of attempts. */
export function CellDrawer({ tableId, row, column, rowNumber, onClose }: Props) {
  const [details, setDetails] = useState<Details | null>(null);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [state, setState] = useState<"loading" | "none" | "ready">("loading");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const params = new URLSearchParams({ rowId: row.id, columnKey: column.key });
      const d = await gridRequest<Details>(`${gridUrl.sub(tableId, "cell-details")}?${params}`, "GET");
      if (cancelled) return;
      if (!d.ok || !d.data) return setState("none");
      setDetails(d.data);
      const h = await gridRequest<{ runs: Run[] }>(`${gridUrl.sub(tableId, "cell-runs")}?${params}`, "GET");
      if (cancelled) return;
      setRuns(h.ok && h.data ? h.data.runs : []);
      setState("ready");
    })();
    return () => {
      cancelled = true;
    };
  }, [tableId, row.id, column.key]);

  const value = row.cells[column.key];
  const meta = row.cellMeta[column.key];

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{column.name}</SheetTitle>
          <SheetDescription>
            Row {rowNumber} · {typeLabel(column.type)} · version {row.version}
          </SheetDescription>
        </SheetHeader>
        <div className="grid gap-5 px-4 pb-6 text-sm">
          <section aria-labelledby="cd-value">
            <h3 id="cd-value" className="mb-1 text-xs font-medium text-muted-foreground">
              Value
            </h3>
            <pre className="max-h-64 overflow-auto rounded-lg border bg-muted/40 p-2.5 text-xs break-words whitespace-pre-wrap">{editorText(value) || displayValue(value, column) || "(empty)"}</pre>
          </section>

          {meta && (
            <section aria-labelledby="cd-state">
              <h3 id="cd-state" className="mb-1 text-xs font-medium text-muted-foreground">
                State
              </h3>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                {meta.status && (
                  <>
                    <dt className="text-muted-foreground">Status</dt>
                    <dd>{meta.status}</dd>
                  </>
                )}
                {meta.outcome && (
                  <>
                    <dt className="text-muted-foreground">Outcome</dt>
                    <dd>{meta.outcome}</dd>
                  </>
                )}
                {meta.provider && (
                  <>
                    <dt className="text-muted-foreground">Provider</dt>
                    <dd>{meta.provider}</dd>
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
                {meta.error && (
                  <>
                    <dt className="text-muted-foreground">Error</dt>
                    <dd className="text-destructive">{meta.error}</dd>
                  </>
                )}
              </dl>
            </section>
          )}

          <section aria-labelledby="cd-runs">
            <h3 id="cd-runs" className="mb-1 text-xs font-medium text-muted-foreground">
              Run history
            </h3>
            {state === "loading" && <p className="text-muted-foreground">Loading...</p>}
            {state === "none" && <p className="text-muted-foreground">This cell was typed or imported, so it has no runs.</p>}
            {state === "ready" && details && (
              <>
                <p className="mb-2 text-muted-foreground">
                  Produced by {details.sourceColumnName} ({typeLabel(details.sourceColumnType)}).
                </p>
                {runs && runs.length === 0 && <p className="text-muted-foreground">No recorded runs yet.</p>}
                <ol className="grid gap-2">
                  {runs?.map((r) => (
                    <li key={r.id} className="rounded-lg border p-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={OUTCOME_VARIANT[r.outcome] ?? "outline"}>{r.outcome}</Badge>
                        {r.provider && <span>{r.provider}</span>}
                        <Time value={r.createdAt} className="text-xs text-muted-foreground" />
                        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                          {r.costCents > 0 ? `${r.costCents}c` : "free"}
                          {r.credits !== null ? ` · ${r.credits} ${r.credits === 1 ? "credit" : "credits"}` : ""}
                          {r.latencyMs !== null ? ` · ${r.latencyMs} ms` : ""}
                        </span>
                      </div>
                      {r.response !== null && r.response !== undefined && (
                        <details className="mt-2">
                          <summary className="cursor-pointer text-xs text-muted-foreground">Response</summary>
                          <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted/40 p-2 text-xs break-words whitespace-pre-wrap">{pretty(r.response)}</pre>
                        </details>
                      )}
                    </li>
                  ))}
                </ol>
              </>
            )}
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
