import { eq, sql } from "drizzle-orm";
import { db, type DbHandle } from "@/platform/db/client";
import { canonicalTimeZone } from "@/shared/time-zone";
import { channelSettings, organizations } from "@/platform/db/schema";
import { readUnknownSenderAiCap, UNKNOWN_SENDER_AI_CAP_KEY } from "../domain/ai-cap";
import { DEFAULT_PHONE_COUNTRY_KEY, normalizePhoneCountry } from "../domain/phone-country";
import { recordAudit } from "@/contexts/tenancy/infrastructure/audit";
import { isValidTimeZone } from "@/shared/time-zone";
import type { OrganizationStore } from "../application/organization-settings";
import { mergeChannelSettings } from "./channel-settings";

const VALID_ZONE = (zone: unknown): zone is string => typeof zone === "string" && isValidTimeZone(zone);

/**
 * The organization's zone by the one rule every reader follows: a valid zone in the `general` settings row wins (the
 * send engine has always read it there), then a valid `organizations.timezone`, then UTC. Canonical IANA name.
 */
export function organizationZoneOf(general: unknown, column: unknown): string {
  return (VALID_ZONE(general) ? canonicalTimeZone(general) : null) ?? (VALID_ZONE(column) ? canonicalTimeZone(column) : null) ?? "UTC";
}

/** The organization's zone in one query on `handle`, so a transaction can read it too. "UTC" when the organization is gone. */
export async function organizationTimeZone(organizationId: string, handle: Pick<DbHandle, "execute"> = db): Promise<string> {
  const rows = (await handle.execute(sql`
    select o.timezone as "column", s."values" ->> 'timeZone' as general
    from organizations o
    left join channel_settings s on s.organization_id = o.id and s.channel = 'general'
    where o.id = ${organizationId}`)) as unknown as Array<{ column: string | null; general: string | null }>;
  return organizationZoneOf(rows[0]?.general, rows[0]?.column);
}

/** Every organization with its zone by the same rule, in id order. The daily rollover reads it for each local day. */
export async function organizationTimeZones(): Promise<Array<{ organizationId: string; timeZone: string }>> {
  const rows = (await db.execute(sql`
    select o.id, o.timezone as "column", s."values" ->> 'timeZone' as general
    from organizations o
    left join channel_settings s on s.organization_id = o.id and s.channel = 'general'
    order by o.id`)) as unknown as Array<{ id: string; column: string | null; general: string | null }>;
  return rows.map((r) => ({ organizationId: r.id, timeZone: organizationZoneOf(r.general, r.column) }));
}

export const drizzleOrganizationStore: OrganizationStore = {
  async get(organizationId) {
    const [org] = await db.select().from(organizations).where(eq(organizations.id, organizationId));
    if (!org) return null;
    // The send engine reads the zone from the `general` settings row, so that row wins when it holds a valid zone.
    const [general] = await db.select({ values: channelSettings.values }).from(channelSettings).where(sql`${channelSettings.organizationId} = ${organizationId} and ${channelSettings.channel} = 'general'`);
    const mirrored = general?.values?.timeZone;
    return { id: org.id, name: org.name, slug: org.slug, timeZone: organizationZoneOf(mirrored, org.timezone), unknownSenderAiDailyCap: readUnknownSenderAiCap(general?.values?.[UNKNOWN_SENDER_AI_CAP_KEY]), defaultPhoneCountry: normalizePhoneCountry(general?.values?.[DEFAULT_PHONE_COUNTRY_KEY]), createdAt: org.createdAt };
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
        await mergeChannelSettings(tx, organizationId, "general", values, actorUserId);
      }
      for (const entry of audit) await recordAudit(tx, entry);
    });
  },
};
