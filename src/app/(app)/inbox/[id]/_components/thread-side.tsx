import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { Time } from "@/components/shell/time";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getCrmRecordDetail } from "@/contexts/conversations/application/crm";
import type { EventEntry } from "@/contexts/conversations/application/crm-ports";
import { getRecordSequence } from "@/contexts/conversations/after-reply/application/sequences";
import { crmDeps } from "@/contexts/conversations/infrastructure/crm-composition";
import { sequenceDeps } from "@/contexts/conversations/after-reply/infrastructure/sequence-composition";
import { dealSummaryForPeople } from "@/contexts/deals/application/deals";
import { dealsDeps } from "@/contexts/deals/infrastructure/deals-composition";
import { leadContactPoints } from "@/contexts/leads/domain/lead-activity";
import { channelLabel, enrollmentStatusLabel, stopReasonNote } from "@/contexts/outreach/domain/campaign-view";
import { NO_REACH } from "@/contexts/outreach/domain/reachability";
import { readReachability } from "@/contexts/outreach/infrastructure/composition";
import type { Actor } from "@/shared/errors";
import { humanizeToken } from "@/shared/humanize";
import { CreateDealButton } from "@/app/(app)/crm/_components/create-deal-dialog";
import { dealDialogData } from "@/app/(app)/crm/_components/deal-dialog-data";
import { dealHref } from "@/app/(app)/crm/_components/deal-href";
import { eventLabel } from "@/app/(app)/crm/_components/event-labels";
import { categoryLabel } from "@/app/(app)/crm/_components/labels";
import { DncControl } from "@/app/(app)/crm/_components/person/dnc-control";
import { DoNotContactNote } from "@/app/(app)/crm/_components/person/do-not-contact-card";
import { TasksSection } from "@/app/(app)/crm/_components/person/tasks-section";
import { personHref } from "@/app/(app)/crm/_components/person/person-href";
import { ReachLinks } from "@/app/(app)/crm/_components/person/reach-links";
import { AsideSection } from "@/app/(app)/crm/_components/record/record-header";
import { toJson } from "@/app/(app)/crm/_components/serialize";
import { AfterReplyControls } from "./after-reply-controls";
import { AssigneeControls } from "./assignee-controls";
import { ChangeCategoryButton } from "./change-category-button";
import { ClassificationHistory } from "./classification-history";
import { RecordControls } from "./record-controls";

/** Shown in place of the follow-up controls for a contact. */
export const CONTACT_FOLLOW_UPS = "The person is a contact, so follow-ups do not apply.";

const ACTIVITY_SHOWN = 12;

/** Draft history wording. It differs from the reply panel's status badge, which names the draft in front of you. */
const DRAFT_STATUS: Record<string, string> = {
  awaiting_review: "Waits for review",
  generating: "Being written",
  sending: "Sending",
  sent: "Sent",
  discarded: "Discarded",
  stale: "Out of date",
  failed: "Failed",
  delivery_uncertain: "Delivery unconfirmed",
};

/** The side panel while it loads: one block per section group inside the panel, so the layout does not jump when it arrives. */
export function ThreadSideSkeleton() {
  return (
    <div className="divide-y" aria-hidden data-testid="thread-side-loading">
      <div className="p-4">
        <Skeleton className="h-32 w-full" />
      </div>
      <div className="p-4">
        <Skeleton className="h-40 w-full" />
      </div>
      <div className="p-4">
        <Skeleton className="h-36 w-full" />
      </div>
    </div>
  );
}

function eventDetail(e: EventEntry): string | null {
  const meta = e.meta as { note?: unknown; reason?: unknown; title?: unknown };
  const to = e.toData as { categoryKey?: string | null; lostReason?: unknown } | null;
  // `reason` is a code token on most events; only the do-not-contact events carry a reason a person typed.
  const typed = [meta.note, e.eventType.startsWith("contact_policy.") ? meta.reason : null, to?.lostReason, e.eventType.startsWith("deal.") ? meta.title : null];
  const parts = [to?.categoryKey ? categoryLabel(to.categoryKey) : null, ...typed.filter((v): v is string => typeof v === "string" && v.trim() !== "")].filter(Boolean);
  return parts.length ? parts.join(". ") : null;
}

const actorText = (e: EventEntry) => (e.actorType === "human" ? (e.actorName ?? "A person") : e.actorType === "ai" ? "The AI" : humanizeToken(e.actorType));

/**
 * The thread's side column: the person, do not contact, the reply category, tasks, After a reply,
 * classification history, campaigns, the person's other conversations, drafts, activity and the conversation's notes.
 * Each block is an AsideSection inside the one bordered panel that `RecordBody` draws. Wrap it in Suspense.
 */
