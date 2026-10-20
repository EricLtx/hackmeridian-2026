// send() and extendTtl() against a stubbed RPC that answers what a hostile
// endpoint could (rpc-1): an authorization entry for another call or another
// role, a footprint that writes entries the call does not touch, a resource
// fee beyond the cap. Each is refused before anything is signed or sent.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { beforeEach, test } from "node:test";

process.env.STELLAR_RPC_URLS = "https://rpc.stub.invalid";
process.env.OPEN_WINDOW_STATE = "offline-test";

const { Account, Address, Asset, Keypair, Networks, Operation, SorobanDataBuilder, StrKey, TransactionBuilder, nativeToScVal, rpc, xdr } = await import("@stellar/stellar-sdk");
const lib = await import("../lib.mjs");
const { server } = lib;

const OW = "CCSSOHTBL3LEWUCBBEB5NJFC2OKFRC74OWEIJIZLRJBGAAU4VMU5NV4W";
const FOREIGN = "CC7LI6WZLFGUXHZ6LSUSOC2KGBIH65ZRKQOKXEFT6DUOJWESHHHNMH5D";
const roles = Object.fromEntries(["governor", "steward", "lender", "trustee", "keeper"].map((r) => [r, Keypair.random()]));
const state = { keys: Object.fromEntries(Object.entries(roles).map(([r, k]) => [r, k.secret()])), contracts: { openWindow: OW } };

const XLM = 10_000_000n;
const instanceKey = (contract) => lib.storageKey(contract);
const dataKey = (contract, n) => lib.storageKey(contract, nativeToScVal(n, { type: "u64" }));

/** The InvokeContractArgs of a call, as an operation carries them. */
function callOf(contract, fn, args) {
  const tx = new TransactionBuilder(new Account(roles.governor.publicKey(), "1"), { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.invokeContractFunction({ contract, function: fn, args }))
    .setTimeout(0)
    .build();
  return tx.operations[0].func.invokeContract;
}

/** An address-credential entry for `address` over `call` (and the calls under it), unsigned, as a simulation records it. */
function entryFor(address, call, subInvocations = []) {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({ address: new Address(address).toScAddress(), nonce: xdr.Int64.fromString("7"), signatureExpirationLedger: 0, signature: xdr.ScVal.scvVoid() })),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({ function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(call), subInvocations }),
  });
}

/** What the stub answers to every simulation of the current test. */
let answer;
let simulations;
let sent;
beforeEach(() => {
  simulations = 0;
  sent = [];
  answer = { auth: [], readOnly: [instanceKey(OW)], readWrite: [], fee: 1n * XLM };
  server.getAccount = async (publicKey) => new Account(publicKey, "100");
  server.getLatestLedger = async () => ({ sequence: 1_000, closeTime: "1800000000" });
  server.simulateTransaction = async () => {
    simulations += 1;
    const data = new SorobanDataBuilder().setReadOnly(answer.readOnly).setReadWrite(answer.readWrite).setResourceFee(answer.fee).build();
    return rpc.parseRawSimulation({
      id: String(simulations),
      latestLedger: 1_000,
      minResourceFee: String(answer.fee),
      transactionData: data.toXDR("base64"),
      results: [{ auth: answer.auth.map((a) => a.toXDR("base64")), xdr: xdr.ScVal.scvVoid().toXDR("base64") }],
      events: [],
    });
  };
  server.sendTransaction = async (tx) => {
    sent.push(tx);
    return { status: "PENDING" };
  };
  server.getTransaction = async () => ({ status: "SUCCESS", returnValue: xdr.ScVal.scvVoid() });
});

const pauseArgs = () => [lib.sv.address(roles.governor.publicKey())];

test("an ordinary simulation is signed and sent", async () => {
  answer.readWrite = [instanceKey(OW)];
  await lib.invoke(state, "governor", OW, "pause", pauseArgs());
  assert.equal(sent.length, 1);
  assert.equal(BigInt(sent[0].fee), 2_000_000n + XLM);
});

