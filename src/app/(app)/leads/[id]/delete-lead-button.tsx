"use client";

import { Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Button } from "@/components/ui/button";
import { DELETE_EFFECT, deleteConfirmation, type DeleteQualification } from "@/contexts/leads/application/lead-delete-check";
import { callApi } from "@/lib/api-client";

/**
 * The delete row of the Contact details and removal section. It says before the click whether the lead qualifies. A lead the
 * rules protect gets the reason and no button, so nothing in the row looks broken. The server applies the same rules again.
 */
export function DeleteLeadSection({ id, name, qualification, returnTo }: { id: string; name: string; qualification: DeleteQualification; returnTo: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  async function remove() {
    const result = await callApi(`/api/leads/${id}`, "DELETE");
    // ConfirmDialog shows the thrown message and keeps the dialog open.
    if (!result.ok) throw new Error(result.error ?? "The lead could not be deleted. Try again.");
    toast.success(`Deleted ${name}.`);
    router.push(returnTo);
    router.refresh();
  }

  return (
    <div className="grid gap-3" data-testid="delete-section" data-can-delete={qualification.canDelete}>
      <div className="grid gap-1">
        <h3 className="text-sm font-medium">Delete lead</h3>
        <p className="text-sm text-muted-foreground" data-testid="delete-qualification">
          <span className="font-medium text-foreground">{qualification.summary}</span> {qualification.detail}
          {qualification.canDelete && ` ${DELETE_EFFECT}`}
        </p>
      </div>
      {qualification.canDelete && (
        <>
          <div>
            <Button variant="outline" onClick={() => setOpen(true)} className="max-sm:h-11">
              <Trash2Icon aria-hidden />
              Delete lead
            </Button>
          </div>
          <ConfirmDialog
            open={open}
            onOpenChange={setOpen}
            title={`Delete ${name}?`}
            description={deleteConfirmation(qualification)}
            confirmLabel="Delete lead"
            pendingLabel="Deleting…"
            destructive
            onConfirm={remove}
          />
        </>
      )}
    </div>
  );
}
