import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { getEmailRules } from "@/contexts/outreach/email/application/email-rules";
import { emailRulesDeps } from "@/contexts/outreach/infrastructure/composition";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { toActor } from "@/shared/api";
import { EmailRulesForm } from "./email-rules-form";

export const metadata: Metadata = { title: "Email rules" };

export default function EmailRulesPage() {
  return (
    <div className="max-w-3xl">
      <Suspense fallback={<Skeleton className="h-64 w-full max-w-3xl" />}>
        <EmailRules />
      </Suspense>
    </div>
  );
}

async function EmailRules() {
  await connection();
  const ctx = await requireOrgContext();
  const rules = await getEmailRules(emailRulesDeps(), toActor(ctx));
  return <EmailRulesForm rules={rules} canEdit={isOwnerOrAdmin(ctx.role)} />;
}
