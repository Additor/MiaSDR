"use client";

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/components/ui/utils";

export interface TabItem {
  id: string;
  label: string;
  /** Shown beside the label when above zero. */
  count?: number;
  content: ReactNode;
}

/**
 * Tabs with the keyboard model of the WAI-ARIA pattern: arrows move, Home and End jump. Every panel stays mounted so form and
 * scroll state survive a switch. An `alert` count is work that waits for a person, in the brand hue as plain text (PRODUCT.md); a `neutral`
 * count only says how many.
 */
export function Tabs({ tabs, label, countTone = "alert" }: { tabs: TabItem[]; label: string; countTone?: "alert" | "neutral" }) {
  const base = useId();
  const [active, setActive] = useState(tabs[0].id);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = tabs.length - 1;
    const next = event.key === "ArrowRight" ? (index === last ? 0 : index + 1) : event.key === "ArrowLeft" ? (index === 0 ? last : index - 1) : event.key === "Home" ? 0 : event.key === "End" ? last : null;
    if (next === null) return;
    event.preventDefault();
    setActive(tabs[next].id);
    buttons.current[next]?.focus();
  }

  return (
    <div className="stack-group">
      <div role="tablist" aria-label={label} className="flex gap-1 border-b">
        {tabs.map((tab, index) => {
          const selected = tab.id === active;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                buttons.current[index] = el;
              }}
              id={`${base}-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`${base}-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(tab.id)}
              onKeyDown={(e) => onKeyDown(e, index)}
              className={cn(
                "-mb-px flex min-h-11 items-center gap-2 border-b-2 px-3 text-sm focus-ring md:min-h-9",
                selected ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.label}
              {tab.count ? (
                <span className={cn("text-xs tabular-nums", countTone === "alert" ? "font-semibold text-sidebar-count" : "text-muted-foreground")}>{tab.count}</span>
              ) : null}
            </button>
          );
        })}
      </div>
      {tabs.map((tab) => (
        <div key={tab.id} id={`${base}-panel-${tab.id}`} role="tabpanel" aria-labelledby={`${base}-tab-${tab.id}`} hidden={tab.id !== active} className="stack-group">
          {tab.content}
        </div>
      ))}
    </div>
  );
}
