"use client";

import { EllipsisIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { ResponsibleUseNote } from "@/components/shell/responsible-use-note";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { callApi } from "@/app/_lib/api-client";
import { START_BLOCKERS_ID } from "./start-blockers";
import { countOf } from "@/shared/format-number";

type Target = "active" | "paused" | "completed";

const ACTIONS: Record<string, Array<{ to: Target; label: string; variant?: "default" | "outline" }>> = {
  draft: [{ to: "active", label: "Start campaign" }],
  active: [{ to: "paused", label: "Pause", variant: "outline" }],
  paused: [
    { to: "active", label: "Resume" },
    { to: "completed", label: "Mark completed", variant: "outline" },
  ],
  completed: [],
};

type Dialog = "start" | "complete" | "archive" | "delete";

interface Control {
  key: string;
  label: string;
  variant: "default" | "outline";
  disabled: boolean;
  describedBy?: string;
  run: () => void;
}

/**
 * The campaign's controls in the header's actions slot: the main move first (Start campaign, Pause, Resume, Archive),
 * then the rare ones (Mark completed, Delete). On a phone the rare ones sit in a More menu.
 */
export function CampaignControls({
  id,
  name,
  status,
  channel = "email",
  archived = false,
  blockers = [],
  startLines = [],
  inProgress = 0,
}: {
  id: string;
  name: string;
  status: string;
  channel?: "email" | "linkedin";
  archived?: boolean;
  /** Why a draft cannot start yet. Start stays disabled while the list has entries, and points to the list on the page. */
  blockers?: string[];
  /** Facts the Start dialog lists: lead count, senders and send rules. */
  startLines?: string[];
  /** Leads still waiting or in the sequence, for the Mark completed dialog. */
  inProgress?: number;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const api = channel === "linkedin" ? "/api/linkedin" : "/api";

  /** Throws the server's message (and its first detail) so a dialog can show it and a button handler can toast it. */
  async function send(url: string, method: "POST" | "DELETE", body: unknown, fallback: string) {
    const result = await callApi(url, method, body);
    if (!result.ok) throw new Error([result.error ?? fallback, result.issues[0]?.message].filter(Boolean).join(" "));
    return result.data;
  }

  async function change(to: Target) {
    const data = await send(`${api}/campaigns/${id}/status`, "POST", { status: to }, "Could not change the status.");
    const empty = (data as { emptySubjectLeads?: number } | null)?.emptySubjectLeads ?? 0;
    const sampled = (data as { sampled?: number } | null)?.sampled ?? 0;
    toast.success(to === "active" ? "Campaign is running." : to === "paused" ? "Campaign paused. Nothing more will be sent." : "Campaign marked completed.", {
      description: empty > 0 ? `${empty} of ${sampled} sampled leads render an empty subject for step 1 and will be skipped. Fix their merge fields to send to them.` : undefined,
    });
    router.refresh();
  }

  async function setArchived(next: boolean) {
    await send(`${api}/campaigns/${id}/archive`, "POST", { archived: next }, next ? "Could not archive the campaign." : "Could not unarchive the campaign.");
    toast.success(next ? "Campaign archived. Find it under Archived on the campaigns page." : "Campaign unarchived.");
    router.refresh();
  }

  async function remove() {
    await send(`${api}/campaigns/${id}`, "DELETE", undefined, "Could not delete the campaign.");
    toast.success("Campaign deleted.");
    router.push("/campaigns");
  }

  /** A button with no dialog: the failure goes to a toast. */
  async function direct(action: () => Promise<void>) {
    setPending(true);
    try {
      await action();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Something went wrong.");
    } finally {
      setPending(false);
    }
  }

  const blocked = status === "draft" && blockers.length > 0;
  const controls: Control[] = (ACTIONS[status] ?? []).map((action) => {
    const starting = action.to === "active" && status === "draft";
    return {
      key: action.to,
      label: action.label,
      variant: action.variant ?? "default",
      disabled: pending || (starting && blocked),
      describedBy: starting && blocked ? START_BLOCKERS_ID : undefined,
      run: () => (starting ? setDialog("start") : action.to === "completed" ? setDialog("complete") : void direct(() => change(action.to))),
    };
  });
  if (status === "completed") {
    controls.push({
      key: "archive",
      label: archived ? "Unarchive" : "Archive",
      variant: "outline",
      disabled: pending,
      run: () => (archived ? void direct(() => setArchived(false)) : setDialog("archive")),
    });
  }
  if (status === "draft") controls.push({ key: "delete", label: "Delete", variant: "outline", disabled: pending, run: () => setDialog("delete") });
  const [main, ...rest] = controls;

  return (
    <>
      {main && (
        <Button variant={main.variant} disabled={main.disabled} aria-describedby={main.describedBy} onClick={main.run}>
          {main.label}
        </Button>
      )}
      {rest.map((control) => (
        <Button key={control.key} variant={control.variant} disabled={control.disabled} className="max-sm:hidden" onClick={control.run}>
          {control.label}
        </Button>
      ))}
      {rest.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" className="sm:hidden" aria-label={`More actions for ${name}`} />}>
            <EllipsisIcon aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto min-w-40">
            {rest.map((control) => (
              <DropdownMenuItem key={control.key} className="min-h-11" disabled={control.disabled} variant={control.key === "delete" ? "destructive" : undefined} onClick={control.run}>
                {control.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <ConfirmDialog
        open={dialog === "start"}
        onOpenChange={(open) => setDialog(open ? "start" : null)}
        title={`Start ${name}?`}
        description="Steps send on their own schedule once the campaign runs. Pause it at any time to stop further sends. Replies to leads go out only when you send them."
        confirmLabel="Start campaign"
        pendingLabel="Starting…"
        onConfirm={() => change("active")}
      >
        <ul className="stack-field text-sm">
          {startLines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <ResponsibleUseNote kind={channel === "linkedin" ? "linkedin" : "launch"} />
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog === "complete"}
        onOpenChange={(open) => setDialog(open ? "complete" : null)}
        title={`Mark ${name} as completed?`}
        description={`${inProgress > 0 ? `Nothing more is sent to the ${countOf(inProgress, "lead")} still in progress. ` : ""}Leads, sends and replies stay. A completed campaign cannot be restarted.`}
        confirmLabel="Mark completed"
        cancelLabel="Keep campaign open"
        pendingLabel="Completing…"
        destructive
        onConfirm={() => change("completed")}
      />

      <ConfirmDialog
        open={dialog === "archive"}
        onOpenChange={(open) => setDialog(open ? "archive" : null)}
        title={`Archive ${name}?`}
        description="It leaves the default campaigns list. Leads, sends and analytics stay, and you can unarchive it from the Archived filter."
        confirmLabel="Archive campaign"
        pendingLabel="Archiving…"
        onConfirm={() => setArchived(true)}
      />

      <ConfirmDialog
        open={dialog === "delete"}
        onOpenChange={(open) => setDialog(open ? "delete" : null)}
        title={`Delete ${name}?`}
        description="The draft and the leads you added to it are removed. Your leads stay in the database. You cannot undo this."
        confirmLabel="Delete campaign"
        cancelLabel="Keep campaign"
        pendingLabel="Deleting…"
        destructive
        onConfirm={remove}
      />
    </>
  );
}
