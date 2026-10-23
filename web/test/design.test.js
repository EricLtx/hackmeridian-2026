// The stylesheet against the accessibility rules recorded in web/DESIGN.md:
// control outlines at 3:1 against their surface in every palette, and
// 44 px targets on touch screens. Read from src/style.css itself, so that a
// change of token or rule that breaks a rule fails here.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");

/** The body of the first block opened by `head` (a selector or an at-rule), braces balanced. */
function block(head, from = 0) {
  const start = css.indexOf(head, from);
  assert.notEqual(start, -1, `no block ${head}`);
  let i = css.indexOf("{", start) + 1;
  const open = i;
  for (let depth = 1; depth; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") depth -= 1;
  }
  return css.slice(open, i - 1);
}

const tokensOf = (text) => Object.fromEntries([...text.matchAll(/--([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)].map((m) => [m[1], m[2]]));
const light = tokensOf(block(":root {"));
const dark = { ...light, ...tokensOf(block(":root {", css.indexOf("@media (prefers-color-scheme: dark)"))) };
const terminal = { ...light, ...tokensOf(block("body.face-terminal {")) };

function luminance(hex) {
  const h = hex.length === 4 ? hex.slice(1).replace(/./g, (c) => c + c) : hex.slice(1, 7);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** The colour token of a rule's border, from `border:` or `border-color:`. */
function borderToken(selector) {
  const body = block(`\n${selector} {`);
  const m = body.match(/border(?:-color)?\s*:[^;]*var\(--([a-z0-9-]+)\)/);
  assert.ok(m, `${selector} has a border drawn with a token`);
  return m[1];
}

test("interactive outlines reach 3:1 against their surface in every palette", () => {
  const cases = [
    [".chip", [light, dark]],
    [".btn-ghost", [light, dark]],
    [".step-mark", [light, dark]],
    [".term kbd", [terminal]],
  ];
  for (const [selector, palettes] of cases) {
    const token = borderToken(selector);
    for (const palette of palettes) {
      const ratio = contrast(palette[token], palette.surface);
      assert.ok(ratio >= 3, `${selector} outline --${token} at ${ratio.toFixed(2)}:1`);
    }
  }
});

test("touch screens get 44 px targets on the small controls", () => {
  const coarse = block("@media (pointer: coarse)");
  for (const selector of [".face-btn", ".btn-small", ".input-small input", ".chip", ".t-key", ".tab", ".lang-btn"]) {
    assert.ok(coarse.includes(selector), `${selector} is enlarged on touch screens`);
  }
  const heights = [...coarse.matchAll(/min-height:\s*(\d+)px/g)].map((m) => Number(m[1]));
  assert.ok(heights.length && heights.every((h) => h >= 44), "every enlarged control is at least 44 px high");
});

test("the Operate grid never asks for more width than a 320 px phone has", () => {
  const grid = block("\n.operate-grid {");
  assert.match(grid, /minmax\(min\(\d+px, 100%\), 1fr\)/, "the column minimum yields to the available width");
});

test("every text token reaches 4.5:1 on every surface, in the three palettes", () => {
  const texts = ["text", "muted", "accent", "ok", "warn", "danger"];
  const surfaces = ["bg", "surface", "surface-2", "surface-3"];
  for (const [name, palette] of [["light", light], ["dark", dark], ["terminal", terminal]]) {
    for (const fg of [...texts, ...(name === "terminal" ? ["t-id"] : [])]) {
      for (const bg of surfaces) {
        const ratio = contrast(palette[fg], palette[bg]);
        assert.ok(ratio >= 4.5, `${name}: --${fg} on --${bg} at ${ratio.toFixed(2)}:1`);
      }
    }
    for (const state of ["accent", "ok", "warn", "danger"]) {
      const ratio = contrast(palette[state], palette[`${state}-soft`]);
      assert.ok(ratio >= 4.5, `${name}: --${state} on --${state}-soft at ${ratio.toFixed(2)}:1`);
    }
    const label = contrast(palette["accent-text"], palette["accent-strong"]);
    assert.ok(label >= 4.5, `${name}: primary button label at ${label.toFixed(2)}:1`);
  }
});

test("font sizes come from the type scale, or are relative to their parent", () => {
  const sizes = [...css.matchAll(/font-size:\s*([^;]+);/g)].map((m) => m[1].trim());
  const off = sizes.filter((v) => !/^var\(--fs-[a-z0-9]+\)$/.test(v) && !/^[0-9.]+em$/.test(v));
  assert.deepEqual(off, [], "every font-size reads a --fs- token");
});

test("the palette colours are Stellar Design System values", () => {
  // The steps of @stellar/design-system 4.0.2 the palettes use (NOTICE).
  const sds = new Set([
    "#ffffff", "#000000",
    "#f8f8f8", "#f3f3f3", "#e2e2e2", "#dbdbdb", "#8f8f8f", "#858585", "#6f6f6f", "#171717",
    "#161616", "#1c1c1c", "#232323", "#282828", "#2e2e2e", "#343434", "#3e3e3e", "#505050", "#707070", "#a0a0a0", "#ededed",
    "#f5f2ff", "#6e56cf", "#644fc1", "#5746af", "#251e40", "#9e8cfc",
    "#e9f9ee", "#18794e", "#0f291e", "#4cc38a",
    "#fff4d5", "#ad5700", "#341c00", "#f1a10d", "#ffb224", "#ffcb47",
    "#2c2100", "#fdda24",
    "#ffefef", "#cd2b31", "#3c181a", "#ff6369",
    "#849dff",
  ]);
  for (const [name, palette] of [["light", light], ["dark", dark], ["terminal", terminal]]) {
    for (const [token, value] of Object.entries(palette)) {
      assert.ok(sds.has(value.toLowerCase()), `${name}: --${token} ${value} is not an SDS step`);
    }
  }
});
