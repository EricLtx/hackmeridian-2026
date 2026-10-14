// Shared helpers for the Open Window testnet demo.
//
// Every write goes through `send`: build, simulate, sign the authorization
// entries of every party that is not the transaction source (two-key fund
// admission needs it), re-simulate, assemble, sign, submit, wait. Reads go
// through `read`, a simulation that never submits.
//
// Submission gives a definitive answer: either the transaction landed, or its
// validity window has closed and it never will. "Timed out, maybe later" is
// never reported, so a rerun cannot duplicate a step that landed late.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Address,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  authorizeEntry,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");
export const STATE_DIR = path.join(here, ".state");
export const STATE_FILE = path.join(STATE_DIR, "testnet.json");
export const WASM_DIR = path.join(ROOT, "target", "wasm32v1-none", "release");

export const RPC_URL = process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
export const PASSPHRASE = Networks.TESTNET;
export const FRIENDBOT = "https://friendbot.stellar.org";
export const server = new rpc.Server(RPC_URL);

/** Reflector fiat FX feed on testnet (base USD, 14 decimals, 5-minute ticks). */
export const REFLECTOR_FX_TESTNET = "CCSSOHTBL3LEWUCBBEB5NJFC2OKFRC74OWEIJIZLRJBGAAU4VMU5NV4W";

/** Seconds a built transaction stays valid. Submission waits until it lands or expires. */
const TX_VALIDITY_SECS = 60;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Error names, per contract
// ---------------------------------------------------------------------------

/** Open Window error codes, in the order of contracts/night-window/src/error.rs. */
export const ERRORS = {
  1: "NotImplemented", 2: "FundNotAccepted", 3: "InvalidHaircut", 4: "InvalidAmount",
  5: "InvalidTerm", 6: "NoPrice", 7: "NotInitialized", 8: "Paused",
  9: "StablecoinNotAccepted", 10: "CurrencyMismatch", 11: "StalePrice", 12: "PriceOutOfBand",
  13: "LoanTooLarge", 14: "OfferNotFound", 15: "InsufficientOffer", 16: "RepoNotFound",
  17: "RepoNotOpen", 18: "NotMatured", 19: "CapExceeded", 20: "TooManyFunds",
  21: "LenderNotApproved", 22: "TransferMismatch", 23: "FundNotInOffer", 24: "InvalidRate",
  25: "ArithmeticOverflow", 26: "OutsideEnvelope", 27: "FundFrozen", 28: "InvalidPrice",
  29: "DuplicateFund", 30: "Unauthorized",
};

/** Error tables of the other contracts the demo calls. */
export const ERROR_TABLES = {
  "fund-token": {
    1: "NotWhitelisted", 2: "Frozen", 3: "InsufficientBalance", 4: "InsufficientAllowance",
    5: "NegativeAmount", 6: "Overflow", 7: "NotInitialized", 8: "InvalidExpiration",
  },
  "nav-oracle": {
    1: "InvalidPrice", 2: "InvalidTimestamp", 3: "NonMonotonicTimestamp", 4: "TooManyAssets",
    5: "NotInitialized", 6: "InvalidConfig",
  },
  "stellar-asset": {
    1: "InternalError", 2: "OperationNotSupported", 3: "AlreadyInitialized", 4: "Unauthorized",
    5: "Authentication", 6: "AccountMissing", 7: "AccountIsNotClassic", 8: "NegativeAmount",
    9: "Allowance", 10: "Balance", 11: "BalanceDeauthorized", 12: "Overflow", 13: "TrustlineMissing",
  },
};

/** Contract id → { kind, table }. Filled by `registerContracts`. */
const registry = new Map();

/** Tells the error decoder which deployed contract is which. */
export function registerContracts(contracts) {
  const kinds = { openWindow: null, shares: "fund-token", navOracle: "nav-oracle", euro: "stellar-asset" };
  for (const [key, kind] of Object.entries(kinds)) {
    if (contracts?.[key]) registry.set(contracts[key], kind === null ? { kind: "open-window", table: ERRORS } : { kind, table: ERROR_TABLES[kind] });
  }
}

export class ContractError extends Error {
  /**
   * `contract` is the kind of contract that raised the code: "open-window",
   * "fund-token", "nav-oracle", "stellar-asset" or "unknown". `name` is the
   * bare error name for Open Window, `kind:Name` for any other contract, so a
   * probe expecting an Open Window refusal never matches another contract's.
   */
  constructor(code, contract, detail) {
    const table = contract === "open-window" ? ERRORS : (ERROR_TABLES[contract] ?? {});
    const bare = table[code] ?? "Error";
    const name = contract === "open-window" ? bare : `${contract}:${bare}`;
    super(`${name} (#${code})`);
    this.code = code;
    this.contract = contract;
    this.name = name;
    this.detail = detail;
  }
}

