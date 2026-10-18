// Deploys and configures the Open Window demo on Stellar testnet.
//
//   npm run setup              resumes where the last run stopped
//   npm run setup -- --fresh   new contracts (keeps the funded accounts; the
//                              previous state is copied to testnet-<id>.json)
//   npm run setup -- --restage new short repo for the seizure scene
//   npm run setup -- --fx=local     re-admit the fund on the local FX feed
//   npm run setup -- --fx=reflector back to the Reflector FX feed
//   npm run setup -- --multisig     make the governor a 2-of-2 account with an
//                                   outside co-signer (decision S7); done once
//   npm run setup -- --sentinel     the guardian names the monitoring key as
//                                   sentinel: it may only pause and cancel (rc4)
//   npm run setup -- --second-fund  admit a second fund (euro money market
//                                   share, its own issuer and NAV feed, no FX
//                                   leg) and a second euro stablecoin; one
//                                   offer over both funds. No contract change.
//
// Each step is recorded in the state file once it succeeds, so a network
// drop costs one step, not the whole setup.
//
// Run it at least one hour before the demo: it opens a short repo that must
// reach maturity for the seizure scene. Keys and addresses are written to
// demo/.state/testnet.json (git-ignored, testnet only).

import {
  Asset,
  ONE,
  Operation,
  Keypair,
  REFLECTOR_FX_TESTNET,
  asset,
  classic,
  deploy,
  deploySac,
  fmt,
  friendbot,
  invoke,
  keypair,
  ledgerTime,
  loadState,
  read,
  saveState,
  WASM_DIR,
  codeKey,
  extendTtl,
  sleep,
  sv,
  writeDeployment,
  STATE_DIR,
  STATE_FILE,
} from "./lib.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DEMO_TIMELOCK_SECS, FALLBACK_EUR_USD, FUND_SETTINGS, NAV_EUR_AT_SETUP, NAV_USD_AT_SETUP, OFFERS, SECOND_FUND_SETTINGS, navAt } from "./config.mjs";

// The provider is an independent lender the issuer designates: the issuer
// (steward) approves lenders but never funds offers on its own fund, which
// EU money market fund rules forbid as sponsor support.
// The keeper only pays storage rent (contract code, entries near archival): no role in the contract.
const ROLES = ["governor", "guardian", "guardianBackup", "trustee", "steward", "stewardBackup", "operator", "keeper", "euroIssuer", "provider", "lender", "borrower"];

function step(label) {
  process.stdout.write(`\n▸ ${label}\n`);
}

/** Runs `body` once per setup: skipped when the state records it as done. */
async function once(state, key, label, body) {
  step(label);
  if (state.done[key]) {
    console.log("  done earlier, skipped");
    return;
  }
  await body();
  state.done[key] = true;
  saveState(state);
}

/** Amount in 7-decimal units as the decimal string a classic payment takes. */
function fmtUnits(units) {
  const whole = units / ONE;
  const frac = (units % ONE).toString().padStart(7, "0");
  return `${whole}.${frac}`;
}

/** Republishes the NAV when it is over an hour old, as the run's heartbeat does. */
async function refreshNav(state) {
  const feed = state.contracts.navOracle;
  const fund = asset.stellar(state.contracts.shares);
  const now = await ledgerTime();
  const last = await read(state, feed, "lastprice", [fund]);
  if (last && now - Number(last.timestamp) < 3600) return;
  const nav = navAt(state.navPublishedAt ?? now, now);
  await invoke(state, "operator", feed, "publish", [
    fund,
    sv.i128(nav),
    sv.u64(Math.max(now - 1, Number(last?.timestamp ?? 0))),
  ]);
  console.log(`  NAV republished  ${(Number(nav) / 1e14).toFixed(4)} USD`);
}

