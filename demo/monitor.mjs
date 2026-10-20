// Monitoring for Open Window on testnet: the detectors of the monitoring plan
// in docs/threat-model-stride.md, section 3.1.
//
//   npm run monitor                  one pass, prints alerts
//   npm run monitor -- --watch       a pass every 30 s
//   npm run monitor -- --watch --act takes the safe actions itself:
//                                    pause on a critical alert, extend TTLs,
//                                    refresh an old price reference
//   npm run monitor -- --rehearse    fires each detector with a real trigger
//                                    on testnet, takes the action, restores
//   npm run monitor -- --witness     a second watch from another machine:
//                                    alerts, never acts; own files, own heartbeat
//
// A planned change is announced first, so that --act reports it instead of
// cancelling or vetoing it:
//   npm run monitor -- --announce=<wasm hash>          an upgrade proposal
//   npm run monitor -- --announce-stablecoin=<C...>    a stablecoin registration
//   npm run monitor -- --announce-admin=<G...>         a governor handover to that address
//   npm run monitor -- --announce-guardian=<G...>      a forced guardian change to that address
//
// A fund's FX leg is compared with a second FX source, by default the
// demo's other feed (Reflector or the local feed); `--fx-fallback=<C...>`
// names another one, quoting the same asset.
//
// A detector never moves funds. The only actions are the sentinel's (or the
// guardian's) pause, which blocks new entries and never exits, and the
// cancellation of an unannounced proposal; the guardian's and the
// trustee's vetoes, only when their key is on this host; and the keeper's
// TTL extensions, steps of a fund's price reference along its model
// (`refresh_reference`) and deliveries of owed shares (`release`), which
// anyone may call. With two endpoints in STELLAR_RPC_URLS, every action is
// taken only once the second endpoint reads the same facts; otherwise it is
// a critical alert for a human. Unpausing stays a human decision for the
// governor.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Keypair, StrKey, xdr } from "@stellar/stellar-sdk";
import {
  ONE,
  ROOT,
  RPC_URLS,
  STATE_DIR,
  WASM_DIR,
  activeRpcUrl,
  codeKey,
  asset,
  contractEvents,
  deploy,
  endpointClient,
  saveState,
  REFLECTOR_FX_TESTNET as REFLECTOR_FX,
  explorer,
  extendCode,
  extendTtl,
  CODE_SLICE_MAX_FEE,
  invoke,
  keypair,
  publicKeyOf,
  latestLedgers,
  ledgerEntries,
  ledgerTime,
  loadState,
  probe,
  read,
  secondEndpoint,
  sleep,
  storageKey,
  sv,
} from "./lib.mjs";
import { FUND_SETTINGS, navAt } from "./config.mjs";
import { plain } from "../indexer/lib/plain.mjs";
import { LEDGER_SECS, LIMITS, compareFacts, confirmation, decideActions, detect, hex, labelOf, lenderPairs, proposalFacts, recordAnnouncement, statusOf } from "./detectors.mjs";
import { loadMonitor as loadMonitorFile, refreshMonitor as refreshMonitorFile, saveMonitor as saveMonitorFile } from "./monitor-state.mjs";

const args = process.argv.slice(2);
/** Witness: a watch that alerts and never acts, for a second instance elsewhere (two witnesses, one actor). */
const WITNESS = args.includes("--witness");
const WATCH = args.includes("--watch") || WITNESS;
const ACT = args.includes("--act");
const REHEARSE = args.includes("--rehearse");
if (WITNESS && (ACT || REHEARSE)) {
  console.error(`--witness never submits a transaction: drop ${ACT ? "--act" : "--rehearse"}, or run without --witness on the acting instance.`);
  process.exit(1);
}
if (WITNESS) {
  // Every line of a witness is tagged, so two instances feeding one log stay apart.
  for (const method of ["log", "error"]) {
    const write = console[method].bind(console);
    console[method] = (...parts) => write(parts.join(" ").replace(/^(\n?)/, "$1[witness] "));
  }
}
/** Rehearsal steps to run, e.g. --steps=4,5,6,7; all by default. */
const STEPS = args.find((a) => a.startsWith("--steps="))?.slice(8).split(",").map(Number);
/** The FX feed a fund's FX leg is compared with, when not the demo's other feed (`--fx-fallback=<C...>`). */
const FX_FALLBACK = args.find((a) => a.startsWith("--fx-fallback="))?.slice(14);
const runStep = (n) => !STEPS || STEPS.includes(n);

