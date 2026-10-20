/**
 * Shown to members where only an owner or admin can act. `action` completes "Only an owner or admin can ...".
 * Pages the member cannot use at all set `replacesPage`, which adds who to ask.
 */
export function AdminNotice({ action, replacesPage = false }: { action: string; replacesPage?: boolean }) {
  return (
    <p role="note" className="text-sm text-muted-foreground">
      Only an owner or admin can {action}.{replacesPage ? " Ask one of them for access." : ""}
    </p>
  );
}