/**
 * Decodes the contract error of a failed simulation. The diagnostic log lists
 * events newest first; the oldest error event names the contract where the
 * error started (a token refusing a transfer inside `open_repo`, say).
 */
function simulationError(sim) {
  const text = sim.error ?? "";
  const events = [...text.matchAll(/contract:(C[A-Z0-9]{55}), topics:\[error, Error\(Contract, #(\d+)\)\]/g)];
  if (events.length) {
    const [, contractId, code] = events[events.length - 1];
    return new ContractError(Number(code), registry.get(contractId)?.kind ?? "unknown", text);
  }
  const match = /Error\(Contract, #(\d+)\)/.exec(text);
  if (match) return new ContractError(Number(match[1]), "unknown", text);
  return new Error(text || "simulation failed");
}

// ---------------------------------------------------------------------------
// Network resilience
// ---------------------------------------------------------------------------
//
// Testnet RPC drops a request now and then, and a hackathon room shares one
// uplink. Reads go through `net`, which retries transient failures with
// exponential backoff. Submissions go through `submit`, which never gives up
// before the transaction's validity window has closed.

function isTransient(error) {
  const text = `${error?.message ?? ""} ${error?.cause?.code ?? ""} ${error?.response?.status ?? ""}`;
  return /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|\b(429|50[0-4])\b/i.test(text);
}

/** Runs `call`; on a transient network error, retries up to three times. */
export async function net(call, label = "rpc") {
  let delay = 1000;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      if (attempt >= 4 || !isTransient(error)) throw error;
      process.stderr.write(`  (network: ${label}, retry ${attempt} in ${delay / 1000} s)\n`);
      await sleep(delay);
      delay *= 2;
    }
  }
}

/** Fee actually charged, in stroops, or null when the response hides it. */
function feeCharged(result) {
  try {
    const xdrResult = result.resultXdr;
    const fee = typeof xdrResult?.feeCharged === "function" ? xdrResult.feeCharged() : xdrResult?.feeCharged;
    return fee === undefined ? null : BigInt(String(fee));
  } catch {
    return null;
  }
}

/** Result code of a transaction result (`txBadSeq`, `txFailed`...), for messages. */
function resultCode(transactionResult) {
  try {
    const inner = transactionResult?.result;
    const type = typeof inner?.switch === "function" ? inner.switch().name : inner?.type;
    return type ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Testnet explorer link of a transaction. */
export const explorer = (hash) => `https://stellar.expert/explorer/testnet/tx/${hash}`;

/** Close time of the latest ledger, in Unix seconds. Throws rather than guessing. */
export async function ledgerTime() {
  const latest = await net(() => server.getLatestLedger(), "ledger");
  const closed = Number(latest.closeTime);
  if (!Number.isFinite(closed) || closed <= 0) throw new Error("RPC returned no ledger close time");
  return closed;
}

/** `getTransaction`, swallowing network errors: returns null when the RPC cannot answer. */
async function lookup(hash) {
  try {
    return await server.getTransaction(hash);
  } catch {
    return null;
  }
}

/**
 * Submits a signed transaction and returns once it has landed. Throws only
 * with a definitive answer: the transaction failed, or its validity window
 * closed without it landing. A lost response, a resend refused because the
 * first copy already applied, or a congested queue are all resolved by
 * looking the transaction up by hash.
 */
async function submit(tx, label, started = Date.now()) {
  const hash = Buffer.from(tx.hash()).toString("hex");
  const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
  const done = (result) => ({ result, hash, seconds: (Date.now() - started) / 1000, fee: feeCharged(result) });

  // 1. Get the transaction into the queue, or learn that it already applied.
  let delay = 1000;
  for (;;) {
    let sent = null;
    try {
      sent = await server.sendTransaction(tx);
    } catch {
      // Lost response: the transaction may be queued. Fall through to the lookup.
    }
    if (sent?.status === "PENDING" || sent?.status === "DUPLICATE") break;
    const known = await lookup(hash);
    if (known?.status === "SUCCESS") return done(known);
    if (known?.status === "FAILED") throw new Error(`${label}: transaction failed (${resultCode(known.resultXdr)}) ${explorer(hash)}`);
    if (sent?.status === "ERROR") throw new Error(`${label}: submission refused (${resultCode(sent.errorResult)})`);
    if (maxTime && Date.now() / 1000 > maxTime + 10) break; // expired: settle it in step 2
    process.stderr.write(`  (network: ${label} ${sent?.status ?? "no answer"}, resending in ${delay / 1000} s)\n`);
    await sleep(delay);
    delay = Math.min(delay * 2, 8000);
  }

  // 2. Wait for the outcome until the ledger has closed past the validity window.
  for (;;) {
    const result = await lookup(hash);
    if (result?.status === "SUCCESS") return done(result);
    if (result?.status === "FAILED") throw new Error(`${label}: transaction failed (${resultCode(result.resultXdr)}) ${explorer(hash)}`);
    let closed = 0;
    try {
      closed = await ledgerTime();
    } catch {
      // RPC unreachable: keep polling.
    }
    if (maxTime && closed > maxTime + 5) {
      const last = await lookup(hash);
      if (last?.status === "SUCCESS") return done(last);
      if (last) throw new Error(`${label}: expired before landing; nothing changed on chain, rerun the step`);
    }
    await sleep(1000);
  }
}

// ---------------------------------------------------------------------------
// State and keys (testnet only, git-ignored)
// ---------------------------------------------------------------------------

export function loadState() {
  if (!fs.existsSync(STATE_FILE)) return { keys: {}, contracts: {} };
  const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  registerContracts(state.contracts);
  return state;
}

export function saveState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  registerContracts(state.contracts);
}

export function keypair(state, role) {
  const secret = state.keys[role];
  if (!secret) throw new Error(`no key for role ${role}; run npm run setup`);
  return Keypair.fromSecret(secret);
}

/** Finds the local key of a G-address, to sign its authorization entries. */
function keyForAddress(state, address) {
  for (const secret of Object.values(state.keys)) {
    const kp = Keypair.fromSecret(secret);
    if (kp.publicKey() === address) return kp;
  }
  throw new Error(`no local key can authorize ${address}`);
}

/** Funds an account on testnet. Friendbot answers 400 when the account already exists. */
export async function friendbot(publicKey) {
  const response = await net(async () => {
    const r = await fetch(`${FRIENDBOT}?addr=${encodeURIComponent(publicKey)}`);
    if (r.status >= 500) throw new Error(`friendbot ${r.status}`);
    return r;
  }, "friendbot");
  if (response.ok) return;
  const body = await response.text();
  if (response.status === 400 && /already funded|createAccountAlreadyExist|op_already_exists/i.test(body)) return;
  throw new Error(`friendbot failed for ${publicKey}: ${response.status}`);
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

export const sv = {
  address: (a) => new Address(a).toScVal(),
  i128: (n) => nativeToScVal(BigInt(n), { type: "i128" }),
  u32: (n) => nativeToScVal(Number(n), { type: "u32" }),
  u64: (n) => nativeToScVal(BigInt(n), { type: "u64" }),
  symbol: (s) => xdr.ScVal.scvSymbol(s),
  bool: (b) => xdr.ScVal.scvBool(Boolean(b)),
  string: (s) => xdr.ScVal.scvString(s),
  bytes: (buf) => xdr.ScVal.scvBytes(buf),
  vec: (items) => xdr.ScVal.scvVec(items),
  /** A contracttype enum variant: `[Symbol(name), ...fields]`. */
  variant: (name, ...fields) => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name), ...fields]),
  /** A contracttype struct: a map with symbol keys sorted by name. */
  struct: (fields) =>
    xdr.ScVal.scvMap(
      Object.keys(fields)
        .sort()
        .map((key) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val: fields[key] })),
    ),
};

