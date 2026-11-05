"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export const SENDING_POLL_MS = 3_000;
export const SENDING_WATCH_MS = 60_000;
/** A vendor that runs a send later can take as long as its queue: the settle limit, read less often. */
export const VENDOR_POLL_MS = 15_000;
export const VENDOR_WATCH_MS = 61 * 60_000;

/**
 * While its component is mounted, which is while a reply is sending, refreshes the server data every 3 s for up to a minute,
 * so the result shows without a reload. True while it watches. After the minute it stops and the panel asks for a reload
 * instead; a new send mounts a new watch. `awaitingVendor`: a vendor runs the send later, so it reads slower for much longer.
 */
export function useSendingWatch(awaitingVendor = false): boolean {
  const router = useRouter();
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    const started = Date.now();
    const limit = awaitingVendor ? VENDOR_WATCH_MS : SENDING_WATCH_MS;
    const timer = window.setInterval(() => {
      if (Date.now() - started >= limit) {
        window.clearInterval(timer);
        setTimedOut(true);
        return;
      }
      router.refresh();
    }, awaitingVendor ? VENDOR_POLL_MS : SENDING_POLL_MS);
    return () => window.clearInterval(timer);
  }, [router, awaitingVendor]);

  return !timedOut;
}