export async function ThreadSide({ actor, conversationId, recordId, personId }: { actor: Actor; conversationId: string; recordId: string; personId: string }) {
  await connection();
  const deps = dealsDeps();
  const [detail, afterReply, people, deals, dialog, reachMap] = await Promise.all([
    getCrmRecordDetail(crmDeps(), actor, recordId),
    getRecordSequence(sequenceDeps(), actor, recordId),
    deps.people.summaries(actor.organizationId, [personId]),
    dealSummaryForPeople(deps, actor, [personId]),
    dealDialogData(actor),
    readReachability(actor.organizationId, [personId]),
  ]);
  const { record, person } = detail;
  const directory = people.get(personId);
  const isContact = directory?.lifecycle === "contact";
  const summary = deals.get(personId);
  const latestDealId = summary?.latestDealId ?? null;
  const name = person.name ?? person.email ?? "Unknown sender";
  const dnc = detail.policy?.doNotContact === true;
  const reach = reachMap.get(personId) ?? NO_REACH;
  const contact = leadContactPoints({ email: person.email, linkedinSlug: directory?.linkedinSlug ?? null, linkedinUrl: directory?.linkedinUrl ?? person.linkedinUrl ?? null });
  const closed = record.workflowState === "closed";
  const others = detail.conversations.filter((c) => c.id !== conversationId);
  const events = detail.events.slice(0, ACTIVITY_SHOWN);
  const dealPerson = { id: personId, name: person.name, email: person.email, companyName: person.company, doNotContact: dnc, suppressed: detail.suppressed, openDeals: summary?.openDeals ?? 0 };

  return (
    <>
      <AsideSection title={name} action={isContact ? <Badge variant="outline">Contact</Badge> : undefined} testId="thread-person">
        {(person.title || person.company) && <p className="text-sm text-muted-foreground">{[person.title, person.company].filter(Boolean).join(" at ")}</p>}
        <ReachLinks reach={reach} contact={contact} phone={null} phoneHref={null} />
        <div className="flex flex-wrap gap-2 max-sm:[&>*]:h-11">
          {!isContact && <CreateDealButton mode="lead" size="sm" person={dealPerson} members={dialog.members} currentUserId={dialog.currentUserId} stages={dialog.stages} />}
          {isContact && latestDealId && (
            <Link href={dealHref(latestDealId, `/inbox/${conversationId}`)} className={buttonVariants({ size: "sm" })}>
              Open deal
            </Link>
          )}
          {isContact && !latestDealId && (
            <CreateDealButton mode="contact" size="sm" person={dealPerson} members={dialog.members} currentUserId={dialog.currentUserId} stages={dialog.stages} />
          )}
          <Link href={personHref(personId, directory?.lifecycle)} className={buttonVariants({ variant: "outline", size: "sm" })}>
            {isContact ? "Open contact" : "Open lead"}
          </Link>
        </div>
      </AsideSection>

      <AsideSection title="Assigned to" testId="thread-assignee">
        <AssigneeControls recordId={record.id} assignedTo={record.assignedTo} members={dialog.members} currentUserId={dialog.currentUserId} />
      </AsideSection>

      <AsideSection title="Do not contact" testId="thread-dnc">
        <DoNotContactNote doNotContact={dnc} reason={detail.policy?.reason ?? null} setAt={detail.policy?.setAt ?? null} />
        <DncControl personId={personId} doNotContact={dnc} />
      </AsideSection>

      <AsideSection title="Reply category" testId="reply-category">
        <div className="grid gap-1 text-sm">
          <p className="font-medium">{record.categoryKey ? `${categoryLabel(record.categoryKey)}${record.subcategoryName ? `: ${record.subcategoryName}` : ""}` : "Not classified yet"}</p>
          {record.categorySource && <p className="text-muted-foreground">Set by {record.categorySource === "ai" ? "the AI" : "a person"}</p>}
          {record.categoryLocked && (
            <Badge variant="outline" className="w-fit" title="The AI cannot move this person out of Existing customer">
              Locked as Existing customer
            </Badge>
          )}
          {record.activeChannel && <p className="text-muted-foreground">Last reply on {channelLabel(record.activeChannel)}</p>}
          {record.lastInboundAt && (
            <p className="text-muted-foreground">
              Last reply <Time value={record.lastInboundAt} />
            </p>
          )}
          {closed && <p className="text-muted-foreground">Reply handling closed{record.closedReason ? `: ${record.closedReason}` : "."}</p>}
        </div>
        {!closed && (
          <div>
            <ChangeCategoryButton recordId={record.id} personName={name} contextVersion={record.contextVersion} currentSubcategoryId={record.subcategoryId} categoryLocked={record.categoryLocked} stages={detail.stages} />
          </div>
        )}
        <div className="border-t pt-group">
          <RecordControls recordId={record.id} personName={name} closed={closed} />
        </div>
      </AsideSection>

      <AsideSection title="Tasks" testId="thread-tasks">
        <p className="text-sm text-muted-foreground">Follow-ups for this person. Open tasks also appear in Actions.</p>
        <Suspense fallback={<Skeleton className="h-24 w-full" />}>
          <TasksSection recordId={record.id} actor={actor} heading={false} />
        </Suspense>
      </AsideSection>

      <AsideSection title="After a reply" testId="thread-after-reply">
        <p className="text-sm text-muted-foreground">Drafts the next steps for you to approve. Nothing sends by itself.</p>
        <AfterReplyControls recordId={record.id} state={toJson(afterReply)} disabledReason={isContact ? CONTACT_FOLLOW_UPS : null} />
      </AsideSection>

      <ClassificationHistory entries={toJson(detail.classifications)} currentConversationId={conversationId} />

      {detail.enrollments.length > 0 && (
        <AsideSection title="Campaigns" testId="thread-campaigns">
          <ul className="grid gap-2 text-sm">
            {detail.enrollments.map((e) => {
              const status = enrollmentStatusLabel(e.status);
              const reason = stopReasonNote(e.status, e.stopReason);
              return (
                <li key={e.id} className="grid gap-0.5">
                  <div className="flex items-center justify-between gap-2">
                    <Link href={`/campaigns/${e.campaignId}`} className="min-w-0 truncate underline-offset-4 hover:underline">
                      {e.campaignName}
                    </Link>
                    <Badge variant="outline">{status}</Badge>
                  </div>
                  {reason && <span className="text-xs text-muted-foreground">{reason}</span>}
                </li>
              );
            })}
          </ul>
        </AsideSection>
      )}

      {others.length > 0 && (
        <AsideSection title="Other conversations" testId="thread-other-conversations">
          <p className="text-sm text-muted-foreground">{name} also wrote from another mailbox or channel.</p>
          <ul className="grid gap-1 text-sm">
            {others.map((c) => (
              <li key={c.id}>
                <Link href={`/inbox/${c.id}`} className="flex min-h-8 items-center gap-2 underline-offset-4 hover:underline max-sm:min-h-11">
                  <Badge variant="outline">{channelLabel(c.channel)}</Badge>
                  <span className="min-w-0 truncate">{c.accountRef}</span>
                </Link>
              </li>
            ))}
          </ul>
        </AsideSection>
      )}

      {detail.drafts.length > 0 && (
        <AsideSection title="Drafts" testId="thread-drafts">
          <p className="text-sm text-muted-foreground">Every draft written for this person, newest first.</p>
          <ul className="grid gap-2 text-sm">
            {detail.drafts.map((d) => (
              <li key={d.id} className="grid gap-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{DRAFT_STATUS[d.status] ?? humanizeToken(d.status)}</Badge>
                  <span className="text-xs text-muted-foreground">
                    Revision {d.revision}, <Time value={d.createdAt} />
                  </span>
                </div>
                <p className="line-clamp-2 break-words text-muted-foreground">{d.preview}</p>
              </li>
            ))}
          </ul>
        </AsideSection>
      )}

      <AsideSection title="Activity" testId="thread-activity">
        {detail.events.length > ACTIVITY_SHOWN && <p className="text-sm text-muted-foreground">The latest {ACTIVITY_SHOWN} events.</p>}
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing has happened yet.</p>
        ) : (
          <ol className="grid gap-2 text-sm" aria-label="Activity">
            {events.map((e) => {
              const extra = eventDetail(e);
              return (
                <li key={e.id} className="grid gap-0.5">
                  <span className="break-words">{eventLabel(e)}</span>
                  <span className="text-xs text-muted-foreground">
                    {actorText(e)}, <Time value={e.createdAt} />
                    {extra ? `. ${extra}` : ""}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </AsideSection>

      {detail.notes.length > 0 && (
        <AsideSection title="Notes" testId="thread-notes">
          <p className="text-sm text-muted-foreground">
            Written on this conversation. Add and edit notes on the{" "}
            <Link href={personHref(personId, directory?.lifecycle)} className="underline underline-offset-4">
              {isContact ? "contact page" : "lead page"}
            </Link>
            .
          </p>
          <ul className="divide-y text-sm">
            {detail.notes.map((n) => (
              <li key={n.id} className="grid gap-0.5 py-group first:pt-0 last:pb-0">
                {n.title && <span className="font-medium">{n.title}</span>}
                <p className="break-words whitespace-pre-wrap">{n.body}</p>
                <span className="text-xs text-muted-foreground">
                  {n.authorName ?? "A person"}, <Time value={n.createdAt} />
                </span>
              </li>
            ))}
          </ul>
        </AsideSection>
      )}
    </>
  );
}
