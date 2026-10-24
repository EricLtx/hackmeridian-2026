// Which parts of the repository a change touches, so that a pull request
// runs only the CI jobs its files need (.github/workflows/ci.yml, job
// `changes`). The areas: `rust` (the contracts and the Cargo workspace),
// `web` (the interface), `tooling` (demo/ and indexer/), `docs` (Markdown
// anywhere), `ci` (.github/). The rule errs on the side of running: a path
// no area claims, a change under .github/, an event other than a pull
// request, or a diff that cannot be read turns every area on. The contracts'
// WASM feeds the demo's upgrade test and the web's deployment checks, so a
// Rust change also runs `web` and `tooling`. Node standard library only.
//
//   node .github/scripts/changes.mjs            (in a workflow step; reads
//     EVENT_NAME, BASE_SHA, HEAD_SHA and appends to $GITHUB_OUTPUT)

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { criticalAreas } from "./critical.mjs";

export const AREAS = ["rust", "web", "tooling", "docs", "ci"];

const RUST = /^(Cargo\.toml|Cargo\.lock|rust-toolchain\.toml|deny\.toml|rustfmt\.toml|contracts\/)/;
const TOOLING = /^(demo|indexer)\//;

/** Every area on: the answer whenever the change is not fully understood. */
const everything = () => Object.fromEntries(AREAS.map((a) => [a, true]));

/**
 * The areas the changed `paths` (repository-relative, forward slashes)
 * touch, as `{rust, web, tooling, docs, ci}` booleans. A Markdown file adds
 * `docs` to the area of its folder (web/README.md is web and docs).
 */
export function classify(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return everything();
  const on = Object.fromEntries(AREAS.map((a) => [a, false]));
  for (const p of paths) {
    if (typeof p !== "string" || p === "") return everything();
    if (p.startsWith(".github/")) return everything();
    let claimed = false;
    if (RUST.test(p)) on.rust = claimed = true;
    if (p.startsWith("web/")) on.web = claimed = true;
    if (TOOLING.test(p)) on.tooling = claimed = true;
    if (/\.md$/i.test(p)) on.docs = claimed = true;
    if (!claimed) return everything();
  }
  if (on.rust) on.web = on.tooling = true;
  return on;
}

const SHA = /^[0-9a-f]{40}$/;

/** The paths changed between two commits, both sides of a rename, or null when git cannot say. */
export function changedPaths(baseSha, headSha, run = execFileSync) {
  if (!SHA.test(baseSha) || !SHA.test(headSha) || /^0+$/.test(baseSha)) return null;
  try {
    const out = run("git", ["diff", "--name-only", "--no-renames", "-z", `${baseSha}...${headSha}`], { encoding: "utf8" });
    const paths = out.split("\0").filter((p) => p !== "");
    return paths.length ? paths : null;
  } catch {
    return null;
  }
}

/**
 * The outputs of the `changes` job for one event: the five areas and the
 * critical areas (critical.mjs), as `key=value` lines. Only a pull request
 * is routed; a push to main or a manual run runs every job. The critical
 * areas come from the diff whenever it can be read (a push's too, for the
 * checklist in the job summary), and are all on when it cannot.
 */
export function outputs({ eventName, baseSha, headSha, paths = changedPaths }) {
  const known = (eventName === "pull_request" || eventName === "push") ? paths(baseSha, headSha) : null;
  const areas = eventName === "pull_request" ? classify(known) : classify(null);
  const critical = known ? criticalAreas(known) : criticalAreas(null);
  const lines = AREAS.map((a) => `${a}=${areas[a]}`);
  lines.push(`critical=${JSON.stringify(critical)}`);
  if (lines.length !== 6) throw new Error(`six outputs expected, ${lines.length} written`);
  return lines;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const lines = outputs({ eventName: process.env.EVENT_NAME ?? "", baseSha: process.env.BASE_SHA ?? "", headSha: process.env.HEAD_SHA ?? "" });
  console.log(lines.join("\n"));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
}