export const asset = {
  stellar: (contractId) => sv.variant("Stellar", sv.address(contractId)),
  other: (symbol) => sv.variant("Other", sv.symbol(symbol)),
};

/** Formats a 7-decimal token amount. */
export function fmt(amount, decimals = 7, digits = 2) {
  const value = Number(BigInt(amount)) / 10 ** decimals;
  return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export const ONE = 10_000_000n;

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

async function build(sourcePublicKey, operation) {
  const account = await net(() => server.getAccount(sourcePublicKey), "account");
  return new TransactionBuilder(account, { fee: "2000000", networkPassphrase: PASSPHRASE })
    .addOperation(operation)
    .setTimeout(TX_VALIDITY_SECS)
    .build();
}

/** Simulation auth entries arrive as XDR objects or base64 strings. */
function normalizeAuth(entries) {
  return (entries ?? []).map((entry) =>
    typeof entry === "string" ? xdr.SorobanAuthorizationEntry.fromXDR(entry, "base64") : entry,
  );
}

// SDK 17 exposes XDR unions as `{ type, <arm> }` objects; this mirrors the
// SDK's own `getAddressCredentials` in base/auth.js.
const ADDRESS_ARMS = {
  sorobanCredentialsAddress: (c) => c.address,
  sorobanCredentialsAddressV2: (c) => c.addressV2,
  sorobanCredentialsAddressWithDelegates: (c) => c.addressWithDelegates.addressCredentials,
};

/** Whether an auth entry must be signed by an address (not the tx source). */
function isAddressCredential(entry) {
  return entry.credentials.type in ADDRESS_ARMS;
}

/** The G- or C-address an address-credential entry is for. */
function credentialAddress(entry) {
  const credentials = entry.credentials;
  return Address.fromScAddress(ADDRESS_ARMS[credentials.type](credentials).address).toString();
}

/** Signs every address-credential entry with the matching local key. */
async function signAuth(state, entries) {
  const { sequence } = await net(() => server.getLatestLedger(), "ledger");
  return Promise.all(
    entries.map(async (entry) => {
      if (!isAddressCredential(entry)) return entry;
      const key = keyForAddress(state, credentialAddress(entry));
      return authorizeEntry(entry, key, sequence + 100, PASSPHRASE);
    }),
  );
}

/**
 * Submits one host-function operation from `sourceRole` and waits for it.
 * Returns `{ value, raw, hash, seconds, total, fee }`: the decoded return
 * value, the transaction hash, the seconds from submission to confirmation,
 * the seconds including simulation and signing, and the fee in stroops.
 */
export async function send(state, sourceRole, operation, label = sourceRole) {
  const begun = Date.now();
  const source = keypair(state, sourceRole);
  let tx = await build(source.publicKey(), operation);
  let sim = await net(() => server.simulateTransaction(tx), "simulate");
  if (rpc.Api.isSimulationError(sim)) throw simulationError(sim);

  const recorded = normalizeAuth(sim.result?.auth);
  if (recorded.some(isAddressCredential)) {
    const signed = await signAuth(state, recorded);
    const func = tx.operations[0].func;
    tx = await build(source.publicKey(), Operation.invokeHostFunction({ func, auth: signed }));
    sim = await net(() => server.simulateTransaction(tx), "simulate");
    if (rpc.Api.isSimulationError(sim)) throw simulationError(sim);
  }

  const ready = rpc.assembleTransaction(tx, sim).build();
  ready.sign(source);
  const { result, hash, seconds, fee } = await submit(ready, label);
  return {
    value: result.returnValue ? scValToNative(result.returnValue) : undefined,
    raw: result.returnValue,
    hash,
    seconds,
    total: (Date.now() - begun) / 1000,
    fee,
  };
}

/** Calls a contract function in a transaction. */
export function invoke(state, sourceRole, contractId, fn, args = []) {
  const operation = Operation.invokeContractFunction({ contract: contractId, function: fn, args });
  return send(state, sourceRole, operation, `${sourceRole} ${fn}`);
}

/** Simulates a contract call and returns the decoded value, or throws. */
export async function read(state, contractId, fn, args = [], sourceRole = "governor") {
  const source = keypair(state, sourceRole);
  const tx = await build(source.publicKey(), Operation.invokeContractFunction({ contract: contractId, function: fn, args }));
  const sim = await net(() => server.simulateTransaction(tx), "read");
  if (rpc.Api.isSimulationError(sim)) throw simulationError(sim);
  return scValToNative(sim.result.retval);
}

/** Simulates a call from `sourceRole` and reports the contract error it would hit, if any. */
export async function probe(state, sourceRole, contractId, fn, args = []) {
  try {
    await read(state, contractId, fn, args, sourceRole);
    return null;
  } catch (error) {
    if (error instanceof ContractError) return error;
    throw error;
  }
}

/** Submits a classic operation (trustline, payment). */
export async function classic(state, sourceRole, operation) {
  const source = keypair(state, sourceRole);
  const tx = await build(source.publicKey(), operation);
  tx.sign(source);
  return (await submit(tx, `${sourceRole} ${operation.type ?? "classic"}`)).hash;
}

/** Uploads a WASM file and deploys it with constructor arguments. */
export async function deploy(state, sourceRole, wasmFile, constructorArgs) {
  const wasm = fs.readFileSync(path.join(WASM_DIR, wasmFile));
  const upload = await send(state, sourceRole, Operation.uploadContractWasm({ wasm }), `upload ${wasmFile}`);
  const wasmHash = Buffer.from(upload.value);
  const created = await send(
    state,
    sourceRole,
    Operation.createCustomContract({
      address: new Address(keypair(state, sourceRole).publicKey()),
      wasmHash,
      salt: Buffer.from(Keypair.random().rawPublicKey()),
      constructorArgs,
    }),
    `deploy ${wasmFile}`,
  );
  return Address.fromScVal(created.raw).toString();
}

/** Deploys the Stellar Asset Contract of a classic asset, if missing. */
export async function deploySac(state, sourceRole, classicAsset) {
  const id = classicAsset.contractId(PASSPHRASE);
  try {
    await send(state, sourceRole, Operation.createStellarAssetContract({ asset: classicAsset }), "deploy asset contract");
  } catch (error) {
    if (!/ExistingValue|already exists/i.test(String(error.detail ?? error.message))) throw error;
  }
  return id;
}

export { Asset, Operation, Keypair };
