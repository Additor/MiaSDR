import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { dealSummaryForPeople } from "@/contexts/deals/application/deals";
import { dealsDeps } from "@/composition/deals";
import { leadContactPoints } from "@/contexts/people/domain/lead-activity";
import { channelLabel, enrollmentStatusLabel, stopReasonNote } from "@/contexts/outreach/domain/campaign-view";
import { NO_REACH } from "@/contexts/people/domain/reachability";
import { readReachability } from "@/contexts/people/infrastructure/composition";
import type { Actor } from "@/shared/errors";
import { CreateDealButton } from "@/app/(app)/crm/_components/create-deal-dialog";
import { dealDialogData } from "@/app/(app)/crm/_components/deal-dialog-data";
import { dealHref } from "@/app/(app)/crm/_components/deal-href";
import { DoNotContactCard } from "@/app/(app)/_components/person/do-not-contact-card";
import { TasksSection } from "@/app/(app)/_components/person/tasks-section";
import { personHref } from "@/app/(app)/_components/person/person-href";
import { ReachLinks } from "@/app/(app)/_components/person/reach-links";
import { AsideDisclosure, AsideSection } from "@/app/(app)/_components/record/record-header";
import { AssigneeControls } from "./assignee-controls";
import { recordAfterReply, recordDetail } from "./thread-data";

/** The side panel while it loads: one block per section group inside the panel, so the layout does not jump when it arrives. */
export function ThreadSideSkeleton() {
  return (
    <div className="divide-y" aria-hidden data-testid="thread-side-loading">
      <div className="p-inset">
        <Skeleton className="h-28 w-full" />
      </div>
      <div className="p-inset">
        <Skeleton className="h-16 w-full" />
      </div>
      <div className="p-inset">
        <Skeleton className="h-20 w-full" />
      </div>
      <div className="p-inset">
        <Skeleton className="h-8 w-full" />
      </div>
    </div>
  );
}

/**
 * The thread's side column: who the person is and what is on file about them. Open: the person, Assigned to and tasks, then
 * the person's campaigns and other conversations folded behind their counts, and Do not contact with Clear once they are
 * marked. What happens next (Remind me, Done, Stop contacting) sits under the reply in Next step (`next-step.tsx`), and
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
  const others = detail.conversations.filter((c) => c.id !== conversationId);
  const dealPerson = { id: personId, name: person.name, email: person.email, companyName: person.company, doNotContact: dnc, suppressed: detail.suppressed, openDeals: summary?.openDeals ?? 0 };
  // A campaign that hands replies to the Inbox says so in its Campaigns row; the work column then shows no follow-ups.
  const handoffCampaignId = !afterReply.run && afterReply.campaign?.mode === "handoff" ? afterReply.campaign.id : null;

  return (
    <>
      <AsideSection title={name} action={isContact ? <Badge variant="outline">Contact</Badge> : undefined} testId="thread-person">
        {(person.title || person.company) && <p className="text-sm text-muted-foreground">{[person.title, person.company].filter(Boolean).join(" at ")}</p>}
        <ReachLinks reach={reach} contact={contact} phone={null} phoneHref={null} />
        <div className="flex flex-wrap gap-2 max-sm:[&>*]:h-11">
          {!isContact && <CreateDealButton mode="lead" size="sm" variant="outline" person={dealPerson} members={dialog.members} currentUserId={dialog.currentUserId} stages={dialog.stages} />}
          {isContact && latestDealId && (
            <Link href={dealHref(latestDealId, `/inbox/${conversationId}`)} className={buttonVariants({ variant: "outline", size: "sm" })}>
              Open deal
            </Link>
          )}
          {isContact && !latestDealId && (
            <CreateDealButton mode="contact" size="sm" variant="outline" person={dealPerson} members={dialog.members} currentUserId={dialog.currentUserId} stages={dialog.stages} />
          )}
          <Link href={personHref(personId, directory?.lifecycle)} className={buttonVariants({ variant: "outline", size: "sm" })}>
            {isContact ? "Open contact" : "Open lead"}
          </Link>
        </div>
      </AsideSection>

      <AsideSection title="Assigned to" testId="thread-assignee">
        <AssigneeControls recordId={record.id} assignedTo={record.assignedTo} members={dialog.members} currentUserId={dialog.currentUserId} />
      </AsideSection>

      <section className="stack-group p-inset" data-testid="thread-tasks">
        <Suspense fallback={<Skeleton className="h-7 w-full" />}>
          <TasksSection recordId={record.id} actor={actor} compact />
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
                    {/* A long name wraps rather than hiding behind a native title, which a phone and a keyboard never show. */}
                    <Link href={`/campaigns/${e.campaignId}`} className="min-w-0 break-words underline-offset-4 hover:underline">
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
                <Link href={`/inbox/${c.id}`} className="flex min-h-8 items-center gap-2 underline-offset-4 hover:underline max-sm:min-h-11">
                  <Badge variant="outline">{channelLabel(c.channel)}</Badge>
                  <span className="min-w-0 break-all">{c.accountRef}</span>
                </Link>
              </li>
            ))}
          </ul>
        </AsideDisclosure>
      )}

      {/* Marking happens under the reply, in Next step's Stop contacting; a marked person shows it here with Clear. */}
      {dnc && <DoNotContactCard personId={personId} doNotContact reason={detail.policy?.reason ?? null} setAt={detail.policy?.setAt ?? null} suppression={null} testId="thread-dnc" />}
    </>
  );
}