async function main() {
  const state = loadState();
  if (process.argv.includes("--fresh") || !state.done) {
    // Keeps the previous deployment reachable: copy its state aside, named
    // after its contract, so a rehearsed demo can be restored by renaming the file.
    if (state.contracts?.openWindow && fs.existsSync(STATE_FILE)) {
      const kept = path.join(STATE_DIR, `testnet-${state.contracts.openWindow.slice(0, 8)}.json`);
      fs.copyFileSync(STATE_FILE, kept);
      console.log(`previous deployment state kept in ${path.basename(kept)}`);
    }
    state.contracts = {};
    state.ids = {};
    state.done = {};
  }
  // A new short repo for the seizure scene, on the same contracts.
  if (process.argv.includes("--restage")) {
    delete state.done.stagedRepo;
    delete state.ids.stagedRepo;
  }
  // FX source of the fund: Reflector by default, the local feed as fallback.
  const fxFlag = process.argv.find((a) => a.startsWith("--fx="))?.slice(5);
  if (fxFlag) {
    if (!["local", "reflector"].includes(fxFlag)) throw new Error("--fx takes local or reflector");
    if (fxFlag !== (state.fxSource ?? "reflector")) delete state.done.admission;
    state.fxSource = fxFlag;
  }
  state.fxSource ??= "reflector";
  const pub = (role) => keypair(state, role).publicKey();

  await once(state, "accounts", "Accounts", async () => {
    for (const role of ROLES) {
      if (!state.keys[role]) state.keys[role] = Keypair.random().secret();
      saveState(state);
      await friendbot(pub(role));
      console.log(`  ${role.padEnd(10)} ${pub(role)}`);
    }
  });

  const teur = new Asset("tEUR", pub("euroIssuer"));
  await once(state, "teur", "Test euro stablecoin tEUR (classic asset and its contract)", async () => {
    for (const role of ["provider", "lender", "borrower"]) {
      await classic(state, role, Operation.changeTrust({ asset: teur }));
    }
    state.contracts.euro = await deploySac(state, "euroIssuer", teur);
    saveState(state);
    console.log(`  tEUR contract ${state.contracts.euro}`);
    // Tops each holder up to its target, so a rerun never pays twice.
    const funding = { provider: 500_000n, lender: 200_000n, borrower: 2_000n };
    for (const [role, target] of Object.entries(funding)) {
      const held = BigInt(await read(state, state.contracts.euro, "balance", [sv.address(pub(role))]));
      const missing = target * ONE - held;
      if (missing <= 0n) continue;
      await classic(
        state,
        "euroIssuer",
        Operation.payment({ destination: pub(role), asset: teur, amount: fmtUnits(missing) }),
      );
    }
  });

  step("Contracts");
  if (!state.contracts.shares) {
    state.contracts.shares = await deploy(state, "steward", "fund_token.wasm", [
      sv.address(pub("steward")),
      sv.u32(7),
      sv.string("Test US T-bill fund share"),
      sv.string("tMMF"),
    ]);
    saveState(state);
  }
  console.log(`  fund share token ${state.contracts.shares}`);
  if (!state.contracts.navOracle) {
    state.contracts.navOracle = await deploy(state, "operator", "nav_oracle.wasm", [
      sv.address(pub("operator")),
      asset.other("USD"),
      sv.u32(14),
      sv.u32(300),
    ]);
    saveState(state);
  }
  console.log(`  NAV feed         ${state.contracts.navOracle}`);
  if (!state.contracts.openWindow) {
    state.contracts.openWindow = await deploy(state, "governor", "night_window.wasm", [sv.address(pub("governor"))]);
    saveState(state);
  }
  console.log(`  Open Window      ${state.contracts.openWindow}`);
  await once(state, "codeTtl", "Operator extends the contract code by 30 days (the contract never pays for its own code)", async () => {
    const wasm = fs.readFileSync(path.join(WASM_DIR, "night_window.wasm"));
    const hash = crypto.createHash("sha256").update(wasm).digest();
    if (!state.keys.keeper) throw new Error("no keeper key: rerun setup from the Accounts step");
    const r = await extendTtl(state, "keeper", [codeKey(hash)], 30 * 17_280);
    console.log(`  code ${hash.toString("hex").slice(0, 12)}… extended, fee ${(Number(r.fee ?? 0n) / 1e7).toFixed(2)} XLM`);
  });

  const ow = state.contracts.openWindow;
  const shares = state.contracts.shares;

  if (process.argv.includes("--multisig")) {
    await once(state, "multisig", "Governor becomes a native 2-of-2 multisig with an outside co-signer", async () => {
      if (!state.keys.cosigner) state.keys.cosigner = Keypair.random().secret();
      saveState(state);
      const cosigner = pub("cosigner");
      // Master key and co-signer weigh 1 each; every threshold needs 2, so no
      // single key can act as governor, on a transaction or an authorization.
      await classic(
        state,
        "governor",
        Operation.setOptions({
          signer: { ed25519PublicKey: cosigner, weight: 1 },
          masterWeight: 1,
          lowThreshold: 2,
          medThreshold: 2,
          highThreshold: 2,
        }),
      );
      state.multisig = { ...(state.multisig ?? {}), governor: ["governor", "cosigner"] };
      console.log(`  governor ${pub("governor")} now needs both keys; co-signer ${cosigner}`);
    });
  }

  await once(state, "governor", "Governor: guardian, stablecoin registry, currency cap", async () => {
    await invoke(state, "governor", ow, "set_guardian", [sv.address(pub("guardian"))]);
    await invoke(state, "governor", ow, "set_stablecoin", [sv.address(state.contracts.euro), sv.symbol("EUR")]);
    await invoke(state, "governor", ow, "set_currency_cap", [sv.symbol("EUR"), sv.i128(1_000_000n * ONE)]);
    // Only possible before the first fund is admitted: afterwards the delay can only grow.
    await invoke(state, "governor", ow, "set_timelock_delay", [sv.u64(DEMO_TIMELOCK_SECS)]);
    console.log(`  time delay on upgrades and fund changes: ${DEMO_TIMELOCK_SECS / 60} min`);
    // Mode D3: one independent lender runs this instance; fixed now, never again.
    await invoke(state, "governor", ow, "set_sole_lender", [sv.address(pub("provider"))]);
    console.log(`  sole lender (mode D3): the provider ${pub("provider").slice(0, 8)}…`);
    // The guardian may only hand its role to this backup, registered by governor and guardian together.
    await invoke(state, "governor", ow, "set_guardian_backup", [sv.address(pub("guardianBackup"))]);
    console.log("  guardian backup registered by the governor and the guardian");
    // The trustee co-signs every upgrade and forced guardian change and can
    // veto them: fixed during bootstrap, independent of the other roles.
    await invoke(state, "governor", ow, "set_trustee", [sv.address(pub("trustee"))]);
    console.log(`  trustee ${pub("trustee").slice(0, 8)}…: no upgrade without its signature`);
  });

  await once(state, "issuer", "Issuer: allowlist (holders and the contract), mint shares", async () => {
    for (const holder of [pub("borrower"), pub("provider"), pub("lender"), ow]) {
      await invoke(state, "steward", shares, "set_whitelisted", [sv.address(holder), sv.bool(true)]);
    }
    // Mints only once: a rerun after a partial failure finds the shares there.
    const held = BigInt(await read(state, shares, "balance", [sv.address(pub("borrower"))]));
    if (held === 0n)
      await invoke(state, "steward", shares, "mint", [sv.address(pub("borrower")), sv.i128(100_000n * ONE)]);
  });

  await once(state, "feeds", "Price feeds", async () => {
    const fx = await read(state, REFLECTOR_FX_TESTNET, "lastprice", [asset.other("EUR")]).catch(() => null);
    if (fx) {
      const fxTime = new Date(Number(fx.timestamp) * 1000).toISOString();
      console.log(`  Reflector EUR/USD ${(Number(fx.price) / 1e14).toFixed(4)} at ${fxTime}`);
    } else {
      console.log("  Reflector EUR/USD unavailable: use --fx=local");
    }
    const now = await ledgerTime();
    await invoke(state, "operator", state.contracts.navOracle, "publish", [
      asset.stellar(shares),
      sv.i128(NAV_USD_AT_SETUP),
      sv.u64(now - 10),
    ]);
    state.navPublishedAt = now - 10;
    console.log(`  NAV published    ${(Number(NAV_USD_AT_SETUP) / 1e14).toFixed(4)} USD`);
  });

  await once(
    state,
    "admission",
    "Two-key admission of the fund (governor and steward sign the same call)",
    async () => {
      const s = FUND_SETTINGS;
      // Admission anchors the NAV reference on the live NAV: it must be fresh and right.
      await refreshNav(state);
      let fxOracle = REFLECTOR_FX_TESTNET;
      if (state.fxSource === "local") {
        // Same base (USD) as the NAV feed, asset EUR: what admission requires.
        let fx = null;
        try {
          fx = await read(state, REFLECTOR_FX_TESTNET, "lastprice", [asset.other("EUR")]);
        } catch (error) {
          console.log(`  Reflector unreadable (${error.message})`);
        }
        const rate = fx ? BigInt(fx.price) : FALLBACK_EUR_USD;
        const now = await ledgerTime();
        await invoke(state, "operator", state.contracts.navOracle, "publish", [
          asset.other("EUR"),
          sv.i128(rate),
          sv.u64(now - 1),
        ]);
        fxOracle = state.contracts.navOracle;
        const origin = fx
          ? `copied from Reflector, rate of ${new Date(Number(fx.timestamp) * 1000).toISOString()}`
          : "fixed fallback rate, not a market price";
        console.log(`  local FX feed EUR/USD ${(Number(rate) / 1e14).toFixed(4)} (${origin})`);
      }
      console.log(`  FX source: ${state.fxSource}`);
      const fundConfig = sv.struct({
        oracle: sv.address(state.contracts.navOracle),
        oracle_asset: asset.stellar(shares),
        haircut_bps: sv.u32(s.haircutBps),
        steward: sv.address(pub("steward")),
        currency: sv.symbol("EUR"),
        source: sv.variant(
          "Cross",
          sv.struct({
            oracle: sv.address(fxOracle),
            asset: asset.other("EUR"),
            haircut_bps: sv.u32(s.fxHaircutBps),
            max_age_secs: sv.u64(s.fxMaxAgeSecs),
            band_bps: sv.u32(s.fxBandBps),
          }),
        ),
        nav_max_age_secs: sv.u64(s.navMaxAgeSecs),
        corridor_floor_bps: sv.u32(s.corridorFloorBps),
        max_yield_bps: sv.u32(s.maxYieldBps),
        max_principal_per_repo: sv.i128(s.maxPrincipalPerRepo),
        max_outstanding: sv.i128(s.maxOutstanding),
      });
      const admitted = await read(state, ow, "get_fund", [sv.address(shares)]);
      await invoke(state, "governor", ow, "set_fund", [sv.address(shares), fundConfig]);
      if (admitted) {
        // Replacing an admitted fund is a proposal: it applies after the time delay.
        const pending = await read(state, ow, "pending_fund_change", [sv.address(shares)]);
        const wait = Math.max(0, Number(pending.eta) - (await ledgerTime()));
        console.log(`  replacement proposed; applying it after the time delay (${Math.ceil(wait / 60)} min)`);
        while ((await ledgerTime()) < Number(pending.eta)) await sleep(10_000);
        await refreshNav(state);
        await invoke(state, "operator", ow, "apply_fund_change", [sv.address(shares)]);
        console.log("  replacement applied");
      }
    },
  );

  await once(state, "stewardBackup", "Issuer: registers the backup key its fund can be recovered to", async () => {
    // Only this address can ever replace a lost steward key, after 30 days, with governor and guardian.
    await invoke(state, "steward", ow, "set_steward_backup", [sv.address(shares), sv.address(pub("stewardBackup"))]);
    console.log("  steward backup registered by the issuer alone");
  });

  await once(state, "lenders", "Lenders: attested by lender and issuer, then approved (the issuer never lends)", async () => {
    // The declaration (eligibility, independence from the fund) lives off chain; its hash is signed by both.
    for (const role of ["provider", "lender"]) {
      const declaration = crypto.createHash("sha256").update(`demo declaration of ${pub(role)} for ${shares}`).digest();
      await invoke(state, role, ow, "attest_lender", [sv.address(shares), sv.address(pub(role)), sv.bytes(declaration)]);
      await invoke(state, "steward", ow, "approve_lender", [sv.address(shares), sv.address(pub(role)), sv.bool(true)]);
    }
    console.log("  provider: attested and approved, the instance's sole lender");
    console.log("  second lender: attested and approved by the issuer, but this instance only accepts the sole lender");
  });

  const funds = sv.vec([sv.address(shares)]);
  await once(state, "sponsorOffer", "Offers: the provider's offer, designated by the issuer", async () => {
    if (state.ids.sponsorOffer === undefined) {
      const sponsor = await invoke(state, "provider", ow, "create_offer", [
        sv.address(pub("provider")),
        sv.address(state.contracts.euro),
        sv.i128(OFFERS.sponsor.amount),
        sv.u32(OFFERS.sponsor.rateBps),
        sv.u64(7 * 24 * 3600),
        funds,
      ]);
      state.ids.sponsorOffer = Number(sponsor.value);
      saveState(state);
    }
    await invoke(state, "steward", ow, "set_sponsor", [
      sv.u64(state.ids.sponsorOffer),
      sv.address(shares),
      sv.bool(true),
    ]);
    console.log(`  designated offer #${state.ids.sponsorOffer} 300,000 tEUR at 2.50 %, funded by the provider`);
  });

  await once(state, "marketOffer", "Offers: a second offer by the sole lender", async () => {
    if (state.ids.marketOffer !== undefined) return;
    const market = await invoke(state, "provider", ow, "create_offer", [
      sv.address(pub("provider")),
      sv.address(state.contracts.euro),
      sv.i128(OFFERS.market.amount),
      sv.u32(OFFERS.market.rateBps),
      sv.u64(7 * 24 * 3600),
      funds,
    ]);
    state.ids.marketOffer = Number(market.value);
    saveState(state);
    console.log(`  second offer  #${state.ids.marketOffer} 150,000 tEUR at 3.50 %, same lender`);
  });

  await once(
    state,
    "stagedRepo",
    "Short repo on the market offer, for the seizure scene (matures in one hour)",
    async () => {
      await refreshNav(state);
      if (state.ids.stagedRepo === undefined) {
        const staged = await invoke(state, "borrower", ow, "open_repo", [
          sv.address(pub("borrower")),
          sv.u64(state.ids.marketOffer),
          sv.address(shares),
          sv.i128(1_000n * ONE),
          sv.i128(900n * ONE),
          sv.u64(3600),
        ]);
        state.ids.stagedRepo = Number(staged.value);
        saveState(state);
      }
      const repo = await read(state, ow, "get_repo", [sv.u64(state.ids.stagedRepo)]);
      state.ids.stagedMaturity = Number(repo.maturity);
      const maturity = new Date(state.ids.stagedMaturity * 1000).toISOString();
      console.log(`  repo #${state.ids.stagedRepo}, ${fmt(repo.principal)} tEUR, matures ${maturity}`);
    },
  );

  // rc4: the monitoring host signs pauses and cancellations with the sentinel key, never the guardian's.
  if (process.argv.includes("--sentinel") || state.keys.sentinel) await nameSentinel(state, ow);

  // The second fund stays part of the deployment once admitted: a rerun keeps it consistent.
  if (process.argv.includes("--second-fund") || state.contracts.shares2) await secondFund(state, ow, shares, teur);

  writeDeployment(state);
  console.log("\n  Public addresses written to web/public/deployment.testnet.json for the web interface.");
  console.log("\nSetup complete. Run `npm run demo` from one hour after now.");
}

