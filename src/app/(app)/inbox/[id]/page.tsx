import { TriangleAlertIcon } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { SummaryLine } from "@/components/shell/summary-line";
import { Time } from "@/components/shell/time";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getThread } from "@/contexts/conversations/application/inbox";
import type { ThreadDetail } from "@/contexts/conversations/application/ports";
import { inboxHref, parseInboxParams } from "@/contexts/conversations/domain/inbox-filter";
import { inboxDeps } from "@/contexts/conversations/infrastructure/composition";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { toActor } from "@/shared/api";
import { NotFoundError } from "@/shared/errors";
import { channelLabel } from "@/contexts/outreach/domain/campaign-view";
import { actionsHref, actionsViewFrom } from "../../actions/actions-query";
import { waitingOn, workflowLabel } from "../labels";
import { DraftWatch } from "./draft-watch-client";
import { ImportantStar } from "./important-star";
import { MarkRead } from "./mark-read";
import { NextQueueLink } from "./next-queue-link";
import { NextUnreadLink } from "./next-unread-link";
import { LinkedInReplyPanel } from "./linkedin-reply-panel";
import { ReplyPanel } from "./reply-panel";
import { ThreadSide, ThreadSideSkeleton } from "./_components/thread-side";
import { RecordBody } from "@/app/(app)/crm/_components/record/record-header";

export const metadata: Metadata = { title: "Conversation" };

export default function ConversationPage({ params, searchParams }: PageProps<"/inbox/[id]">) {
  return (
    <Suspense
      fallback={
        <div className="page">
          <Skeleton className="h-96 w-full" />
        </div>
      }
    >
      <Conversation params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function Conversation({ params, searchParams }: { params: PageProps<"/inbox/[id]">["params"]; searchParams: PageProps<"/inbox/[id]">["searchParams"] }) {
  await connection();
  const { id } = await params;
  // A path that is not a UUID cannot match a row, and Postgres would reject it as a server error.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) notFound();
  const actor = toActor(await requireOrgContext());
  let thread;
  try {
    thread = await getThread(inboxDeps(), actor, id);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  // The list passes its view and filters along, so Back and Next unread stay inside the list the person came from. A row on
  // Actions passes `from=actions` and its own view instead: Back and Next in queue then stay inside that queue.
  const query = await searchParams;
  const listParams = parseInboxParams(query);
  const fromActions = query.from === "actions";
  const actionsView = actionsViewFrom(query);
  const { person } = thread;
  const subject = [...thread.messages].reverse().find((m) => m.subject)?.subject ?? (thread.channel === "linkedin" ? "LinkedIn conversation" : "(no subject)");

  const latest = thread.messages.at(-1);
  const earlier = thread.messages.slice(0, -1).reverse();

  return (
    <>
      <PageHeader
        title={subject}
        back={fromActions ? { href: actionsHref(actionsView), label: "Actions" } : { href: inboxHref(listParams.view === "scheduled" ? { ...listParams, view: "all" } : listParams), label: "Inbox" }}
        actions={
          <>
            <Suspense fallback={null}>
              {fromActions ? <NextQueueLink recordId={thread.recordId} view={actionsView} actor={actor} /> : <NextUnreadLink currentId={thread.conversationId} params={listParams} actor={actor} />}
            </Suspense>
            <MarkRead id={thread.conversationId} unread={thread.unreadCount} />
          </>
        }
      />
      {/* The record frame's body: the work column, then one bordered side panel. On a phone the panel follows the reply, so
          the person, reply handling and tasks never sit between the person and the approval. */}
      <div className="page">
        <RecordBody
          asideLabel="Person and reply handling"
          main={
            <div className="stack-section min-w-0">
              <SummaryLine
                items={[
                  { label: "From", value: person.name ?? person.email ?? "Unknown sender" },
                  { label: "Channel", value: channelLabel(thread.channel) },
                  { label: "Received at", value: thread.accountLabel },
                  { label: "State", value: workflowLabel(thread.workflowState) },
                  { label: "Waiting on", value: waitingOn(thread.workflowState), hint: "Who has to act next on this conversation" },
                ]}
              />
              <DraftWatch contextVersion={thread.contextVersion} draftStatus={thread.latestDraftStatus} workflowState={thread.workflowState} />

              {latest && <MessageCard message={latest} channel={thread.channel} />}

              <div data-slot="reply-draft">
                <Suspense fallback={<Skeleton className="h-48 w-full" />}>
                  {thread.channel === "linkedin" ? (
                    <LinkedInReplyPanel conversationId={thread.conversationId} actor={actor} />
                  ) : (
                    <ReplyPanel conversationId={thread.conversationId} actor={actor} queue={fromActions ? { recordId: thread.recordId, view: actionsView } : undefined} />
                  )}
                </Suspense>
              </div>

              {earlier.length > 0 && (
                <section aria-labelledby="earlier-messages" className="stack-group">
                  <h2 id="earlier-messages" className="text-sm font-semibold">
                    Earlier messages ({earlier.length}), newest first
                  </h2>
                  {earlier.map((m) => (
                    <MessageCard key={`${m.source}-${m.id}`} message={m} channel={thread.channel} />
                  ))}
                </section>
              )}
            </div>
          }
          aside={
            <Suspense fallback={<ThreadSideSkeleton />}>
              <ThreadSide actor={actor} conversationId={thread.conversationId} recordId={thread.recordId} personId={person.id} />
            </Suspense>
          }
        />
      </div>
    </>
  );
}

function MessageCard({ message: m, channel }: { message: ThreadDetail["messages"][number]; channel: string }) {
  return (
    <Card className={m.direction === "outbound" ? "bg-muted/40" : undefined}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          <span>{m.direction === "outbound" ? "You" : (m.from ?? "Sender")}</span>
          {m.source === "sequence" && <Badge variant="outline">{channel === "linkedin" ? "Sequence message" : "Sequence email"}</Badge>}
          {m.possibleBounce ? (
            <span className="inline-flex items-center gap-1 text-xs font-normal">
              <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0 text-warning" />
              Bounce notice, not verified
            </span>
          ) : (
            m.autoReply && <Badge variant="outline">Auto-reply</Badge>
          )}
          {m.unread && <Badge variant="secondary">Unread</Badge>}
          {m.source === "message" && <ImportantStar messageId={m.id} important={m.important} />}
        </CardTitle>
        <CardDescription>
          <Time value={m.at} />
          {m.to ? `, to ${m.to}` : ""}
          {m.cc?.length ? `, cc ${m.cc.join(", ")}` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm whitespace-pre-wrap">{m.bodyText}</p>
      </CardContent>
    </Card>
  );
}
