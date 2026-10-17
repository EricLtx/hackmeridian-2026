// PreToolUse hook: refuses shell commands that would stage, move or commit the
// git-ignored working folders of this public repository (`private/`,
// `references/`, an Obsidian vault) into it, force-add an ignored file, or
// rewrite .gitignore from the shell. Commands that operate *inside* the
// private folder's own repository (`git -C private ...`, `cd private && git
// ...`) are allowed: only paths named as arguments of the public repository's
// git are checked.
//
// The hook receives the tool call as JSON on stdin and exits with status 2 to
// block, printing the reason for the agent.

import { readFileSync } from "node:fs";

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}
const command = String(input?.tool_input?.command ?? "");
if (!command) process.exit(0);

const GUARDED = /(^|[\s"'=])(\.\/)?(private|references|\.obsidian)([/\\]|["'\s]|$)/i;

function block(why) {
  process.stderr.write(`guard-private: blocked (${why}). Command: ${command.slice(0, 200)}\n`);
  process.exit(2);
}

if (/(>>?\s*["']?\.?\/?\.gitignore\b|\bsed\s+-i[^|;&]*\.gitignore\b|\btee\s+(-a\s+)?["']?\.?\/?\.gitignore\b)/i.test(command)) {
  block("edit .gitignore with the Edit tool, after an explicit GO");
}

for (const segment of command.split(/\|\||&&|[|;]|\n/)) {
  if (!/\bgit\b/.test(segment)) continue;
  // Inside the private folder's own repository: not the public repository.
  if (/\s-C\s+\S*(private|references)\b/i.test(segment)) continue;
  if (/\bgit\b[^|;&]*\b(add|stage)\b[^|;&]*(\s-f\b|\s--force\b)/i.test(segment)) block("git add --force can stage an ignored file");
  if (/\bgit\b[^|;&]*\bupdate-index\b.*(--no-assume-unchanged|--no-skip-worktree)/i.test(segment)) block("ignore rules must not be bypassed");
  const m = /\bgit\b[^|;&]*?\b(add|stage|mv|rm|commit)\b(.*)$/i.exec(segment);
  if (m && GUARDED.test(m[2])) block("private/ and references/ never enter the public repository");
}
process.exit(0);
