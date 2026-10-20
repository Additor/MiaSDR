#!/usr/bin/env node
/**
 * `pnpm e2e`: builds the app, starts it on a free port with its own database and fake providers, runs the
 * Playwright scenarios and tears everything down by PID.
 *
 * Two builds:
 *   .next-e2e        built with E2E_BUILD=1, so the test-only routes exist. Served on port A.
 *   .next-e2e-prod   built exactly like the Dockerfile builds it (no E2E_BUILD). Served on port B with every
 *                    runtime helper variable set, to prove the routes stay 404 in the production image (M3).
 *
 * Environment:
 *   E2E_SKIP_BUILD=1   reuse existing builds; "prod" rebuilds only the test build
 *   E2E_DIST_SUFFIX    appended to both build directories, so two checkouts or agents can build side by side
 *   E2E_OUTPUT_DIR     Playwright output directory (absolute path), so concurrent runs do not clear each other's traces
 *   E2E_PG_URL         admin connection (default postgres://postgres:test@localhost:55437/postgres)
 * Arguments after `--` go to `playwright test`.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runDir = path.join(root, "e2e", ".run");
const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
const adminUrl = process.env.E2E_PG_URL ?? "postgres://postgres:test@localhost:55437/postgres";
const distSuffix = process.env.E2E_DIST_SUFFIX ?? "";
const runId = `${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
const children = new Set();
let dbNames = [];

const log = (m) => console.log(`[e2e] ${m}`);

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** ENV and ARG lines of the Dockerfile stages, so the production check uses the real flags. */
function dockerfileFlags() {
  const stages = {};
  let current = "";
  for (const raw of readFileSync(path.join(root, "Dockerfile"), "utf8").split("\n")) {
    const line = raw.trim();
    const from = /^FROM\s+\S+\s+AS\s+(\w+)/i.exec(line);
    if (from) current = from[1];
    const envLine = /^(ENV|ARG)\s+(.*)$/i.exec(line);
    if (!envLine || !current) continue;
    for (const pair of envLine[2].split(/\s+/)) {
      const [k, ...v] = pair.split("=");
      if (k && v.length) (stages[current] ??= {})[k] = v.join("=");
    }
  }
  return stages;
}

function runCommand(cmd, args, env, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: root, env, stdio: ["ignore", "inherit", "inherit"] });
    children.add(child);
    child.on("exit", (code) => {
      children.delete(child);
      if (code === 0) resolve();
      else reject(new Error(`${label} exited with ${code}`));
    });
  });
}

async function waitFor(url, ms, child) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`server exited early with ${child.exitCode}`);
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function createDatabase(name) {
  const sql = postgres(adminUrl, { max: 1 });
  try {
    await sql.unsafe(`create database "${name}"`);
  } finally {
    await sql.end();
  }
  dbNames.push(name);
}

async function dropDatabases() {
  if (dbNames.length === 0) return;
  const sql = postgres(adminUrl, { max: 1 });
  try {
    for (const name of dbNames) await sql.unsafe(`drop database if exists "${name}" with (force)`).catch((e) => log(`drop ${name}: ${e.message}`));
  } finally {
    await sql.end();
  }
  dbNames = [];
}

function baseEnv() {
  const env = { ...process.env };
  // Never inherit app configuration from the caller's shell.
  for (const k of Object.keys(env)) if (/^(E2E_|DATABASE_|NEXT_|APP_URL|CRON_|MAILBOX_|LINKEDIN_|AI_|GRID_|RUN_MIGRATIONS|EMBEDDED_)/.test(k) && k !== "E2E_SKIP_BUILD" && k !== "E2E_PG_URL" && k !== "E2E_DIST_SUFFIX" && k !== "E2E_OUTPUT_DIR") delete env[k];
  delete env.NODE_ENV;
  env.NEXT_TELEMETRY_DISABLED = "1";
  return env;
}

function databaseUrl(database) {
  const u = new URL(adminUrl);
  u.pathname = `/${database}`;
  return u.toString();
}

function appEnv({ port, database, distDir, secrets, helpers }) {
  return {
    ...baseEnv(),
    NODE_ENV: "production",
    NEXT_DIST_DIR: distDir,
    PORT: String(port),
    DATABASE_URL: databaseUrl(database),
    DATABASE_SSL: "disable",
    APP_URL: `http://localhost:${port}`,
    BETTER_AUTH_SECRET: `e2e-auth-${secrets}`.padEnd(40, "x"),
    INTEGRATION_CREDENTIALS_KEY: `e2e-cred-${secrets}`.padEnd(40, "y"),
    UNSUBSCRIBE_SECRET: `e2e-unsub-${secrets}`.padEnd(40, "z"),
    CRON_SECRET: `e2e-cron-${secrets}`.padEnd(24, "c"),
    MAILBOX_PROVIDER: "fake",
    LINKEDIN_PROVIDER: "fake",
    AI_PROVIDER: "fake",
    GRID_PROVIDER: "fake",
    GOOGLE_SERVICE_ACCOUNT_FILE: "",
    GOOGLE_SERVICE_ACCOUNT_JSON: "",
    RESEND_API_KEY: "",
    EMBEDDED_SCHEDULER: "false",
    ...(helpers ? { E2E_DEV_HELPERS: "1", E2E_FAKE_CONTROLS: "1" } : {}),
  };
}

