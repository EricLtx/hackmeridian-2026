// Shared helpers for the Open Window testnet demo.
//
// Every write goes through `send`: build, simulate, sign the authorization
// entries of every party that is not the transaction source (two-key fund
// admission needs it), re-simulate, assemble, sign, submit, wait. Reads go
// through `read`, a simulation that never submits.
//
// Submission gives a definitive answer: either the transaction landed, or its
// validity window has closed, on this machine's clock, and it never will.
// "Timed out, maybe later" is never reported, so a rerun cannot duplicate a
// step that landed late.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Account,
  Address,
  Asset,
  Keypair,
  Networks,
  Operation,
  SorobanDataBuilder,
  StrKey,
  TransactionBuilder,
  authorizeEntry,
  hash,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { LIMITS } from "./detectors.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");
export const STATE_DIR = path.join(here, ".state");
/** Name of the state file: `testnet` for the demo instance; `OPEN_WINDOW_STATE=<name>` points the tooling at a disposable instance (rehearsals), whose deployment facts stay out of `web/public/`. */
export const STATE_NAME = process.env.OPEN_WINDOW_STATE ?? "testnet";
export const STATE_FILE = path.join(STATE_DIR, `${STATE_NAME}.json`);
export const WASM_DIR = path.join(ROOT, "target", "wasm32v1-none", "release");

/**
 * RPC endpoints, tried in order. `STELLAR_RPC_URLS` lists several (comma
 * separated); `STELLAR_RPC_URL` names one; the default is the public SDF
 * testnet RPC, then Gateway.fm's public testnet RPC as a fallback (both
 * keyless and open to browsers). With several endpoints, a call that fails with a
 * network error, a 429/5xx or a transient inconsistency ("Account not found"
 * for a live account) is retried on the next endpoint, which then stays
 * active. Every endpoint must serve the same network.
 */
