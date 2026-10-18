// Inventory of an Open Window instance, for its operator: roles, code, and every
// admitted fund checked against the risk envelope and the admission rules.
//
//   npm run inventory             print the inventory
//   npm run inventory -- --json   also write demo/.state/instance-register.json,
//                                 the off-chain instance register (docs/operations.md)
//
// Read-only: nothing is signed, nothing is submitted. Run it before a governed
// upgrade that tightens an admission rule: a fund admitted under the older
// rule keeps running, but its next `set_fund_limits` or replacement is refused
// until a compliant configuration is applied through the time delay (18
// October 2026, S22 on the first demo fund). The tool names those funds first.

import fs from "node:fs";
import path from "node:path";
import { asset, codeKey, fmt, ledgerEntries, ledgerTime, loadState, read, storageKey, STATE_DIR, sv } from "./lib.mjs";

const JSON_OUT = process.argv.includes("--json");
const state = loadState();
if (!state.contracts?.openWindow) {
  console.error("No deployment found: run `npm run setup` first.");
  process.exit(1);
}
const C = state.contracts;
const ow = C.openWindow;

/** The admitted funds this deployment knows (the contract keeps no global index, invariant I6). */
function fundsOf() {
  const list = [{ label: "fund 1", symbol: "tMMF", shares: C.shares, navOracle: C.navOracle, tokenCode: "fund-token" }];
  if (C.shares2) list.push({ label: "fund 2", symbol: "tEMMF", shares: C.shares2, navOracle: C.navOracle2, tokenCode: "fund-token" });
  if (C.shares3) list.push({ label: "fund 3", symbol: "tSHARE", shares: C.shares3, navOracle: C.navOracle3, tokenCode: "stellar-asset-contract" });
  return list;
}
const stablecoinsOf = () => [C.euro, C.euro2].filter(Boolean);

const pct = (bps) => `${(Number(bps) / 100).toFixed(2)} %`;
const hours = (secs) => (Number(secs) < 3600 ? `${Math.round(Number(secs) / 60)} min` : `${(Number(secs) / 3600).toFixed(0)} h`);
const short = (a) => (a ? `${String(a).slice(0, 6)}…${String(a).slice(-4)}` : "none");

async function executableHash() {
  const head = await ledgerEntries([storageKey(ow)]);
  const raw = head.entries[0]?.value?.contractData?.val?.instance?.executable?.wasmHash;
  return raw ? (typeof raw.toXDR === "function" ? raw.toXDR("hex") : Buffer.from(raw).toString("hex")) : null;
}

