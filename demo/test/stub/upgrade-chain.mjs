// An offline chain for `node --import ./test/stub/upgrade-chain.mjs upgrade.mjs ...`
// (demo/test/upgrade-run.test.mjs): the RPC client's methods are replaced on
// the SDK's prototype, so every endpoint lib.mjs builds answers from here and
// nothing leaves the process (`fetch` is removed). A small chain model lets
// the good path run to its end: the instance's executable, the single
// pending-upgrade slot, code entries with a time to live, rent per day,
// ledgers that advance with every submission. The scenario is the JSON file
// named by UPGRADE_STUB; the log, JSON lines appended to UPGRADE_STUB_LOG.
//
// Scenario fields: `ow`, `trustee` (G-address), `monitorFile`, `executable`
// (hex the instance runs), `lieExecutable` (what the first endpoint reports
// instead, or null), `pending` ({ hash, etaOffset } or null), `codes`
// ({ hex: days to live, or null for archived }), `rentPerDayXlm` (8.4),
// `ledgersPerSubmission` (2), `jumpAfterPropose` (seconds the clock skips once
// the proposal lands), `swapAfterReads` and `swapTo` (another proposal takes
// the slot after that many reads of pending_upgrade).

import fs from "node:fs";
import { createHash } from "node:crypto";
import { Account, Address, SorobanDataBuilder, nativeToScVal, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";

const scenario = JSON.parse(fs.readFileSync(process.env.UPGRADE_STUB, "utf8"));
const LOG = process.env.UPGRADE_STUB_LOG;
const log = (entry) => fs.appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
const XLM = 10_000_000;
const DAY = 17_280;
const OW = scenario.ow;
const chain = {
  latest: 5_300_000,
  skew: 0,
  executable: scenario.executable,
  pending: scenario.pending ? { hash: scenario.pending.hash, eta: null, etaOffset: scenario.pending.etaOffset } : null,
  pendingReads: 0,
  codes: {}, // hex -> liveUntil ledger
  schema: scenario.schema ?? 2,
  rent: scenario.rentPerDayXlm ?? 8.4,
  sequences: new Map(),
  txs: new Map(),
};
const now = () => Math.floor(Date.now() / 1000) + chain.skew;
if (chain.pending) chain.pending.eta = now() + chain.pending.etaOffset;
for (const [hex, days] of Object.entries(scenario.codes ?? {})) if (days !== null) chain.codes[hex] = chain.latest + Math.round(days * DAY);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hexOfKey = (key) => key.contractCode.hash.toXDR("hex");
const instanceKey = () => xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({ contract: new Address(OW).toScAddress(), key: xdr.ScVal.scvLedgerKeyContractInstance(), durability: xdr.ContractDataDurability.persistent }));
const codeKey = (hex) => xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: Buffer.from(hex, "hex") }));
const own = (call) => new xdr.SorobanAuthorizedInvocation({ function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(call), subInvocations: [] });
/** The endpoint that lies about the executable: the first one listed, when the scenario says so. */
const lies = (server) => scenario.lieExecutable && server.serverURL.toString().startsWith(scenario.lieAt ?? "https://one.");

function pendingNow() {
  chain.pendingReads += 1;
  if (scenario.swapAfterReads && chain.pendingReads > scenario.swapAfterReads && chain.pending) chain.pending.hash = scenario.swapTo;
  return chain.pending;
}

function ledgerEntry(key, server) {
  if (key.type === "contractData" && key.contractData.key.type === "scvLedgerKeyContractInstance") {
    const executable = lies(server) ? scenario.lieExecutable : chain.executable;
    return xdr.LedgerEntryData.contractData(new xdr.ContractDataEntry({
      ext: xdr.ExtensionPoint.v0(),
      contract: key.contractData.contract,
      key: key.contractData.key,
      durability: key.contractData.durability,
      val: xdr.ScVal.scvContractInstance(new xdr.ScContractInstance({ executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(executable, "hex")), storage: null })),
    }));
  }
  if (key.type === "contractCode") {
    const hex = hexOfKey(key);
    const until = chain.codes[hex];
    if (until === undefined || until < chain.latest) return null; // missing, or archived
    return xdr.LedgerEntryData.contractCode(new xdr.ContractCodeEntry({ ext: xdr.ContractCodeEntryExt.v0(), hash: Buffer.from(hex, "hex"), code: Buffer.from([0]) }));
  }
  return null;
}

