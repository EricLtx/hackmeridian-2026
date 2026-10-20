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
// A detector never moves funds. The only actions are the guardian's pause,
// which blocks new entries and never exits, a TTL extension, which anyone
// may pay for, and a step of a fund's price reference along its model
// (`refresh_reference`), which anyone may call. Unpausing stays a human
// decision for the governor.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Keypair, xdr } from "@stellar/stellar-sdk";
import {
  ONE,
  ROOT,
  RPC_URLS,
  STATE_DIR,
  WASM_DIR,
  codeKey,
  asset,
  contractEvents,
  deploy,
  saveState,
  REFLECTOR_FX_TESTNET as REFLECTOR_FX,
  explorer,
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
  sleep,
  storageKey,
  sv,
} from "./lib.mjs";
import { FUND_SETTINGS, navAt } from "./config.mjs";
import { LEDGER_SECS, LIMITS, decideActions, detect, factsNeeded, labelOf, lenderPairs, statusOf } from "./detectors.mjs";

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

/** Monitoring state of the deployed contract; a new deployment starts afresh. */
function loadMonitor() {
  let m = {};
  try {
    m = JSON.parse(fs.readFileSync(MONITOR_FILE, "utf8"));
  } catch {
    // first run
  }
  return m.contract === C.openWindow ? m : { contract: C.openWindow, announced: m.announced ?? [] };
}
function saveMonitor(m) {
  fs.writeFileSync(MONITOR_FILE, JSON.stringify(m, null, 2));
}

// ---------------------------------------------------------------------------
// The indexer's journal, read incrementally (Repud.2 cross-check)
// ---------------------------------------------------------------------------
//
// `indexer/.state/events-YYYY-MM.jsonl` holds one JSON line per event with
// `txHash`, `id` (the RPC event id) and `ledger`. Only the files of the
// current and the previous month are read, from the byte where the last pass
// stopped; the keys `txHash:id` seen so far stay in memory. `pending` holds
// the RPC events the journal did not cover yet, re-checked on later passes.

const JOURNAL = { seen: new Set(), lastLedger: null, offsets: new Map(), pending: new Map() };

