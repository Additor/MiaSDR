import { and, count, eq, ne, notLike, or, isNull } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { campaigns, sends } from "@/platform/db/schema";
import { env } from "@/shared/env";

/**
 * What the setup guide's campaign and send steps read: campaigns, the ones past draft, and the campaign emails that went
 * out. The fake provider marks its message ids, and a demo send proves nothing about real mail, so those count only on an
 * install that runs the fake provider.
 */
export async function onboardingCampaignFacts(organizationId: string, countDemoSends = env().MAILBOX_PROVIDER === "fake"): Promise<{ campaigns: number; startedCampaigns: number; emailsSent: number }> {
  const [[all], [started], [sent]] = await Promise.all([
    db.select({ n: count() }).from(campaigns).where(eq(campaigns.organizationId, organizationId)),
    db
      .select({ n: count() })
      .from(campaigns)
      .where(and(eq(campaigns.organizationId, organizationId), ne(campaigns.status, "draft"))),
    db
      .select({ n: count() })
      .from(sends)
      .where(
        and(
          eq(sends.organizationId, organizationId),
          eq(sends.kind, "campaign"),
          eq(sends.channel, "email"),
          eq(sends.status, "sent"),
          countDemoSends ? undefined : or(isNull(sends.providerMessageId), notLike(sends.providerMessageId, "fake-%")),
        ),
      ),
  ]);
  return { campaigns: all?.n ?? 0, startedCampaigns: started?.n ?? 0, emailsSent: sent?.n ?? 0 };
}
