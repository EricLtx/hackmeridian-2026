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
import { TransactionError, WalletError, contractKinds, decodeSimulationError } from "./errors.js";

/** The SDK's impossible account, used as the source of read-only simulations. */
export const NULL_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const FRIENDBOT = "https://friendbot.stellar.org";

/** Seconds a write stays valid. Long enough for a person to read the wallet prompt. */
export const TX_VALIDITY_SECS = 180;
/** Highest inclusion fee bid, in stroops; the network charges less when idle. */
const INCLUSION_FEE = "100000";
const SCAN_BATCH = 8;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
  return /fetch|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|\b(429|50[0-4])\b/i.test(text);
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

const normalizeRepo = (id, repo) => ({ id, ...repo, status: Array.isArray(repo.status) ? repo.status[0] : repo.status });

export class Chain {
  /** `deployment` is the parsed deployment.testnet.json. */
  constructor(deployment) {
    this.deployment = deployment;
    this.passphrase = deployment.networkPassphrase;
    this.contracts = deployment.contracts;
    this.fund = deployment.contracts.fundShares;
    this.server = new rpc.Server(deployment.rpcUrl);
    this.kinds = contractKinds(deployment.contracts);
    this.nativeContract = Asset.native().contractId(this.passphrase);
  }

  explorerTx(hash) {
    return `${this.deployment.explorer}/tx/${hash}`;
  }

  explorerAccount(address) {
    return `${this.deployment.explorer}/${address.startsWith("C") ? "contract" : "account"}/${address}`;
  }

