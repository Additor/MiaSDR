import { z } from "zod";
import { addSuppressions, listSuppressions } from "@/contexts/outreach/application/suppression-list";
import { suppressions } from "@/composition/inbox-filing";
import { withActor, withAdmin } from "@/app/_lib/api";

const query = z.object({
  q: z.string().max(320).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

export const GET = (request: Request) => withActor((actor) => listSuppressions(suppressions(), actor, query.parse(Object.fromEntries(new URL(request.url).searchParams))));

/** `{ text, note? }`: addresses separated by commas, spaces or line breaks, up to 500. */
export const POST = (request: Request) =>
  withAdmin("Only an owner or admin can change the suppression list.", async (actor) =>
    addSuppressions(suppressions(), actor, z.object({ text: z.string().max(100_000), note: z.string().max(500).nullable().optional() }).parse(await request.json())),
  );
