import assert from "node:assert/strict";
import { test } from "node:test";

import { setLang } from "../src/i18n.js";
import { operateModel, whoCanApply } from "../src/operate.js";

const NOW = 1_792_620_000;
const H = 3600;
const ME = "GAMEWALLETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAME";
const GOV = "GAGOVERNORAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGOV";
const OTHER = "GAOTHERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOTHER";

const none = { value: null };
const pendingOf = (over = {}) => ({
  upgrade: none,
  admin: none,
  guardian: none,
  forced: none,
  envelope: none,
  maxTerm: none,
  cap: none,
  currency: "EUR",
  schema: { value: 2 },
  funds: [],
  stablecoins: [],
  ...over,
});
const factsOf = (over = {}) => ({
  admin: { value: GOV },
  adminSigners: { value: [{ key: GOV, weight: 1 }, { key: ME, weight: 1 }] },
  guardian: { value: OTHER },
  guardianBackup: { value: null },
  sentinel: { value: OTHER },
  trustee: { value: null },
  soleLender: { value: OTHER },
  funds: [],
  ...over,
});
const fund = (over = {}) => ({
  symbol: "tMMF",
  config: { value: { nav_max_age_secs: 26 * H, max_outstanding: 1_000n, haircut_bps: 200, source: ["Direct"], steward: OTHER } },
  state: { value: { reference_time: NOW - 2 * H, outstanding: 100n, frozen: false } },
  ...over,
});
const boardOf = (over = {}) => ({ paused: { value: false }, funds: [fund()], ...over });
const model = (over = {}) =>
  operateModel({ pending: pendingOf(), roleFacts: factsOf(), board: boardOf(), now: NOW, wallet: null, version: 4, ...over });

test("proposals are sorted by the moment they can apply; a past one can apply now; an unreadable one is counted", () => {
  const m = model({
    pending: pendingOf({
      upgrade: { value: { eta: NOW + 600, wasm_hash: "ab" } },
      guardian: { value: { eta: NOW - 60, guardian: OTHER } },
      envelope: { error: new Error("timeout") },
      funds: [{ symbol: "tMMF", change: { value: { eta: NOW + 60 } }, limits: none, fallback: none, reanchor: none, stewardBackup: none, stewardRecovery: none }],
    }),
  });
  assert.deepEqual(
    m.proposals.map((p) => [p.label, p.due]),
    [
      ["Guardian change", true],
      ["Fund change: tMMF", false],
      ["Code upgrade", false],
    ],
  );
  assert.equal(m.unreadable, 1);
  assert.equal(model().proposals.length, 0, "nothing pending");
});

test("a price reference older than its NAV age bound, a frozen fund and a cap nearly used are warnings", () => {
  const m = model({
    board: boardOf({
      paused: { value: true },
      funds: [fund({ state: { value: { reference_time: NOW - 30 * H, outstanding: 900n, frozen: true } } })],
    }),
  });
  const tone = (prefix) => m.health.filter((r) => r.label.startsWith(prefix)).map((r) => r.tone);
  assert.deepEqual(tone("New loans"), ["warn"]);
  assert.deepEqual(tone("tMMF"), ["warn", "warn", "warn"], "reference, cap, frozen");
  const calm = model();
  assert.ok(calm.health.every((r) => r.tone !== "warn"), "a healthy instance has no warning");
});

test("the roles list marks the connected wallet, a governor signer included", () => {
  const m = model({ wallet: ME });
  const you = m.roles.filter((r) => r.you).map((r) => r.label);
  assert.deepEqual(you, ["Governor"]);
  const asSentinel = model({ wallet: OTHER }).roles.filter((r) => r.you).map((r) => r.label);
  assert.deepEqual(asSentinel, ["Guardian", "Sentinel", "Sole lender"]);
});

test("an unreadable role shows unknown, not an address; an empty role shows none", () => {
  const m = model({ roleFacts: factsOf({ guardian: { error: new Error("timeout") } }) });
  const guardian = m.roles.find((r) => r.label === "Guardian");
  assert.equal(guardian.unknown, true);
  assert.equal(guardian.address, null);
  const trustee = m.roles.find((r) => r.label === "Trustee");
  assert.equal(trustee.unknown, false);
  assert.equal(trustee.address, null);
});

test("the Operate space reads in French", () => {
  try {
    setLang("fr");
    const m = model({ pending: pendingOf({ upgrade: { value: { eta: NOW + 600 } } }) });
    assert.equal(m.proposals[0].label, "Mise à niveau du code");
    assert.equal(m.health[0].label, "Nouveaux prêts");
  } finally {
    setLang("en");
  }
});

test("proposals say who can apply them: the governor installs an upgrade, the proposed governor accepts, anyone applies the rest", () => {
  const m = model({
    pending: pendingOf({
      upgrade: { value: { eta: NOW - 10 } },
      admin: { value: { eta: NOW - 20 } },
      guardian: { value: { eta: NOW - 30 } },
      forced: { value: { eta: NOW - 40 } },
      stablecoins: [{ code: "tEUR", change: { value: { eta: NOW - 50 } } }],
    }),
  });
  const who = Object.fromEntries(m.proposals.map((p) => [p.label, p.whoCan]));
  assert.deepEqual(who, {
    "Code upgrade": "governor",
    "Governor handover": "proposedGovernor",
    "Guardian change": "anyone",
    "Forced guardian change": "governor",
    "Stablecoin registration: tEUR": "governor",
  });
  assert.equal(whoCanApply("anyone"), "anyone can apply it now");
  assert.equal(whoCanApply("governor"), "the governor can apply it now");
  assert.equal(whoCanApply("proposedGovernor"), "the proposed governor can accept it now");
});

test("the proposals panel never says nothing is pending when a read failed or nothing was read", () => {
  assert.equal(model().proposalsState, "read");
  assert.equal(model({ pending: pendingOf({ envelope: { error: new Error("timeout") } }) }).proposalsState, "partial");
  assert.equal(model({ pending: null }).proposalsState, "unknown");
});

test("the governor row marks a wallet only when the chain says it can sign for the governor", () => {
  const disabledMaster = factsOf({ adminSigners: { value: [{ key: GOV, weight: 0 }, { key: OTHER, weight: 1 }] } });
  const gov = model({ wallet: GOV, roleFacts: disabledMaster }).roles.find((r) => r.label === "Governor");
  assert.equal(gov.you, false);
  const unread = factsOf({ adminSigners: { error: new Error("timeout") } });
  assert.equal(model({ wallet: GOV, roleFacts: unread }).roles.find((r) => r.label === "Governor").you, false);
});

test("a stored layout that is not an integer shows unknown", () => {
  const m = model({ pending: pendingOf({ schema: { value: { odd: 1 } } }) });
  assert.deepEqual(m.health.find((r) => r.label === "Contract"), { label: "Contract", value: "Unknown", tone: "dim" });
});
