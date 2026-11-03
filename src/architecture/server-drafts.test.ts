import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sourceFiles } from "./context-layers";

/**
 * A form that guards unsaved changes holds text a person can lose, so it must also tell their edit from the server's value
 * changing under it (`useServerDraft`). `useState(saved)` shows a colleague's change as this person's unsaved edit, and Save
 * writes the old value back.
 */
const ROOT = path.resolve(__dirname, "../..");
const OWN_DRAFT: Record<string, string> = {
  "src/app/(app)/settings/account/account-panel.tsx": "A person's own name, which nobody else changes.",
  "src/app/(app)/settings/instructions/instructions-panel.tsx": "Follows the server's copy itself: two lists on one screen keep each other's edits by content.",
  "src/app/(app)/campaigns/[id]/_components/after-reply-editor.tsx": "Holds four parallel lists that follow one saved copy. It reports its edits to Start, which refuses until they are saved.",
};

describe("forms that guard unsaved changes", () => {
  it("use useServerDraft, or sit in the list with a reason", () => {
    const files = sourceFiles(path.join(ROOT, "src/app"));
    const offenders = files
      .filter((file) => !file.endsWith("settings-form.tsx"))
      .filter((file) => {
        const text = readFileSync(file, "utf8");
        return text.includes("useLeaveGuard(") && !text.includes("useServerDraft");
      })
      .map((file) => path.relative(ROOT, file));
    expect(offenders.sort()).toEqual(Object.keys(OWN_DRAFT).sort());
  });
});
