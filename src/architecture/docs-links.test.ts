import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");

/** Markdown the project ships to users and contributors. A local read-only reference clone stays out. */
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "reference"]);

function markdownFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!SKIP_DIRS.has(name)) markdownFiles(path, out);
    } else if (name.endsWith(".md")) out.push(path);
  }
  return out;
}

const files = [
  ...["README.md", ".github/SECURITY.md", ".github/CODE_OF_CONDUCT.md", "CONTRIBUTING.md"].filter((f) => existsSync(join(root, f))).map((f) => join(root, f)),
  ...markdownFiles(join(root, "docs")),
];

/** GitHub-style heading anchor. */
const slug = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");

function anchors(path: string): Set<string> {
  const text = readFileSync(path, "utf8").replace(/```[\s\S]*?```/g, "");
  return new Set([...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1])));
}

function links(path: string): string[] {
  const text = readFileSync(path, "utf8").replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  return [...text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => m[1]);
}

describe("documentation links", () => {
  it("covers the files this test is meant to guard", () => {
    const names = files.map((f) => relative(root, f));
    for (const expected of ["README.md", ".github/SECURITY.md", ".github/CODE_OF_CONDUCT.md", "CONTRIBUTING.md", "docs/responsible-use.md", "docs/guides/quick-start.md", "docs/guides/how-it-works.md"]) expect(names).toContain(expected);
  });

  it("resolves every relative link to a file and every anchor to a heading", () => {
    const broken: string[] = [];
    for (const file of files) {
      for (const link of links(file)) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(link)) continue;
        const [target, anchor] = link.split("#");
        const path = target ? resolve(dirname(file), decodeURI(target)) : file;
        if (!existsSync(path)) {
          broken.push(`${relative(root, file)} -> ${link} (missing file)`);
          continue;
        }
        if (anchor && path.endsWith(".md") && !anchors(path).has(anchor)) broken.push(`${relative(root, file)} -> ${link} (missing heading)`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("links the responsible-use page from the README", () => {
    expect(readFileSync(join(root, "README.md"), "utf8")).toContain("docs/responsible-use.md");
  });
});
