// Key ceremony tooling for the role accounts of Open Window (native multisig).
//
//   npm run keys -- --plan --account G... --signer G...:1 --signer G...:1 --signer G...:1 \
//                   --low 2 --medium 2 --high 3 [--master 0] [--valid-hours 24]
//       builds ONE unsigned transaction carrying every setOptions (signers with
//       their weights, thresholds, master weight), checks that the target state
//       cannot lock the account, prints a summary table, the transaction hash
//       and the XDR to sign offline (hardware wallet or another machine)
//   npm run keys -- --readback --account G...|<role> [--expect <plan.json> | --signer ... --low ...]
//       reads the account from the ledger and prints signers, weights and
//       thresholds; compares them to a plan when one is given
//   npm run keys -- --submit --xdr <base64>
//       submits a signed envelope and waits for it to land
//   npm run keys -- --rehearse
//       full rehearsal on testnet with throwaway software keys: funds an account,
//       applies the plan (master 0, thresholds 2/2/3, three signers), reads it
//       back, proves that one key is refused (tx_bad_auth) and two keys pass,
//       and writes minutes to demo/.state/ceremony-<date>.md
//
// No secret key is ever taken as input or written anywhere. The rehearsal
// keeps its throwaway secrets in memory only. The thresholds that matter for
// the contract are the account's MEDIUM threshold: the Soroban host checks a
// G-account's signatures against it (key-custody memo, section 1.1).

import fs from "node:fs";
import path from "node:path";
import {
  Asset,
  Keypair,
  Memo,
  Operation,
  StrKey,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import {
  PASSPHRASE,
  RPC_URL,
  STATE_DIR,
  explorer,
  friendbot,
  keypair,
  ledgerTime,
  loadState,
  net,
  server,
  sleep,
} from "./lib.mjs";

/** Hours a ceremony transaction stays valid when built for offline signing. */
const DEFAULT_VALID_HOURS = 24;
/** Seconds a rehearsal transaction stays valid: signed and sent at once. */
const REHEARSAL_VALIDITY_SECS = 60;
/** Base fee per operation, in stroops; generous so the ceremony never waits on a surge. */
const BASE_FEE = "10000";
/** Protocol limit on signers (master key included) and on signatures per transaction. */
const MAX_SIGNERS = 20;

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

/** `--flag value`, `--flag=value` or bare `--flag`; repeated flags collect into arrays. */
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    let key = token.slice(2);
    let value = true;
    const eq = key.indexOf("=");
    if (eq >= 0) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      value = argv[i + 1];
      i += 1;
    }
    if (key in args) args[key] = [].concat(args[key], value);
    else args[key] = value;
  }
  return args;
}

function fail(message) {
  throw new Error(message);
}

/** A threshold or weight: an integer from 0 to 255. */
function level(value, name) {
  if (value === undefined || value === true) fail(`--${name} is required`);
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 255) fail(`--${name} must be an integer from 0 to 255, got ${value}`);
  return n;
}

/** `G...:weight` into { key, weight }. */
function parseSigner(text) {
  const [key, weightText, extra] = String(text).split(":");
  if (extra !== undefined || !weightText) fail(`--signer takes G...:weight, got ${text}`);
  if (!StrKey.isValidEd25519PublicKey(key)) fail(`--signer ${key} is not a valid ed25519 public key (G...)`);
  const weight = Number(weightText);
  if (!Number.isInteger(weight) || weight < 1 || weight > 255) fail(`--signer ${key}: weight must be 1 to 255, got ${weightText}`);
  return { key, weight };
}

/**
 * The account to work on: a G-address, or the name of a demo role whose
 * public key is read from the state file (the secret stays there, unused).
 */
function resolveAccount(value) {
  if (value === undefined || value === true) fail("--account is required (a G... address or a demo role name)");
  if (StrKey.isValidEd25519PublicKey(value)) return value;
  const state = loadState();
  if (state.keys?.[value]) return keypair(state, value).publicKey();
  fail(`--account ${value} is neither a G... address nor a role of demo/.state/testnet.json`);
}

