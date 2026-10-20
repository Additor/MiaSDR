import { ForbiddenError, ValidationError } from "@/shared/errors";
import { organizationNameProblem } from "../domain/organization";
import { slugPrefix, slugify, uniqueSlug, FALLBACK_SLUG } from "../domain/slug";

/** Raised by the store when the slug unique index rejects the insert (two creations raced for one name). */
export class SlugTakenError extends Error {}

export interface OrganizationCreationStore {
  /** Slugs that start with `prefix` (see `slugPrefix`). */
  slugsStartingWith(prefix: string): Promise<string[]>;
  /** One transaction: the organization row and the creator's owner membership. Throws SlugTakenError. */
  createWithOwner(input: { name: string; slug: string; ownerUserId: string }): Promise<{ id: string }>;
}

export interface ActiveOrganizationGateway {
  /** Writes the active organization on the caller's session. */
  set(organizationId: string): Promise<void>;
}

export interface CreateOrganizationDeps {
  store: OrganizationCreationStore;
  active: ActiveOrganizationGateway;
  /** The signup policy: open instances allow anyone, invite-only instances allow owners and admins of the first organization. */
  mayCreate: (userId: string) => Promise<boolean>;
}

export interface CreatedOrganization {
  id: string;
  name: string;
  slug: string;
}

const SLUG_ATTEMPTS = 5;

/** The creator becomes owner and the new organization becomes the active one. */
export async function createOrganization(deps: CreateOrganizationDeps, user: { userId: string }, input: { name: string }): Promise<CreatedOrganization> {
  if (!(await deps.mayCreate(user.userId))) throw new ForbiddenError("This instance does not let you create an organization.");
  const problem = organizationNameProblem(input.name);
  if (problem) throw new ValidationError(problem);
  const name = input.name.trim();

  const base = slugify(name) || FALLBACK_SLUG;
  for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt += 1) {
    const slug = uniqueSlug(name, await deps.store.slugsStartingWith(slugPrefix(base)));
    try {
      const { id } = await deps.store.createWithOwner({ name, slug, ownerUserId: user.userId });
      // The organization exists now. A failed switch must not fail the request: a retry would create a second one.
      // The creator can pick it in the switcher.
      await deps.active.set(id).catch((error: unknown) => console.error("create-organization: could not set the active organization", error));
      return { id, name, slug };
    } catch (error) {
      if (!(error instanceof SlugTakenError)) throw error;
    }
  }
  throw new ValidationError("Could not find a free URL name for this organization. Try a different name.");
}
