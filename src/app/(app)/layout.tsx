import { cookies } from "next/headers";
import { connection } from "next/server";
import { Suspense } from "react";
import { AppSidebar } from "@/components/shell/app-sidebar";
import { getOrgTimeZone } from "@/components/shell/org-time-zone";
import { OutboundPauseBanner } from "@/components/shell/outbound-pause-banner";
import { OrgTimeZoneProvider } from "@/components/shell/time";
import { Skeleton } from "@/components/ui/skeleton";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { getWorkQueueCounts } from "@/contexts/conversations/actions/application/work-queue";
import { unreadCounts } from "@/contexts/conversations/application/unread-count";
import { workQueueDeps } from "@/contexts/conversations/actions/infrastructure/work-queue-composition";
import { unreadStore } from "@/contexts/conversations/infrastructure/composition";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { listMyOrganizations } from "@/contexts/tenancy/application/organization-switching";
import { getOnboarding } from "@/contexts/tenancy/application/onboarding";
import { onboardingDeps } from "@/contexts/tenancy/infrastructure/onboarding-composition";
import { getOutboundPauseBanner } from "@/contexts/outreach/application/outbound-pause";
import { switchingDeps } from "@/contexts/tenancy/infrastructure/organization-composition";
import { toActor } from "@/shared/api";

export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <Suspense fallback={<Skeleton className="m-4 h-[calc(100svh-2rem)] flex-1" />}>
      <Shell>{children}</Shell>
    </Suspense>
  );
}

/** Validates the session on every request; the static shell above stays prerendered. */
async function Shell({ children }: { children: React.ReactNode }) {
  await connection();
  const { user, organization, role } = await requireOrgContext();
  // The sidebar writes this cookie when it collapses; reading it here keeps the choice across full page loads.
  const defaultOpen = (await cookies()).get("sidebar_state")?.value !== "false";
  const scope = { userId: user.id, organizationId: organization.id, role };
  // Five independent reads: run them together so the shell adds the slowest one, not the sum.
  const [{ total: inboxUnread }, { work }, { organizations, canCreate }, setup, timeZone] = await Promise.all([
    unreadCounts(unreadStore, scope),
    getWorkQueueCounts(workQueueDeps(), scope),
    listMyOrganizations(switchingDeps(), { userId: user.id, activeOrganizationId: organization.id }),
    setupProgress(toActor({ user, organization, role })),
    getOrgTimeZone(),
  ]);
  return (
    <SidebarProvider defaultOpen={defaultOpen}>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:shadow-md focus:ring-2 focus:ring-ring"
      >
        Skip to content
      </a>
      <AppSidebar organizationName={organization.name} organizations={organizations} canCreateOrganization={canCreate} user={user} inboxUnread={inboxUnread} actionsPending={work.mine} setup={setup} isAdmin={isOwnerOrAdmin(role)} />
      <SidebarInset id="main-content" tabIndex={-1} className="outline-none">
        <OutboundPauseBanner banner={getOutboundPauseBanner()} />
        <OrgTimeZoneProvider timeZone={timeZone}>{children}</OrgTimeZoneProvider>
      </SidebarInset>
    </SidebarProvider>
  );
}

/**
 * The sidebar highlights the setup guide until required steps are done or an admin dismisses it. Only people who can
 * act on it (owner, admin) see the highlight. A read failure just drops it.
 */
async function setupProgress(actor: Parameters<typeof getOnboarding>[1]) {
  try {
    const view = await getOnboarding(onboardingDeps(), actor);
    return view.complete || view.dismissed || !view.canDismiss ? null : { done: view.requiredDone, total: view.requiredTotal };
  } catch {
    return null;
  }
}