/** Reads the new lines of the journal; returns `{ lastLedger, seen }` or null when there is no journal. */
function readJournal(contractId) {
  if (!fs.existsSync(JOURNAL_DIR)) return null;
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
      JOURNAL.seen.add(`${line.txHash}:${line.id}`);
      if (JOURNAL.lastLedger === null || line.ledger > JOURNAL.lastLedger) JOURNAL.lastLedger = line.ledger;
    }
    JOURNAL.offsets.set(file, start + end + 1);
  }
  return { lastLedger: JOURNAL.lastLedger, seen: JOURNAL.seen };
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
async function snapshot(monitor) {
  const now = await ledgerTime();
  const [paused, repos, offers] = await Promise.all([
    read(state, C.openWindow, "is_paused"),
    scan("get_repo"),
    scan("get_offer"),
  ]);
  // One block per admitted fund: settings, state, NAV, shares held, quote probe, steward backup, FX leg.
  const funds = await Promise.all(
    fundsOf().map(async (f) => {
      const fund = sv.address(f.shares);
      const [config, fundState, nav, held, stewardBackup] = await Promise.all([
        read(state, C.openWindow, "get_fund", [fund]),
        read(state, C.openWindow, "get_fund_state", [fund]),
        read(state, f.navOracle, "lastprice", [asset.stellar(f.shares)]),
        read(state, f.shares, "balance", [sv.address(C.openWindow)]),
        // Version 4: without a registered backup, a lost steward key can never be replaced.
        read(state, C.openWindow, "steward_backup", [fund]).catch(() => undefined),
      ]);
      // Simulated from the null account: reading needs no role key on this host.
      const priceError = await probe(state, null, C.openWindow, "quote", [fund, sv.i128(ONE), sv.address(f.stablecoin)]);
      // The FX leg, when the fund's price is crossed through an FX feed.
      const fxLeg = Array.isArray(config.source) && config.source[0] === "Cross" ? config.source[1] : null;
      const fxAsset = fxLeg ? (fxLeg.asset[0] === "Other" ? asset.other(String(fxLeg.asset[1])) : asset.stellar(String(fxLeg.asset[1]))) : null;
      const fx = fxLeg ? await read(state, fxLeg.oracle, "lastprice", [fxAsset]).catch(() => null) : null;
      return { ...f, config, fundState, nav, held, stewardBackup, priceError, fxLeg, fx, currency: String(fundState.currency) };
    }),
  );
  // Caps are per currency: two stablecoins of one currency share one cap.
  const caps = Object.fromEntries(
    await Promise.all(
      [...new Set(funds.map((f) => f.currency))].map(async (currency) => {
        const [outstanding, cap] = await Promise.all([
          read(state, C.openWindow, "currency_outstanding", [sv.symbol(currency)]),
          read(state, C.openWindow, "currency_cap", [sv.symbol(currency)]),
        ]);
        return [currency, { outstanding, cap }];
      }),
    ),
  );
  // The first fund's fields stay at the top level: the drills and older readers use them.
  const [first] = funds;
  const { config, fundState, nav, held, stewardBackup, priceError, fxLeg, fx, currency } = first;
  const { outstanding, cap } = caps[currency];
  // The keeper pays the rent: its float must cover the coming month. A host
  // without the keeper's key (a witness) reports it unreadable.
  const keeperPub = publicKeyOf(state, keeperRole());
  const keeperKey = keeperPub ? xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(keeperPub).xdrAccountId() })) : null;
  const keeperEntry = keeperKey ? await ledgerEntries([keeperKey]).catch(() => null) : null;
  const keeperXlm = keeperEntry?.entries[0]?.value?.account?.balance != null ? Number(keeperEntry.entries[0].value.account.balance) / 1e7 : null;

  const openRepos = repos.filter((r) => statusOf(r) === "Open");
  const releases = [];
  for (const r of repos.filter((x) => statusOf(x) !== "Open")) {
    const pending = await read(state, C.openWindow, "pending_release", [sv.u64(r.id)]);
    if (pending) releases.push({ id: r.id, ...pending });
  }
  const liveOffers = offers.filter((o) => BigInt(o.available) > 0n);
  const keyed = [
    ["contract instance", storageKey(C.openWindow)],
    ...funds.flatMap((f) => [
      [`${f.label} config`, storageKey(C.openWindow, sv.variant("Fund", sv.address(f.shares)))],
      [`${f.label} state`, storageKey(C.openWindow, sv.variant("FundState", sv.address(f.shares)))],
    ]),
    ...openRepos.map((r) => [`repo #${r.id}`, storageKey(C.openWindow, sv.variant("Repo", sv.u64(r.id)))]),
    ...liveOffers.map((o) => [`offer #${o.id}`, storageKey(C.openWindow, sv.variant("Offer", sv.u64(o.id)))]),
    // A lender's approval is read by every exit that delivers shares to it
    // (seize, redirect): an archived approval would block a seizure, which
    // decision S6 forbids. Watch one entry per (fund, lender) an exit may read.
    ...lenderPairs(liveOffers, openRepos).map(([fund, lender]) => [
      `lender ${lender.slice(0, 6)} on ${labelOf(funds, fund)}`,
      storageKey(C.openWindow, sv.variant("Lender", sv.address(fund), sv.address(lender))),
    ]),
  ];
  // The contract no longer extends its own code (rent grows with size): the operator does.
  const head = await ledgerEntries([storageKey(C.openWindow)]);
  const rawCode = head.entries[0]?.value?.contractData?.val?.instance?.executable?.wasmHash;
  if (rawCode) keyed.push(["contract code", codeKey(typeof rawCode.toXDR === "function" ? rawCode.toXDR() : rawCode), "code"]);
  const ledger = await ledgerEntries(keyed.map(([, k]) => k));
  const ttl = keyed.map(([label, key, kind], i) => ({
    label,
    key,
    kind,
    days: ledger.entries[i] ? ((ledger.entries[i].liveUntil - ledger.latest) * LEDGER_SECS) / 86_400 : null,
  }));
  const instance = ledger.entries[0]?.value?.contractData?.val?.instance;
  const rawHash = instance?.executable?.wasmHash;
  const wasmHash = rawHash ? (typeof rawHash.toXDR === "function" ? rawHash.toXDR("hex") : Buffer.from(rawHash).toString("hex")) : null;

  // The RPC serves events up to its latest ledger and for about a week back.
  const from = Math.min(Math.max(monitor.cursor ?? ledger.latest - 720, ledger.latest - 17_000), ledger.latest);
  const events = await contractEvents(C.openWindow, from);
  // rc4: the layout version behind the code means an upgrade without its migration; the sentinel is the key that acts.
  const [schemaVersion, sentinel] = await Promise.all([
    read(state, C.openWindow, "schema_version").then(Number, () => null),
    read(state, C.openWindow, "sentinel").catch(() => null),
  ]);
  // Two sources for the chain head (every configured RPC) and for the event trail (the indexer's journal).
  const rpcHeights = RPC_URLS.length > 1 ? await latestLedgers() : null;
  const journal = readJournal(C.openWindow);
  return { now, latest: ledger.latest, from, funds, caps, config, fundState, paused, nav, repos, openRepos, releases, held, stewardBackup, outstanding, cap, currency, priceError, ttl, wasmHash, events, fxLeg, fx, keeperRole: keeperRole(), keeperXlm, rpcHeights, journal, schemaVersion, sentinel };
}