// The thresholds of the monitoring plan live in detectors.mjs; a constant-NAV
// fund publishes the same value by design (`--nav-frozen-hours=Infinity`).
const navFrozenFlag = args.find((a) => a.startsWith("--nav-frozen-hours="))?.slice(19);
if (navFrozenFlag !== undefined) LIMITS.navFrozenHours = Number(navFrozenFlag);
/** Heartbeat: an HTTP GET after every successful pass, when `HEARTBEAT_URL` is set (Healthchecks.io, Uptime Kuma push, ...); a witness has its own. */
const HEARTBEAT_URL = WITNESS ? process.env.HEARTBEAT_WITNESS_URL : process.env.HEARTBEAT_URL;
async function heartbeat() {
  if (!HEARTBEAT_URL) return;
  try {
    await fetch(HEARTBEAT_URL, { method: "GET", signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    console.error(`  (heartbeat not delivered: ${error.message})`);
  }
}
// A witness keeps its own state and alert files: it never shares the acting instance's.
const MONITOR_FILE = path.join(STATE_DIR, WITNESS ? "monitor-witness.json" : "monitor.json");
const ALERT_FILE = path.join(STATE_DIR, WITNESS ? "alerts-witness.jsonl" : "alerts.jsonl");
/** The indexer's journal (indexer/README.md): the second source for the event trail, when a copy is kept on this machine. `INDEXER_STATE_DIR` points at a copy kept elsewhere (the indexer's `--state <dir>`). */
const JOURNAL_DIR = process.env.INDEXER_STATE_DIR ?? path.join(ROOT, "indexer", ".state");

const state = loadState();
const C = state.contracts;
if (!C?.openWindow) {
  console.error("No deployment found: run `npm run setup` first.");
  process.exit(1);
}

/**
 * Monitoring state of the deployed contract; a new deployment starts afresh.
 * Other processes write to the same file (`npm run upgrade`, the
 * `--announce-...=` flags): every pass and every decision merges what they
 * wrote first, and every save writes that merge (monitor-state.mjs, TOOL-3).
 * Fields starting with "_" are this process's memory, never saved.
 */
const loadMonitor = () => loadMonitorFile(MONITOR_FILE, C.openWindow);
const saveMonitor = (m) => saveMonitorFile(MONITOR_FILE, m);
const refreshMonitor = (m) => refreshMonitorFile(MONITOR_FILE, m);

// ---------------------------------------------------------------------------
// The indexer's journal, read incrementally (Repud.2 cross-check)
// ---------------------------------------------------------------------------
//
// `indexer/.state/events-YYYY-MM.jsonl` holds one JSON line per event with
// `id` (the RPC event id), `ledger`, `txHash`, `topics` and `data`. Only the
// files of the current and the previous month are read, from the byte where
// the last pass stopped; each pass hands its new lines to the journal
// detector, which compares them with the events an endpoint independent of
// the indexer's serves (rpc-6). `cursor.json` names the indexer's endpoint.

const JOURNAL = { lastLedger: null, offsets: new Map(), trailCursor: null };

/** Reads the new lines of the journal: `{ lastLedger, lines, endpoint }`, or null when there is no journal. */
function readJournal(contractId) {
  if (!fs.existsSync(JOURNAL_DIR)) return null;
  const lines = [];
  let endpoint = null;
  try {
    endpoint = JSON.parse(fs.readFileSync(path.join(JOURNAL_DIR, "cursor.json"), "utf8")).rpc ?? null;
  } catch {
    // no cursor yet: the indexer's endpoint is unknown
  }
  const now = new Date();
  const months = [0, 1].map((back) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  });
  for (const month of months.reverse()) {
    const file = path.join(JOURNAL_DIR, `events-${month}.jsonl`);
    if (!fs.existsSync(file)) continue;
    const start = JOURNAL.offsets.get(file) ?? 0;
    const size = fs.statSync(file).size;
    if (size <= start) continue;
    const fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(size - start);
    try {
      fs.readSync(fd, buffer, 0, buffer.length, start);
    } finally {
      fs.closeSync(fd);
    }
    // Only whole lines count: a line still being appended waits for the next pass.
    const end = buffer.lastIndexOf("\n");
    if (end < 0) continue;
    for (const row of buffer.toString("utf8", 0, end).split("\n")) {
      if (row.trim() === "") continue;
      let line;
      try {
        line = JSON.parse(row);
      } catch {
        continue; // `npm run verify` in indexer/ reports a malformed line; this is not its job
      }
      if (line.contract !== contractId) continue;
      lines.push(line);
      if (JOURNAL.lastLedger === null || line.ledger > JOURNAL.lastLedger) JOURNAL.lastLedger = line.ledger;
    }
    JOURNAL.offsets.set(file, start + end + 1);
  }
  return { lastLedger: JOURNAL.lastLedger, lines, endpoint };
}

/**
 * The contract's events in the journal's form, read from an endpoint other
 * than the one the indexer read (its `cursor.json`), from where the last
 * pass stopped; the first pass starts at the oldest ledger that endpoint
 * keeps. When every configured endpoint is the indexer's, the check runs
 * against it and says it is not independent.
 */
async function readTrail(journal) {
  if (!journal) return null;
  const other = RPC_URLS.findIndex((url) => url !== journal.endpoint);
  const index = other >= 0 ? other : Math.max(0, RPC_URLS.indexOf(activeRpcUrl()));
  const client = endpointClient(index);
  const independent = journal.endpoint ? client.url !== journal.endpoint : null;
  try {
    // The first read starts at the oldest ledger the endpoint keeps, as the indexer's first run does.
    JOURNAL.trailCursor ??= Number((await client.health()).oldestLedger) || 1;
    const events = await client.events(C.openWindow, JOURNAL.trailCursor);
    if (events.reachedLedger !== null && events.reachedLedger !== undefined) JOURNAL.trailCursor = events.reachedLedger + 1;
    return {
      url: client.url,
      independent,
      from: events.startLedger,
      reached: events.reachedLedger,
      events: events.map((e) => ({ id: e.id, ledger: e.ledger, txHash: e.txHash, topics: plain([e.name, ...e.topics]), data: plain(e.data) })),
    };
  } catch (error) {
    return { url: client.url, independent, error: firstLine(error) };
  }
}

// ---------------------------------------------------------------------------
// One pass: read everything once, then run the detectors on that snapshot
// ---------------------------------------------------------------------------

async function scan(getter) {
  const items = [];
  for (let id = 1; id < 10_000; id += 1) {
    const item = await read(state, C.openWindow, getter, [sv.u64(id)]);
    if (!item) break;
    items.push({ id, ...item });
  }
  return items;
}

/** Rent is paid by the keeper, an account with no role in the contract; older states fall back to the operator. */
const keeperRole = () => (state.keys.keeper ? "keeper" : "operator");
/** The admitted funds this deployment knows: the first one, and the second once `setup -- --second-fund` ran. Each detector runs per fund. */
function fundsOf() {
  const list = [{ label: "fund 1", shares: C.shares, navOracle: C.navOracle, stablecoin: C.euro }];
  if (C.shares2) list.push({ label: "fund 2", shares: C.shares2, navOracle: C.navOracle2, stablecoin: C.euro2 ?? C.euro });
  if (C.shares3) list.push({ label: "fund 3", shares: C.shares3, navOracle: C.navOracle3, stablecoin: C.euro });
  return list;
}
/** The first line of an error's message, for an alert. */
const firstLine = (error) => String(error?.message ?? error).split("\n")[0].slice(0, 160);

/**
 * One fund's reads, each caught on its own (oracle-3): a reverting feed or a
 * failing read becomes `errors.<read>` for this fund, and the other reads,
 * funds and detectors go on. A fund whose `get_fund` is None was removed:
 * `remove_fund` deletes its settings only, so its state, its shares held and
 * its positions are still read.
 */
async function readFund(f) {
  const fund = sv.address(f.shares);
  const errors = {};
  const attempt = async (what, call) => {
    try {
      return await call();
    } catch (error) {
      errors[what] = firstLine(error);
      return undefined;
    }
  };
  const config = await attempt("get_fund", () => read(state, C.openWindow, "get_fund", [fund]));
  const [fundState, held] = await Promise.all([
    attempt("get_fund_state", () => read(state, C.openWindow, "get_fund_state", [fund])),
    attempt("balance", () => read(state, f.shares, "balance", [sv.address(C.openWindow)])),
  ]);
  const base = { ...f, config, fundState, held, errors, currency: fundState ? String(fundState.currency) : null };
  if (config === null) return { ...base, removed: true };
  if (config === undefined) return base;
  const [nav, stewardBackup] = await Promise.all([
    attempt("lastprice", () => read(state, f.navOracle, "lastprice", [asset.stellar(f.shares)])),
    // Version 4: without a registered backup, a lost steward key can never be replaced.
    read(state, C.openWindow, "steward_backup", [fund]).catch(() => undefined),
  ]);
  // Simulated from the null account: reading needs no role key on this host.
  // Any failure of the simulation is the contract's answer, a feed's revert
  // included; only a failure to reach the RPC leaves the price unknown.
  let priceError = null;
  try {
    priceError = await probe(state, null, C.openWindow, "quote", [fund, sv.i128(ONE), sv.address(f.stablecoin)]);
  } catch (error) {
    if (error.simulation) priceError = { name: "HostError", contract: "host", detail: firstLine(error) };
    else errors.quote = firstLine(error);
  }
  // The FX leg, when the fund's price is crossed through an FX feed.
  const fxLeg = Array.isArray(config.source) && config.source[0] === "Cross" ? config.source[1] : null;
  const fxAsset = fxLeg ? (fxLeg.asset[0] === "Other" ? asset.other(String(fxLeg.asset[1])) : asset.stellar(String(fxLeg.asset[1]))) : null;
  const fx = fxLeg ? await attempt("FX lastprice", () => read(state, fxLeg.oracle, "lastprice", [fxAsset])) : null;
  // A second FX source the leg is compared with (detector feed-flat).
  const fallbackOracle = fxLeg ? fxFallbackOf(fxLeg) : null;
  const fxFallback = fallbackOracle ? await readFxFallback(fallbackOracle, fxAsset) : null;
  return { ...base, nav, stewardBackup, priceError, fxLeg, fx: fx ?? null, fxDecimals: fundState ? Number(fundState.fx_decimals) : undefined, fxFallback };
}

/**
 * The FX source a fund's FX leg is compared with: the one `--fx-fallback=`
 * names, else the demo's other feed (the local feed, which `setup --
 * --fx=local` fills, for Reflector; Reflector for the local feed).
 */
function fxFallbackOf(leg) {
  const primary = String(leg.oracle);
  const other = FX_FALLBACK ?? (primary === REFLECTOR_FX ? C.navOracle : REFLECTOR_FX);
  return other && other !== primary ? other : null;
}

/** That source's reading and decimals, or null when it has none (an empty local feed) or cannot be read. */
async function readFxFallback(oracle, fxAsset) {
  try {
    const [reading, decimals] = await Promise.all([read(state, oracle, "lastprice", [fxAsset]), read(state, oracle, "decimals")]);
    return reading ? { label: oracle === REFLECTOR_FX ? "Reflector" : `feed ${oracle.slice(0, 6)}…`, reading, decimals: Number(decimals) } : null;
  } catch {
    return null;
  }
}

/**
 * A deferred delivery and why it waits. The simulated `release` (anyone may
 * call it) says whether it would deliver now; for a seized position the
 * lender's approval says whether it waits for that approval (rc5, F1)
 * rather than for the token.
 */
async function describeRelease(repo, pending) {
  const position = { id: repo.id, ...pending, status: statusOf(repo) };
  position.deliverable = await read(state, C.openWindow, "release", [sv.u64(repo.id)]).catch(() => undefined);
  if (position.status === "Defaulted") {
    position.approved = await read(state, C.openWindow, "is_lender_approved", [sv.address(String(pending.fund)), sv.address(String(pending.to))]).catch(() => undefined);
  }
  return position;
}

/** The stablecoins this deployment knows and the offers hold, with the contract's balance in each (invariant I1). */
async function readStablecoins(offers) {
  const names = { [C.euro]: "tEUR", [C.euro2]: "tEURB" };
  const tokens = [...new Set([C.euro, C.euro2, ...offers.map((o) => String(o.stablecoin))].filter(Boolean))];
  return Promise.all(
    tokens.map(async (token) => {
      const owed = offers.filter((o) => String(o.stablecoin) === token).reduce((sum, o) => sum + BigInt(o.available), 0n);
      const coin = { token, label: names[token] ?? `${token.slice(0, 6)}…`, owed };
      try {
        coin.held = BigInt(await read(state, token, "balance", [sv.address(C.openWindow)]));
      } catch (error) {
        coin.error = firstLine(error);
      }
      // DoS.8: an issuer that deauthorizes the contract's balance blocks every
      // repurchase in that stablecoin while seizures go ahead. A Stellar
      // Asset Contract answers `authorized`; another token may not.
      try {
        coin.authorized = await read(state, token, "authorized", [sv.address(C.openWindow)]);
      } catch (error) {
        coin.authError = firstLine(error);
      }
      return coin;
    }),
  );
}

async function snapshot(monitor) {
  const now = await ledgerTime();
  const [pausedRead, repos, offers] = await Promise.all([
    read(state, C.openWindow, "is_paused"),
    scan("get_repo"),
    scan("get_offer"),
  ]);
  let paused = pausedRead;
  // One block per admitted fund: settings, state, NAV, shares held, quote probe, steward backup, FX leg.
  const funds = await Promise.all(fundsOf().map(readFund));
  // Caps are per currency: two stablecoins of one currency share one cap.
  const caps = Object.fromEntries(
    await Promise.all(
      [...new Set(funds.map((f) => f.currency).filter(Boolean))].map(async (currency) => {
        try {
          const [outstanding, cap] = await Promise.all([
            read(state, C.openWindow, "currency_outstanding", [sv.symbol(currency)]),
            read(state, C.openWindow, "currency_cap", [sv.symbol(currency)]),
          ]);
          return [currency, { outstanding, cap }];
        } catch (error) {
          return [currency, { error: firstLine(error) }];
        }
      }),
    ),
  );
  // The first fund's fields stay at the top level: the drills and older readers use them.
  const [first] = funds;
  const { config, fundState, nav, held, stewardBackup, priceError, fxLeg, fx, currency } = first;
  const { outstanding, cap } = caps[currency] ?? {};
  // The keeper pays the rent: its float must cover two code slices. A host
  // without the keeper's key (a witness) reports it unreadable.
  const keeperPub = publicKeyOf(state, keeperRole());
  const keeperKey = keeperPub ? xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(keeperPub).xdrAccountId() })) : null;
  const keeperEntry = keeperKey ? await ledgerEntries([keeperKey]).catch(() => null) : null;
  const keeperXlm = keeperEntry?.entries[0]?.value?.account?.balance != null ? Number(keeperEntry.entries[0].value.account.balance) / 1e7 : null;

  const openRepos = repos.filter((r) => statusOf(r) === "Open");
  const releases = [];
  for (const r of repos.filter((x) => statusOf(x) !== "Open")) {
    const pending = await read(state, C.openWindow, "pending_release", [sv.u64(r.id)]);
    if (pending) releases.push(await describeRelease(r, pending));
  }
  const liveOffers = offers.filter((o) => BigInt(o.available) > 0n);
  const stablecoins = await readStablecoins(offers);
  // DoS.7: whether each lender is still approved on each fund it lends on or
  // has open repos in, as the contract answers it.
  const lenders = await Promise.all(
    lenderPairs(liveOffers, openRepos).map(async ([fund, lender]) => ({
      fund,
      lender,
      approved: await read(state, C.openWindow, "is_lender_approved", [sv.address(fund), sv.address(lender)]).catch(() => undefined),
      open: openRepos.filter((r) => String(r.fund) === fund && String(r.lender) === lender).length,
    })),
  );
  const keyed = [
    ["contract instance", storageKey(C.openWindow)],
    ...funds.flatMap((f) => [
      // remove_fund deletes the settings by design: a removed fund's state is still watched.
      ...(f.removed ? [] : [[`${f.label} config`, storageKey(C.openWindow, sv.variant("Fund", sv.address(f.shares)))]]),
      [`${f.label} state`, storageKey(C.openWindow, sv.variant("FundState", sv.address(f.shares)))],
    ]),
    ...openRepos.map((r) => [`repo #${r.id}`, storageKey(C.openWindow, sv.variant("Repo", sv.u64(r.id)))]),
    ...liveOffers.map((o) => [`offer #${o.id}`, storageKey(C.openWindow, sv.variant("Offer", sv.u64(o.id)))]),
    // A lender's approval is read by every exit that delivers shares to it
    // (seize, redirect): an archived approval would block a seizure, which
    // decision S6 forbids. Watch one entry per (fund, lender) an exit may read.
    // A revoked approval has no entry left: that is not an archival (below).
    ...lenders.map(({ fund, lender, approved }) => [
      `lender ${lender.slice(0, 6)} on ${labelOf(funds, fund)}`,
      storageKey(C.openWindow, sv.variant("Lender", sv.address(fund), sv.address(lender))),
      undefined,
      approved === false,
    ]),
  ];
  // The contract no longer extends its own code (rent grows with size): the operator does.
  const head = await ledgerEntries([storageKey(C.openWindow)]);
  const rawCode = head.entries[0]?.value?.contractData?.val?.instance?.executable?.wasmHash;
  if (rawCode) keyed.push(["contract code", codeKey(typeof rawCode.toXDR === "function" ? rawCode.toXDR() : rawCode), "code"]);
  const ledger = await ledgerEntries(keyed.map(([, k]) => k));
  const ttl = keyed.map(([label, key, kind, revoked], i) => ({
    label,
    key,
    kind,
    revoked: revoked || undefined,
    days: ledger.entries[i] ? ((ledger.entries[i].liveUntil - ledger.latest) * LEDGER_SECS) / 86_400 : null,
  }));
  const instance = ledger.entries[0]?.value?.contractData?.val?.instance;
  const rawHash = instance?.executable?.wasmHash;
  const wasmHash = rawHash ? (typeof rawHash.toXDR === "function" ? rawHash.toXDR("hex") : Buffer.from(rawHash).toString("hex")) : null;

  // The RPC serves events up to its latest ledger and for about a week back.
  // They are read from where the last pass stopped, with that retention as
  // the only floor: an outage shorter than a week loses nothing, and a
  // longer one is reported as a gap (detector `events`).
  const asked = Math.min(monitor.cursor ?? ledger.latest - 720, ledger.latest);
  const events = await contractEvents(C.openWindow, asked);
  const from = events.startLedger ?? asked;
  const eventGap = from > asked ? { from: asked, to: from - 1 } : null;
  // rc4: the layout version behind the code means an upgrade without its migration; the sentinel is the key that acts.
  const [schemaVersion, sentinel] = await Promise.all([
    read(state, C.openWindow, "schema_version").then(Number, () => null),
    read(state, C.openWindow, "sentinel").catch(() => null),
  ]);
  // The proposals the automatic actions answer, from state on every pass:
  // a dropped event or a failed action does not hide one (rpc-2).
  const primaryRead = (contractId, fn, args) => read(state, contractId, fn, args);
  let pending = await pendingProposals(primaryRead);
  // The same facts on a second endpoint: they must agree before anything is
  // done about them. A proposal landing between the two readings is not a
  // disagreement: the first endpoint is read once more before comparing.
  const second = await secondFacts(ledger.latest);
  if (second?.facts && compareFacts(proposalFacts({ paused, ...pending }), second.facts).length) {
    paused = await read(state, C.openWindow, "is_paused");
    pending = await pendingProposals(primaryRead);
  }
  // Stablecoin proposals are kept per token, with no list to read: the
  // tokens their events named, in this window or in an earlier one while
  // still pending, are read from state on every pass (TOOL-7). Null: no
  // longer pending; undefined: the read failed.
  const proposedCoins = [...new Set([
    ...(monitor.stablecoinProposals ?? []),
    ...events.filter((e) => e.name === "stablecoin_change_proposed").map((e) => String(e.topics?.[0] ?? "")),
  ].filter((token) => StrKey.isValidContract(token)))];
  const pendingStablecoins = Object.fromEntries(await Promise.all(proposedCoins.map(async (token) => [token, await read(state, C.openWindow, "pending_stablecoin_change", [sv.address(token)]).catch(() => undefined)])));
  monitor.stablecoinProposals = proposedCoins.filter((token) => pendingStablecoins[token] !== null);
  // Two sources for the chain head (every configured RPC) and for the event trail (the indexer's journal).
  const rpcHeights = RPC_URLS.length > 1 ? await latestLedgers() : null;
  const journal = readJournal(C.openWindow);
  const trail = await readTrail(journal);
  return { now, latest: ledger.latest, from, funds, caps, config, fundState, paused, nav, repos, openRepos, offers, releases, stablecoins, lenders, eventGap, eventsReached: events.reachedLedger, held, stewardBackup, outstanding, cap, currency, priceError, ttl, wasmHash, events, fxLeg, fx, keeperRole: keeperRole(), keeperXlm, rpcHeights, journal, schemaVersion, sentinel, pending, pendingStablecoins, second, primaryUrl: activeRpcUrl(), trail };
}