async function startServer({ name, env, logFile }) {
  const out = createWriteStream(logFile);
  const child = spawn(process.execPath, [nextBin, "start", "-p", env.PORT], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  children.add(child);
  log(`${name} server pid ${child.pid} on port ${env.PORT}, log ${path.relative(root, logFile)}`);
  await waitFor(`http://127.0.0.1:${env.PORT}/api/health`, 120_000, child);
  return child;
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 8000);
    child.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

let tearingDown = false;
async function teardown() {
  if (tearingDown) return;
  tearingDown = true;
  for (const c of [...children]) await stopChild(c);
  await dropDatabases();
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    teardown().finally(() => process.exit(130));
  });
}

/**
 * `next build` with a custom distDir rewrites tsconfig.json (adds the dist types to `include`, reformats it).
 * The file is not ours to change, so put the original bytes back after each build.
 */
const tsconfigPath = path.join(root, "tsconfig.json");
const tsconfigOriginal = readFileSync(tsconfigPath, "utf8");
const restoreTsconfig = () => {
  if (readFileSync(tsconfigPath, "utf8") !== tsconfigOriginal) writeFileSync(tsconfigPath, tsconfigOriginal);
};

async function main() {
  mkdirSync(runDir, { recursive: true });
  const flags = dockerfileFlags();
  const build = baseEnv();

  const skip = process.env.E2E_SKIP_BUILD;
  if (skip !== "1") {
    log("building the test build (E2E_BUILD=1)");
    await runCommand(process.execPath, [nextBin, "build"], { ...build, NODE_ENV: "production", NEXT_DIST_DIR: `.next-e2e${distSuffix}`, E2E_BUILD: "1" }, "next build (e2e)").finally(restoreTsconfig);
  }
  if (skip !== "1" && skip !== "prod") {
    log("building the production-image build (Dockerfile build flags, no E2E_BUILD)");
    // Build stage of the Dockerfile: its ENV/ARG lines and nothing else.
    await runCommand(process.execPath, [nextBin, "build"], { ...build, ...(flags.build ?? {}), NEXT_DIST_DIR: `.next-e2e-prod${distSuffix}` }, "next build (prod)").finally(restoreTsconfig);
  }

  const [portA, portB] = [await freePort(), await freePort()];
  const dbA = `miasdr_e2e_a2_${runId}`;
  const dbB = `miasdr_e2e_a2p_${runId}`;
  await createDatabase(dbA);
  await createDatabase(dbB);

  const envA = appEnv({ port: portA, database: dbA, distDir: `.next-e2e${distSuffix}`, secrets: runId, helpers: true });
  const serverLog = path.join(runDir, "server.log");
  await startServer({ name: "e2e", env: envA, logFile: serverLog });

  // The runner stage of the Dockerfile supplies NODE_ENV and friends; every helper variable is set to "on".
  const envB = { ...appEnv({ port: portB, database: dbB, distDir: `.next-e2e-prod${distSuffix}`, secrets: `p${runId}`, helpers: true }), ...(flags.runner ?? {}), PORT: String(portB) };
  await startServer({ name: "prod-flags", env: envB, logFile: path.join(runDir, "server-prod.log") });

  const pwEnv = {
    ...baseEnv(),
    E2E_BASE_URL: `http://localhost:${portA}`,
    E2E_PROD_URL: `http://localhost:${portB}`,
    E2E_DATABASE_URL: envA.DATABASE_URL,
    E2E_CRON_SECRET: envA.CRON_SECRET,
    E2E_PROD_CRON_SECRET: envB.CRON_SECRET,
    E2E_SERVER_LOG: serverLog,
  };
  const extra = process.argv.slice(2).filter((a) => a !== "--");
  log("running Playwright");
  const pw = spawn(process.execPath, [path.join(root, "node_modules", "@playwright", "test", "cli.js"), "test", "-c", "e2e/playwright.config.ts", ...extra], { cwd: root, env: pwEnv, stdio: "inherit" });
  children.add(pw);
  return await new Promise((resolve) => pw.on("exit", (c) => resolve(c ?? 1)));
}

let code = 1;
try {
  code = await main();
} catch (error) {
  console.error(`[e2e] ${error instanceof Error ? error.message : error}`);
} finally {
  await teardown();
  rmSync(path.join(runDir, "server-prod.log"), { force: true });
}
process.exit(code);
