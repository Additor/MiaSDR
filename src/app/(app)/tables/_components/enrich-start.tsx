"use client";

import { BotIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { OUTCOMES } from "../_lib/data/outcomes";

/**
 * The first move on a table that has rows and no column that runs yet: one quiet strip under the toolbar that names what
 * enrichment can fill. Each choice opens the enrichment dialog on that outcome; the strip goes once a column runs.
 */
export function EnrichStart({ onOutcome, onAi }: { onOutcome: (actionKey: string) => void; onAi: () => void }) {
  return (
    <section aria-labelledby="enrich-start-title" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3 py-2">
      <h2 id="enrich-start-title" className="text-sm font-medium">
        Enrich these rows
      </h2>
      <div className="flex flex-wrap gap-1.5">
        {OUTCOMES.map((o) => (
          <Button key={o.actionKey} type="button" variant="outline" size="xs" title={o.fills} onClick={() => onOutcome(o.actionKey)}>
            {o.label}
          </Button>
        ))}
        <Button type="button" variant="ghost" size="xs" onClick={onAi}>
          <BotIcon /> Ask AI about each row
        </Button>
      </div>
      <p className="text-xs text-muted-foreground sm:ml-auto">Nothing runs or spends until you press Run.</p>
    </section>
  );
}
