"use client";

import { EllipsisIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { deleteConfirmation, type DeleteQualification } from "@/contexts/leads/application/lead-delete-check";
import { callApi } from "@/lib/api-client";

/**
 * The lead's rare actions: a ghost More menu in the header with Delete lead, as company and deal pages keep theirs. A lead
 * the rules protect still offers the item; the dialog says why it stays and has nothing to confirm. The server applies the
 * same rules again.
 */
export function LeadMoreMenu({ id, name, qualification, returnTo }: { id: string; name: string; qualification: DeleteQualification; returnTo: string }) {
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
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" aria-label={`More actions for ${name}`} />}>
          <EllipsisIcon aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-48">
          <DropdownMenuItem variant="destructive" className="max-sm:min-h-11" onClick={() => setOpen(true)}>
            Delete lead
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {qualification.canDelete ? (
        <ConfirmDialog
          open={open}
          onOpenChange={setOpen}
          title={`Delete ${name}?`}
          description={deleteConfirmation(qualification)}
          confirmLabel="Delete lead"
          cancelLabel="Keep lead"
          pendingLabel="Deleting…"
          destructive
          onConfirm={remove}
        />
      ) : (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent data-testid="delete-qualification">
            <DialogHeader>
              <DialogTitle>{`${name} cannot be deleted`}</DialogTitle>
              <DialogDescription>{qualification.detail}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button onClick={() => setOpen(false)}>Close</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
