"use client";

import { Fragment } from "react";
import { OUTCOMES } from "../_lib/data/outcomes";

const LINK = "rounded-sm text-foreground underline decoration-muted-foreground/50 underline-offset-4 hover:decoration-foreground focus-ring";

/**
 * The first move on a table that has rows and no column that runs yet: one line under the toolbar that names what the
 * Enrich menu can fill, as links into the same choices. It carries no box or buttons of its own, so the toolbar keeps the
 * one filled button; the line goes once a column runs.
 */
export function EnrichStart({ onOutcome, onAi }: { onOutcome: (actionKey: string) => void; onAi: () => void }) {
  return (
    <section aria-label="Enrich these rows" className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b pb-2 text-xs text-muted-foreground">
      <p>
        Enrich these rows:{" "}
        {OUTCOMES.map((o, i) => (
          <Fragment key={o.actionKey}>
            {i > 0 && " · "}
            <button type="button" className={LINK} onClick={() => onOutcome(o.actionKey)}>
              {o.label}
            </button>
          </Fragment>
        ))}
        {" · "}
        <button type="button" className={LINK} onClick={onAi}>
          Ask AI about each row
        </button>
      </p>
      <p className="sm:ml-auto">Nothing runs or spends until you press Run.</p>
    </section>
  );
}
