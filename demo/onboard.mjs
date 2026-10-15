// Onboards an outside testnet wallet (Freighter or any other) into the demo,
// so a judge or a tester can use the web interface with their own key.
//
//   npm run onboard -- G...ADDRESS                 borrower: shares and a little tEUR
//   npm run onboard -- G...ADDRESS --role=lender   lender: approval and tEUR to lend
//
// The wallet must hold a tEUR trustline first; the web interface adds it in
// one click ("Add tEUR"). The demo keys sign every other step: the steward
// allowlists and mints, the euro issuer pays. Testnet only.

import { Asset, ONE, Operation, StrKey } from "./lib.mjs";
import { ContractError, classic, fmt, friendbot, invoke, keypair, loadState, read, sv } from "./lib.mjs";

const SHARES_FOR_BORROWER = 10_000n * ONE;
const TEUR = { borrower: 1_000n * ONE, lender: 50_000n * ONE };

async function main() {
  const address = process.argv.slice(2).find((a) => a.startsWith("G"));
  const role = process.argv.find((a) => a.startsWith("--role="))?.slice(7) ?? "borrower";
  if (!address || !StrKey.isValidEd25519PublicKey(address)) throw new Error("usage: npm run onboard -- G...ADDRESS [--role=lender]");
  if (!(role in TEUR)) throw new Error("--role takes borrower or lender");

  const state = loadState();
  const C = state.contracts;
  if (!C?.openWindow) throw new Error("no deployment: run `npm run setup` first");

  await friendbot(address);
  console.log(`  account ${address} funded with test XLM (or already funded)`);

  const listed = await read(state, C.shares, "is_whitelisted", [sv.address(address)]);
  if (!listed) await invoke(state, "steward", C.shares, "set_whitelisted", [sv.address(address), sv.bool(true)]);
  console.log("  allowlisted by the fund issuer");

  if (role === "borrower") {
    const held = BigInt(await read(state, C.shares, "balance", [sv.address(address)]));
    if (held < SHARES_FOR_BORROWER) {
      await invoke(state, "steward", C.shares, "mint", [sv.address(address), sv.i128(SHARES_FOR_BORROWER - held)]);
    }
    console.log(`  holds ${fmt(SHARES_FOR_BORROWER, 7, 0)} fund shares`);
  } else {
    // Since version 4 a lender needs an attestation signed by itself and the issuer, and this
    // demo instance runs in mode D3: only its sole lender may make offers.
    const sole = await read(state, C.openWindow, "sole_lender");
    if (sole && sole !== address) {
      console.log(`\n  This instance is run by a single lender (${sole.slice(0, 8)}…): other wallets cannot lend here.`);
      console.log("  Onboard this wallet as a borrower instead, or deploy a separate instance with it as the sole lender.");
      return;
    }
    console.log("  lender onboarding needs the wallet's own signature on `attest_lender`; not available from this script");
  }

  let euros;
  try {
    euros = BigInt(await read(state, C.euro, "balance", [sv.address(address)]));
  } catch (error) {
    if (error instanceof ContractError && /TrustlineMissing|AccountMissing/.test(error.name)) {
      console.log("\n  No tEUR trustline yet: click \"Add tEUR\" in the web interface, then run this command again.");
      return;
    }
    throw error;
  }
  const target = TEUR[role];
  if (euros < target) {
    const teur = new Asset("tEUR", keypair(state, "euroIssuer").publicKey());
    const missing = target - euros;
    const amount = `${missing / ONE}.${(missing % ONE).toString().padStart(7, "0")}`;
    await classic(state, "euroIssuer", Operation.payment({ destination: address, asset: teur, amount }));
  }
  console.log(`  holds ${fmt(target)} tEUR`);
  console.log(`\n  Ready: open the web interface and connect ${address.slice(0, 6)}… as ${role}.`);
}

main().catch((error) => {
  console.error(`\nOnboarding failed: ${error.message}`);
  process.exit(1);
});
