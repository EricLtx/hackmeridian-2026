// Anchors the journal's last hash on the ledger: a `manageData` operation on
// the anchoring account writes the 32 bytes of the hash under
// `openwindow.indexer.<contract id prefix>`, then the anchor is recorded in
// `.state/anchors.jsonl` for `npm run verify -- --anchors`.
//
//   INDEXER_ANCHOR_SECRET=S... npm run anchor      sign with the operator's anchoring key
//   npm run anchor -- --rehearse                   testnet only: a throwaway key, funded by friendbot
//   npm run anchor -- --contract C...              another contract (default: demo/.state/testnet.json)
//   npm run anchor -- --state <dir>                another state folder (default: indexer/.state)
//
// The key is read from the environment and never written to disk or printed.
// The command refuses a journal whose hash chain is broken: an anchor of
// corrupt data would be worse than none.

import { Keypair, Networks } from "@stellar/stellar-sdk";

import { anchor, anchorDataKey, anchorsFile, appendAnchor, friendbot, networkPassphrase, readAnchors } from "./lib/anchor.mjs";
import { verifyChain } from "./lib/chain.mjs";
import { DEFAULT_STATE_DIR, demoContract, readJournal } from "./lib/journal.mjs";
import { Rpc } from "./lib/rpc.mjs";

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const REHEARSE = args.includes("--rehearse");
const STATE_DIR = option("--state") ?? DEFAULT_STATE_DIR;
const CONTRACT = option("--contract") ?? demoContract();
const PASSPHRASE = networkPassphrase();

if (!CONTRACT || !/^C[A-Z2-7]{55}$/.test(CONTRACT)) {
  console.error("No contract id: pass --contract C... or run the demo's setup so that demo/.state/testnet.json exists.");
  process.exit(1);
}

const rpc = new Rpc(undefined, { log: (t) => console.error(`  (${t})`) });

/** The signing key: the operator's from the environment, or a funded throwaway one under `--rehearse`. */
async function signingKey() {
  const secret = process.env.INDEXER_ANCHOR_SECRET?.trim();
  if (secret) {
    let key;
    try {
      key = Keypair.fromSecret(secret);
    } catch {
      throw new Error("INDEXER_ANCHOR_SECRET is not a valid secret seed (S...)");
    }
    return { key, origin: "INDEXER_ANCHOR_SECRET" };
  }
  if (!REHEARSE) {
    throw new Error("No anchoring key: set INDEXER_ANCHOR_SECRET (S...), or pass --rehearse to use a throwaway testnet account");
  }
  if (PASSPHRASE !== Networks.TESTNET) throw new Error("--rehearse only works on testnet: friendbot funds no other network");
  const key = Keypair.random();
  console.log(`Rehearsal: throwaway account ${key.publicKey()} (funded by friendbot, key kept in memory only)`);
  await friendbot(key.publicKey());
  return { key, origin: "throwaway" };
}

async function main() {
  const { lines, problems } = readJournal(STATE_DIR);
  if (problems.length) throw new Error(`journal has ${problems.length} unreadable line(s): ${problems[0].file}:${problems[0].line}; nothing anchored`);
  const check = verifyChain(lines);
  if (!check.ok) throw new Error(`journal hash chain broken at seq ${check.break.seq}: ${check.break.reason}; nothing anchored`);
  if (!lines.length) throw new Error("journal is empty; nothing to anchor");
  const last = lines[lines.length - 1];
  if (last.contract !== CONTRACT) throw new Error(`journal in ${STATE_DIR} belongs to ${last.contract}; use --state <another folder> for ${CONTRACT}`);

  const { anchors } = readAnchors(STATE_DIR);
  const previous = anchors.length ? anchors[anchors.length - 1] : null;
  if (previous && previous.hash === check.lastHash && previous.lines === check.lines && !args.includes("--force")) {
    console.log(`Already anchored: line ${check.lines}, hash ${check.lastHash.slice(0, 16)}… in transaction ${previous.txHash} (ledger ${previous.ledger}). Pass --force to anchor it again.`);
    return;
  }

  const { key, origin } = await signingKey();
  console.log(`Journal:  ${STATE_DIR}`);
  console.log(`Contract: ${CONTRACT}`);
  console.log(`Lines:    ${check.lines}`);
  console.log(`Hash:     ${check.lastHash}`);
  console.log(`Account:  ${key.publicKey()} (${origin})`);
  console.log(`Data key: ${anchorDataKey(CONTRACT)}`);
  console.log(`RPC:      ${rpc.url}`);

  const record = await anchor(rpc, key, CONTRACT, check.lastHash, check.lines, { passphrase: PASSPHRASE });
  appendAnchor(STATE_DIR, record);
  console.log(`Anchored: transaction ${record.txHash} in ledger ${record.ledger} (${record.at})`);
  console.log(`Recorded: ${anchorsFile(STATE_DIR)}`);
  if (origin === "throwaway") console.log("Rehearsal: the key is gone with this process; the data entry stays on the account until testnet resets.");
}

main().catch((error) => {
  console.error(`Anchor failed: ${error.message}`);
  process.exitCode = 1;
});
