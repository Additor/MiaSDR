export interface UnreadCandidate {
  threadId: string;
  unreadCount: number;
}

/**
 * The conversation to open after `currentId`: the first unread one below it in list order, else the first unread one
 * above it. The open conversation never qualifies, because the list was read before the page marked it read.
 */
export function pickNextUnread(rows: UnreadCandidate[], currentId: string): string | null {
  const at = rows.findIndex((r) => r.threadId === currentId);
  const unread = (r: UnreadCandidate) => r.unreadCount > 0 && r.threadId !== currentId;
  const after = rows.slice(at + 1).find(unread);
  if (after) return after.threadId;
  return (at > 0 ? rows.slice(0, at) : []).find(unread)?.threadId ?? null;
}