/**
 * The pending upgrade, governor handover and forced guardian change, read
 * through `reader`: null when none is pending, undefined when the read fails
 * (code older than rc4 has no such function).
 */
async function pendingProposals(reader) {
  const [upgrade, admin, forcedGuardian] = await Promise.all([
    reader(C.openWindow, "pending_upgrade", []).catch(() => undefined),
    reader(C.openWindow, "pending_admin", []).catch(() => undefined),
    reader(C.openWindow, "pending_forced_guardian_change", []).catch(() => undefined),
  ]);
  return {
    upgrade: upgrade ? { hash: hex(upgrade.wasm_hash), eta: Number(upgrade.eta) } : upgrade,
    admin: admin ? { admin: String(admin.admin), eta: Number(admin.eta) } : admin,
    forcedGuardian: forcedGuardian ? { guardian: String(forcedGuardian.guardian), eta: Number(forcedGuardian.eta) } : forcedGuardian,
  };
}

/** Waits, about 15 s at most, for an endpoint to reach `ledger`; a lagging endpoint then answers from an older ledger. */
async function caughtUp(client, ledger) {
  for (let tries = 0; tries < 15; tries += 1) {
    const { sequence } = await client.latestLedger();
    if (Number(sequence) >= ledger) return true;
    await sleep(1_000);
  }
  return false;
}

