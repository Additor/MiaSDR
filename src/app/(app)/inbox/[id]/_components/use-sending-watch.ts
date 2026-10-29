"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export const SENDING_POLL_MS = 3_000;
export const SENDING_WATCH_MS = 60_000;

/**
 * While a reply is sending, refreshes the server data every 3 s for up to a minute, so the result shows without a reload.
 * True while it watches. After the minute it stops and the panel asks for a reload instead; a new send starts a new watch.
 */
export function useSendingWatch(sending: boolean): boolean {
  const router = useRouter();
  const [timedOut, setTimedOut] = useState(false);
  const [seen, setSeen] = useState(sending);
  if (seen !== sending) {
    setSeen(sending);
    setTimedOut(false);
  }

  useEffect(() => {
    if (!sending) return;
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
  }, [sending, router]);

  return sending && !timedOut;
}