const callOf = (tx) => {
  const op = tx.operations[0];
  if (op.type !== "invokeHostFunction") return { kind: op.type };
  if (op.func.type === "hostFunctionTypeUploadContractWasm") return { kind: "upload", hash: sha(Buffer.from(op.func.wasm)) };
  const call = op.func.invokeContract;
  return { kind: "invoke", fn: String(call.functionName), args: call.args, call };
};
const argsHex = (args) => args.map((a) => (a.type === "scvBytes" ? Buffer.from(scValToNative(a)).toString("hex") : a.type === "scvAddress" ? Address.fromScAddress(a.address).toString() : a.type));

function simulate(tx) {
  const c = callOf(tx);
  const footprint = tx.toEnvelope().value.tx.ext;
  const asked = footprint.type === "sorobanData" ? footprint.value.resources.footprint : { readOnly: [], readWrite: [] };
  let retval = xdr.ScVal.scvVoid();
  let auth = [];
  let readOnly = [];
  let readWrite = [];
  let fee = 1_000_000;
  if (c.kind === "extendFootprintTtl") {
    readOnly = asked.readOnly;
    const extendTo = tx.operations[0].extendTo;
    fee = 0;
    for (const key of readOnly) {
      if (key.type !== "contractCode") continue;
      const until = chain.codes[hexOfKey(key)] ?? chain.latest;
      fee += (Math.max(0, chain.latest + extendTo - until) * (chain.rent * XLM)) / DAY;
    }
    fee = Math.round(fee) + 1_000;
  } else if (c.kind === "restoreFootprint") {
    readWrite = asked.readWrite;
    fee = 60 * XLM;
  } else if (c.kind === "upload") {
    readWrite = [codeKey(c.hash)];
    fee = 60 * XLM;
    retval = xdr.ScVal.scvBytes(Buffer.from(c.hash, "hex"));
  } else {
    readWrite = [instanceKey()];
    if (c.fn === "pending_upgrade") {
      const p = pendingNow();
      retval = p
        ? xdr.ScVal.scvMap([
          new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("eta"), val: nativeToScVal(BigInt(p.eta), { type: "u64" }) }),
          new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("wasm_hash"), val: xdr.ScVal.scvBytes(Buffer.from(p.hash, "hex")) }),
        ])
        : xdr.ScVal.scvVoid();
    } else if (c.fn === "schema_version") {
      retval = nativeToScVal(chain.schema, { type: "u32" });
    } else if (c.fn === "propose_upgrade" || c.fn === "migrate") {
      auth = [new xdr.SorobanAuthorizationEntry({ credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(), rootInvocation: own(c.call) })];
      auth.push(new xdr.SorobanAuthorizationEntry({ credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({ address: new Address(scenario.trustee).toScAddress(), nonce: xdr.Int64.fromString("11"), signatureExpirationLedger: 0, signature: xdr.ScVal.scvVoid() })), rootInvocation: own(c.call) }));
      if (c.fn === "propose_upgrade") {
        let monitor = null;
        try {
          monitor = JSON.parse(fs.readFileSync(scenario.monitorFile, "utf8"));
        } catch {
          // no file yet
        }
        log({ at: "simulate propose_upgrade", announcedBefore: (monitor?.announced ?? []).includes(argsHex(c.args)[0]) });
      }
    } else if (c.fn === "upgrade") {
      auth = [new xdr.SorobanAuthorizationEntry({ credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(), rootInvocation: own(c.call) })];
    }
  }
  const data = new SorobanDataBuilder().setReadOnly(readOnly).setReadWrite(readWrite).setResourceFee(BigInt(fee)).build();
  return rpc.parseRawSimulation({ id: "1", latestLedger: chain.latest, minResourceFee: String(fee), transactionData: data.toXDR("base64"), results: [{ auth: auth.map((a) => a.toXDR("base64")), xdr: retval.toXDR("base64") }], events: [] });
}

