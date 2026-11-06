"use client";

import { PlusIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/components/ui/utils";

export interface ChatListRow {
  id: string;
  title: string | null;
}

/** The person's own chats, newest first. Nobody else's chats are listed, an admin's included. */
export function ChatList({ threads, className }: { threads: ChatListRow[]; className?: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Chats" className={cn("grid content-start gap-1", className)}>
      <Link href="/mia" className={cn(buttonVariants({ variant: "outline", size: "sm" }), "mb-2 justify-start")}>
        <PlusIcon />
        New chat
      </Link>
      {threads.length === 0 && <p className="px-2 text-sm text-muted-foreground">No chats yet.</p>}
      {threads.map((t) => {
        const href = `/mia/${t.id}`;
        const current = pathname === href;
        return (
          <Link
            key={t.id}
            href={href}
            aria-current={current ? "page" : undefined}
            className={cn("truncate rounded-md px-2 py-1.5 text-sm hover:bg-muted focus-ring max-md:py-3", current && "bg-muted font-medium")}
          >
            {t.title ?? "Chat"}
          </Link>
        );
      })}
    </nav>
  );
}
