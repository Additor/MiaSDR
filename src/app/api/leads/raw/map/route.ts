import { z } from "zod";
import { mapRawField } from "@/contexts/people/application/lead-management";
import { leadDeps } from "@/composition/leads";
import { withActor } from "@/app/_lib/api";

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
