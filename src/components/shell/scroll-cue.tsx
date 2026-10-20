"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A horizontal scroller that shows where more content waits: a fade on each edge that can still scroll,
 * and a one-line hint while the right edge is out of sight.
 */
export function ScrollCue({ children, hint, className, ...rest }: { children: ReactNode; hint: string; className?: string } & Record<`data-${string}`, string>) {
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
    return () => observer.disconnect();
  }, [measure]);

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1">
      <p className={cn("text-xs text-muted-foreground", edges.right ? "" : "invisible")} aria-hidden={!edges.right}>
        {hint}
      </p>
      <div className="relative min-w-0">
        <div ref={ref} onScroll={measure} className={cn("flex overflow-x-auto", className)} {...rest}>
          {children}
        </div>
        <div aria-hidden className={cn("pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-background to-transparent transition-opacity", edges.left ? "opacity-100" : "opacity-0")} />
        <div aria-hidden className={cn("pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-background to-transparent transition-opacity", edges.right ? "opacity-100" : "opacity-0")} />
      </div>
    </div>
  );
}
