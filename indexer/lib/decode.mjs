// Turns decoded Soroban values into plain, readable JSON: big integers as
// decimal strings, bytes as hex, addresses and symbols as strings. The
// contract's `#[contractevent]` types put the event name in topic 0, the
// `#[topic]` fields next, and the other fields in a map (`data`).

import { scValToNative } from "@stellar/stellar-sdk";

export function plain(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") return value;
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) return Buffer.from(value).toString("hex");
  if (Array.isArray(value)) return value.map(plain);
  if (value instanceof Map) return Object.fromEntries([...value.entries()].map(([k, v]) => [String(plain(k)), plain(v)]));
  if (typeof value === "object") {
    if (typeof value.toString === "function" && value.constructor?.name === "Address") return value.toString();
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  }
  return String(value);
}

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
