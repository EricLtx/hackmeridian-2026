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

import fs from "node:fs";
import path from "node:path";
import {
  ONE,
  STATE_DIR,
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
import { navAt } from "./config.mjs";

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
const MONITOR_FILE = path.join(STATE_DIR, "monitor.json");
const ALERT_FILE = path.join(STATE_DIR, "alerts.jsonl");

/** Privileged changes: every one of them is reported (Elev.2). */
const PRIVILEGED = new Set([
  "admin_changed", "admin_proposed", "guardian_changed", "envelope_changed", "fund_set", "fund_removed",
  "stablecoin_set", "stablecoin_removed", "currency_cap_set", "max_term_changed", "fund_limits_set",
  "lender_approval", "fund_frozen", "sponsor_set",
]);

const state = loadState();
const C = state.contracts;
if (!C?.openWindow) {
  console.error("No deployment found: run `npm run setup` first.");
  process.exit(1);
}

function loadMonitor() {
  try {
    return JSON.parse(fs.readFileSync(MONITOR_FILE, "utf8"));
  } catch {
    return {};
  }
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
  const liveOffers = offers.filter((o) => BigInt(o.available) > 0n);
  const keyed = [
    ["contract instance", storageKey(C.openWindow)],
    ["fund config", storageKey(C.openWindow, sv.variant("Fund", fund))],
    ["fund state", storageKey(C.openWindow, sv.variant("FundState", fund))],
    ...openRepos.map((r) => [`repo #${r.id}`, storageKey(C.openWindow, sv.variant("Repo", sv.u64(r.id)))]),
    ...liveOffers.map((o) => [`offer #${o.id}`, storageKey(C.openWindow, sv.variant("Offer", sv.u64(o.id)))]),
  ];
  const ledger = await ledgerEntries(keyed.map(([, k]) => k));
  const ttl = keyed.map(([label, key], i) => ({
    label,
    key,
    days: ledger.entries[i] ? ((ledger.entries[i].liveUntil - ledger.latest) * LEDGER_SECS) / 86_400 : null,
  }));
  const instance = ledger.entries[0]?.value?.contractData?.val?.instance;
  const rawHash = instance?.executable?.wasmHash;
  const wasmHash = rawHash ? (typeof rawHash.toXDR === "function" ? rawHash.toXDR("hex") : Buffer.from(rawHash).toString("hex")) : null;

  const from = Math.max(monitor.cursor ?? ledger.latest - 720, ledger.latest - 17_000);
  const events = await contractEvents(C.openWindow, from);
  return { now, latest: ledger.latest, from, config, fundState, paused, nav, repos, openRepos, held, outstanding, cap, currency, priceError, ttl, wasmHash, events };
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
    const locked = s.openRepos.reduce((sum, r) => sum + BigInt(r.shares), 0n);
    const held = BigInt(s.held);
    if (held === locked) return [];
    return [{ detector: "reconciliation", threat: "DoS.5", level: "critical", message: `contract holds ${fmt(held, 7, 7)} shares, open repos lock ${fmt(locked, 7, 7)}: ${held - locked} units apart (invariant I2)`, action: "pause" }];
  },
  privileged(s, monitor) {
    const out = s.events
      .filter((e) => PRIVILEGED.has(e.name))
      .map((e) => ({ level: "warning", message: `privileged change ${e.name} at ledger ${e.ledger}`, action: "verify", tx: e.txHash }));
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

/** The safe automatic actions: pause on a critical price or reconciliation alert, extend TTLs. */
async function act(alerts, s) {
  const done = [];
  if (!s.paused && alerts.some((a) => a.level === "critical" && a.action === "pause")) {
    const r = await invoke(state, "guardian", C.openWindow, "pause", [sv.address(keypair(state, "guardian").publicKey())]);
    console.log(`  ACTION   guardian paused new entries in ${r.seconds.toFixed(1)} s  ${explorer(r.hash)}`);
    done.push("pause");
  }
  const keys = alerts.filter((a) => a.action === "extend" && a.key).map((a) => a.key);
  if (keys.length) {
    const r = await extendTtl(state, "guardian", keys, 2_419_200); // about 140 days
    console.log(`  ACTION   extended ${keys.length} entries to about 140 days in ${r.seconds.toFixed(1)} s  ${explorer(r.hash)}`);
    done.push("extend");
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
    console.log("\n3. Privileged change (Elev.2): the governor re-sets the guardian");
    await invoke(state, "governor", C.openWindow, "set_guardian", [sv.address(pub("guardian"))]);
    const { alerts } = await pass(monitor);
    const fired = alerts.some((a) => a.detector === "privileged" && /guardian_changed/.test(a.message));
    record("privileged", "Elev.2", "set_guardian by the governor", fired, "second signer verifies (manual)", true);
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
    await invoke(state, "steward", C.openWindow, "set_fund_limits", [fund, sv.u32(config.haircut_bps), sv.i128(config.max_principal_per_repo), sv.i128(config.max_outstanding)]);
    const after = await clean();
    record("exposure", "DoS.1", "fund cap lowered to 90 % utilisation", fired, "limits reviewed and restored", !after.some((a) => a.detector === "exposure"));
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
    const done = await act(alerts, s);
    const after = await clean();
    LIMITS.ttlDays = saved;
    record("ttl", "DoS.2", "threshold forced to 130 days", fired, done.join(", ") || "none", !firedBy(after, "ttl"));
  }

  if (runStep(7)) {
    console.log("\n7. Events (Repud.1): no real trigger exists; the contract emits an event on every repo");
    const { alerts } = await pass(monitor);
    record("events", "Repud.1", "none possible: checked that every recent repo has its event", false, "none", !firedBy(alerts, "events"));
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
