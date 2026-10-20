import type { DbHandle } from "@/platform/db/client";
import { normalizeLinkedinSlug } from "../domain/normalize";
import { toFoundCandidates, type FoundCandidate, type FoundPersonInput } from "../domain/found-people";

export interface FoundPersonResult {
  key: string;
  personId: string;
  created: boolean;
}

/** Port. One transaction under the organization's import lock, so a search and a CSV import cannot race on the same profile. */
export interface FoundPeopleStore {
  upsert(input: { organizationId: string; source: string; candidates: FoundCandidate[]; tx?: DbHandle }): Promise<Array<{ slug: string | null; memberId: string | null; personId: string; created: boolean }>>;
}

export interface FoundPeopleReport {
  /** Keyed by the caller's `key`. Inputs that repeat a profile share the first one's person. */
  people: Map<string, { personId: string; created: boolean }>;
  /** Keys with no readable profile slug or member id. */
  skipped: string[];
}

/**
 * Creates leads for people found by a LinkedIn search, or matches the lead with the same profile slug.
 * Idempotent: a second call with the same people changes nothing and returns the same ids.
 */
export async function importFoundPeople(deps: { store: FoundPeopleStore }, input: { organizationId: string; source: string; people: FoundPersonInput[]; tx?: DbHandle }): Promise<FoundPeopleReport> {
  const { candidates, skipped } = toFoundCandidates(input.people);
  const saved = candidates.length === 0 ? [] : await deps.store.upsert({ organizationId: input.organizationId, source: input.source, candidates, tx: input.tx });
  const bySlug = new Map(saved.flatMap((s) => (s.slug ? [[s.slug, s] as const] : [])));
  const byMember = new Map(saved.flatMap((s) => (s.memberId ? [[s.memberId, s] as const] : [])));
  const people = new Map<string, { personId: string; created: boolean }>();
  // Every input maps to the person of its slug, so a duplicate row in one page resolves too.
  for (const row of input.people) {
    const slug = normalizeLinkedinSlug(row.profile);
    const hit = slug ? bySlug.get(slug) : row.memberId ? byMember.get(row.memberId) : undefined;
    if (hit) people.set(row.key, { personId: hit.personId, created: hit.created && candidates.some((c) => c.key === row.key) });
  }
  return { people, skipped };
}