export const RPC_URLS = (process.env.STELLAR_RPC_URLS ?? process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org,https://soroban-rpc.testnet.stellar.gateway.fm")
  .split(",").map((u) => u.trim()).filter(Boolean);
export const RPC_URL = RPC_URLS[0];
/** Endpoints written into the public web deployment file: keyless public RPCs only. */
const WEB_RPC_URL = process.env.WEB_RPC_URL ?? "https://soroban-testnet.stellar.org";
const WEB_RPC_FALLBACKS = (process.env.WEB_RPC_FALLBACKS ?? "https://soroban-rpc.testnet.stellar.gateway.fm")
  .split(",").map((u) => u.trim()).filter((u) => u.startsWith("https://") && u !== WEB_RPC_URL);
export const PASSPHRASE = Networks.TESTNET;
export const FRIENDBOT = "https://friendbot.stellar.org";
const servers = RPC_URLS.map((url) => new rpc.Server(url));
let activeRpc = 0;
/** The endpoint currently in use. */
export const activeRpcUrl = () => RPC_URLS[activeRpc];
/**
 * The RPC client. With one endpoint it is the plain client; with several, a
 * proxy that fails over to the next endpoint on a transient error, so every
 * caller keeps using `server.<method>` unchanged.
 */
export const server = servers.length === 1
  ? servers[0]
  : new Proxy(servers[0], {
    get(_, prop) {
      const value = servers[activeRpc][prop];
      if (typeof value !== "function") return value;
      return async (...callArgs) => {
        for (let tried = 0; ; tried += 1) {
          try {
            return await servers[activeRpc][prop](...callArgs);
          } catch (error) {
            if (tried >= servers.length - 1 || !(isTransient(error) || /Account not found/i.test(error?.message ?? ""))) throw error;
            const from = RPC_URLS[activeRpc];
            activeRpc = (activeRpc + 1) % servers.length;
            process.stderr.write(`  (rpc: ${String(prop)} failed on ${from}: ${String(error?.message ?? error).slice(0, 80)}; switching to ${RPC_URLS[activeRpc]})\n`);
          }
        }
      };
    },
  });
/** Each endpoint's own client, in `RPC_URLS` order (the offline tests stub them). */
export const rpcServers = servers;

/** An endpoint other than the active one, for a second reading of what an action rests on: its index, or null with a single endpoint. */
export function secondEndpoint() {
  const other = servers.findIndex((_, i) => i !== activeRpc);
  return other < 0 ? null : other;
}

/**
 * Reads through one endpoint only, bypassing the failover: the second
 * reading that must agree with the first before the monitor acts (rpc-2).
 * Simulations come from the null account, like `read`.
 */
export function endpointClient(index) {
  const client = servers[index];
  const readHere = async (contractId, fn, args = []) => {
    const sim = await net(() => client.simulateTransaction(simulationTx(null, contractId, fn, args)), "read");
    if (rpc.Api.isSimulationError(sim)) throw simulationError(sim);
    return scValToNative(sim.result.retval);
  };
  return {
    url: RPC_URLS[index],
    read: readHere,
    async probe(contractId, fn, args = []) {
      try {
        await readHere(contractId, fn, args);
        return null;
      } catch (error) {
        if (error instanceof ContractError) return error;
        throw error;
      }
    },
    latestLedger: () => net(() => client.getLatestLedger(), "ledger"),
    /** `{ oldestLedger, latestLedger, ... }`: the ledgers this endpoint keeps. */
    health: () => net(() => client.getHealth(), "health"),
    ledgerEntries: (keys) => ledgerEntries(keys, client),
    events: (contractId, startLedger) => contractEvents(contractId, startLedger, client),
  };
}

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
  29: "DuplicateFund", 30: "Unauthorized", 31: "DelayCannotDecrease", 32: "NotProposed",
  33: "TimelockPending", 34: "ReleaseBlocked", 35: "PriceDivergence", 36: "NothingToRelease",
  37: "NoFallback", 38: "ProposalExpired", 39: "LimitReached", 40: "StewardCannotLend", 41: "NotSoleLender",
  42: "AttestationMissing", 43: "NotGuardianBackup", 44: "SoleLenderFixed", 45: "NoStewardBackup",
  46: "TrusteeFixed", 47: "TrusteeNotIndependent", 48: "FxBandExceedsHaircut",
  49: "SentinelNotIndependent", 50: "NothingToMigrate", 51: "SchemaOutdated",
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
  const kinds = { openWindow: null, shares: "fund-token", navOracle: "nav-oracle", euro: "stellar-asset", shares2: "fund-token", navOracle2: "nav-oracle", euro2: "stellar-asset", shares3: "stellar-asset", navOracle3: "nav-oracle" };
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
 * error started (a token refusing a transfer inside `open_repo`, say). The
 * error carries `simulation: true`: the call ran and failed, which a caller
 * tells apart from an RPC it could not reach.
 */
function simulationError(sim) {
  return Object.assign(decodeSimulationError(sim.error ?? ""), { simulation: true });
}

function decodeSimulationError(text) {
  // The surfaced code heads the message. Error events are listed newest first:
  // the oldest event carrying that same code names the contract it came from.
  // An error a contract caught (a refused `try_transfer`) carries another code
  // and is ignored, so the contract's own refusal is reported.
  const surfaced = /^HostError: Error\(Contract, #(\d+)\)/.exec(text)?.[1];
  const events = [...text.matchAll(/contract:(C[A-Z0-9]{55}), topics:\[error, Error\(Contract, #(\d+)\)\]/g)];
  const same = surfaced ? events.filter(([, , code]) => code === surfaced) : events;
  if (same.length) {
    const [, contractId, code] = same[same.length - 1];
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
// Testnet RPC drops a request now and then, and a crowded room shares one
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
async function lookup(hash, client = server) {
  try {
    return await client.getTransaction(hash);
  } catch {
    return null;
  }
}

/**
 * Seconds past a transaction's `maxTime`, on this machine's clock, before it
 * counts as expired: room for the skew between this clock and the network's
 * (the transaction's `maxTime` was set from this clock) and for the last
 * ledger that may still close inside the window to reach the endpoint.
 */
export const EXPIRY_MARGIN_SECS = 30;

/**
 * Submits a signed transaction and returns once it has landed. Throws only
 * with a definitive answer: the transaction failed, or its validity window
 * closed without it landing. A lost response, a resend refused because the
 * first copy already applied, or a congested queue are all resolved by
 * looking the transaction up by hash.
 *
 * The window is judged on this machine's clock, never on a close time the
 * endpoint reports (review finding TOOL-1, 20 October 2026): an endpoint
 * that holds the signed transaction back and claims a later ledger would
 * otherwise have the step called expired, rerun, and then land both. Before
 * saying that nothing changed, a second endpoint, when one is configured,
 * must not know the transaction either.
 */
async function submit(tx, label, started = Date.now()) {
  const hash = Buffer.from(tx.hash()).toString("hex");
  const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
  const done = (result) => ({ result, hash, seconds: (Date.now() - started) / 1000, fee: feeCharged(result) });
  const expired = () => maxTime > 0 && Date.now() / 1000 > maxTime + EXPIRY_MARGIN_SECS;

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
    if (expired()) break; // settled in step 2
    process.stderr.write(`  (network: ${label} ${sent?.status ?? "no answer"}, resending in ${delay / 1000} s)\n`);
    await sleep(delay);
    delay = Math.min(delay * 2, 8000);
  }

  // 2. Wait for the outcome until this machine's clock is past the validity window.
  for (;;) {
    const result = await lookup(hash);
    if (result?.status === "SUCCESS") return done(result);
    if (result?.status === "FAILED") throw new Error(`${label}: transaction failed (${resultCode(result.resultXdr)}) ${explorer(hash)}`);
    if (expired()) {
      const last = await lookup(hash);
      if (last?.status === "SUCCESS") return done(last);
      if (last?.status === "FAILED") throw new Error(`${label}: transaction failed (${resultCode(last.resultXdr)}) ${explorer(hash)}`);
      if (last) {
        const index = secondEndpoint();
        const other = index === null ? null : await lookup(hash, servers[index]);
        if (other?.status === "SUCCESS" || other?.status === "FAILED") {
          throw new Error(`${label}: ${activeRpcUrl()} does not know transaction ${hash}, ${RPC_URLS[index]} says ${other.status}: the endpoints disagree; check it in the explorer before rerunning the step ${explorer(hash)}`);
        }
        throw new Error(`${label}: expired before landing; nothing changed on chain, rerun the step`);
      }
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

/** The public key of a role, or null when this host holds no key for it. */
export function publicKeyOf(state, role) {
  return state.keys?.[role] ? keypair(state, role).publicKey() : null;
}

/**
 * The keys that sign for a role. A role turned into a native multisig
 * account (`state.multisig[role]`, set by `setup -- --multisig`) needs every
 * listed key: the account's thresholds require their combined weight.
 */
export function signersOf(state, role) {
  const roles = state.multisig?.[role] ?? [role];
  return roles.map((r) => keypair(state, r));
}

/** The keys that sign for a G-address, to authorize its entries. */
function signersForAddress(state, address) {
  for (const role of Object.keys(state.keys)) {
    if (keypair(state, role).publicKey() === address) return signersOf(state, role);
  }
  throw new Error(`no local key can authorize ${address}`);
}

/** Signs a transaction envelope with every key of the source role. */
function signTx(state, role, tx) {
  for (const key of signersOf(state, role)) tx.sign(key);
}

/**
 * Signature value for an address credential signed by several keys of one
 * account: a vector of { public_key, signature } maps, sorted by public key,
 * which is the order the host requires for a multisig account.
 */
function multisigSignature(keys, payload) {
  const entries = keys
    .map((key) => ({ raw: key.rawPublicKey(), signature: key.sign(Buffer.from(payload)) }))
    .sort((a, b) => Buffer.compare(Buffer.from(a.raw), Buffer.from(b.raw)));
  return xdr.ScVal.scvVec(
    entries.map(({ raw, signature }) =>
      nativeToScVal(
        { public_key: Buffer.from(raw), signature: Buffer.from(signature) },
        { type: { public_key: ["symbol", null], signature: ["symbol", null] } },
      ),
    ),
  );
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

/** The inclusion fee every transaction bids, in stroops; the resource fee comes on top. */
const INCLUSION_FEE = "2000000";

/**
 * The most a simulation may ask in resource fees before anything is signed:
 * 25 XLM, as the web interface (web/src/chain.js). Legitimate calls cost
 * about 1 XLM on testnet; the caps below are for the two writes that pay
 * rent on a large entry.
 */
export const MAX_RESOURCE_FEE = 250_000_000n;
/**
 * One 30-day slice of the contract code entry. The testnet rent moves: 7.15
 * XLM a day in the morning of 20 October 2026, 8.35 to 8.40 XLM a day in
 * the afternoon, so about 250 XLM a slice for the rc4 code and 257 XLM for
 * rc5's, about 2 % larger (review finding TOOL-6). 400 XLM leaves about half
 * as much again for the rate to rise, and stays under the 429.49 XLM a
 * transaction fee can carry (a uint32 in stroops) with the inclusion bid on
 * top. Beyond it, `extendCode` falls back to a shorter slice.
 */
export const CODE_SLICE_MAX_FEE = 4_000_000_000n;
/** An upload creates the code entry with the network's minimum time to live: about 60 XLM for night_window.wasm on testnet (20 October 2026). */
export const UPLOAD_MAX_FEE = 1_000_000_000n;

async function build(sourcePublicKey, operation) {
  const account = await net(() => server.getAccount(sourcePublicKey), "account");
  return new TransactionBuilder(account, { fee: INCLUSION_FEE, networkPassphrase: PASSPHRASE })
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

// ---------------------------------------------------------------------------
// What a simulation may ask before anything is signed (rpc-1)
// ---------------------------------------------------------------------------
//
// The RPC answers the simulation, and the simulation decides what is signed:
// the authorization entries, the footprint (with the entries to restore) and
// the resource fee. A hostile or compromised endpoint could slip in an entry
// for another call, signed with a role key and replayed elsewhere, or a
// footprint and a fee that drain the paying account. Each is checked against
// what the operation itself is; anything else is refused before a signature.

/** The value of an XDR union's arm, whatever its name. */
const armOf = (union) => union[Object.keys(union).find((key) => key !== "type")];

/** The authorized function that stands for each host function. */
const AUTHORIZED_FOR = {
  hostFunctionTypeInvokeContract: "sorobanAuthorizedFunctionTypeContractFn",
  hostFunctionTypeCreateContract: "sorobanAuthorizedFunctionTypeCreateContractHostFn",
  hostFunctionTypeCreateContractV2: "sorobanAuthorizedFunctionTypeCreateContractV2HostFn",
};

/** Whether an authorized function is exactly the operation's own call, arguments included. */
function isOwnCall(authorized, func) {
  return AUTHORIZED_FOR[func.type] === authorized.type && armOf(authorized).toXDR("base64") === armOf(func).toXDR("base64");
}

/** A short name of an authorized function, for messages. */
function describeCall(authorized) {
  const call = armOf(authorized);
  if (authorized.type === "sorobanAuthorizedFunctionTypeContractFn") return `${Address.fromScAddress(call.contractAddress).toString().slice(0, 8)}….${String(call.functionName)}`;
  return "a contract creation";
}

/** Every address an ScVal carries, at any depth. */
function addressesIn(value, out = new Set()) {
  if (!value) return out;
  if (value.type === "scvAddress") out.add(Address.fromScAddress(value.address).toString());
  else if (value.type === "scvVec") for (const item of value.vec ?? []) addressesIn(item, out);
  else if (value.type === "scvMap") for (const entry of value.map ?? []) addressesIn(entry.val, addressesIn(entry.key, out));
  return out;
}

/** The contract a creation makes: sha256 of its id preimage on this network. */
function createdContract(call) {
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(new xdr.HashIdPreimageContractId({ networkId: hash(Buffer.from(PASSPHRASE)), contractIdPreimage: call.contractIdPreimage }));
  return StrKey.encodeContract(hash(preimage.toXDR()));
}

/** The addresses an operation names: the contract it calls or creates, its arguments, its deployer. */
function operationAddresses(func) {
  const out = new Set();
  const call = armOf(func);
  if (func.type === "hostFunctionTypeInvokeContract") {
    out.add(Address.fromScAddress(call.contractAddress).toString());
    for (const arg of call.args) addressesIn(arg, out);
  } else if (func.type === "hostFunctionTypeCreateContract" || func.type === "hostFunctionTypeCreateContractV2") {
    out.add(createdContract(call));
    for (const arg of call.constructorArgs ?? []) addressesIn(arg, out);
    if (call.contractIdPreimage.type === "contractIdPreimageFromAddress") out.add(Address.fromScAddress(call.contractIdPreimage.fromAddress.address).toString());
  }
  return out;
}

/** The role a local key holds for an address, for messages. */
function roleOf(state, address) {
  const role = Object.keys(state.keys ?? {}).find((r) => publicKeyOf(state, r) === address);
  return role ? `${role} (${address.slice(0, 6)}…)` : address;
}

/**
 * The addresses expected to authorize an operation: its source, the
 * addresses it names, and the co-signers the caller declares (a role the
 * contract has on record, such as the steward for `propose_fallback`).
 */
export function expectedSigners(state, sourceRole, func, cosigners = []) {
  const expected = operationAddresses(func);
  expected.add(keypair(state, sourceRole).publicKey());
  for (const role of cosigners) {
    const address = publicKeyOf(state, role);
    if (address) expected.add(address);
  }
  return expected;
}

/** How a refusal ends while nothing has left this machine signed. */
export const NOTHING_SIGNED = "nothing signed";

/**
 * How a refusal ends once authorization entries were signed and sent to the
 * RPC in the second simulation: the transaction itself was not signed, but
 * those signatures are out, until their expiry ledger.
 */
const signedForSimulation = (count, expiry) =>
  `the transaction was not signed or sent, but ${count} authorization ${count === 1 ? "entry" : "entries"} signed for its simulation reached the RPC, valid until ledger ${expiry}`;

/**
 * Refuses an authorization entry that is not for the operation's own call,
 * or an address-credential entry for an address the operation does not
 * expect. A signature over another call could be replayed in a transaction
 * the RPC builds (rpc-1); one from an unexpected role is never needed.
 *
 * The transaction's source never signs an entry of its own (review finding
 * TOOL-1, 20 October 2026): an honest endpoint records the source's
 * authority as source-account credentials, which only this transaction
 * carries. An address credential for the source would be a signature that
 * any transaction, from any fee payer, could carry until its expiry.
 *
 * Below the root, the only node signed is a transfer by the entry's signer
 * of a token of this deployment into the Open Window contract (review
 * finding TOOL-5): see `checkSubInvocations`.
 *
 * `source` is the source's G-address, `tail` ends the message, `tokens`
 * adds token contracts the state does not list (a registered stablecoin).
 */
export function checkAuthEntries(state, entries, func, expected, label, { source = null, tail = NOTHING_SIGNED, tokens = [] } = {}) {
  const allowed = deploymentTokens(state, tokens);
  for (const entry of entries) {
    const root = entry.rootInvocation.function;
    if (!isOwnCall(root, func)) {
      throw new Error(`${label}: the simulation asks to authorize ${describeCall(root)}, not this call; ${tail} (rpc-1)`);
    }
    let signer = source;
    if (isAddressCredential(entry)) {
      const address = credentialAddress(entry);
      if (source && address === source) {
        throw new Error(`${label}: the simulation asks the transaction's source, ${roleOf(state, address)}, to sign this call apart from the transaction, which an honest endpoint never does and which another transaction could replay; ${tail} (rpc-1)`);
      }
      if (!expected.has(address)) throw new Error(`${label}: the simulation asks ${roleOf(state, address)} to authorize this call, which does not expect it; ${tail} (rpc-1)`);
      signer = address;
    }
    checkSubInvocations(state, entry.rootInvocation, signer, allowed, label, tail);
  }
}

/** The token contracts a transfer into Open Window may move: every contract of this deployment but Open Window itself, and those the caller declares. */
function deploymentTokens(state, extra = []) {
  const ow = state.contracts?.openWindow;
  const ids = Object.values(state.contracts ?? {}).filter((id) => typeof id === "string" && id.startsWith("C") && id !== ow);
  return new Set([...ids, ...extra]);
}

/** The address an ScVal holds, or null for any other value. */
const addressOf = (value) => (value?.type === "scvAddress" ? Address.fromScAddress(value.address).toString() : null);

/**
 * Walks the tree below an entry's root, at every depth. The only node it
 * accepts is `transfer(from, to, amount)` on a token of `tokens`, from the
 * entry's `signer`, to the Open Window contract: how the contract pulls
 * collateral, offer funds and repayments (token_io::pull). Any other node,
 * a transfer elsewhere or another function, is the signer's authority over
 * a call some contract on the path could make in its name: a compromised
 * feed or token, say, moving the signer's funds or taking a token's admin
 * role (review finding TOOL-5, 20 October 2026). Refused before a signature.
 */
function checkSubInvocations(state, node, signer, tokens, label, tail) {
  const ow = state.contracts?.openWindow;
  for (const sub of node.subInvocations ?? []) {
    const fn = sub.function;
    const call = fn.type === "sorobanAuthorizedFunctionTypeContractFn" ? armOf(fn) : null;
    const token = call ? Address.fromScAddress(call.contractAddress).toString() : null;
    const pull = call && String(call.functionName) === "transfer" && call.args.length === 3
      && tokens.has(token) && addressOf(call.args[0]) === signer && addressOf(call.args[1]) === ow;
    if (!pull) {
      throw new Error(`${label}: the simulation asks ${signer ? roleOf(state, signer) : "the signer"} to authorize ${describeCall(fn)} inside this call, which is not a transfer of its own tokens into Open Window; ${tail} (rpc-1)`);
    }
    checkSubInvocations(state, sub, signer, tokens, label, tail);
  }
}

/** The Soroban data of an assembled transaction: footprint, resources, resource fee. */
function sorobanDataOf(tx) {
  const ext = tx.toEnvelope().value.tx.ext;
  if (ext.type !== "sorobanData") throw new Error("not a Soroban transaction");
  return ext.value;
}

/** What a footprint key names, or null when it is an entry `known` allows to write. */
function foreignWrite(key, known) {
  if (key.type === "contractCode") return known.code?.has(Buffer.from(key.contractCode.hash.toXDR()).toString("hex")) ? null : "a contract's code";
  if (key.type === "contractData") {
    const owner = Address.fromScAddress(key.contractData.contract).toString();
    return known.addresses.has(owner) ? null : `data of ${owner}`;
  }
  if (key.type === "account" || key.type === "trustline") {
    const accountId = key.type === "account" ? key.account.accountId : key.trustLine.accountId;
    const owner = Address.fromScAddress(xdr.ScAddress.scAddressTypeAccount(accountId)).toString();
    return known.addresses.has(owner) ? null : `the ${key.type} of ${owner}`;
  }
  return `a ${key.type} entry`;
}

/**
 * Refuses a footprint that writes, or restores, an entry the operation does
 * not touch: an invocation writes only the data of this deployment's
 * contracts, of the contracts and accounts it names and of the local roles
 * (balances, trustlines, signature nonces), never contract code; an upload
 * writes only the code it uploads. Restoring a stranger's archived entry is
 * how a simulation makes the payer buy rent it never needed. `extra` names
 * addresses the call writes to without naming them, such as the holder a
 * `release` delivers to (review finding TOOL-9): their entries may be
 * written, and they sign nothing.
 */
export function checkFootprint(state, ready, func, expected, label, tail = NOTHING_SIGNED, extra = []) {
  const known = { addresses: new Set([...expected, ...extra]) };
  for (const id of Object.values(state.contracts ?? {})) if (typeof id === "string" && id.startsWith("C")) known.addresses.add(id);
  for (const role of Object.keys(state.keys ?? {})) known.addresses.add(publicKeyOf(state, role));
  // The SDK's hash() returns a Uint8Array: hex through a Buffer.
  if (func.type === "hostFunctionTypeUploadContractWasm") known.code = new Set([Buffer.from(hash(Buffer.from(func.wasm))).toString("hex")]);
  for (const key of sorobanDataOf(ready).resources.footprint.readWrite) {
    const why = foreignWrite(key, known);
    if (why) throw new Error(`${label}: the simulation writes ${why}, which this call does not touch; ${tail} (rpc-1)`);
  }
}

/**
 * Refuses an extension whose footprint is not exactly the requested keys,
 * read-only, with nothing to restore: the simulation chooses which entries
 * the keeper pays to extend, and a swapped footprint (another contract's
 * code, say) is rent the keeper never meant to pay (rpc-1).
 */
export function checkExtendFootprint(ready, keys, label) {
  const data = sorobanDataOf(ready);
  const asked = new Set(keys.map((k) => k.toXDR("base64")));
  const { readOnly, readWrite } = data.resources.footprint;
  const got = new Set(readOnly.map((k) => k.toXDR("base64")));
  const restores = data.ext.type === "v0" ? [] : armOf(data.ext).archivedSorobanEntries ?? [];
  if (readWrite.length || restores.length || got.size !== asked.size || [...got].some((k) => !asked.has(k))) {
    throw new Error(`${label}: the simulation extends other entries than the ${keys.length} asked; nothing signed (rpc-1)`);
  }
}

/**
 * Refuses a transaction whose resource fee is above `cap`, or whose total fee
 * is anything but the inclusion bid plus that resource fee: the fee signed is
 * the fee checked. A consistent fee that is only too high carries `feeAsked`
 * (stroops), so that a caller may size a cheaper call (`extendCode`).
 */
export function checkFee(ready, cap, label, tail = NOTHING_SIGNED) {
  const resourceFee = BigInt(sorobanDataOf(ready).resourceFee.toString());
  const beyondInclusion = BigInt(ready.fee) - BigInt(INCLUSION_FEE);
  if (resourceFee > cap || beyondInclusion > cap || beyondInclusion !== resourceFee) {
    throw feeAboveCap(beyondInclusion > resourceFee ? beyondInclusion : resourceFee, cap, label, tail, beyondInclusion === resourceFee);
  }
}

/** The refusal of a fee above `cap`; `sized` when the fee is consistent and only too high, which `feeAsked` then carries. */
function feeAboveCap(asked, cap, label, tail, sized = true) {
  const xlm = (stroops) => (Number(stroops) / 1e7).toFixed(2);
  const error = new Error(`${label}: the simulation asks ${xlm(asked)} XLM in resource fees, above the ${xlm(cap)} XLM this call may pay; ${tail} (rpc-1)`);
  if (sized) error.feeAsked = asked;
  return error;
}

/**
 * Refuses a simulation whose resource fee is above `cap` before the SDK
 * assembles it: a fee beyond the 429.49 XLM a transaction can carry would
 * not even assemble, and the refusal must still say what was asked.
 */
function checkSimulatedFee(sim, cap, label, tail = NOTHING_SIGNED) {
  const asked = BigInt(sim.minResourceFee ?? "0");
  if (asked > cap) throw feeAboveCap(asked, cap, label, tail);
}

/** Ledgers an authorization signature stays valid: about 8 minutes. */
const AUTH_VALIDITY_LEDGERS = 100;

/**
 * The ledger the authorization signatures expire at: 100 ledgers past the
 * lower of the latest ledgers of the active endpoint and of a second one
 * (review finding TOOL-1, 20 October 2026). The expiry is part of what is
 * signed, and one endpoint alone could announce a ledger far ahead to
 * stretch a signature's life. Two endpoints further apart than
 * `LIMITS.rpcLedgerGap`, or a second endpoint that does not answer, refuse
 * the signature. With a single endpoint configured, its word is taken.
 */
export async function signatureExpiry(label) {
  const active = Number((await net(() => server.getLatestLedger(), "ledger")).sequence);
  if (!Number.isSafeInteger(active) || active <= 0) throw new Error(`${label}: ${activeRpcUrl()} gave no latest ledger; ${NOTHING_SIGNED} (rpc-1)`);
  const index = secondEndpoint();
  if (index === null) return active + AUTH_VALIDITY_LEDGERS;
  let second;
  try {
    second = Number((await net(() => servers[index].getLatestLedger(), "ledger")).sequence);
  } catch (error) {
    throw new Error(`${label}: ${RPC_URLS[index]} did not give its latest ledger (${String(error?.message ?? error).split("\n")[0].slice(0, 80)}), so the expiry of the signatures cannot be checked; ${NOTHING_SIGNED} (rpc-1); retry, or list one endpoint in STELLAR_RPC_URLS to sign on its word alone`);
  }
  if (!Number.isSafeInteger(second) || Math.abs(active - second) > LIMITS.rpcLedgerGap) {
    throw new Error(`${label}: ${activeRpcUrl()} is at ledger ${active} and ${RPC_URLS[index]} at ${second}, more than ${LIMITS.rpcLedgerGap} apart: the expiry of the signatures cannot be trusted; ${NOTHING_SIGNED} (rpc-1)`);
  }
  return Math.min(active, second) + AUTH_VALIDITY_LEDGERS;
}

/** Signs every address-credential entry with the matching local key, valid until ledger `expiry`. */
async function signAuth(state, entries, expiry) {
  return Promise.all(
    entries.map(async (entry) => {
      if (!isAddressCredential(entry)) return entry;
      const address = credentialAddress(entry);
      const keys = signersForAddress(state, address);
      if (keys.length === 1) return authorizeEntry(entry, keys[0], expiry, PASSPHRASE);
      const signer = async (_preimage, payload) => ({ signatureScVal: multisigSignature(keys, payload), address });
      return authorizeEntry(entry, signer, expiry, PASSPHRASE);
    }),
  );
}

/**
 * Submits one host-function operation from `sourceRole` and waits for it.
 * Returns `{ value, raw, hash, seconds, total, fee }`: the decoded return
 * value, the transaction hash, the seconds from submission to confirmation,
 * the seconds including simulation and signing, and the fee in stroops.
 *
 * Before anything is signed, the simulation must authorize only this call,
 * by its source, the addresses it names and the declared `cosigners`, with
 * nothing below it but the signers' own transfers into Open Window of a
 * deployment token or one of `tokens`; write only entries the call touches;
 * and ask at most `maxResourceFee` (25 XLM by default). Otherwise it throws
 * and nothing leaves this machine. The entries of the co-signers are signed
 * before the second simulation, which checks them: a refusal after that
 * point says what went out. `extraAddresses` are addresses whose entries the
 * call may write without naming them (footprint only: they never sign).
 */
export async function send(state, sourceRole, operation, label = sourceRole, { cosigners = [], maxResourceFee = MAX_RESOURCE_FEE, tokens = [], extraAddresses = [] } = {}) {
  const begun = Date.now();
  const source = keypair(state, sourceRole);
  let tx = await build(source.publicKey(), operation);
  const func = tx.operations[0].func;
  const expected = expectedSigners(state, sourceRole, func, cosigners);
  let sim = await net(() => server.simulateTransaction(tx), "simulate");
  if (rpc.Api.isSimulationError(sim)) throw simulationError(sim);

  const recorded = normalizeAuth(sim.result?.auth);
  checkAuthEntries(state, recorded, func, expected, label, { source: source.publicKey(), tokens });
  let tail = NOTHING_SIGNED;
  if (recorded.some(isAddressCredential)) {
    const expiry = await signatureExpiry(label);
    const signed = await signAuth(state, recorded, expiry);
    tail = signedForSimulation(signed.filter(isAddressCredential).length, expiry);
    tx = await build(source.publicKey(), Operation.invokeHostFunction({ func, auth: signed }));
    sim = await net(() => server.simulateTransaction(tx), "simulate");
    if (rpc.Api.isSimulationError(sim)) throw simulationError(sim);
  }

  checkSimulatedFee(sim, maxResourceFee, label, tail);
  const ready = rpc.assembleTransaction(tx, sim).build();
  // The assembled transaction keeps our entries when we signed some, else it
  // takes the simulation's: check what is actually there.
  checkAuthEntries(state, ready.operations[0].auth ?? [], func, expected, label, { source: source.publicKey(), tail, tokens });
  checkFootprint(state, ready, func, expected, label, tail, extraAddresses);
  checkFee(ready, maxResourceFee, label, tail);
  signTx(state, sourceRole, ready);
  const { result, hash: txHash, seconds, fee } = await submit(ready, label);
  return {
    value: result.returnValue ? scValToNative(result.returnValue) : undefined,
    raw: result.returnValue,
    hash: txHash,
    seconds,
    total: (Date.now() - begun) / 1000,
    fee,
  };
}

/**
 * Calls a contract function in a transaction. `options.cosigners` names the
 * roles the contract requires besides the source and the addresses in
 * `args` (the steward on record for `propose_fallback`, the trustee for
 * `propose_upgrade`...); `options.maxResourceFee` raises the fee cap;
 * `options.tokens` names a token the state does not list whose transfer
 * into Open Window the call makes (a registered stablecoin);
 * `options.extraAddresses` names addresses the call writes to without
 * naming them (the holder a `release` delivers to), never signers.
 */
export function invoke(state, sourceRole, contractId, fn, args = [], options = {}) {
  const operation = Operation.invokeContractFunction({ contract: contractId, function: fn, args });
  return send(state, sourceRole, operation, `${sourceRole} ${fn}`, options);
}

/**
 * The source of a simulation that needs no account: an all-zero key nobody
 * holds, as web/src/chain.js uses. A read then needs no role key on the host
 * (the monitoring host keeps no governor secret) and no `getAccount` call.
 */
export const NULL_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/** A call to simulate, from `sourcePublicKey` or the null account; never signed, never sent. */
function simulationTx(sourcePublicKey, contractId, fn, args) {
  return new TransactionBuilder(new Account(sourcePublicKey ?? NULL_ACCOUNT, "0"), { fee: "100", networkPassphrase: PASSPHRASE })
    .addOperation(Operation.invokeContractFunction({ contract: contractId, function: fn, args }))
    .setTimeout(0)
    .build();
}

/**
 * Simulates a contract call and returns the decoded value, or throws. The
 * source is the null account unless a role is named: no key is needed to
 * read, and the answer does not depend on who asks.
 */
export async function read(state, contractId, fn, args = [], sourceRole = null) {
  const source = sourceRole ? keypair(state, sourceRole).publicKey() : null;
  const sim = await net(() => server.simulateTransaction(simulationTx(source, contractId, fn, args)), "read");
  if (rpc.Api.isSimulationError(sim)) throw simulationError(sim);
  return scValToNative(sim.result.retval);
}

/** Simulates a call (from `sourceRole`, or the null account when it is null) and reports the contract error it would hit, if any. */
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
  signTx(state, sourceRole, tx);
  return (await submit(tx, `${sourceRole} ${operation.type ?? "classic"}`)).hash;
}

/** Uploads a WASM file and deploys it with constructor arguments. */
export async function deploy(state, sourceRole, wasmFile, constructorArgs) {
  const wasm = fs.readFileSync(path.join(WASM_DIR, wasmFile));
  const upload = await send(state, sourceRole, Operation.uploadContractWasm({ wasm }), `upload ${wasmFile}`, { maxResourceFee: UPLOAD_MAX_FEE });
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

export { Asset, Operation, Keypair, StrKey };

// ---------------------------------------------------------------------------
// Ledger entries and their time to live (monitoring)
// ---------------------------------------------------------------------------

/** Ledger key of a persistent entry of `contractId`; `key` is an ScVal, or null for the instance. */
export function storageKey(contractId, key = null) {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: key ?? xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent,
    }),
  );
}

/** Ledger key of a contract's WASM code entry, from the code hash (hex or bytes). */
export function codeKey(hash) {
  const bytes = typeof hash === "string" ? Buffer.from(hash, "hex") : Buffer.from(hash);
  return xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: bytes }));
}

/** The most keys one `getLedgerEntries` call takes: the RPC refuses the 201st (live check, 20 October 2026). */
export const LEDGER_KEYS_PER_CALL = 200;

/**
 * Reads ledger entries: `{ latest, entries: [{ liveUntil, value }] }`, null
 * for a missing entry, in the order of `keys`. The keys go out in calls of at
 * most 200, so a growing number of positions never makes the read fail
 * (econ-3); `latest` is the highest ledger the calls answered at, which
 * errs towards a shorter time to live. `client` defaults to the failover
 * client; `endpointClient` passes one endpoint's.
 */
export async function ledgerEntries(keys, client = server) {
  const byKey = new Map();
  let latest = null;
  for (let start = 0; start < keys.length; start += LEDGER_KEYS_PER_CALL) {
    const chunk = keys.slice(start, start + LEDGER_KEYS_PER_CALL);
    const response = await net(() => client.getLedgerEntries(...chunk), "ledger entries");
    latest = Math.max(latest ?? 0, Number(response.latestLedger));
    for (const e of response.entries) byKey.set(e.key.toXDR("base64"), e);
  }
  if (latest === null) latest = Number((await net(() => client.getLatestLedger(), "ledger")).sequence);
  return {
    latest,
    entries: keys.map((k) => {
      const e = byKey.get(k.toXDR("base64"));
      return e ? { liveUntil: e.liveUntilLedgerSeq, value: e.val } : null;
    }),
  };
}

/**
 * Extends the time to live of persistent entries to `ledgers` from now.
 * Anyone may pay for it. The simulation must keep exactly these keys and ask
 * at most `maxResourceFee` (25 XLM; `CODE_SLICE_MAX_FEE` for the code entry).
 */
export async function extendTtl(state, sourceRole, keys, ledgers, { maxResourceFee = MAX_RESOURCE_FEE } = {}) {
  const label = `${sourceRole} extend TTL`;
  const source = keypair(state, sourceRole);
  const account = await net(() => server.getAccount(source.publicKey()), "account");
  const tx = new TransactionBuilder(account, { fee: INCLUSION_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(Operation.extendFootprintTtl({ extendTo: ledgers }))
    .setSorobanData(new SorobanDataBuilder().setReadOnly(keys).build())
    .setTimeout(TX_VALIDITY_SECS)
    .build();
  const sim = await net(() => server.simulateTransaction(tx), "simulate");
  if (rpc.Api.isSimulationError(sim)) throw simulationError(sim);
  checkSimulatedFee(sim, maxResourceFee, label);
  const ready = rpc.assembleTransaction(tx, sim).build();
  checkExtendFootprint(ready, keys, label);
  checkFee(ready, maxResourceFee, label);
  signTx(state, sourceRole, ready);
  const { hash: txHash, seconds, fee } = await submit(ready, label);
  return { hash: txHash, seconds, fee };
}

/** Ledgers in a day, at five seconds a ledger. */
export const LEDGERS_PER_DAY = 17_280;

/**
 * Extends the contract code entry `key` to `toDays` of life, from about
 * `fromDays` now, paying at most `maxResourceFee` (one slice). The rent is
 * the network's and moves: when the slice asks more than the cap, a shorter
 * one is tried once, sized on the rate per day that simulation showed, with
 * a tenth to spare (review finding TOOL-6, 20 October 2026). Returns the
 * extension's `{ hash, seconds, fee }` and `days`, the life it asked for.
 */
export async function extendCode(state, sourceRole, key, { fromDays, toDays, maxResourceFee = CODE_SLICE_MAX_FEE }) {
  const extend = async (days) => ({ ...(await extendTtl(state, sourceRole, [key], Math.floor(days * LEDGERS_PER_DAY), { maxResourceFee })), days });
  try {
    return await extend(toDays);
  } catch (error) {
    const added = toDays - fromDays;
    if (error.feeAsked === undefined || !Number.isFinite(fromDays) || !(added > 0)) throw error;
    // Rent is proportional to the days added: the slice that fits, nine tenths of the cap.
    const days = Math.floor((added * Number(maxResourceFee) * 9) / (10 * Number(error.feeAsked)));
    if (days < 1) throw error;
    process.stderr.write(`  (${String(error.message).split(";")[0]}: a ${days}-day slice instead)\n`);
    return extend(fromDays + days);
  }
}

/**
 * The latest ledger of every configured endpoint, asked in parallel: one
 * `{ url, sequence }` or `{ url, error }` per endpoint, in `RPC_URLS` order.
 * Bypasses the failover proxy on purpose: a cross-check needs every answer.
 */
export async function latestLedgers(timeoutMs = 10_000) {
  return Promise.all(servers.map(async (s, i) => {
    let timer;
    try {
      const latest = await Promise.race([
        s.getLatestLedger(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer in ${timeoutMs / 1000} s`)), timeoutMs); }),
      ]);
      return { url: RPC_URLS[i], sequence: Number(latest.sequence) };
    } catch (error) {
      return { url: RPC_URLS[i], error: String(error?.message ?? error).split("\n")[0].slice(0, 80) };
    } finally {
      clearTimeout(timer);
    }
  }));
}

/** Pages of events one read may fetch: a week of ledgers needs about 13 empty ones, and every 200 events one more. */
const EVENT_PAGES = 1_000;

/**
 * Contract events since `startLedger`, decoded: `{ ledger, name, topics,
 * data, txHash, id }`; `id` is the RPC event id, the key of the indexer's
 * journal. The array also carries `startLedger`, where the read began (the
 * RPC's oldest ledger when the one asked is past its retention), and
 * `reachedLedger`, the last ledger it covered: the next read starts after it.
 */
export async function contractEvents(contractId, startLedger, client = server) {
  const out = [];
  let cursor;
  let start = startLedger;
  let reached = null;
  for (let page = 0; page < EVENT_PAGES; page += 1) {
    const request = cursor
      ? { filters: [{ type: "contract", contractIds: [contractId] }], cursor, limit: 200 }
      : { filters: [{ type: "contract", contractIds: [contractId] }], startLedger: start, limit: 200 };
    let response;
    try {
      response = await net(() => client.getEvents(request), "events");
    } catch (error) {
      // The public RPC keeps a window of events it announces in this error
      // (sometimes well under a day): start from its oldest ledger instead.
      const range = /startLedger must be within the ledger range: (\d+) - (\d+)/.exec(error.message ?? "");
      if (!cursor && range && Number(range[1]) > start) {
        start = Number(range[1]);
        page -= 1;
        continue;
      }
      // Asked from a ledger this endpoint has not reached yet (a pass right
      // after the last one, a lagging endpoint): nothing to read so far.
      if (!cursor && range && Number(range[2]) < start) {
        reached = start - 1;
        break;
      }
      throw error;
    }
    for (const e of response.events) {
      const topics = e.topic.map((t) => scValToNative(t));
      out.push({ ledger: e.ledger, name: String(topics[0]), topics: topics.slice(1), data: scValToNative(e.value), txHash: e.txHash, id: e.id });
    }
    // The RPC scans at most about 10,000 ledgers per request and returns a
    // cursor at the end of the scanned stretch even when it holds no event:
    // a short page only ends the read once the cursor has reached the
    // latest ledger (the cursor is `<toid>-<index>`, ledger in the toid's
    // top 32 bits).
    const next = response.cursor;
    const latest = response.latestLedger ? Number(response.latestLedger) : null;
    if (!next || next === cursor) {
      reached = latest ?? reached;
      break;
    }
    const reachedLedger = /^(\d+)-/.exec(String(next)) ? Number(BigInt(/^(\d+)-/.exec(String(next))[1]) >> 32n) : null;
    if (response.events.length < 200 && (reachedLedger === null || !latest || reachedLedger >= latest)) {
      reached = latest ?? reachedLedger ?? reached;
      break;
    }
    // Not done yet: if the page limit stops the read here, the next one
    // resumes from this ledger.
    reached = reachedLedger === null ? reached : reachedLedger - 1;
    cursor = next;
  }
  return Object.assign(out, { startLedger: start, reachedLedger: reached });
}

/**
 * Writes the public facts of the deployment for the web interface:
 * network, contract addresses, offer ids. No key, no secret.
 */
export function writeDeployment(state) {
  const pub = (role) => keypair(state, role).publicKey();
  const deployment = {
    network: "testnet",
    // The web endpoints are public by construction: the operator's own list (STELLAR_RPC_URLS) may
    // carry an API key and never reaches the published file. WEB_RPC_URL and WEB_RPC_FALLBACKS override.
    rpcUrl: WEB_RPC_URL,
    rpcFallbacks: WEB_RPC_FALLBACKS,
    networkPassphrase: PASSPHRASE,
    explorer: "https://stellar.expert/explorer/testnet",
    contracts: {
      openWindow: state.contracts.openWindow,
      fundShares: state.contracts.shares,
      navFeed: state.contracts.navOracle,
      stablecoin: state.contracts.euro,
      fxFeed: state.fxSource === "local" ? state.contracts.navOracle : REFLECTOR_FX_TESTNET,
    },
    stablecoin: { code: "tEUR", issuer: pub("euroIssuer"), currency: "EUR", decimals: 7 },
    fund: { symbol: "tMMF", name: "Test US T-bill fund share", decimals: 7, navCurrency: "USD" },
    offers: { sponsor: state.ids.sponsorOffer ?? null, market: state.ids.marketOffer ?? null },
    updatedAt: new Date().toISOString(),
  };
  // Every admitted fund and every registered stablecoin, for the pages that list them.
  // The first entries repeat `fund` and `stablecoin`: readers of the old shape keep working.
  deployment.funds = [
    { ...deployment.fund, shares: state.contracts.shares, navFeed: state.contracts.navOracle, priceSource: "Cross" },
    ...(state.contracts.shares2
      ? [{ symbol: "tEMMF", name: "Test euro money market fund share", decimals: 7, navCurrency: "EUR", shares: state.contracts.shares2, navFeed: state.contracts.navOracle2, priceSource: "Direct" }]
      : []),
    // Third fund (`setup -- --third-fund`): a classic Stellar asset held through its Stellar Asset Contract, not a token this repository wrote.
    ...(state.contracts.shares3
      ? [{ symbol: "tSHARE", name: "Test fund share as a classic asset (Stellar Asset Contract)", decimals: 7, navCurrency: "EUR", shares: state.contracts.shares3, navFeed: state.contracts.navOracle3, priceSource: "Direct", tokenCode: "stellar-asset-contract" }]
      : []),
  ];
  deployment.stablecoins = [
    { ...deployment.stablecoin, contract: state.contracts.euro },
    ...(state.contracts.euro2 ? [{ code: "tEURB", issuer: pub("euroIssuer"), currency: "EUR", decimals: 7, contract: state.contracts.euro2 }] : []),
  ];
  if (state.ids.dualOffer !== undefined) deployment.offers.dual = state.ids.dualOffer;
  if (state.ids.secondOffer !== undefined) deployment.offers.second = state.ids.secondOffer;
  if (state.ids.thirdOffer !== undefined) deployment.offers.third = state.ids.thirdOffer;
  // A disposable instance (OPEN_WINDOW_STATE) never overwrites the facts the web interface serves.
  const dir = STATE_NAME === "testnet" ? path.join(ROOT, "web", "public") : STATE_DIR;
  const file = STATE_NAME === "testnet" ? "deployment.testnet.json" : `deployment-${STATE_NAME}.json`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), `${JSON.stringify(deployment, null, 2)}\n`);
  return deployment;
}
