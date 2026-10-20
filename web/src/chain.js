// Everything that talks to the network. Runs unchanged in the browser
// (Freighter signs) and in Node tests (a Keypair signs): a signer is any
// `{ address, sign(txXdr, networkPassphrase) -> signedTxXdr }`.
//
// Reads are simulations from a null account, so the board works without a
// wallet. Writes are built, simulated (a contract refusal surfaces here,
// before anything is signed), assembled, signed and submitted. In every
// write the connected wallet is the transaction source and the only party
// whose authority is consumed, so source-account authorization covers it.
//
// Submission reports failure only when it is definitive: the transaction
// failed, or the ledger closed past its validity window without it. A lost
// response or a busy queue is settled by looking the transaction up by hash.
//
// Adapted from demo/lib.mjs (same repository, Apache-2.0): `submit`, the
// retry rule of `net`, `sv`, `friendbot`, `resultCode` and `feeCharged`.

import {
  Account,
  Address,
  Asset,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { ContractError, TransactionError, WalletError, contractKinds, decodeSimulationError } from "./errors.js";
import { formatUnits } from "./format.js";
import { locale, t } from "./i18n.js";

/** The SDK's impossible account, used as the source of read-only simulations. */
export const NULL_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const FRIENDBOT = "https://friendbot.stellar.org";

/** Seconds a write stays valid. Long enough for a person to read the wallet prompt. */
export const TX_VALIDITY_SECS = 180;
/** Highest inclusion fee bid, in stroops; the network charges less when idle. */
const INCLUSION_FEE = "100000";
const SCAN_BATCH = 8;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** How long one RPC call may take before the next endpoint is tried; a scan of events and a submission get longer. */
export const RPC_TIMEOUT_MS = 7000;
const EVENTS_TIMEOUT_MS = 12000;
const SEND_TIMEOUT_MS = 10000;
/** Seconds past a write's validity window that a second endpoint gets to see it before its silence counts. */
const CONFIRM_GRACE_SECS = 30;

/** An RPC call that did not answer within its bound. */
export class RpcTimeout extends Error {
  constructor(ms) {
    super(`RPC timeout after ${Math.round(ms / 1000)} s`);
    this.name = "RpcTimeout";
  }
}

/** `promise`, or an RpcTimeout after `ms`. The request is not cancelled; a late answer is ignored. */
export function withTimeout(promise, ms) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new RpcTimeout(ms)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}
const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** ScVal builders. Structs are maps with sorted symbol keys; enum variants are vec [Symbol(name), ...]. */
export const sv = {
  address: (a) => new Address(a).toScVal(),
  i128: (n) => nativeToScVal(BigInt(n), { type: "i128" }),
  u32: (n) => nativeToScVal(Number(n), { type: "u32" }),
  u64: (n) => nativeToScVal(BigInt(n), { type: "u64" }),
  symbol: (s) => xdr.ScVal.scvSymbol(s),
  vec: (items) => xdr.ScVal.scvVec(items),
  variant: (name, ...fields) => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name), ...fields]),
};

/** A SEP-40 asset as decoded by scValToNative (["Other", "EUR"]) back to an ScVal. */
function assetScVal([kind, value]) {
  return kind === "Stellar" ? sv.variant("Stellar", sv.address(value)) : sv.variant("Other", sv.symbol(value));
}

/** A signer backed by a secret key. For tests and scripts only, never in the browser. */
export function keypairSigner(keypair) {
  return {
    address: keypair.publicKey(),
    async sign(txXdr, networkPassphrase) {
      const tx = TransactionBuilder.fromXDR(txXdr, networkPassphrase);
      tx.sign(keypair);
      return tx.toXDR();
    },
  };
}

function isTransient(error) {
  const text = `${error?.message ?? ""} ${error?.cause?.code ?? ""} ${error?.response?.status ?? ""}`;
  // Chrome says "Failed to fetch", Firefox "NetworkError", Safari "Load failed" (a CORS refusal included).
  return /fetch|load failed|network|connection was lost|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|\b(429|50[0-4])\b/i.test(text);
}

/** Ledgers the endpoint in use may trail the highest one before calls move to another endpoint. */
export const STALE_LEDGERS = 10;
/** Ledgers within which an endpoint counts as level with the highest: each one is read at a slightly different moment. */
export const LEVEL_LEDGERS = 1;
const HEIGHT_TIMEOUT_MS = 4000;

/**
 * Which endpoint calls should use, from the latest ledger each one reports
 * (null for one that did not answer): the first endpoint whenever it is
 * level with the highest; else the one in use, unless it trails the highest
 * by more than STALE_LEDGERS, in which case the first endpoint that is
 * level. An endpoint that did not answer is no reason to move: a failing
 * call moves on its own (`failover`). Returns `{ index, reason, behind }`,
 * reason "behind" or "level" when calls should move, else null.
 */
export function pickEndpoint(heights, active) {
  const known = heights.filter((h) => Number.isSafeInteger(h));
  const stay = { index: active, reason: null, behind: 0 };
  if (!known.length) return stay;
  const highest = Math.max(...known);
  const level = (i) => Number.isSafeInteger(heights[i]) && highest - heights[i] <= LEVEL_LEDGERS;
  if (active !== 0 && level(0)) return { index: 0, reason: "level", behind: 0 };
  const mine = heights[active];
  if (!Number.isSafeInteger(mine) || highest - mine <= STALE_LEDGERS) return stay;
  const best = heights.findIndex((_, i) => level(i));
  return best >= 0 && best !== active ? { index: best, reason: "behind", behind: highest - mine } : stay;
}

/** The sentence that says calls moved to another endpoint, from an `onRpcChange` notice. */
export function rpcChangeText({ from, to, reason, behind = 0 }) {
  if (reason === "timeout") return t("RPC {from} did not answer in time: switched to {to}.", { from, to });
  if (reason === "behind") return t("RPC {from} is {n} ledgers behind: switched to {to}.", { from, to, n: behind });
  if (reason === "level") return t("RPC {to} has caught up: switched back to it.", { to });
  return t("RPC {from} failed: switched to {to}.", { from, to });
}

/**
 * An RPC client that sends no header but `Content-Type`. The SDK adds
 * `X-Client-Name` and `X-Client-Version`, and a browser's CORS preflight
 * fails on an endpoint that allows `Content-Type` alone, as Gateway.fm's
 * public RPC does: the fallback would then refuse every call.
 */
