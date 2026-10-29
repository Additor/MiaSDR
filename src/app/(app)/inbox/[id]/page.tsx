import { ChevronRightIcon, TriangleAlertIcon } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { PageSkeleton } from "@/components/shell/page-skeleton";
import { Section } from "@/components/shell/section";
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
import { ImportantStar } from "./_components/important-star";
import { MarkRead } from "./_components/mark-read";
import { NextQueueLink } from "./_components/next-queue-link";
import { NextUnreadLink } from "./_components/next-unread-link";
import { LinkedInReplyPanel } from "./_components/linkedin-reply-panel";
import { ReplyPanel } from "./_components/reply-panel";
import { NextStep } from "./_components/next-step";
import { ThreadSide, ThreadSideSkeleton } from "./_components/thread-side";
import { ThreadFollowUps, ThreadHistory } from "./_components/thread-work";
import { TypeLine } from "./_components/type-line";
import { RecordBody } from "@/app/(app)/_components/record/record-header";

export const metadata: Metadata = { title: "Conversation" };

export default function ConversationPage({ params, searchParams }: PageProps<"/inbox/[id]">) {
  return (
    <Suspense
      fallback={
        <div className="page">
          <PageSkeleton shape="record" label="Loading the conversation" />
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
      {/* The record frame's body: the work column (the message and its reply type, the reply, the next step, follow-ups,
          earlier messages and the histories), then one bordered side panel about the person. On a phone the panel follows the
          work column. */}
      <div className="page">
        <RecordBody
          asideLabel="Person"
          main={
            <div className="stack-section min-w-0">
              {/* Email is the default channel, so only another channel is named. */}
              {thread.channel !== "email" && <SummaryLine items={[{ label: "Channel", value: channelLabel(thread.channel) }]} />}

              {/* The latest message and, fixed under it, its reply type: the type line opens in place when the AI's pick waits for you. */}
              <div className="grid gap-2">
                {latest && <MessageCard message={latest} channel={thread.channel} person={person} />}
                <Suspense fallback={<Skeleton className="h-6 w-2/3" />}>
                  <TypeLine actor={actor} conversationId={thread.conversationId} channel={thread.channel} recordId={thread.recordId} queue={fromActions ? { view: actionsView } : undefined} />
                </Suspense>
              </div>

              <div data-slot="reply-draft">
                <Suspense fallback={<Skeleton className="h-48 w-full" />}>
                  {thread.channel === "linkedin" ? (
                    <LinkedInReplyPanel conversationId={thread.conversationId} recordId={thread.recordId} actor={actor} />
                  ) : (
                    <ReplyPanel conversationId={thread.conversationId} actor={actor} queue={fromActions ? { recordId: thread.recordId, view: actionsView } : undefined} />
                  )}
                </Suspense>
              </div>

              {/* What happens to the person after this reply: finishing without a reply. `?stop=1` opens Stop contacting. */}
              <Suspense fallback={<Skeleton className="h-20 w-full" />}>
                <NextStep
                  actor={actor}
                  conversationId={thread.conversationId}
                  channel={thread.channel}
                  recordId={thread.recordId}
                  queue={fromActions ? { view: actionsView } : undefined}
                  stopOnLoad={query.stop === "1"}
                />
              </Suspense>

              <Suspense fallback={null}>
                <ThreadFollowUps actor={actor} recordId={thread.recordId} personId={person.id} />
              </Suspense>

              {/* Newest first, each folded to one line, so History stays near the reply. A line opens the message in place. */}
              {earlier.length > 0 && (
                <Section frame="plain" id="earlier-messages" title="Earlier messages" count={earlier.length}>
                  <ul className="divide-y rounded-lg border text-sm">
                    {earlier.map((m) => (
                      <li key={`${m.source}-${m.id}`}>
                        <EarlierMessage message={m} channel={thread.channel} person={person} />
                      </li>
                    ))}
                  </ul>
                </Section>
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

type Message = ThreadDetail["messages"][number];
type Person = ThreadDetail["person"];

/** The message is the person's own: an inbound message from their address, or with no address on it. */
const isFromPerson = (m: Message, person: Person) => m.direction === "inbound" && person.name !== null && (m.from === null || m.from === person.email);

/**
 * One message. An inbound message from the person names them, with their title and company, so you see who you answer
 * before the side panel, which a phone shows last. The address follows when it differs from the name.
 */
function MessageCard({ message: m, channel, person }: { message: Message; channel: string; person: Person }) {
  return (
    <Card className={m.direction === "outbound" ? "bg-muted/40" : undefined}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <MessageTitle message={m} channel={channel} person={person} />
        </CardTitle>
        <CardDescription>
          <MessageMeta message={m} person={person} />
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm whitespace-pre-wrap">{m.bodyText}</p>
      </CardContent>
    </Card>
  );
}

/**
 * An earlier message as one line: who wrote, the start of the text and the time. It opens in place to the whole message,
 * with the same facts as a message card, inside the list's own frame instead of a second card.
 */
function EarlierMessage({ message: m, channel, person }: { message: Message; channel: string; person: Person }) {
  const sender = isFromPerson(m, person) ? person.name : m.direction === "outbound" ? "You" : (m.from ?? "Sender");
  return (
    <details className="group" data-testid="earlier-message">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-md px-3 py-2 select-none focus-ring hover:bg-muted/50 sm:min-h-9 [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground transition-transform duration-(--duration-panel) ease-out group-open:rotate-90" />
        <span className={m.unread ? "shrink-0 font-semibold" : "shrink-0 font-medium"}>{sender}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{m.bodyText.slice(0, 240).replace(/\s+/g, " ").trim()}</span>
        <Time value={m.at} className="shrink-0 text-xs text-muted-foreground tabular-nums" />
      </summary>
      <div className="stack-field px-3 pb-3 pl-9">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
          <MessageTitle message={m} channel={channel} person={person} />
        </div>
        <p className="text-muted-foreground">
          <MessageMeta message={m} person={person} />
        </p>
        <p className="mt-group whitespace-pre-wrap">{m.bodyText}</p>
      </div>
    </details>
  );
}

/** Who wrote the message, with its marks: a sequence step, a bounce or an auto-reply, unread, and the Important star. */
function MessageTitle({ message: m, channel, person }: { message: Message; channel: string; person: Person }) {
  const fromPerson = isFromPerson(m, person);
  const role = [person.title, person.company].filter(Boolean).join(" at ");
  return (
    <>
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
    </>
  );
}

/** The address when it differs from the name, the time, the recipient and the copies. */
function MessageMeta({ message: m, person }: { message: Message; person: Person }) {
  return (
    <>
      {isFromPerson(m, person) && m.from && <span className="break-all">{m.from}, </span>}
      <Time value={m.at} />
      {m.to ? <span className="break-all">{`, to ${m.to}`}</span> : ""}
      {m.cc?.length ? `, cc ${m.cc.join(", ")}` : ""}
    </>
  );
}
