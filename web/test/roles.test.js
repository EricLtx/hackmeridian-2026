import assert from "node:assert/strict";
import { test } from "node:test";

import { setLang } from "../src/i18n.js";
import { roleLabel, rolesNone, rolesOf } from "../src/roles.js";

const ME = "GAMEWALLETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAME";
const GOV = "GAGOVERNORAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGOV";
const OTHER = "GAOTHERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOTHER";

/** Facts as `chain.roleFacts` returns them: every read settled, nobody holding anything. */
const facts = (over = {}) => ({
  admin: { value: GOV },
  adminSigners: { value: [{ key: GOV, weight: 0 }] },
  guardian: { value: OTHER },
  guardianBackup: { value: null },
  sentinel: { value: null },
  trustee: { value: null },
  soleLender: { value: null },
  funds: [],
  ...over,
});

const held = (r) => r.held.map((h) => (h.fund ? `${h.role}:${h.fund}` : h.role)).sort();
const unknown = (r) => r.unknown.map((h) => (h.fund ? `${h.role}:${h.fund}` : h.role)).sort();

test("a signer of the governor account with a weight is governor; a weight of 0 is not", () => {
  assert.deepEqual(held(rolesOf(ME, facts({ adminSigners: { value: [{ key: GOV, weight: 0 }, { key: ME, weight: 1 }] } }))), ["governor"]);
  assert.deepEqual(held(rolesOf(ME, facts({ adminSigners: { value: [{ key: GOV, weight: 1 }, { key: ME, weight: 0 }] } }))), []);
});

test("the governor account itself is governor", () => {
  assert.deepEqual(held(rolesOf(GOV, facts({ adminSigners: { value: [{ key: GOV, weight: 1 }] } }))), ["governor"]);
});

test("a failed read leaves that role unknown, grants nothing, and keeps the others", () => {
  const r = rolesOf(ME, facts({ admin: { error: new Error("timeout") }, guardian: { error: new Error("timeout") }, sentinel: { value: ME } }));
  assert.deepEqual(held(r), ["sentinel"]);
  assert.deepEqual(unknown(r), ["governor", "guardian"]);
  // The signer list unread: governor unknown, the governor account's own key included.
  assert.deepEqual(unknown(rolesOf(ME, facts({ adminSigners: { error: new Error("timeout") } }))), ["governor"]);
  assert.deepEqual(held(rolesOf(GOV, facts({ adminSigners: { error: new Error("timeout") } }))), []);
  assert.deepEqual(unknown(rolesOf(GOV, facts({ adminSigners: { error: new Error("timeout") } }))), ["governor"]);
});

test("stewardship, its backup and lender approval are per fund", () => {
  const r = rolesOf(
    ME,
    facts({
      funds: [
        { symbol: "tMMF", steward: { value: ME }, stewardBackup: { value: null }, approved: { value: false } },
        { symbol: "tEMMF", steward: { value: OTHER }, stewardBackup: { value: ME }, approved: { value: true } },
        { symbol: "tSHARE", steward: { error: new Error("x") }, stewardBackup: { value: null }, approved: { error: new Error("x") } },
      ],
    }),
  );
  assert.deepEqual(held(r), ["approvedLender:tEMMF", "steward:tMMF", "stewardBackup:tEMMF"]);
  assert.deepEqual(unknown(r), ["approvedLender:tSHARE", "steward:tSHARE"]);
});

test("the guardian, its backup, the trustee and the sole lender are matched by address", () => {
  const r = rolesOf(ME, facts({ guardian: { value: ME }, guardianBackup: { value: ME }, trustee: { value: ME }, soleLender: { value: ME } }));
  assert.deepEqual(held(r), ["guardian", "guardianBackup", "soleLender", "trustee"]);
  assert.deepEqual(held(rolesOf(null, facts({ guardian: { value: ME } }))), [], "no wallet, no role");
});

test("role labels read in the page's language, with the fund when there is one", () => {
  assert.equal(roleLabel({ role: "steward", fund: "tMMF" }), "Steward of tMMF");
  assert.equal(roleLabel({ role: "governor" }), "Governor");
  try {
    setLang("fr");
    assert.equal(roleLabel({ role: "guardian" }), "Gardien");
    assert.equal(roleLabel({ role: "approvedLender", fund: "tEMMF" }), "Prêteur approuvé de tEMMF");
  } finally {
    setLang("en");
  }
});

test("the governor account's master key with a weight of 0 is not governor; a contract governor is matched by address", () => {
  const multisig = { value: [{ key: GOV, weight: 0 }, { key: ME, weight: 1 }, { key: OTHER, weight: 1 }] };
  assert.deepEqual(held(rolesOf(GOV, facts({ adminSigners: multisig }))), [], "disabled master key");
  assert.deepEqual(held(rolesOf(ME, facts({ adminSigners: multisig }))), ["governor"]);
  const CGOV = "CAGOVERNORCONTRACTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACGOV";
  assert.deepEqual(held(rolesOf(CGOV, facts({ admin: { value: CGOV }, adminSigners: { value: [] } }))), ["governor"]);
});

test("a wallet holds no role only when every role was read", () => {
  assert.equal(rolesNone({ held: [], unknown: [] }), true);
  assert.equal(rolesNone({ held: [], unknown: [{ role: "guardian" }] }), false);
  assert.equal(rolesNone({ held: [{ role: "sentinel" }], unknown: [] }), false);
});
