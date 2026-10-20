// The monitor's detectors and its choice of actions, on hand-made snapshots:
// no network, no key. Each test names the rule it holds.

import assert from "node:assert/strict";
import { test } from "node:test";

import { DETECTORS, LIMITS, decideActions, detect, factsNeeded } from "../detectors.mjs";

const H = 3600;
const DAY = 86_400;
/** Wednesday 13 January 2027, 12:00 UTC: a business day. */
const NOW = Date.UTC(2027, 0, 13, 12) / 1000;

const ctx = (limits = {}) => ({ limits: { ...LIMITS, ...limits }, journalPending: new Map() });

function fund(label, shares, over = {}) {
  return {
    label,
    shares,
    navOracle: `N-${shares}`,
    stablecoin: "CEUR",
    config: { nav_max_age_secs: 26n * 3600n, max_outstanding: 1_000_000n, haircut_bps: 200 },
    fundState: { reference_time: BigInt(NOW - H), outstanding: 0n, currency: "EUR" },
    nav: { price: 108_000_000n, timestamp: BigInt(NOW - 60) },
    held: 0n,
    stewardBackup: "GBACKUP",
    priceError: null,
    fxLeg: null,
    fx: null,
    currency: "EUR",
    ...over,
  };
}

function snap(over = {}) {
  return {
    now: NOW,
    latest: 10_000,
    from: 9_990,
    funds: [fund("fund 1", "CF1")],
    caps: {},
    paused: false,
    repos: [],
    openRepos: [],
    releases: [],
    ttl: [],
    wasmHash: null,
    events: [],
    keeperRole: "keeper",
    keeperXlm: 1_000,
    rpcHeights: null,
    journal: null,
    schemaVersion: 2,
    sentinel: null,
    ...over,
  };
}

const run = (name, s, monitor = {}, c = ctx()) => DETECTORS[name](s, monitor, c);
const repo = (id, fundId, shares, over = {}) => ({ id, fund: fundId, shares: BigInt(shares), status: ["Open"], opened_at: BigInt(NOW - DAY), lender: "GLENDER", ...over });

test("price: an Open Window refusal of the fund price is critical and pauses", () => {
  const s = snap({ funds: [fund("fund 1", "CF1", { priceError: { name: "PriceOutOfBand" } })] });
  const [alert] = run("price", s);
  assert.equal(alert.level, "critical");
  assert.equal(alert.action, "pause");
  assert.match(alert.message, /refuses the fund price: PriceOutOfBand$/);
});

test("price: the NAV age warns two hours before the fund's own bound, at most at 24 h", () => {
  const at = (ageHours, boundHours) => run("price", snap({ funds: [fund("fund 1", "CF1", { nav: { price: 1n, timestamp: BigInt(NOW - ageHours * H) }, config: { nav_max_age_secs: BigInt(boundHours * H), max_outstanding: 1n } })] }));
  assert.equal(at(23.9, 26).length, 0);
  assert.equal(at(24, 26)[0].action, "republish");
  assert.equal(at(23.9, 64).length, 0);
  assert.equal(at(24, 64).length, 1);
  assert.equal(at(7.9, 10).length, 0);
  assert.equal(at(8, 10).length, 1);
});

test("funds: a removed fund raises fund_removed, and the other funds are still checked", () => {
  const removed = fund("fund 1", "CF1", { config: null, removed: true, stewardBackup: undefined, nav: undefined, priceError: undefined });
  const other = fund("fund 2", "CF2", { priceError: { name: "StalePrice" } });
  const alerts = detect(snap({ funds: [removed, other], openRepos: [repo(1, "CF1", 5)] }), {}, ctx());
  const [gone] = alerts.filter((a) => a.detector === "funds");
  assert.equal(gone.level, "critical");
  assert.match(gone.message, /^fund_removed: .*1 repo\(s\) still open \[fund 1\]$/);
  assert.ok(alerts.some((a) => a.detector === "price" && /StalePrice \[fund 2\]$/.test(a.message)));
});

