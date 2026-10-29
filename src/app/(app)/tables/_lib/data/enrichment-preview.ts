"use client";

import { useEffect, useState } from "react";
import { useCellRequest } from "./cell-request";
import { gridUrl } from "./client";
import { credits, dollars } from "./run-request";
import { formatCount } from "@/shared/format-number";

/** What a new enrichment column would match and cost, as `POST /enrichments/preview` returns it. */
export interface EnrichmentPreview {
  rows: number;
  ready: number;
  /** The table has rows past the ones the preview read. */
  more: boolean;
  /** The first value of each column, by column key. */
  samples: Record<string, string>;
  perCell: { cents: number; credits: number };
}


/** "1,842 of 2,000 rows have these inputs", or why none do. */
export function coverageText(p: EnrichmentPreview): string {
  if (p.rows === 0) return "The table has no rows yet.";
  const of = `${formatCount(p.rows)}${p.more ? "+" : ""}`;
  if (p.ready === 0) return `None of the ${of} rows has these inputs yet.`;
  return `${formatCount(p.ready)} of ${of} ${p.rows === 1 ? "row has" : "rows have"} these inputs`;
}

/** "A full run uses up to 1,842 credits and $18.42", from one cell's worst case times the ready rows. Null with nothing to run. */
export function fullRunText(p: EnrichmentPreview): string | null {
  if (p.ready === 0) return null;
  // An upper bound rounds up, so a fraction of a cent never reads as less than it can cost.
  const spend = [p.perCell.credits > 0 ? credits(p.perCell.credits * p.ready) : null, p.perCell.cents > 0 ? dollars(Math.ceil(p.perCell.cents * p.ready)) : null].filter(Boolean).join(" and ");
  return spend ? `A full run uses up to ${spend}.` : "These providers have no price set.";
}

/**
 * The preview of the column as the form stands, asked again 250 ms after the last change. An answer for an older form
 * never shows, and a failed preview shows nothing: the dialog still works without it.
 */
export function useEnrichmentPreview(tableId: string, steps: Array<{ providerKey: string; actionKey: string }>, inputs: Record<string, string>): EnrichmentPreview | null {
  // Without a provider the dialog shows the connect step, which has no use for a preview, so nothing scans the table.
  const draft = steps.length === 0 ? null : JSON.stringify({ steps, inputs: Object.fromEntries(Object.entries(inputs).filter(([, v]) => v)) });
  const [answer, setAnswer] = useState<{ draft: string; preview: EnrichmentPreview } | null>(null);
  const cellRequest = useCellRequest();
  useEffect(() => {
    if (draft === null) return;
    let live = true;
    const timer = setTimeout(() => {
      void cellRequest<EnrichmentPreview>(gridUrl.sub(tableId, "enrichments/preview"), "POST", JSON.parse(draft)).then((res) => {
        if (live && res.ok && res.data) setAnswer({ draft, preview: res.data });
      });
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [draft, tableId, cellRequest]);
  return answer && answer.draft === draft ? answer.preview : null;
}
