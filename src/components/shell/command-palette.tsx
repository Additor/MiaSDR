"use client";

import { SearchIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export interface PaletteDestination {
  href: string;
  label: string;
  /** Section the page belongs to, such as "CRM" or "Settings". Searched along with the label. */
  group: string;
}

const RECENT_KEY = "miasdr.palette.recent";

function readRecent(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string").slice(0, 3) : [];
  } catch {
    return [];
  }
}

function writeRecent(href: string) {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify([href, ...readRecent().filter((h) => h !== href)].slice(0, 3)));
  } catch {
    // Private windows can refuse storage; the palette works without recents.
  }
}

/**
 * Jump to any page by typing its name. Opens with Cmd+K or Ctrl+K from anywhere, or from the button that
 * `CommandPaletteTrigger` renders. Arrow keys move, Enter goes, Escape closes.
 */
export function CommandPalette({ destinations, open, onOpenChange }: { destinations: PaletteDestination[]; open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const listId = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  // Re-read on open: the palette is mounted for the whole session, so what it remembers changes while it is closed.
  const recent = useMemo(() => (open ? readRecent() : []), [open]);

  const matches = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      // Nothing typed: the pages you picked last come first and say so.
      const seen = recent.map((href) => destinations.find((d) => d.href === href)).filter((d): d is PaletteDestination => d !== undefined);
      return [...seen.map((d) => ({ ...d, group: "Recent" })), ...destinations.filter((d) => !seen.includes(d))];
    }
    return destinations.filter((d) => words.every((w) => `${d.group} ${d.label}`.toLowerCase().includes(w)));
  }, [destinations, query, recent]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // A rich-text editor keeps Cmd+K for its own links.
      const inEditor = event.target instanceof HTMLElement && event.target.isContentEditable;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && !inEditor) {
        event.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  function go(destination: PaletteDestination | undefined) {
    if (!destination) return;
    writeRecent(destination.href);
    onOpenChange(false);
    router.push(destination.href);
  }

  const current = matches[Math.min(active, matches.length - 1)];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          setQuery("");
          setActive(0);
        }
      }}
    >
      <DialogContent showCloseButton={false} className="top-[20%] translate-y-0 gap-0 p-0 sm:max-w-md">
        <DialogTitle className="sr-only">Go to a page</DialogTitle>
        <DialogDescription className="sr-only">Type a page name, use the arrow keys to choose, and press Enter.</DialogDescription>
        <div className="flex items-center gap-2 border-b px-3">
          <SearchIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            role="combobox"
            aria-expanded={matches.length > 0}
            aria-autocomplete="list"
            aria-controls={listId}
            aria-activedescendant={current ? `${listId}-${destinations.indexOf(current)}` : undefined}
            aria-label="Go to a page"
            placeholder="Go to a page"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((i) => Math.min(i + 1, matches.length - 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((i) => Math.max(i - 1, 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                go(current);
              }
            }}
            className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <ul id={listId} role="listbox" aria-label="Pages" className="max-h-72 overflow-y-auto p-1">
          {matches.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted-foreground">No page matches &ldquo;{query}&rdquo;.</li>}
          {matches.map((d, index) => (
            <li
              key={d.href}
              id={`${listId}-${destinations.indexOf(d)}`}
              role="option"
              aria-selected={d === current}
              onMouseMove={(event) => (event.movementX !== 0 || event.movementY !== 0) && setActive(index)}
              onClick={() => go(d)}
              className={cn("flex min-h-9 cursor-pointer items-center justify-between gap-3 rounded-md px-3 text-sm", d === current && "bg-muted")}
            >
              <span className="truncate">{d.label}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{d.group}</span>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
