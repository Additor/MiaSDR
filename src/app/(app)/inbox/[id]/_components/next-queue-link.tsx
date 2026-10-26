import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/components/ui/utils";
import type { Actor } from "@/shared/errors";
import { loadNextInQueue } from "../_lib/next-queue";
import { QueueKeys } from "./queue-keys";

/**
 * "Next in queue" for a thread opened from Actions: the first item below this record in the view the row came from, or the
 * first one left when this record has already left the queue because it was just handled. The link keeps the view, so the next
 * thread offers the same step. Nothing opens by itself. A view that does not parse leaves the link out.
 */
export async function NextQueueLink({ recordId, view, actor }: { recordId: string; view: Record<string, string>; actor: Actor }) {
  const next = await loadNextInQueue(actor, recordId, view);
  if (next === undefined) return null;
  if (!next) return <span className="text-sm whitespace-nowrap text-muted-foreground">No other items in this queue</span>;
  return (
    <>
      <QueueKeys href={next.href} />
      <Link href={next.href} className={cn(buttonVariants({ variant: "outline", size: "sm" }))} data-testid="next-in-queue" aria-keyshortcuts="]" title="Next in queue (])">
        Next in queue
        <kbd aria-hidden className="ml-1 hidden rounded border px-1 font-sans text-xs leading-4 text-muted-foreground sm:inline">]</kbd>
      </Link>
    </>
  );
}
