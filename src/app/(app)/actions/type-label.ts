import { groupLabel } from "@/contexts/conversations/domain/reply-handling";

/**
 * Names of reply types that more than one group uses, lowercased. A row names its type alone ("Meeting requested"), and adds
 * the group only for these, as "{type} · {group}" like the thread's type line.
 */
export function ambiguousTypeNames(types: ReadonlyArray<{ name: string; groupKey: string }>): Set<string> {
  const groupsOf = new Map<string, Set<string>>();
  for (const t of types) {
    const name = t.name.trim().toLowerCase();
    groupsOf.set(name, (groupsOf.get(name) ?? new Set()).add(t.groupKey));
  }
  return new Set([...groupsOf].filter(([, groups]) => groups.size > 1).map(([name]) => name));
}

/** A type as a row names it: the type, the group too when the name is ambiguous, the group alone without a type. */
export function typeLabel(name: string | null, groupKey: string | null, ambiguous: ReadonlySet<string>): string | null {
  if (!name) return groupKey ? groupLabel(groupKey) : null;
  return groupKey && ambiguous.has(name.trim().toLowerCase()) ? `${name} · ${groupLabel(groupKey)}` : name;
}