test("an authorization entry for another call is refused before any signature", async () => {
  // The lender's transfer to an address the RPC controls, slipped into a pause.
  answer.auth = [entryFor(roles.lender.publicKey(), callOf(OW, "withdraw_offer", [nativeToScVal(1, { type: "u64" }), nativeToScVal(5n, { type: "i128" })]))];
  await assert.rejects(lib.invoke(state, "governor", OW, "pause", pauseArgs()), /asks to authorize .*withdraw_offer, not this call; nothing signed/);
  assert.equal(simulations, 1);
  assert.equal(sent.length, 0);
});

test("an entry for this call by a role the call does not expect is refused", async () => {
  answer.auth = [entryFor(roles.lender.publicKey(), callOf(OW, "pause", pauseArgs()))];
  await assert.rejects(lib.invoke(state, "governor", OW, "pause", pauseArgs()), /asks lender \(G.{5}…\) to authorize this call, which does not expect it/);
  assert.equal(sent.length, 0);
});

test("a co-signer the call declares is signed for; undeclared, it is refused", async () => {
  const args = [lib.sv.address(FOREIGN)];
  const call = callOf(OW, "propose_reanchor_test", args);
  answer.auth = [entryFor(roles.steward.publicKey(), call)];
  await assert.rejects(lib.invoke(state, "governor", OW, "propose_reanchor_test", args), /asks steward/);
  assert.equal(sent.length, 0);
  await lib.invoke(state, "governor", OW, "propose_reanchor_test", args, { cosigners: ["steward"] });
  assert.equal(sent.length, 1);
  const [entry] = sent[0].operations[0].auth;
  assert.equal(entry.credentials.address.signature.type, "scvVec", "the steward's entry carries its signature");
});

test("an address named in the arguments may co-sign without being declared", async () => {
  const args = [lib.sv.address(roles.lender.publicKey()), lib.sv.u64(1)];
  answer.auth = [entryFor(roles.lender.publicKey(), callOf(OW, "attest_test", args))];
  await lib.invoke(state, "governor", OW, "attest_test", args);
  assert.equal(sent.length, 1);
});

test("a footprint that writes contract code is refused", async () => {
  answer.readWrite = [lib.codeKey(Buffer.alloc(32, 9))];
  await assert.rejects(lib.invoke(state, "governor", OW, "pause", pauseArgs()), /writes a contract's code, which this call does not touch/);
  assert.equal(sent.length, 0);
});

test("a footprint that writes or restores a stranger's entry is refused", async () => {
  answer.readWrite = [instanceKey(OW), dataKey(FOREIGN, 1)];
  await assert.rejects(lib.invoke(state, "governor", OW, "pause", pauseArgs()), new RegExp(`writes data of ${FOREIGN}`));
  answer.readWrite = [xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: Keypair.random().xdrAccountId() }))];
  await assert.rejects(lib.invoke(state, "governor", OW, "pause", pauseArgs()), /writes the account of G/);
  assert.equal(sent.length, 0);
  // A local role's account and a deployment contract's data are the call's own.
  answer.readWrite = [xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: roles.keeper.xdrAccountId() })), dataKey(OW, 3)];
  await lib.invoke(state, "governor", OW, "pause", pauseArgs());
  assert.equal(sent.length, 1);
});

test("a resource fee above 25 XLM is refused; a call may raise its cap", async () => {
  answer.fee = 26n * XLM;
  await assert.rejects(lib.invoke(state, "governor", OW, "pause", pauseArgs()), /asks 26\.00 XLM in resource fees, above the 25\.00 XLM/);
  assert.equal(sent.length, 0);
  await lib.invoke(state, "governor", OW, "pause", pauseArgs(), { maxResourceFee: 30n * XLM });
  assert.equal(sent.length, 1);
});

