import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stateless one-click unsubscribe token: base64url("v2.<organizationId>.<email>.<sig>").
 * The signature covers the organization and the address, so a token only
 * suppresses that address in that organization.
 */
const SIG_LENGTH = 32;

function signature(secret: string, organizationId: string, email: string): string {
  return createHmac("sha256", secret).update(`v2:${organizationId}:${email}`).digest("hex").slice(0, SIG_LENGTH);
}

export function createUnsubscribeToken(secret: string, organizationId: string, email: string): string {
  const normalized = email.trim().toLowerCase();
  return Buffer.from(`v2.${organizationId}.${normalized}.${signature(secret, organizationId, normalized)}`).toString("base64url");
}

export function verifyUnsubscribeToken(secret: string, token: string): { organizationId: string; email: string } | null {
  let decoded: string;
  try {
    decoded = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const match = decoded.match(/^v2\.([0-9a-f-]{36})\.(.+)\.([0-9a-f]{32})$/);
  if (!match) return null;
  const [, organizationId, email, given] = match;
  const expected = signature(secret, organizationId, email);
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { organizationId, email };
}

/**
 * The two links of one recipient. `pageUrl` goes in the body: a person opens it and confirms.
 * `oneClickUrl` goes in the List-Unsubscribe header (RFC 8058): a mail client POSTs
 * `List-Unsubscribe=One-Click` to it, so it must point at the POST endpoint, never the page.
 */
export function unsubscribeLinks(appUrl: string, secret: string, organizationId: string, email: string): { pageUrl: string; oneClickUrl: string } {
  const token = createUnsubscribeToken(secret, organizationId, email);
  return { pageUrl: `${appUrl}/unsubscribe?token=${token}`, oneClickUrl: `${appUrl}/api/outreach/unsubscribe?token=${token}` };
}
