import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

const redirects = async () => (await nextConfig.redirects?.()) ?? [];

/** Each redirect is temporary, so a browser does not cache it (307, not 308). */
function expectTemporary(redirect: Awaited<ReturnType<typeof redirects>>[number]) {
  expect(redirect.permanent).toBe(false);
  expect("statusCode" in redirect && redirect.statusCode === 308).toBe(false);
}

describe("/crm/sequences redirects", () => {
  it("are temporary, so a browser does not cache them (307, not 308)", async () => {
    const sequences = (await redirects()).filter((r) => r.source.startsWith("/crm/sequences"));
    expect(sequences.map((r) => r.source)).toEqual(["/crm/sequences", "/crm/sequences/:id/:path+"]);
    for (const redirect of sequences) {
      expect(redirect).toMatchObject({ destination: "/campaigns" });
      expectTemporary(redirect);
    }
  });
});

/** One case per static row of the URL map ("Leads and CRM" in docs/decisions.md). Route handlers answer the rest. */
describe("lead and CRM split redirects", () => {
  it.each([
    ["/crm", "/crm/pipeline"],
    ["/crm/actions", "/actions"],
    ["/crm/identity-exceptions", "/inbox/unmatched"],
    ["/crm/settings", "/settings/replies"],
    ["/settings/crm", "/settings/replies"],
    ["/settings/email", "/settings/mailboxes"],
  ])("sends %s to %s with a 307", async (source, destination) => {
    const matches = (await redirects()).filter((r) => r.source === source && !r.has && !r.missing);
    expect(matches).toHaveLength(1);
    expect(matches[0].destination).toBe(destination);
    expectTemporary(matches[0]);
  });

  it("sends /leads?tab=companies to /crm/companies and leaves the plain Leads list alone", async () => {
    const leads = (await redirects()).filter((r) => r.source === "/leads");
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ destination: "/crm/companies", has: [{ type: "query", key: "tab", value: "companies" }] });
    expectTemporary(leads[0]);
  });

  it("sends /inbox?view=action to /actions", async () => {
    const inbox = (await redirects()).filter((r) => r.source === "/inbox");
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ destination: "/actions", has: [{ type: "query", key: "view", value: "action" }] });
    expectTemporary(inbox[0]);
  });

  it("leaves /crm/records and /crm/records/:id to their route handlers", async () => {
    expect((await redirects()).filter((r) => r.source.startsWith("/crm/records"))).toEqual([]);
  });
});
