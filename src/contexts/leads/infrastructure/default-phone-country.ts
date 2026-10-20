import { and, eq } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { channelSettings } from "@/platform/db/schema";
import { DEFAULT_PHONE_COUNTRY_KEY, resolvePhoneCountry } from "@/contexts/tenancy/domain/phone-country";

/**
 * The organization's `defaultPhoneCountry` from its `general` channel settings, else the DEFAULT_PHONE_COUNTRY
 * environment variable, else undefined (a number without a country code is then not valid).
 * The variable is read at call time and validated by the env schema (two letters, any case).
 */
export async function defaultPhoneCountry(organizationId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ values: channelSettings.values })
    .from(channelSettings)
    .where(and(eq(channelSettings.organizationId, organizationId), eq(channelSettings.channel, "general")));
  return resolvePhoneCountry(row?.values?.[DEFAULT_PHONE_COUNTRY_KEY], process.env.DEFAULT_PHONE_COUNTRY) ?? undefined;
}
