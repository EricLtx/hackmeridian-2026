// The hash chain of the journal. Each line carries the hash of the previous
// line, so a line cannot be altered, removed or inserted without every later
// hash changing. Pure functions: no file, no network.

import crypto from "node:crypto";

/** `prevHash` of the first line. */
export const GENESIS = "0".repeat(64);

/** The fields of a journal line, in the order they are written. */
export const LINE_FIELDS = ["seq", "ledger", "closedAt", "txHash", "id", "contract", "topics", "data", "prevHash", "hash"];

/**
 * Canonical JSON: object keys sorted at every depth, no whitespace. Arrays
 * keep their order. `undefined` values are dropped, as JSON.stringify does.
 */
export function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v === undefined ? null : v)).join(",")}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}

export const sha256 = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");

/** `sha256(prevHash + canonical(line without hash))`. */
export function hashLine(line) {
  const { hash: _ignored, ...rest } = line;
  return sha256(`${line.prevHash}${canonical(rest)}`);
}

/** Builds the next line of the chain from a decoded event and the previous line (or null). */
export function chainLine(previous, event) {
  const line = {
    seq: previous ? previous.seq + 1 : 1,
    ledger: event.ledger,
    closedAt: event.closedAt,
    txHash: event.txHash,
    id: event.id,
    contract: event.contract,
    topics: event.topics,
    data: event.data,
    prevHash: previous ? previous.hash : GENESIS,
  };
  line.hash = hashLine(line);
  return line;
}

/**
 * Recomputes the chain over `lines` (in file order). Returns
 * `{ ok, lines: count, lastHash, break }` where `break` names the first
 * line that does not fit: `{ seq, index, reason }`.
 */
export function verifyChain(lines) {
  let prev = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const expectedSeq = prev ? prev.seq + 1 : 1;
    const expectedPrev = prev ? prev.hash : GENESIS;
    let reason = null;
    if (line.seq !== expectedSeq) reason = `seq ${line.seq}, expected ${expectedSeq}`;
    else if (line.prevHash !== expectedPrev) reason = `prevHash does not match the previous line's hash`;
    else if (hashLine(line) !== line.hash) reason = `hash does not match the line's content`;
    else if (prev && (line.ledger < prev.ledger || (line.ledger === prev.ledger && line.id <= prev.id))) reason = `event order broken (ledger ${line.ledger}, id ${line.id})`;
    if (reason) return { ok: false, lines: lines.length, lastHash: prev?.hash ?? GENESIS, break: { seq: line.seq, index: i, reason } };
    prev = line;
  }
  return { ok: true, lines: lines.length, lastHash: prev?.hash ?? GENESIS, break: null };
}
