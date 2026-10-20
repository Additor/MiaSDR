"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { listKeyAction, moveActive } from "./list-nav";

const ROW = "[data-list-row]";

/**
 * Keyboard for a list of rows: j and k move the focus row, Enter opens it. Rows are server-rendered elements with
 * `data-list-row={id}` and `data-href` (the Inbox's `<tr>`, the Actions queue's `<li>`); this component only sets
 * `data-active` on one of them (the row styles itself from that attribute) and navigates on Enter. All rows on the page
 * form one list in document order, so the Actions groups read as one queue. It renders nothing.
 */
export function ListKeys() {
  const router = useRouter();
  const activeId = useRef<string | null>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      const action = listKeyAction(event, target);
      if (!action) return;
      // A dialog or menu owns the keyboard while it is open.
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return;
      const rows = Array.from(document.querySelectorAll<HTMLElement>(ROW));
      const current = rows.findIndex((row) => row.dataset.listRow === activeId.current);
      if (action === "open") {
        const href = current >= 0 ? rows[current].dataset.href : undefined;
        if (!href) return;
        event.preventDefault();
        router.push(href);
        return;
      }
      if (rows.length === 0) return;
      event.preventDefault();
      const next = rows[moveActive(current, rows.length, action)];
      for (const row of rows) row.removeAttribute("data-active");
      next.setAttribute("data-active", "true");
      activeId.current = next.dataset.listRow ?? null;
      next.scrollIntoView({ block: "nearest" });
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [router]);

  return null;
}
