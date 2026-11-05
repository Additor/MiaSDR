import { GtmRequestError, obj } from "./gtm-http";

export { obj };
export type Row = Record<string, unknown>;

export const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** An ACoAA or ACwAA member id, which every match here needs. */
export const memberIdOf = (value: unknown): string | null => {
  const id = str(value);
  return id && /^AC[a-zA-Z0-9_-]{6,}$/.test(id) ? id : null;
};

/** A search's rows. A missing list is a changed answer and throws: a read must not take it for nothing new. */
export function itemsOf(answer: Row): Array<{ item: Row; included: Row }> {
  if (!Array.isArray(answer.items) || !answer.pagination) throw new GtmRequestError(0, "gtm-api answered a search without its rows.");
  return (answer.items as unknown[]).map((entry) => ({ item: obj(obj(entry).item), included: obj(obj(entry).included) }));
}

const ON_FIRST_SYNC = new Set(["new", "initial_syncing"]);
const SIGNED_OUT = new Set(["login_issue", "restricted"]);

/** `status` is the account's lifecycle and stays active through a logout, so the browser says whether it is signed in. */
export function accountReadiness(item: Row, included: Row): "connected" | "disconnected" | "not_yet" {
  const status = str(item.status);
  if (status && ON_FIRST_SYNC.has(status)) return "not_yet";
  if (status !== "active") return "disconnected";
  const raw = included.antidetect_browser;
  const browser = obj(Array.isArray(raw) ? raw[0] : raw);
  return SIGNED_OUT.has(str(browser.status) ?? "") ? "disconnected" : "connected";
}
