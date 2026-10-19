// Completeness of the translations: every text the code or the pages mark
// for translation has a French and a Spanish entry with the same {placeholders}.
//
//   node scripts/i18n-check.mjs                 every source
//   node scripts/i18n-check.mjs src/terminal.js only these files
//
// Marked in JavaScript: t("..."), tk("..."), tn("one", "other", n) and
// tc("context", "..."), whose entry is "context\u0004...". The text
// arguments must be double-quoted literals. Marked in HTML: the text of
// a data-i18n element, the inner HTML of a data-i18n-html element, the
// attributes a data-i18n-attr lists.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STRING = String.raw`"((?:[^"\\\n]|\\.)*)"`;
const CALLS = [
  { re: new RegExp(String.raw`(?<![\w.$])t\(\s*${STRING}`, "g"), groups: [1] },
  { re: new RegExp(String.raw`(?<![\w.$])tk\(\s*${STRING}`, "g"), groups: [1] },
  { re: new RegExp(String.raw`(?<![\w.$])tn\(\s*${STRING}\s*,\s*${STRING}`, "g"), groups: [1, 2] },
  { re: new RegExp(String.raw`(?<![\w.$])tc\(\s*${STRING}\s*,\s*${STRING}`, "g"), groups: [1, 2], context: true },
];
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
    e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e] ?? m),
  );
const squash = (s) => s.replace(/\s+/g, " ").trim();
const lineOf = (text, index) => text.slice(0, index).split("\n").length;

/** Every marked text of a JavaScript file: [{ key, line }]. */
export function jsKeys(text) {
  const found = [];
  for (const { re, groups, context } of CALLS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      if (context) {
        try {
          found.push({ key: `${JSON.parse(`"${m[1]}"`)}\u0004${JSON.parse(`"${m[2]}"`)}`, line: lineOf(text, m.index) });
        } catch {
          found.push({ key: null, line: lineOf(text, m.index), problem: `cannot read the context string ${m[0].slice(0, 60)}` });
        }
        continue;
      }
      for (const g of groups) {
        let key;
        try {
          key = JSON.parse(`"${m[g]}"`);
        } catch {
          found.push({ key: null, line: lineOf(text, m.index), problem: `cannot read the string ${m[g].slice(0, 60)}` });
          continue;
        }
        found.push({ key, line: lineOf(text, m.index) });
      }
    }
  }
  return found;
}

/** Every marked text of an HTML page: [{ key, line }], plus markup problems. */
export function htmlKeys(html) {
  const found = [];
  const tagRe = /<([a-z][a-z0-9-]*)\b([^>]*)>/gi;
  let m;
  while ((m = tagRe.exec(html))) {
    const [whole, tag, attrs] = m;
    const line = lineOf(html, m.index);
    const has = (name) => new RegExp(String.raw`\s${name}(?=[\s=>/]|$)`).test(attrs);
    if (has("data-i18n") || has("data-i18n-html")) {
      const start = m.index + whole.length;
      const close = html.indexOf(`</${tag}>`, start);
      if (close < 0) found.push({ key: null, line, problem: `<${tag}> marked for translation has no closing tag` });
      else {
        const inner = html.slice(start, close);
        if (has("data-i18n")) {
          if (/<[a-z]/i.test(inner)) found.push({ key: null, line, problem: `data-i18n on <${tag}> with markup inside: use data-i18n-html` });
          else found.push({ key: squash(decode(inner)), line });
        } else found.push({ key: squash(inner), line });
      }
    }
    const list = /\sdata-i18n-attr="([^"]*)"/.exec(attrs);
    if (list) {
      for (const name of list[1].split(/\s+/).filter(Boolean)) {
        const value = new RegExp(String.raw`\s${name}="([^"]*)"`).exec(attrs);
        if (!value) found.push({ key: null, line, problem: `data-i18n-attr names ${name}, which <${tag}> does not have` });
        else found.push({ key: decode(value[1]), line });
      }
    }
  }
  return found;
}