function apply(tx) {
  const c = callOf(tx);
  chain.latest += scenario.ledgersPerSubmission ?? 2;
  const entry = { at: "submitted", kind: c.kind, fee: Number(tx.fee) / XLM, source: tx.source };
  let retval = xdr.ScVal.scvVoid();
  if (c.kind === "extendFootprintTtl") {
    const keys = tx.toEnvelope().value.tx.ext.value.resources.footprint.readOnly;
    entry.keys = keys.map((k) => (k.type === "contractCode" ? `code:${hexOfKey(k)}` : k.type));
    entry.extendToDays = tx.operations[0].extendTo / DAY;
    for (const k of keys) if (k.type === "contractCode") chain.codes[hexOfKey(k)] = Math.max(chain.codes[hexOfKey(k)] ?? 0, chain.latest + tx.operations[0].extendTo);
  } else if (c.kind === "restoreFootprint") {
    const keys = tx.toEnvelope().value.tx.ext.value.resources.footprint.readWrite;
    entry.keys = keys.map((k) => (k.type === "contractCode" ? `code:${hexOfKey(k)}` : k.type));
    for (const k of keys) if (k.type === "contractCode") chain.codes[hexOfKey(k)] = chain.latest + 120_960;
  } else if (c.kind === "upload") {
    entry.hash = c.hash;
    chain.codes[c.hash] = chain.latest + 120_960; // the network's minimum: 7 days
    retval = xdr.ScVal.scvBytes(Buffer.from(c.hash, "hex"));
  } else {
    entry.fn = c.fn;
    entry.args = argsHex(c.args);
    entry.auth = (tx.operations[0].auth ?? []).map((a) => a.credentials.type);
    if (c.fn === "propose_upgrade") {
      chain.pending = { hash: entry.args[0], eta: now() + 300 };
      chain.skew += scenario.jumpAfterPropose ?? 0;
    } else if (c.fn === "upgrade") {
      const ok = chain.pending && chain.pending.hash === entry.args[0] && now() >= chain.pending.eta;
      entry.contract = ok ? "installed" : `refused (pending ${chain.pending?.hash ?? "none"})`;
      if (ok) {
        chain.executable = entry.args[0];
        chain.pending = null;
      }
    } else if (c.fn === "migrate") {
      chain.schema = 2;
    }
  }
  entry.ledger = chain.latest;
  log(entry);
  return retval;
}

/** A landed transaction as `getTransaction` reports it, with what lib.mjs reads of it. */
function success(retval) {
  const result = new xdr.TransactionResult({ feeCharged: xdr.Int64.fromString("1000"), result: xdr.TransactionResultResult.txSuccess([]), ext: xdr.TransactionResultExt.v0() });
  return { status: "SUCCESS", latestLedger: chain.latest, latestLedgerCloseTime: String(now()), ledger: chain.latest, createdAt: now(), resultXdr: result, returnValue: retval };
}

const proto = rpc.Server.prototype;
proto.getLatestLedger = async function getLatestLedger() {
  log({ rpc: "getLatestLedger", at: this.serverURL.toString() });
  return { id: "stub", protocolVersion: 23, sequence: chain.latest, closeTime: String(now()) };
};
proto.getAccount = async function getAccount(publicKey) {
  log({ rpc: "getAccount" });
  const sequence = (chain.sequences.get(publicKey) ?? 100) + 1;
  chain.sequences.set(publicKey, sequence);
  return new Account(publicKey, String(sequence));
};
proto.getLedgerEntries = async function getLedgerEntries(...keys) {
  log({ rpc: "getLedgerEntries", at: this.serverURL.toString() });
  const entries = keys.map((key) => {
    const val = ledgerEntry(key, this);
    if (!val) return null;
    const liveUntil = key.type === "contractCode" ? chain.codes[hexOfKey(key)] : chain.latest + 100_000;
    return { key, val, lastModifiedLedgerSeq: 1, liveUntilLedgerSeq: liveUntil };
  }).filter(Boolean);
  return { entries, latestLedger: chain.latest };
};
proto.simulateTransaction = async function simulateTransaction(tx) {
  log({ rpc: "simulateTransaction" });
  return simulate(tx);
};
proto.sendTransaction = async function sendTransaction(tx) {
  log({ rpc: "sendTransaction" });
  const hash = Buffer.from(tx.hash()).toString("hex");
  if (!chain.txs.has(hash)) chain.txs.set(hash, success(apply(tx)));
  return { status: "PENDING", hash, latestLedger: chain.latest, latestLedgerCloseTime: String(now()) };
};
proto.getTransaction = async function getTransaction(hash) {
  log({ rpc: "getTransaction", at: this.serverURL.toString() });
  return chain.txs.get(hash) ?? { status: "NOT_FOUND", latestLedger: chain.latest, latestLedgerCloseTime: String(now()) };
};
for (const method of ["getHealth", "getEvents", "getNetwork", "getFeeStats", "getVersionInfo"]) {
  proto[method] = async () => {
    throw new Error(`stub: ${method} not answered`);
  };
}
// Nothing leaves the process: a request that escaped the stub fails here.
globalThis.fetch = async (input) => {
  log({ refused: String(input instanceof Request ? input.url : input) });
  throw new Error(`stub: refused ${String(input instanceof Request ? input.url : input)}`);
};
