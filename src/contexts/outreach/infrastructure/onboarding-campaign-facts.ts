import { and, count, eq, isNull } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { campaigns } from "@/platform/db/schema";

/**
 * What the onboarding checklist's campaign step reads: campaigns in the organization, and the running ones a person
 * started. A campaign an agent started does not count as running here, so the step still reflects a person's launch.
 */
export async function onboardingCampaignFacts(organizationId: string): Promise<{ campaigns: number; activeCampaigns: number }> {
  const [[all], [running]] = await Promise.all([
    db.select({ n: count() }).from(campaigns).where(eq(campaigns.organizationId, organizationId)),
    db
      .select({ n: count() })
      .from(campaigns)
      .where(and(eq(campaigns.organizationId, organizationId), eq(campaigns.status, "active"), isNull(campaigns.startedViaTokenId))),
  ]);
  return { campaigns: all?.n ?? 0, activeCampaigns: running?.n ?? 0 };
}
