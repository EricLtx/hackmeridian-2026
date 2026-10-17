// On-chain anchoring of the journal's last hash. A classic `manageData`
// operation writes the 32 bytes of the hash under a key named after the
// contract, on an account the operator controls; the ledger then holds a
// timestamped copy of the proof that no machine running the indexer can
// alter. Each anchor is also recorded in `anchors.jsonl`, so `verify` can
// check both the journal and the ledger against it later.
//
// The pure parts (key, operation, checks against the journal) have no network
// and are unit-tested; the network parts go through the same failover RPC as
// the indexer, plus Horizon as a last resort for a transaction the RPC no
// longer retains.

import fs from "node:fs";
import path from "node:path";
import { Account, BASE_FEE, Keypair, Memo, Networks, Operation, TransactionBuilder, xdr } from "@stellar/stellar-sdk";

import { hashLine } from "./chain.mjs";

/** `manageData` key: a fixed prefix plus the first characters of the contract id (a data name is at most 64 bytes). */
export const DATA_KEY_PREFIX = "openwindow.indexer.";
export const SHORT_ID_LENGTH = 8;

/** Seconds a built anchor transaction stays valid. */
export const TX_VALIDITY_SECS = 60;

export const DEFAULT_HORIZON = "https://horizon-testnet.stellar.org";
export const FRIENDBOT = "https://friendbot.stellar.org";

/** Horizon, read only when the RPC no longer retains an anchoring transaction. */
export const horizonUrl = (env = process.env) => env.STELLAR_HORIZON_URL?.trim() || DEFAULT_HORIZON;
/** The network the anchor is signed for; the indexer is a testnet tool unless told otherwise. */
export const networkPassphrase = (env = process.env) => env.STELLAR_NETWORK_PASSPHRASE?.trim() || Networks.TESTNET;

export const anchorsFile = (stateDir) => path.join(stateDir, "anchors.jsonl");

/** `openwindow.indexer.<first 8 characters of the contract id>`. */
export function anchorDataKey(contractId) {
  if (!/^C[A-Z2-7]{55}$/.test(String(contractId ?? ""))) throw new Error(`not a contract id: ${contractId}`);
  return `${DATA_KEY_PREFIX}${contractId.slice(0, SHORT_ID_LENGTH)}`;
}

/** The 32 bytes of a hex hash, or a thrown error when it is not one. */
export function hashBytes(hash) {
  if (!/^[0-9a-f]{64}$/.test(String(hash ?? ""))) throw new Error(`not a 32-byte hex hash: ${hash}`);
  return Buffer.from(hash, "hex");
}

/** The `manageData` operation of an anchor: the data key and the raw hash. */
export function anchorOperation(contractId, hash) {
  return Operation.manageData({ name: anchorDataKey(contractId), value: hashBytes(hash) });
}

/**
 * The anchor transaction of `account` (an `Account` with its current sequence
 * number): one `manageData`, base fee, a text memo with the line count and a
 * validity window. Unsigned.
 */
export function anchorTransaction(account, contractId, hash, lines, { passphrase = networkPassphrase(), validitySecs = TX_VALIDITY_SECS } = {}) {
  return new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(anchorOperation(contractId, hash))
    .addMemo(Memo.text(`ow-indexer lines=${Number(lines)}`))
    .setTimeout(validitySecs)
    .build();
}

/**
 * The anchor carried by a transaction envelope (XDR base64), if it holds a
 * `manageData` on `dataKey`: `{ account, dataKey, hash }`, else null. Used
 * when the ledger entry has since been overwritten by a later anchor.
 */
export function anchorInEnvelope(envelopeXdr, dataKey, passphrase = networkPassphrase()) {
  const tx = TransactionBuilder.fromXDR(envelopeXdr, passphrase);
  const inner = typeof tx.innerTransaction === "object" && tx.innerTransaction ? tx.innerTransaction : tx;
  for (const op of inner.operations ?? []) {
    if (op.type !== "manageData" || op.name !== dataKey) continue;
    const value = op.value == null ? null : Buffer.from(op.value);
    return { account: op.source ?? inner.source, dataKey, hash: value ? value.toString("hex") : null };
  }
  return null;
}

/** The record written to `anchors.jsonl`. Field order is the one documented in the README. */
export function anchorRecord({ at, ledger, txHash, account, dataKey, hash, lines }) {
  return { at, ledger, txHash, account, dataKey, hash, lines };
}