test("an upload writes only the code it uploads, under its own cap", async () => {
  const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  const upload = Operation.uploadContractWasm({ wasm });
  answer.readOnly = [];
  answer.readWrite = [lib.codeKey(createHash("sha256").update(wasm).digest())];
  answer.fee = 50n * XLM;
  await lib.send(state, "governor", upload, "upload", { maxResourceFee: lib.UPLOAD_MAX_FEE });
  assert.equal(sent.length, 1);
  answer.readWrite = [lib.codeKey(Buffer.alloc(32, 6))];
  await assert.rejects(lib.send(state, "governor", upload, "upload", { maxResourceFee: lib.UPLOAD_MAX_FEE }), /writes a contract's code, which this call does not touch/);
  assert.equal(sent.length, 1);
});

test("a contract creation writes its new contract's data, and nothing else", async () => {
  const deployer = roles.governor.publicKey();
  const creation = Operation.createCustomContract({ address: new Address(deployer), wasmHash: Buffer.alloc(32, 1), salt: Buffer.alloc(32, 2), constructorArgs: [lib.sv.address(deployer)] });
  // The id the network derives from the deployer and the salt.
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(new xdr.HashIdPreimageContractId({ networkId: createHash("sha256").update(Networks.TESTNET).digest(), contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(new xdr.ContractIdPreimageFromAddress({ address: new Address(deployer).toScAddress(), salt: Buffer.alloc(32, 2) })) }));
  const created = StrKey.encodeContract(createHash("sha256").update(preimage.toXDR()).digest());
  answer.readWrite = [instanceKey(created)];
  await lib.send(state, "governor", creation, "deploy");
  assert.equal(sent.length, 1);
  answer.readWrite = [instanceKey(FOREIGN)];
  await assert.rejects(lib.send(state, "governor", creation, "deploy"), new RegExp(`writes data of ${FOREIGN}`));
});

test("an extension whose footprint is swapped for other entries is refused", async () => {
  const asked = [dataKey(OW, 1), dataKey(OW, 2)];
  answer.readOnly = [lib.codeKey(Buffer.alloc(32, 4))];
  await assert.rejects(lib.extendTtl(state, "keeper", asked, 1_000), /extends other entries than the 2 asked; nothing signed/);
  answer.readOnly = [...asked];
  answer.readWrite = [dataKey(OW, 1)];
  await assert.rejects(lib.extendTtl(state, "keeper", asked, 1_000), /extends other entries/);
  assert.equal(sent.length, 0);
  answer.readWrite = [];
  await lib.extendTtl(state, "keeper", [...asked].reverse(), 1_000);
  assert.equal(sent.length, 1);
});

test("the code extension pays one slice at most: refused at 25 XLM, sent under its own cap", async () => {
  const code = lib.codeKey(Buffer.alloc(32, 1));
  answer.readOnly = [code];
  answer.fee = 215n * XLM;
  await assert.rejects(lib.extendTtl(state, "keeper", [code], 518_400), /above the 25\.00 XLM/);
  await lib.extendTtl(state, "keeper", [code], 518_400, { maxResourceFee: lib.CODE_SLICE_MAX_FEE });
  assert.equal(sent.length, 1);
  answer.fee = lib.CODE_SLICE_MAX_FEE + 1n;
  await assert.rejects(lib.extendTtl(state, "keeper", [code], 518_400, { maxResourceFee: lib.CODE_SLICE_MAX_FEE }), /above the 300\.00 XLM/);
});

test("the source's own authority asked as a standalone signature is refused before anything is signed (TOOL-1)", async () => {
  // An honest endpoint records the source's authority as source-account
  // credentials. A hostile one asks for an address credential of the
  // governor over its own unpause, and claims a ledger far ahead so that the
  // signature would live long: another transaction could replay it.
  server.getLatestLedger = async () => ({ sequence: 4_000_000_000, closeTime: "1800000000" });
  answer.auth = [entryFor(roles.governor.publicKey(), callOf(OW, "unpause", []))];
  await assert.rejects(
    lib.invoke(state, "governor", OW, "unpause", []),
    /asks the transaction's source, governor \(G.{5}…\), to sign this call apart from the transaction.*; nothing signed \(rpc-1\)$/,
  );
  assert.equal(simulations, 1, "no second simulation: no signed entry reached the endpoint");
  assert.equal(sent.length, 0);
});

test("a refusal after the co-signers' entries went out with the simulation says so, never 'nothing signed' (TOOL-1)", async () => {
  const args = [lib.sv.address(FOREIGN)];
  answer.auth = [entryFor(roles.steward.publicKey(), callOf(OW, "co_signed_test", args))];
  // The second simulation, made with the signed entry, writes a stranger's account.
  answer.readWrite = [xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: Keypair.random().xdrAccountId() }))];
  const error = await lib.invoke(state, "governor", OW, "co_signed_test", args, { cosigners: ["steward"] }).then(() => null, (e) => e);
  assert.ok(error, "the footprint is refused");
  assert.match(error.message, /writes the account of G/);
  assert.doesNotMatch(error.message, /nothing signed/);
  assert.match(error.message, /the transaction was not signed or sent, but 1 authorization entry signed for its simulation reached the RPC, valid until ledger 1100 \(rpc-1\)$/);
  assert.equal(simulations, 2);
  assert.equal(sent.length, 0);
});

