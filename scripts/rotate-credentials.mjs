#!/usr/bin/env node
/**
 * Re-encrypts stored credentials with the current INTEGRATION_CREDENTIALS_KEY.
 *
 *   pnpm credentials:rotate            dry run, writes nothing
 *   pnpm credentials:rotate --apply    writes
 *
 * Reads DATABASE_URL, DATABASE_SSL, INTEGRATION_CREDENTIALS_KEY and INTEGRATION_CREDENTIALS_LEGACY_KEYS
 * (comma separated). Scans integration_credentials and grid_provider_credentials, decrypts each row with
 * any known key, and re-encrypts it with the current key in one transaction per row. Rows already on the
 * current key are opened to prove they decrypt, then skipped. Rows no known key can decrypt are listed and left untouched. Output carries
 * counts, key ids (first 8 hex characters of SHA-256) and row ids, never key material or plaintext.
 * Exit code: 0 clean, 1 bad usage or configuration, 2 some rows could not be decrypted.
 *
 * This file runs under plain `node` in the production image, so it cannot import TypeScript. The envelope
 * code below repeats src/contexts/integrations/infrastructure/credential-crypto.ts. The test
 * src/contexts/integrations/infrastructure/__tests__/credential-rotation.test.ts encrypts with one and decrypts with the other in both directions.
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

const CURRENT_VERSION = "v2";
const LEGACY_VERSION = "v1";
const INFO = "miasdr:integration-credentials:v1";

export const TABLES = [
  { table: "integration_credentials", pk: "account_id" },
  { table: "grid_provider_credentials", pk: "provider_id" },
];

function deriveKey(secret) {
  if (secret.length < 32) throw new Error("A credential key must be at least 32 characters.");
  return Buffer.from(hkdfSync("sha256", secret, "", INFO, 32));
}

export function credentialKeyId(secret) {
  return createHash("sha256").update(secret).digest("hex").slice(0, 8);
}

export function encryptCredential(plaintext, secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(secret), iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [CURRENT_VERSION, credentialKeyId(secret), iv.toString("base64url"), tag.toString("base64url"), body.toString("base64url")].join(":");
}

function open(secret, iv, tag, body) {
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(secret), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}

/**
 * Returns the plaintext and the id of the key that worked, or throws with a reason free of key material.
 * @param {string} envelope
 * @param {string[]} keys
 * @returns {{ plaintext: string, keyId: string }}
 */
export function decryptWithKeys(envelope, keys) {
  const parts = envelope.split(":");
  if (parts[0] === CURRENT_VERSION && parts.length === 5 && parts[2] && parts[3] && parts[4] !== undefined) {
    const [, keyId, iv, tag, body] = parts;
    const match = keys.find((key) => credentialKeyId(key) === keyId);
    if (!match) throw new Error(`no known key for key id ${keyId}`);
    try {
      return { plaintext: open(match, iv, tag, body), keyId };
    } catch {
      throw new Error(`authentication failed for key id ${keyId}`);
    }
  }
  if (parts[0] === LEGACY_VERSION && parts.length === 4 && parts[1] && parts[2] && parts[3] !== undefined) {
    const [, iv, tag, body] = parts;
    for (const key of keys) {
      try {
        return { plaintext: open(key, iv, tag, body), keyId: credentialKeyId(key) };
      } catch {
        // try the next key
      }
    }
    throw new Error("no known key decrypts this v1 envelope");
  }
  throw new Error("unsupported envelope");
}

function classify(envelope, currentKey, keys) {
  const currentId = credentialKeyId(currentKey);
  try {
    // A row on the current key id is opened too: a truncated payload or a bad tag is undecryptable, not current.
    const { plaintext, keyId } = decryptWithKeys(envelope, keys);
    if (envelope.startsWith(`${CURRENT_VERSION}:${currentId}:`)) return { status: "current", keyId: currentId };
    return { status: "rotate", keyId, plaintext };
  } catch (error) {
    return { status: "undecryptable", reason: error instanceof Error ? error.message : "unknown error" };
  }
}

/**
 * `sql` is a postgres.js client. Returns a report per table:
 * `{ total, current, rotated, undecryptable: [{ id, reason }], bySourceKey: { <keyId>: count } }`.
 * `rotated` counts rows written with `apply`, or rows that would be written without it.
 *
 * @typedef {{ total: number, current: number, rotated: number, undecryptable: { id: string, reason: string }[], bySourceKey: Record<string, number> }} TableReport
 * @typedef {{ apply: boolean, currentKeyId: string, legacyKeyIds: string[], tables: Record<string, TableReport> }} RotationReport
 * @param {{ sql: any, currentKey: string, legacyKeys?: string[], apply?: boolean }} options
 * @returns {Promise<RotationReport>}
 */
