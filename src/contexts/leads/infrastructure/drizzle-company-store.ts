import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { companies, entityColumns } from "@/platform/db/schema";
import { ValidationError } from "@/shared/errors";
import type { CompanyStore } from "../application/company-management";

export const drizzleCompanyStore: CompanyStore = {
  async update(organizationId, companyId, plan) {
    return db.transaction(async (tx) => {
      // The registry lock first, as for column delete and import, so a value never lands under a deleted field.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"leads-columns:" + organizationId + ":companies"}, 0))`);
      const keys = [...Object.keys(plan.customSet), ...plan.customRemove];
      if (keys.length > 0) {
        const active = await tx
          .select({ key: entityColumns.key })
          .from(entityColumns)
          .where(and(eq(entityColumns.organizationId, organizationId), eq(entityColumns.entity, "companies"), eq(entityColumns.isCore, false), isNull(entityColumns.archivedAt)));
        const known = new Set(active.map((c) => c.key));
        // A removal of a key with no field is fine: it clears a stale value.
        if (Object.keys(plan.customSet).some((key) => !known.has(key))) throw new ValidationError("A company field changed in Settings. Reload and try again.");
      }
      const [current] = await tx
        .select({ custom: companies.custom })
        .from(companies)
        .where(and(eq(companies.organizationId, organizationId), eq(companies.id, companyId)))
        .for("update");
      if (!current) return false;
      const custom = { ...current.custom, ...plan.customSet };
      // Every company write bumps the version, so an open merge or delete preview sees the edit.
      for (const key of plan.customRemove) delete custom[key];
      await tx
        .update(companies)
        .set({ ...plan.patch, custom, version: sql`${companies.version} + 1`, updatedAt: new Date() })
        .where(and(eq(companies.organizationId, organizationId), eq(companies.id, companyId)));
      return true;
    });
  },
};
