import type { MailboxProvider } from "../application/ports";

const REASON = "Google is not connected yet. Add the service account in Settings, Integrations.";

/** Used until a real adapter is configured: every call explains what is missing instead of failing obscurely. */
export const notConfiguredProvider: MailboxProvider = {
  async verify() {
    throw new Error(REASON);
  },
  async send() {
    throw new Error(REASON);
  },
  async findSent() {
    throw new Error(REASON);
  },
  async fetchInbound() {
    throw new Error(REASON);
  },
  async fetchMessages() {
    throw new Error(REASON);
  },
};