// ---------------------------------------------------------------------------
// Plan: target state, checks, transaction
// ---------------------------------------------------------------------------

/**
 * Reads a plan from the flags: { account, signers, low, medium, high, master }.
 * `master` defaults to 0 (the recommended target: the master key can no
 * longer sign), as in the memo's guarded-launch design.
 */
function planFromArgs(args) {
  const signers = [].concat(args.signer ?? []).map(parseSigner);
  return {
    account: resolveAccount(args.account),
    signers,
    low: level(args.low, "low"),
    medium: level(args.medium, "medium"),
    high: level(args.high, "high"),
    master: args.master === undefined ? 0 : level(args.master, "master"),
  };
}

/**
 * Checks that the target state is coherent and cannot lock the account.
 * Returns { errors, warnings }: an error refuses the plan, a warning is
 * printed and signed off by the people in the room.
 */
export function checkPlan(plan) {
  const errors = [];
  const warnings = [];
  const { account, signers, low, medium, high, master } = plan;
  const seen = new Set();
  for (const { key } of signers) {
    if (key === account) errors.push(`${key} is the account itself: its weight is the master weight (--master), not a signer entry`);
    if (seen.has(key)) errors.push(`${key} is listed twice as a signer`);
    seen.add(key);
  }
  if (signers.length + 1 > MAX_SIGNERS) errors.push(`${signers.length} signers plus the master key exceed the protocol limit of ${MAX_SIGNERS}`);
  if (!(low <= medium && medium <= high)) errors.push(`thresholds must satisfy low <= medium <= high, got ${low}/${medium}/${high}`);
  const extra = signers.reduce((sum, s) => sum + s.weight, 0);
  const total = master + extra;
  if (medium === 0) {
    errors.push("medium threshold 0: any single signer would authorize every contract call (the host checks the medium threshold); set it explicitly");
  }
  if (total < high) {
    errors.push(`total weight ${total} (master ${master} + signers ${extra}) is below the high threshold ${high}: no quorum could ever change the signers again (locked account)`);
  }
  if (total < medium) {
    errors.push(`total weight ${total} is below the medium threshold ${medium}: the account could never act as a contract role`);
  }
  if (total < low) errors.push(`total weight ${total} is below the low threshold ${low}`);
  if (master === 0 && signers.length === 0) errors.push("master weight 0 with no signer: nobody could ever sign for the account");
  if (master > 0 && master >= medium) {
    warnings.push(`the master key alone (weight ${master}) reaches the medium threshold ${medium}: one key controls the contract role`);
  }
  if (signers.length) {
    const heaviest = Math.max(...signers.map((s) => s.weight));
    const remaining = total - heaviest;
    if (remaining < medium) {
      warnings.push(`losing the heaviest signer (weight ${heaviest}) leaves ${remaining} < medium ${medium}: one lost key freezes the contract role until the account is handed over`);
    }
    if (remaining < high) {
      warnings.push(`losing the heaviest signer leaves ${remaining} < high ${high}: one lost key blocks every signer rotation; the role would have to move to a fresh account (set_admin / accept_admin)`);
    }
  }
  return { errors, warnings };
}

/**
 * Builds the single setOptions transaction of a plan. The signer additions
 * come first, the thresholds and master weight last, so each operation is
 * still authorized by the state that precedes it; nothing applies unless all
 * of them apply. Returns the unsigned transaction.
 */
async function buildPlanTransaction(plan, validitySecs) {
  const account = await net(() => server.getAccount(plan.account), "account");
  const builder = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASSPHRASE });
  for (const { key, weight } of plan.signers) {
    builder.addOperation(Operation.setOptions({ signer: { ed25519PublicKey: key, weight } }));
  }
  builder.addOperation(
    Operation.setOptions({
      masterWeight: plan.master,
      lowThreshold: plan.low,
      medThreshold: plan.medium,
      highThreshold: plan.high,
    }),
  );
  return builder.setTimeout(validitySecs).build();
}

