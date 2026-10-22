import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConflictError, ValidationError } from "@/shared/errors";
import { bootDealsKit, holdLocks, waitForLockWaiters, type DealsKit } from "@/test-support/deals-test-kit";
import { describeDb, TEST_DATABASE_URL } from "@/test-support/db";

/**
 * `resolveCompanyDomain` by domain, by other domain (alias) and by insert, with the conflict arm an import-inserted
 * company takes; `findCompanyByDomain` and `searchCompanies`. Needs TEST_DATABASE_URL pointing at a migrated Postgres.
 */
describeDb("company domains", () => {
  let kit: DealsKit;
  let store: typeof import("../company-domain-store");
  let dbClient: typeof import("@/platform/db/client");

  beforeAll(async () => {
    kit = await bootDealsKit(TEST_DATABASE_URL ?? "");
    store = await import("../company-domain-store");
    dbClient = await import("@/platform/db/client");
  }, 60_000);

  afterAll(async () => {
    await kit?.cleanup();
  });

  const resolve = (org: string, domain: string, name: string | null = null) => dbClient.db.transaction((tx) => store.resolveCompanyDomain(tx, org, domain, { name }));
  const alias = (org: string, companyId: string, domain: string) => kit.sql`insert into company_domain_aliases (organization_id, company_id, domain, merged_name) values (${org}, ${companyId}, ${domain}, 'Globex')`;
  const company = async (id: string) => (await kit.sql`select domain, name, version, crm_listed_at from companies where id = ${id}`)[0];

  describe("resolveCompanyDomain", () => {
    it("finds a company by its domain and keeps its name", async () => {
      const f = await kit.organization();
      const acme = await f.company("Acme", `acme-${f.tag}.test`);
      expect(await resolve(f.org, `acme-${f.tag}.test`, "Other")).toEqual({ companyId: acme, name: "Acme", domain: `acme-${f.tag}.test`, viaAlias: false, created: false });
      expect((await company(acme)).version).toBe(0);
    });

    it("lands an other domain on the company that holds it", async () => {
      const f = await kit.organization();
      const acme = await f.company("Acme", `acme-${f.tag}.test`);
      await alias(f.org, acme, `globex-${f.tag}.test`);
      expect(await resolve(f.org, `globex-${f.tag}.test`, "Globex")).toEqual({ companyId: acme, name: "Acme", domain: `acme-${f.tag}.test`, viaAlias: true, created: false });
      expect(await kit.count("companies", f.org)).toBe(1);
    });

    it("inserts a new company with the typed name", async () => {
      const f = await kit.organization();
      const result = await resolve(f.org, `initech-${f.tag}.test`, "Initech");
      expect(result).toMatchObject({ name: "Initech", viaAlias: false, created: true });
      expect(await company(result.companyId)).toMatchObject({ name: "Initech", version: 0, crm_listed_at: null });
      const [{ source }] = await kit.sql`select source from companies where id = ${result.companyId}`;
      expect(source).toBe("manual");
    });

    it("takes the conflict arm for a company an import inserted without the domain lock, and bumps its version", async () => {
      const f = await kit.organization();
      const domain = `raced-${f.tag}.test`;
      // An import holds `leads-import`, not the domain lock: its insert is uncommitted while the resolver runs.
      const importer = await holdLocks(TEST_DATABASE_URL ?? "", (tx) => tx`insert into companies (organization_id, domain, name, source) values (${f.org}, ${domain}, null, 'import:x')`);
      const resolving = resolve(f.org, domain, "Raced");
      await waitForLockWaiters(kit.sql, 1);
      await importer.release();
      const result = await resolving;
      expect(result).toMatchObject({ name: "Raced", created: false });
      expect(await company(result.companyId)).toMatchObject({ name: "Raced", version: 1 });
    });

    it("answers try_again when a guard trigger raises on a path that missed the alias", async () => {
      const f = await kit.organization();
      const acme = await f.company("Acme", `acme-${f.tag}.test`);
      await alias(f.org, acme, `globex-${f.tag}.test`);
      // A handle whose first select (the alias read) sees nothing, as a writer that skipped the domain lock would.
      const error = await dbClient.db
        .transaction(async (tx) => {
          let blind = true;
          const handle = new Proxy(tx, {
            get(target, prop) {
              if (prop === "select" && blind) {
                blind = false;
                return () => ({ from: () => ({ where: async () => [] }) });
              }
              const value = Reflect.get(target, prop, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
          return store.resolveCompanyDomain(handle, f.org, `globex-${f.tag}.test`, { name: null });
        })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).details).toEqual({ code: "try_again" });
      expect(await kit.count("companies", f.org)).toBe(1);
    });
  });

  describe("findCompanyByDomain", () => {
    it("reads by domain or other domain, with the listing rule", async () => {
      const f = await kit.organization();
      const acme = await f.company("Acme", `acme-${f.tag}.test`);
      await alias(f.org, acme, `globex-${f.tag}.test`);
      expect(await store.findCompanyByDomain(f.org, `https://www.acme-${f.tag}.test/x`)).toEqual({ companyId: acme, name: "Acme", domain: `acme-${f.tag}.test`, viaAlias: false, listed: false });
      expect(await store.findCompanyByDomain(f.org, `globex-${f.tag}.test`)).toMatchObject({ companyId: acme, viaAlias: true, listed: false });
      await f.person({ companyId: acme, contact: true });
      expect((await store.findCompanyByDomain(f.org, `acme-${f.tag}.test`))?.listed).toBe(true);
      expect(await store.findCompanyByDomain(f.org, `nobody-${f.tag}.test`)).toBeNull();
    });

    it("refuses a webmail domain and a value that is not a domain", async () => {
      const f = await kit.organization();
      await expect(store.findCompanyByDomain(f.org, "gmail.com")).rejects.toThrow(new ValidationError("gmail.com is an email provider, not a company domain."));
      await expect(store.findCompanyByDomain(f.org, "a b")).rejects.toBeInstanceOf(ValidationError);
    });

    it("never reads another organization's company", async () => {
      const a = await kit.organization();
      const b = await kit.organization();
      await b.company("Shared", `shared-${a.tag}.test`);
      expect(await store.findCompanyByDomain(a.org, `shared-${a.tag}.test`)).toBeNull();
    });
  });

  describe("searchCompanies", () => {
    it("matches name, domain and other domain, and keeps unlisted companies out unless asked", async () => {
      const f = await kit.organization();
      const acme = await f.company("Acme", `acme-${f.tag}.test`);
      const leadsOnly = await f.company("Acme Labs", `labs-${f.tag}.test`);
      await alias(f.org, acme, `globex-${f.tag}.test`);
      await f.person({ companyId: acme, contact: true });
      await f.person({ companyId: leadsOnly });

      expect(await store.searchCompanies(f.org, "acme")).toEqual([{ companyId: acme, name: "Acme", domain: `acme-${f.tag}.test`, contacts: 1, listed: true }]);
      expect((await store.searchCompanies(f.org, "ACME", { all: true })).map((c) => [c.name, c.listed])).toEqual([
        ["Acme", true],
        ["Acme Labs", false],
      ]);
      expect((await store.searchCompanies(f.org, `globex-${f.tag}`)).map((c) => c.companyId)).toEqual([acme]);
      expect(await store.searchCompanies(f.org, "100%_")).toEqual([]);
    });

    it("returns at most 20", async () => {
      const f = await kit.organization();
      for (let i = 0; i < 22; i += 1) await kit.sql`insert into companies (organization_id, domain, name, crm_listed_at) values (${f.org}, ${`c${i}-${f.tag}.test`}, ${`Co ${i}`}, now())`;
      expect(await store.searchCompanies(f.org, "co ")).toHaveLength(store.MAX_COMPANY_SEARCH);
    });
  });
});
