// Deploys and configures the Open Window demo on Stellar testnet.
//
//   npm run setup              resumes where the last run stopped
//   npm run setup -- --fresh   new contracts (keeps the funded accounts)
//   npm run setup -- --restage new short repo for the seizure scene
//   npm run setup -- --fx=local     re-admit the fund on the local FX feed
//   npm run setup -- --fx=reflector back to the Reflector FX feed
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
  sv,
  writeDeployment,
} from "./lib.mjs";
import { FALLBACK_EUR_USD, FUND_SETTINGS, NAV_USD_AT_SETUP, OFFERS, navAt } from "./config.mjs";

const ROLES = ["governor", "guardian", "steward", "operator", "euroIssuer", "lender", "borrower"];

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
    for (const role of ["lender", "steward", "borrower"]) {
      await classic(state, role, Operation.changeTrust({ asset: teur }));
    }
    state.contracts.euro = await deploySac(state, "euroIssuer", teur);
    saveState(state);
    console.log(`  tEUR contract ${state.contracts.euro}`);
    // Tops each holder up to its target, so a rerun never pays twice.
    const funding = { lender: 200_000n, steward: 500_000n, borrower: 2_000n };
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

  const ow = state.contracts.openWindow;
  const shares = state.contracts.shares;

  await once(state, "governor", "Governor: guardian, stablecoin registry, currency cap", async () => {
    await invoke(state, "governor", ow, "set_guardian", [sv.address(pub("guardian"))]);
    await invoke(state, "governor", ow, "set_stablecoin", [sv.address(state.contracts.euro), sv.symbol("EUR")]);
    await invoke(state, "governor", ow, "set_currency_cap", [sv.symbol("EUR"), sv.i128(1_000_000n * ONE)]);
  });

  await once(state, "issuer", "Issuer: allowlist (holders and the contract), mint shares", async () => {
    for (const holder of [pub("borrower"), pub("lender"), pub("steward"), ow]) {
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
      await invoke(state, "governor", ow, "set_fund", [sv.address(shares), fundConfig]);
    },
  );

  await once(state, "lenders", "Steward: approves the market lender and itself as sponsor", async () => {
    await invoke(state, "steward", ow, "approve_lender", [
      sv.address(shares),
      sv.address(pub("lender")),
      sv.bool(true),
    ]);
    await invoke(state, "steward", ow, "approve_lender", [
      sv.address(shares),
      sv.address(pub("steward")),
      sv.bool(true),
    ]);
  });

  const funds = sv.vec([sv.address(shares)]);
  await once(state, "sponsorOffer", "Offers: the issuer's sponsor offer", async () => {
    if (state.ids.sponsorOffer === undefined) {
      const sponsor = await invoke(state, "steward", ow, "create_offer", [
        sv.address(pub("steward")),
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
    console.log(`  sponsor offer #${state.ids.sponsorOffer} 300,000 tEUR at 2.50 %`);
  });

  await once(state, "marketOffer", "Offers: a market offer", async () => {
    if (state.ids.marketOffer !== undefined) return;
    const market = await invoke(state, "lender", ow, "create_offer", [
      sv.address(pub("lender")),
      sv.address(state.contracts.euro),
      sv.i128(OFFERS.market.amount),
      sv.u32(OFFERS.market.rateBps),
      sv.u64(7 * 24 * 3600),
      funds,
    ]);
    state.ids.marketOffer = Number(market.value);
    saveState(state);
    console.log(`  market offer  #${state.ids.marketOffer} 150,000 tEUR at 3.50 %`);
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

  writeDeployment(state);
  console.log("\n  Public addresses written to web/public/deployment.testnet.json for the web interface.");
  console.log("\nSetup complete. Run `npm run demo` from one hour after now.");
}

main().catch((error) => {
  console.error(`\nSetup failed: ${error.message}`);
  console.error("Run it again: completed steps are skipped.");
  process.exit(1);
});
