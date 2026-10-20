// Turns decoded Soroban values into plain, readable JSON: big integers as
// decimal strings, bytes as hex, addresses and symbols as strings. Pure, with
// no SDK import, so the demo's monitor can put the events it reads in the
// journal's form without the indexer's dependencies.

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
