import { eq, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { canonicalTimeZone } from "@/shared/time-zone";
import { channelSettings, organizations } from "@/platform/db/schema";
import { readUnknownSenderAiCap, UNKNOWN_SENDER_AI_CAP_KEY } from "../domain/ai-cap";
import { DEFAULT_PHONE_COUNTRY_KEY, normalizePhoneCountry } from "../domain/phone-country";
import { recordAudit } from "@/platform/db/audit";
import { isValidTimeZone } from "@/shared/time-zone";
import type { OrganizationStore } from "../application/organization-settings";

const VALID_ZONE = (zone: unknown): zone is string => typeof zone === "string" && isValidTimeZone(zone);

export const drizzleOrganizationStore: OrganizationStore = {
  async get(organizationId) {
    const [org] = await db.select().from(organizations).where(eq(organizations.id, organizationId));
    if (!org) return null;
    // The send engine reads the zone from the `general` settings row, so that row wins when it holds a valid zone.
    const [general] = await db.select({ values: channelSettings.values }).from(channelSettings).where(sql`${channelSettings.organizationId} = ${organizationId} and ${channelSettings.channel} = 'general'`);
    const mirrored = general?.values?.timeZone;
    return { id: org.id, name: org.name, slug: org.slug, timeZone: (VALID_ZONE(mirrored) ? canonicalTimeZone(mirrored) : null) ?? canonicalTimeZone(org.timezone) ?? org.timezone, unknownSenderAiDailyCap: readUnknownSenderAiCap(general?.values?.[UNKNOWN_SENDER_AI_CAP_KEY]), defaultPhoneCountry: normalizePhoneCountry(general?.values?.[DEFAULT_PHONE_COUNTRY_KEY]), createdAt: org.createdAt };
  },

  async update(organizationId, patch, audit, actorUserId) {
    await db.transaction(async (tx) => {
      if (patch.name !== undefined) await tx.update(organizations).set({ name: patch.name }).where(eq(organizations.id, organizationId));
      if (patch.timeZone !== undefined) await tx.update(organizations).set({ timezone: patch.timeZone }).where(eq(organizations.id, organizationId));
      // The send engine and the AI cap read the `general` settings row, so the settings mirror there.
      const values = {
        ...(patch.timeZone === undefined ? {} : { timeZone: patch.timeZone }),
        ...(patch.unknownSenderAiDailyCap === undefined ? {} : { [UNKNOWN_SENDER_AI_CAP_KEY]: patch.unknownSenderAiDailyCap }),
        ...(patch.defaultPhoneCountry === undefined ? {} : { [DEFAULT_PHONE_COUNTRY_KEY]: patch.defaultPhoneCountry }),
      };
      if (Object.keys(values).length > 0) {
        await tx
          .insert(channelSettings)
          .values({ organizationId, channel: "general", values, updatedBy: actorUserId })
          .onConflictDoUpdate({
            target: [channelSettings.organizationId, channelSettings.channel],
            set: { values: sql`${channelSettings.values} || ${JSON.stringify(values)}::jsonb`, updatedBy: actorUserId, updatedAt: new Date() },
          });
      }
      for (const entry of audit) await recordAudit(tx, entry);
    });
  },
};