test("an endpoint that holds the transaction back cannot have it called expired while it is still valid (TOOL-1)", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 });
  // The endpoint claims a ledger closed 1,000 s from now, keeps the signed
  // transaction and never forwards it: the verdict waits for this machine's
  // clock to pass the transaction's own limit, plus the margin.
  server.getLatestLedger = async () => ({ sequence: 1_000, closeTime: String(Math.floor(Date.now() / 1000) + 1_000) });
  server.getTransaction = async () => ({ status: "NOT_FOUND" });
  let verdict;
  lib.invoke(state, "steward", OW, "mint_test", []).then(() => { verdict = "landed"; }, (error) => { verdict = error.message; });
  for (let second = 0; second < 300 && verdict === undefined; second += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(1_000);
  }
  assert.equal(sent.length, 1);
  const maxTime = Number(sent[0].timeBounds.maxTime);
  assert.match(verdict ?? "", /expired before landing; nothing changed on chain, rerun the step$/);
  assert.ok(Date.now() / 1000 > maxTime + lib.EXPIRY_MARGIN_SECS, `called expired ${(maxTime - Date.now() / 1000).toFixed(0)} s before the transaction's own limit`);
});

// Below the root of an authorization tree (review finding TOOL-5): only a
// transfer by the signer of a deployment token into Open Window is signed.
const SHARES = "CAEXP2UGZVWDXIVOMSZSE5MDSTD5LRBU55FPTERGFSPHTMKONBNJ5XHB";
const EURO = "CC7Z4ENDJV4PBCJMKAOEENJRRU6FFY3FS7W252MNJZ2SUW7ZEVAIP4QX";
const deployment = { ...state, contracts: { openWindow: OW, shares: SHARES, euro: EURO } };
const node = (call, subInvocations = []) => new xdr.SorobanAuthorizedInvocation({ function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(call), subInvocations });
const sourceEntry = (root) => new xdr.SorobanAuthorizationEntry({ credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(), rootInvocation: root });
const transfer = (token, from, to, amount = 5n) => callOf(token, "transfer", [lib.sv.address(from), lib.sv.address(to), lib.sv.i128(amount)]);

test("a call some contract on the path could make in the signer's name is refused under the operation's own call (TOOL-5)", async () => {
  // set_stablecoin calls the candidate token's decimals(): a compromised
  // token makes the governor's XLM move inside that call.
  const xlm = Asset.native().contractId(Networks.TESTNET);
  const attacker = Keypair.random().publicKey();
  const args = [lib.sv.address(FOREIGN), lib.sv.symbol("EUR")];
  answer.auth = [sourceEntry(node(callOf(OW, "set_stablecoin", args), [node(transfer(xlm, roles.governor.publicKey(), attacker, 10_000n * XLM))]))];
  await assert.rejects(lib.invoke(deployment, "governor", OW, "set_stablecoin", args), /asks governor \(G.{5}…\) to authorize C.{7}….transfer inside this call, which is not a transfer of its own tokens into Open Window; nothing signed \(rpc-1\)$/);
  // A compromised feed under a re-anchor takes the share token's admin role with the steward's signature.
  const reanchor = [lib.sv.address(SHARES), lib.sv.i128(1n), lib.sv.i128(1n)];
  const takeover = node(callOf(SHARES, "set_admin", [lib.sv.address(attacker)]));
  answer.auth = [entryFor(roles.steward.publicKey(), callOf(OW, "propose_reanchor", reanchor), [takeover])];
  await assert.rejects(lib.invoke(deployment, "governor", OW, "propose_reanchor", reanchor, { cosigners: ["steward"] }), /asks steward \(G.{5}…\) to authorize CAEXP2UG….set_admin inside this call/);
  assert.equal(simulations, 2, "refused at the first simulation each time: nothing signed went out");
  assert.equal(sent.length, 0);
});

