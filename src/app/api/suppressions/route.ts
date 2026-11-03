import { z } from "zod";
import { addSuppressions } from "@/contexts/outreach/application/suppression-list";
import { suppressions } from "@/composition/inbox-filing";
import { withAdmin } from "@/app/_lib/api";

/** `{ text, note? }`: addresses separated by commas, spaces or line breaks, up to 500. */
export const POST = (request: Request) =>
  withAdmin("Only an owner or admin can change the suppression list.", async (actor) =>
    addSuppressions(suppressions(), actor, z.object({ text: z.string().max(100_000), note: z.string().max(500).nullable().optional() }).parse(await request.json())),
  );
