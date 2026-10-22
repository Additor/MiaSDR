"use client";

import { BarChart3Icon, Building2Icon, ContactRoundIcon, KanbanIcon, ListChecksIcon, SearchIcon, PlusIcon, RocketIcon, MonitorIcon, MoonIcon, SunIcon, ChevronsUpDownIcon, InboxIcon, LogOutIcon, SendIcon, SettingsIcon, Table2Icon, UserRoundIcon, UsersIcon, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { SETTINGS_GROUPS } from "@/app/(app)/settings/settings-nav-config";
import { CommandPalette, type PaletteDestination } from "./command-palette";
import { authClient } from "@/contexts/identity/infrastructure/auth-client";

type NavGroup = "Work" | "CRM" | "Insight" | "Admin";

interface NavItem {
  href: string;
  label: string;
  group: NavGroup;
  icon: LucideIcon;
  /** Other path prefixes that belong to this row, such as a deal page under Pipeline. */
  also?: string[];
}

/** Sidebar rows. A row is a place you go to; what a page shows about itself (views, filters) stays in the page. */
const NAV: NavItem[] = [
  { href: "/inbox", label: "Inbox", group: "Work", icon: InboxIcon },
  { href: "/actions", label: "Actions", group: "Work", icon: ListChecksIcon },
  { href: "/leads", label: "Leads", group: "Work", icon: UsersIcon },
  { href: "/campaigns", label: "Campaigns", group: "Work", icon: SendIcon },
  { href: "/crm/pipeline", label: "Pipeline", group: "CRM", icon: KanbanIcon, also: ["/crm/deals"] },
  { href: "/crm/contacts", label: "Contacts", group: "CRM", icon: ContactRoundIcon },
  { href: "/crm/companies", label: "Companies", group: "CRM", icon: Building2Icon },
  { href: "/tables", label: "Tables", group: "Insight", icon: Table2Icon },
  { href: "/analytics", label: "Analytics", group: "Insight", icon: BarChart3Icon },
  { href: "/settings", label: "Settings", group: "Admin", icon: SettingsIcon },
];

/** Daily work first, then the deals that came out of it, then the data behind it, then configuration. */
const GROUPS: NavGroup[] = ["Work", "CRM", "Insight", "Admin"];

/** Counts that wait for a person, by row. */
const COUNTED: Record<string, { unit: string; testId: string }> = {
  "/inbox": { unit: "unread", testId: "inbox-unread" },
  "/actions": { unit: "pending", testId: "actions-pending" },
};

/** Rows are 32px on a desktop pointer and 44px in the phone sheet. */
const TOUCH = "max-md:h-11";

/** A count that waits for a person: plain text in the brand hue, so it reads before the label does. */
const BADGE = "min-w-0 justify-end px-0 font-semibold text-sidebar-count peer-hover/menu-button:text-sidebar-count peer-data-active/menu-button:text-sidebar-count";

const SETUP_GUIDE = { href: "/onboarding", label: "Setup guide" } as const;

/** First letters of the first and last word: "Ada Lovelace" is AL, "Ada" is A. */
const initials = (name: string) => {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0], words[words.length - 1]] : words.slice(0, 1);
  return letters.map((w) => Array.from(w)[0]).join("").toUpperCase();
};

const within = (pathname: string, href: string) => pathname === href || pathname.startsWith(`${href}/`);
const rowOf = (pathname: string) => NAV.find((item) => [item.href, ...(item.also ?? [])].some((prefix) => within(pathname, prefix)));

/** Required setup steps done out of the total. Null once the guide is complete or dismissed. */
export interface SetupProgress {
  done: number;
  total: number;
}

export interface ShellUser {
  name: string;
  email: string;
  image: string | null;
}

export interface ShellOrganization {
  id: string;
  name: string;
  active: boolean;
}

/**
 * The list page of each sidebar row, where an organization switch lands: a detail page of the old organization does not
 * exist in the new one. A deal page lands on Pipeline. Anything else (such as /organizations/new) lands on /leads.
 */
const listPageOf = (pathname: string) => rowOf(pathname)?.href ?? "/leads";

