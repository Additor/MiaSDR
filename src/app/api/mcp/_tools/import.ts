import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { importLeads, previewImport } from "@/contexts/people/application/import-leads";
import { CORE_TARGETS, type Mapping } from "@/contexts/people/domain/import-plan";
import { leadImportDeps } from "@/contexts/people/infrastructure/composition";
import { normalizePhoneCountry } from "@/contexts/tenancy/domain/phone-country";
import { parseSpreadsheet } from "@/platform/files/spreadsheet";
import { ConflictError, ValidationError, type Actor } from "@/shared/errors";
import { CHANGES, defineTool } from "./define";

/** What one agent import may carry. The Leads page takes larger files; an agent sends the text in its own context. */
export const MAX_AGENT_CSV_BYTES = 256 * 1024;
export const MAX_AGENT_IMPORT_ROWS = 500;
/** How long a preview waits for its commit. */
export const PREVIEW_TTL_MS = 10 * 60_000;
/** Previews held at once across the process; the oldest goes first. */
const MAX_PREVIEWS = 50;

interface Preview {
  organizationId: string;
  userId: string;
  headers: string[];
  rows: Array<Record<string, string>>;
  mapping: Mapping;
  defaultCountry: string | undefined;
  csvHash: string;
  expiresAt: number;
}

/**
 * Previews kept between `preview` and `commit`, in this process's memory, so the agent sends the CSV once. A commit that
 * reaches another process, or comes after a restart or ten minutes, finds no preview and asks for a new one.
 */
const previews = new Map<string, Preview>();

function keep(token: string, preview: Preview, now: number) {
  for (const [key, held] of previews) if (held.expiresAt <= now) previews.delete(key);
  while (previews.size >= MAX_PREVIEWS) previews.delete(previews.keys().next().value as string);
  previews.set(token, preview);
}

/** The preview behind a token, for the same person in the same organization only. Taking it removes it. */
function take(token: string, actor: Actor, now: number): Preview {
  const preview = previews.get(token);
  if (!preview || preview.expiresAt <= now || preview.organizationId !== actor.organizationId || preview.userId !== actor.userId) {
    throw new ConflictError("This preview expired or is unknown. Run preview again, then commit with its new previewToken.", { code: "preview_expired" });
  }
  previews.delete(token);
  return preview;
}

const target = z.union([z.literal("skip"), z.enum(CORE_TARGETS), z.string().regex(/^custom:.+$/)]);
const ACTIONS = ["preview", "commit"] as const;

export const importLeadsTool = defineTool({
  name: "import_leads",
  title: "Import leads",
  description: [
    "Imports leads from CSV text, as the Leads import does. `preview` takes `csvText` (a header row, up to 500 rows and 256 KB) and `mapping` from each header to a field",
    `(${CORE_TARGETS.join(", ")}), \`custom:<name>\` or \`skip\`, and optional \`defaultCountry\` for phone numbers. It answers what the import would create, update and skip, and a \`previewToken\`.`,
    "`commit` imports that preview with its `previewToken` within 10 minutes. Existing leads match by email or LinkedIn profile.",
  ].join(" "),
  scope: "mcp:write",
  annotations: CHANGES,
  input: z.object({
    action: z.enum(ACTIONS),
    csvText: z.string().optional(),
    mapping: z.record(z.string(), target).optional(),
    defaultCountry: z.string().optional(),
    previewToken: z.string().optional(),
  }),
  output: z.object({
    action: z.enum(ACTIONS),
    previewToken: z.string().nullable(),
    summary: z.object({ totalRows: z.number(), created: z.number(), updated: z.number(), unchanged: z.number(), skipped: z.array(z.unknown()), duplicates: z.unknown(), ignored: z.unknown(), overwrites: z.array(z.unknown()) }).nullable(),
    report: z.object({ runId: z.string(), stats: z.record(z.string(), z.number()), issues: z.unknown() }).nullable(),
  }),
  buckets: (input) => (input.action === "commit" ? ["write", "import"] : ["write"]),
  async run({ actor }, input) {
    const now = Date.now();
    if (input.action === "preview") {
      if (!input.csvText || !input.mapping) throw new ValidationError("preview needs csvText and mapping.");
      const bytes = Buffer.from(input.csvText, "utf8");
      if (bytes.length > MAX_AGENT_CSV_BYTES) throw new ValidationError(`Keep the CSV to ${MAX_AGENT_CSV_BYTES / 1024} KB. Split it into several imports.`);
      const { headers, rows } = await parseSpreadsheet(bytes, "agent-import.csv");
      if (rows.length === 0) throw new ValidationError("The CSV has a header row and no leads.");
      if (rows.length > MAX_AGENT_IMPORT_ROWS) throw new ValidationError(`Keep one import to ${MAX_AGENT_IMPORT_ROWS} rows. Split the file.`);
      const mapping = input.mapping as Mapping;
      const defaultCountry = normalizePhoneCountry((input.defaultCountry ?? "").toUpperCase()) ?? undefined;
      const summary = await previewImport(leadImportDeps(), { organizationId: actor.organizationId, headers, rows, mapping, defaultCountry, role: actor.role });
      const previewToken = randomBytes(18).toString("base64url");
      const csvHash = createHash("sha256").update(bytes).digest("hex");
      keep(previewToken, { organizationId: actor.organizationId, userId: actor.userId, headers, rows, mapping, defaultCountry, csvHash, expiresAt: now + PREVIEW_TTL_MS }, now);
      return {
        summary: `Would create ${summary.created}, update ${summary.updated} and leave ${summary.unchanged} unchanged of ${summary.totalRows} row(s). Commit with the previewToken within 10 minutes.`,
        structured: { action: input.action, previewToken, summary, report: null },
      };
    }
    if (!input.previewToken) throw new ValidationError("commit needs the previewToken from preview.");
    const preview = take(input.previewToken, actor, now);
    // The preview holds the organization and the person `take` matched to the actor.
    const report = await importLeads(leadImportDeps(), { ...preview, filename: `agent import ${preview.csvHash.slice(0, 8)}.csv`, role: actor.role });
    const { stats } = report;
    return {
      summary: `Imported: ${stats.created} created, ${stats.updated} updated, ${stats.unchanged} unchanged, ${stats.invalid} invalid.`,
      structured: { action: input.action, previewToken: null, summary: null, report },
    };
  },
});
