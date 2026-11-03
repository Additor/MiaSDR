import type { DbHandle } from "@/platform/db/client";
import { retryOnce } from "@/platform/db/errors";
import { ConflictError, NotFoundError, type Actor } from "@/shared/errors";
import { convertToContact, type ConvertDeps } from "./convert-to-contact";

/*
 * Make contact ("Contacts and Companies CRUD" in docs/decisions.md): the conversion without a deal, from the lead page
 * and from Add contact's matching-lead step. It runs `convertToContact` with `reason: "added"`, in one transaction with the conversion's lock timeout and one retry.
 */

export interface MakeContactDeps extends ConvertDeps {
  /** One transaction with `lock_timeout` set to `CONVERSION_LOCK_TIMEOUT`. */
  transaction<T>(fn: (tx: DbHandle) => Promise<T>): Promise<T>;
  now?: () => Date;
}

export interface MakeContactResult {
  personId: string;
  stopped: { enrollments: number; runs: number; drafts: number };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Makes one lead a contact. 404 for a person outside the organization; 409 `already_converted` for a contact; 409
 * `try_again` after the retry.
 */
export async function makeContact(deps: MakeContactDeps, actor: Actor, personId: string): Promise<MakeContactResult> {
  if (!UUID.test(personId)) throw new NotFoundError("Lead not found");
  const organizationId = actor.organizationId;
  return retryOnce(() =>
    deps.transaction(async (tx) => {
      const converted = await convertToContact(deps, tx, {
        organizationId,
        personId,
        reason: "added",
        actorUserId: actor.userId,
        now: deps.now?.(),
      });
      if (!converted.changed) throw new ConflictError("This person is already a contact.", { code: "already_converted", personId });
      return { personId, stopped: converted.stopped };
    }),
  );
}
