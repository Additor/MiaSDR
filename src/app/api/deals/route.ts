import { board, createDealForContact } from "@/contexts/deals/application/deals";
import { dealsDeps } from "@/contexts/deals/infrastructure/deals-composition";
import { withActor } from "@/app/_lib/api";
import { createForContactSchema } from "./validation";

/** The Pipeline board: `stage`, `owner` (user id, `me` or `none`), `q`, `limit` (per stage, default 25), `cursor`, `showAll=1`. */
export function GET(request: Request) {
  return withActor(async (actor) => {
    const params = new URL(request.url).searchParams;
    const limit = params.get("limit");
    return board(dealsDeps(), actor, {
      stage: params.get("stage"),
      owner: params.get("owner"),
      q: params.get("q"),
      limit: limit === null ? null : Number(limit),
      cursor: params.get("cursor"),
      showAll: params.get("showAll") === "1" || params.get("showAll") === "true",
    });
  });
}

/** A further deal for a contact (contact mode of the Create deal dialog). The idempotency key is required. */
export async function POST(request: Request) {
  return withActor(async (actor) => {
    const { personId, ...input } = createForContactSchema.parse(await request.json());
    return createDealForContact(dealsDeps(), actor, personId, input);
  }, 201);
}
