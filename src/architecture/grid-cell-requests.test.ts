import { readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { parseSource, walk } from "./source-ast";

/**
 * A request about the open table reads or writes stored cells, so it waits for the queued cell edits ("Edit pipeline
 * and conflicts" in docs/decisions.md). Under `src/app/(app)/tables`, `useGridTable` owns the queue and sends those
 * requests; components reach them through `cellRequest` (`useCellRequest`) or a hook method. The rule holds at the
 * import: no other file imports `gridRequest` or `callApi`, or calls `fetch`, unless the list below names it with why
 * the call is no request about stored cells or settles the queue itself.
 */

const ROOT = path.resolve(__dirname, "../..");
const TABLES = path.join(ROOT, "src/app/(app)/tables");
const OWNERS = new Set(["_lib/data/use-grid-table.ts", "_lib/data/client.ts", "_lib/data/cell-request.ts"]);
const ALLOWED: Record<string, string> = {
  "_components/ai-dialog.tsx gridRequest": "the organization's AI status, no table",
  "_components/provider-manager.tsx gridRequest": "providers belong to the organization",
  "_components/push-campaign-dialog.tsx gridRequest": "the campaign list, no table",
  "_components/run-controls.tsx gridRequest": "Stop goes out at once; waiting or refusing would keep a paid run going",
  "_components/table-dialogs.tsx gridRequest": "the workbook list for moving a table",
  "_components/table-workspace.tsx fetch": "export downloads a blob after `grid.settle()`",
  "_components/tables-browser.tsx gridRequest": "folders and workbooks, outside any open table",
  "_components/workbook-view.tsx gridRequest": "workbook and tab requests; a duplicate awaits the open table's `settle` (`onSettle`)",
  "_lib/data/providers.ts gridRequest": "the provider catalog of the organization",
};

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return files(full);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [full] : [];
  });
}

/** "file gridRequest", "file callApi" for each import of them, and "file fetch" for each file that calls `fetch`. */
function requestSenders(): string[] {
  const found = new Set<string>();
  for (const file of files(TABLES)) {
    const rel = path.relative(TABLES, file).split(path.sep).join("/");
    if (OWNERS.has(rel)) continue;
    const sf = parseSource(file);
    walk(sf, (node) => {
      if (ts.isImportSpecifier(node)) {
        const name = (node.propertyName ?? node.name).text;
        if (name === "gridRequest" || name === "callApi") found.add(`${rel} ${name}`);
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "fetch") found.add(`${rel} fetch`);
    });
  }
  return [...found].sort();
}

describe("grid cell requests", () => {
  it("leave requests about the open table to the grid hook", () => {
    expect(requestSenders()).toEqual(Object.keys(ALLOWED).sort());
  });
});
