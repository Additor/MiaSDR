"use client";

import { useId } from "react";
import { Button } from "@/components/ui/button";
import type { CatalogEntry, ProviderView } from "../_lib/data/providers";
import { ProviderRow } from "./provider-manager";

/**
 * One line of the enrichment setup: a label, what the column will do in a sentence, and Change to open the fields
 * behind it. The fields open on their own when the sentence cannot be made, such as inputs that cover nothing.
 */
export function SetupRow({ label, noun, summary, detail, action = "Change", open, onToggle, children }: { label: string; noun: string; summary: React.ReactNode; detail?: React.ReactNode; action?: string; open: boolean; onToggle?: () => void; children?: React.ReactNode }) {
  const id = useId();
  return (
    <li className="grid gap-3 px-3 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className="basis-full text-sm text-muted-foreground sm:w-28 sm:shrink-0 sm:basis-auto">{label}</span>
        <div className="min-w-0 flex-1">
          <div className="text-sm">{summary}</div>
          {detail && <p className="text-xs text-muted-foreground tabular-nums">{detail}</p>}
        </div>
        {onToggle && (
          <Button type="button" variant="link" size="sm" className="h-auto p-0" aria-expanded={open} aria-controls={id} aria-label={`${open ? "Hide" : action} ${noun}`} onClick={onToggle}>
            {open ? "Hide" : action}
          </Button>
        )}
      </div>
      {open && (
        <div id={id} className="grid gap-3 sm:pl-31">
          {children}
        </div>
      )}
    </li>
  );
}

/** The column names a new enrichment adds, as plain chips: the main answer first. */
export function ColumnChips({ names }: { names: string[] }) {
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Columns this adds">
      {names.map((name, i) => (
        <li key={`${i}:${name}`} className="rounded-md border bg-muted/40 px-1.5 py-0.5 text-xs">
          {name}
        </li>
      ))}
    </ul>
  );
}

/**
 * The vendors that offer one outcome, each with Connect and its key, price and rate limit in place. The dialog shows it
 * instead of the form while no connected provider offers the outcome, so nothing below waits on a missing vendor.
 */
export function ConnectProviders({ entries, providers, onChanged, lead }: { entries: CatalogEntry[]; providers: ProviderView[]; onChanged: () => Promise<void>; lead: string }) {
  return (
    <section aria-label="Connect a provider" className="grid gap-2">
      <p className="text-sm">{lead}</p>
      <p className="text-xs text-muted-foreground">Each provider uses your own account and key. MiaSDR checks a key with the vendor before it saves it, and never shows it again.</p>
      <ul className="grid gap-2">
        {entries.map((entry) => (
          <li key={entry.key}>
            <ProviderRow entry={entry} provider={providers.find((p) => p.key === entry.key)} onChanged={onChanged} />
          </li>
        ))}
      </ul>
    </section>
  );
}
