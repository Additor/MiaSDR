import { env } from "@/shared/env";

interface AuthEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function authEmail(input: { to: string; subject: string; intro: string; action: string; url: string; outro?: string }): AuthEmail {
  const text = [input.intro, "", `${input.action}: ${input.url}`, ...(input.outro ? ["", input.outro] : [])].join("\n");
  const html = `<p>${escapeHtml(input.intro)}</p><p><a href="${escapeHtml(input.url)}">${escapeHtml(input.action)}</a></p>${
    input.outro ? `<p>${escapeHtml(input.outro)}</p>` : ""
  }`;
  return { to: input.to, subject: input.subject, text, html };
}

/**
 * Sends through Resend when RESEND_API_KEY is set. Without it the message is
 * written to the server log, so a first-time self-hoster can copy the link.
 */
export async function sendAuthEmail(message: AuthEmail): Promise<void> {
  const { RESEND_API_KEY, AUTH_EMAIL_FROM } = env();
  if (!RESEND_API_KEY || !AUTH_EMAIL_FROM) {
    console.log(`[auth-email] to=${message.to} subject="${message.subject}"\n${message.text}`);
    return;
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: AUTH_EMAIL_FROM, to: message.to, subject: message.subject, text: message.text, html: message.html }),
  });
  if (!response.ok) throw new Error(`Resend responded ${response.status}`);
}
