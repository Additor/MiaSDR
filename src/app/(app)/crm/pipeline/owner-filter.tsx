"use client";

import { useRouter } from "next/navigation";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { boardHref, type BoardUrlState } from "./board-url";

const ANYONE = "any";

/** The Owner filter of the board. Picking an owner rewrites the URL; search and Show all stay. */
export function OwnerFilter({ state, members, currentUserId }: { state: BoardUrlState; members: Array<{ userId: string; name: string }>; currentUserId: string }) {
  const router = useRouter();
  const items = [
    { value: ANYONE, label: "Any owner" },
    { value: "me", label: "Me" },
    ...members.filter((m) => m.userId !== currentUserId).map((m) => ({ value: m.userId, label: m.name })),
    { value: "none", label: "No owner" },
  ];
  const value = state.owner === currentUserId ? "me" : (state.owner ?? ANYONE);
  return (
    <Select items={items} value={value} onValueChange={(v) => v && router.push(boardHref({ ...state, owner: v === ANYONE ? undefined : v }))}>
      <SelectTrigger aria-label="Owner" className="w-40">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((i) => (
          <SelectItem key={i.value} value={i.value}>
            {i.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
