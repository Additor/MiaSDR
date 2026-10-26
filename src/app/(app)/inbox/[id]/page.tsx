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
import { toActor } from "@/app/_lib/api";
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
import { NextStep } from "./_components/next-step";
import { ThreadSide, ThreadSideSkeleton } from "./_components/thread-side";
import { ThreadFollowUps, ThreadHistory } from "./_components/thread-work";
import { RecordBody } from "@/app/(app)/_components/record/record-header";

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
      {/* The record frame's body: the work column (the message, the reply, the next step, follow-ups, earlier messages and the
          histories), then one bordered side panel about the person. On a phone the panel follows the work column. */}
      <div className="page">
        <RecordBody
          asideLabel="Person"
          main={
            <div className="stack-section min-w-0">
              {/* The sender and the mailbox are on the message card and the side panel; this line says whose move it is. */}
              <SummaryLine
                items={[
                  { label: "Waiting on", value: waitingOn(thread.workflowState), hint: `${workflowLabel(thread.workflowState)}. Who has to act next on this conversation` },
                  ...(thread.channel === "email" ? [] : [{ label: "Channel", value: channelLabel(thread.channel) }]),
                ]}
              />
              <DraftWatch contextVersion={thread.contextVersion} draftStatus={thread.latestDraftStatus} workflowState={thread.workflowState} />

              {latest && <MessageCard message={latest} channel={thread.channel} person={person} />}

              <div data-slot="reply-draft">
                <Suspense fallback={<Skeleton className="h-48 w-full" />}>
                  {thread.channel === "linkedin" ? (
                    <LinkedInReplyPanel conversationId={thread.conversationId} actor={actor} />
                  ) : (
                    <ReplyPanel conversationId={thread.conversationId} actor={actor} queue={fromActions ? { recordId: thread.recordId, view: actionsView } : undefined} />
                  )}
                </Suspense>
              </div>

              {/* What happens to the person after this reply: the category, and finishing without a reply. */}
              <Suspense fallback={<Skeleton className="h-20 w-full" />}>
                <NextStep actor={actor} conversationId={thread.conversationId} channel={thread.channel} recordId={thread.recordId} queue={fromActions ? { view: actionsView } : undefined} />
              </Suspense>

              <Suspense fallback={null}>
                <ThreadFollowUps actor={actor} recordId={thread.recordId} personId={person.id} />
              </Suspense>

              {earlier.length > 0 && (
                <section aria-labelledby="earlier-messages" className="stack-group">
                  <h2 id="earlier-messages" className="text-sm font-semibold">
                    Earlier messages ({earlier.length}), newest first
                  </h2>
                  {earlier.map((m) => (
                    <MessageCard key={`${m.source}-${m.id}`} message={m} channel={thread.channel} person={person} />
                  ))}
                </section>
              )}

              <Suspense fallback={<Skeleton className="h-24 w-full" />}>
                <ThreadHistory actor={actor} conversationId={thread.conversationId} recordId={thread.recordId} personId={person.id} />
              </Suspense>
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

/**
 * One message. An inbound message from the person names them, with their title and company, so you see who you answer
 * before the side panel, which a phone shows last. The address follows when it differs from the name.
 */
function MessageCard({ message: m, channel, person }: { message: ThreadDetail["messages"][number]; channel: string; person: ThreadDetail["person"] }) {
  const fromPerson = m.direction === "inbound" && person.name !== null && (m.from === null || m.from === person.email);
  const role = [person.title, person.company].filter(Boolean).join(" at ");
  return (
    <Card className={m.direction === "outbound" ? "bg-muted/40" : undefined}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          {fromPerson ? (
            <span className="min-w-0">
              {person.name}
              {role && <span className="ml-2 font-normal text-muted-foreground">{role}</span>}
            </span>
          ) : (
            <span className="min-w-0 break-all">{m.direction === "outbound" ? "You" : (m.from ?? "Sender")}</span>
          )}
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
          {fromPerson && m.from && <span className="break-all">{m.from}, </span>}
          <Time value={m.at} />
          {m.to ? <span className="break-all">{`, to ${m.to}`}</span> : ""}
          {m.cc?.length ? `, cc ${m.cc.join(", ")}` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm whitespace-pre-wrap">{m.bodyText}</p>
      </CardContent>
    </Card>
  );
}
