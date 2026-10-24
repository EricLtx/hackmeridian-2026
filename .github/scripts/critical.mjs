// The paths that hold funds, signatures or the review rules, and the
// checklist a change to them gets (.github/workflows/ci.yml, job
// `critical-review`): posted once on the pull request and kept up to date,
// written to the job summary on every run. The list repeats the public
// rules of AGENTS.md, docs/security.md §7 and SECURITY.md; it blocks nobody
// and needs no secret. The same paths are listed in .github/CODEOWNERS.
// Node standard library only.
//
//   node .github/scripts/critical.mjs render '["csp","ci"]'   (prints the Markdown)

import { pathToFileURL } from "node:url";

export const MARKER = "<!-- critical-path-review -->";

const RULES_7 = "the review rules of `docs/security.md` §7 (1 to 6) applied to every changed privileged function, external call, computation and stored value";
const WORKFLOW_RULES = "every action pinned to a full commit SHA, least-privilege `permissions`, `persist-credentials: false` on every checkout, no `pull_request_target`, no `${{ }}` inside `run:`";

/** One critical area: a name, the paths that belong to it, what its reviewer checks. */
export const CRITICAL = [
  {
    area: "contract",
    title: "The contract and the Cargo workspace",
    match: (p) => /^(contracts\/|Cargo\.toml$|Cargo\.lock$|rust-toolchain\.toml$|deny\.toml$)/.test(p),
    checklist: [
      RULES_7,
      "any change under `contracts/` means a new tag and a new testnet rehearsal (`AGENTS.md`)",
      "a `soroban-sdk` or toolchain bump changes the code hash of the audit candidate: say so, or leave it for after the audit",
      "error codes and exported types are append-only (`AGENTS.md`)",
    ],
  },
  {
    area: "signing-web",
    title: "The interface's signing path and its dependencies",
    match: (p) => ["web/src/chain.js", "web/src/wallet.js", "web/src/deployment.js", "web/public/deployment.testnet.json", "web/package.json", "web/package-lock.json", "web/vite.config.js"].includes(p),
    checklist: [
      "every value read from the chain is checked in `web/src/chain.js` before it reaches the markup (`AGENTS.md`)",
      "the deployment file is checked in `web/src/deployment.js` and accepts only the test network; it holds public facts only, never a key or an RPC URL that carries one",
      "the fee check before a signature is unchanged (`SECURITY.md`, what the code already enforces)",
      "a dependency change keeps `npm audit --omit=dev --audit-level=high` green and adds no install script",
    ],
  },
  {
    area: "csp",
    title: "The pages' content security policy",
    match: (p) => /^web\/[^/]+\.html$/.test(p),
    checklist: [
      "the content security policy is the same on every page of `web/`, with no inline script",
      "`connect-src` lists every RPC endpoint of `web/public/deployment.testnet.json` (`AGENTS.md`, Web interface)",
      "the page still refuses to run inside another site's frame (`SECURITY.md`)",
    ],
  },
  {
    area: "operator-signing",
    title: "The operator's scripts, which sign with the demo keys",
    match: (p) => /^demo\/[^/]+\.mjs$/.test(p),
    checklist: [
      "every transaction is simulated and checked before it is signed, and the checks of the demo library are unchanged or tested",
      "no key, state file or RPC URL that carries a key reaches a tracked file or the output",
      "a script that changes an admitted fund, a role, a limit or the stablecoin registry handles the proposal and the delay (`AGENTS.md`, Deploy and invoke)",
    ],
  },
  {
    area: "ci",
    title: "The workflows",
    match: (p) => p.startsWith(".github/"),
    checklist: [
      WORKFLOW_RULES,
      "pull-request data (title, body, branch names) reaches a step only through `env:`",
      "a job that may skip fails open: the gate runs everything when the change is not understood",
    ],
  },
  {
    area: "repo-guard",
    title: "What the repository tracks, and its rules",
    match: (p) => [".gitignore", "AGENTS.md", "SECURITY.md", "docs/security.md"].includes(p) || p.startsWith(".claude/"),
    checklist: [
      "`private/` and `references/` stay ignored, and nothing from them is copied into tracked files (`AGENTS.md`, What stays out)",
      "no personal data beyond the copyright holder named in `LICENSE` and `NOTICE`",
      "a changed rule is reflected wherever it is repeated (`AGENTS.md`, `SECURITY.md`, `docs/security.md` §7)",
    ],
  },
];

/** The critical areas the changed `paths` touch, in the order of `CRITICAL`; every area when the paths are unknown. */
export function criticalAreas(paths) {
  if (!Array.isArray(paths)) return CRITICAL.map((c) => c.area);
  return CRITICAL.filter((c) => paths.some((p) => typeof p === "string" && c.match(p))).map((c) => c.area);
}

/** The checklist for `areas` as Markdown, starting with the marker the sticky comment is found by. */
export function render(areas) {
  const known = CRITICAL.filter((c) => areas.includes(c.area));
  const lines = [MARKER, "## Review on critical paths", "", "This change touches paths that hold funds, signatures or the review rules. The reviewer goes through the list below; CI only posts it (enforcement comes with a second maintainer and a ruleset)."];
  for (const c of known) {
    lines.push("", `### ${c.title} (\`${c.area}\`)`, "");
    for (const item of c.checklist) lines.push(`- [ ] ${item}`);
  }
  lines.push("", "Sources: `AGENTS.md`, `docs/security.md` §7, `SECURITY.md`.", "");
  return lines.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, json] = process.argv.slice(2);
  if (command !== "render") {
    console.error("usage: node critical.mjs render '<json array of areas>'");
    process.exit(2);
  }
  let areas;
  try {
    areas = JSON.parse(json ?? "[]");
    if (!Array.isArray(areas)) throw new Error("not an array");
  } catch (error) {
    console.error(`areas: ${error.message}`);
    process.exit(2);
  }
  process.stdout.write(render(areas));
}
