"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export const SENDING_POLL_MS = 3_000;
export const SENDING_WATCH_MS = 60_000;

/**
 * While its component is mounted, which is while a reply is sending, refreshes the server data every 3 s for up to a minute,
 * so the result shows without a reload. True while it watches. After the minute it stops and the panel asks for a reload
 * instead; a new send mounts a new watch.
 */
export function useSendingWatch(): boolean {
  const router = useRouter();
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (Date.now() - started >= SENDING_WATCH_MS) {
        window.clearInterval(timer);
        setTimedOut(true);
        return;
      }
      router.refresh();
    }, SENDING_POLL_MS);
    return () => window.clearInterval(timer);
  }, [router]);

  return !timedOut;
}