/** Current signers, weights and thresholds of an account, from the ledger. */
export async function readAccount(publicKey) {
  const key = xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(publicKey).xdrAccountId() }));
  const response = await net(() => server.getLedgerEntries(key), "ledger entries");
  const entry = response.entries?.[0];
  if (!entry) fail(`account ${publicKey} does not exist on ${RPC_URL}`);
  // SDK 17 decodes the entry into plain objects (`{ type, account }`, strkey
  // signers, `Thresholds { value }`); older builds expose XDR accessors.
  const acc = typeof entry.val.account === "function" ? entry.val.account() : entry.val.account;
  const field = (name) => (typeof acc[name] === "function" ? acc[name]() : acc[name]);
  const rawThresholds = field("thresholds");
  const [master, low, medium, high] = Array.from(rawThresholds?.value ?? rawThresholds);
  const signers = field("signers").map((s) => ({
    key: signerKeyToString(typeof s.key === "function" ? s.key() : s.key),
    weight: Number(typeof s.weight === "function" ? s.weight() : s.weight),
  }));
  return {
    account: publicKey,
    ledger: response.latestLedger,
    sequence: field("seqNum").toString(),
    balance: field("balance").toString(),
    master,
    low,
    medium,
    high,
    signers,
  };
}

/**
 * Strkey of a signer key of any protocol type. Accepts the SDK 17 decoded
 * form (`{ type: "signerKeyTypeEd25519", ed25519: bytes }`), an
 * `xdr.SignerKey` with accessors, or a strkey string.
 */
function signerKeyToString(signerKey) {
  if (typeof signerKey === "string") return signerKey;
  const type = typeof signerKey.switch === "function" ? signerKey.switch().name : signerKey.type;
  const arm = (name) => {
    const raw = typeof signerKey[name] === "function" ? signerKey[name]() : signerKey[name];
    return Buffer.from(raw?.value ?? raw);
  };
  switch (type) {
    case "signerKeyTypeEd25519":
      return StrKey.encodeEd25519PublicKey(arm("ed25519"));
    case "signerKeyTypePreAuthTx":
      return StrKey.encodePreAuthTx(arm("preAuthTx"));
    case "signerKeyTypeHashX":
      return StrKey.encodeSha256Hash(arm("hashX"));
    default:
      return `${type}:unsupported signer type`;
  }
}

/**
 * Compares an account read from the ledger with a plan. Returns the list of
 * differences, empty when the account matches the plan exactly: same
 * thresholds, same master weight, same signers with the same weights, and no
 * signer the plan does not name.
 */
export function compareToPlan(account, plan) {
  const diffs = [];
  for (const field of ["low", "medium", "high", "master"]) {
    if (account[field] !== plan[field]) diffs.push(`${field}: on chain ${account[field]}, plan ${plan[field]}`);
  }
  for (const { key, weight } of plan.signers) {
    const actual = account.signers.find((s) => s.key === key)?.weight ?? 0;
    if (actual !== weight) diffs.push(`signer ${key}: on chain weight ${actual}, plan ${weight}`);
  }
  for (const { key, weight } of account.signers) {
    if (!plan.signers.some((s) => s.key === key)) diffs.push(`signer ${key}: on chain weight ${weight}, not in the plan`);
  }
  return diffs;
}

// ---------------------------------------------------------------------------
// Submission (classic transactions, no simulation)
// ---------------------------------------------------------------------------

