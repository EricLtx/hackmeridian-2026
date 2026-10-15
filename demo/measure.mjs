// Measures, on the live testnet deployment, what each main operation costs
// the network: CPU instructions, ledger entries and bytes read and written,
// and the resource fee, by simulation (nothing is submitted). Also measures
// the rent of the contract's code entry per day of time to live.
//
//   npm run measure
//
// The test host counts entries but not the code of the contracts a call
// reaches (tokens, feeds); simulation on the network does, so these are the
// figures to budget with.

import { Operation, TransactionBuilder, rpc, SorobanDataBuilder } from "@stellar/stellar-sdk";
import {
  ONE,
  PASSPHRASE,
  asset,
  codeKey,
  keypair,
  ledgerEntries,
  loadState,
  net,
  server,
  storageKey,
  sv,
} from "./lib.mjs";

const state = loadState();
const C = state.contracts;
const pub = (role) => keypair(state, role).publicKey();

async function simulate(role, operation, sorobanData) {
  const account = await net(() => server.getAccount(pub(role)), "account");
  let builder = new TransactionBuilder(account, { fee: "100", networkPassphrase: PASSPHRASE }).addOperation(operation).setTimeout(60);
  if (sorobanData) builder = builder.setSorobanData(sorobanData);
  const sim = await net(() => server.simulateTransaction(builder.build()), "simulate");
  if (rpc.Api.isSimulationError(sim)) return { error: sim.error.split("\n")[0] };
  const data = sim.transactionData.build();
  const r = data.resources;
  return {
    instructions: Number(r.instructions),
    read: r.footprint.readOnly.length + r.footprint.readWrite.length,
    written: r.footprint.readWrite.length,
    readBytes: Number(r.diskReadBytes ?? r.readBytes ?? 0),
    writeBytes: Number(r.writeBytes),
    fee: Number(sim.minResourceFee) / 1e7,
  };
}

const call = (fn, args) => Operation.invokeContractFunction({ contract: C.openWindow, function: fn, args });
const fund = sv.address(C.shares);
const staged = sv.u64(state.ids.stagedRepo ?? 1);

const cases = [
  ["quote (read only)", "operator", call("quote", [fund, sv.i128(1_000n * ONE), sv.address(C.euro)])],
  ["create_offer", "provider", call("create_offer", [sv.address(pub("provider")), sv.address(C.euro), sv.i128(1_000n * ONE), sv.u32(300), sv.u64(24 * 3600), sv.vec([fund])])],
  ["open_repo", "borrower", call("open_repo", [sv.address(pub("borrower")), sv.u64(state.ids.sponsorOffer ?? 1), fund, sv.i128(1_000n * ONE), sv.i128(800n * ONE), sv.u64(24 * 3600)])],
  ["repurchase", "borrower", call("repurchase", [staged])],
  ["seize", "provider", call("seize", [staged, sv.address(pub("provider"))])],
  ["withdraw_offer", "provider", call("withdraw_offer", [sv.u64(state.ids.marketOffer ?? 2), sv.i128(ONE)])],
  ["refresh_reference", "operator", call("refresh_reference", [fund])],
];

async function main() {
  console.log(`Network cost per operation, Open Window ${C.openWindow.slice(0, 8)}…, simulated ${new Date().toISOString()}`);
  console.log(`${"operation".padEnd(20)} ${"CPU instr".padStart(11)} ${"entries r/w".padStart(12)} ${"bytes r/w".padStart(14)} ${"resource fee".padStart(13)}`);
  const rows = [];
  for (const [label, role, op] of cases) {
    const m = await simulate(role, op);
    rows.push({ label, ...m });
    if (m.error) {
      console.log(`${label.padEnd(20)} ${m.error.slice(0, 70)}`);
      continue;
    }
    console.log(`${label.padEnd(20)} ${m.instructions.toLocaleString("en-US").padStart(11)} ${`${m.read}/${m.written}`.padStart(12)} ${`${m.readBytes}/${m.writeBytes}`.padStart(14)} ${`${m.fee.toFixed(4)} XLM`.padStart(13)}`);
  }

  // Code rent: the cost of one more day of time to live, from two extensions.
  const instance = await ledgerEntries([storageKey(C.openWindow)]);
  const raw = instance.entries[0]?.value?.contractData?.val?.instance?.executable?.wasmHash;
  const key = codeKey(typeof raw.toXDR === "function" ? raw.toXDR() : raw);
  const code = await ledgerEntries([key]);
  const left = code.entries[0].liveUntil - code.latest;
  const day = 17_280;
  const payer = state.keys.keeper ? "keeper" : "operator";
  const extend = (ledgers) => simulate(payer, Operation.extendFootprintTtl({ extendTo: ledgers }), new SorobanDataBuilder().setReadOnly([key]).build());
  const plus1 = await extend(left + day);
  const plus11 = await extend(left + 11 * day);
  const perDay = (plus11.fee - plus1.fee) / 10;
  console.log(`\nContract code: ${(left / day).toFixed(1)} days to live; rent ≈ ${perDay.toFixed(2)} XLM per day of time to live (≈ ${(perDay * 30).toFixed(0)} XLM per 30 days, ≈ ${(perDay * 365).toFixed(0)} XLM per year)`);
}

main().catch((error) => {
  console.error(`Measure failed: ${error.message}`);
  process.exit(1);
});
