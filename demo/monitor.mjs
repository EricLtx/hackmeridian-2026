// Monitoring for Open Window on testnet: the detectors of the monitoring plan
// in docs/modele-menace-stride.md, section 3.1.
//
//   npm run monitor                  one pass, prints alerts
//   npm run monitor -- --watch       a pass every 30 s
//   npm run monitor -- --watch --act takes the safe actions itself:
//                                    pause on a critical alert, extend TTLs
//   npm run monitor -- --rehearse    fires each detector with a real trigger
//                                    on testnet, takes the action, restores
//
// A detector never moves funds. The only actions are the guardian's pause,
// which blocks new entries and never exits, and a TTL extension, which
// anyone may pay for. Unpausing stays a human decision for the governor.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  ONE,
  STATE_DIR,
  WASM_DIR,
  codeKey,
  asset,
  contractEvents,
  explorer,
  extendTtl,
  fmt,
  invoke,
  keypair,
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

const args = process.argv.slice(2);
const WATCH = args.includes("--watch");
const ACT = args.includes("--act");
const REHEARSE = args.includes("--rehearse");
/** Rehearsal steps to run, e.g. --steps=4,5,6,7; all by default. */
const STEPS = args.find((a) => a.startsWith("--steps="))?.slice(8).split(",").map(Number);
const runStep = (n) => !STEPS || STEPS.includes(n);

/** Thresholds of the monitoring plan. */
const LIMITS = {
  ttlDays: 14, // an open entry with less time to live is extended
  navWarnHours: 24, // warn two hours before the contract refuses a 26-hour-old NAV
  capWarnRatio: 0.8, // warn when outstanding passes 80 % of a cap
  opensPerHour: 20, // an unusual rate of new repos
};
const LEDGER_SECS = 5;
/** Largest extension of the code entry in one transaction, in days. */
const CODE_STEP_DAYS = 30;
const MONITOR_FILE = path.join(STATE_DIR, "monitor.json");
const ALERT_FILE = path.join(STATE_DIR, "alerts.jsonl");

/** Privileged changes: every one of them is reported (Elev.2). */
const PRIVILEGED = new Set([
  "admin_changed", "admin_proposed", "guardian_changed", "envelope_changed", "fund_set", "fund_removed",
  "stablecoin_set", "stablecoin_removed", "currency_cap_set", "max_term_changed", "fund_limits_set",
  "lender_approval", "fund_frozen", "sponsor_set", "timelock_delay_changed", "fund_change_cancelled",
  "fallback_set", "fallback_cancelled", "fallback_removed", "upgrade_cancelled", "upgraded",
]);
/** Proposals that take effect after the time delay: the window to verify and cancel (Elev.2). */
const PROPOSALS = /_proposed$|_change_proposed$/;

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

const statusOf = (repo) => (Array.isArray(repo.status) ? repo.status[0] : repo.status);
const hex = (bytes) => (bytes ? Buffer.from(bytes).toString("hex") : "");

