"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { DRAFT_POLL_INTERVAL_MS, initialWatch, isWatching, observe, type WatchSnapshot } from "../_lib/draft-watch";

/**
 * Shows "Drafting a reply..." and refreshes the server data every 3 s (up to 45 s) after a reclassification,
 * so the new draft appears without a reload. The reply panel refreshes the page once after a change; a version
 * bump in the fresh props starts the watch.
 */
export function DraftWatch(snapshot: WatchSnapshot) {
  const router = useRouter();
  const { contextVersion, draftStatus, workflowState } = snapshot;
  const [state, setState] = useState(() => initialWatch(snapshot, Date.now()));
  const [now, setNow] = useState(() => Date.now());

  // Fresh server data arrived (the reply panel refreshed the page). Read the clock in a callback, not in render.
  useEffect(() => {
    const timer = setTimeout(() => {
      const at = Date.now();
      setNow(at);
      setState((prev) => observe(prev, { contextVersion, draftStatus, workflowState }, at));
    }, 0);
    return () => clearTimeout(timer);
  }, [contextVersion, draftStatus, workflowState]);

  const watching = isWatching(state, { contextVersion, draftStatus, workflowState }, now);

  useEffect(() => {
    if (!watching) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      router.refresh();
    }, DRAFT_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [watching, router]);

  if (!watching) return null;
  return (
    <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground" data-slot="draft-watch">
      <span aria-hidden className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
      Drafting a reply...
    </p>
  );
}