/**
 * The sentinel (decision S26, rc4): a key the monitoring host holds, which
 * the guardian names and which may only pause and cancel proposals. The
 * guardian key itself leaves the host. Skipped, and left to a rerun, while the
 * instance still runs code without the role.
 */
async function nameSentinel(state, ow) {
  step("Sentinel: the guardian names the monitoring key");
  if (state.done.sentinel) {
    console.log("  done earlier, skipped");
    return;
  }
  const supported = await read(state, ow, "sentinel").then(() => true, () => false);
  if (!supported) {
    console.log("  the instance runs code without the sentinel role (before rc4): rerun after the upgrade");
    return;
  }
  if (!state.keys.sentinel) {
    state.keys.sentinel = Keypair.random().secret();
    saveState(state);
    await friendbot(keypair(state, "sentinel").publicKey());
  }
  const sentinel = keypair(state, "sentinel").publicKey();
  await invoke(state, "guardian", ow, "set_sentinel", [sv.address(sentinel)]);
  state.done.sentinel = true;
  saveState(state);
  console.log(`  sentinel ${sentinel.slice(0, 8)}…: pause and cancel only; the monitor acts with it from now on`);
}

/**
 * Second fund and second stablecoin, on the same instance, without a line of
 * contract code: a euro money market fund share (NAV in the loan currency, so
 * `PriceSource::Direct`, no FX leg), issued and stewarded by a second issuer
 * with its own NAV operator; a second euro stablecoin that shares the EUR cap
 * with tEUR; an offer that lists both funds and an offer in the second
 * stablecoin. Admitting a new fund takes the governor and that fund's steward
 * and applies at once: the time delay guards changes to an admitted fund.
 */
