// The journal against what an RPC endpoint serves, both ways and by content
// (rpc-6). The hash chain proves that a line was not changed after it was
// written, and the anchor dates it; neither says the event was true. An
// endpoint independent of the one the indexer read is the only check on
// content: every journaled event it still serves must be identical there,
// and every event it serves must be journaled. Pure functions: no file, no
// network (verify.mjs and the demo's monitor do the reading).

import { canonical } from "./chain.mjs";

/** What two copies of one event must share: where and in which transaction it happened, and what it says. */
export const CONTENT_FIELDS = ["ledger", "txHash", "topics", "data"];

/**
 * Compares journal lines with the events an endpoint served for the same
 * contract, over the ledgers both cover, `from` to `to` inclusive (the
 * endpoint's retention on one side, the journal's last line on the other).
 * Both sides carry the journal's fields: `id` (the RPC event id), `ledger`,
 * `txHash`, `topics` and `data` in plain JSON. Returns:
 * - `missing`: events the endpoint serves that the journal lacks: a stalled,
 *   trimmed or tampered journal;
 * - `unknown`: journal lines the endpoint does not know: an event a hostile
 *   endpoint made up for the indexer, or a line written by hand;
 * - `altered`: lines whose ledger, transaction, topics or data differ from
 *   the endpoint's copy, with the fields that differ;
 * - `checked`: the number of journal lines compared.
 * Lines and events outside the range are left out.
 */
export function compareTrail(lines, events, { from, to }) {
  const inside = (item) => Number(item.ledger) >= from && Number(item.ledger) <= to;
  const served = new Map(events.filter(inside).map((e) => [e.id, e]));
  const journaled = new Map(lines.filter(inside).map((l) => [l.id, l]));
  const missing = [...served.values()].filter((e) => !journaled.has(e.id));
  const unknown = [...journaled.values()].filter((l) => !served.has(l.id));
  const altered = [];
  for (const [id, line] of journaled) {
    const event = served.get(id);
    if (!event) continue;
    const fields = CONTENT_FIELDS.filter((field) => canonical(line[field] ?? null) !== canonical(event[field] ?? null));
    if (fields.length) altered.push({ id, ledger: line.ledger, seq: line.seq, name: nameOf(line), fields });
  }
  return { checked: journaled.size, missing, unknown, altered };
}

/** An event's name: its first topic. */
export const nameOf = (item) => (Array.isArray(item.topics) ? String(item.topics[0]) : "?");
