"use client";

import { useCallback, useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "@/components/ui/utils";

/**
 * A horizontal scroller that shows where more content waits: a fade on each edge that can still scroll,
 * and a one-line hint while the right edge is out of sight. A strip with no room for the hint line, such as a row of
 * tabs, leaves `hint` out and keeps the fades alone.
 */
export function ScrollCue({ children, hint, className, after, ...rest }: { children: ReactNode; hint?: string; className?: string; /** Sits after the scroller, outside it, such as a strip's add button. */ after?: ReactNode } & Record<`data-${string}`, string> & Pick<HTMLAttributes<HTMLDivElement>, "role" | "aria-label">) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const left = el.scrollLeft > 4;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
    setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);

  useEffect(() => {
    measure();
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    // Content can grow without the scroller changing size, such as a tab added or renamed in a row of tabs.
    const changes = new MutationObserver(measure);
    changes.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      changes.disconnect();
    };
  }, [measure]);

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1">
      {hint && (
        <p className={cn("text-xs text-muted-foreground", edges.right ? "" : "invisible")} aria-hidden={!edges.right}>
          {hint}
        </p>
      )}
      <div className="relative flex min-w-0 items-end">
        <div className={cn("relative min-w-0", !after && "flex-1")}>
          <div ref={ref} onScroll={measure} className={cn("flex overflow-x-auto", className)} {...rest}>
            {children}
          </div>
          <div aria-hidden className={cn("pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-background to-transparent transition-opacity", edges.left ? "opacity-100" : "opacity-0")} />
          <div aria-hidden className={cn("pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-background to-transparent transition-opacity", edges.right ? "opacity-100" : "opacity-0")} />
        </div>
        {after}
      </div>
    </div>
  );
}
