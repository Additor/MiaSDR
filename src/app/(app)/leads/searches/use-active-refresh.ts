"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Pages of a search arrive in the background, so a list that shows working searches refreshes itself this often. */
export const ACTIVE_REFRESH_MS = 8000;

/**
 * Re-reads the server data every `ACTIVE_REFRESH_MS` while `active` is true. The timer stops when nothing is active,
 * skips ticks while the tab is hidden, and refreshes at once when the tab becomes visible again.
 */
export function useActiveRefresh(active: boolean) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const timer = setInterval(refreshIfVisible, ACTIVE_REFRESH_MS);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [active, router]);
}