/**
 * Check (a): the anchored hash is the hash of line `lines` of the journal,
 * recomputed from the line's content. Returns `{ ok, reason }`.
 */
export function checkAnchorAgainstJournal(anchor, journalLines) {
  const n = Number(anchor.lines);
  if (!Number.isInteger(n) || n < 1) return { ok: false, reason: `lines is ${anchor.lines}` };
  if (journalLines.length < n) return { ok: false, reason: `journal has ${journalLines.length} line(s), anchor names line ${n}` };
  const line = journalLines[n - 1];
  if (line.seq !== n) return { ok: false, reason: `line ${n} carries seq ${line.seq}` };
  const recomputed = hashLine(line);
  if (recomputed !== line.hash) return { ok: false, reason: `line ${n} does not hash to its own hash field` };
  if (recomputed !== anchor.hash) return { ok: false, reason: `line ${n} hashes to ${recomputed.slice(0, 16)}…, anchor says ${String(anchor.hash).slice(0, 16)}…` };
  return { ok: true, reason: "hash of line matches" };
}

/** Anchors on disk, oldest first. A malformed line is skipped and reported. */
export function readAnchors(stateDir) {
  const file = anchorsFile(stateDir);
  if (!fs.existsSync(file)) return { anchors: [], problems: [] };
  const anchors = [];
  const problems = [];
  fs.readFileSync(file, "utf8")
    .split("\n")
    .forEach((row, i) => {
      if (row.trim() === "") return;
      try {
        anchors.push(JSON.parse(row));
      } catch {
        problems.push({ file: path.basename(file), line: i + 1, reason: "not valid JSON" });
      }
    });
  return { anchors, problems };
}

export function appendAnchor(stateDir, record) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.appendFileSync(anchorsFile(stateDir), `${JSON.stringify(anchorRecord(record))}\n`, { flag: "a" });
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The bytes of a `LedgerEntryData` of type `data`, or null. The SDK's XDR
 * structs expose their fields as properties (js-xdr 5) and, before, as
 * methods; opaque values may be wrapped in `{ value }`.
 */
export function dataEntryValue(val) {
  const field = (object, name) => (typeof object?.[name] === "function" ? object[name]() : object?.[name]);
  const type = typeof val?.switch === "function" ? val.switch().name : val?.type;
  if (type !== "data") return null;
  const raw = field(field(val, "data"), "dataValue");
  const bytes = raw?.value ?? raw;
  return bytes ? Buffer.from(bytes) : null;
}

/** The ledger key of a `manageData` entry. */
export function dataLedgerKey(account, dataKey) {
  return xdr.LedgerKey.data(new xdr.LedgerKeyData({ accountId: Keypair.fromPublicKey(account).xdrAccountId(), dataName: dataKey }));
}

/**
 * The current value of the account's data entry, as hex, or null when the
 * entry does not exist. Reads `getLedgerEntries` through the failover RPC.
 */
export async function readDataEntry(rpcClient, account, dataKey) {
  const response = await rpcClient.call("ledger entry", (s) => s.getLedgerEntries(dataLedgerKey(account, dataKey)));
  const entry = response.entries?.[0];
  if (!entry) return { value: null, ledger: response.latestLedger ?? null, lastModified: null };
  const val = dataEntryValue(entry.val);
  return {
    value: val ? val.toString("hex") : null,
    ledger: response.latestLedger ?? null,
    lastModified: entry.lastModifiedLedgerSeq ?? null,
  };
}

/**
 * The anchor a past transaction carried: from the RPC while it retains the
 * transaction, else from Horizon's operation records. Returns
 * `{ hash, ledger, source }` or null when neither holds it.
 */
