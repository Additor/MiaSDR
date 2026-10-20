"use client";

import { usePathname } from "next/navigation";
import { PageHeader } from "@/components/shell/page-header";
import { findSettingsItem } from "./settings-nav-config";

/** One header for every settings page, so a page cannot repeat its own title in a card. Pages link back to the overview. */
export function SettingsHeader() {
  const item = findSettingsItem(usePathname());
  return item ? <PageHeader title={item.title} back={{ href: "/settings", label: "Settings" }} /> : <PageHeader title="Settings" />;
}
