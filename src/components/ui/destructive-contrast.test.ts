import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * Contrast of the destructive tokens, computed from src/app/globals.css and the variant classes in button.tsx. The tests
 * resolve the oklch values themselves, so a token edit that drops a pair under WCAG AA fails here.
 */

const root = join(__dirname, "..", "..");
const css = readFileSync(join(root, "app/globals.css"), "utf8");
const buttonSource = readFileSync(join(__dirname, "button.tsx"), "utf8");
const menuSource = readFileSync(join(__dirname, "dropdown-menu.tsx"), "utf8");

type Rgb = [number, number, number];

function block(selector: string): Map<string, string> {
  const start = css.indexOf(`\n${selector} {`);
  const end = css.indexOf("\n}", start);
  const tokens = new Map<string, string>();
  for (const match of css.slice(start, end).matchAll(/--([\w-]+):\s*([^;]+);/g)) tokens.set(match[1], match[2].trim());
  return tokens;
}

function resolve(tokens: Map<string, string>, name: string): string {
  let value = tokens.get(name);
  if (!value) throw new Error(`Token --${name} is missing`);
  for (let guard = 0; guard < 5; guard += 1) {
    const ref = value.match(/^var\(--([\w-]+)\)$/);
    if (!ref) break;
    value = tokens.get(ref[1]);
    if (!value) throw new Error(`Token --${ref[1]} is missing`);
  }
  return value;
}

/** Parses `oklch(L C h)` or `oklch(L C h / a%)` into linear-light sRGB (unclamped) and alpha. */
function parseOklch(value: string): { lab: [number, number, number]; alpha: number } {
  const match = value.match(/^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+)(%?))?\s*\)$/);
  if (!match) throw new Error(`Cannot parse ${value}`);
  const [, l, c, h, a, pct] = match;
  const hue = (Number(h) * Math.PI) / 180;
  const alpha = a === undefined ? 1 : pct ? Number(a) / 100 : Number(a);
  return { lab: [Number(l), Number(c) * Math.cos(hue), Number(c) * Math.sin(hue)], alpha };
}

function labToLinear([L, a, b]: [number, number, number]): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}

const clamp = (x: number) => Math.min(1, Math.max(0, x));
const color = (value: string): { rgb: Rgb; alpha: number } => {
  const { lab, alpha } = parseOklch(value);
  return { rgb: labToLinear(lab).map(clamp) as Rgb, alpha };
};

const encode = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const decode = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** Source-over compositing. Browsers blend alpha on the gamma-encoded sRGB values, so the mix happens there. */
const over = (top: { rgb: Rgb; alpha: number }, below: Rgb): Rgb =>
  top.rgb.map((c, i) => decode(encode(c) * top.alpha + encode(below[i]) * (1 - top.alpha))) as Rgb;

const luminance = ([r, g, b]: Rgb) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const ratio = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const WHITE: Rgb = [1, 1, 1];

/** `color-mix(in oklab, fill, black N%)`, as the hover class writes it. */
function mixBlack(value: string, percent: number): Rgb {
  const { lab } = parseOklch(value);
  const mixed: [number, number, number] = [lab[0] * (1 - percent / 100), lab[1] * (1 - percent / 100), lab[2] * (1 - percent / 100)];
  return labToLinear(mixed).map(clamp) as Rgb;
}

const themes = [
  { name: "light", tokens: block(":root"), tint: { button: 0.1, menu: 0.1 } },
  { name: "dark", tokens: block(".dark"), tint: { button: 0.2, menu: 0.2 } },
];

describe("destructive variant contrast", () => {
  it("styles the variant as a solid fill with white text", () => {
    const variant = buttonSource.match(/destructive:\s*"([^"]+)"/)?.[1] ?? "";
    expect(variant).toContain("bg-destructive-solid");
    expect(variant).toContain("text-white");
    expect(variant).not.toMatch(/(^|\s)bg-destructive\//);
  });

  for (const theme of themes) {
    const t = theme.tokens;
    const fillValue = resolve(t, "destructive-solid");

    it(`${theme.name}: white text on the solid fill reaches 4.5:1`, () => {
      expect(ratio(WHITE, color(fillValue).rgb)).toBeGreaterThanOrEqual(4.5);
    });

    it(`${theme.name}: white text on the hover fill reaches 4.5:1`, () => {
      expect(ratio(WHITE, mixBlack(fillValue, 14))).toBeGreaterThanOrEqual(4.5);
    });

    it(`${theme.name}: the disabled button text reaches 3:1 on its surface`, () => {
      const surface = color(resolve(t, "muted")).rgb;
      expect(ratio(color(resolve(t, "muted-foreground")).rgb, surface)).toBeGreaterThanOrEqual(3);
    });

    it(`${theme.name}: destructive text reaches 4.5:1 on the page, a popover and the menu item highlight`, () => {
      const text = color(resolve(t, "destructive"));
      const page = color(resolve(t, "background")).rgb;
      const popover = color(resolve(t, "popover")).rgb;
      expect(ratio(text.rgb, page)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(text.rgb, popover)).toBeGreaterThanOrEqual(4.5);
      const highlight = over({ rgb: text.rgb, alpha: theme.tint.menu }, popover);
      expect(ratio(text.rgb, highlight)).toBeGreaterThanOrEqual(4.5);
      const badge = over({ rgb: text.rgb, alpha: theme.tint.button }, page);
      expect(ratio(text.rgb, badge)).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("keeps the menu item tint at the alphas the test assumes", () => {
    expect(menuSource).toContain("data-[variant=destructive]:focus:bg-destructive/10");
    expect(menuSource).toContain("dark:data-[variant=destructive]:focus:bg-destructive/20");
  });
});
