import { StarIcon, TriangleAlertIcon } from "lucide-react";
import { LIST_ROW_FRAME } from "@/components/shell/list-row";
import { RowLink, rowLinkClasses } from "@/components/shell/row-link";
import { Badge } from "@/components/ui/badge";
import type { InboxRow } from "@/contexts/conversations/application/ports";
import { groupLabel } from "@/contexts/conversations/domain/reply-handling";
import { channelLabel } from "@/contexts/outreach/domain/campaign-view";
import { cn } from "@/components/ui/utils";

/** What a row says about the conversation itself: one state. What waits on a person is in Actions, not here. */
function RowState({ row }: { row: InboxRow }) {
  // A bounce notice nobody verified is an uncertain state: the amber icon and the plain sentence, not a badge (DESIGN.md).
  if (row.possibleBounce) {
    return (
      <span className="inline-flex items-center gap-1 text-xs">
        <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0 text-warning" />
        Bounce notice, not verified
      </span>
    );
  }
  const label = row.autoReply ? "Auto-reply" : row.groupKey ? (row.replyTypeName ?? groupLabel(row.groupKey)) : null;
  return label ? <Badge variant="outline">{label}</Badge> : null;
}

/**
 * One conversation in the list: the same anatomy as a row of Actions (a name that is the link over the whole row, a time at the
 * right, a line of text under it), so a person who learned one list can read the other. The unread dot has its own gutter, so
 * names line up whether or not a row has one. The channel is said only when it is not email, which most rows are.
 */
export function ConversationRow({ row, href, time }: { row: InboxRow; href: string; time: string }) {
  const unread = row.unreadCount > 0;
  const subject = row.subject ?? (row.channel === "linkedin" ? "LinkedIn" : "(no subject)");
  const state = <RowState row={row} />;
  const showsChannel = row.channel !== "email";
  return (
    <li data-list-row={row.conversationId} data-href={href} className={cn(rowLinkClasses, LIST_ROW_FRAME)}>
      <div className="flex items-baseline gap-2">
        <span className="flex w-3 shrink-0 justify-center">
          {unread && <span role="img" aria-label={`${row.unreadCount} unread`} className="size-2 rounded-full bg-sidebar-primary" />}
        </span>
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <RowLink href={href} className={cn("truncate", unread && "font-semibold")}>
            {row.personName ?? row.personEmail ?? "Unknown sender"}
            <span className="sr-only">
              , {subject}, {time}
            </span>
          </RowLink>
          {row.hasImportant && <StarIcon role="img" aria-label="Important" className="size-3.5 shrink-0 self-center text-foreground" />}
          {row.personName && row.personEmail && <span className="hidden truncate text-xs text-muted-foreground sm:inline">{row.personEmail}</span>}
        </div>
        <time dateTime={row.lastMessageAt.toISOString()} className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {time}
        </time>
      </div>
      <p className="truncate pl-5">
        <span className={unread ? "font-semibold" : undefined}>{subject}</span>
        <span className="text-muted-foreground">{` ${row.lastDirection === "outbound" ? "You: " : ""}${row.snippet}`}</span>
      </p>
      {(showsChannel || state) && (
        <div className="flex flex-wrap items-center gap-2 pl-5 text-xs text-muted-foreground">
          {showsChannel && <span>{channelLabel(row.channel)}</span>}
          {state}
        </div>
      )}
    </li>
  );
}
