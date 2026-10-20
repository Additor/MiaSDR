"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { RowLink } from "@/components/shell/row-link";
import { dealHref } from "./deal-href";

/** The row link of `DealsList`. It carries the page it sits on (a contact or a company page) as the deal page's `from`. */
export function DealRowLink({ dealId, children }: { dealId: string; children: ReactNode }) {
  const pathname = usePathname();
  return <RowLink href={dealHref(dealId, pathname)}>{children}</RowLink>;
}
