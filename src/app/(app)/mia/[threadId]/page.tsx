import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/shell/page-skeleton";
import { toActor } from "@/app/_lib/api";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { openChat } from "@/contexts/mia/application/chat-use-cases";
import { miaUnavailable } from "@/contexts/mia/application/mia-use-cases";
import { miaChatDeps } from "@/contexts/mia/infrastructure/composition";
import { NotFoundError } from "@/shared/errors";
import { ChatHeader } from "../_components/chat-header";
import { ChatView } from "../_components/chat-view";

export const metadata: Metadata = { title: "Mia" };

export default function ChatPage({ params, searchParams }: PageProps<"/mia/[threadId]">) {
  return (
    <Suspense fallback={<PageSkeleton shape="list" />}>
      <Chat params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function Chat({ params, searchParams }: { params: PageProps<"/mia/[threadId]">["params"]; searchParams: PageProps<"/mia/[threadId]">["searchParams"] }) {
  await connection();
  const { threadId } = await params;
  const ask = (await searchParams).ask;
  const actor = toActor(await requireOrgContext());
  const deps = miaChatDeps();
  const view = await openChat(deps, actor, threadId).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const unavailable = await miaUnavailable(deps, actor);
  return (
    <>
      <ChatHeader threadId={view.thread.id} title={view.thread.title ?? "Chat"} />
      {view.thread.purgedAt && (
        <p className="border-b bg-muted/50 px-gutter py-2 text-sm text-muted-foreground" role="note">
          Part of this chat was removed with a deleted person.
        </p>
      )}
      <ChatView key={view.thread.id} threadId={view.thread.id} initial={view.messages} going={view.going} unavailable={unavailable} ask={typeof ask === "string" && view.messages.length === 0 ? ask : undefined} />
    </>
  );
}