test("a deployment token's transfer into Open Window by its signer is signed; elsewhere, by another, or deeper, it is refused (TOOL-5)", async () => {
  // open_repo pulls the borrower's shares (token_io::pull): the tree the host records.
  const borrower = roles.lender.publicKey();
  const args = [lib.sv.address(borrower), lib.sv.u64(1), lib.sv.address(SHARES), lib.sv.i128(10n), lib.sv.i128(9n), lib.sv.u64(3600)];
  const open = callOf(OW, "open_repo", args);
  answer.auth = [sourceEntry(node(open, [node(transfer(SHARES, borrower, OW, 10n))]))];
  await lib.invoke(deployment, "lender", OW, "open_repo", args);
  assert.equal(sent.length, 1);
  // A co-signer's own pull is signed with its entry too.
  const offer = [lib.sv.address(FOREIGN)];
  answer.auth = [entryFor(roles.steward.publicKey(), callOf(OW, "offer_test", offer), [node(transfer(EURO, roles.steward.publicKey(), OW))])];
  await lib.invoke(deployment, "governor", OW, "offer_test", offer, { cosigners: ["steward"] });
  assert.equal(sent.length, 2);
  const refusedWith = async (subs) => {
    answer.auth = [sourceEntry(node(open, subs))];
    await assert.rejects(lib.invoke(deployment, "lender", OW, "open_repo", args), /inside this call, which is not a transfer of its own tokens into Open Window/);
  };
  await refusedWith([node(transfer(SHARES, borrower, FOREIGN, 10n))]); // to another address
  await refusedWith([node(transfer(SHARES, roles.keeper.publicKey(), OW, 10n))]); // from another holder
  await refusedWith([node(transfer(FOREIGN, borrower, OW, 10n))]); // a token the deployment does not know
  await refusedWith([node(transfer(SHARES, borrower, OW, 10n), [node(callOf(SHARES, "set_admin", [lib.sv.address(FOREIGN)]))])]); // deeper
  assert.equal(sent.length, 2);
  // A token the state does not list is accepted once the caller declares it.
  answer.auth = [sourceEntry(node(open, [node(transfer(FOREIGN, borrower, OW, 10n))]))];
  await lib.invoke(deployment, "lender", OW, "open_repo", args, { tokens: [FOREIGN] });
  assert.equal(sent.length, 3);
});

test("a release writes the trustline of a holder it does not name only once the caller declares that holder, who still signs nothing (TOOL-9)", async () => {
  // Shares of a Stellar Asset Contract delivered to an outside G-address: the simulation writes its trustline.
  const holder = Keypair.random();
  const trustline = xdr.LedgerKey.trustline(new xdr.LedgerKeyTrustLine({ accountId: holder.xdrAccountId(), asset: new Asset("tSHARE", roles.steward.publicKey()).toTrustLineXDRObject() }));
  answer.readWrite = [dataKey(OW, 4), trustline];
  const release = [lib.sv.u64(4)];
  await assert.rejects(lib.invoke(deployment, "keeper", OW, "release", release), new RegExp(`writes the trustline of ${holder.publicKey()}, which this call does not touch; nothing signed`));
  assert.equal(sent.length, 0);
  await lib.invoke(deployment, "keeper", OW, "release", release, { extraAddresses: [holder.publicKey()] });
  assert.equal(sent.length, 1);
  // Declared for the footprint only: an entry asking that holder to sign is still refused.
  answer.auth = [entryFor(holder.publicKey(), callOf(OW, "release", release))];
  await assert.rejects(lib.invoke(deployment, "keeper", OW, "release", release, { extraAddresses: [holder.publicKey()] }), /to authorize this call, which does not expect it; nothing signed/);
  assert.equal(sent.length, 1);
});