/** The pause flag and the pending proposals on a second endpoint, once it has reached `latest`; null with a single endpoint. */
async function secondFacts(latest) {
  const index = secondEndpoint();
  if (index === null) return null;
  const client = endpointClient(index);
  try {
    await caughtUp(client, latest);
    const [paused, proposals] = await Promise.all([client.read(C.openWindow, "is_paused"), pendingProposals(client.read)]);
    return { url: client.url, facts: proposalFacts({ paused, ...proposals }) };
  } catch (error) {
    return { url: client.url, error: firstLine(error) };
  }
}

async function pass(monitor, { quiet = false } = {}) {
  // What other processes wrote to the state file (an announcement, a code
  // baseline moved by `npm run upgrade`) counts from this pass on, and so
  // does what they wrote while the chain was being read (TOOL-3).
  refreshMonitor(monitor);
  const s = await snapshot(monitor);
  refreshMonitor(monitor);
  const alerts = detect(s, monitor, { limits: LIMITS });
  // The next pass reads events after the last ledger this one covered.
  monitor.cursor = (s.eventsReached ?? s.latest) + 1;
  if (s.wasmHash) monitor.wasmHash = monitor.wasmHash ?? s.wasmHash;
  if (!quiet) report(s, alerts);
  for (const a of alerts) {
    fs.appendFileSync(ALERT_FILE, `${JSON.stringify({ at: new Date().toISOString(), ledger: s.latest, ...a, key: undefined })}\n`);
  }
  return { s, alerts };
}

function report(s, alerts) {
  const stamp = new Date(s.now * 1000).toISOString().slice(0, 19).replace("T", " ");
  console.log(`\n[${stamp} UTC] ledger ${s.latest}: ${s.funds.length} fund(s), ${s.openRepos.length} open repos, ${s.events.length} events since ${s.from}, entries ${s.paused ? "paused" : "open"}`);
  if (!alerts.length) console.log("  no alert");
  for (const a of alerts) console.log(`  ${a.level.toUpperCase().padEnd(8)} ${a.threat.padEnd(9)} ${a.message}  (action: ${a.action})`);
}

/** The key that pauses and cancels: the sentinel when the instance names ours (rc4), else the guardian. Vetoes stay with the guardian and the trustee. */
function actorRole(s) {
  const ours = state.keys.sentinel ? keypair(state, "sentinel").publicKey() : null;
  return s?.sentinel && ours && s.sentinel === ours ? "sentinel" : "guardian";
}

/** An action in a few words, for an alert. */
function describeAction(action) {
  const detail = {
    cancel_upgrade: ` of code ${action.hash?.slice(0, 12)}`,
    cancel_stablecoin: ` of ${action.token?.slice(0, 8)}…`,
    veto_admin: ` of the handover to ${action.admin?.slice(0, 8)}…`,
    veto_forced: ` of the change to ${action.guardian?.slice(0, 8)}…`,
    extend: ` of ${action.keys?.length} entries`,
    refresh_reference: ` of ${action.fund?.slice(0, 8)}…`,
    release: ` of repo #${action.repoId}`,
  }[action.kind];
  return `${action.kind}${detail ?? ""}`;
}

/** One ground of a pause, read again on a second endpoint: the quote's refusal, or what is held against what is owed. */
async function groundOn(client, ground, s) {
  try {
    if (ground.type === "price") {
      let refusal = null;
      try {
        refusal = (await client.probe(C.openWindow, "quote", [sv.address(ground.fund), sv.i128(ONE), sv.address(ground.stablecoin)]))?.name ?? null;
      } catch (error) {
        if (!error.simulation) throw error;
        refusal = "HostError";
      }
      return { ...ground, refusal };
    }
    if (ground.type === "shares") {
      let owed = 0n;
      for (const r of s.openRepos.filter((x) => String(x.fund) === ground.fund)) {
        const repo = await client.read(C.openWindow, "get_repo", [sv.u64(r.id)]);
        if (repo && statusOf(repo) === "Open") owed += BigInt(repo.shares);
      }
      for (const r of s.releases.filter((x) => String(x.fund) === ground.fund)) {
        const pendingRelease = await client.read(C.openWindow, "pending_release", [sv.u64(r.id)]);
        if (pendingRelease) owed += BigInt(pendingRelease.shares);
      }
      return { ...ground, held: BigInt(await client.read(ground.fund, "balance", [sv.address(C.openWindow)])), owed };
    }
    if (ground.type === "coin") {
      let owed = 0n;
      for (const o of (s.offers ?? []).filter((x) => String(x.stablecoin) === ground.token)) {
        const offer = await client.read(C.openWindow, "get_offer", [sv.u64(o.id)]);
        if (offer) owed += BigInt(offer.available);
      }
      return { ...ground, held: BigInt(await client.read(ground.token, "balance", [sv.address(C.openWindow)])), owed };
    }
  } catch (error) {
    return { ...ground, error: firstLine(error) };
  }
  return ground;
}

/**
 * Reads again, on a second endpoint, the facts an action rests on, and asks
 * detectors.mjs whether they agree (rpc-2). One lying or compromised RPC can
 * then neither trigger a pause, a cancellation or a veto, nor make the
 * keeper pay for what is not needed.
 */
async function secondReading(client, action, s) {
  await caughtUp(client, s.latest);
  const seen = {};
  const owAddress = (value) => sv.address(value);
  switch (action.kind) {
    case "cancel_upgrade":
      seen.pendingUpgrade = await client.read(C.openWindow, "pending_upgrade");
      break;
    case "cancel_stablecoin":
      seen.pendingStablecoin = await client.read(C.openWindow, "pending_stablecoin_change", [owAddress(action.token)]);
      break;
    case "veto_admin":
      seen.pendingAdmin = await client.read(C.openWindow, "pending_admin");
      break;
    case "veto_forced":
      seen.pendingForcedGuardian = await client.read(C.openWindow, "pending_forced_guardian_change");
      break;
    case "pause":
      seen.grounds = await Promise.all(action.grounds.map((ground) => groundOn(client, ground, s)));
      break;
    case "extend":
    case "extend_code": {
      const read2 = await client.ledgerEntries(action.kind === "extend" ? action.keys : [action.key]);
      seen.ttlDays = read2.entries.map((e) => (e ? ((e.liveUntil - read2.latest) * LEDGER_SECS) / 86_400 : null));
      break;
    }
    case "refresh_reference": {
      const [fundState, config, head] = await Promise.all([
        client.read(C.openWindow, "get_fund_state", [owAddress(action.fund)]),
        client.read(C.openWindow, "get_fund", [owAddress(action.fund)]),
        client.latestLedger(),
      ]);
      Object.assign(seen, { referenceTime: Number(fundState?.reference_time), navMaxAge: Number(config?.nav_max_age_secs), now: Number(head.closeTime ?? 0) });
      break;
    }
    case "release":
      seen.release = await client.read(C.openWindow, "release", [sv.u64(action.repoId)]);
      break;
    default:
      break;
  }
  return confirmation(action, seen);
}