export async function rotateCredentials({ sql, currentKey, legacyKeys = [], apply = false }) {
  const keys = [currentKey, ...legacyKeys];
  /** @type {RotationReport} */
  const report = { apply, currentKeyId: credentialKeyId(currentKey), legacyKeyIds: legacyKeys.map(credentialKeyId), tables: {} };
  for (const { table, pk } of TABLES) {
    /** @type {TableReport} */
    const t = { total: 0, current: 0, rotated: 0, undecryptable: [], bySourceKey: {} };
    report.tables[table] = t;
    const rows = await sql.unsafe(`select ${pk} as id from ${table} order by ${pk}`);
    for (const { id } of rows) {
      t.total += 1;
      const outcome = await sql.begin(async (tx) => {
        const [row] = await tx.unsafe(`select encrypted_payload as payload from ${table} where ${pk} = $1 ${apply ? "for update" : ""}`, [id]);
        if (!row) return { status: "gone" };
        const result = classify(row.payload, currentKey, keys);
        if (result.status !== "rotate" || !apply) return result;
        const next = encryptCredential(result.plaintext, currentKey);
        if (decryptWithKeys(next, [currentKey]).plaintext !== result.plaintext) throw new Error("re-encryption check failed");
        await tx.unsafe(`update ${table} set encrypted_payload = $1, encryption_version = $2, updated_at = now() where ${pk} = $3`, [next, CURRENT_VERSION, id]);
        return result;
      });
      if (outcome.status === "gone") {
        t.total -= 1;
      } else if (outcome.status === "current") {
        t.current += 1;
      } else if (outcome.status === "rotate") {
        t.rotated += 1;
        t.bySourceKey[outcome.keyId] = (t.bySourceKey[outcome.keyId] ?? 0) + 1;
      } else {
        t.undecryptable.push({ id, reason: outcome.reason });
      }
    }
  }
  return report;
}

function formatReport(report) {
  const lines = [report.apply ? "Applied." : "Dry run. Nothing was written. Run with --apply to write.", `Current key id: ${report.currentKeyId}`];
  lines.push(`Legacy key ids: ${report.legacyKeyIds.length ? report.legacyKeyIds.join(", ") : "none"}`);
  for (const [table, t] of Object.entries(report.tables)) {
    const verb = report.apply ? "rotated" : "to rotate";
    const sources = Object.entries(t.bySourceKey).map(([id, n]) => `${id}:${n}`).join(", ");
    lines.push(`${table}: ${t.total} rows, ${t.current} already on the current key, ${t.rotated} ${verb}${sources ? ` (from key id ${sources})` : ""}, ${t.undecryptable.length} undecryptable`);
    for (const { id, reason } of t.undecryptable) lines.push(`  undecryptable ${id}: ${reason}`);
  }
  return lines.join("\n");
}

async function main(argv, env) {
  const flags = argv.filter((a) => a.startsWith("-"));
  const apply = flags.includes("--apply");
  if (argv.length !== flags.length || flags.some((f) => f !== "--apply")) {
    console.error("Usage: rotate-credentials.mjs [--apply]");
    return 1;
  }
  const currentKey = env.INTEGRATION_CREDENTIALS_KEY ?? "";
  const legacyKeys = (env.INTEGRATION_CREDENTIALS_LEGACY_KEYS ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  if (!env.DATABASE_URL) return console.error("DATABASE_URL is not set."), 1;
  if (currentKey.length < 32) return console.error("INTEGRATION_CREDENTIALS_KEY must be set and at least 32 characters."), 1;
  if (legacyKeys.some((k) => k.length < 32)) return console.error("Every key in INTEGRATION_CREDENTIALS_LEGACY_KEYS must be at least 32 characters."), 1;
  const { default: postgres } = await import("postgres");
  const sql = postgres(env.DATABASE_URL, { max: 1, ssl: env.DATABASE_SSL === "disable" ? false : "require", onnotice: () => undefined });
  try {
    const report = await rotateCredentials({ sql, currentKey, legacyKeys, apply });
    console.log(formatReport(report));
    return Object.values(report.tables).some((t) => t.undecryptable.length) ? 2 : 0;
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`Rotation failed: ${error instanceof Error ? error.message : "unknown error"}`);
      process.exit(1);
    },
  );
}
