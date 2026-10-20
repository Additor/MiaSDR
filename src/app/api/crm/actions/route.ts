import { getWorkQueue } from "@/contexts/conversations/actions/application/work-queue";
import { workQueueDeps } from "@/contexts/conversations/actions/infrastructure/work-queue-composition";
import { withActor } from "@/shared/api";

/**
 * The work queue: records in `action_required` or `error`, or `waiting` and due, in five groups with an exact total each.
 * Filters: category, channel, group, subcategoryId, campaignId, dueBefore, dueAfter, errorsOnly. `limit` defaults to 50, max 200.
 * `cursor` (from a group's `nextCursor`) needs `group` and returns that group's next page. Dead inbound events live at /api/inbound-events.
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
