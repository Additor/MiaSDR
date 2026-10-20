import type { LinkedInInboundEvent } from "../domain/linkedin";

/*
 * Webhook payloads, per developer.unipile.com/docs (read 2026-10-14):
 *   new_relation:     { event, account_id, account_type: "LINKEDIN", webhook_name, user_full_name, user_provider_id,
 *                       user_public_identifier, user_profile_url, user_picture_url }
 *                     May arrive up to 8 hours after acceptance (Unipile polls relations at random intervals).
 *   message_received: { event, account_id, account_type, account_info: { type, feature, user_id }, chat_id, message_id,
 *                       message, sender: { attendee_id, attendee_name, attendee_provider_id, attendee_profile_url },
 *                       attendees: [...], attachments, timestamp, webhook_name }
 *                     There is no is_sender field. Messages the account owner sent also arrive, so
 *                     sender.attendee_provider_id === account_info.user_id marks an echo.
 */

type Json = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});

/** Normalizes a raw Unipile payload. Returns null for other accounts types and for events this app ignores. */
export function parseUnipilePayload(payload: unknown): LinkedInInboundEvent | null {
  const body = obj(payload);
  const account = str(body.account_id);
  if (!account || body.account_type !== "LINKEDIN") return null;

  if (body.event === "new_relation") {
    const member = str(body.user_provider_id);
    if (!member) return null;
    return { type: "connection_accepted", account, member, name: str(body.user_full_name), profileUrl: str(body.user_profile_url) };
  }

  if (body.event === "message_received") {
    const ownerId = str(obj(body.account_info).user_id);
    const sender = obj(body.sender);
    const senderId = str(sender.attendee_provider_id);
    const fromAccountOwner = ownerId !== null && senderId === ownerId;
    let counterparty = fromAccountOwner ? null : senderId;
    if (fromAccountOwner) {
      // An echo: the other person is the attendee that is neither us nor the sender.
      for (const attendee of Array.isArray(body.attendees) ? body.attendees : []) {
        const id = str(obj(attendee).attendee_provider_id);
        if (id && id !== ownerId && id !== senderId) {
          counterparty = id;
          break;
        }
      }
    }
    return {
      type: "message_received",
      account,
      chat: str(body.chat_id),
      messageId: str(body.message_id),
      text: typeof body.message === "string" ? body.message : "",
      fromAccountOwner,
      counterparty,
      counterpartyName: fromAccountOwner ? null : str(sender.attendee_name),
      counterpartyProfileUrl: fromAccountOwner ? null : str(sender.attendee_profile_url),
      sentAt: str(body.timestamp),
    };
  }
  return null;
}
