import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { DbTx } from "@/platform/db/client";
import { campaignEnrollments, campaigns, sends } from "@/platform/db/schema";
import type { PersonTimeline } from "../application/inbound-ports";
import { bouncesTripPause, type BouncePause } from "../domain/bounce-pause";
import { SEND_COUNTED } from "../domain/send-status";

/**
 * Marks the send a verified hard bounce belongs to and checks its campaign's rate, in the transaction that stops the
 * address. The mark lives on the send because a last step's enrollment has already completed and stays `completed`, so the
 * enrollment status misses those bounces. A replayed notice finds the mark in place and counts nothing twice.
 * Returns the pause it wrote, or null.
 */
export async function recordBounceTx(tx: DbTx, timeline: PersonTimeline, input: { organizationId: string; sendId: string; now: Date }): Promise<BouncePause | null> {
  const { organizationId, sendId, now } = input;
  await tx.update(sends).set({ bouncedAt: now }).where(and(eq(sends.id, sendId), eq(sends.organizationId, organizationId), sql`${sends.bouncedAt} is null`));
  // The row lock makes two bounces that land together count one after the other, so neither misses the other's mark.
  const [campaign] = await tx
    .select({ id: campaigns.id, name: campaigns.name, status: campaigns.status, channel: campaigns.channel, countedFrom: campaigns.sendsCountedFrom, personId: campaignEnrollments.personId })
    .from(sends)
    .innerJoin(campaignEnrollments, eq(campaignEnrollments.id, sends.enrollmentId))
    .innerJoin(campaigns, eq(campaigns.id, campaignEnrollments.campaignId))
    .where(eq(sends.id, sendId))
    .for("no key update", { of: campaigns });
  if (!campaign || campaign.status !== "active" || campaign.channel !== "email") return null;
  const [count] = await tx
    .select({ sent: sql<number>`count(*)::int`, bounced: sql<number>`(count(*) filter (where ${sends.bouncedAt} is not null))::int` })
    .from(sends)
    .innerJoin(campaignEnrollments, eq(campaignEnrollments.id, sends.enrollmentId))
    .where(and(eq(campaignEnrollments.campaignId, campaign.id), eq(sends.kind, "campaign"), eq(sends.channel, "email"), inArray(sends.status, SEND_COUNTED), gte(sends.claimedAt, campaign.countedFrom)));
  if (!bouncesTripPause(count)) return null;
  const pause: BouncePause = { at: now.toISOString(), sent: count.sent, bounced: count.bounced };
  // `person_paused` holds it for a person, so the agent paths and Pause campaigns agents started treat it as they treat a person's pause.
  await tx.update(campaigns).set({ status: "paused", personPaused: true, bouncePause: pause }).where(and(eq(campaigns.id, campaign.id), eq(campaigns.status, "active")));
  await timeline.append(tx, {
    organizationId,
    personId: campaign.personId,
    eventType: "campaign.paused_for_bounces",
    actorType: "system",
    fromData: { status: "active" },
    toData: { status: "paused" },
    meta: { campaignId: campaign.id, campaignName: campaign.name, sent: count.sent, bounced: count.bounced },
  });
  return pause;
}
