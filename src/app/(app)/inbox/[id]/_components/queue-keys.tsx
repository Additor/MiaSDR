"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { isTypingTarget } from "@/components/shell/list-nav";

/**
 * The key `]` opens the next item of the queue the thread was opened from. It leaves a letter typed into a field alone, and
 * stays out of the way while a dialog or a menu owns the keyboard. It renders nothing; the link beside it is the visible control.
 */
export function QueueKeys({ href }: { href: string }) {
  const router = useRouter();
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.key !== "]" || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (isTypingTarget(target)) return;
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return;
      event.preventDefault();
      router.push(href);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [href, router]);
  return null;
}
