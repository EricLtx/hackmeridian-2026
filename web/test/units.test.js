import assert from "node:assert/strict";
import { test } from "node:test";

import { ContractError, TransactionError, WalletError, contractKinds, decodeSimulationError, describeError } from "../src/errors.js";
import { formatAge, formatAmount, formatCountdown, formatDuration, formatRate, formatTerm, formatUnits, toUnits, unitsToInput } from "../src/format.js";
import { chargedHours, defaultPrincipal, interest, maxTermFor, nextInterestStep, pickOffer, sortOffers, WEEKEND_SECS } from "../src/terms.js";

const ONE = 10_000_000n;

test("interest matches the contract formula on the weekend example", () => {
  // 8,374 tEUR at 2.50 % for 64 h = 1.52949771... rounded up to 7 decimals.
  const units = interest(8_374n * ONE, 250, WEEKEND_SECS);
  assert.equal(units, 15_294_978n);
  assert.equal(formatUnits(units, 7), "1.5294978");
});

test("interest charges every started hour, at least one", () => {
  assert.equal(chargedHours(0), 1);
  assert.equal(chargedHours(1), 1);
  assert.equal(chargedHours(3600), 1);
  assert.equal(chargedHours(3601), 2);
  assert.equal(interest(1_000n * ONE, 250, 0), interest(1_000n * ONE, 250, 3600));
  assert.ok(interest(1_000n * ONE, 250, 3601) > interest(1_000n * ONE, 250, 3600));
  // 1,000 at 2.5 % for one hour: 1000 * 0.025 / 8760 = 0.00285388... -> ceil.
  assert.equal(interest(1_000n * ONE, 250, 3600), 28_539n);
  assert.equal(interest(0n, 250, 3600), 0n);
  assert.equal(interest(1_000n * ONE, 0, 3600), 0n);
});

test("next interest step is the end of the hour being charged", () => {
  assert.equal(nextInterestStep(1000, 1000), 4600);
  assert.equal(nextInterestStep(1000, 4599), 4600);
  assert.equal(nextInterestStep(1000, 4601), 8200);
});

test("units parse and format without float rounding", () => {
  assert.equal(toUnits("1,250.5", 7), 12_505_000_000n);
  assert.equal(toUnits("0.0000001", 7), 1n);
  assert.equal(toUnits(".5", 7), 5_000_000n);
  assert.equal(toUnits("12", 0), 12n);
  assert.equal(toUnits("0.00000001", 7), null);
  assert.equal(toUnits("abc", 7), null);
  assert.equal(toUnits("", 7), null);
  assert.equal(toUnits("-1", 7), null);
  assert.equal(formatUnits(12_505_000_000n, 7), "1,250.5000000");
  assert.equal(formatAmount(12_505_000_000n), "1,250.50");
  assert.equal(formatAmount(123_456_789_012_345n), "12,345,678.90");
  assert.equal(formatAmount(15_294_978n), "1.53");
  assert.equal(formatAmount(15_000_001n, 7, "ceil"), "1.51");
  assert.equal(formatAmount(15_049_999n, 7, "floor"), "1.50");
  assert.equal(formatUnits(108_500_238_083_460n, 14, { digits: 4 }), "1.0850");
  assert.equal(unitsToInput(12_505_000_000n, 7), "1250.5");
  assert.equal(unitsToInput(10_000_000n, 7), "1");
  assert.equal(formatRate(250), "2.50 %");
  assert.equal(formatRate(1), "0.01 %");
});

test("durations read naturally", () => {
  assert.equal(formatDuration(42), "42 s");
  assert.equal(formatDuration(600), "10 min");
  assert.equal(formatDuration(3 * 3600 + 300), "3 h 05 min");
  assert.equal(formatDuration(7 * 86400), "7 d");
  assert.equal(formatCountdown(3849), "1 h 04 min 09 s");
  assert.equal(formatCountdown(65), "1 min 05 s");
  assert.equal(formatAge(100, 400), "5 min ago");
  assert.equal(formatAge(500, 400), "just now");
  assert.equal(formatTerm(3600), "1 hour");
  assert.equal(formatTerm(604800), "168 hours (7 days)");
});