export async function readAnchorTransaction(rpcClient, txHash, dataKey, { horizon = horizonUrl(), passphrase = networkPassphrase() } = {}) {
  try {
    const found = await rpcClient.call("transaction", (s) => s.getTransaction(txHash));
    if (found?.status === "SUCCESS" && found.envelopeXdr) {
      const envelope = typeof found.envelopeXdr === "string" ? found.envelopeXdr : found.envelopeXdr.toXDR("base64");
      const inEnvelope = anchorInEnvelope(envelope, dataKey, passphrase);
      if (inEnvelope) return { hash: inEnvelope.hash, ledger: found.ledger ?? null, source: "rpc" };
    }
    if (found?.status === "FAILED") return { hash: null, ledger: found.ledger ?? null, source: "rpc", failed: true };
  } catch {
    // Fall through to Horizon.
  }
  // Horizon keeps the full history of the network: its transaction record
  // carries the envelope, the ledger and whether the transaction succeeded.
  const response = await fetch(`${horizon.replace(/\/$/, "")}/transactions/${txHash}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`horizon ${response.status} for transaction ${txHash}`);
  const body = await response.json();
  if (!body?.envelope_xdr) return null;
  const inEnvelope = anchorInEnvelope(body.envelope_xdr, dataKey, passphrase);
  if (!inEnvelope) return null;
  return { hash: inEnvelope.hash, ledger: body.ledger ?? null, source: "horizon", failed: body.successful === false };
}

/** Funds a testnet account through friendbot; an already funded account is fine. */
export async function friendbot(publicKey, url = FRIENDBOT) {
  const response = await fetch(`${url}?addr=${encodeURIComponent(publicKey)}`);
  if (response.ok) return;
  const body = await response.text();
  if (response.status === 400 && /already funded|createAccountAlreadyExist|op_already_exists/i.test(body)) return;
  throw new Error(`friendbot failed for ${publicKey}: ${response.status}`);
}

/** Result code of a transaction result XDR (`txBadSeq`, `txFailed`...), for messages. */
function resultCode(result) {
  try {
    const inner = typeof result?.result === "function" ? result.result() : result?.result;
    const type = typeof inner?.switch === "function" ? inner.switch().name : inner?.type;
    return type ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Submits a signed transaction and returns `{ hash, ledger, createdAt }` once
 * it has landed. Throws only with a definitive answer: the transaction
 * failed, or its validity window closed without it landing. A lost response
 * or a resend refused as a duplicate is resolved by looking it up by hash.
 */
export async function submitAndWait(rpcClient, tx, label = "anchor") {
  const hash = Buffer.from(tx.hash()).toString("hex");
  const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
  const lookup = async () => {
    try {
      return await rpcClient.call("transaction", (s) => s.getTransaction(hash));
    } catch {
      return null;
    }
  };
  const done = (result) => ({ hash, ledger: result.ledger ?? null, createdAt: result.createdAt ? new Date(Number(result.createdAt) * 1000).toISOString() : null });

  let delay = 1000;
  for (;;) {
    let sent = null;
    try {
      sent = await rpcClient.call("send", (s) => s.sendTransaction(tx));
    } catch {
      // Lost response: the transaction may be queued. Fall through to the lookup.
    }
    if (sent?.status === "PENDING" || sent?.status === "DUPLICATE") break;
    const known = await lookup();
    if (known?.status === "SUCCESS") return done(known);
    if (known?.status === "FAILED") throw new Error(`${label}: transaction failed (${resultCode(known.resultXdr)})`);
    if (sent?.status === "ERROR") throw new Error(`${label}: submission refused (${resultCode(sent.errorResult)})`);
    if (maxTime && Date.now() / 1000 > maxTime + 10) break;
    await sleep(delay);
    delay = Math.min(delay * 2, 8000);
  }

  for (;;) {
    const result = await lookup();
    if (result?.status === "SUCCESS") return done(result);
    if (result?.status === "FAILED") throw new Error(`${label}: transaction failed (${resultCode(result.resultXdr)})`);
    let closed = 0;
    try {
      closed = Number((await rpcClient.latestLedger()).closeTime ?? 0);
    } catch {
      // RPC unreachable: keep polling.
    }
    if (maxTime && closed > maxTime + 5) {
      const last = await lookup();
      if (last?.status === "SUCCESS") return done(last);
      throw new Error(`${label}: expired before landing; nothing changed on chain, rerun the command`);
    }
    await sleep(1000);
  }
}

/**
 * Builds, signs and submits the anchor of `hash` (line `lines`) for
 * `contractId` from `keypair`'s account. Returns the record to append.
 */
export async function anchor(rpcClient, keypair, contractId, hash, lines, { passphrase = networkPassphrase() } = {}) {
  const publicKey = keypair.publicKey();
  const loaded = await rpcClient.call("account", (s) => s.getAccount(publicKey));
  const account = new Account(publicKey, loaded.sequenceNumber());
  const tx = anchorTransaction(account, contractId, hash, lines, { passphrase });
  tx.sign(keypair);
  const landed = await submitAndWait(rpcClient, tx);
  return anchorRecord({
    at: landed.createdAt ?? new Date().toISOString(),
    ledger: landed.ledger,
    txHash: landed.hash,
    account: publicKey,
    dataKey: anchorDataKey(contractId),
    hash,
    lines: Number(lines),
  });
}