async function pass(monitor, { quiet = false } = {}) {
  const s = await snapshot(monitor);
  const alerts = detect(s, monitor, { limits: LIMITS, journalPending: JOURNAL.pending });
  monitor.cursor = s.latest + 1;
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

/** The proposals the decided actions depend on, read only when an alert calls for them. */
async function readPending(needed) {
  const pending = {};
  if (needed.admin) pending.admin = await read(state, C.openWindow, "pending_admin");
  if (needed.forcedGuardian) pending.forcedGuardian = await read(state, C.openWindow, "pending_forced_guardian_change").catch(() => null);
  if (needed.upgrade) pending.upgrade = await read(state, C.openWindow, "pending_upgrade");
  return pending;
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
      // Its rent is the largest fee the monitor pays: capped at one slice (lib.mjs).
      const r = await extendTtl(state, keeperRole(), [action.key], Math.floor(action.targetDays * 17_280), { maxResourceFee: CODE_SLICE_MAX_FEE });
      const fee = r.fee === null ? "" : `, fee ${(Number(r.fee) / 1e7).toFixed(2)} XLM`;
      console.log(`  ACTION   extended the contract code to about ${action.targetDays.toFixed(0)} days in ${r.seconds.toFixed(1)} s${fee}  ${explorer(r.hash)}`);
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
    default:
      throw new Error(`unknown action ${action.kind}`);
  }
}

