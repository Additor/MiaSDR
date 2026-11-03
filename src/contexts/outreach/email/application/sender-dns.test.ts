import { describe, expect, it } from "vitest";
import { checkSenderDomain, checkSenderDomains, type ResolveTxt } from "./sender-dns";

const failure = (code: string) => Object.assign(new Error(code), { code });

/** A resolver from a table: records for a host, or the error code it fails with. */
const resolver = (table: Record<string, string[][] | string>): ResolveTxt => async (host) => {
  const answer = table[host];
  if (answer === undefined) throw failure("ENOTFOUND");
  if (typeof answer === "string") throw failure(answer);
  return answer;
};

describe("checkSenderDomain", () => {
  it("finds SPF, DKIM on the google selector and DMARC, across chunked records", async () => {
    const resolve = resolver({
      "acme.test": [["google-site-verification=abc"], ["v=spf1 include:_spf.", "google.com ~all"]],
      "google._domainkey.acme.test": [["v=DKIM1; k=rsa; ", "p=MIIBIjANBg"]],
      "_dmarc.acme.test": [["v=DMARC1; p=none"]],
    });
    expect(await checkSenderDomain(resolve, "acme.test")).toEqual({ domain: "acme.test", spf: "found", dkim: "found", dmarc: "found" });
  });

  it("says missing when DNS answers without the record", async () => {
    const resolve = resolver({ "acme.test": [["google-site-verification=abc"]], "google._domainkey.acme.test": "ENODATA", "_dmarc.acme.test": [["v=spf1 -all"]] });
    expect(await checkSenderDomain(resolve, "acme.test")).toEqual({ domain: "acme.test", spf: "missing", dkim: "missing", dmarc: "missing" });
  });

  it("treats a revoked DKIM key, an empty p=, as missing", async () => {
    const resolve = resolver({ "acme.test": [], "google._domainkey.acme.test": [["v=DKIM1; p="]], "_dmarc.acme.test": [] });
    expect((await checkSenderDomain(resolve, "acme.test")).dkim).toBe("missing");
  });

  it.each(["ETIMEOUT", "ESERVFAIL", "ECONNREFUSED", "EREFUSED"])("says it could not check on %s, and never missing", async (code) => {
    const resolve = resolver({ "acme.test": code, "google._domainkey.acme.test": code, "_dmarc.acme.test": code });
    expect(await checkSenderDomain(resolve, "acme.test")).toEqual({ domain: "acme.test", spf: "unchecked", dkim: "unchecked", dmarc: "unchecked" });
  });

  it("says it could not check on an error with no code", async () => {
    const resolve: ResolveTxt = async () => {
      throw new Error("boom");
    };
    expect((await checkSenderDomain(resolve, "acme.test")).spf).toBe("unchecked");
  });

  it("keeps one lookup's failure from hiding the others", async () => {
    const resolve = resolver({ "acme.test": [["v=spf1 ~all"]], "google._domainkey.acme.test": "ETIMEOUT" });
    expect(await checkSenderDomain(resolve, "acme.test")).toEqual({ domain: "acme.test", spf: "found", dkim: "unchecked", dmarc: "missing" });
  });
});

describe("checkSenderDomains", () => {
  it("checks each domain once, lowercased", async () => {
    const seen: string[] = [];
    const resolve: ResolveTxt = async (host) => {
      seen.push(host);
      return [];
    };
    const results = await checkSenderDomains(resolve, ["a@Acme.test", "b@acme.test", "c@other.test"]);
    expect(results.map((r) => r.domain)).toEqual(["acme.test", "other.test"]);
    expect(seen.filter((host) => host === "acme.test")).toHaveLength(1);
  });
});
