import { getWorkQueue } from "@/contexts/conversations/actions/application/work-queue";
import { workQueueDeps } from "@/contexts/conversations/actions/infrastructure/work-queue-composition";
import { withActor } from "@/app/_lib/api";

/**
 * The work queue: conversations in `action_required`, or `waiting` and due, in five lists with an exact total each.
 * Filters: group (the reply group), channel, list, replyTypeId, campaignId, dueBefore, dueAfter, errorsOnly. `limit` defaults to 50, max 200.
 * `cursor` (from a group's `nextCursor`) needs `list` and returns that list's next page. Dead inbound events live at /api/inbound-events.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  return withActor((actor) =>
    getWorkQueue(workQueueDeps(), actor, {
      filter: Object.fromEntries(params.entries()),
      limit: params.get("limit"),
      cursor: params.get("cursor"),
    }),
  );
}