interface AppSidebarProps {
  organizationName: string;
  organizations?: ShellOrganization[];
  canCreateOrganization?: boolean;
  user: ShellUser;
  inboxUnread?: number;
  /** Size of the Actions queue. */
  actionsPending?: number;
  setup?: SetupProgress | null;
  /** Owners and admins also reach the operations pages in the palette. */
  isAdmin?: boolean;
}

export function AppSidebar({ organizationName, organizations = [], canCreateOrganization = false, user, inboxUnread = 0, actionsPending = 0, setup = null, isAdmin = false }: AppSidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { theme = "system", setTheme } = useTheme();
  const { setOpenMobile } = useSidebar();

  const [paletteOpen, setPaletteOpen] = useState(false);
  const destinations = useMemo<PaletteDestination[]>(
    () => [
      ...NAV.map((item) => ({ href: item.href, label: item.label, group: item.group === "CRM" ? "CRM" : "Go to" })),
      { ...SETUP_GUIDE, group: "Go to" },
      { href: "/leads/import", label: "Import leads", group: "Do" },
      { href: "/settings/mailboxes", label: "Connect a mailbox", group: "Do" },
      ...(isAdmin ? [{ href: "/settings/members", label: "Invite a member", group: "Do" }] : []),
      ...SETTINGS_GROUPS.flatMap((g) => g.items.filter((i) => isAdmin || !i.adminOnly).map((i) => ({ href: i.href, label: i.title, group: "Settings" }))),
    ],
    [isAdmin],
  );
  const [switchError, setSwitchError] = useState<string | null>(null);
  const activeId = organizations.find((o) => o.active)?.id;

  async function switchTo(organizationId: string) {
    if (organizationId === activeId) return;
    setSwitchError(null);
    const response = await fetch("/api/organizations/active", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId }),
    });
    if (!response.ok) {
      const detail = await response.json().then((body: { error?: unknown }) => (typeof body.error === "string" ? body.error : null)).catch(() => null);
      setSwitchError(detail ? `Could not switch organization: ${detail}` : "Could not switch organization. Try again.");
      return;
    }
    router.push(listPageOf(pathname));
    router.refresh();
  }

  async function signOut() {
    const { error } = await authClient.signOut();
    if (error) {
      toast.error("Could not sign out. Try again.");
      return;
    }
    router.push("/sign-in");
    router.refresh();
  }

  const activeRow = rowOf(pathname);
  const renderItem = ({ href, label, icon: Icon }: NavItem) => {
    const active = activeRow?.href === href;
    const counted = COUNTED[href];
    const count = href === "/inbox" ? inboxUnread : href === "/actions" ? actionsPending : 0;
    const tooltip = counted && count > 0 ? `${label}, ${count} ${counted.unit}` : label;
    return (
      <SidebarMenuItem key={href}>
        <SidebarMenuButton
          isActive={active}
          tooltip={tooltip}
          className={cn(TOUCH, count > 0 && "pr-8")}
          aria-current={active ? "page" : undefined}
          onClick={() => setOpenMobile(false)}
          render={<Link href={href} />}
        >
          <Icon />
          <span>{label}</span>
        </SidebarMenuButton>
        {counted && count > 0 && (
          <SidebarMenuBadge data-testid={counted.testId} className={BADGE}>
            {count > 99 ? "99+" : count}
            <span className="sr-only"> {counted.unit}</span>
          </SidebarMenuBadge>
        )}
        {/* The icon rail has no room for a count, so a dot says something waits and the tooltip says how many. */}
        {counted && count > 0 && (
          <span aria-hidden data-testid={`${href.slice(1)}-dot`} className="pointer-events-none absolute top-1 right-1 hidden size-2 rounded-full bg-sidebar-primary ring-1 ring-sidebar-primary-foreground/60 group-data-[collapsible=icon]:block" />
        )}
      </SidebarMenuItem>
    );
  };

  return (
    <>
    <CommandPalette destinations={destinations} open={paletteOpen} onOpenChange={setPaletteOpen} />
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            {organizations.length > 1 || canCreateOrganization ? (
              <DropdownMenu>
                <DropdownMenuTrigger render={<SidebarMenuButton size="lg" data-testid="org-switcher" />}>
                  <div className="grid flex-1 text-left leading-tight">
                    <span className="text-sm font-semibold">MiaSDR</span>
                    <span className="truncate text-xs text-muted-foreground">{organizationName}</span>
                  </div>
                  <ChevronsUpDownIcon className="ml-auto size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent side="bottom" align="start" className="min-w-56">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Organizations</DropdownMenuLabel>
                    <DropdownMenuRadioGroup value={activeId ?? ""} onValueChange={(id) => void switchTo(id)}>
                      {organizations.map((o) => (
                        <DropdownMenuRadioItem key={o.id} value={o.id} data-testid="org-option">
                          <span className="truncate">{o.name}</span>
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuGroup>
                  {canCreateOrganization && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem nativeButton={false} render={<Link href="/organizations/new" />}>
                        <PlusIcon />
                        New organization
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <div className="px-2 py-1.5">
                <p className="text-sm font-semibold leading-tight">MiaSDR</p>
                <p className="truncate text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">{organizationName}</p>
              </div>
            )}
          </SidebarMenuItem>
        </SidebarMenu>
        {/* The menu closes on selection, so the error sits outside it. */}
        {switchError && (
          <p role="alert" className="px-2 text-xs text-destructive group-data-[collapsible=icon]:hidden">
            {switchError}
          </p>
        )}
      </SidebarHeader>
      <SidebarContent role="navigation" aria-label="Main">
        <SidebarGroup className="pb-0">
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton tooltip="Go to a page" variant="outline" className={TOUCH} onClick={() => setPaletteOpen(true)}>
                  <SearchIcon />
                  <span>Go to a page</span>
                  <kbd className="ml-auto text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">⌘K</kbd>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        {GROUPS.map((group) => (
          <SidebarGroup key={group} className={group === "Admin" ? "mt-auto" : undefined}>
            <SidebarGroupLabel>{group}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {NAV.filter((item) => item.group === group).map((item) => renderItem(item))}
                {group === "Admin" && (
              <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={within(pathname, SETUP_GUIDE.href)}
                    aria-current={within(pathname, SETUP_GUIDE.href) ? "page" : undefined}
                    tooltip={setup ? `${SETUP_GUIDE.label}, ${setup.done} of ${setup.total} done` : SETUP_GUIDE.label}
                    onClick={() => setOpenMobile(false)}
                    render={<Link href={SETUP_GUIDE.href} />}
                    className={cn(TOUCH, setup && "pr-12")}
                  >
                    <RocketIcon />
                    <span>{SETUP_GUIDE.label}</span>
                  </SidebarMenuButton>
                  {/* Open setup waits on an admin, so it takes the same lavender count and rail dot as Inbox and Actions. */}
                  {setup && (
                    <SidebarMenuBadge data-testid="setup-progress" className={BADGE}>
                      {setup.done} of {setup.total}
                      <span className="sr-only"> required steps done</span>
                    </SidebarMenuBadge>
                  )}
                  {setup && (
                    <span aria-hidden data-testid="onboarding-dot" className="pointer-events-none absolute top-1 right-1 hidden size-2 rounded-full bg-sidebar-primary ring-1 ring-sidebar-primary-foreground/60 group-data-[collapsible=icon]:block" />
                  )}
                </SidebarMenuItem>
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger render={<SidebarMenuButton size="lg" />}>
                <Avatar className="size-8">
                  {user.image && <AvatarImage src={user.image} alt="" />}
                  <AvatarFallback>{initials(user.name || user.email)}</AvatarFallback>
                </Avatar>
                <div className="grid flex-1 text-left leading-tight">
                  <span className="truncate text-sm font-medium">{user.name}</span>
                  <span className="truncate text-xs text-muted-foreground">{user.email}</span>
                </div>
                <ChevronsUpDownIcon className="ml-auto size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="min-w-56">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Theme</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
                    <DropdownMenuRadioItem value="light">
                      <SunIcon />
                      Light
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="dark">
                      <MoonIcon />
                      Dark
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="system">
                      <MonitorIcon />
                      System
                    </DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem render={<Link href="/settings/account" />}>
                  <UserRoundIcon />
                  Your account
                </DropdownMenuItem>
                <DropdownMenuItem onClick={signOut}>
                  <LogOutIcon />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
    </>
  );
}