export function rpcServer(url) {
  const server = new rpc.Server(url);
  const headers = server.httpClient?.defaults?.headers;
  if (headers) {
    delete headers["X-Client-Name"];
    delete headers["X-Client-Version"];
  }
  return server;
}

/** Result code of a transaction result (`txFailed`, `txBadSeq`...), across SDK XDR shapes. */
function resultCode(transactionResult) {
  try {
    const inner = typeof transactionResult?.result === "function" ? transactionResult.result() : transactionResult?.result;
    return (typeof inner?.switch === "function" ? inner.switch().name : inner?.type) ?? "unknown";
  } catch {
    return "unknown";
  }
}

function feeCharged(result) {
  try {
    const r = result.resultXdr;
    const fee = typeof r?.feeCharged === "function" ? r.feeCharged() : r?.feeCharged;
    return fee === undefined ? null : BigInt(String(fee));
  } catch {
    return null;
  }
}

/** Ledger sequence encoded in a getEvents cursor (a TOID: ledger in the high 32 bits). */
function cursorLedger(cursor) {
  try {
    return Number(BigInt(String(cursor).split("-")[0]) >> 32n);
  } catch {
    return 0;
  }
}

// Decoded values come from an RPC and from contracts the page does not
// control (an exchange-rate feed): their shape is checked here, at the
// boundary, so that nothing but integers and Stellar addresses reaches the
// markup where a number or an address is expected.
const STRKEY = /^[GC][A-Z2-7]{55}$/;
const isInt = (v) => typeof v === "bigint" || Number.isSafeInteger(v);

/** Throws unless every listed field of `value` is an integer or, for `addresses`, a Stellar address. */
export function checkShape(value, { ints = [], addresses = [], what = "value" } = {}) {
  if (!value || typeof value !== "object") throw new TypeError(`unexpected ${what} from the chain`);
  for (const k of ints) if (k in value && !isInt(value[k])) throw new TypeError(`unexpected ${what}.${k} from the chain`);
  for (const k of addresses) if (k in value && !(typeof value[k] === "string" && STRKEY.test(value[k]))) throw new TypeError(`unexpected ${what}.${k} from the chain`);
  return value;
}

/** A SEP-40 price as `lastprice` returns it: `{ price, timestamp }`, both integers, or the error to show. */
export function checkPrice(settled) {
  if (!settled || settled.error || settled.value === null || settled.value === undefined) return settled;
  try {
    checkShape(settled.value, { ints: ["price", "timestamp"], what: "price" });
    if (!("price" in settled.value) || !("timestamp" in settled.value)) throw new TypeError("unexpected price from the chain");
    return settled;
  } catch (error) {
    return { error };
  }
}

/** Decimals read on chain stay between 0 and 38: a larger one would freeze the page in a power of ten. */
const DECIMAL_KEYS = ["nav_decimals", "fx_decimals", "share_decimals", "price_decimals", "decimals"];
export function checkDecimals(value, what = "value") {
  for (const k of DECIMAL_KEYS) {
    if (value && typeof value === "object" && k in value) {
      const d = Number(value[k]);
      if (!Number.isSafeInteger(d) || d < 0 || d > 38) throw new TypeError(`unexpected ${what}.${k} from the chain`);
    }
  }
  return value;
}

/** A Soroban symbol, as a currency or an asset ticker decodes. */
const SYMBOL = /^[A-Za-z0-9_]{1,32}$/;

/** Throws unless `value` has every key: a missing field would reach the page as undefined, then BigInt(). */
function need(value, keys, what) {
  for (const k of keys) if (!(k in value)) throw new TypeError(`missing ${what}.${k} from the chain`);
}

/** An integer read on chain (u32, u64 or i128), or a TypeError. */
export function checkInt(value, what = "value") {
  if (!isInt(value)) throw new TypeError(`unexpected ${what} from the chain`);
  return value;
}

/** A SEP-40 asset as decoded: `["Stellar", address]` or `["Other", symbol]`. */
function checkAsset(asset, what) {
  const [kind, id] = Array.isArray(asset) && asset.length === 2 ? asset : [];
  const ok = typeof id === "string" && ((kind === "Stellar" && STRKEY.test(id)) || (kind === "Other" && SYMBOL.test(id)));
  if (!ok) throw new TypeError(`unexpected ${what} from the chain`);
}

const FUND_INTS = ["haircut_bps", "nav_max_age_secs", "corridor_floor_bps", "max_yield_bps", "max_principal_per_repo", "max_outstanding"];
const LEG_INTS = ["haircut_bps", "max_age_secs", "band_bps"];
const STATE_INTS = ["share_decimals", "nav_decimals", "fx_decimals", "reference_nav", "reference_time", "reference_fx", "outstanding"];

/**
 * A fund's settings as `get_fund` returns them (FundConfig), or null for a
 * fund not admitted. The price source is `["Direct"]` or `["Cross", leg]`;
 * anything else is refused here, so the exchange-rate read never starts
 * from a source it cannot use.
 */
export function checkFund(value) {
  if (value === null || value === undefined) return null;
  checkShape(value, { ints: FUND_INTS, addresses: ["oracle", "steward"], what: "fund" });
  need(value, [...FUND_INTS, "oracle", "steward", "oracle_asset", "currency", "source"], "fund");
  checkAsset(value.oracle_asset, "fund.oracle_asset");
  if (typeof value.currency !== "string" || !SYMBOL.test(value.currency)) throw new TypeError("unexpected fund.currency from the chain");
  const source = value.source;
  if (Array.isArray(source) && source.length === 1 && source[0] === "Direct") return value;
  if (Array.isArray(source) && source.length === 2 && source[0] === "Cross") {
    checkShape(source[1], { ints: LEG_INTS, addresses: ["oracle"], what: "fund.source" });
    need(source[1], [...LEG_INTS, "oracle", "asset"], "fund.source");
    checkAsset(source[1].asset, "fund.source.asset");
    return value;
  }
  throw new TypeError("unexpected fund.source from the chain");
}

/** A fund's state as `get_fund_state` returns it (FundState), or null for a fund not admitted. */
export function checkFundState(value) {
  if (value === null || value === undefined) return null;
  checkShape(value, { ints: STATE_INTS, what: "fund state" });
  need(value, [...STATE_INTS, "currency", "frozen"], "fund state");
  if (typeof value.frozen !== "boolean") throw new TypeError("unexpected fund state.frozen from the chain");
  if (typeof value.currency !== "string" || !SYMBOL.test(value.currency)) throw new TypeError("unexpected fund state.currency from the chain");
  return checkDecimals(value, "fund state");
}

