"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode, type RefObject } from "react";

/*
 * The ticked rows of a list page (Leads, Contacts). The table writes it, and any client component rendered inside the
 * provider (a bulk action such as "Add to campaign") reads `selectedIds`. The page keys the provider by the filter only:
 * the selection survives sort, paging and page size, and resets when the filter changes.
 */

interface Selection {
  selectedIds: string[];
  isSelected: (id: string) => boolean;
  select: (ids: string[], checked: boolean) => void;
  clear: () => void;
}

const Context = createContext<Selection | null>(null);

export function SelectionProvider({ children }: { children: ReactNode }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const select = useCallback((ids: string[], checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);
  const clear = useCallback(() => setSelected(new Set()), []);
  const value = useMemo<Selection>(
    () => ({ selectedIds: [...selected], isSelected: (id) => selected.has(id), select, clear }),
    [selected, select, clear],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useSelection(): Selection {
  const value = useContext(Context);
  if (!value) throw new Error("useSelection needs a SelectionProvider");
  return value;
}

/**
 * While rows are ticked, the sticky bar covers the bottom of the viewport, and on a phone it wraps to two or three lines.
 * The page reserves the bar's height as scroll padding, so a row that takes focus scrolls clear of the bar (WCAG 2.4.11).
 * The document scrolls, so the padding goes on the root element, and it follows the bar as it wraps.
 */
export function useBarScrollPadding(bar: RefObject<HTMLDivElement | null>, active: boolean) {
  useEffect(() => {
    const element = bar.current;
    if (!active || !element) return;
    const root = document.documentElement;
    const sync = () => {
      root.style.scrollPaddingBottom = `${element.offsetHeight + 8}px`;
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    return () => {
      observer.disconnect();
      root.style.scrollPaddingBottom = "";
    };
  }, [bar, active]);
}
