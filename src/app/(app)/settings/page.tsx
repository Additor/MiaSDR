import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/shell/page-skeleton";
import { Count } from "@/components/shell/section";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { getOnboarding } from "@/contexts/tenancy/application/onboarding";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { onboardingDeps } from "@/composition/onboarding";
import { toActor } from "@/app/_lib/api";
import type { Actor } from "@/shared/errors";
import { loadSettingsAttention, type AttentionMap } from "./settings-attention";
import { visibleGroups } from "./settings-nav-config";
import { openSetupLinks, type SetupLink } from "./settings-setup";
import { formatCount } from "@/shared/format-number";

export const metadata: Metadata = { title: "Settings" };

export default function SettingsPage() {
  return (
    <Suspense fallback={<PageSkeleton shape="form" />}>
      <Overview />
    </Suspense>
  );
}

async function Overview() {
  await connection();
  const ctx = await requireOrgContext();
  const isAdmin = isOwnerOrAdmin(ctx.role);
  const [attention, setup] = await Promise.all([loadSettingsAttention(toActor(ctx), isAdmin), loadSetupLinks(toActor(ctx))]);
  const flagged = Object.values(attention).filter(Boolean).length;
  return (
    <div className="stack-section max-w-3xl">
      {setup.length > 0 && <SetupBlock links={setup} />}
      <p role="status" className="text-sm text-muted-foreground">
        {flagged === 0 ? "Nothing needs attention." : `${formatCount(flagged)} ${flagged === 1 ? "area needs" : "areas need"} attention.`}
      </p>
      {visibleGroups(isAdmin).map((group) => (
        <section key={group.label} aria-labelledby={`settings-${group.label}`} className="stack-group">
          <h2 id={`settings-${group.label}`} className="heading-section px-3">
            {group.label}
          </h2>
          <ul className="divide-y rounded-lg border">
            {group.items.map((item) => (
              <Row key={item.href} href={item.href} title={item.title} summary={item.summary} attention={attention[item.href]} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** Required steps still open. Empty once setup is done or an owner dismissed the guide, and when the checklist cannot be read. */
async function loadSetupLinks(actor: Actor): Promise<SetupLink[]> {
  try {
    const view = await getOnboarding(onboardingDeps(), actor);
    return view.dismissed ? [] : openSetupLinks(view.steps);
  } catch {
    return [];
  }
}

function SetupBlock({ links }: { links: SetupLink[] }) {
  return (
    <section aria-labelledby="settings-setup" className="stack-group">
      <div className="flex items-baseline justify-between gap-4 px-3">
        <h2 id="settings-setup" className="heading-section">
          Set up sending
        </h2>
        <Link href="/onboarding" className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-ring">
          Open setup guide
        </Link>
      </div>
      <ol className="divide-y rounded-lg border">
        {links.map((link, index) => (
          <li key={link.id}>
            <Link href={link.href} className="flex min-h-14 items-center gap-3 px-3 py-3 first:rounded-t-lg last:rounded-b-lg hover:bg-muted/50 focus-ring">
              <span aria-hidden className="w-4 shrink-0 text-sm text-muted-foreground tabular-nums">
                {index + 1}
              </span>
              <span className="grid gap-0.5">
                <span className="text-sm font-medium">{link.title}</span>
                <span className="text-sm text-muted-foreground">{link.reason}</span>
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Row({ href, title, summary, attention }: { href: string; title: string; summary: string; attention: AttentionMap[string] }) {
  return (
    <li>
      <Link href={href} className="flex min-h-14 items-center justify-between gap-4 px-3 py-3 first:rounded-t-lg last:rounded-b-lg hover:bg-muted/50 focus-ring">
        <span className="grid gap-0.5">
          <span className="text-sm font-medium">{title}</span>
          <span className="text-sm text-muted-foreground">{summary}</span>
        </span>
        {/* Work that waits on an admin: the sidebar's lavender count, plain text with no capsule. */}
        {attention && <Count value={attention.label} tone="waiting" className="shrink-0" />}
      </Link>
    </li>
  );
}
