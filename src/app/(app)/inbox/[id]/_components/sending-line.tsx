"use client";

import { Spinner } from "@/components/shell/spinner";
import { useSendingWatch } from "./use-sending-watch";

/** Shown while a reply sends. The page refreshes on its own for up to a minute (use-sending-watch.ts), then `stopped` asks for a reload. */
export function SendingLine({ stopped }: { stopped: string }) {
  const watching = useSendingWatch(true);
  if (!watching) return <p>{stopped}</p>;
  return (
    <p className="flex items-center gap-2">
      <Spinner />
      Sending…
    </p>
  );
}
