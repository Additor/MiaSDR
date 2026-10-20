import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { listInbox } from "@/contexts/conversations/application/inbox";
import { inboxHref, type InboxParams } from "@/contexts/conversations/domain/inbox-filter";
import { inboxDeps } from "@/contexts/conversations/infrastructure/composition";
import type { Actor } from "@/shared/errors";
import { pickNextUnread } from "./next-unread";

/**
 * "Next unread" for the thread header. It reads the list the person came from (same view, search and filters, same
 * page) and takes the first unread conversation after this one. When that page holds none, it looks at the first page of
 * the Unread view with the same filters. The link keeps the list context, so the next thread offers the same step.
 */
export async function NextUnreadLink({ currentId, params, actor }: { currentId: string; params: InboxParams; actor: Actor }) {
  const deps = inboxDeps();
  // The scheduled view lists queued steps, not conversations.
  const here = { ...params, view: params.view === "scheduled" ? ("all" as const) : params.view };
  let nextId = pickNextUnread((await listInbox(deps, actor, here)).rows, currentId);
  if (!nextId && here.view !== "unread") nextId = pickNextUnread((await listInbox(deps, actor, { ...here, view: "unread", page: 1 })).rows, currentId);
  if (!nextId) return <span className="text-sm whitespace-nowrap text-muted-foreground">No other unread</span>;
  const query = inboxHref(here).split("?")[1];
  return (
    <Link href={`/inbox/${nextId}${query ? `?${query}` : ""}`} className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
      Next unread
    </Link>
  );
}
