"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { DRAFT_POLL_INTERVAL_MS, initialWatch, isWatching, observe, type WatchSnapshot } from "../_lib/draft-watch";

/**
 * Refreshes the server data every 3 s (up to 45 s) while a draft job waits or runs, so the new draft appears without a
 * reload. The reply card shows "Drafting…"; this announces it once, in a live region that is always in the page.
 */
export function DraftWatch(snapshot: WatchSnapshot) {
  const router = useRouter();
  const { contextVersion, draftStatus, workflowState, drafting } = snapshot;
  const [state, setState] = useState(() => initialWatch(snapshot, Date.now()));
  const [now, setNow] = useState(() => Date.now());

  // Fresh server data arrived (the reply panel refreshed the page). Read the clock in a callback, not in render.
  useEffect(() => {
    const timer = setTimeout(() => {
      const at = Date.now();
      setNow(at);
      setState((prev) => observe(prev, { contextVersion, draftStatus, workflowState, drafting }, at));
    }, 0);
    return () => clearTimeout(timer);
  }, [contextVersion, draftStatus, workflowState, drafting]);

  const watching = isWatching(state, { contextVersion, draftStatus, workflowState, drafting }, now);

  useEffect(() => {
    if (!watching) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      router.refresh();
    }, DRAFT_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [watching, router]);

  return (
    <p role="status" className="sr-only" data-slot="draft-watch">
      {watching ? "Drafting a reply…" : ""}
    </p>
  );
}
