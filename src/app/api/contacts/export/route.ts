import { z } from "zod";
import { organizationTimeZone } from "@/composition/person-lifecycle";
import { exportContactsCsv } from "@/contexts/deals/application/deals";
import { dealsDeps } from "@/contexts/deals/infrastructure/deals-composition";
import { MAX_MATCHING_IDS } from "@/contexts/leads/domain/lead-filter";
import { withActor } from "@/shared/api";
import { PayloadTooLargeError, type Actor } from "@/shared/errors";

/*
 * The Contacts CSV: UTF-8 with BOM, formula-safe cells, batches of 1,000 rows, dates in the organization's
 * time zone. The first chunk is read before the response starts, so a bad filter answers 422 as JSON and not a broken file.
 */

type Scope = Parameters<typeof exportContactsCsv>[2];

async function csv(actor: Actor, scope: Scope): Promise<Response> {
  const chunks = exportContactsCsv(dealsDeps(), actor, scope, await organizationTimeZone(actor.organizationId));
  const first = await chunks.next();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (first.done) controller.close();
      else controller.enqueue(encoder.encode(first.value));
    },
    async pull(controller) {
      try {
        const next = await chunks.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await chunks.return(undefined);
    },
  });
  const date = new Date().toISOString().slice(0, 10);
  return new Response(first.done ? null : stream, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="contacts-${date}.csv"`,
      "cache-control": "no-store",
    },
  });
}

/** Runs the export under `withActor`, which answers 401 and the application errors as JSON. */
async function exported(build: (actor: Actor) => Promise<Scope>): Promise<Response> {
  let file: Response | null = null;
  const answer = await withActor(async (actor) => {
    file = await csv(actor, await build(actor));
    return undefined;
  });
  return file ?? answer;
}

/** The contacts that match the list filter (`q`, `owner`, `stage`), as Export CSV on the Contacts list. */
export function GET(request: Request) {
  return exported(async () => {
    const { q, owner, stage } = Object.fromEntries(new URL(request.url).searchParams);
    return { filter: { q, owner, stage } };
  });
}

const idsSchema = z.object({ ids: z.array(z.string().max(64)).min(1).max(50_000) });

/** Export selected: up to 5,000 contact ids. 413 above that. Ids of leads or of another organization export nothing. */
export function POST(request: Request) {
  return exported(async () => {
    const { ids } = idsSchema.parse(await request.json());
    if (ids.length > MAX_MATCHING_IDS) throw new PayloadTooLargeError(`Export up to ${MAX_MATCHING_IDS.toLocaleString("en-US")} contacts at a time.`);
    return { ids };
  });
}