/** Sends one decided action; returns the word the rehearsal records. */
async function perform(action, s) {
  const me = (role) => sv.address(keypair(state, role).publicKey());
  switch (action.kind) {
    case "veto_admin": {
      const r = await invoke(state, "guardian", C.openWindow, "veto_admin", [me("guardian")]);
      console.log(`  ACTION   guardian vetoed the governor handover in ${r.seconds.toFixed(1)} s  ${explorer(r.hash)}`);
      return "veto handover";
    }
    case "veto_forced": {
      const r = await invoke(state, "trustee", C.openWindow, "veto_forced_guardian_change", [me("trustee")]);
      console.log(`  ACTION   trustee vetoed the forced guardian change in ${r.seconds.toFixed(1)} s  ${explorer(r.hash)}`);
      return "veto forced guardian change";
    }
    case "cancel_upgrade": {
      const r = await invoke(state, action.role, C.openWindow, "cancel_upgrade", [me(action.role)]);
      console.log(`  ACTION   ${action.role} cancelled the upgrade proposal in ${r.seconds.toFixed(1)} s  ${explorer(r.hash)}`);
      return "cancel upgrade";
    }
    case "cancel_stablecoin": {
      const r = await invoke(state, action.role, C.openWindow, "cancel_stablecoin_change", [sv.address(action.token), me(action.role)]);
      console.log(`  ACTION   ${action.role} cancelled the stablecoin proposal in ${r.seconds.toFixed(1)} s  ${explorer(r.hash)}`);
      return "cancel stablecoin";
    }
    case "pause": {
      const r = await invoke(state, action.role, C.openWindow, "pause", [me(action.role)]);
      console.log(`  ACTION   ${action.role} paused new entries in ${r.seconds.toFixed(1)} s  ${explorer(r.hash)}`);
      return "pause";
    }
    case "extend": {
      const r = await extendTtl(state, keeperRole(), action.keys, action.ledgers);
      console.log(`  ACTION   extended ${action.keys.length} entries to about 140 days in ${r.seconds.toFixed(1)} s  ${explorer(r.hash)}`);
      return "extend";
    }
    case "extend_code": {
      // Its rent is the largest fee the monitor pays: capped at one slice,
      // and a shorter slice when the rent has risen past the cap (lib.mjs).
      const r = await extendCode(state, keeperRole(), action.key, { fromDays: action.days, toDays: action.targetDays, maxResourceFee: CODE_SLICE_MAX_FEE });
      const fee = r.fee === null ? "" : `, fee ${(Number(r.fee) / 1e7).toFixed(2)} XLM`;
      console.log(`  ACTION   extended the contract code to about ${r.days.toFixed(0)} days in ${r.seconds.toFixed(1)} s${fee}  ${explorer(r.hash)}`);
      return "extend code";
    }
    case "refresh_reference": {
      // rc5: refresh_reference is open to anyone. A refusal, a NAV out of the
      // corridor or stale, is logged and leaves the other actions alone: the
      // price detector reports its cause.
      const label = s.funds?.length > 1 ? ` of ${labelOf(s.funds, action.fund)}` : "";
      try {
        const r = await invoke(state, keeperRole(), C.openWindow, "refresh_reference", [sv.address(action.fund)]);
        console.log(`  ACTION   ${keeperRole()} refreshed the price reference${label} in ${r.seconds.toFixed(1)} s  ${explorer(r.hash)}`);
        return "refresh reference";
      } catch (error) {
        console.log(`  ACTION   refresh_reference${label} refused: ${error.message}`);
        return null;
      }
    }
    case "release": {
      // The simulation said it would deliver; a refusal since then is logged
      // and the position goes back to waiting, warned about once. The
      // delivery writes the holder's balance or trustline: that holder may be
      // in the footprint, though the call does not name it (TOOL-9).
      try {
        const r = await invoke(state, keeperRole(), C.openWindow, "release", [sv.u64(action.repoId)], { extraAddresses: action.to ? [action.to] : [] });
        console.log(`  ACTION   ${keeperRole()} released the shares of repo #${action.repoId} in ${r.seconds.toFixed(1)} s (${r.value ? "delivered" : "still refused"})  ${explorer(r.hash)}`);
        return r.value ? "release" : null;
      } catch (error) {
        console.log(`  ACTION   release of repo #${action.repoId} refused: ${error.message}`);
        return null;
      }
    }
    default:
      throw new Error(`unknown action ${action.kind}`);
  }
}

/**
 * The safe automatic actions, decided by detectors.mjs from the alerts and
 * the snapshot. With a second endpoint configured, each one waits for that
 * endpoint to read the same facts; otherwise, or when it fails, it becomes a
 * critical alert and the next action still runs (auth-6, rpc-2). Returns
 * the words the rehearsal records. An announcement written since the pass
 * read the state file is merged first: a planned change is never answered
 * as an attack (TOOL-3).
 */
async function act(alerts, s, monitor = {}) {
  const ctx = { actor: actorRole(s), keys: { trustee: Boolean(state.keys.trustee), guardian: Boolean(state.keys.guardian) }, limits: LIMITS };
  refreshMonitor(monitor);
  const plan = decideActions(alerts, s, monitor, ctx);
  const raised = [...plan.alerts];
  const done = [];
  const index = secondEndpoint();
  const second = index === null ? null : endpointClient(index);
  for (const decided of plan.actions) {
    let action = decided;
    try {
      if (second) {
        const check = await secondReading(second, action, s);
        if (!check.agree) {
          raised.push({ detector: "act", threat: "Infra.1", level: "critical", message: `${describeAction(action)} not taken: ${second.url} does not confirm it (${check.detail})`, action: "check both endpoints; act by hand if the condition is real" });
          continue;
        }
        action = check.action;
      }
      const word = await perform(action, s);
      if (word) done.push(word);
    } catch (error) {
      raised.push({ detector: "act", threat: "DoS.10", level: "critical", message: `${describeAction(action)} failed: ${firstLine(error)}`, action: "act by hand; the next pass tries again while the condition lasts" });
    }
  }
  for (const a of raised) {
    console.log(`  ${a.level.toUpperCase().padEnd(8)} ${a.threat.padEnd(9)} ${a.message}  (action: ${a.action})`);
    fs.appendFileSync(ALERT_FILE, `${JSON.stringify({ at: new Date().toISOString(), ledger: s.latest, ...a })}\n`);
  }
  return done;
}

// ---------------------------------------------------------------------------
// Rehearsal: a real trigger per detector, the action, then a clean pass
// ---------------------------------------------------------------------------

