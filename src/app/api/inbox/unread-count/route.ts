import { connection } from "next/server";
import { unreadCounts } from "@/contexts/conversations/application/unread-count";
import { unreadStore } from "@/contexts/conversations/infrastructure/composition";
import { withActor } from "@/app/_lib/api";

export async function GET() {
  await connection();
  return withActor((actor) => unreadCounts(unreadStore, actor));
}
