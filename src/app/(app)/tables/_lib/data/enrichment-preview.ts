"use client";

import { useEffect, useState } from "react";
import { gridRequest, gridUrl } from "./client";
import { dollars } from "./run-request";

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

const count = (n: number) => n.toLocaleString("en-US");
const creditText = (n: number) => `${Number(n.toFixed(2)).toLocaleString("en-US")} ${n === 1 ? "credit" : "credits"}`;

/** "1,842 of 2,000 rows have these inputs", or why none do. */
export function coverageText(p: EnrichmentPreview): string {
  if (p.rows === 0) return "The table has no rows yet.";
  const of = `${count(p.rows)}${p.more ? "+" : ""}`;
  if (p.ready === 0) return `None of the ${of} rows has these inputs yet.`;
  return `${count(p.ready)} of ${of} ${p.rows === 1 ? "row has" : "rows have"} these inputs`;
}

/** "A full run uses up to 1,842 credits and $18.42", from one cell's worst case times the ready rows. Null with nothing to run. */
export function fullRunText(p: EnrichmentPreview): string | null {
  if (p.ready === 0) return null;
  const spend = [p.perCell.credits > 0 ? creditText(p.perCell.credits * p.ready) : null, p.perCell.cents > 0 ? dollars(p.perCell.cents * p.ready) : null].filter(Boolean).join(" and ");
  return spend ? `A full run uses up to ${spend}.` : "These providers have no price set.";
}

/**
 * The preview of the column as the form stands, asked again 250 ms after the last change. An answer for an older form
 * never shows, and a failed preview shows nothing: the dialog still works without it.
 */
export function useEnrichmentPreview(tableId: string, steps: Array<{ providerKey: string; actionKey: string }>, inputs: Record<string, string>): EnrichmentPreview | null {
  const draft = JSON.stringify({ steps, inputs: Object.fromEntries(Object.entries(inputs).filter(([, v]) => v)) });
  const [answer, setAnswer] = useState<{ draft: string; preview: EnrichmentPreview } | null>(null);
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      void gridRequest<EnrichmentPreview>(gridUrl.sub(tableId, "enrichments/preview"), "POST", JSON.parse(draft)).then((res) => {
        if (live && res.ok && res.data) setAnswer({ draft, preview: res.data });
      });
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [draft, tableId]);
  return answer && answer.draft === draft ? answer.preview : null;
}