/** The safe automatic actions (detectors.mjs decides them): pause on a critical alert, cancel an unannounced upgrade, extend TTLs. */
async function act(alerts, s, monitor = {}) {
  const ctx = { actor: actorRole(s), keys: { trustee: Boolean(state.keys.trustee), guardian: Boolean(state.keys.guardian) } };
  const pending = await readPending(factsNeeded(alerts, ctx));
  const { actions } = decideActions(alerts, { ...s, pending }, monitor, ctx);
  const done = [];
  for (const action of actions) {
    const word = await perform(action, s);
    if (word) done.push(word);
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
    const done = await act(alerts, s);
    const reacted = (Date.now() - proposedAt) / 1000;
    const after = await read(state, C.openWindow, "pending_upgrade");
    const window = Number(pending.eta) - (await ledgerTime());
    console.log(`  proposal ${explorer(proposed.hash)}; cancelled ${reacted.toFixed(0)} s after it, ${window} s before it could apply`);
    record("privileged", "Elev.2", "unannounced upgrade proposed with the governor keys", fired, `${done.join(", ") || "none"} after ${reacted.toFixed(0)} s, ${window} s of the delay left`, !after && early?.name === "TimelockPending");
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
    const after = await read(state, C.openWindow, "pending_admin");
    const governor = await read(state, C.openWindow, "admin");
    const window = Number(pending.eta) - (await ledgerTime());
    record("privileged", "Elev.2", "governor handover proposed with the governor keys", fired, `${done.join(", ") || "none"} after ${((Date.now() - proposedAt) / 1000).toFixed(0)} s, ${window} s of the delay left`, !after && governor === pub("governor") && early?.name === "TimelockPending");
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
      const left = await read(state, C.openWindow, "pending_forced_guardian_change");
      const guardian1 = await read(state, C.openWindow, "guardian");
      console.log(`  proposal ${explorer(proposed.hash)}; ${done.join(", ") || "no action"} after ${reacted.toFixed(0)} s`);
      record("privileged", "Elev.2", "forced guardian change proposed with the governor and trustee keys", fired, `${done.join(", ") || "none"} after ${reacted.toFixed(0)} s, 30 days before it could apply`, !left && guardian1 === guardian0);
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
    console.log("\n15. Keeper float (DoS.2): the rent-paying account falls below a month of rent");
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
      const token = C.backupFeed ?? C.navOracle; // any contract address stands for an unknown token: it is never registered
      const proposed = await invoke(state, "governor", C.openWindow, "set_stablecoin", [sv.address(token), sv.symbol("XXX")]);
      const { s, alerts } = await pass(monitor);
      const fired = alerts.some((a) => a.level === "critical" && /stablecoin registration proposed/.test(a.message));
      const done = await act(alerts, s, monitor);
      const left = await read(state, C.openWindow, "pending_stablecoin_change", [sv.address(token)]);
      console.log(`  proposal ${explorer(proposed.hash)}; ${done.join(", ") || "no action"}`);
      record("privileged", "Elev.2", "unannounced stablecoin registration proposed with the governor keys", fired, `${done.join(", ") || "none"} by ${actorRole(s)}`, !left);
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

  const file = path.join(STATE_DIR, `rehearsal-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(file, JSON.stringify(results, null, 2));
  console.log(`\nRehearsal written to ${path.relative(process.cwd(), file)}`);
  console.log("\n| Detector | Threat | Trigger | Fired | Action | Restored |\n|---|---|---|---|---|---|");
  for (const r of results) console.log(`| ${r.detector} | ${r.threat} | ${r.trigger} | ${r.fired ? "yes" : "no"} | ${r.action} | ${r.restored ? "yes" : "no"} |`);
}

async function main() {
  if (REHEARSE) return rehearse();
  const monitor = loadMonitor();
  // An upgrade announced in advance is reported as a warning, not cancelled.
  const announce = args.find((a) => a.startsWith("--announce="))?.slice(11);
  if (announce) {
    monitor.announced = [...new Set([...(monitor.announced ?? []), announce.toLowerCase()])];
    saveMonitor(monitor);
    console.log(`Upgrade ${announce} recorded as announced.`);
    return;
  }
  const announceToken = args.find((a) => a.startsWith("--announce-stablecoin="))?.slice(22);
  if (announceToken) {
    monitor.announcedStablecoins = [...new Set([...(monitor.announcedStablecoins ?? []), announceToken])];
    saveMonitor(monitor);
    console.log(`Stablecoin ${announceToken} recorded as announced.`);
    return;
  }
  if (RPC_URLS.length === 1) console.log("single RPC endpoint, no cross-check (set STELLAR_RPC_URLS to compare two)");
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