async function main() {
  const now = await ledgerTime();
  const [version, schema, admin, guardian, guardianBackup, trustee, sentinel, soleLender, delay, maxTerm, envelope, pendingUpgrade, wasmHash] = await Promise.all([
    read(state, ow, "version"),
    read(state, ow, "schema_version"),
    read(state, ow, "admin"),
    read(state, ow, "guardian"),
    read(state, ow, "guardian_backup"),
    read(state, ow, "trustee"),
    read(state, ow, "sentinel"),
    read(state, ow, "sole_lender"),
    read(state, ow, "timelock_delay"),
    read(state, ow, "max_term"),
    read(state, ow, "envelope"),
    read(state, ow, "pending_upgrade"),
    executableHash(),
  ]);
  const codeTtl = wasmHash ? await ledgerEntries([codeKey(wasmHash)]).catch(() => null) : null;
  const codeLive = codeTtl?.entries?.[0]?.liveUntil ?? null;

  console.log(`Open Window instance ${ow}`);
  console.log(`  contract version ${version}, schema ${schema}, executable ${wasmHash ?? "?"}${codeLive ? `, code live until ledger ${codeLive}` : ""}`);
  console.log(`  time delay ${hours(delay)}, term ceiling ${hours(maxTerm)}${pendingUpgrade ? `, UPGRADE PENDING to ${Buffer.from(pendingUpgrade.wasm_hash).toString("hex").slice(0, 12)}… at ${new Date(Number(pendingUpgrade.eta) * 1000).toISOString()}` : ""}`);
  console.log("\nRoles");
  const roles = { governor: admin, guardian, "guardian backup": guardianBackup, trustee, sentinel, "sole lender": soleLender };
  for (const [name, who] of Object.entries(roles)) console.log(`  ${name.padEnd(16)} ${who ?? "none"}`);
  console.log("\nRisk envelope");
  console.log(`  haircut ≥ ${pct(envelope.min_haircut_bps)}, FX haircut ≥ ${pct(envelope.min_fx_haircut_bps)}, corridor floor ≤ ${pct(envelope.max_corridor_floor_bps)}, yield ≤ ${pct(envelope.max_yield_bps)}, NAV age ≤ ${hours(envelope.max_nav_age_secs)}, FX age ≤ ${hours(envelope.max_fx_age_secs)}, FX band ≤ ${pct(envelope.max_fx_band_bps)}`);

  const stablecoins = [];
  for (const token of stablecoinsOf()) {
    const cfg = await read(state, ow, "get_stablecoin", [sv.address(token)]);
    if (!cfg) continue;
    const cap = await read(state, ow, "currency_cap", [sv.symbol(String(cfg.currency))]);
    const outstanding = await read(state, ow, "currency_outstanding", [sv.symbol(String(cfg.currency))]);
    stablecoins.push({ token, currency: String(cfg.currency), decimals: Number(cfg.decimals), currencyCap: String(cap), currencyOutstanding: String(outstanding) });
  }
  console.log("\nStablecoins");
  for (const s of stablecoins) console.log(`  ${s.token}  ${s.currency}, ${s.decimals} decimals; currency outstanding ${fmt(BigInt(s.currencyOutstanding))} / cap ${fmt(BigInt(s.currencyCap))}`);

  console.log("\nFunds");
  const register = [];
  let findings = 0;
  for (const f of fundsOf()) {
    const [cfg, st, backup, pending] = await Promise.all([
      read(state, ow, "get_fund", [sv.address(f.shares)]),
      read(state, ow, "get_fund_state", [sv.address(f.shares)]),
      read(state, ow, "steward_backup", [sv.address(f.shares)]),
      read(state, ow, "pending_fund_change", [sv.address(f.shares)]),
    ]);
    if (!cfg) {
      console.log(`  ${f.label} ${short(f.shares)}: not admitted`);
      continue;
    }
    const fx = Array.isArray(cfg.source) ? cfg.source[1] : null;
    const sourceName = Array.isArray(cfg.source) ? cfg.source[0] : String(cfg.source);
    const nav = await read(state, f.navOracle, "lastprice", [asset.stellar(f.shares)]).catch(() => null);
    const navAge = nav ? now - Number(nav.timestamp) : null;
    const approved = soleLender ? await read(state, ow, "is_lender_approved", [sv.address(f.shares), sv.address(soleLender)]) : null;
    const issues = [];
    // Envelope: what `set_fund` and `set_fund_limits` check today.
    if (Number(cfg.haircut_bps) < Number(envelope.min_haircut_bps)) issues.push(`haircut ${pct(cfg.haircut_bps)} below the envelope minimum ${pct(envelope.min_haircut_bps)}`);
    if (Number(cfg.corridor_floor_bps) > Number(envelope.max_corridor_floor_bps)) issues.push(`corridor floor ${pct(cfg.corridor_floor_bps)} above the envelope maximum`);
    if (Number(cfg.max_yield_bps) > Number(envelope.max_yield_bps)) issues.push(`yield ${pct(cfg.max_yield_bps)} above the envelope maximum`);
    if (Number(cfg.nav_max_age_secs) > Number(envelope.max_nav_age_secs)) issues.push(`NAV age bound ${hours(cfg.nav_max_age_secs)} above the envelope maximum ${hours(envelope.max_nav_age_secs)}`);
    if (fx) {
      if (Number(fx.haircut_bps) < Number(envelope.min_fx_haircut_bps)) issues.push(`FX haircut ${pct(fx.haircut_bps)} below the envelope minimum`);
      if (Number(fx.band_bps) > Number(envelope.max_fx_band_bps)) issues.push(`FX band ${pct(fx.band_bps)} above the envelope maximum`);
      if (Number(fx.max_age_secs) > Number(envelope.max_fx_age_secs)) issues.push(`FX age bound ${hours(fx.max_age_secs)} above the envelope maximum`);
      // S22 (rc4): the band may not exceed the FX haircut; checked at admission and when limits are tuned.
      if (Number(fx.band_bps) > Number(fx.haircut_bps)) issues.push(`S22: FX band ${pct(fx.band_bps)} exceeds the FX haircut ${pct(fx.haircut_bps)}; the next set_fund_limits is refused until a compliant configuration is applied through the delay`);
    }
    if (!backup) issues.push("no steward backup registered: a lost steward key could not be recovered (D4)");
    if (soleLender && approved === false) issues.push("the sole lender is not approved on this fund: no offer can list it");
    if (navAge !== null && navAge > Number(cfg.nav_max_age_secs)) issues.push(`NAV is ${hours(navAge)} old, beyond the ${hours(cfg.nav_max_age_secs)} bound: entries on this fund are refused until a fresh publication`);
    if (st.frozen) issues.push("fund frozen by its steward: no new repo");
    findings += issues.length;
    console.log(`  ${f.label} ${f.symbol} ${f.shares} (${f.tokenCode})`);
    console.log(`    steward ${cfg.steward}, backup ${backup ?? "none"}; currency ${cfg.currency}; source ${sourceName}; haircut ${pct(cfg.haircut_bps)}${fx ? `, FX haircut ${pct(fx.haircut_bps)}, FX band ${pct(fx.band_bps)}, FX age ≤ ${hours(fx.max_age_secs)}` : ""}`);
    console.log(`    corridor floor ${pct(cfg.corridor_floor_bps)}, yield ≤ ${pct(cfg.max_yield_bps)}, NAV age ≤ ${hours(cfg.nav_max_age_secs)}${navAge !== null ? ` (now ${hours(navAge)} old)` : " (no NAV read)"}`);
    console.log(`    outstanding ${fmt(BigInt(st.outstanding))} / cap ${fmt(BigInt(cfg.max_outstanding))}, per repo ≤ ${fmt(BigInt(cfg.max_principal_per_repo))}${pending ? `; CHANGE PENDING until ${new Date(Number(pending.eta) * 1000).toISOString()}` : ""}${soleLender ? `; sole lender ${approved ? "approved" : "NOT approved"}` : ""}`);
    for (const i of issues) console.log(`    ! ${i}`);
    if (!issues.length) console.log("    ok: within the envelope and the admission rules");
    register.push({
      label: f.label,
      symbol: f.symbol,
      shares: f.shares,
      tokenCode: f.tokenCode,
      navFeed: f.navOracle,
      steward: cfg.steward,
      stewardBackup: backup ?? null,
      currency: String(cfg.currency),
      source: sourceName,
      haircutBps: Number(cfg.haircut_bps),
      fx: fx ? { oracle: fx.oracle, haircutBps: Number(fx.haircut_bps), bandBps: Number(fx.band_bps), maxAgeSecs: Number(fx.max_age_secs) } : null,
      corridorFloorBps: Number(cfg.corridor_floor_bps),
      maxYieldBps: Number(cfg.max_yield_bps),
      navMaxAgeSecs: Number(cfg.nav_max_age_secs),
      maxPrincipalPerRepo: String(cfg.max_principal_per_repo),
      maxOutstanding: String(cfg.max_outstanding),
      outstanding: String(st.outstanding),
      frozen: Boolean(st.frozen),
      pendingChangeEta: pending ? Number(pending.eta) : null,
      soleLenderApproved: approved,
      issues,
    });
  }
  console.log(`\n${findings ? `${findings} finding(s): fix each one through the time delay before an upgrade that tightens a rule, or accept it in writing.` : "No finding: every admitted fund is within the envelope and the admission rules."}`);

  if (JSON_OUT) {
    const out = {
      network: "testnet",
      takenAt: new Date().toISOString(),
      ledgerTime: now,
      contract: ow,
      version: Number(version),
      schemaVersion: Number(schema),
      executable: wasmHash,
      codeLiveUntilLedger: codeLive,
      timelockDelaySecs: Number(delay),
      maxTermSecs: Number(maxTerm),
      roles: Object.fromEntries(Object.entries(roles).map(([k, v]) => [k, v ?? null])),
      envelope: Object.fromEntries(Object.entries(envelope).map(([k, v]) => [k, Number(v)])),
      pendingUpgrade: pendingUpgrade ? { wasmHash: Buffer.from(pendingUpgrade.wasm_hash).toString("hex"), eta: Number(pendingUpgrade.eta) } : null,
      stablecoins,
      funds: register,
      findings,
    };
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const file = path.join(STATE_DIR, "instance-register.json");
    fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
    console.log(`Instance register written to ${path.relative(process.cwd(), file)}`);
  }
}

main().catch((error) => {
  console.error(`Inventory failed: ${error.message}`);
  process.exit(1);
});
