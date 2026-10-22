import { z } from "zod";
import { getSendPause, setSendPause } from "@/contexts/outreach/application/send-pause";
import { emailRulesDeps, sendPauseDeps } from "@/contexts/outreach/infrastructure/composition";
import { withActor, withAdmin } from "@/app/_lib/api";

/** `{ paused: null }` while outreach runs, else `{ paused: { at, byName } }`. */
export const GET = () => withActor(async (actor) => ({ paused: await getSendPause(emailRulesDeps(), actor) }));

export const PUT = (request: Request) =>
  withAdmin("Only an owner or admin can pause or resume sending.", async (actor, ctx) => {
    const { paused } = z.object({ paused: z.boolean() }).parse(await request.json());
    return { paused: await setSendPause(sendPauseDeps(), actor, { paused, byName: ctx.user.name || ctx.user.email, now: new Date() }) };
  });
