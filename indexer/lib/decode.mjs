// Decodes the RPC's events into the journal's shape. The contract's
// `#[contractevent]` types put the event name in topic 0, the `#[topic]`
// fields next, and the other fields in a map (`data`); `plain` turns the
// values into readable JSON (lib/plain.mjs).

import { scValToNative } from "@stellar/stellar-sdk";

import { plain } from "./plain.mjs";

export { plain };

/** Decodes one `getEvents` entry into the journal's event shape (without chain fields). */
export function decodeEvent(raw) {
  const topics = (raw.topic ?? []).map((t) => plain(scValToNative(t)));
  const data = plain(scValToNative(raw.value));
  const contract = typeof raw.contractId === "string" ? raw.contractId : raw.contractId?.contractId?.() ?? null;
  return {
    ledger: raw.ledger,
    closedAt: raw.ledgerClosedAt,
    txHash: raw.txHash,
    id: raw.id,
    contract,
    topics,
    data,
  };
}

/** The event name is the first topic. */
export const eventName = (line) => (Array.isArray(line.topics) ? String(line.topics[0]) : "");
