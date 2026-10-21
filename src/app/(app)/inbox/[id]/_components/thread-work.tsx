import Link from "next/link";
import { connection } from "next/server";
import { Time } from "@/components/shell/time";
import { Badge } from "@/components/ui/badge";
import type { EventEntry } from "@/contexts/conversations/application/crm-ports";
import { dealsDeps } from "@/contexts/deals/infrastructure/deals-composition";
import type { Actor } from "@/shared/errors";
import { humanizeToken } from "@/shared/humanize";
import { eventLabel } from "@/app/(app)/crm/_components/event-labels";
import { categoryLabel } from "@/app/(app)/crm/_components/labels";
import { personHref } from "@/app/(app)/crm/_components/person/person-href";
import { RecordDisclosure } from "@/app/(app)/crm/_components/record/record-header";
import { toJson } from "@/app/(app)/crm/_components/serialize";
import { AfterReplyControls } from "./after-reply-controls";
import { ClassificationHistory } from "./classification-history";
import { recordAfterReply, recordDetail } from "./thread-data";

/** Shown in place of the follow-up controls for a contact. */
export const CONTACT_FOLLOW_UPS = "The person is a contact, so follow-ups do not apply.";

const ACTIVITY_SHOWN = 12;

/** An entry waits for a person: a suggestion on hold, or an AI change nobody reviewed. */
const waitsForReview = (entries: ReadonlyArray<{ status: string; acknowledged: boolean }>) =>
  entries.some((e) => e.status === "proposed" || (!e.acknowledged && e.status === "auto_applied"));

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
 * Follow-ups under the reply panel, where the drafts they write are approved. Nothing shows when there is nothing to
 * follow up: no run, and a campaign that hands replies to the Inbox, or a contact. Wrap it in Suspense.
 */
export async function ThreadFollowUps({ actor, recordId, personId }: { actor: Actor; recordId: string; personId: string }) {
  await connection();
  const [afterReply, people] = await Promise.all([recordAfterReply(actor, recordId), dealsDeps().people.summaries(actor.organizationId, [personId])]);
  const isContact = people.get(personId)?.lifecycle === "contact";
  if (!afterReply.run && (isContact || afterReply.campaign?.mode !== "ai_drafts")) return null;
  return (
    <section aria-labelledby="follow-ups" className="stack-group" data-testid="thread-after-reply">
      <h2 id="follow-ups" className="text-sm font-semibold">
        Follow-ups
      </h2>
      <AfterReplyControls recordId={recordId} state={toJson(afterReply)} disabledReason={isContact ? CONTACT_FOLLOW_UPS : null} />
    </section>
  );
}

/**
 * What happened around this person, under the messages: the AI's classifications (open while one waits for review),
 * drafts, the conversation's notes and the activity, each folded behind its count. A history with nothing in it is
 * left out. Wrap it in Suspense.
 */
export async function ThreadHistory({ actor, conversationId, recordId, personId }: { actor: Actor; conversationId: string; recordId: string; personId: string }) {
  await connection();
  const [detail, people] = await Promise.all([recordDetail(actor, recordId), dealsDeps().people.summaries(actor.organizationId, [personId])]);
  const lifecycle = people.get(personId)?.lifecycle;
  const classifications = toJson(detail.classifications);
  const events = detail.events.slice(0, ACTIVITY_SHOWN);
  if (classifications.length + detail.drafts.length + detail.notes.length + events.length === 0) return null;

  return (
    <section aria-labelledby="thread-history" className="grid" data-testid="thread-history">
      <h2 id="thread-history" className="pb-group text-sm font-semibold">
        History
      </h2>
      {classifications.length > 0 && (
        <RecordDisclosure title="Classification history" count={classifications.length} open={waitsForReview(classifications)}>
          <ClassificationHistory entries={classifications} currentConversationId={conversationId} />
        </RecordDisclosure>
      )}

      {detail.drafts.length > 0 && (
        <RecordDisclosure title="Drafts" count={detail.drafts.length} testId="thread-drafts">
          <ul className="grid gap-2 text-sm" aria-label="Drafts, newest first">
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
        </RecordDisclosure>
      )}

      {detail.notes.length > 0 && (
        <RecordDisclosure title="Notes" count={detail.notes.length} testId="thread-notes">
          <p className="text-sm text-muted-foreground">
            Written on this conversation. Add and edit notes on the{" "}
            <Link href={personHref(personId, lifecycle)} className="underline underline-offset-4">
              {lifecycle === "contact" ? "contact page" : "lead page"}
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
        </RecordDisclosure>
      )}

      {events.length > 0 && (
        <RecordDisclosure title="Activity" count={detail.events.length > ACTIVITY_SHOWN ? `latest ${ACTIVITY_SHOWN}` : events.length} testId="thread-activity">
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
        </RecordDisclosure>
      )}
    </section>
  );
}