async function secondFund(state, ow, shares, teur) {
  const pub = (role) => keypair(state, role).publicKey();
  const s = SECOND_FUND_SETTINGS;

  await once(state, "secondAccounts", "Second issuer: steward, its backup, its NAV operator", async () => {
    for (const role of ["steward2", "stewardBackup2", "operator2"]) {
      if (!state.keys[role]) state.keys[role] = Keypair.random().secret();
      saveState(state);
      await friendbot(pub(role));
      console.log(`  ${role.padEnd(14)} ${pub(role)}`);
    }
  });

  const teurb = new Asset("tEURB", pub("euroIssuer"));
  await once(state, "teurb", "Second euro stablecoin tEURB (same currency, another token: shares the EUR cap)", async () => {
    for (const role of ["provider", "borrower"]) {
      await classic(state, role, Operation.changeTrust({ asset: teurb }));
    }
    state.contracts.euro2 = await deploySac(state, "euroIssuer", teurb);
    saveState(state);
    console.log(`  tEURB contract ${state.contracts.euro2}`);
    const funding = { provider: 200_000n, borrower: 1_000n };
    for (const [role, target] of Object.entries(funding)) {
      const held = BigInt(await read(state, state.contracts.euro2, "balance", [sv.address(pub(role))]));
      const missing = target * ONE - held;
      if (missing <= 0n) continue;
      await classic(state, "euroIssuer", Operation.payment({ destination: pub(role), asset: teurb, amount: fmtUnits(missing) }));
    }
  });

  step("Second fund contracts");
  if (!state.contracts.shares2) {
    state.contracts.shares2 = await deploy(state, "steward2", "fund_token.wasm", [
      sv.address(pub("steward2")),
      sv.u32(7),
      sv.string("Test euro money market fund share"),
      sv.string("tEMMF"),
    ]);
    saveState(state);
  }
  console.log(`  fund share token ${state.contracts.shares2}`);
  if (!state.contracts.navOracle2) {
    // Base EUR: the NAV is quoted in the loan currency, which is what `Direct` requires.
    state.contracts.navOracle2 = await deploy(state, "operator2", "nav_oracle.wasm", [
      sv.address(pub("operator2")),
      asset.other("EUR"),
      sv.u32(14),
      sv.u32(300),
    ]);
    saveState(state);
  }
  console.log(`  NAV feed (EUR)   ${state.contracts.navOracle2}`);
  const shares2 = state.contracts.shares2;

  await once(state, "secondStablecoin", "Governor registers tEURB as a EUR stablecoin (at once on rc2; behind the delay from rc4)", async () => {
    const token = sv.address(state.contracts.euro2);
    await invoke(state, "governor", ow, "set_stablecoin", [token, sv.symbol("EUR")]);
    // From rc4 a registration after the first admission is a proposal (S29).
    const pending = await read(state, ow, "pending_stablecoin_change", [token]).catch(() => null);
    if (pending) {
      const wait = Math.max(0, Number(pending.eta) - (await ledgerTime()));
      console.log(`  proposed; applying it after the time delay (${Math.ceil(wait / 60)} min)`);
      while ((await ledgerTime()) < Number(pending.eta)) await sleep(10_000);
      await invoke(state, "operator2", ow, "apply_stablecoin_change", [token]);
      console.log("  applied by a third party after the delay");
    }
    console.log("  two stablecoins now share the EUR cap");
  });

  await once(state, "secondIssuer", "Second issuer: allowlist (holders and the contract), mint shares", async () => {
    for (const holder of [pub("borrower"), pub("provider"), pub("lender"), ow]) {
      await invoke(state, "steward2", shares2, "set_whitelisted", [sv.address(holder), sv.bool(true)]);
    }
    const held = BigInt(await read(state, shares2, "balance", [sv.address(pub("borrower"))]));
    if (held === 0n) await invoke(state, "steward2", shares2, "mint", [sv.address(pub("borrower")), sv.i128(50_000n * ONE)]);
  });

  await once(state, "secondFeed", "Second NAV feed: the euro fund share, published by its own operator", async () => {
    const now = await ledgerTime();
    await invoke(state, "operator2", state.contracts.navOracle2, "publish", [asset.stellar(shares2), sv.i128(NAV_EUR_AT_SETUP), sv.u64(now - 10)]);
    state.nav2PublishedAt = now - 10;
    console.log(`  NAV published    ${(Number(NAV_EUR_AT_SETUP) / 1e14).toFixed(4)} EUR`);
  });

  await once(state, "secondAdmission", "Two-key admission of the second fund (governor and its own steward), no FX leg, its own settings", async () => {
    const fundConfig = sv.struct({
      oracle: sv.address(state.contracts.navOracle2),
      oracle_asset: asset.stellar(shares2),
      haircut_bps: sv.u32(s.haircutBps),
      steward: sv.address(pub("steward2")),
      currency: sv.symbol("EUR"),
      source: sv.variant("Direct"),
      nav_max_age_secs: sv.u64(s.navMaxAgeSecs),
      corridor_floor_bps: sv.u32(s.corridorFloorBps),
      max_yield_bps: sv.u32(s.maxYieldBps),
      max_principal_per_repo: sv.i128(s.maxPrincipalPerRepo),
      max_outstanding: sv.i128(s.maxOutstanding),
    });
    const admitted = await read(state, ow, "get_fund", [sv.address(shares2)]);
    await invoke(state, "governor", ow, "set_fund", [sv.address(shares2), fundConfig]);
    if (admitted) {
      const pending = await read(state, ow, "pending_fund_change", [sv.address(shares2)]);
      const wait = Math.max(0, Number(pending.eta) - (await ledgerTime()));
      console.log(`  replacement proposed; applying it after the time delay (${Math.ceil(wait / 60)} min)`);
      while ((await ledgerTime()) < Number(pending.eta)) await sleep(10_000);
      await invoke(state, "operator2", ow, "apply_fund_change", [sv.address(shares2)]);
      console.log("  replacement applied");
    } else {
      console.log(`  admitted at once: haircut ${s.haircutBps / 100} %, NAV age ≤ ${s.navMaxAgeSecs / 3600} h, cap ${fmt(s.maxOutstanding, 7, 0)} EUR`);
    }
  });

  await once(state, "secondStewardBackup", "Second issuer: registers its backup key", async () => {
    await invoke(state, "steward2", ow, "set_steward_backup", [sv.address(shares2), sv.address(pub("stewardBackup2"))]);
    console.log("  steward backup registered by the second issuer alone");
  });

  await once(state, "secondLenders", "Second fund: the provider is attested and approved by the second issuer", async () => {
    const declaration = crypto.createHash("sha256").update(`demo declaration of ${pub("provider")} for ${shares2}`).digest();
    await invoke(state, "provider", ow, "attest_lender", [sv.address(shares2), sv.address(pub("provider")), sv.bytes(declaration)]);
    await invoke(state, "steward2", ow, "approve_lender", [sv.address(shares2), sv.address(pub("provider")), sv.bool(true)]);
    console.log("  provider approved on both funds, by each fund's own issuer");
  });

  await once(state, "dualOffer", "Offer in tEUR that lists both funds", async () => {
    if (state.ids.dualOffer !== undefined) return;
    // The provider's tEUR is mostly locked in the first two offers: top it up for this one.
    const held = BigInt(await read(state, state.contracts.euro, "balance", [sv.address(pub("provider"))]));
    if (held < OFFERS.dual.amount) {
      await classic(state, "euroIssuer", Operation.payment({ destination: pub("provider"), asset: teur, amount: fmtUnits(OFFERS.dual.amount - held) }));
    }
    const dual = await invoke(state, "provider", ow, "create_offer", [
      sv.address(pub("provider")),
      sv.address(state.contracts.euro),
      sv.i128(OFFERS.dual.amount),
      sv.u32(OFFERS.dual.rateBps),
      sv.u64(7 * 24 * 3600),
      sv.vec([sv.address(shares), sv.address(shares2)]),
    ]);
    state.ids.dualOffer = Number(dual.value);
    saveState(state);
    console.log(`  offer #${state.ids.dualOffer} ${fmt(OFFERS.dual.amount, 7, 0)} tEUR at ${OFFERS.dual.rateBps / 100} %, over the T-bill fund and the euro fund`);
  });

  await once(state, "secondOffer", "Offer in tEURB on the euro fund", async () => {
    if (state.ids.secondOffer !== undefined) return;
    const second = await invoke(state, "provider", ow, "create_offer", [
      sv.address(pub("provider")),
      sv.address(state.contracts.euro2),
      sv.i128(OFFERS.second.amount),
      sv.u32(OFFERS.second.rateBps),
      sv.u64(7 * 24 * 3600),
      sv.vec([sv.address(shares2)]),
    ]);
    state.ids.secondOffer = Number(second.value);
    saveState(state);
    console.log(`  offer #${state.ids.secondOffer} ${fmt(OFFERS.second.amount, 7, 0)} tEURB at ${OFFERS.second.rateBps / 100} %, euro fund only`);
  });
}

main().catch((error) => {
  console.error(`\nSetup failed: ${error.message}`);
  console.error("Run it again: completed steps are skipped.");
  process.exit(1);
});
