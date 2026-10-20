import { useSyncExternalStore } from "react";

/** True when the viewport is at least `px` wide. Server render and first paint assume wide. */
export function useMinWidth(px: number): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(`(min-width: ${px}px)`);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.matchMedia(`(min-width: ${px}px)`).matches,
    () => true,
  );
}