/** Shares owed on a closed repo (`pending_release`): `{ fund, to, shares }`, or null when none are. */
export function checkPendingRelease(value) {
  if (value === null || value === undefined) return null;
  checkShape(value, { ints: ["shares"], addresses: ["fund", "to"], what: "pending release" });
  need(value, ["fund", "to", "shares"], "pending release");
  return value;
}

/** Applies `check` to a settled read: `{ value }` checked, or `{ error }` when the value is not what the contract returns. */
const settledWith = (check) => (settled) => {
  if (!settled || settled.error) return settled;
  try {
    return { value: check(settled.value) };
  } catch (error) {
    return { error };
  }
};
const isBool = (value, what) => {
  if (typeof value !== "boolean") throw new TypeError(`unexpected ${what} from the chain`);
  return value;
};

/** The most a transaction may carry in resource fees before anything is signed: legitimate calls cost about 1 XLM on testnet. */
export const MAX_RESOURCE_FEE = 250_000_000n;

/** The resource fee a built Soroban transaction declares in its envelope, or null for a classic one. */
export function resourceFeeOf(tx) {
  const envelope = tx.toEnvelope();
  const ext = envelope.type === "envelopeTypeTx" ? envelope.value.tx.ext : null;
  return ext?.type === "sorobanData" ? BigInt(ext.value.resourceFee.toString()) : null;
}

/**
 * Checks the fee of the assembled transaction, the one the wallet is asked to
 * sign, rather than the simulation's summary of it: the resource fee in its
 * envelope and its total fee beyond the inclusion bid each stay under
 * MAX_RESOURCE_FEE, they are the same amount, and they match the simulation's
 * own estimate when it gives one. An RPC that inflates the fee, or reports
 * one figure and sets another, is refused before anything is signed. Returns
 * the resource fee.
 */
export function checkFee(tx, { inclusionFee = BigInt(INCLUSION_FEE), cap = MAX_RESOURCE_FEE, estimate = null } = {}) {
  const resource = resourceFeeOf(tx);
  const beyond = BigInt(tx.fee) - BigInt(inclusionFee);
  const highest = resource !== null && resource > beyond ? resource : beyond;
  if (highest > cap) {
    throw new TransactionError("TxRefused", t("The network asked for an unusually high fee ({fee} XLM). Nothing was signed.", { fee: formatUnits(highest, 7, { digits: 2 }) }));
  }
  if (resource === null || resource !== beyond || (estimate !== null && BigInt(estimate) !== resource)) {
    throw new TransactionError("TxRefused", t("The fee of the prepared transaction does not match the network's estimate. Nothing was signed."));
  }
  return resource;
}

/** A simulation's fee estimate as an integer, or null when it gives none it can be held to. */
function estimateOf(sim) {
  try {
    return sim?.minResourceFee === undefined || sim.minResourceFee === null ? null : BigInt(sim.minResourceFee);
  } catch {
    return -1n; // an estimate that is not a number matches no fee
  }
}

const REPO_INTS = ["offer_id", "shares", "principal", "rate_bps", "opened_at", "maturity"];
const REPO_ADDRESSES = ["borrower", "lender", "fund", "stablecoin"];
const OFFER_INTS = ["available", "rate_bps", "max_term"];
const OFFER_ADDRESSES = ["lender", "stablecoin"];
const STATUSES = new Set(["Open", "Repurchased", "Defaulted"]);

const normalizeRepo = (id, repo) => {
  checkShape(repo, { ints: REPO_INTS, addresses: REPO_ADDRESSES, what: "repo" });
  const status = Array.isArray(repo.status) ? repo.status[0] : repo.status;
  if (!STATUSES.has(status)) throw new TypeError("unexpected repo.status from the chain");
  // The scanned id comes last: a decoded field named id cannot replace it.
  return { ...repo, id, status };
};

const normalizeOffer = (id, offer) => {
  checkShape(offer, { ints: OFFER_INTS, addresses: OFFER_ADDRESSES, what: "offer" });
  if (!Array.isArray(offer.funds) || !offer.funds.every((f) => typeof f === "string" && STRKEY.test(f))) throw new TypeError("unexpected offer.funds from the chain");
  return { ...offer, id, sponsor: offer.sponsor === true };
};

/** Decoded Soroban values as plain JSON, as the indexer writes them: big integers as strings, bytes as hex. */
export function plain(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") return value;
  if (value instanceof Uint8Array) return toHex(value);
  if (Array.isArray(value)) return value.map(plain);
  if (value instanceof Map) return Object.fromEntries([...value.entries()].map(([k, v]) => [String(plain(k)), plain(v)]));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  return String(value);
}

/** One `getEvents` entry in the shape of the indexer's export: the event name is topic 0. */
function decodeEvent(raw) {
  const topics = (raw.topic ?? []).map((topic) => plain(scValToNative(topic)));
  let data = null;
  try {
    data = plain(scValToNative(raw.value));
  } catch {
    data = null;
  }
  return { ledger: raw.ledger, closedAt: raw.ledgerClosedAt, txHash: raw.txHash, id: raw.id, event: String(topics[0] ?? ""), topics: topics.slice(1), data };
}

