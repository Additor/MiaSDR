"use client";

import { Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { orThrow, runApiAction } from "@/app/_lib/api-action";
import { callApi } from "@/app/_lib/api-client";

/** A chat's name, which its owner can change, and Delete. */
export function ChatHeader({ threadId, title }: { threadId: string; title: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);

  async function rename(name: string) {
    const res = await runApiAction(callApi(`/api/mia/threads/${threadId}`, "PATCH", { title: name }), { refresh: () => router.refresh() });
    return res.ok ? null : res.error;
  }

  async function remove() {
    orThrow(await runApiAction(callApi(`/api/mia/threads/${threadId}`, "DELETE"), { refresh: () => undefined }));
    router.push("/mia");
    router.refresh();
  }

  return (
    <>
      <PageHeader
        title={title}
        back={{ href: "/mia", label: "Mia" }}
        rename={{ label: "Chat name", onSave: rename }}
        actions={
          <Button variant="ghost" size="sm" onClick={() => setConfirming(true)} aria-label="Delete chat">
            <Trash2Icon />
            <span className="max-sm:sr-only">Delete</span>
          </Button>
        }
      />
      <ConfirmDialog open={confirming} onOpenChange={setConfirming} title="Delete this chat?" description="The questions and answers in it are deleted. The leads and items Mia read stay as they are." confirmLabel="Delete chat" destructive onConfirm={remove} />
    </>
  );
}
