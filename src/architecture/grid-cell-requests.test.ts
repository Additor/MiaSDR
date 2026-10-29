import { readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { parseSource, walk } from "./source-ast";

/**
 * A request about the open table reads or writes stored cells, so it waits for the queued cell edits ("Edit pipeline
 * and conflicts" in docs/decisions.md). Under `src/app/(app)/tables`, only `useGridTable` (which owns the queue) and
 * `client.ts` call `gridRequest` or `fetch` with a table URL (`gridUrl.sub`, `gridUrl.table`, `gridUrl.view`, a
 * table duplicate). Everything else goes through `cellRequest` (`useCellRequest`) or a hook method. The list below
 * holds the calls that settle the queue themselves, each with how.
 */

const ROOT = path.resolve(__dirname, "../..");
const TABLES = path.join(ROOT, "src/app/(app)/tables");
const OWNERS = new Set(["_lib/data/use-grid-table.ts", "_lib/data/client.ts"]);
const SETTLED = [
  // `exportCsv` awaits `grid.settle()` before the download; the CSV comes as a blob, which `gridRequest` does not read.
  '_components/table-workspace.tsx fetch gridUrl.sub(tableId, "export")',
  // The tab menu sits outside the open table; `duplicate` awaits the open table's `settle`, handed up through `onSettle`.
  "_components/workbook-view.tsx gridRequest `${gridUrl.tables}/${id}/duplicate`",
];
const TABLE_URL = /gridUrl\.(sub|table|view)\(|\/duplicate/;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return files(full);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [full] : [];
  });
}

/** `gridRequest` and `fetch` calls whose URL argument names the table, as "file callee url". */
function tableCalls(): string[] {
  const found: string[] = [];
  for (const file of files(TABLES)) {
    const rel = path.relative(TABLES, file).split(path.sep).join("/");
    if (OWNERS.has(rel)) continue;
    const sf = parseSource(file);
    walk(sf, (node) => {
      if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return;
      const callee = node.expression.text;
      if (callee !== "gridRequest" && callee !== "fetch") return;
      const url = node.arguments[0]?.getText(sf) ?? "";
      if (TABLE_URL.test(url)) found.push(`${rel} ${callee} ${url}`);
    });
  }
  return found.sort();
}

describe("grid cell requests", () => {
  it("send every request about the open table after the queued cell edits", () => {
    expect(tableCalls()).toEqual([...SETTLED].sort());
  });
});