export class Chain {
  /** `deployment` is the parsed deployment.testnet.json. */
  constructor(deployment) {
    this.deployment = deployment;
    this.passphrase = deployment.networkPassphrase;
    this.contracts = deployment.contracts;
    this.fund = deployment.contracts.fundShares;
    // The RPC endpoints: the deployment's, then its fallbacks. A slow or failing one is left for the next.
    const urls = [deployment.rpcUrl, ...(Array.isArray(deployment.rpcFallbacks) ? deployment.rpcFallbacks : [])].filter(Boolean);
    this.endpoints = [...new Set(urls)].map((url) => ({ url, host: new URL(url).host, server: rpcServer(url), lastMs: null, failures: 0 }));
    this.active = 0;
    /** Pause between two looks at a submitted transaction, in milliseconds. */
    this.pollMs = 1000;
    /**
     * Called with `{ from, to, reason, behind }` when calls move to another endpoint: reason
     * "timeout" or "error" (a failing call), "behind" (it lagged by `behind` ledgers) or "level" (back to the first).
     */
    this.onRpcChange = null;
    this.kinds = contractKinds(deployment.contracts);
    /** The ticker of each token the page knows, by address: a token's refusal names that token. */
    this.codes = new Map();
    if (deployment.contracts.stablecoin && deployment.stablecoin?.code) this.codes.set(deployment.contracts.stablecoin, deployment.stablecoin.code);
    // Every admitted fund's share token and NAV feed, and every registered stablecoin, so a refusal names its contract.
    for (const f of deployment.funds ?? []) {
      const sac = f.tokenCode === "stellar-asset-contract";
      if (f.shares && !this.kinds.has(f.shares)) this.kinds.set(f.shares, sac ? "stellar-asset" : "fund-token");
      if (f.shares && sac && f.symbol) this.codes.set(f.shares, f.symbol);
      if (f.navFeed && !this.kinds.has(f.navFeed)) this.kinds.set(f.navFeed, "nav-oracle");
    }
    for (const c of deployment.stablecoins ?? []) {
      if (c.contract && !this.kinds.has(c.contract)) this.kinds.set(c.contract, "stellar-asset");
      if (c.contract && c.code) this.codes.set(c.contract, c.code);
    }
    this.nativeContract = Asset.native().contractId(this.passphrase);
    this.kinds.set(this.nativeContract, "stellar-asset");
    this.codes.set(this.nativeContract, "XLM");
    /** Addresses whose kind a read is settling, so each is asked once at a time. */
    this.learning = new Map();
  }

  /** A simulation's error, decoded and, for a token the page knows, given that token's ticker. */
  simulationError(text) {
    const error = decodeSimulationError(text, this.kinds);
    if (error instanceof ContractError && error.contractId) error.coin = this.codes.get(error.contractId) ?? null;
    return error;
  }

  /**
   * Learns the kind of the stablecoins the chain shows that the deployment
   * file does not list (offers and repos carry only registered ones), so a
   * refusal by any of them is named after it. A Stellar Asset Contract is
   * recognised by its name, "CODE:ISSUER", from which its address derives;
   * any other contract is a token with no table here. One read per new
   * address; a read the network did not answer is tried again later.
   */
  async learnCoins(addresses) {
    const fresh = [...new Set(addresses)].filter((a) => typeof a === "string" && STRKEY.test(a) && a.startsWith("C") && !this.kinds.has(a));
    await Promise.all(
      fresh.map((address) => {
        if (!this.learning.has(address)) {
          const settle = this.identify(address).finally(() => this.learning.delete(address));
          this.learning.set(address, settle);
        }
        return this.learning.get(address);
      }),
    );
  }

  async identify(address) {
    let name;
    try {
      name = await this.read(address, "name");
    } catch (error) {
      if (!(error instanceof ContractError)) return; // the network, not the contract: ask again later
      this.kinds.set(address, "token");
      return;
    }
    const [code, issuer] = typeof name === "string" ? name.split(":") : [];
    try {
      if (code && issuer && new Asset(code, issuer).contractId(this.passphrase) === address) {
        this.kinds.set(address, "stellar-asset");
        this.codes.set(address, code);
        return;
      }
    } catch {
      // Not an asset name: a token of its own.
    }
    this.kinds.set(address, "token");
  }

  explorerTx(hash) {
    return `${this.deployment.explorer}/tx/${hash}`;
  }

  explorerAccount(address) {
    return `${this.deployment.explorer}/${address.startsWith("C") ? "contract" : "account"}/${address}`;
  }

  /** The RPC client in use. Calls written `() => this.server.x()` pick up a switch when they are retried. */
  get server() {
    return this.endpoints[this.active].server;
  }

  /** The endpoint in use: `{ host, url, ms, index, count }`, `ms` the time of its last answer. */
  rpcInfo() {
    const endpoint = this.endpoints[this.active];
    return { host: endpoint.host, url: endpoint.url, ms: endpoint.lastMs, index: this.active, count: this.endpoints.length };
  }

  /**
   * Moves to the next endpoint after a timeout or a network failure of a call
   * made on endpoint `from`. Many calls run at once: only the first failure
   * on the endpoint in use switches; the others find the switch done and
   * retry on the new endpoint, so the interface never bounces between them.
   * False when there is no other endpoint or the error is not the network's.
   */
  failover(error, from = this.active) {
    if (this.endpoints.length < 2) return false;
    if (!(error instanceof RpcTimeout) && !isTransient(error)) return false;
    if (from !== this.active) return true;
    const previous = this.endpoints[this.active];
    previous.failures += 1;
    this.active = (this.active + 1) % this.endpoints.length;
    try {
      this.onRpcChange?.({ from: previous.host, to: this.endpoints[this.active].host, reason: error instanceof RpcTimeout ? "timeout" : "error" });
    } catch {
      // A failing listener never stops a call.
    }
    return true;
  }

  /**
   * The latest ledger of every endpoint, read at once within a short bound:
   * a sequence per endpoint, null for one that did not answer. `getHealth`
   * carries it in about 200 bytes, where `getLatestLedger` now ships the
   * whole ledger's metadata (about 330 KB on testnet); an endpoint that calls
   * itself unhealthy (its last ledger is old) is asked `getLatestLedger`,
   * since a lagging endpoint is what the comparison looks for.
   */
  async heights() {
    return Promise.all(
      this.endpoints.map(async (endpoint) => {
        try {
          const health = await withTimeout(endpoint.server.getHealth(), HEIGHT_TIMEOUT_MS);
          if (Number.isSafeInteger(health?.latestLedger)) return health.latestLedger;
        } catch (error) {
          if (error instanceof RpcTimeout || isTransient(error)) return null;
        }
        try {
          const latest = await withTimeout(endpoint.server.getLatestLedger(), HEIGHT_TIMEOUT_MS);
          return Number.isSafeInteger(latest?.sequence) ? latest.sequence : null;
        } catch {
          return null;
        }
      }),
    );
  }

  /**
   * Moves calls away from an endpoint that answers but lags: compares every
   * endpoint's latest ledger and applies `pickEndpoint`, so a fallback is
   * left for the first endpoint once that one is level again. The page runs
   * it before each refresh: the pass, its clock included, then reads an
   * endpoint that is current. Never throws; returns the heights read.
   */
  async checkHeights() {
    if (this.endpoints.length < 2) return [];
    const heights = await this.heights();
    const { index, reason, behind } = pickEndpoint(heights, this.active);
    if (reason && index !== this.active) {
      const previous = this.endpoints[this.active];
      this.active = index;
      try {
        this.onRpcChange?.({ from: previous.host, to: this.endpoints[index].host, reason, behind });
      } catch {
        // A failing listener never stops a refresh.
      }
    }
    return heights;
  }

