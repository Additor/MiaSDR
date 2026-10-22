import { connection } from "next/server";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { toActor } from "@/app/_lib/api";
import { loadSettingsAttention } from "./settings-attention";
import { visibleGroups } from "./settings-nav-config";
import { SettingsNavList } from "./settings-nav-list";

/** Reads the role at request time so members never see links to pages that refuse them, and marks areas that need attention. */
export async function SettingsNav() {
  await connection();
  const ctx = await requireOrgContext();
  const isAdmin = isOwnerOrAdmin(ctx.role);
  const attention = await loadSettingsAttention(toActor(ctx), isAdmin);
  return <SettingsNavList groups={visibleGroups(isAdmin)} attention={attention} />;
}

/** Shell fallback while the role loads: the pages every role can open. */
export function SettingsNavFallback() {
  return <SettingsNavList groups={visibleGroups(false)} />;
}
