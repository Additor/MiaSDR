import { connection, NextResponse } from "next/server";

/**
 * The Records list went away: people with a conversation are a Leads filter now. Only the search carries over; the
 * old state, category and page filters have no equivalent, so they are dropped instead of passed through the way a
 * `next.config.ts` redirect would pass them. Temporary (307), so a browser does not keep it.
 */
export async function GET(request: Request) {
  await connection();
  const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  const target = new URLSearchParams({ hasConversation: "yes", lifecycle: "all" });
  if (q) target.set("q", q);
  return new NextResponse(null, { status: 307, headers: { Location: `/leads?${target.toString()}` } });
}
