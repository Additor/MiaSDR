"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDownIcon } from "lucide-react";
import { useRef, useState } from "react";
import { cn } from "@/components/ui/utils";
import type { AttentionMap } from "./settings-attention";
import type { SettingsGroup } from "./settings-nav-config";

const LINK = "flex min-h-11 items-center rounded-md px-3 text-sm whitespace-nowrap focus-ring md:min-h-9";

function NavLink({
  href,
  title,
  active,
  activeRef,
  attention,
}: {
  href: string;
  title: string;
  active: boolean;
  activeRef: React.RefObject<HTMLAnchorElement | null>;
  attention?: string;
}) {
  return (
    <Link
      href={href}
      ref={active ? activeRef : undefined}
      aria-current={active ? "page" : undefined}
      className={cn(LINK, active ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground")}
    >
      {title}
      {attention && (
        <>
          <span aria-hidden className="ml-2 size-1.5 shrink-0 rounded-full bg-sidebar-primary" />
          <span className="sr-only">, {attention}</span>
        </>
      )}
    </Link>
  );
}

/** Left column on wide screens. On narrow ones a single row names the current page and opens the same list. */
export function SettingsNavList({ groups, attention = {} }: { groups: SettingsGroup[]; attention?: AttentionMap }) {
  const pathname = usePathname();
  const activeRef = useRef<HTMLAnchorElement | null>(null);
  const [openFor, setOpenFor] = useState<string | null>(null);
  const open = openFor === pathname;

  const isActive = (href: string) => (href === "/settings" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`));
  const items = groups.flatMap((g) => g.items);
  const current = items.find((item) => isActive(item.href));
  const flagged = items.filter((item) => attention[item.href]).length;

  return (
    <nav aria-label="Settings" className="border-b md:w-56 md:shrink-0 md:border-r md:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="settings-nav-groups"
        onClick={() => setOpenFor(open ? null : pathname)}
        className="flex min-h-11 w-full items-center justify-between gap-2 px-4 text-sm font-medium focus-ring md:hidden"
      >
        <span className="truncate">{current?.title ?? "Settings"}</span>
        <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
          {flagged > 0 && !open && <span className="text-xs">{flagged} need attention</span>}
          <ChevronDownIcon aria-hidden className={cn("size-4 transition-transform", open && "rotate-180")} />
        </span>
      </button>
      <div id="settings-nav-groups" className={cn("flex-col gap-4 p-2 md:flex md:gap-5 md:p-group transition-[opacity,translate] duration-(--duration-menu) ease-out max-md:starting:opacity-0 max-md:motion-safe:starting:-translate-y-1", open ? "flex" : "hidden")}>
        {groups.map((group) => (
          <div key={group.label} role="group" aria-label={group.label} className="flex flex-col gap-0.5">
            <p className="px-3 pb-1 text-xs font-medium text-muted-foreground">{group.label}</p>
            {group.items.map((item) => (
              <NavLink key={item.href} href={item.href} title={item.title} active={isActive(item.href)} activeRef={activeRef} attention={attention[item.href]?.label} />
            ))}
          </div>
        ))}
      </div>
    </nav>
  );
}
