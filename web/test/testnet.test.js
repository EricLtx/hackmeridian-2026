// Full cycle on Stellar testnet through the same chain module the browser
// uses, with a Keypair in place of Freighter. Skipped unless OW_TESTNET=1.
//
// Onboarding (allowlist, shares, tEUR) needs the operator keys, which live
// only in the demo's git-ignored state. The test runs the demo's onboarding
// script; OW_DEMO_DIR points at a demo folder that holds that state
// (default: ../demo next to this web folder).
//
//   OW_TESTNET=1 npm test
//   OW_TESTNET=1 OW_DEMO_DIR=/path/to/checkout/demo npm test

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Keypair } from "@stellar/stellar-sdk";

import { Chain, keypairSigner } from "../src/chain.js";
import { ContractError } from "../src/errors.js";
import { defaultPrincipal, interest, pickOffer } from "../src/terms.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(here, "..");
const DEMO_DIR = process.env.OW_DEMO_DIR ?? path.resolve(WEB, "..", "demo");
const skip = process.env.OW_TESTNET === "1" ? false : "set OW_TESTNET=1 to run against testnet";
const ONE = 10_000_000n;

const deployment = JSON.parse(fs.readFileSync(path.join(WEB, "public", "deployment.testnet.json"), "utf8"));

/** A signer that counts its signatures, to prove refusals never reach the wallet. */
function countingSigner(keypair) {
  const inner = keypairSigner(keypair);
  const signer = { address: inner.address, count: 0, sign: (...args) => ((signer.count += 1), inner.sign(...args)) };
  return signer;
}

const log = (stage) => (s) => {
  if (s.stage === "confirmed") console.log(`    ${stage}: ${s.text} ${s.hash}`);
};

function onboard(address, role) {
  const args = ["onboard.mjs", address, ...(role ? [`--role=${role}`] : [])];
  const run = spawnSync(process.execPath, args, { cwd: DEMO_DIR, encoding: "utf8", timeout: 300_000 });
  assert.equal(run.status, 0, `onboarding failed:\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /Ready/, run.stdout);
}

async function freshWallet(chain) {
  const keypair = Keypair.random();
  const signer = countingSigner(keypair);
  await chain.friendbot(signer.address);
  const before = await chain.balances(signer.address);
  assert.equal(before.stablecoin, null, "a fresh account has no tEUR trustline");
  await chain.addTrustline(signer, log("trustline"));
  assert.equal((await chain.balances(signer.address)).stablecoin, 0n);
  return signer;
}

test("borrower: quote, open, find the position, repurchase", { skip, timeout: 900_000 }, async () => {
  const chain = new Chain(deployment);
  const signer = await freshWallet(chain);
  console.log(`    borrower ${signer.address}`);
  onboard(signer.address);

  const funded = await chain.balances(signer.address);
  assert.ok(funded.shares > 0n, "onboarding mints fund shares");
  assert.ok(funded.stablecoin > 0n, "onboarding pays some tEUR for the interest");

  const shares = 1_000n * ONE;
  const board = await chain.board(shares);
  assert.equal(board.paused.value, false, "the contract is paused");
  assert.ok(board.quote.value, `quote failed: ${board.quote.error?.message}`);
  const quote = BigInt(board.quote.value.max_principal);
  assert.ok(quote > 0n);
  assert.ok(board.nav.value.price > 0n && board.fx.value.price > 0n);

  // A refusal is caught by simulation, before the wallet is asked anything.
  const offer = pickOffer(board.offers.value, chain.fund, quote);
  assert.ok(offer, "no offer holds enough tEUR");
  const signed = signer.count;
  await assert.rejects(
    chain.openRepo(signer, { offerId: offer.id, shares, principal: quote + 1n, term: 3600 }),
    (error) => error instanceof ContractError && error.name === "LoanTooLarge",
  );
  assert.equal(signer.count, signed, "a refused call must not be signed");

  const principal = defaultPrincipal(quote, offer.available);
  const opened = await chain.openRepo(signer, { offerId: offer.id, shares, principal, term: 3600 }, log("open_repo"));
  assert.ok(opened.repoId > 0);

  const afterOpen = await chain.balances(signer.address);
  assert.equal(afterOpen.stablecoin, funded.stablecoin + principal);
  assert.equal(afterOpen.shares, funded.shares - shares);

  // Positions: the full get_repo scan, and the repo_opened events.
  const mine = (await chain.repos()).filter((r) => r.borrower === signer.address);
  assert.deepEqual(mine.map((r) => r.id), [opened.repoId]);
  const repo = mine[0];
  assert.equal(repo.status, "Open");
  assert.equal(repo.principal, principal);
  assert.equal(repo.offer_id, BigInt(offer.id));

  const latest = await chain.server.getLatestLedger();
  const { openings } = await chain.repoOpenings(signer.address, latest.sequence - 200);
  assert.equal(openings.get(opened.repoId)?.txHash, opened.hash, "repo_opened event not found");

  // Within the first hour the contract charges one hour, as the preview says.
  const due = await chain.repoDue(opened.repoId);
  assert.equal(due, interest(principal, repo.rate_bps, 3600));

  await chain.repurchase(signer, opened.repoId, log("repurchase"));
  const closed = await chain.repo(opened.repoId);
  assert.equal(closed.status, "Repurchased");
  const end = await chain.balances(signer.address);
  assert.equal(end.shares, funded.shares, "shares come back");
  assert.equal(end.stablecoin, funded.stablecoin - due, "the cost is one hour of interest");
  await assert.rejects(chain.repoDue(opened.repoId), (e) => e.name === "RepoNotOpen");
});

test("lender: create an offer, find it, withdraw it", { skip, timeout: 900_000 }, async () => {
  const chain = new Chain(deployment);
  const signer = await freshWallet(chain);
  console.log(`    lender ${signer.address}`);
  assert.equal(await chain.isLenderApproved(signer.address), false);
  onboard(signer.address, "lender");
  assert.equal(await chain.isLenderApproved(signer.address), true);

  const start = (await chain.balances(signer.address)).stablecoin;
  const amount = 100n * ONE;
  const created = await chain.createOffer(signer, { amount, rateBps: 300, maxTerm: 86_400 }, log("create_offer"));
  const offer = (await chain.offers()).find((o) => o.id === created.offerId);
  assert.equal(offer.lender, signer.address);
  assert.equal(offer.available, amount);
  assert.equal(offer.rate_bps, 300);
  assert.equal(offer.sponsor, false);

  await chain.withdrawOffer(signer, created.offerId, amount, log("withdraw_offer"));
  const after = (await chain.offers()).find((o) => o.id === created.offerId);
  assert.equal(after.available, 0n);
  assert.equal((await chain.balances(signer.address)).stablecoin, start);
});
