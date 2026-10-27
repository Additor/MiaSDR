import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  callRoute,
  createWorld,
  declaredMethods,
  handlerReadsBody,
  HTTP_METHODS,
  loadRoute,
  paramNames,
  proxyAnswer,
  routeKey,
  scanRouteFiles,
  seedErrors,
  type CallResult,
  type HttpMethod,
  type World,
} from "@/test-support/route-client";
import { describeDb, dropOrgs, TEST_DATABASE_URL, uniqueKey } from "@/test-support/db";
import { PERMISSION_AFTER_VALIDATION } from "./route-matrix-allowlist";
import { PUBLIC_ROUTES, ROUTES, type HandlerSpec, type IdSpec } from "./route-matrix-spec";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("@/test-support/route-client")).nextHeadersStandIn());
vi.mock("next/server", async (original) => (await import("@/test-support/route-client")).nextServerStandIn(await original()));

/*
 * Route matrix. Calls every handler of every route.ts under src/app/api in process, against a real database and
 * real Better Auth sessions, and checks the status contract for protected routes:
 *   no session 401 | member on an admin handler 403 | another organization's id 404 | non-uuid id 404 |
 *   malformed JSON body 400 | member on an admin handler with a malformed body 403 (permission before validation).
 * Needs TEST_DATABASE_URL. It migrates that database and removes what it creates.
 */
const files = scanRouteFiles();
const keys = files.map(routeKey);
const publicKeys = new Set(Object.keys(PUBLIC_ROUTES));

const idSpec = (value: IdSpec | string | null | undefined): IdSpec => (typeof value === "string" ? { table: value } : (value ?? { table: null }));
const csvForm = () => {
  const form = new FormData();
  form.set("file", new File(["email,name\nsomeone@example.com,Someone\n"], "leads.csv", { type: "text/csv" }));
  return form;
};
const label = (method: string, key: string) => `${method} ${key}`;

describe("route inventory", () => {
  it("lists every route.ts found on disk, either as public or as protected", () => {
    const known = new Set([...publicKeys, ...Object.keys(ROUTES)]);
    const missing = keys.filter((k) => !known.has(k));
    expect(missing, "routes with no entry in route-matrix-spec.ts (add them to ROUTES, or to PUBLIC_ROUTES with a reason)").toEqual([]);
    const stale = [...known].filter((k) => !keys.includes(k));
    expect(stale, "entries in route-matrix-spec.ts with no route.ts on disk").toEqual([]);
    const both = [...publicKeys].filter((k) => k in ROUTES);
    expect(both, "routes listed as both public and protected").toEqual([]);
  });

  it("lists every exported handler and every path param of a protected route", () => {
    const problems: string[] = [];
    for (const file of files) {
      const key = routeKey(file);
      const spec = ROUTES[key];
      if (!spec) continue;
      const declared = declaredMethods(file);
      const listed = Object.keys(spec.handlers);
      for (const m of declared) if (!listed.includes(m)) problems.push(`${label(m, key)} is exported but not in the spec`);
      for (const m of listed) if (!declared.includes(m as HttpMethod)) problems.push(`${label(m, key)} is in the spec but not exported`);
      const params = paramNames(key);
      const covered = new Set<string>();
      for (const [param, raw] of Object.entries(spec.ids ?? {})) {
        covered.add(param);
        for (const linked of Object.keys(idSpec(raw).links ?? {})) covered.add(linked);
      }
      for (const p of params) if (!covered.has(p)) problems.push(`${key}: path param [${p}] has no id spec`);
    }
    expect(problems).toEqual([]);
  });

  it("matches the exports the modules really have", async () => {
    const problems: string[] = [];
    for (const file of files) {
      const exported = Object.keys(await loadRoute(file)).sort();
      const declared = [...declaredMethods(file)].sort();
      if (exported.join() !== declared.join()) problems.push(`${file}: source says ${declared.join()}, module exports ${exported.join()}`);
    }
    expect(problems).toEqual([]);
  }, 60_000);
});

describe("permission before validation", () => {
  it("has an empty allow-list: every admin-only handler checks the role before it parses the body", () => {
    expect(PERMISSION_AFTER_VALIDATION, "use withAdmin (src/app/_lib/api.ts) in the handler instead of allow-listing it").toEqual([]);
  });
});