/** Result code name of a transaction result XDR object (`txBadAuth`, `txFailed`...). */
function resultCodeOf(result) {
  try {
    // SDK 17 decodes the result into `{ result: { type } }`; XDR objects have accessors.
    const inner = typeof result?.result === "function" ? result.result() : result?.result;
    const type = typeof inner?.switch === "function" ? inner.switch().name : inner?.type;
    return type ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Submits a signed transaction and returns `{ hash, ledger }` once it has
 * landed, or throws with the result code: `refused:<code>` when the network
 * rejects it at submission (a `txBadAuth` for a missing signature is such a
 * refusal), `failed:<code>` when it applied and failed, `expired` when the
 * validity window closed without it landing.
 */
async function submitSigned(tx, label) {
  const hash = Buffer.from(tx.hash()).toString("hex");
  const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
  const sent = await net(() => server.sendTransaction(tx), label);
  if (sent.status === "ERROR") {
    throw new Error(`${label}: refused:${resultCodeOf(sent.errorResult)}`);
  }
  if (sent.status !== "PENDING" && sent.status !== "DUPLICATE" && sent.status !== "TRY_AGAIN_LATER") {
    throw new Error(`${label}: unexpected submission status ${sent.status}`);
  }
  for (;;) {
    let known = null;
    try {
      known = await server.getTransaction(hash);
    } catch {
      // RPC hiccup: keep polling.
    }
    if (known?.status === "SUCCESS") return { hash, ledger: known.ledger };
    if (known?.status === "FAILED") throw new Error(`${label}: failed:${resultCodeOf(known.resultXdr)} ${explorer(hash)}`);
    let closed = 0;
    try {
      closed = await ledgerTime();
    } catch {
      // Unreachable RPC: keep polling.
    }
    if (maxTime && closed > maxTime + 5) throw new Error(`${label}: expired before landing; nothing changed on chain`);
    await sleep(1000);
  }
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

function table(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  for (const row of rows) console.log(`  ${row.map((cell, i) => String(cell).padEnd(widths[i])).join("  ")}`);
}

function printAccount(account, title) {
  console.log(`\n${title}`);
  console.log(`  account   ${account.account}`);
  console.log(`  ledger    ${account.ledger}   sequence ${account.sequence}   balance ${(Number(account.balance) / 1e7).toFixed(2)} XLM`);
  console.log(`  thresholds low ${account.low}  medium ${account.medium}  high ${account.high}   master weight ${account.master}`);
  const rows = [["signer", "weight", "kind"], [account.account, account.master, "master key"]];
  for (const s of account.signers) rows.push([s.key, s.weight, s.key.startsWith("G") ? "ed25519" : "other (cannot sign a Soroban entry)"]);
  table(rows);
  const total = account.master + account.signers.reduce((sum, s) => sum + s.weight, 0);
  console.log(`  total weight ${total}; a contract call needs ${account.medium}, a signer change needs ${account.high}`);
}

function printPlanSummary(plan) {
  console.log(`\nTarget state for ${plan.account}`);
  const rows = [["signer", "weight", "role in the plan"], [plan.account, plan.master, plan.master === 0 ? "master key, disabled" : "master key"]];
  for (const s of plan.signers) rows.push([s.key, s.weight, "signer"]);
  table(rows);
  const total = plan.master + plan.signers.reduce((sum, s) => sum + s.weight, 0);
  console.log(`  thresholds low ${plan.low}  medium ${plan.medium}  high ${plan.high}   total weight ${total}`);
}

/** Lines that describe each operation of the plan transaction, in order. */
function describeOperations(plan) {
  const lines = plan.signers.map((s, i) => `${i + 1}. setOptions: add signer ${s.key} with weight ${s.weight}`);
  lines.push(`${plan.signers.length + 1}. setOptions: master weight ${plan.master}, thresholds low ${plan.low} / medium ${plan.medium} / high ${plan.high}`);
  return lines;
}

/** Writes the plan to a JSON file when `--out` is given, for `--readback --expect`. */
function savePlan(plan, file) {
  const target = path.resolve(file);
  fs.writeFileSync(target, `${JSON.stringify(plan, null, 2)}\n`);
  console.log(`\n  plan written to ${target} (public keys and levels only)`);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdPlan(args) {
  const plan = planFromArgs(args);
  if (plan.signers.length === 0) fail("--plan needs at least one --signer G...:weight");
  const { errors, warnings } = checkPlan(plan);
  printPlanSummary(plan);
  for (const w of warnings) console.log(`  warning: ${w}`);
  if (errors.length) {
    console.log("\nPlan refused:");
    for (const e of errors) console.log(`  - ${e}`);
    process.exitCode = 2;
    return;
  }
  const hours = args["valid-hours"] === undefined ? DEFAULT_VALID_HOURS : Number(args["valid-hours"]);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 7) fail("--valid-hours must be between 0 and 168");
  const before = await readAccount(plan.account);
  printAccount(before, "Current state (before)");
  const tx = await buildPlanTransaction(plan, Math.round(hours * 3600));
  console.log("\nTransaction (unsigned, one atomic change)");
  for (const line of describeOperations(plan)) console.log(`  ${line}`);
  console.log(`  network    ${PASSPHRASE}`);
  console.log(`  source     ${plan.account}   sequence ${tx.sequence}   fee ${tx.fee} stroops`);
  console.log(`  valid until ${new Date(Number(tx.timeBounds.maxTime) * 1000).toISOString()} (${hours} h)`);
  console.log(`  hash       ${Buffer.from(tx.hash()).toString("hex")}`);
  console.log("  The account must send no other transaction before this one: its sequence number is fixed in the XDR.");
  console.log(`  Signatures needed now: weight ${before.high} at the current high threshold (${before.master === 0 ? "master key disabled" : "the master key weighs " + before.master}).`);
  console.log("\nXDR to sign (base64, TransactionEnvelope):");
  console.log(tx.toEnvelope().toXDR("base64"));
  console.log("\nAfter signing: npm run keys -- --submit --xdr <signed base64>, then --readback --account ... --expect <plan.json>");
  if (args.out && args.out !== true) savePlan(plan, args.out);
}

/** The expectation of `--readback --expect`: a plan file, or the plan flags. */
function expectedPlan(args) {
  if (args.expect === undefined) return null;
  if (args.expect !== true && fs.existsSync(args.expect)) {
    const plan = JSON.parse(fs.readFileSync(args.expect, "utf8"));
    for (const field of ["account", "signers", "low", "medium", "high", "master"]) {
      if (plan[field] === undefined) fail(`${args.expect}: plan file lacks the field ${field}`);
    }
    return plan;
  }
  if (args.signer === undefined) fail("--expect takes a plan file written by --plan --out, or the plan flags (--signer, --low, --medium, --high, --master)");
  return planFromArgs(args);
}

async function cmdReadback(args) {
  const account = await readAccount(resolveAccount(args.account));
  printAccount(account, "State on chain");
  const plan = expectedPlan(args);
  if (!plan) return;
  if (plan.account !== account.account) fail(`the plan is for ${plan.account}, not ${account.account}`);
  const diffs = compareToPlan(account, plan);
  if (diffs.length === 0) {
    console.log("\n  matches the plan");
    return;
  }
  console.log("\n  differs from the plan:");
  for (const d of diffs) console.log(`  - ${d}`);
  process.exitCode = 3;
}

async function cmdSubmit(args) {
  if (!args.xdr || args.xdr === true) fail("--submit needs --xdr <signed TransactionEnvelope, base64>");
  const tx = TransactionBuilder.fromXDR(args.xdr, PASSPHRASE);
  const signatures = tx.signatures?.length ?? 0;
  console.log(`  ${tx.operations.length} operation(s), ${signatures} signature(s), hash ${Buffer.from(tx.hash()).toString("hex")}`);
  if (signatures === 0) fail("the envelope carries no signature");
  const { hash, ledger } = await submitSigned(tx, "submit");
  console.log(`  landed in ledger ${ledger}: ${explorer(hash)}`);
  console.log(`  read the account back: npm run keys -- --readback --account ${tx.source}`);
}

// ---------------------------------------------------------------------------
// Rehearsal
// ---------------------------------------------------------------------------

/**
 * Signs a payment to self (a medium-threshold operation) by the given keys and
 * reports the outcome without throwing. The memo names the proof, so two
 * proofs built on the same sequence number never share a hash.
 */
async function proveQuorum(accountKey, keys, label) {
  const account = await net(() => server.getAccount(accountKey), "account");
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(Operation.payment({ destination: accountKey, asset: Asset.native(), amount: "1" }))
    .addMemo(Memo.text(label.slice(0, 28)))
    .setTimeout(REHEARSAL_VALIDITY_SECS)
    .build();
  for (const key of keys) tx.sign(key);
  const hash = Buffer.from(tx.hash()).toString("hex");
  try {
    const { ledger } = await submitSigned(tx, label);
    return { hash, outcome: "landed", detail: `ledger ${ledger}`, ledger };
  } catch (error) {
    const code = /(refused|failed|expired)(?::(\w+))?/.exec(error.message);
    return { hash, outcome: code?.[1] ?? "error", detail: code?.[2] ?? error.message };
  }
}

/** Markdown lines describing an account state, for the minutes. */
function accountMarkdown(account) {
  const lines = [
    `- Ledger ${account.ledger}, sequence ${account.sequence}, balance ${(Number(account.balance) / 1e7).toFixed(2)} XLM`,
    `- Thresholds: low ${account.low}, medium ${account.medium}, high ${account.high}; master weight ${account.master}`,
    "",
    "| Signer | Weight |",
    "|---|---|",
    `| ${account.account} (master) | ${account.master} |`,
  ];
  for (const s of account.signers) lines.push(`| ${s.key} | ${s.weight} |`);
  return lines.join("\n");
}

async function cmdRehearse() {
  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/:/g, "").replace(/\.\d{3}Z$/, "Z");
  console.log("Key ceremony rehearsal on testnet, throwaway software keys (never written to disk)\n");

  // 1. A fresh account and three signers. The master key signs the ceremony
  //    transaction, then is disabled by it.
  const master = Keypair.random();
  const signers = [Keypair.random(), Keypair.random(), Keypair.random()];
  console.log(`▸ Account ${master.publicKey()} funded by friendbot`);
  await friendbot(master.publicKey());
  const plan = {
    account: master.publicKey(),
    signers: signers.map((k) => ({ key: k.publicKey(), weight: 1 })),
    low: 2,
    medium: 2,
    high: 3,
    master: 0,
  };
  const { errors, warnings } = checkPlan(plan);
  if (errors.length) fail(`rehearsal plan refused: ${errors.join("; ")}`);
  printPlanSummary(plan);
  for (const w of warnings) console.log(`  warning: ${w}`);

  const before = await readAccount(plan.account);
  printAccount(before, "State before");

  // 2. One atomic transaction, signed by the master key alone (it still
  //    weighs 1 against thresholds of 0 until the last operation applies).
  console.log("\n▸ Applying the plan in one transaction");
  const tx = await buildPlanTransaction(plan, REHEARSAL_VALIDITY_SECS);
  tx.sign(master);
  const applied = await submitSigned(tx, "ceremony");
  console.log(`  landed in ledger ${applied.ledger}: ${explorer(applied.hash)}`);

  // 3. Read back and compare.
  const after = await readAccount(plan.account);
  printAccount(after, "State after");
  const diffs = compareToPlan(after, plan);
  const readbackOk = diffs.length === 0;
  console.log(readbackOk ? "  matches the plan" : `  differs from the plan: ${diffs.join("; ")}`);

  // 4. Proofs on a medium-threshold operation (a payment to self).
  console.log("\n▸ Proof 1: one signer alone (weight 1 < medium 2) must be refused");
  const one = await proveQuorum(plan.account, [signers[0]], "proof 1: one signer");
  const oneOk = one.outcome === "refused" && one.detail === "txBadAuth";
  console.log(`  ${one.outcome} ${one.detail}  ${oneOk ? "as expected" : "UNEXPECTED"}   hash ${one.hash}`);

  console.log("\n▸ Proof 2: two signers (weight 2 = medium 2) must pass");
  const two = await proveQuorum(plan.account, [signers[0], signers[1]], "proof 2: two signers");
  const twoOk = two.outcome === "landed";
  console.log(`  ${two.outcome} ${two.detail}  ${twoOk ? "as expected" : "UNEXPECTED"}   ${twoOk ? explorer(two.hash) : "hash " + two.hash}`);

  // 5. Minutes. Public keys and hashes only.
  const verdict = readbackOk && oneOk && twoOk ? "PASSED" : "FAILED";
  const minutes = [
    `# Key ceremony rehearsal, ${startedAt.toISOString()}`,
    "",
    `Network: Stellar testnet (\`${PASSPHRASE}\`), RPC ${RPC_URL}. Throwaway software keys generated in memory by \`npm run keys -- --rehearse\`; no secret key appears in these minutes or on disk.`,
    "",
    `**Result: ${verdict}**`,
    "",
    "## Account and plan",
    "",
    `- Account: ${plan.account}`,
    `- Target: master weight ${plan.master}; thresholds low ${plan.low} / medium ${plan.medium} / high ${plan.high}`,
    "",
    "| Signer | Weight |",
    "|---|---|",
    ...plan.signers.map((s) => `| ${s.key} | ${s.weight} |`),
    "",
    "Checks on the plan: no error" + (warnings.length ? `; warnings accepted:\n${warnings.map((w) => `- ${w}`).join("\n")}` : "."),
    "",
    "## State before",
    "",
    accountMarkdown(before),
    "",
    "## Ceremony transaction",
    "",
    ...describeOperations(plan).map((line) => `- ${line}`),
    `- Signed by: the master key alone (weight 1, thresholds 0 before the change)`,
    `- Hash: \`${applied.hash}\`, ledger ${applied.ledger}, ${explorer(applied.hash)}`,
    "",
    "## State after",
    "",
    accountMarkdown(after),
    "",
    `Readback against the plan: ${readbackOk ? "matches" : `differs (${diffs.join("; ")})`}.`,
    "",
    "## Proofs",
    "",
    "| Proof | Signers | Expected | Observed | Hash |",
    "|---|---|---|---|---|",
    `| One key on a medium-threshold operation (payment to self) | ${signers[0].publicKey()} | refused, tx_bad_auth | ${one.outcome} ${one.detail} | \`${one.hash}\` |`,
    `| Two keys on the same operation | ${signers[0].publicKey()}, ${signers[1].publicKey()} | landed | ${two.outcome} ${two.detail} | \`${two.hash}\` |`,
    "",
    "## Participants and devices",
    "",
    "Rehearsal with software keys: no participant, no device. For a real ceremony, list each participant's role, device model, serial number and the two channels on which each public key was confirmed.",
    "",
    "## Backups",
    "",
    "None: throwaway keys. For a real ceremony, list each seed backup's location (vault, not the content) and the person who sealed it.",
    "",
    `Written by demo/keys.mjs at ${new Date().toISOString()}.`,
    "",
  ].join("\n");
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const file = path.join(STATE_DIR, `ceremony-${stamp}.md`);
  fs.writeFileSync(file, minutes);
  console.log(`\nRehearsal ${verdict}. Minutes written to ${file}`);
  if (verdict !== "PASSED") process.exitCode = 4;
}

// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const commands = ["plan", "readback", "submit", "rehearse"].filter((c) => args[c]);
  if (commands.length !== 1) {
    console.error("Usage: npm run keys -- (--plan | --readback | --submit | --rehearse) [options]; see the header of demo/keys.mjs");
    process.exitCode = 1;
    return;
  }
  const [command] = commands;
  if (command === "plan") await cmdPlan(args);
  else if (command === "readback") await cmdReadback(args);
  else if (command === "submit") await cmdSubmit(args);
  else await cmdRehearse();
}

main().catch((error) => {
  console.error(`\nkeys: ${error.message}`);
  process.exitCode = 1;
});
