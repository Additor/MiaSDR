import { z } from "zod";
import { slugify } from "../domain/slug";
import { canonicalTimeZone } from "../domain/time-zone";

export const setupInputSchema = z.object({
  name: z.string().trim().min(1, "Enter your name.").max(100, "Name is at most 100 characters."),
  email: z.string().trim().toLowerCase().max(254, "Email is at most 254 characters.").email("Enter a valid email address."),
  password: z.string().min(8, "Password needs at least 8 characters.").max(128, "Password is at most 128 characters."),
  organizationName: z.string().trim().min(1, "Enter an organization name.").max(100, "Organization name is at most 100 characters."),
  timeZone: z
    .string()
    .max(64, "Time zone is too long.")
    .transform((zone, ctx) => {
      // An empty value means "no preference", the same as leaving the field out.
      if (zone.trim() === "") return undefined;
      const canonical = canonicalTimeZone(zone);
      if (canonical === null) {
        ctx.addIssue({ code: "custom", message: "Time zone is not a known IANA zone." });
        return z.NEVER;
      }
      return canonical;
    })
    .optional(),
});

export type SetupInput = z.infer<typeof setupInputSchema>;

export class SetupAlreadyDoneError extends Error {
  constructor() {
    super("This instance is already set up.");
  }
}

export interface NewInstance {
  name: string;
  email: string;
  passwordHash: string;
  organizationName: string;
  organizationSlug: string;
  timeZone?: string;
}

/** Port: persists the first admin and organization atomically. */
export interface InstanceSetupStore {
  hasAnyUser(): Promise<boolean>;
  /** Must throw SetupAlreadyDoneError if a user exists once the store holds its lock. */
  createInitialAdmin(instance: NewInstance): Promise<{ userId: string; organizationId: string }>;
}

export interface SetupDeps {
  store: InstanceSetupStore;
  hashPassword(password: string): Promise<string>;
}

export async function needsSetup(deps: Pick<SetupDeps, "store">): Promise<boolean> {
  return !(await deps.store.hasAnyUser());
}

/** First-run: no user exists, so create the admin and their organization in one step. */
export async function setupInstance(deps: SetupDeps, rawInput: unknown) {
  const input = setupInputSchema.parse(rawInput);
  if (await deps.store.hasAnyUser()) throw new SetupAlreadyDoneError();
  return deps.store.createInitialAdmin({
    name: input.name,
    email: input.email,
    passwordHash: await deps.hashPassword(input.password),
    organizationName: input.organizationName,
    organizationSlug: slugify(input.organizationName) || "workspace",
    timeZone: input.timeZone,
  });
}
