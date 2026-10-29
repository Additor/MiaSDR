import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { EmptyState } from "@/components/shell/empty-state";
import { ListSkeleton } from "@/components/shell/list-skeleton";
import { PageHeader } from "@/components/shell/page-header";
import { Time } from "@/components/shell/time";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { readPersonalThread } from "@/contexts/outreach/linkedin/application/personal-thread";
import { personalThreadDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { cn } from "@/components/ui/utils";
import { toActor } from "@/app/_lib/api";
import { ForbiddenError, NotFoundError } from "@/shared/errors";

export const metadata: Metadata = { title: "Private reply" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function PersonalThreadPage({ params }: PageProps<"/campaigns/[id]/leads/[enrollmentId]/thread">) {
  return (
    <Suspense
      fallback={
        <div className="page">
          <ListSkeleton rows={3} toolbar={false} />
        </div>
      }
    >
      <Thread params={params} />
    </Suspense>
  );
}

async function Thread({ params }: { params: PageProps<"/campaigns/[id]/leads/[enrollmentId]/thread">["params"] }) {
  await connection();
  const { id, enrollmentId } = await params;
  if (!UUID.test(id) || !UUID.test(enrollmentId)) notFound();
  const actor = toActor(await requireOrgContext());
  let thread;
  try {
    thread = await readPersonalThread(personalThreadDeps(), actor, id, enrollmentId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    if (error instanceof ForbiddenError) {
      return (
        <>
          <PageHeader title="Private reply" />
          <div className="page stack-group">
            <p className="text-sm text-muted-foreground">Only an owner, an admin or the campaign creator can read this.</p>
            <Link href={`/campaigns/${id}`} className={cn(buttonVariants({ variant: "outline", size: "sm", touch: true }), "w-fit")}>
              Back to the campaign
            </Link>
          </div>
        </>
      );
    }
    throw error;
  }
  return (
    <>
      <PageHeader
        title={thread.personName ?? "Lead"}
        back={{ href: `/campaigns/${thread.campaignId}`, label: thread.campaignName }}
      />
      <div className="page stack-group">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">Personal</Badge>
          <p className="text-sm text-muted-foreground">Replies to {thread.campaignName}. They stay out of the Inbox and get no AI draft.</p>
        </div>
        {thread.messages.length === 0 ? (
          <EmptyState title="No reply yet" description="Replies to this campaign show here once the person answers." />
        ) : (
          <ol className="min-w-0 divide-y border-y" aria-label="Messages">
            {thread.messages.map((m) => (
              <li key={m.id} className="stack-field py-4">
                <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
                  <span className="font-semibold">{m.direction === "inbound" ? (thread.personName ?? "Lead") : "You"}</span>
                  <span className="text-xs text-muted-foreground">
                    <Time value={m.at} />
                  </span>
                </p>
                <p className="max-w-prose text-sm break-words whitespace-pre-wrap">{m.text}</p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </>
  );
}
