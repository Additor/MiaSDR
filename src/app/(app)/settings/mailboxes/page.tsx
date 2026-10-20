import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { getOrgTimeZone } from "@/components/shell/org-time-zone";
import { Skeleton } from "@/components/ui/skeleton";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { getEmailRules } from "@/contexts/outreach/email/application/email-rules";
import { listMailboxes } from "@/contexts/outreach/email/application/mailbox-management";
import { mailboxDeps, emailRulesDeps } from "@/contexts/outreach/infrastructure/composition";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { toActor } from "@/shared/api";
import { timeZoneOptions } from "../time-zone-options";
import { MailboxList } from "./mailbox-list";

export const metadata: Metadata = { title: "Mailboxes" };

export default function MailboxesPage() {
  return (
    <div className="max-w-3xl">
      <Suspense fallback={<Skeleton className="h-64 w-full max-w-3xl" />}>
        <Mailboxes />
      </Suspense>
    </div>
  );
}

async function Mailboxes() {
  await connection();
  const ctx = await requireOrgContext();
  const actor = toActor(ctx);
  const { policy } = mailboxDeps();
  const [mailboxes, rules, orgTimeZone] = await Promise.all([listMailboxes(mailboxDeps(), actor), getEmailRules(emailRulesDeps(), actor), getOrgTimeZone()]);
  const saved = mailboxes.map((m) => m.workingHours?.timeZone).filter((zone): zone is string => Boolean(zone));
  const zones = timeZoneOptions(Intl.supportedValuesOf("timeZone"), orgTimeZone);
  for (const zone of saved) if (!zones.includes(zone)) zones.push(zone);
  return (
    <MailboxList
      mailboxes={JSON.parse(JSON.stringify(mailboxes))}
      canManage={isOwnerOrAdmin(ctx.role)}
      takeoverAfterHours={rules.takeoverAfterHours}
      allowedDomains={policy.allowedDomains}
      signupBlocked={policy.allowedDomains === null && policy.openSignup}
      zones={zones}
      defaultTimeZone={orgTimeZone}
    />
  );
}
