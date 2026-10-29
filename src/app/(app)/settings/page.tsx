import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { getOnboarding } from "@/contexts/tenancy/application/onboarding";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { onboardingDeps } from "@/composition/onboarding";
import { toActor } from "@/app/_lib/api";
import type { Actor } from "@/shared/errors";
import { loadSettingsAttention, type AttentionMap } from "./settings-attention";
import { visibleGroups } from "./settings-nav-config";
import { openSetupLinks, type SetupLink } from "./settings-setup";

export const metadata: Metadata = { title: "Settings" };

export default function SettingsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full max-w-3xl" />}>
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
        {flagged === 0 ? "Nothing needs attention." : `${flagged} ${flagged === 1 ? "area needs" : "areas need"} attention.`}
      </p>
      {visibleGroups(isAdmin).map((group) => (
        <section key={group.label} aria-labelledby={`settings-${group.label}`} className="grid gap-1">
          <h2 id={`settings-${group.label}`} className="px-3 text-base font-semibold">
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
    <section aria-labelledby="settings-setup" className="grid gap-1">
      <div className="flex items-baseline justify-between gap-4 px-3">
        <h2 id="settings-setup" className="text-base font-semibold">
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
        {attention && <span className="shrink-0 text-sm font-semibold text-sidebar-count tabular-nums">{attention.label}</span>}
      </Link>
    </li>
  );
}