const placeholders = (s) =>
  [...String(s).matchAll(/\{(\w+)\}/g)]
    .map((m) => m[1])
    .sort()
    .join(",");

/** The default sources: every module of src/ except the language module, and both pages. */
export function sources() {
  const src = readdirSync(join(ROOT, "src"))
    .filter((f) => f.endsWith(".js") && f !== "i18n.js")
    .map((f) => `src/${f}`);
  return [...src, "index.html", "history.html"];
}

async function load(lang) {
  const parts = {};
  for (const f of readdirSync(join(ROOT, "src", "locales", lang)).filter((f) => f.endsWith(".js") && f !== "index.js")) {
    parts[f] = (await import(pathToFileURL(join(ROOT, "src", "locales", lang, f)).href)).default;
  }
  const merged = (await import(pathToFileURL(join(ROOT, "src", "locales", lang, "index.js")).href)).default;
  return { parts, merged };
}

/**
 * Checks `files` (paths relative to web/). Returns { missing, mismatched,
 * problems, conflicts, unused, keys }: what is missing per language, which
 * translations change the placeholders, markup that cannot be read, a key
 * translated differently in two module files, and keys no source uses
 * (only when every source is checked).
 */
export async function check(files = sources()) {
  const dicts = { fr: await load("fr"), es: await load("es") };
  const out = { missing: [], mismatched: [], problems: [], conflicts: [], unused: [], keys: 0 };
  const used = new Set();
  const counted = new Set();
  for (const file of files) {
    const text = readFileSync(join(ROOT, file), "utf8");
    const found = file.endsWith(".html") ? htmlKeys(text) : jsKeys(text);
    for (const { key, line, problem } of found) {
      if (problem) {
        out.problems.push(`${file}:${line} ${problem}`);
        continue;
      }
      if (!key || counted.has(`${file}\u0000${key}`)) continue;
      counted.add(`${file}\u0000${key}`);
      used.add(key);
      out.keys += 1;
      for (const lang of ["fr", "es"]) {
        const value = dicts[lang].merged[key];
        if (typeof value !== "string" || !value.trim()) out.missing.push(`${lang} ${file}:${line} ${JSON.stringify(key)}`);
        else if (placeholders(value) !== placeholders(key)) out.mismatched.push(`${lang} ${file}:${line} ${JSON.stringify(key)} -> ${JSON.stringify(value)}`);
      }
    }
  }
  const everything = files.length === sources().length;
  for (const lang of ["fr", "es"]) {
    const seen = new Map();
    for (const [part, dict] of Object.entries(dicts[lang].parts)) {
      for (const [key, value] of Object.entries(dict)) {
        if (seen.has(key) && seen.get(key).value !== value) out.conflicts.push(`${lang} ${JSON.stringify(key)}: ${seen.get(key).part} and ${part} differ`);
        else if (!seen.has(key)) seen.set(key, { part, value });
      }
    }
    if (everything) for (const key of Object.keys(dicts[lang].merged)) if (!used.has(key)) out.unused.push(`${lang} ${JSON.stringify(key)}`);
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const files = process.argv.slice(2).map((f) => relative(ROOT, join(process.cwd(), f)).split("\\").join("/"));
  const result = await check(files.length ? files : sources());
  const section = (title, list) => list.length && console.log(`\n${title} (${list.length}):\n  ${list.join("\n  ")}`);
  section("Missing", result.missing);
  section("Placeholders differ", result.mismatched);
  section("Markup", result.problems);
  section("Translated differently in two files", result.conflicts);
  section("Unused (warning)", result.unused);
  const bad = result.missing.length + result.mismatched.length + result.problems.length + result.conflicts.length;
  console.log(`\n${result.keys} marked texts checked; ${bad ? `${bad} problem(s)` : "complete in French and Spanish"}.`);
  process.exitCode = bad ? 1 : 0;
}