const FUND = "CFUND";
const offers = [
  { id: 2, sponsor: false, rate_bps: 350, available: 1_500n * ONE, max_term: 604800n, funds: [FUND] },
  { id: 3, sponsor: false, rate_bps: 300, available: 10n * ONE, max_term: 3600n, funds: [FUND] },
  { id: 1, sponsor: true, rate_bps: 250, available: 100n * ONE, max_term: 604800n, funds: [FUND] },
  { id: 4, sponsor: false, rate_bps: 100, available: 9_000n * ONE, max_term: 604800n, funds: ["COTHER"] },
];

test("offers sort sponsor first, then by rate", () => {
  assert.deepEqual(sortOffers(offers).map((o) => o.id), [1, 4, 3, 2]);
});

test("the default offer is the first with enough funds for this fund", () => {
  assert.equal(pickOffer(offers, FUND, 50n * ONE).id, 1);
  assert.equal(pickOffer(offers, FUND, 500n * ONE).id, 2);
  assert.equal(pickOffer(offers, FUND, 5_000n * ONE), null);
  assert.equal(maxTermFor(offers[1], 604800n), 3600);
  assert.equal(maxTermFor(offers[0], 86400n), 86400);
});

test("default principal is 90 % of the quote, capped by every limit", () => {
  assert.equal(defaultPrincipal(1_000n * ONE), 900n * ONE);
  assert.equal(defaultPrincipal(1_000n * ONE, 500n * ONE, null), 500n * ONE);
  assert.equal(defaultPrincipal(1_000n * ONE, -5n), 0n);
});

const OW = "CBVSCT2WPGYBP23BQKI5LCQQT4AWVT3WB36GUYJBS7OENEJCS3A6IKA7";
const SAC = "CC7Z4ENDJV4PBCJMKAOEENJRRU6FFY3FS7W252MNJZ2SUW7ZEVAIP4QX";
const kinds = contractKinds({ openWindow: OW, stablecoin: SAC });

test("a simulation error is named after the contract that raised it", () => {
  const own = decodeSimulationError(
    `HostError: Error(Contract, #13)\n\nEvent log (newest first):\n   0: [Diagnostic Event] contract:${OW}, topics:[error, Error(Contract, #13)], data:"escalating"`,
    kinds,
  );
  assert.ok(own instanceof ContractError);
  assert.equal(own.name, "LoanTooLarge");

  // A token refusing inside open_repo: the oldest error event wins.
  const nested = decodeSimulationError(
    `HostError: Error(Contract, #10)\n0: [Diagnostic Event] contract:${OW}, topics:[error, Error(Contract, #10)]\n1: [Diagnostic Event] contract:${SAC}, topics:[error, Error(Contract, #10)], data:["resulting balance is not within the allowed range"]`,
    kinds,
  );
  assert.equal(nested.name, "stellar-asset:Balance");
  assert.equal(describeError(nested, { code: "tEUR" }).text, "Your tEUR balance is too low for this.");

  const bare = decodeSimulationError("HostError: Error(Contract, #8)", kinds);
  assert.equal(bare.contract, "unknown");
});

test("errors read as sentences with their name", () => {
  const tooLarge = describeError(new ContractError(13, "open-window"), { max: "8,374.00 tEUR" });
  assert.equal(tooLarge.text, "This is more than the shares can secure. The maximum is 8,374.00 tEUR.");
  assert.equal(tooLarge.name, "LoanTooLarge");
  assert.match(describeError(new ContractError(8, "open-window")).text, /paused/);
  assert.match(describeError(new ContractError(1, "fund-token"), { command: "npm run onboard" }).text, /npm run onboard/);
  assert.equal(describeError(new ContractError(99, "open-window")).name, "Error (#99)");
  for (let code = 1; code <= 30; code += 1) {
    const { text } = describeError(new ContractError(code, "open-window"));
    assert.ok(text.endsWith(".") && !text.includes("undefined"), `code ${code}: ${text}`);
  }
  assert.equal(describeError(new WalletError("You declined the request in your wallet.")).name, "Wallet");
  assert.match(describeError(new TransactionError("TxExpired", "x")).text, /Nothing changed/);
  assert.equal(describeError(new TypeError("Failed to fetch")).name, "Network");
});
