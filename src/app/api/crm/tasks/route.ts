import { listTasks } from "@/contexts/conversations/actions/application/tasks";
import { taskDeps } from "@/contexts/conversations/actions/infrastructure/task-composition";
import { withActor } from "@/shared/api";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  return withActor(async (actor) =>
    listTasks(taskDeps(), actor, {
      state: state === "completed" || state === "all" ? state : "open",
      mine: url.searchParams.get("mine") === "1",
    }),
  );
}
