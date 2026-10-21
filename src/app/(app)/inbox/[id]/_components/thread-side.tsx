import { SparklesIcon, UserIcon } from "lucide-react";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { dealSummaryForPeople } from "@/contexts/deals/application/deals";
import { dealsDeps } from "@/contexts/deals/infrastructure/deals-composition";
import { leadContactPoints } from "@/contexts/leads/domain/lead-activity";
import { channelLabel, enrollmentStatusLabel, stopReasonNote } from "@/contexts/outreach/domain/campaign-view";
import { NO_REACH } from "@/contexts/outreach/domain/reachability";
import { readReachability } from "@/contexts/outreach/infrastructure/composition";
import type { Actor } from "@/shared/errors";
import { CreateDealButton } from "@/app/(app)/crm/_components/create-deal-dialog";
import { dealDialogData } from "@/app/(app)/crm/_components/deal-dialog-data";
import { dealHref } from "@/app/(app)/crm/_components/deal-href";
import { categoryLabel } from "@/app/(app)/crm/_components/labels";
import { DoNotContactCard } from "@/app/(app)/crm/_components/person/do-not-contact-card";
import { TasksSection } from "@/app/(app)/crm/_components/person/tasks-section";
import { personHref } from "@/app/(app)/crm/_components/person/person-href";
import { ReachLinks } from "@/app/(app)/crm/_components/person/reach-links";
import { StateTip } from "@/app/(app)/crm/_components/person/state-tip";
import { AsideDisclosure, AsideSection } from "@/app/(app)/crm/_components/record/record-header";
import { AssigneeControls } from "./assignee-controls";
import { ChangeCategoryButton } from "./change-category-button";
import { RecordControls } from "./record-controls";
import { recordAfterReply, recordDetail } from "./thread-data";

/** The side panel while it loads: one block per section group inside the panel, so the layout does not jump when it arrives. */
export function ThreadSideSkeleton() {
  return (
    <div className="divide-y" aria-hidden data-testid="thread-side-loading">
      <div className="p-4">
        <Skeleton className="h-28 w-full" />
      </div>
      <div className="p-4">
        <Skeleton className="h-16 w-full" />
      </div>
      <div className="p-4">
        <Skeleton className="h-20 w-full" />
      </div>
      <div className="p-4">
        <Skeleton className="h-8 w-full" />
      </div>
    </div>
  );
}

/**
 * The thread's side column: who the person is and what you decide about them. Open: the person, Assigned to, the reply
 * category (with the closed state and Reopen), tasks, then the person's campaigns and other conversations folded behind
 * their counts. Close reply handling and Do not contact end the panel, as the stop controls do on every person page.
 * Follow-ups and the histories live in the work column (`thread-work.tsx`). Wrap it in Suspense.
 */