  /** Runs `call`, retrying transient network failures up to three times. */
  async net(call) {
    let delay = 800;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await call();
      } catch (error) {
        if (attempt >= 4 || !isTransient(error)) throw error;
        await sleep(delay);
        delay *= 2;
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
    if (rpc.Api.isSimulationError(sim)) throw decodeSimulationError(sim.error, this.kinds);
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
    if (!Number.isFinite(closed) || closed <= 0) throw new Error("RPC returned no ledger close time");
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

  quote(shares) {
    return this.read(this.contracts.openWindow, "quote", [sv.address(this.fund), sv.i128(shares), sv.address(this.contracts.stablecoin)]);
  }

  async offers() {
    return (await this.scan("get_offer")).map(({ id, value }) => ({ id, ...value }));
  }

  /** Repos from `from` on, until the first id with no repo. */
  async repos(from = 1) {
    return (await this.scan("get_repo", from)).map(({ id, value }) => normalizeRepo(id, value));
  }

  async repo(id) {
    const value = await this.read(this.contracts.openWindow, "get_repo", [sv.u64(id)]);
    return value ? normalizeRepo(id, value) : null;
  }

  /** Interest due on an open repo if repurchased now (principal not included). */
  async repoDue(id) {
    return BigInt(await this.read(this.contracts.openWindow, "repo_due", [sv.u64(id)]));
  }

  isLenderApproved(address) {
    return this.read(this.contracts.openWindow, "is_lender_approved", [sv.address(this.fund), sv.address(address)]);
  }

  /**
   * Everything the board shows, read in parallel. Each field is `{ value }`
   * or `{ error }`, so one stale feed does not blank the whole board.
   */
  async board(shares) {
    const ow = this.contracts.openWindow;
    const fund = sv.address(this.fund);
    const [config, state, paused, maxTerm, nav, quote, offers, cap, outstanding, now] = await Promise.all([
      this.settle(ow, "get_fund", [fund]),
      this.settle(ow, "get_fund_state", [fund]),
      this.settle(ow, "is_paused"),
      this.settle(ow, "max_term"),
      this.settle(ow, "fund_price", [fund]),
      shares > 0n ? this.quote(shares).then((value) => ({ value }), (error) => ({ error })) : { value: null },
      this.offers().then((value) => ({ value }), (error) => ({ error })),
      this.settle(ow, "currency_cap", [sv.symbol(this.deployment.stablecoin.currency)]),
      this.settle(ow, "currency_outstanding", [sv.symbol(this.deployment.stablecoin.currency)]),
      this.ledgerTime().then((value) => ({ value }), (error) => ({ error })),
    ]);
    let fx = { value: null };
    const source = config.value?.source;
    if (Array.isArray(source) && source[0] === "Cross") {
      fx = await this.settle(source[1].oracle, "lastprice", [assetScVal(source[1].asset)]);
    }
    return { config, state, paused, maxTerm, nav, fx, quote, offers, cap, outstanding, now };
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
      xlm: xlm.error ? null : BigInt(xlm.value),
      stablecoin: stable.error ? null : BigInt(stable.value),
      shares: shares.error ? 0n : BigInt(shares.value),
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
      const response = await this.net(() => this.server.getEvents(request));
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
    throw new Error(`Friendbot refused (${response.status}).`);
  }

  async signWith(signer, tx, onStatus) {
    onStatus({ stage: "signing", text: "Waiting for your signature in the wallet." });
    let signedXdr;
    try {
      signedXdr = await signer.sign(tx.toXDR(), this.passphrase);
    } catch (error) {
      throw error instanceof WalletError ? error : new WalletError(error?.message || "The wallet did not sign.");
    }
    return TransactionBuilder.fromXDR(signedXdr, this.passphrase);
  }

  /**
   * Calls a contract function from `signer`. Returns `{ value, hash, seconds, fee }`.
   * `onStatus({ stage, text, hash })` follows each step for the interface.
   */
  async invoke(signer, fn, args, onStatus = () => {}) {
    onStatus({ stage: "preparing", text: "Checking the transaction with the network." });
    const source = await this.account(signer.address);
    const tx = new TransactionBuilder(source, { fee: INCLUSION_FEE, networkPassphrase: this.passphrase })
      .addOperation(Operation.invokeContractFunction({ contract: this.contracts.openWindow, function: fn, args }))
      .setTimeout(TX_VALIDITY_SECS)
      .build();
    const sim = await this.net(() => this.server.simulateTransaction(tx));
    if (rpc.Api.isSimulationError(sim)) throw decodeSimulationError(sim.error, this.kinds);
    const ready = rpc.assembleTransaction(tx, sim).build();
    const signed = await this.signWith(signer, ready, onStatus);
    const { result, hash, seconds, fee } = await this.submit(signed, onStatus);
    return { value: result.returnValue ? scValToNative(result.returnValue) : undefined, hash, seconds, fee };
  }

  /** Submits one classic operation (a trustline) from `signer`. */
  async classic(signer, operation, onStatus = () => {}) {
    onStatus({ stage: "preparing", text: "Preparing the transaction." });
    const source = await this.account(signer.address);
    const tx = new TransactionBuilder(source, { fee: "1000", networkPassphrase: this.passphrase })
      .addOperation(operation)
      .setTimeout(TX_VALIDITY_SECS)
      .build();
    const signed = await this.signWith(signer, tx, onStatus);
    return this.submit(signed, onStatus);
  }

  async lookup(hash) {
    try {
      return await this.server.getTransaction(hash);
    } catch {
      return null; // RPC unreachable: unknown, not failed
    }
  }

  /**
   * Sends a signed transaction and returns once it has landed. Throws only
   * on a definitive outcome: failed on chain, refused by the network, or
   * expired (the ledger closed past the validity window without it).
   */
  async submit(tx, onStatus = () => {}) {
    const started = Date.now();
    const hash = toHex(tx.hash());
    const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
    const done = (result) => {
      const seconds = (Date.now() - started) / 1000;
      onStatus({ stage: "confirmed", text: `Confirmed in ${seconds.toFixed(1)} s.`, hash });
      return { result, hash, seconds, fee: feeCharged(result) };
    };
    const failed = (result) => new TransactionError("TxFailed", `Result: ${resultCode(result.resultXdr)}.`, hash);
    const until = maxTime ? new Date(maxTime * 1000).toLocaleTimeString("en-GB") : null;

    // 1. Into the queue, or learn that it already applied.
    let delay = 1000;
    for (;;) {
      onStatus({ stage: "submitting", text: "Sending to the network.", hash });
      let sent = null;
      try {
        sent = await this.server.sendTransaction(tx);
      } catch {
        // Lost response: the transaction may be queued. The lookup settles it.
      }
      if (sent?.status === "PENDING" || sent?.status === "DUPLICATE") break;
      const known = await this.lookup(hash);
      if (known?.status === "SUCCESS") return done(known);
      if (known?.status === "FAILED") throw failed(known);
      if (sent?.status === "ERROR") {
        throw new TransactionError("TxRefused", `Code: ${resultCode(sent.errorResult)}.`, hash);
      }
      if (maxTime && Date.now() / 1000 > maxTime + 10) break; // past the window: step 2 settles it
      onStatus({ stage: "retrying", text: `No receipt from the network yet. Sending again. It can still land until ${until}.`, hash });
      await sleep(delay);
      delay = Math.min(delay * 2, 8000);
    }

    // 2. Wait for the outcome until the ledger closes past the validity window.
    onStatus({ stage: "pending", text: "Submitted. Waiting for the next ledger.", hash });
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
        onStatus({ stage: "pending", text: `Still waiting. It can land until ${until}; it is not failed before then.`, hash });
      }
      await sleep(1000);
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

  repurchase(signer, repoId, onStatus) {
    return this.invoke(signer, "repurchase", [sv.u64(repoId)], onStatus);
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
}