  /**
   * Runs `call` on the endpoint in use, within `timeoutMs`. A timeout or a
   * transient network failure moves at once to the next endpoint when there
   * is one, else waits and retries; at most `attempts` calls.
   */
  async net(call, { timeoutMs = RPC_TIMEOUT_MS, attempts = 4 } = {}) {
    let delay = 800;
    let moves = 0;
    for (let attempt = 1; ; attempt += 1) {
      const index = this.active;
      const endpoint = this.endpoints[index];
      const started = Date.now();
      try {
        const result = await withTimeout(call(), timeoutMs);
        endpoint.lastMs = Date.now() - started;
        endpoint.failures = 0;
        return result;
      } catch (error) {
        if (attempt >= attempts || !(error instanceof RpcTimeout || isTransient(error))) throw error;
        // With every endpoint failing, a call backs off instead of bouncing back to the one it left.
        if (moves < this.endpoints.length - 1 && this.failover(error, index)) moves += 1;
        else {
          await sleep(delay);
          delay *= 2;
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** Simulates a contract call and returns the decoded value, or throws a typed error. */
  async read(contractId, fn, args = []) {
    const tx = new TransactionBuilder(new Account(NULL_ACCOUNT, "0"), { fee: "100", networkPassphrase: this.passphrase })
      .addOperation(Operation.invokeContractFunction({ contract: contractId, function: fn, args }))
      .setTimeout(0)
      .build();
    const sim = await this.net(() => this.server.simulateTransaction(tx));
    if (rpc.Api.isSimulationError(sim)) throw this.simulationError(sim.error);
    return scValToNative(sim.result.retval);
  }

  /** `read` that never throws: `{ value }` or `{ error }`. */
  async settle(contractId, fn, args = []) {
    try {
      return { value: await this.read(contractId, fn, args) };
    } catch (error) {
      return { error };
    }
  }

  /** Close time of the latest ledger, in Unix seconds. */
  async ledgerTime() {
    const latest = await this.net(() => this.server.getLatestLedger());
    const closed = Number(latest.closeTime);
    if (!Number.isFinite(closed) || closed <= 0) throw new Error(t("RPC returned no ledger close time"));
    return closed;
  }

  /** Reads `fn(id)` for id = from, from+1, ... until the first None. */
  async scan(fn, from = 1) {
    const found = [];
    for (let start = from; ; start += SCAN_BATCH) {
      const ids = Array.from({ length: SCAN_BATCH }, (_, i) => start + i);
      const values = await Promise.all(ids.map((id) => this.read(this.contracts.openWindow, fn, [sv.u64(id)])));
      for (let i = 0; i < ids.length; i += 1) {
        if (values[i] === null || values[i] === undefined) return found;
        found.push({ id: ids[i], value: values[i] });
      }
    }
  }

  /** What `shares` of `fund` (default: the interface's fund) secure now, fully checked by the contract. */
  quote(shares, fund = this.fund) {
    return this.read(this.contracts.openWindow, "quote", [sv.address(fund), sv.i128(shares), sv.address(this.contracts.stablecoin)]).then((q) =>
      checkDecimals(checkShape(q, { ints: ["max_principal", "price", "price_decimals", "haircut_bps"], what: "quote" }), "quote"),
    );
  }

  async offers() {
    const offers = (await this.scan("get_offer")).map(({ id, value }) => normalizeOffer(id, value));
    await this.learnCoins(offers.map((o) => o.stablecoin));
    return offers;
  }

  /** Repos from `from` on, until the first id with no repo. */
  async repos(from = 1) {
    const repos = (await this.scan("get_repo", from)).map(({ id, value }) => normalizeRepo(id, value));
    await this.learnCoins(repos.map((r) => r.stablecoin));
    return repos;
  }

  async repo(id) {
    const value = await this.read(this.contracts.openWindow, "get_repo", [sv.u64(id)]);
    const repo = value ? normalizeRepo(id, value) : null;
    if (repo) await this.learnCoins([repo.stablecoin]);
    return repo;
  }

  /** Interest due on an open repo if repurchased now (principal not included). */
  async repoDue(id) {
    return BigInt(checkInt(await this.read(this.contracts.openWindow, "repo_due", [sv.u64(id)]), "repo_due"));
  }

  /** Whether the fund's steward approves `address` as a lender; anything but true reads as no. */
  async isLenderApproved(address) {
    return (await this.read(this.contracts.openWindow, "is_lender_approved", [sv.address(this.fund), sv.address(address)])) === true;
  }

  /**
   * Everything the board shows, read in parallel. Each field is `{ value }`
   * or `{ error }`, so one stale feed does not blank the whole board.
   */
  async board(shares) {
    const ow = this.contracts.openWindow;
    const fund = sv.address(this.fund);
    const [config, state, paused, maxTerm, nav, quote, offers, cap, outstanding, now] = await Promise.all([
      this.settle(ow, "get_fund", [fund]).then(settledWith(checkFund)),
      this.settle(ow, "get_fund_state", [fund]).then(settledWith(checkFundState)),
      this.settle(ow, "is_paused").then(settledWith((v) => isBool(v, "is_paused"))),
      this.settle(ow, "max_term").then(settledWith((v) => checkInt(v, "max_term"))),
      this.settle(ow, "fund_price", [fund]).then(checkPrice),
      shares > 0n ? this.quote(shares).then((value) => ({ value }), (error) => ({ error })) : { value: null },
      this.offers().then((value) => ({ value }), (error) => ({ error })),
      this.settle(ow, "currency_cap", [sv.symbol(this.deployment.stablecoin.currency)]).then(settledWith((v) => checkInt(v, "currency_cap"))),
      this.settle(ow, "currency_outstanding", [sv.symbol(this.deployment.stablecoin.currency)]).then(settledWith((v) => checkInt(v, "currency_outstanding"))),
      this.ledgerTime().then((value) => ({ value }), (error) => ({ error })),
    ]);
    const fx = await this.exchangeRate(config.value);
    // Every admitted fund the deployment lists (one, or two after `setup -- --second-fund`): settings and state.
    const funds = await Promise.all(
      (this.deployment.funds ?? []).map(async (f) => {
        const [cfg, st] = await Promise.all([
          this.settle(ow, "get_fund", [sv.address(f.shares)]).then(settledWith(checkFund)),
          this.settle(ow, "get_fund_state", [sv.address(f.shares)]).then(settledWith(checkFundState)),
        ]);
        return { ...f, config: cfg, state: st };
      }),
    );
    return { config, state, paused, maxTerm, nav, fx, quote, offers, cap, outstanding, now, funds };
  }

  /**
   * The exchange rate of a cross-priced fund, read on its FX oracle: `{ value }`,
   * `{ error }`, or `{ value: null }` for a fund priced directly. A source the
   * page cannot read from becomes this field's error, never the whole pass's.
   */
  async exchangeRate(config) {
    const source = config?.source;
    if (!Array.isArray(source) || source[0] !== "Cross") return { value: null };
    try {
      return checkPrice(await this.settle(source[1].oracle, "lastprice", [assetScVal(source[1].asset)]));
    } catch (error) {
      return { error };
    }
  }

  /** Balances of an address: XLM, the stablecoin (null without trustline) and fund shares. */
  async balances(address) {
    const who = [sv.address(address)];
    const [xlm, stable, shares] = await Promise.all([
      this.settle(this.nativeContract, "balance", who),
      this.settle(this.contracts.stablecoin, "balance", who),
      this.settle(this.fund, "balance", who),
    ]);
    const missing = (r) => r.error && /TrustlineMissing|AccountMissing/.test(r.error.name ?? "");
    for (const r of [xlm, stable, shares]) {
      if (r.error && !missing(r)) throw r.error;
    }
    return {
      xlm: xlm.error ? null : BigInt(checkInt(xlm.value, "balance")),
      stablecoin: stable.error ? null : BigInt(checkInt(stable.value, "balance")),
      shares: shares.error ? 0n : BigInt(checkInt(shares.value, "balance")),
    };
  }

  /**
   * Repos opened by `borrower`, from the contract's `repo_opened` events
   * (topics: name, repo id, borrower). Returns `{ openings, nextLedger }`
   * where `openings` maps repo id to its opening transaction. The RPC keeps
   * events for a limited window, so this complements the `get_repo` scan,
   * it does not replace it.
   */
  async repoOpenings(borrower, startLedger = null) {
    const health = await this.net(() => this.server.getHealth());
    const start = Math.max(startLedger ?? health.oldestLedger, health.oldestLedger);
    const filters = [
      {
        type: "contract",
        contractIds: [this.contracts.openWindow],
        topics: [[sv.symbol("repo_opened").toXDR("base64"), "*", sv.address(borrower).toXDR("base64")]],
      },
    ];
    const openings = new Map();
    let request = { startLedger: Math.min(start, health.latestLedger), filters, limit: 100 };
    let latest = health.latestLedger;
    // Each response covers a bounded ledger range; follow the cursor to the tip.
    for (let page = 0; page < 40; page += 1) {
      const response = await this.net(() => this.server.getEvents(request), { timeoutMs: EVENTS_TIMEOUT_MS });
      for (const event of response.events) {
        openings.set(Number(scValToNative(event.topic[1])), { txHash: event.txHash, ledger: event.ledger });
      }
      latest = response.latestLedger;
      if (!response.cursor || response.cursor === request.cursor) break;
      if (response.events.length < 100 && cursorLedger(response.cursor) >= response.latestLedger) break;
      request = { cursor: response.cursor, filters, limit: 100 };
    }
    return { openings, nextLedger: latest };
  }

  /**
   * A fund's NAV as the contract reads it (`fund_price`) and, for a
   * cross-priced fund, its exchange rate. Each `{ value }` or `{ error }`.
   */
  async feeds(fund, config) {
    const [nav, fx] = await Promise.all([this.settle(this.contracts.openWindow, "fund_price", [sv.address(fund)]).then(checkPrice), this.exchangeRate(config)]);
    return { nav, fx };
  }

  /**
   * Governance changes waiting for their time delay, each `{ value }` (null
   * when nothing is pending) or `{ error }`: upgrade, governor handover,
   * guardian, envelope, term ceiling, the currency cap, and each fund; plus
   * the stored layout version.
   */
  async pendingChanges(funds = []) {
    const ow = this.contracts.openWindow;
    const currency = sv.symbol(this.deployment.stablecoin.currency);
    const [upgrade, admin, guardian, envelope, maxTerm, cap, schema] = await Promise.all([
      this.settle(ow, "pending_upgrade"),
      this.settle(ow, "pending_admin"),
      this.settle(ow, "pending_guardian_change"),
      this.settle(ow, "pending_envelope_change"),
      this.settle(ow, "pending_max_term_change"),
      this.settle(ow, "pending_currency_cap_change", [currency]),
      this.settle(ow, "schema_version"),
    ]);
    const fundChanges = await Promise.all(
      funds.map(async (f) => ({ symbol: f.symbol, change: await this.settle(ow, "pending_fund_change", [sv.address(f.shares)]) })),
    );
    return { upgrade, admin, guardian, envelope, maxTerm, cap, funds: fundChanges, schema };
  }

  /**
   * The contract's events from `startLedger` on (default: the oldest
   * ledger the RPC still keeps, about a week), decoded like the indexer's
   * export: `{ ledger, closedAt, txHash, id, event, topics, data }`, the
   * event name taken out of the topics. Returns `{ events, nextLedger }`.
   */
  async contractEvents(startLedger = null, { maxPages = 20 } = {}) {
    const health = await this.net(() => this.server.getHealth());
    const wanted = startLedger ?? health.oldestLedger;
    const start = Math.min(Math.max(wanted, health.oldestLedger), health.latestLedger);
    const filters = [{ type: "contract", contractIds: [this.contracts.openWindow] }];
    const events = [];
    let request = { startLedger: start, filters, limit: 100 };
    let latest = health.latestLedger;
    for (let page = 0; page < maxPages; page += 1) {
      const response = await this.net(() => this.server.getEvents(request), { timeoutMs: EVENTS_TIMEOUT_MS });
      for (const raw of response.events) events.push(decodeEvent(raw));
      latest = response.latestLedger;
      if (!response.cursor || response.cursor === request.cursor) break;
      if (response.events.length < 100 && cursorLedger(response.cursor) >= response.latestLedger) break;
      request = { cursor: response.cursor, filters, limit: 100 };
    }
    return { events, nextLedger: latest };
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  async account(address) {
    try {
      return await this.net(() => this.server.getAccount(address));
    } catch (error) {
      if (/not found|404/i.test(String(error?.message))) throw new TransactionError("AccountMissing", "account not found");
      throw error;
    }
  }

  /** Asks the testnet faucet for XLM. A 400 for an existing account is fine. */
  async friendbot(address) {
    const response = await this.net(async () => {
      const r = await fetch(`${FRIENDBOT}?addr=${encodeURIComponent(address)}`);
      if (r.status >= 500) throw new Error(`friendbot ${r.status}`);
      return r;
    });
    if (response.ok) return;
    const body = await response.text();
    if (response.status === 400 && /already funded|createAccountAlreadyExist|op_already_exists/i.test(body)) return;
    throw new Error(t("Friendbot refused ({status}).", { status: response.status }));
  }

  async signWith(signer, tx, onStatus) {
    onStatus({ stage: "signing", text: t("Waiting for your signature in the wallet.") });
    let signedXdr;
    try {
      signedXdr = await signer.sign(tx.toXDR(), this.passphrase);
    } catch (error) {
      throw error instanceof WalletError ? error : new WalletError(error?.message || t("The wallet did not sign."));
    }
    return TransactionBuilder.fromXDR(signedXdr, this.passphrase);
  }

  /**
   * Calls a contract function from `signer`. Returns `{ value, hash, seconds, fee }`.
   * `onStatus({ stage, text, hash })` follows each step for the interface.
   */
  async invoke(signer, fn, args, onStatus = () => {}) {
    onStatus({ stage: "preparing", text: t("Checking the transaction with the network.") });
    const source = await this.account(signer.address);
    const tx = new TransactionBuilder(source, { fee: INCLUSION_FEE, networkPassphrase: this.passphrase })
      .addOperation(Operation.invokeContractFunction({ contract: this.contracts.openWindow, function: fn, args }))
      .setTimeout(TX_VALIDITY_SECS)
      .build();
    const sim = await this.net(() => this.server.simulateTransaction(tx));
    if (rpc.Api.isSimulationError(sim)) throw this.simulationError(sim.error);
    // The simulation sets the resource fee the wallet is asked to sign: the assembled transaction is
    // checked, since its fee comes from the simulation's transaction data, not from its summary.
    const ready = rpc.assembleTransaction(tx, sim).build();
    checkFee(ready, { estimate: estimateOf(sim) });
    const signed = await this.signWith(signer, ready, onStatus);
    const { result, hash, seconds, fee } = await this.submit(signed, onStatus);
    return { value: result.returnValue ? scValToNative(result.returnValue) : undefined, hash, seconds, fee };
  }

  /** Submits one classic operation (a trustline) from `signer`. */
  async classic(signer, operation, onStatus = () => {}) {
    onStatus({ stage: "preparing", text: t("Preparing the transaction.") });
    const source = await this.account(signer.address);
    const tx = new TransactionBuilder(source, { fee: "1000", networkPassphrase: this.passphrase })
      .addOperation(operation)
      .setTimeout(TX_VALIDITY_SECS)
      .build();
    const signed = await this.signWith(signer, tx, onStatus);
    return this.submit(signed, onStatus);
  }

  /** `getTransaction` on the endpoint in use: its answer with `via`, the index of the endpoint that gave it, or null when none answered. */
  async lookup(hash) {
    let via = this.active;
    try {
      const answer = await this.net(
        () => {
          via = this.active;
          return this.server.getTransaction(hash);
        },
        { attempts: 2 },
      );
      return answer ? { ...answer, via } : null;
    } catch {
      return null; // RPC unreachable: unknown, not failed
    }
  }

  /**
   * Asks the endpoints other than `via` whether `hash` succeeded, so that one
   * endpoint's word never shows a write as confirmed: an RPC can report
   * SUCCESS for a transaction it never forwarded. Returns another endpoint's
   * SUCCESS answer, or null when there is no other endpoint. Throws
   * TxUnconfirmed when another endpoint reports a failure, does not know the
   * transaction once its ledgers are past the validity window, or stays
   * silent until shortly after it.
   */
  async confirmElsewhere(hash, via, maxTime, onStatus = () => {}) {
    const others = this.endpoints.filter((_, i) => i !== via);
    if (!others.length) return null;
    const hosts = others.map((e) => e.host).join(", ");
    onStatus({ stage: "confirming", text: t("Submitted, confirming: waiting for a second RPC endpoint ({host}) to see it.", { host: hosts }), hash });
    const deadline = (maxTime || Math.floor(Date.now() / 1000) + TX_VALIDITY_SECS) + CONFIRM_GRACE_SECS;
    for (;;) {
      const answers = await Promise.all(
        others.map((endpoint) =>
          withTimeout(endpoint.server.getTransaction(hash), RPC_TIMEOUT_MS).then(
            (answer) => ({ endpoint, answer }),
            () => ({ endpoint, answer: null }),
          ),
        ),
      );
      const success = answers.find(({ answer }) => answer?.status === "SUCCESS");
      if (success) return success.answer;
      const failure = answers.find(({ answer }) => answer?.status === "FAILED");
      if (failure) throw new TransactionError("TxUnconfirmed", t("{host} reports it failed.", { host: failure.endpoint.host }), hash);
      // Past the window, an endpoint that has closed later ledgers would know a transaction that landed.
      const unknown = answers.find(({ answer }) => answer?.status === "NOT_FOUND" && maxTime && Number(answer.latestLedgerCloseTime) > maxTime + 5);
      if (unknown) throw new TransactionError("TxUnconfirmed", t("{host} does not know it, and its validity window has passed.", { host: unknown.endpoint.host }), hash);
      if (Date.now() / 1000 > deadline) throw new TransactionError("TxUnconfirmed", t("{host} did not confirm it in time.", { host: hosts }), hash);
      await sleep(this.pollMs);
    }
  }

  /**
   * Sends a signed transaction and returns once it has landed. Throws only
   * on a definitive outcome: failed on chain, refused by the network, or
   * expired (the ledger closed past the validity window without it); or
   * TxUnconfirmed when a second endpoint does not confirm the success the
   * first one reports (`confirmElsewhere`).
   */
  async submit(tx, onStatus = () => {}) {
    const started = Date.now();
    const hash = toHex(tx.hash());
    const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
    const done = async (answer) => {
      const confirmed = (await this.confirmElsewhere(hash, answer.via, maxTime, onStatus)) ?? answer;
      const seconds = (Date.now() - started) / 1000;
      onStatus({ stage: "confirmed", text: t("Confirmed in {seconds} s.", { seconds: formatUnits(BigInt(Math.round(seconds * 10)), 1) }), hash });
      return { result: confirmed, hash, seconds, fee: feeCharged(confirmed) };
    };
    const failed = (result) => new TransactionError("TxFailed", t("Result: {code}.", { code: resultCode(result.resultXdr) }), hash);
    const until = maxTime ? new Date(maxTime * 1000).toLocaleTimeString(locale()) : null;

    // 1. Into the queue, or learn that it already applied.
    let delay = 1000;
    for (;;) {
      onStatus({ stage: "submitting", text: t("Sending to the network."), hash });
      let sent = null;
      const via = this.active;
      try {
        sent = await withTimeout(this.server.sendTransaction(tx), SEND_TIMEOUT_MS);
      } catch (error) {
        // Lost or late response: the transaction may be queued. The lookup settles it, and the next
        // send goes to the other endpoint; the same signed transaction cannot apply twice.
        this.failover(error, via);
      }
      if (sent?.status === "PENDING" || sent?.status === "DUPLICATE") break;
      const known = await this.lookup(hash);
      if (known?.status === "SUCCESS") return done(known);
      if (known?.status === "FAILED") throw failed(known);
      if (sent?.status === "ERROR") {
        throw new TransactionError("TxRefused", t("Code: {code}.", { code: resultCode(sent.errorResult) }), hash);
      }
      if (maxTime && Date.now() / 1000 > maxTime + 10) break; // past the window: step 2 settles it
      onStatus({ stage: "retrying", text: t("No receipt from the network yet. Sending again. It can still land until {until}.", { until }), hash });
      await sleep(delay);
      delay = Math.min(delay * 2, 8000);
    }

    // 2. Wait for the outcome until the ledger closes past the validity window.
    onStatus({ stage: "pending", text: t("Submitted. Waiting for the next ledger."), hash });
    for (let polls = 0; ; polls += 1) {
      const result = await this.lookup(hash);
      if (result?.status === "SUCCESS") return done(result);
      if (result?.status === "FAILED") throw failed(result);
      let closed = 0;
      try {
        closed = await this.ledgerTime();
      } catch {
        // RPC unreachable: keep polling, never conclude.
      }
      if (maxTime && closed > maxTime + 5) {
        const last = await this.lookup(hash);
        if (last?.status === "SUCCESS") return done(last);
        if (last?.status === "FAILED") throw failed(last);
        if (last) throw new TransactionError("TxExpired", "Expired before landing.", hash);
      }
      if (polls === 10) {
        onStatus({ stage: "pending", text: t("Still waiting. It can land until {until}; it is not failed before then.", { until }), hash });
      }
      await sleep(this.pollMs);
    }
  }

  // -------------------------------------------------------------------------
  // The five actions of the interface
  // -------------------------------------------------------------------------

  addTrustline(signer, onStatus) {
    const { code, issuer } = this.deployment.stablecoin;
    return this.classic(signer, Operation.changeTrust({ asset: new Asset(code, issuer) }), onStatus);
  }

  /** Returns the new repo id with the transaction facts. */
  async openRepo(signer, { offerId, shares, principal, term }, onStatus) {
    const result = await this.invoke(
      signer,
      "open_repo",
      [sv.address(signer.address), sv.u64(offerId), sv.address(this.fund), sv.i128(shares), sv.i128(principal), sv.u64(term)],
      onStatus,
    );
    return { ...result, repoId: Number(result.value) };
  }

  /** Repays an open repo. `deferred` says whether its shares wait in the contract (`deferredAfter`). */
  async repurchase(signer, repoId, onStatus) {
    const result = await this.invoke(signer, "repurchase", [sv.u64(repoId)], onStatus);
    return { ...result, deferred: await this.deferredAfter(repoId) };
  }

  /**
   * After a write that closed repo `repoId`: true when its shares wait in the
   * contract for a later delivery, false when none do, null when the read
   * failed. The write succeeds either way: a token refusal, or a lender whose
   * approval was revoked, only defers the delivery.
   */
  async deferredAfter(repoId) {
    try {
      return (await this.pendingRelease(repoId)) !== null;
    } catch {
      return null;
    }
  }

  async createOffer(signer, { amount, rateBps, maxTerm, funds = [this.fund] }, onStatus) {
    const result = await this.invoke(
      signer,
      "create_offer",
      [
        sv.address(signer.address),
        sv.address(this.contracts.stablecoin),
        sv.i128(amount),
        sv.u32(rateBps),
        sv.u64(maxTerm),
        sv.vec(funds.map((f) => sv.address(f))),
      ],
      onStatus,
    );
    return { ...result, offerId: Number(result.value) };
  }

  withdrawOffer(signer, offerId, amount, onStatus) {
    return this.invoke(signer, "withdraw_offer", [sv.u64(offerId), sv.i128(amount)], onStatus);
  }

  /**
   * Lender takes the shares of an unpaid repo from its maturity on. `to` is
   * by default the lender; another address must be a lender the fund's
   * steward approved. Since rc5 the lender of record may seize even after
   * its approval was revoked: the repo settles and the shares wait in the
   * contract until it is approved again (`deferred`, see `deferredAfter`).
   */
  async seize(signer, repoId, onStatus, to = signer.address) {
    const result = await this.invoke(signer, "seize", [sv.u64(repoId), sv.address(to)], onStatus);
    return { ...result, deferred: await this.deferredAfter(repoId) };
  }

  /**
   * Shares owed on a closed repo and not delivered: the share token refused
   * to move them (an issuer freeze or allowlist removal), or, for a seizure,
   * the lender is not approved for the fund. `{ fund, to, shares }` or null.
   */
  async pendingRelease(repoId) {
    return checkPendingRelease(await this.read(this.contracts.openWindow, "pending_release", [sv.u64(repoId)]));
  }

  /** Retries the delivery of held-back shares; anyone may call it. Resolves `value` true when delivered, false when it still waits. */
  release(signer, repoId, onStatus) {
    return this.invoke(signer, "release", [sv.u64(repoId)], onStatus);
  }

  /**
   * Simulates `fn` without a wallet and returns the contract error it would
   * hit, or null. Simulation records authorizations without checking them,
   * so this probes the contract's other rules only, never who may call.
   */
  async probe(fn, args) {
    const { error } = await this.settle(this.contracts.openWindow, fn, args);
    return error ?? null;
  }
}