describeDb("route matrix", () => {
  let world: World;
  const rowCache = new Map<string, Record<string, unknown> | null>();

  beforeAll(async () => {
    world = await createWorld(TEST_DATABASE_URL ?? "");
  }, 120_000);

  afterAll(async () => {
    if (!world) return;
    // dropOrgs throws on a failed delete; close() then removes the users and ends the client.
    await dropOrgs(world.sql, [{ organizationId: world.orgA.id }, { organizationId: world.orgB.id }]);
    await world.close();
  });

  /** One row of a table in an organization. Seeded once and reused: the checks that share rows never succeed in changing one. */
  async function rowFor(table: string, organizationId: string, fresh = false, force?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const cacheKey = fresh ? `fresh:${Math.random()}` : `${table}:${organizationId}:${JSON.stringify(force ?? {})}`;
    if (!rowCache.has(cacheKey)) {
      if (table === "members") {
        const [row] = await world.sql`select * from members where organization_id = ${organizationId} order by created_at limit 1`;
        rowCache.set(cacheKey, row ?? null);
      } else if (table === "reply_types") {
        // The reply type set and its types are created on first read, so read it as the organization's owner first.
        await callRoute("reply-types/route.ts", "GET", { as: organizationId === world.orgA.id ? world.admin : world.other });
        // A type with a system role refuses archive and delete, so the matrix takes a type without one.
        const [row] = await world.sql`select * from reply_types where organization_id = ${organizationId} and system_role is null order by ${fresh ? world.sql`random()` : world.sql`created_at`} limit 1`;
        rowCache.set(cacheKey, row ?? null);
      } else {
        rowCache.set(cacheKey, await world.seed(table, organizationId, force));
      }
    }
    const row = rowCache.get(cacheKey);
    if (!row) throw new Error(`cannot seed ${table}: ${seedErrors[table] ?? "a parent row failed"} (all seed errors: ${JSON.stringify(seedErrors)}). Add a SEED_OVERRIDES entry in route-client.ts.`);
    return row;
  }

  /** The path params of a route, all pointing at rows of one organization. */
  async function idsOf(key: string, organizationId: string, fresh = false): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [param, raw] of Object.entries(ROUTES[key]?.ids ?? {})) {
      const spec = idSpec(raw);
      if (!spec.table) {
        out[param] = spec.sample ?? "00000000-0000-4000-8000-000000000000";
        continue;
      }
      const row = await rowFor(spec.table, organizationId, fresh, spec.force);
      out[param] = String(row.id);
      for (const [linked, source] of Object.entries(spec.links ?? {})) {
        const [column, hop] = source.split(">");
        if (!hop) {
          out[linked] = String(row[column]);
          continue;
        }
        const [hopTable, hopColumn] = hop.split(".");
        const [parent] = await world.sql.unsafe(`select "${hopColumn}" as value from "${hopTable}" where id = $1`, [row[column] as string]);
        out[linked] = String(parent.value);
      }
    }
    return out;
  }

  const describeStatus = (r: CallResult) => `${r.status} ${r.thrown ? `(threw: ${String(r.thrown).slice(0, 160)})` : r.text.slice(0, 160)}`;

  function bodyOptions(file: string, method: HttpMethod, spec: HandlerSpec) {
    const reads = method !== "GET" && (spec.form || handlerReadsBody(file, method));
    const valid = spec.form ? { form: csvForm() } : reads ? { json: spec.valid ?? {} } : {};
    return { reads, valid };
  }

  for (const file of files) {
    const key = routeKey(file);
    const route = ROUTES[key];
    if (!route) continue;
    for (const method of HTTP_METHODS) {
      const spec = route.handlers[method];
      if (!spec) continue;
      const { reads, valid } = bodyOptions(file, method, spec);
      const common = { query: spec.query };
      const params = paramNames(key);

      describe(label(method, key), () => {
        it("answers 401 without a session", async () => {
          const result = await callRoute(file, method, { ...common, ...valid, params: Object.fromEntries(params.map((p) => [p, "x"])), as: null });
          expect(result.status, describeStatus(result)).toBe(401);
        });

        if (spec.admin) {
          it("answers 403 to a member", async () => {
            const ids = await idsOf(key, world.orgA.id);
            const result = await callRoute(file, method, { ...common, ...valid, params: ids, as: world.member });
            expect(result.status, describeStatus(result)).toBe(403);
          });

          if (reads && !spec.form) {
            it("answers 403, not 400, to a member with a malformed body", async () => {
              const ids = await idsOf(key, world.orgA.id);
              const result = await callRoute(file, method, { ...common, params: ids, raw: "{not json", as: world.member });
              expect(result.status, describeStatus(result)).toBe(403);
            });
          }
        }

        for (const [param, raw] of Object.entries(route.ids ?? {})) {
          const idSpecValue = idSpec(raw);
          const names = [param, ...Object.keys(idSpecValue.links ?? {})];

          it(`answers 404 for a non-uuid [${param}]`, async () => {
            const ids = await idsOf(key, world.orgA.id);
            const result = await callRoute(file, method, { ...common, ...valid, params: { ...ids, [param]: idSpecValue.table ? "not-a-uuid" : "not-a-view" }, as: world.admin });
            expect(result.status, describeStatus(result)).toBe(404);
          });

          if (idSpecValue.table && !spec.idIsCapability) {
            it(`answers 404 for another organization's [${param}]`, async () => {
              const own = await idsOf(key, world.orgA.id);
              const foreign = await idsOf(key, world.orgB.id);
              const params = { ...own, [param]: foreign[param] };
              // A nested id is only foreign if the row it names is not this organization's: keep its parents foreign too.
              for (const linked of names.slice(1)) params[linked] = foreign[linked];
              const result = await callRoute(file, method, { ...common, ...valid, params, as: world.admin });
              expect(result.status, describeStatus(result)).toBe(404);
            });
          }
        }

        if (reads && !spec.form && !spec.lenientBody) {
          it("answers 400 for a malformed JSON body", async () => {
            const ids = await idsOf(key, world.orgA.id);
            const result = await callRoute(file, method, { ...common, params: ids, raw: "{not json", as: world.admin });
            expect(result.status, describeStatus(result)).toBe(400);
          });
        }

        it(`finds its own organization's row and never answers 5xx`, async () => {
          // A valid request may change its rows, so it gets rows of its own. A 404 here means the id spec names the wrong table.
          const ids = await idsOf(key, world.orgA.id, true);
          const result = await callRoute(file, method, { ...common, ...valid, params: ids, as: world.admin });
          expect(result.status, describeStatus(result)).toBeLessThan(500);
          if (Object.values(route.ids ?? {}).some((v) => idSpec(v).table) && !spec.mayNotFindOwnRow) expect(result.status, describeStatus(result)).not.toBe(404);
        });
      });
    }
  }

  it("an empty PATCH changes nothing and does not answer 500", async () => {
    // Regression: drizzle throws "No values to set" for an empty SET. Each of these stores built its SET from optional fields.
    const targets: Array<[string, string]> = [
      ["campaigns/[id]/route.ts", "campaigns/[id]"],
      ["linkedin/campaigns/[id]/route.ts", "linkedin/campaigns/[id]"],
      ["mailboxes/[id]/route.ts", "mailboxes/[id]"],
      ["linkedin/accounts/[id]/route.ts", "linkedin/accounts/[id]"],
    ];
    const problems: string[] = [];
    for (const [file, key] of targets) {
      const own = await callRoute(file, "PATCH", { params: await idsOf(key, world.orgA.id), json: {}, as: world.admin });
      if (own.status !== 200) problems.push(`${key} own row: ${describeStatus(own)}`);
      const foreign = await callRoute(file, "PATCH", { params: await idsOf(key, world.orgB.id), json: {}, as: world.admin });
      if (foreign.status !== 404) problems.push(`${key} other organization's row: ${describeStatus(foreign)}`);
    }
    expect(problems).toEqual([]);
  });

  it("list and read endpoints show nothing of the other organization", async () => {
    const markers = [world.orgB.id, world.orgB.slug, world.other.email, world.other.userId];
    for (const [cacheKey, row] of rowCache) if (cacheKey.includes(world.orgB.id) && row) markers.push(String(row.id));
    const leaks: string[] = [];
    for (const file of files) {
      const key = routeKey(file);
      const spec = ROUTES[key]?.handlers.GET;
      if (!spec) continue;
      const result = await callRoute(file, "GET", { query: spec.query, params: await idsOf(key, world.orgA.id), as: world.admin });
      if (result.status >= 500) leaks.push(`GET ${key}: ${describeStatus(result)}`);
      for (const marker of markers) if (marker && result.text.includes(marker)) leaks.push(`GET ${key} shows ${marker}`);
    }
    expect(leaks).toEqual([]);
  });

  it("requests for the other organization's ids left its rows unchanged", async () => {
    const changed: string[] = [];
    for (const [cacheKey, before] of rowCache) {
      if (!before || !cacheKey.includes(world.orgB.id)) continue;
      const table = cacheKey.split(":")[0];
      const [after] = await world.sql.unsafe(`select * from "${table}" where id = $1`, [before.id as string]);
      if (!after) changed.push(`${table} ${String(before.id)} is gone`);
      else if (JSON.stringify(after) !== JSON.stringify(before)) changed.push(`${table} ${String(before.id)} was modified`);
    }
    expect(changed).toEqual([]);
  });

  it("linkedin/webhooks/setup is a POST: member 403, admin 200 with no-store and one audit row, GET answers 405 and audits nothing, every error carries no-store", async () => {
    const { drizzleLinkedInAccountStore } = await import("@/contexts/outreach/linkedin/infrastructure/drizzle-linkedin-account-store");
    const secret = "matrix-notify-secret-0123456789";
    const file = "linkedin/webhooks/setup/route.ts";
    const audits = async () => (await world.sql`select meta from audit_log where organization_id = ${world.orgA.id} and action = 'integration.secret_viewed'`).length;
    const before = await audits();

    // No Unipile row yet: 409. No session: 401. Member: 403. All of them carry no-store.
    const notConnected = await callRoute(file, "POST", { as: world.admin });
    expect(notConnected.status).toBe(409);
    expect(notConnected.headers.get("cache-control")).toBe("no-store");
    const anonymous = await callRoute(file, "POST", { as: null });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("cache-control")).toBe("no-store");
    const refused = await callRoute(file, "POST", { as: world.member });
    expect(refused.status).toBe(403);
    expect(refused.headers.get("cache-control")).toBe("no-store");
    expect(await audits()).toBe(before);

    await drizzleLinkedInAccountStore.saveCredentials(world.orgA.id, { dsn: "api1.unipile.com:13111", apiKey: "matrix-api-key", notifySecret: secret });
    try {
      // GET has no handler, so Next answers 405 and no code runs: no reveal, no audit row.
      expect(Object.keys(await loadRoute(file))).toEqual(["POST"]);
      expect(declaredMethods(file)).toEqual(["POST"]);
      expect(await audits()).toBe(before);

      const view = await callRoute(file, "POST", { as: world.admin });
      expect(view.status).toBe(200);
      expect(view.headers.get("cache-control")).toBe("no-store");
      expect(JSON.stringify(view.body)).toContain(secret);
      expect(await audits()).toBe(before + 1);

      const listing = await callRoute("linkedin/route.ts", "GET", { as: world.admin });
      expect(JSON.stringify(listing.body)).not.toContain(secret);
      expect(JSON.stringify(listing.body)).not.toContain("matrix-api-key");
    } finally {
      await drizzleLinkedInAccountStore.clearCredentials(world.orgA.id);
    }
  });

  it("the proxy gate answers 401 without a session cookie for every protected route", async () => {
    const problems: string[] = [];
    for (const [key, route] of Object.entries(ROUTES)) {
      for (const method of Object.keys(route.handlers) as HttpMethod[]) {
        const answer = await proxyAnswer(key, method);
        if (answer.status !== 401 || answer.passedThrough) problems.push(`${label(method, key)}: ${answer.status}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("the proxy gate lets the public routes through without a cookie, except the dev helper", async () => {
    const problems: string[] = [];
    for (const key of publicKeys) {
      const answer = await proxyAnswer(key, "POST");
      const expectOpen = key !== "dev/inbound";
      if (expectOpen !== answer.passedThrough) problems.push(`${key}: passedThrough=${answer.passedThrough}`);
    }
    expect(problems).toEqual([]);
  });

  describe("public routes", () => {
    const call = (key: string, method: HttpMethod, options: Parameters<typeof callRoute>[2] = {}) => callRoute(`${key}/route.ts`, method, { as: null, ...options });

    it("health answers 200", async () => {
      expect((await call("health", "GET")).status).toBe(200);
    });

    it("jobs/tick answers 401 without the bearer secret and with a wrong one", async () => {
      expect((await call("jobs/tick", "POST")).status).toBe(401);
      expect((await call("jobs/tick", "GET", { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    });

    it("outreach/unsubscribe answers 400 for a missing or invalid token", async () => {
      expect((await call("outreach/unsubscribe", "POST", { raw: "{}" })).status).toBe(400);
      expect((await call("outreach/unsubscribe", "POST", { raw: "{not json" })).status).toBe(400);
      expect((await call("outreach/unsubscribe", "POST", { json: { token: "garbage" } })).status).toBe(400);
    });

    it("outreach/unsubscribe takes the RFC 8058 one-click POST without a session, once, and refuses a bad token or body", async () => {
      const { createUnsubscribeToken } = await import("@/contexts/outreach/email/domain/unsubscribe-token");
      const email = `oneclick-${uniqueKey()}@lead.test`;
      const token = createUnsubscribeToken("r".repeat(40), world.orgA.id, email);
      const oneClick = { query: { token }, raw: "List-Unsubscribe=One-Click", headers: { "content-type": "application/x-www-form-urlencoded" } };
      const count = async () => (await world.sql`select count(*)::int as n from suppression_list where organization_id = ${world.orgA.id} and email = ${email}`)[0].n;

      expect((await call("outreach/unsubscribe", "POST", { ...oneClick, raw: "List-Unsubscribe=Nope" })).status).toBe(400);
      expect((await call("outreach/unsubscribe", "POST", { ...oneClick, query: { token: "garbage" } })).status).toBe(400);
      expect(await count()).toBe(0);

      expect((await call("outreach/unsubscribe", "POST", oneClick)).status).toBe(200);
      expect((await call("outreach/unsubscribe", "POST", oneClick)).status).toBe(200);
      expect(await count()).toBe(1);

      // The confirmation page keeps working through the JSON body.
      expect((await call("outreach/unsubscribe", "POST", { json: { token } })).status).toBe(200);
      expect(await count()).toBe(1);
      // The public proxy lets the endpoint through without a cookie.
      expect((await proxyAnswer("outreach/unsubscribe", "POST")).passedThrough).toBe(true);
    });

    it("setup answers 409 once a user exists, and 400 for a malformed body", async () => {
      expect((await call("setup", "POST", { raw: "{not json" })).status).toBe(400);
      const result = await call("setup", "POST", { json: { name: "A", email: "a@matrix.test", password: "long-enough-pw-1", organizationName: "O" } });
      expect([400, 409]).toContain(result.status);
    });

    it("webhooks/unipile answers 401 for a missing org or secret", async () => {
      expect((await call("webhooks/unipile", "POST", { json: {} })).status).toBe(401);
      expect((await call("webhooks/unipile", "POST", { json: {}, query: { org: world.orgA.id } })).status).toBe(401);
    });

    it("webhooks/unipile-account answers 401 for a missing, malformed or unknown link and secret", async () => {
      expect((await call("webhooks/unipile-account", "POST", { json: {} })).status).toBe(401);
      expect((await call("webhooks/unipile-account", "POST", { json: {}, query: { link: "not-a-uuid", secret: "x" } })).status).toBe(401);
      expect((await call("webhooks/unipile-account", "POST", { json: {}, query: { link: "00000000-0000-4000-8000-000000000000", secret: "x" } })).status).toBe(401);
      expect((await call("webhooks/unipile-account", "POST", { raw: "{not json", query: { link: "00000000-0000-4000-8000-000000000000", secret: "x" } })).status).toBe(401);
    });

    it("webhooks/dev-fakes and dev/inbound answer 404 without their flags", async () => {
      expect((await call("webhooks/dev-fakes", "POST", { json: { action: "delivered" }, headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } })).status).toBe(404);
      expect((await call("dev/inbound", "POST", { json: {} })).status).toBe(404);
    });

    it("auth/[...all] answers requests for an unknown endpoint without a 5xx", async () => {
      const result = await callRoute("auth/[...all]/route.ts", "GET", { params: { all: "no-such-endpoint" }, as: null });
      expect(result.status).toBeLessThan(500);
    });
  });
});