export async function ThreadSide({ actor, conversationId, recordId, personId }: { actor: Actor; conversationId: string; recordId: string; personId: string }) {
  await connection();
  const deps = dealsDeps();
  const [detail, afterReply, people, deals, dialog, reachMap] = await Promise.all([
    recordDetail(actor, recordId),
    recordAfterReply(actor, recordId),
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
  const dealPerson = { id: personId, name: person.name, email: person.email, companyName: person.company, doNotContact: dnc, suppressed: detail.suppressed, openDeals: summary?.openDeals ?? 0 };
  // A suggestion the AI holds for review, named next to "Not classified yet" so the two never seem to disagree.
  const held = !record.categoryKey ? detail.classifications.find((c) => c.status === "proposed" && c.latest) : undefined;
  // A campaign that hands replies to the Inbox says so in its Campaigns row; the work column then shows no follow-ups.
  const handoffCampaignId = !afterReply.run && afterReply.campaign?.mode === "handoff" ? afterReply.campaign.id : null;

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

      <AsideSection title="Reply category" testId="reply-category">
        <div className="grid gap-1 text-sm">
          {/* Who set the category rides on a mark beside it; the message card already says when the last reply came. */}
          <p className="flex items-center gap-1.5 font-medium">
            {record.categoryKey ? `${categoryLabel(record.categoryKey)}${record.subcategoryName ? `: ${record.subcategoryName}` : ""}` : "Not classified yet"}
            {record.categorySource && (
              <StateTip trigger={<span tabIndex={0} className="inline-flex rounded-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring" data-testid="category-source" />} tip={`Set by ${record.categorySource === "ai" ? "the AI" : "a person"}`}>
                {record.categorySource === "ai" ? <SparklesIcon aria-hidden className="size-3.5" /> : <UserIcon aria-hidden className="size-3.5" />}
              </StateTip>
            )}
          </p>
          {held?.proposed.categoryKey && <p>The AI suggests {categoryLabel(held.proposed.categoryKey)}, waiting in the reply panel.</p>}
          {record.categoryLocked && (
            <Badge variant="outline" className="w-fit" title="The AI cannot move this person out of Existing customer">
              Locked as Existing customer
            </Badge>
          )}
        </div>
        {closed ? (
          <RecordControls recordId={record.id} closed closedReason={record.closedReason ?? null} />
        ) : (
          <div>
            <ChangeCategoryButton recordId={record.id} conversationId={conversationId} personName={name} contextVersion={record.contextVersion} currentSubcategoryId={record.subcategoryId} categoryLocked={record.categoryLocked} stages={detail.stages} />
          </div>
        )}
      </AsideSection>

      <section className="stack-group p-4" data-testid="thread-tasks">
        <Suspense fallback={<Skeleton className="h-7 w-full" />}>
          <TasksSection recordId={record.id} actor={actor} heading={false} compact />
        </Suspense>
      </section>

      {detail.enrollments.length > 0 && (
        <AsideDisclosure title="Campaigns" count={detail.enrollments.length} testId="thread-campaigns">
          <ul className="grid gap-2 text-sm">
            {detail.enrollments.map((e) => {
              const status = enrollmentStatusLabel(e.status);
              const reason = stopReasonNote(e.status, e.stopReason);
              return (
                <li key={e.id} className="grid gap-0.5">
                  <div className="flex items-center justify-between gap-2">
                    <Link href={`/campaigns/${e.campaignId}`} title={e.campaignName} className="min-w-0 truncate underline-offset-4 hover:underline">
                      {e.campaignName}
                    </Link>
                    <Badge variant="outline">{status}</Badge>
                  </div>
                  {reason && <span className="text-xs text-muted-foreground">{reason}</span>}
                  {e.campaignId === handoffCampaignId && (
                    <span className="text-xs text-muted-foreground" data-testid="campaign-handoff">
                      Replies go to the Inbox.{" "}
                      <Link href={`/campaigns/${e.campaignId}#after-reply`} className="underline underline-offset-4 hover:text-foreground">
                        Turn on AI follow-ups
                      </Link>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </AsideDisclosure>
      )}

      {others.length > 0 && (
        <AsideDisclosure title="Other conversations" count={others.length} testId="thread-other-conversations">
          <ul className="grid gap-1 text-sm" aria-label={`${name} also wrote from another mailbox or channel`}>
            {others.map((c) => (
              <li key={c.id}>
                <Link href={`/inbox/${c.id}`} title={c.accountRef} className="flex min-h-8 items-center gap-2 underline-offset-4 hover:underline max-sm:min-h-11">
                  <Badge variant="outline">{channelLabel(c.channel)}</Badge>
                  <span className="min-w-0 truncate">{c.accountRef}</span>
                </Link>
              </li>
            ))}
          </ul>
        </AsideDisclosure>
      )}

      {!closed && (
        <AsideSection title="Reply handling" testId="thread-reply-handling">
          <RecordControls recordId={record.id} closed={false} closedReason={null} />
        </AsideSection>
      )}

      <DoNotContactCard personId={personId} doNotContact={dnc} reason={detail.policy?.reason ?? null} setAt={detail.policy?.setAt ?? null} suppression={null} testId="thread-dnc" />
    </>
  );
}