test("funds: one fund's failing read is that fund's critical alert, and nothing else breaks", () => {
  const broken = fund("fund 1", "CF1", { nav: undefined, errors: { lastprice: "HostError: Error(WasmVm, InvalidAction)" } });
  const alerts = detect(snap({ funds: [broken, fund("fund 2", "CF2")] }), {}, ctx());
  assert.deepEqual(alerts.map((a) => [a.detector, a.level]), [["funds", "critical"]]);
  assert.match(alerts[0].message, /^fund unreadable: lastprice failed \(HostError.*\) \[fund 1\]$/);
  // A fund whose settings could not be read at all is skipped by the others.
  const blind = fund("fund 1", "CF1", { config: undefined, fundState: undefined, held: undefined, nav: undefined, errors: { get_fund: "timeout" } });
  assert.deepEqual(detect(snap({ funds: [blind] }), {}, ctx()).map((a) => a.detector), ["funds"]);
});

test("price: a feed failing inside the valuation pauses like a refusal; another code alerts without pausing", () => {
  const first = (name) => run("price", snap({ funds: [fund("fund 1", "CF1", { priceError: { name } })] }))[0];
  for (const name of ["nav-oracle:InvalidPrice", "unknown:Error", "HostError", "PriceDivergence"]) {
    assert.deepEqual([first(name).level, first(name).action], ["critical", "pause"], name);
  }
  const other = first("StablecoinNotAccepted");
  assert.equal(other.level, "critical");
  assert.notEqual(other.action, "pause");
});