async function rehearse() {
  const monitor = loadMonitor();
  const results = [];
  const pub = (role) => keypair(state, role).publicKey();
  const fund = sv.address(C.shares);
  const clean = async () => (await pass(monitor, { quiet: true })).alerts;
  const record = (detector, threat, trigger, fired, action, restored) => {
    results.push({ detector, threat, trigger, fired, action, restored });
    console.log(`  => ${detector}: fired ${fired ? "yes" : "NO"}, action ${action}, restored ${restored ? "yes" : "NO"}`);
  };
  const firedBy = (alerts, detector) => alerts.some((a) => a.detector === detector);

  console.log("Baseline pass");
  await pass(monitor);

  if (runStep(1)) {
    console.log("\n1. Price (Tamper.1): the operator publishes a NAV 3 % too high");
    const now = await ledgerTime();
    const good = navAt(state.navPublishedAt ?? now, now);
    await invoke(state, "operator", C.navOracle, "publish", [asset.stellar(C.shares), sv.i128((good * 103n) / 100n), sv.u64(now - 1)]);
    const { s, alerts } = await pass(monitor);
    const fired = firedBy(alerts.filter((a) => a.level === "critical"), "price");
    const done = await act(alerts, s);
    await invoke(state, "operator", C.navOracle, "publish", [asset.stellar(C.shares), sv.i128(good), sv.u64(now)]);
    await invoke(state, "governor", C.openWindow, "unpause", []);
    const after = await clean();
    record("price", "Tamper.1", "NAV +3 % published", fired, done.join(", ") || "none", !firedBy(after, "price"));
  }

  if (runStep(2)) {
    console.log("\n2. Reconciliation (DoS.5): one share unit appears or disappears from the contract's balance");
    // With shares locked in an open repo the issuer claws one unit back; with
    // nothing locked (no open repo), a stray unit is minted to the contract
    // instead. Both break invariant I2 in one direction and are reverted.
    const heldBefore = BigInt(await read(state, C.shares, "balance", [sv.address(C.openWindow)]));
    const [breakI2, revertI2, trigger] = heldBefore > 0n
      ? ["clawback", "mint", "issuer clawback of 1 unit"]
      : ["mint", "clawback", "1 stray unit minted to the contract (no open repo)"];
    await invoke(state, "steward", C.shares, breakI2, [sv.address(C.openWindow), sv.i128(1n)]);
    const { s, alerts } = await pass(monitor);
    const fired = firedBy(alerts, "reconciliation");
    const done = await act(alerts, s);
    await invoke(state, "steward", C.shares, revertI2, [sv.address(C.openWindow), sv.i128(1n)]);
    await invoke(state, "governor", C.openWindow, "unpause", []);
    const after = await clean();
    record("reconciliation", "DoS.5", trigger, fired, done.join(", ") || "none", !firedBy(after, "reconciliation"));
  }

  if (runStep(3)) {
    console.log("\n3. Privileged change (Elev.2): the governor proposes a new guardian, which waits for the time delay");
    await invoke(state, "governor", C.openWindow, "set_guardian", [sv.address(pub("operator"))]);
    const { alerts } = await pass(monitor);
    const fired = alerts.some((a) => a.detector === "privileged" && /guardian_change_proposed/.test(a.message));
    // The current guardian vetoes its own replacement inside the window.
    await invoke(state, "guardian", C.openWindow, "cancel_guardian_change", [sv.address(pub("guardian"))]);
    const left = await read(state, C.openWindow, "pending_guardian_change");
    const guardian = await read(state, C.openWindow, "guardian");
    record("privileged", "Elev.2", "governor proposes a new guardian", fired, "current guardian cancelled it", !left && guardian === pub("guardian"));
  }

  if (runStep(4)) {
    console.log("\n4. Exposure (DoS.1): the steward lowers the fund cap just above what is lent");
    const config = await read(state, C.openWindow, "get_fund", [fund]);
    const fs0 = await read(state, C.openWindow, "get_fund_state", [fund]);
    const tight = BigInt(fs0.outstanding) + BigInt(fs0.outstanding) / 9n + 1n;
    // The per-repo cap may not exceed the fund cap: lower both.
    await invoke(state, "steward", C.openWindow, "set_fund_limits", [fund, sv.u32(config.haircut_bps), sv.i128(tight), sv.i128(tight)]);
    const { alerts } = await pass(monitor);
    const fired = alerts.some((a) => a.detector === "exposure" && /fund outstanding/.test(a.message));
    // Lowering a cap is immediate; raising it back is a loosening, so it
    // waits for the time delay before anyone may apply it.
    await invoke(state, "steward", C.openWindow, "set_fund_limits", [fund, sv.u32(FUND_SETTINGS.haircutBps), sv.i128(FUND_SETTINGS.maxPrincipalPerRepo), sv.i128(FUND_SETTINGS.maxOutstanding)]);
    const pending = await read(state, C.openWindow, "pending_fund_limits_change", [fund]);
    const wait = pending ? Number(pending.eta) - (await ledgerTime()) : 0;
    console.log(`  restoring the caps is a loosening: it applies after the delay (${wait} s)`);
    while (pending && (await ledgerTime()) < Number(pending.eta)) await sleep(10_000);
    if (pending) await invoke(state, "operator", C.openWindow, "apply_fund_limits_change", [fund]);
    const after = await clean();
    record("exposure", "DoS.1", "fund cap lowered to 90 % utilisation", fired, `caps restored through the ${wait} s delay`, !after.some((a) => a.detector === "exposure"));
  }

  if (runStep(5)) {
    console.log("\n5. Pause (DoS.4): the guardian pauses");
    await invoke(state, "guardian", C.openWindow, "pause", [sv.address(pub("guardian"))]);
    const { alerts } = await pass(monitor);
    const fired = firedBy(alerts, "pause");
    await invoke(state, "governor", C.openWindow, "unpause", []);
    const after = await clean();
    record("pause", "DoS.4", "pause by the guardian", fired, "governor unpaused", !after.some((a) => a.detector === "pause" && /are paused/.test(a.message)));
  }

  if (runStep(6)) {
    console.log("\n6. TTL (DoS.2): threshold raised above every entry's time to live (forced: no entry is near archival)");
    const saved = LIMITS.ttlDays;
    LIMITS.ttlDays = 130;
    const { s, alerts } = await pass(monitor);
    const fired = firedBy(alerts, "ttl");
    // The code entry keeps its own threshold (`codeTtlDays`, 90 days), which
    // the drill does not force: its rent is real money, so the drill extends
    // the small entries and leaves the code to its normal rule.
    const done = await act(alerts.filter((x) => x.kind !== "code"), s);
    const after = await clean();
    LIMITS.ttlDays = saved;
    record("ttl", "DoS.2", "threshold forced to 130 days", fired, done.join(", ") || "none", !after.some((x) => x.detector === "ttl" && x.kind !== "code"));
  }

  if (runStep(7)) {
    console.log("\n7. Events (Repud.1): no real trigger exists; the contract emits an event on every repo");
    const { alerts } = await pass(monitor);
    record("events", "Repud.1", "none possible: checked that every recent repo has its event", false, "none", !firedBy(alerts, "events"));
  }

  if (runStep(8)) {
    console.log("\n8. Key compromise drill (Elev.2): the governor keys propose an unannounced upgrade");
    // The hash of another contract's code stands for a hostile WASM: it is never executed.
    const hostile = crypto.createHash("sha256").update(fs.readFileSync(path.join(WASM_DIR, "fund_token.wasm"))).digest();
    const proposed = await invoke(state, "governor", C.openWindow, "propose_upgrade", [sv.bytes(hostile)], { cosigners: ["trustee"] });
    const proposedAt = Date.now();
    const pending = await read(state, C.openWindow, "pending_upgrade");
    const early = await probe(state, "governor", C.openWindow, "upgrade", [sv.bytes(hostile)]);
    console.log(`  upgrade before the delay: ${early ? early.name : "accepted"}`);
    const { s, alerts } = await pass(monitor);
    const fired = alerts.some((a) => a.detector === "privileged" && a.level === "critical" && /upgrade_proposed/.test(a.message));
    const done = await act(alerts, s, monitor);
    const reacted = (Date.now() - proposedAt) / 1000;
    let after = await read(state, C.openWindow, "pending_upgrade");
    const window = Number(pending.eta) - (await ledgerTime());
    console.log(`  proposal ${explorer(proposed.hash)}; ${done.includes("cancel upgrade") ? `cancelled ${reacted.toFixed(0)} s after it, ${window} s before it could apply` : "not cancelled by the monitor"}`);
    // The drill never leaves its stand-in code pending: when the monitor's
    // cancellation was not taken (the second endpoint lagging or down), the
    // governor withdraws its own proposal, which `npm run upgrade -- --apply`
    // would otherwise meet (TOOL-2).
    let cleanup = "";
    if (after && hex(after.wasm_hash) === hostile.toString("hex")) {
      const withdrawn = await invoke(state, "governor", C.openWindow, "cancel_upgrade", [sv.address(pub("governor"))]);
      after = await read(state, C.openWindow, "pending_upgrade");
      cleanup = "; still pending after the monitor's action, withdrawn by the governor";
      console.log(`  still pending after the monitor's action: the governor withdrew its own proposal ${explorer(withdrawn.hash)}`);
    }
    record("privileged", "Elev.2", "unannounced upgrade proposed with the governor keys", fired, `${done.join(", ") || "none"} after ${reacted.toFixed(0)} s, ${window} s of the delay left${cleanup}`, !after && early?.name === "TimelockPending");
  }

  if (runStep(9)) {
    console.log("\n9. Issuer freeze during a repo (DoS.5, decision S9): repurchase settles, the shares wait");
    const borrower = pub("borrower");
    const opened = await invoke(state, "borrower", C.openWindow, "open_repo", [
      sv.address(borrower), sv.u64(state.ids.marketOffer), fund, sv.i128(100n * ONE), sv.i128(50n * ONE), sv.u64(3600),
    ]);
    const repoId = Number(opened.value);
    await invoke(state, "steward", C.shares, "set_frozen", [sv.address(C.openWindow), sv.bool(true)]);
    const repaid = await invoke(state, "borrower", C.openWindow, "repurchase", [sv.u64(repoId)]);
    console.log(`  repo #${repoId} repaid while the contract is frozen: ${explorer(repaid.hash)}`);
    // While the token refuses, release returns false and keeps the record (and its TTL).
    const delivered = await read(state, C.openWindow, "release", [sv.u64(repoId)], "operator");
    const { s, alerts } = await pass(monitor);
    const fired = alerts.some((a) => a.detector === "reconciliation" && /held back/.test(a.message));
    const balanced = !alerts.some((a) => /units apart/.test(a.message));
    await invoke(state, "steward", C.shares, "set_frozen", [sv.address(C.openWindow), sv.bool(false)]);
    const released = await invoke(state, "operator", C.openWindow, "release", [sv.u64(repoId)]);
    console.log(`  release while frozen: ${delivered ? "delivered" : "refused by the token, record kept"}; after the issuer lifts the freeze: ${explorer(released.hash)}, delivered ${released.value}`);
    const after = await clean();
    record("reconciliation", "DoS.5", "issuer freezes the contract, borrower repays", fired && balanced && delivered === false && released.value === true, "issuer lifts the freeze, anyone releases", !firedBy(after, "reconciliation"));
  }

  if (runStep(10)) {
    console.log("\n10. Governor handover with stolen keys (Elev.2, version 4): the guardian vetoes inside the delay");
    const attacker = keypair(state, "operator").publicKey(); // stands for an address the attacker controls
    const proposed = await invoke(state, "governor", C.openWindow, "set_admin", [sv.address(attacker)]);
    const proposedAt = Date.now();
    const pending = await read(state, C.openWindow, "pending_admin");
    const early = await probe(state, "operator", C.openWindow, "accept_admin", []);
    console.log(`  accept before the delay: ${early ? early.name : "accepted"}; proposal ${explorer(proposed.hash)}`);
    const { s, alerts } = await pass(monitor);
    const fired = alerts.some((a) => a.level === "critical" && /governor handover proposed/.test(a.message));
    const done = await act(alerts, s, monitor);
    let after = await read(state, C.openWindow, "pending_admin");
    // Not vetoed (no guardian key on this host, or the second endpoint did
    // not confirm): the governor withdraws its own handover (TOOL-2).
    let cleanup = "";
    if (after && String(after.admin) === attacker) {
      const withdrawn = await invoke(state, "governor", C.openWindow, "cancel_admin", []);
      after = await read(state, C.openWindow, "pending_admin");
      cleanup = "; still pending after the monitor's action, withdrawn by the governor";
      console.log(`  still pending after the monitor's action: the governor withdrew its own handover ${explorer(withdrawn.hash)}`);
    }
    const governor = await read(state, C.openWindow, "admin");
    const window = Number(pending.eta) - (await ledgerTime());
    record("privileged", "Elev.2", "governor handover proposed with the governor keys", fired, `${done.join(", ") || "none"} after ${((Date.now() - proposedAt) / 1000).toFixed(0)} s, ${window} s of the delay left${cleanup}`, !after && governor === pub("governor") && early?.name === "TimelockPending");
  }

  if (runStep(11)) {
    console.log("\n11. Backup NAV feed (Tamper.1): admitted with two keys after the delay, then a divergence stops pricing");
    const fundAsset = asset.stellar(C.shares);
    if (!C.backupFeed) {
      C.backupFeed = await deploy(state, "operator", "nav_oracle.wasm", [sv.address(pub("operator")), asset.other("USD"), sv.u32(14), sv.u32(300)]);
      saveState(state);
    }
    const primary = await read(state, C.navOracle, "lastprice", [fundAsset]);
    let t = await ledgerTime();
    await invoke(state, "operator", C.backupFeed, "publish", [fundAsset, sv.i128(BigInt(primary.price)), sv.u64(t - 1)]);
    let active = await read(state, C.openWindow, "get_fallback", [fund]);
    if (!active) {
      const feed = sv.struct({ oracle: sv.address(C.backupFeed), asset: fundAsset, max_age_secs: sv.u64(26 * 3600), max_divergence_bps: sv.u32(20) });
      await invoke(state, "governor", C.openWindow, "propose_fallback", [fund, feed], { cosigners: ["steward"] });
      const pending = await read(state, C.openWindow, "pending_fallback", [fund]);
      console.log(`  backup feed proposed by governor and steward; applies after the delay (${Number(pending.eta) - (await ledgerTime())} s)`);
      while ((await ledgerTime()) < Number(pending.eta)) await sleep(10_000);
      t = await ledgerTime();
      await invoke(state, "operator", C.backupFeed, "publish", [fundAsset, sv.i128(BigInt(primary.price)), sv.u64(t - 1)]);
      await invoke(state, "operator", C.openWindow, "apply_fallback", [fund]);
      active = await read(state, C.openWindow, "get_fallback", [fund]);
    }
    console.log(`  backup feed active: ${Boolean(active)}`);
    t = await ledgerTime();
    await invoke(state, "operator", C.backupFeed, "publish", [fundAsset, sv.i128((BigInt(primary.price) * 1005n) / 1000n), sv.u64(t)]);
    const refused = await probe(state, "operator", C.openWindow, "quote", [fund, sv.i128(ONE), sv.address(C.euro)]);
    const { s, alerts } = await pass(monitor);
    const fired = alerts.some((a) => a.detector === "price" && /PriceDivergence/.test(a.message));
    const done = await act(alerts, s, monitor);
    const t2 = Math.max(await ledgerTime(), t);
    await invoke(state, "operator", C.backupFeed, "publish", [fundAsset, sv.i128(BigInt(primary.price)), sv.u64(t2)]);
    if (await read(state, C.openWindow, "is_paused")) await invoke(state, "governor", C.openWindow, "unpause", []);
    const priced = await probe(state, "operator", C.openWindow, "quote", [fund, sv.i128(ONE), sv.address(C.euro)]);
    record("price", "Tamper.1", "backup feed diverges by 0.5 % from the primary", Boolean(active) && fired && refused?.name === "PriceDivergence", `${done.join(", ") || "none"}; backup realigned`, !priced);
  }

  if (runStep(12)) {
    console.log("\n12. Re-anchoring (S21): governor and steward sign the values, applied by anyone after the delay");
    const fundAsset = asset.stellar(C.shares);
    const nav = BigInt((await read(state, C.navOracle, "lastprice", [fundAsset])).price);
    const fxOracle = state.fxSource === "local" ? C.navOracle : REFLECTOR_FX;
    const fx = BigInt((await read(state, fxOracle, "lastprice", [asset.other("EUR")])).price);
    await invoke(state, "governor", C.openWindow, "propose_reanchor", [fund, sv.i128(nav), sv.i128(fx)], { cosigners: ["steward"] });
    const pending = await read(state, C.openWindow, "pending_reanchor", [fund]);
    const { alerts } = await pass(monitor);
    const fired = alerts.some((a) => /reanchor_proposed/.test(a.message));
    console.log(`  proposed with NAV ${(Number(nav) / 1e14).toFixed(4)} and EUR/USD ${(Number(fx) / 1e14).toFixed(4)}; applies after the delay (${Number(pending.eta) - (await ledgerTime())} s)`);
    while ((await ledgerTime()) < Number(pending.eta)) await sleep(10_000);
    await invoke(state, "operator", C.openWindow, "apply_reanchor", [fund]);
    const fs1 = await read(state, C.openWindow, "get_fund_state", [fund]);
    record("privileged", "S21", "two-key re-anchor of the price reference", fired, "applied after the delay by a third party", BigInt(fs1.reference_nav) === nav && BigInt(fs1.reference_fx) === fx);
  }

  if (runStep(13)) {
    console.log("\n13. Forced guardian change (Elev.2): proposed with the governor and trustee keys, vetoed by the trustee");
    const trustee = state.keys.trustee ? await read(state, C.openWindow, "trustee").catch(() => null) : null;
    if (!trustee) {
      console.log("  no trustee on this deployment (needs a `setup -- --fresh` on a contract with the trustee role); skipped");
    } else {
      const guardian0 = await read(state, C.openWindow, "guardian");
      const proposed = await invoke(state, "governor", C.openWindow, "force_guardian_change", [sv.address(pub("operator"))], { cosigners: ["trustee"] });
      const proposedAt = Date.now();
      const { s, alerts } = await pass(monitor);
      const fired = alerts.some((a) => a.detector === "privileged" && a.level === "critical" && /forced guardian change/.test(a.message));
      const done = await act(alerts, s, monitor);
      const reacted = (Date.now() - proposedAt) / 1000;
      let left = await read(state, C.openWindow, "pending_forced_guardian_change");
      console.log(`  proposal ${explorer(proposed.hash)}; ${done.join(", ") || "no action"} after ${reacted.toFixed(0)} s`);
      // Not vetoed: the governor withdraws its own forced change (TOOL-2).
      let cleanup = "";
      if (left && String(left.guardian) === pub("operator")) {
        const withdrawn = await invoke(state, "governor", C.openWindow, "cancel_forced_guardian_change", []);
        left = await read(state, C.openWindow, "pending_forced_guardian_change");
        cleanup = "; still pending after the monitor's action, withdrawn by the governor";
        console.log(`  still pending after the monitor's action: the governor withdrew its own forced change ${explorer(withdrawn.hash)}`);
      }
      const guardian1 = await read(state, C.openWindow, "guardian");
      record("privileged", "Elev.2", "forced guardian change proposed with the governor and trustee keys", fired, `${done.join(", ") || "none"} after ${reacted.toFixed(0)} s, 30 days before it could apply${cleanup}`, !left && guardian1 === guardian0);
    }
  }

  saveMonitor(monitor);
  if (runStep(14)) {
    console.log("\n14. FX leg (Tamper.1): the exchange-rate feed keeps republishing the same rate with a fresh timestamp");
    // The live feed cannot be frozen on demand: the drill lowers the threshold
    // to zero so that the rate observed on two consecutive passes, identical
    // as it is while the market is closed, raises the alert; then restores it.
    const before = await clean();
    monitor.fxFrozenHoursOverride = 0;
    const { alerts } = await pass(monitor);
    delete monitor.fxFrozenHoursOverride;
    const fired = firedBy(alerts, "fx");
    const after = await clean();
    record("fx", "Tamper.1", "FX rate unchanged across passes (threshold lowered to 0 h)", fired, "verify market closure; band and haircut bound it", !firedBy(after, "fx") || firedBy(before, "fx"));
  }

  if (runStep(15)) {
    console.log("\n15. Keeper float (DoS.2): the rent-paying account falls below two slices of code rent");
    monitor.keeperMinXlmOverride = Number.POSITIVE_INFINITY;
    const { alerts } = await pass(monitor);
    delete monitor.keeperMinXlmOverride;
    const fired = firedBy(alerts, "keeper");
    const after = await clean();
    record("keeper", "DoS.2", "keeper threshold raised above its balance", fired, "top up from treasury", !firedBy(after, "keeper"));
  }

  if (runStep(16)) {
    console.log("\n16. Lender approvals (DoS.2, S6): threshold forced above their time to live; an archived approval would block a seizure");
    const saved = LIMITS.ttlDays;
    // Whatever their current time to live, every watched approval must be
    // listed: the threshold is forced above any TTL for the firing pass, then
    // set to 130 days to check that the extension (about 140 days) took.
    LIMITS.ttlDays = 10_000;
    const { s, alerts } = await pass(monitor);
    const lenderAlerts = alerts.filter((a) => a.detector === "ttl" && /^lender /.test(a.message));
    const fired = lenderAlerts.length > 0;
    const done = await act(lenderAlerts, s);
    LIMITS.ttlDays = 130;
    const after = (await clean()).filter((a) => a.detector === "ttl" && /^lender /.test(a.message));
    LIMITS.ttlDays = saved;
    record("ttl", "DoS.2", `threshold forced above every TTL: ${lenderAlerts.length} lender approval(s) watched and extended`, fired, done.join(", ") || "none", fired && after.length === 0);
  }

  if (runStep(17)) {
    console.log("\n17. NAV feed (Tamper.1): the NAV keeps its value publication after publication");
    // The feed cannot be frozen on demand: the drill lowers the threshold to
    // zero, so a NAV identical on two consecutive passes raises the alert.
    const before = await clean();
    monitor.navFrozenHoursOverride = 0;
    const { alerts } = await pass(monitor);
    delete monitor.navFrozenHoursOverride;
    const fired = firedBy(alerts, "nav");
    const after = await clean();
    record("nav", "Tamper.1", "NAV unchanged across passes (threshold lowered to 0 h)", fired, "verify the fund type and the operator; the corridor floor bounds it", !firedBy(after, "nav") || firedBy(before, "nav"));
  }

  if (runStep(18)) {
    console.log("\n18. Stablecoin proposed without announcement (Elev.2, S29): withdrawn inside the delay");
    const supported = await read(state, C.openWindow, "schema_version").then(() => true, () => false);
    if (!supported) {
      console.log("  instance without rc4 code; skipped");
    } else {
      // A token of its own stands for an unknown stablecoin: it is never
      // registered. Since rc5 a proposal needs a token that answers 7
      // decimals (F4), so a feed contract no longer does; deployed once.
      if (!C.drillToken) {
        C.drillToken = await deploy(state, "operator", "fund_token.wasm", [sv.address(pub("operator")), sv.u32(7), sv.string("Rehearsal stand-in token"), sv.string("tDRILL")]);
        saveState(state);
      }
      const token = C.drillToken;
      const proposed = await invoke(state, "governor", C.openWindow, "set_stablecoin", [sv.address(token), sv.symbol("XXX")]);
      const { s, alerts } = await pass(monitor);
      const fired = alerts.some((a) => a.level === "critical" && /stablecoin registration proposed/.test(a.message));
      const done = await act(alerts, s, monitor);
      let left = await read(state, C.openWindow, "pending_stablecoin_change", [sv.address(token)]);
      console.log(`  proposal ${explorer(proposed.hash)}; ${done.join(", ") || "no action"}`);
      // Not cancelled: the governor withdraws its own proposal (TOOL-2).
      let cleanup = "";
      if (left) {
        const withdrawn = await invoke(state, "governor", C.openWindow, "cancel_stablecoin_change", [sv.address(token), sv.address(pub("governor"))]);
        left = await read(state, C.openWindow, "pending_stablecoin_change", [sv.address(token)]);
        cleanup = "; still pending after the monitor's action, withdrawn by the governor";
        console.log(`  still pending after the monitor's action: the governor withdrew its own proposal ${explorer(withdrawn.hash)}`);
      }
      record("privileged", "Elev.2", "unannounced stablecoin registration proposed with the governor keys", fired, `${done.join(", ") || "none"} by ${actorRole(s)}${cleanup}`, !left);
    }
  }

  if (runStep(19)) {
    console.log("\n19. Sentinel limits (S26): the sentinel pauses, and cannot veto a governor handover");
    const sentinel = await read(state, C.openWindow, "sentinel").catch(() => null);
    if (!sentinel || !state.keys.sentinel) {
      console.log("  no sentinel named on this instance (run `npm run setup -- --sentinel` on rc4 code); skipped");
    } else {
      const me = sv.address(keypair(state, "sentinel").publicKey());
      const paused = await invoke(state, "sentinel", C.openWindow, "pause", [me]);
      const refused = await probe(state, "sentinel", C.openWindow, "veto_admin", [me]);
      await invoke(state, "governor", C.openWindow, "unpause", []);
      const after = await clean();
      console.log(`  pause by the sentinel ${explorer(paused.hash)}; veto_admin by the sentinel: ${refused ? refused.name : "accepted"}`);
      record("pause", "S26", "sentinel pauses, then tries to veto a handover", true, `pause accepted, veto refused (${refused?.name ?? "accepted"})`, refused?.name === "Unauthorized" && !after.some((a) => a.detector === "pause" && /are paused/.test(a.message)));
    }
  }

  // The event cursor and the memory of every drill: the next watch starts
  // after the rehearsal's own events, not before drills 14 to 19 (TOOL-7).
  saveMonitor(monitor);
  const file = path.join(STATE_DIR, `rehearsal-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(file, JSON.stringify(results, null, 2));
  console.log(`\nRehearsal written to ${path.relative(process.cwd(), file)}`);
  console.log("\n| Detector | Threat | Trigger | Fired | Action | Restored |\n|---|---|---|---|---|---|");
  for (const r of results) console.log(`| ${r.detector} | ${r.threat} | ${r.trigger} | ${r.fired ? "yes" : "no"} | ${r.action} | ${r.restored ? "yes" : "no"} |`);
}

async function main() {
  if (REHEARSE) return rehearse();
  const monitor = loadMonitor();
  // A change announced in advance is reported as a warning, never cancelled
  // or vetoed: an upgrade, a stablecoin, a governor handover, a forced
  // guardian change (detectors.mjs, recordAnnouncement).
  let announcement;
  try {
    announcement = recordAnnouncement(monitor, args, { isAddress: (value) => StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value) });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  if (announcement) {
    saveMonitor(monitor);
    console.log(announcement);
    return;
  }
  if (RPC_URLS.length === 1) console.log("single RPC endpoint, no cross-check and no second reading before an action (set STELLAR_RPC_URLS to two)");
  for (;;) {
    try {
      const { s, alerts } = await pass(monitor);
      if (ACT) await act(alerts, s, monitor);
      saveMonitor(monitor);
      await heartbeat();
    } catch (error) {
      // In watch mode a failed pass (public RPC hiccup, "Account not found"
      // on a live account, timeout) is logged and retried, never fatal: the
      // watch must survive a weekend unattended. A single pass still fails.
      if (!WATCH) throw error;
      console.error(`\n[${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC] pass failed, retrying in 30 s: ${error.message}`);
    }
    if (!WATCH) return;
    await sleep(30_000);
  }
}

main().catch((error) => {
  console.error(`\nMonitor stopped: ${error.message}`);
  process.exit(1);
});