async function snapshot(monitor) {
  const now = await ledgerTime();
  const fund = sv.address(C.shares);
  const [config, fundState, paused, nav, repos, offers, held] = await Promise.all([
    read(state, C.openWindow, "get_fund", [fund]),
    read(state, C.openWindow, "get_fund_state", [fund]),
    read(state, C.openWindow, "is_paused"),
    read(state, C.navOracle, "lastprice", [asset.stellar(C.shares)]),
    scan("get_repo"),
    scan("get_offer"),
    read(state, C.shares, "balance", [sv.address(C.openWindow)]),
  ]);
  const currency = String(fundState.currency);
  const [outstanding, cap] = await Promise.all([
    read(state, C.openWindow, "currency_outstanding", [sv.symbol(currency)]),
    read(state, C.openWindow, "currency_cap", [sv.symbol(currency)]),
  ]);
  const priceError = await probe(state, "governor", C.openWindow, "quote", [fund, sv.i128(ONE), sv.address(C.euro)]);

  const openRepos = repos.filter((r) => statusOf(r) === "Open");
  const releases = [];
  for (const r of repos.filter((x) => statusOf(x) !== "Open")) {
    const pending = await read(state, C.openWindow, "pending_release", [sv.u64(r.id)]);
    if (pending) releases.push({ id: r.id, ...pending });
  }
  const liveOffers = offers.filter((o) => BigInt(o.available) > 0n);
  const keyed = [
    ["contract instance", storageKey(C.openWindow)],
    ["fund config", storageKey(C.openWindow, sv.variant("Fund", fund))],
    ["fund state", storageKey(C.openWindow, sv.variant("FundState", fund))],
    ...openRepos.map((r) => [`repo #${r.id}`, storageKey(C.openWindow, sv.variant("Repo", sv.u64(r.id)))]),
    ...liveOffers.map((o) => [`offer #${o.id}`, storageKey(C.openWindow, sv.variant("Offer", sv.u64(o.id)))]),
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
  return { now, latest: ledger.latest, from, config, fundState, paused, nav, repos, openRepos, releases, held, outstanding, cap, currency, priceError, ttl, wasmHash, events };
}

/** The detectors. Each returns alerts: { detector, threat, level, message, action }. */
const DETECTORS = {
  price(s) {
    const out = [];
    if (s.priceError && ["PriceOutOfBand", "StalePrice", "NoPrice", "InvalidPrice"].includes(s.priceError.name)) {
      out.push({ level: "critical", message: `the contract refuses the fund price: ${s.priceError.name}`, action: "pause" });
    }
    const ageHours = s.nav ? (s.now - Number(s.nav.timestamp)) / 3600 : Infinity;
    if (ageHours >= LIMITS.navWarnHours) {
      out.push({ level: "warning", message: `NAV is ${ageHours.toFixed(1)} h old; the contract refuses it at ${Number(s.config.nav_max_age_secs) / 3600} h`, action: "republish" });
    }
    return out.map((a) => ({ detector: "price", threat: "Tamper.1", ...a }));
  },
  reconciliation(s) {
    // Invariant I2 (v3): shares held = shares of open repos + shares awaiting release.
    const locked = s.openRepos.reduce((sum, r) => sum + BigInt(r.shares), 0n);
    const awaiting = s.releases.reduce((sum, r) => sum + BigInt(r.shares), 0n);
    const held = BigInt(s.held);
    const out = s.releases.map((r) => ({
      detector: "reconciliation", threat: "DoS.5", level: "critical",
      message: `repo #${r.id}: ${fmt(r.shares, 7, 0)} shares held back, the share token refuses the transfer (issuer freeze or allowlist)`,
      action: "contact the issuer, then release",
    }));
    if (held !== locked + awaiting) {
      out.push({ detector: "reconciliation", threat: "DoS.5", level: "critical", message: `contract holds ${fmt(held, 7, 7)} shares, open repos and releases account for ${fmt(locked + awaiting, 7, 7)}: ${held - locked - awaiting} units apart (invariant I2)`, action: "pause" });
    }
    return out;
  },
  privileged(s, monitor) {
    const out = s.events
      .filter((e) => PRIVILEGED.has(e.name))
      .map((e) => ({ level: "warning", message: `privileged change ${e.name} at ledger ${e.ledger}`, action: "verify", tx: e.txHash }));
    for (const e of s.events.filter((ev) => PROPOSALS.test(ev.name))) {
      const isUpgrade = e.name === "upgrade_proposed";
      const hash = isUpgrade ? hex(e.data?.wasm_hash) : null;
      const announced = isUpgrade && (monitor.announced ?? []).includes(hash);
      out.push({
        level: isUpgrade && !announced ? "critical" : "warning",
        message: `${e.name} at ledger ${e.ledger}${hash ? `, code ${hash.slice(0, 12)}${announced ? " (announced)" : " (NOT announced)"}` : ""}; takes effect at ${e.data?.eta ? new Date(Number(e.data.eta) * 1000).toISOString().slice(11, 19) : "?"} UTC`,
        action: isUpgrade && !announced ? "cancel" : "verify before it applies",
        tx: e.txHash,
      });
    }
    if (monitor.wasmHash && s.wasmHash && monitor.wasmHash !== s.wasmHash) {
      out.push({ level: "critical", message: `contract code changed: ${monitor.wasmHash.slice(0, 12)} to ${s.wasmHash.slice(0, 12)}`, action: "verify" });
    }
    return out.map((a) => ({ detector: "privileged", threat: "Elev.2", ...a }));
  },
  pause(s) {
    const out = s.events
      .filter((e) => e.name === "pause_changed")
      .map((e) => ({ level: "warning", message: `pause set to ${JSON.stringify(e.data?.paused ?? e.data)} at ledger ${e.ledger}`, action: "verify", tx: e.txHash }));
    if (s.paused) out.push({ level: "warning", message: "new entries are paused", action: "governor decides when to unpause" });
    return out.map((a) => ({ detector: "pause", threat: "DoS.4", ...a }));
  },
  ttl(s) {
    return s.ttl
      .filter((t) => t.days === null || t.days < LIMITS.ttlDays)
      .map((t) => ({
        detector: "ttl",
        threat: "DoS.2",
        level: t.days === null ? "critical" : "warning",
        message: t.days === null ? `${t.label} is archived or missing` : `${t.label} has ${t.days.toFixed(1)} days to live`,
        action: "extend",
        key: t.key,
        kind: t.kind,
        days: t.days,
      }));
  },
  exposure(s) {
    const out = [];
    const ratio = (a, b) => (BigInt(b) > 0n ? Number((BigInt(a) * 1000n) / BigInt(b)) / 1000 : 0);
    const fundRatio = ratio(s.fundState.outstanding, s.config.max_outstanding);
    if (fundRatio >= LIMITS.capWarnRatio) out.push({ level: "warning", message: `fund outstanding at ${(fundRatio * 100).toFixed(0)} % of its cap`, action: "review limits" });
    const currencyRatio = ratio(s.outstanding, s.cap);
    if (currencyRatio >= LIMITS.capWarnRatio) out.push({ level: "warning", message: `${s.currency} outstanding at ${(currencyRatio * 100).toFixed(0)} % of its cap`, action: "review limits" });
    const hours = Math.max(((s.latest - s.from) * LEDGER_SECS) / 3600, 1 / 60);
    const opens = s.events.filter((e) => e.name === "repo_opened").length;
    if (opens / hours > LIMITS.opensPerHour) out.push({ level: "warning", message: `${opens} repos opened in ${(hours * 60).toFixed(0)} min`, action: "pause if unexplained" });
    return out.map((a) => ({ detector: "exposure", threat: "DoS.1", ...a }));
  },
  events(s) {
    // Every repo opened inside the event window must have its repo_opened event (Repud.1).
    const seen = new Set(s.events.filter((e) => e.name === "repo_opened").map((e) => Number(e.topics[0])));
    const windowStart = s.now - (s.latest - s.from) * LEDGER_SECS;
    return s.repos
      .filter((r) => Number(r.opened_at) > windowStart + 60 && !seen.has(r.id))
      .map((r) => ({ detector: "events", threat: "Repud.1", level: "warning", message: `repo #${r.id} has no repo_opened event`, action: "investigate" }));
  },
};

async function pass(monitor, { quiet = false } = {}) {
  const s = await snapshot(monitor);
  const alerts = Object.entries(DETECTORS).flatMap(([, detect]) => detect(s, monitor));
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
  console.log(`\n[${stamp} UTC] ledger ${s.latest}: ${s.openRepos.length} open repos, ${s.events.length} events since ${s.from}, entries ${s.paused ? "paused" : "open"}`);
  if (!alerts.length) console.log("  no alert");
  for (const a of alerts) console.log(`  ${a.level.toUpperCase().padEnd(8)} ${a.threat.padEnd(9)} ${a.message}  (action: ${a.action})`);
}

/** The safe automatic actions: pause on a critical alert, cancel an unannounced upgrade, extend TTLs. */
async function act(alerts, s) {
  const done = [];
  if (alerts.some((a) => a.action === "cancel")) {
    const pending = await read(state, C.openWindow, "pending_upgrade");
    if (pending) {
      const r = await invoke(state, "guardian", C.openWindow, "cancel_upgrade", [sv.address(keypair(state, "guardian").publicKey())]);
      console.log(`  ACTION   guardian cancelled the upgrade proposal in ${r.seconds.toFixed(1)} s  ${explorer(r.hash)}`);
      done.push("cancel upgrade");
    }
  }
  if (!s.paused && alerts.some((a) => a.level === "critical" && a.action === "pause")) {
    const r = await invoke(state, "guardian", C.openWindow, "pause", [sv.address(keypair(state, "guardian").publicKey())]);
    console.log(`  ACTION   guardian paused new entries in ${r.seconds.toFixed(1)} s  ${explorer(r.hash)}`);
    done.push("pause");
  }
  const extend = alerts.filter((a) => a.action === "extend" && a.key);
  const small = extend.filter((a) => a.kind !== "code").map((a) => a.key);
  if (small.length) {
    const r = await extendTtl(state, "operator", small, 2_419_200); // about 140 days
    console.log(`  ACTION   extended ${small.length} entries to about 140 days in ${r.seconds.toFixed(1)} s  ${explorer(r.hash)}`);
    done.push("extend");
  }
  // The code entry is large: extend it by 30 days at most per transaction, so
  // its rent stays well under the largest fee a transaction may carry.
  for (const a of extend.filter((x) => x.kind === "code")) {
    const target = Math.min(Math.max(a.days ?? 0, 0) + CODE_STEP_DAYS, 120);
    const r = await extendTtl(state, "operator", [a.key], Math.floor(target * 17_280));
    const fee = r.fee === null ? "" : `, fee ${(Number(r.fee) / 1e7).toFixed(2)} XLM`;
    console.log(`  ACTION   extended the contract code to about ${target.toFixed(0)} days in ${r.seconds.toFixed(1)} s${fee}  ${explorer(r.hash)}`);
    done.push("extend code");
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
    console.log("\n2. Reconciliation (DoS.5): the issuer claws back one share unit from the contract");
    await invoke(state, "steward", C.shares, "clawback", [sv.address(C.openWindow), sv.i128(1n)]);
    const { s, alerts } = await pass(monitor);
    const fired = firedBy(alerts, "reconciliation");
    const done = await act(alerts, s);
    await invoke(state, "steward", C.shares, "mint", [sv.address(C.openWindow), sv.i128(1n)]);
    await invoke(state, "governor", C.openWindow, "unpause", []);
    const after = await clean();
    record("reconciliation", "DoS.5", "issuer clawback of 1 unit", fired, done.join(", ") || "none", !firedBy(after, "reconciliation"));
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
    // The forced threshold would also flag the code entry; its rent is real
    // money, so the drill extends the small entries and leaves the code to
    // its normal 14-day rule.
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
    const proposed = await invoke(state, "governor", C.openWindow, "propose_upgrade", [sv.bytes(hostile)]);
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
  // An upgrade announced in advance is reported as a warning, not cancelled.
  const announce = args.find((a) => a.startsWith("--announce="))?.slice(11);
  if (announce) {
    monitor.announced = [...new Set([...(monitor.announced ?? []), announce.toLowerCase()])];
    saveMonitor(monitor);
    console.log(`Upgrade ${announce} recorded as announced.`);
    return;
  }
  for (;;) {
    const { s, alerts } = await pass(monitor);
    if (ACT) await act(alerts, s);
    saveMonitor(monitor);
    if (!WATCH) return;
    await sleep(30_000);
  }
}

main().catch((error) => {
  console.error(`\nMonitor stopped: ${error.message}`);
  process.exit(1);
});
