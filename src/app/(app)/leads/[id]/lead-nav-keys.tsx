"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { isTypingTarget } from "@/components/shell/list-nav";
import { popupOpen } from "@/components/shell/list-keys";

/**
 * `[` opens the previous lead of the list and `]` the next one, as `]` moves through a queue in the Inbox. It leaves a letter
 * typed into a field alone, and stays out of the way while a dialog or a menu owns the keyboard. It renders nothing; the links
 * in the top bar are the visible controls.
 */
export function LeadNavKeys({ prevHref, nextHref }: { prevHref: string | null; nextHref: string | null }) {
  const router = useRouter();
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      const href = event.key === "[" ? prevHref : event.key === "]" ? nextHref : null;
      if (!href) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (isTypingTarget(target)) return;
      if (popupOpen()) return;
      event.preventDefault();
      router.push(href);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [prevHref, nextHref, router]);
  return null;
}