test("reference-age: quiet at the bound, a refresh beyond it when the NAV is newer", () => {
  const f = (label, shares, refAge, navAge) => fund(label, shares, {
    fundState: { reference_time: BigInt(NOW - refAge), outstanding: 0n, currency: "EUR" },
    nav: navAge === null ? null : { price: 1n, timestamp: BigInt(NOW - navAge) },
  });
  let out = run("reference-age", snap({ funds: [f("fund 1", "CF1", 26 * H, 60), f("fund 2", "CF2", 26 * H + 1, 60)] }));
  assert.equal(out.length, 1);
  assert.deepEqual([out[0].threat, out[0].level, out[0].action, out[0].fund], ["Tamper.7", "warning", "refresh_reference", "CF2"]);
  assert.match(out[0].message, /\[fund 2\]$/);
  out = run("reference-age", snap({ funds: [f("fund 1", "CF1", 30 * DAY, 31 * DAY)] }));
  assert.notEqual(out[0].action, "refresh_reference");
  assert.doesNotMatch(out[0].message, /\[fund/);
  out = run("reference-age", snap({ funds: [f("fund 1", "CF1", 30 * DAY, null)] }));
  assert.notEqual(out[0].action, "refresh_reference");
});

test("reconciliation: a balanced fund raises nothing", () => {
  const s = snap({ funds: [fund("fund 1", "CF1", { held: 30n })], openRepos: [repo(1, "CF1", 20)], releases: [{ id: 2, fund: "CF1", to: "GB", shares: 10n }], repos: [repo(1, "CF1", 20), repo(2, "CF1", 10, { status: ["Repurchased"] })] });
  assert.deepEqual(run("reconciliation", s).filter((a) => /units apart/.test(a.message)), []);
});

test("reconciliation: a share deficit is critical and pauses; a surplus is a warning with its size (econ-4)", () => {
  const at = (held) => run("reconciliation", snap({ funds: [fund("fund 1", "CF1", { held })], openRepos: [repo(1, "CF1", 20)] }));
  const [short] = at(19n);
  assert.deepEqual([short.level, short.action, short.fund], ["critical", "pause", "CF1"]);
  assert.match(short.message, /: 1 units apart, shares missing \(invariant I2\)$/);
  // One donated unit, or shares paid in kind: no function can move them out.
  const [surplus] = at(21n);
  assert.equal(surplus.level, "warning");
  assert.notEqual(surplus.action, "pause");
  assert.match(surplus.message, /: 1 units apart, a surplus no function can move out/);
  assert.deepEqual(at(20n), []);
  const pause = decideActions([surplus], snap(), {}, { actor: "sentinel" }).actions;
  assert.deepEqual(pause, []);
  // A surplus lasts: warned when it appears or changes size, not every pass.
  const monitor = {};
  const pass = (held) => run("reconciliation", snap({ funds: [fund("fund 1", "CF1", { held })], openRepos: [repo(1, "CF1", 20)] }), monitor);
  assert.equal(pass(21n).length, 1);
  assert.equal(pass(21n).length, 0);
  assert.equal(pass(22n).length, 1);
  assert.equal(pass(20n).length, 0);
  assert.equal(pass(21n).length, 1);
});

test("reconciliation: a stablecoin short of its offers is critical; a surplus is a warning (I1)", () => {
  const coin = (held, owed) => run("reconciliation", snap({ stablecoins: [{ token: "CEUR", label: "tEUR", held, owed }] }));
  const [short] = coin(99n, 100n);
  assert.deepEqual([short.level, short.action, short.threat], ["critical", "pause", "DoS.8"]);
  assert.match(short.message, /^tEUR: .*1 units short \(invariant I1\)$/);
  const [extra] = coin(101n, 100n);
  assert.equal(extra.level, "warning");
  assert.deepEqual(coin(100n, 100n), []);
  assert.equal(run("reconciliation", snap({ stablecoins: [{ token: "CX", label: "CX…", owed: 0n, error: "no such function" }] }))[0].level, "warning");
});

test("reconciliation: a waiting delivery warns once per reason, then stays silent until it changes (release keeper)", () => {
  const monitor = {};
  const at = (position) => run("reconciliation", snap({ funds: [fund("fund 1", "CF1", { held: 10n })], releases: [{ id: 4, fund: "CF1", to: "GBORROWER", shares: 10n, ...position }] }), monitor);
  // The token refuses: one warning, then nothing while nothing changes.
  let out = at({ status: "Repurchased", deliverable: false });
  assert.deepEqual(out.map((a) => a.level), ["warning"]);
  assert.match(out[0].message, /held back, the share token refuses the transfer/);
  assert.deepEqual(at({ status: "Repurchased", deliverable: false }), []);
  // A seized position whose lender is no longer approved names that reason (rc5).
  out = at({ status: "Defaulted", deliverable: false, approved: false, to: "GLENDER" });
  assert.match(out[0].message, /seized for a lender not approved for the fund/);
  assert.equal(out[0].threat, "DoS.7");
  assert.deepEqual(at({ status: "Defaulted", deliverable: false, approved: false, to: "GLENDER" }), []);
  // Deliverable: listed every pass until released, with the keeper's action.
  for (let pass = 0; pass < 2; pass += 1) {
    out = at({ status: "Defaulted", deliverable: true, approved: true, to: "GLENDER" });
    assert.deepEqual([out[0].action, out[0].repoId], ["release", 4]);
  }
  const { actions } = decideActions(out, snap(), {}, {});
  assert.deepEqual(actions, [{ kind: "release", repoId: 4 }]);
  // Delivered: forgotten, so a new deferral of the same id warns again.
  run("reconciliation", snap({ releases: [] }), monitor);
  assert.deepEqual(monitor.releaseSeen, {});
});

test("journal: an RPC event the journal covers but lacks warns; one it does not cover yet waits", () => {
  const c = ctx();
  const events = [{ name: "repo_opened", ledger: 100, txHash: "aa", id: "e1" }, { name: "repo_opened", ledger: 120, txHash: "cc", id: "e3" }, { name: "pause_changed", ledger: 200, txHash: "bb", id: "e2" }];
  const out = run("journal", snap({ events, journal: { lastLedger: 150, seen: new Set(["cc:e3"]) } }), {}, c);
  assert.deepEqual(out.map((a) => a.message), ["event repo_opened at ledger 100 missing from the indexer journal"]);
  assert.deepEqual([...c.journalPending.keys()], ["bb:e2"]);
});

test("privileged: every privileged event is reported; handovers, recoveries and forced changes are critical", () => {
  const events = [
    { name: "fund_removed", ledger: 1, txHash: "t1" },
    { name: "steward_recovery_proposed", ledger: 2, txHash: "t2" },
    { name: "admin_proposed", ledger: 3, txHash: "t3" },
    { name: "guardian_change_forced", ledger: 4, txHash: "t4", data: { eta: BigInt(NOW + 30 * DAY) } },
    { name: "repo_opened", ledger: 5, txHash: "t5", topics: [1n] },
  ];
  const out = run("privileged", snap({ events }));
  assert.deepEqual(out.map((a) => [a.level, a.action.slice(0, 12)]), [
    ["warning", "verify"],
    ["critical", "tell the iss"],
    ["critical", "verify with "],
    ["critical", "veto_forced"],
    // Every *_proposed event is also listed as a proposal to verify before it applies.
    ["warning", "verify befor"],
    ["warning", "verify befor"],
  ]);
  assert.match(out[2].action, /veto_admin/);
});

test("privileged: an unannounced upgrade is cancelled, an announced one is a warning", () => {
  const hash = Buffer.alloc(32, 7);
  const events = [{ name: "upgrade_proposed", ledger: 9, txHash: "t", data: { wasm_hash: hash, eta: BigInt(NOW + 300) } }];
  let [alert] = run("privileged", snap({ events }));
  assert.deepEqual([alert.level, alert.action], ["critical", "cancel"]);
  assert.match(alert.message, /NOT announced/);
  [alert] = run("privileged", snap({ events }), { announced: [hash.toString("hex")] });
  assert.deepEqual([alert.level, alert.action], ["warning", "verify before it applies"]);
});

test("privileged: an unannounced stablecoin registration is cancelled, an announced one is a warning", () => {
  const events = [{ name: "stablecoin_change_proposed", ledger: 9, txHash: "t", topics: ["CTOKEN"], data: { currency: "EUR" } }];
  let [alert] = run("privileged", snap({ events }));
  assert.deepEqual([alert.level, alert.action, alert.token], ["critical", "cancel stablecoin", "CTOKEN"]);
  [alert] = run("privileged", snap({ events }), { announcedStablecoins: ["CTOKEN"] });
  assert.deepEqual([alert.level, alert.action], ["warning", "verify before it applies"]);
});

test("privileged: a code change and a steward without backup are reported", () => {
  const out = run("privileged", snap({ wasmHash: "bb".repeat(32), funds: [fund("fund 1", "CF1", { stewardBackup: null })] }), { wasmHash: "aa".repeat(32) });
  assert.deepEqual(out.map((a) => a.level).sort(), ["critical", "warning"]);
});

test("pause: a pause event and a paused instance are reported", () => {
  const out = run("pause", snap({ paused: true, events: [{ name: "pause_changed", ledger: 3, data: { paused: true } }] }));
  assert.equal(out.length, 2);
  assert.match(out[1].message, /are paused/);
});

test("ttl: 14 days for the entries, 90 for the code; a missing entry is critical", () => {
  const t = (label, days, kind) => ({ label, key: label, kind, days });
  let out = run("ttl", snap({ ttl: [t("repo #1", 13.9), t("repo #2", 14.1), t("contract code", 89.9, "code"), t("contract instance", 89.9), t("gone", null)] }));
  assert.deepEqual(out.map((a) => [a.message, a.level]), [
    ["repo #1 has 13.9 days to live", "warning"],
    ["contract code has 89.9 days to live", "warning"],
    ["gone is archived or missing", "critical"],
  ]);
  assert.equal(run("ttl", snap({ ttl: [t("contract code", 90.1, "code")] })).length, 0);
  // Drill 6 forces the entries' threshold; the code keeps its own.
  out = run("ttl", snap({ ttl: [t("repo #1", 100), t("contract code", 100, "code")] }), {}, ctx({ ttlDays: 130 }));
  assert.deepEqual(out.map((a) => a.kind), [undefined]);
});

test("exposure: a fund or a currency past 80 % of its cap warns", () => {
  const s = snap({
    funds: [fund("fund 1", "CF1", { fundState: { reference_time: BigInt(NOW), outstanding: 800n, currency: "EUR" }, config: { nav_max_age_secs: 26n * 3600n, max_outstanding: 1000n } })],
    caps: { EUR: { outstanding: 799n, cap: 1000n } },
  });
  const out = run("exposure", s);
  assert.deepEqual(out.map((a) => a.message), ["fund outstanding at 80 % of its cap"]);
});

test("fx and nav: a value unchanged past the threshold warns, a move resets it", () => {
  const monitor = {};
  const withFx = (price, at) => snap({ now: at, funds: [fund("fund 1", "CF1", { fx: { price, timestamp: BigInt(at - 60) }, nav: { price, timestamp: BigInt(at - 60) } })] });
  assert.equal(run("fx", withFx(5n, NOW), monitor).length, 0);
  assert.equal(run("nav", withFx(5n, NOW), monitor).length, 0);
  assert.equal(run("fx", withFx(5n, NOW + 61 * H), monitor).length, 1);
  assert.equal(run("nav", withFx(5n, NOW + 61 * H), monitor).length, 0);
  assert.equal(run("nav", withFx(5n, NOW + 73 * H), monitor).length, 1);
  assert.equal(run("fx", withFx(6n, NOW + 74 * H), monitor).length, 0);
  assert.equal(run("nav", withFx(6n, NOW + 74 * H), monitor).length, 0);
});

test("keeper: a float below the threshold warns; an unreadable keeper warns", () => {
  assert.equal(run("keeper", snap({ keeperXlm: LIMITS.keeperMinXlm })).length, 0);
  assert.equal(run("keeper", snap({ keeperXlm: LIMITS.keeperMinXlm - 0.1 })).length, 1);
  assert.match(run("keeper", snap({ keeperXlm: null }))[0].message, /not readable/);
});

test("events: a repo opened in the window without its repo_opened event warns", () => {
  const s = snap({ from: 9_000, repos: [repo(1, "CF1", 1, { opened_at: BigInt(NOW - 10) }), repo(2, "CF1", 1, { opened_at: BigInt(NOW - 10) }), repo(3, "CF1", 1, { opened_at: BigInt(NOW - DAY) })], events: [{ name: "repo_opened", topics: [2n] }] });
  assert.deepEqual(run("events", s).map((a) => a.message), ["repo #1 has no repo_opened event"]);
});

test("rpc: a silent endpoint and heads too far apart warn", () => {
  const s = snap({ rpcHeights: [{ url: "a", sequence: 100 }, { url: "b", sequence: 111 }, { url: "c", error: "timeout" }] });
  assert.equal(run("rpc", s).length, 2);
  assert.equal(run("rpc", snap({ rpcHeights: [{ url: "a", sequence: 100 }, { url: "b", sequence: 110 }] })).length, 0);
});

test("schema: a stored layout behind the code is critical", () => {
  assert.equal(run("schema", snap({ schemaVersion: 1 }))[0].level, "critical");
  assert.equal(run("schema", snap({ schemaVersion: null })).length, 0);
});

test("detect runs every detector and tags each alert with its detector", () => {
  const alerts = detect(snap({ schemaVersion: 1, paused: true }), {}, ctx());
  assert.deepEqual([...new Set(alerts.map((a) => a.detector))].sort(), ["pause", "schema"]);
});

test("decideActions: cancellation and extensions follow the alerts, in order", () => {
  const alerts = [
    { level: "critical", action: "cancel" },
    { level: "critical", action: "cancel stablecoin", token: "CTOKEN" },
    { level: "warning", action: "extend", key: "k1", kind: undefined, days: 3 },
    { level: "warning", action: "extend", key: "kc", kind: "code", days: 89 },
    { level: "warning", action: "refresh_reference", fund: "CF1" },
  ];
  const s = snap({ pending: { upgrade: { wasm_hash: Buffer.alloc(32), eta: 1n } } });
  const { actions } = decideActions(alerts, s, {}, { actor: "sentinel", keys: {} });
  assert.deepEqual(actions.map((a) => a.kind), ["cancel_upgrade", "cancel_stablecoin", "extend", "extend_code", "refresh_reference"]);
  assert.equal(actions[0].role, "sentinel");
  assert.equal(actions[3].targetDays, 119);
  assert.deepEqual(factsNeeded(alerts), { admin: false, forcedGuardian: false, upgrade: true });
});
