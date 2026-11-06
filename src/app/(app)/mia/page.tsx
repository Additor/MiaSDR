import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { toActor } from "@/app/_lib/api";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { listChats } from "@/contexts/mia/application/chat-use-cases";
import { miaUnavailable } from "@/contexts/mia/application/mia-use-cases";
import { miaChatDeps } from "@/contexts/mia/infrastructure/composition";
import { isUuid } from "@/shared/uuid";
import { ChatList } from "./_components/chat-list";
import { NewChat } from "./_components/new-chat";

export const metadata: Metadata = { title: "Mia" };

/** A new chat, and on a phone the person's chats under it. `?person=` starts the chat about that lead. */
export default function MiaPage({ searchParams }: PageProps<"/mia">) {
  return (
    <>
      <PageHeader title="Mia" />
      <div className="min-h-0 flex-1 overflow-y-auto px-gutter py-6">
        <div className="mx-auto grid max-w-2xl gap-8">
          <Suspense fallback={null}>
            <Start searchParams={searchParams} />
          </Suspense>
        </div>
      </div>
    </>
  );
}

async function Start({ searchParams }: { searchParams: PageProps<"/mia">["searchParams"] }) {
  await connection();
  const actor = toActor(await requireOrgContext());
  const raw = (await searchParams).person;
  const personId = typeof raw === "string" && isUuid(raw) ? raw : null;
  const deps = miaChatDeps();
  const [unavailable, threads] = await Promise.all([miaUnavailable(deps, actor), listChats(deps, actor)]);
  return (
    <>
      <NewChat personId={personId} unavailable={unavailable} />
      <ChatList threads={threads} className="md:hidden" />
    </>
  );
}
