import { and, eq, sql } from "drizzle-orm";
import { db, type DbHandle } from "@/platform/db/client";
import { entityColumns } from "@/contexts/people/infrastructure/schema";
import type { RunningFieldUse } from "@/contexts/people/application/custom-columns";
import { stepsLoseField } from "../domain/variables";
import { campaigns } from "./schema";
import type { MergeFieldSource } from "../application/merge-fields";

const SOURCE_SAMPLE = 250;
const SOURCE_KEY_LIMIT = 100;

export const drizzleMergeFieldSource: MergeFieldSource = {
  async customColumns(organizationId) {
    return db
      .select({ key: entityColumns.key, name: entityColumns.name })
      .from(entityColumns)
      .where(and(eq(entityColumns.organizationId, organizationId), eq(entityColumns.entity, "people"), sql`${entityColumns.archivedAt} is null`));
  },

  async sourceKeys(organizationId) {
    const rows = await db.execute<{ key: string }>(sql`
      select distinct k as key from (
        select jsonb_object_keys(raw) as k from (
          select raw from people where organization_id = ${organizationId} and raw is not null order by created_at desc limit ${SOURCE_SAMPLE}
        ) p
        union all
        select jsonb_object_keys(raw) from (
          select raw from companies where organization_id = ${organizationId} and raw is not null order by created_at desc limit ${SOURCE_SAMPLE}
        ) c
      ) keys
      order by key
      limit ${SOURCE_KEY_LIMIT}`);
    return [...rows].map((r) => r.key);
  },

  async fieldNames(organizationId, tx?: DbHandle) {
    const rows = await (tx ?? db).execute<{ name: string }>(sql`
      select name from entity_columns where organization_id = ${organizationId} and entity = 'people'
      union select jsonb_object_keys(raw) from people where organization_id = ${organizationId} and jsonb_typeof(raw) = 'object'
      union select jsonb_object_keys(custom) from people where organization_id = ${organizationId} and jsonb_typeof(custom) = 'object'
      union select jsonb_object_keys(raw) from companies where organization_id = ${organizationId} and jsonb_typeof(raw) = 'object'
      union select jsonb_object_keys(merge_fields) from campaign_enrollments where organization_id = ${organizationId} and merge_fields <> '{}'::jsonb`);
    return [...rows].map((r) => r.name);
  },
};

export const drizzleRunningFieldUse: RunningFieldUse = {
  async runningCampaignsLosing(organizationId, name, renamedTo) {
    const rows = await db.select({ name: campaigns.name, steps: campaigns.steps }).from(campaigns).where(and(eq(campaigns.organizationId, organizationId), eq(campaigns.status, "active")));
    return rows.filter((row) => stepsLoseField(row.steps as Parameters<typeof stepsLoseField>[0], name, renamedTo)).map((row) => row.name);
  },
};
