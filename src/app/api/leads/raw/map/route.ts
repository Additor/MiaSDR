import { z } from "zod";
import { mapRawField } from "@/contexts/leads/application/lead-management";
import { leadDeps } from "@/contexts/leads/infrastructure/composition";
import { withActor } from "@/shared/api";

const schema = z.object({
  rawKey: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  overwrite: z.boolean().optional(),
});

export async function POST(request: Request) {
  return withActor(async (actor) => {
    const input = schema.parse(await request.json());
    return mapRawField(leadDeps(), actor, input);
  });
}
