// Contract errors, decoded and told in plain words. Error codes are public
// ABI (contracts/night-window/src/error.rs): appended, never renumbered, so
// these tables stay valid across contract upgrades.
//
// The error tables, `ContractError` and `decodeSimulationError` are adapted
// from demo/lib.mjs (same repository, Apache-2.0).

import { t } from "./i18n.js";

/** Open Window error codes. */
export const ERRORS = {
  1: "NotImplemented", 2: "FundNotAccepted", 3: "InvalidHaircut", 4: "InvalidAmount",
  5: "InvalidTerm", 6: "NoPrice", 7: "NotInitialized", 8: "Paused",
  9: "StablecoinNotAccepted", 10: "CurrencyMismatch", 11: "StalePrice", 12: "PriceOutOfBand",
  13: "LoanTooLarge", 14: "OfferNotFound", 15: "InsufficientOffer", 16: "RepoNotFound",
  17: "RepoNotOpen", 18: "NotMatured", 19: "CapExceeded", 20: "TooManyFunds",
  21: "LenderNotApproved", 22: "TransferMismatch", 23: "FundNotInOffer", 24: "InvalidRate",
  25: "ArithmeticOverflow", 26: "OutsideEnvelope", 27: "FundFrozen", 28: "InvalidPrice",
  29: "DuplicateFund", 30: "Unauthorized", 31: "DelayCannotDecrease", 32: "NotProposed",
  33: "TimelockPending", 34: "ReleaseBlocked", 35: "PriceDivergence", 36: "NothingToRelease",
  37: "NoFallback", 38: "ProposalExpired", 39: "LimitReached", 40: "StewardCannotLend", 41: "NotSoleLender",
  42: "AttestationMissing", 43: "NotGuardianBackup", 44: "SoleLenderFixed", 45: "NoStewardBackup",
  46: "TrusteeFixed", 47: "TrusteeNotIndependent", 48: "FxBandExceedsHaircut",
  49: "SentinelNotIndependent", 50: "NothingToMigrate", 51: "SchemaOutdated",
};

/** Error tables of the other contracts a transaction can reach. */
export const ERROR_TABLES = {
  "open-window": ERRORS,
  "fund-token": {
    1: "NotWhitelisted", 2: "Frozen", 3: "InsufficientBalance", 4: "InsufficientAllowance",
    5: "NegativeAmount", 6: "Overflow", 7: "NotInitialized", 8: "InvalidExpiration",
  },
  "nav-oracle": {
    1: "InvalidPrice", 2: "InvalidTimestamp", 3: "NonMonotonicTimestamp", 4: "TooManyAssets",
    5: "NotInitialized", 6: "InvalidConfig",
  },
  "stellar-asset": {
    1: "InternalError", 2: "OperationNotSupported", 3: "AlreadyInitialized", 4: "Unauthorized",
    5: "Authentication", 6: "AccountMissing", 7: "AccountIsNotClassic", 8: "NegativeAmount",
    9: "Allowance", 10: "Balance", 11: "BalanceDeauthorized", 12: "Overflow", 13: "TrustlineMissing",
  },
};

/** Which kind of contract each deployed address is, from the deployment file. */
export function contractKinds(contracts) {
  const kinds = new Map();
  if (contracts.openWindow) kinds.set(contracts.openWindow, "open-window");
  if (contracts.fundShares) kinds.set(contracts.fundShares, "fund-token");
  if (contracts.navFeed) kinds.set(contracts.navFeed, "nav-oracle");
  if (contracts.stablecoin) kinds.set(contracts.stablecoin, "stellar-asset");
  return kinds;
}

/**
 * A typed error raised by a contract. `name` is the bare name for Open
 * Window and `kind:Name` for any other contract, so a share-token refusal is
 * never mistaken for an Open Window one. `contractId` is the address that
 * raised it when the diagnostic events name one; `coin`, set by the chain
 * module, the ticker of that token when it is known.
 */
export class ContractError extends Error {
  constructor(code, contract, detail = "", contractId = null) {
    const bare = ERROR_TABLES[contract]?.[code] ?? "Error";
    const name = contract === "open-window" ? bare : `${contract}:${bare}`;
    super(`${name} (#${code})`);
    this.code = code;
    this.contract = contract;
    this.name = name;
    this.bare = bare;
    this.detail = detail;
    this.contractId = contractId;
    this.coin = null;
  }
}

/** The wallet refused or failed to sign. */
export class WalletError extends Error {
  constructor(message) {
    super(message);
    this.name = "WalletError";
  }
}

/** A definitive transaction outcome other than success, or a success a second endpoint did not confirm. */
export class TransactionError extends Error {
  constructor(kind, message, hash = null) {
    super(message);
    this.name = kind; // "TxFailed" | "TxExpired" | "TxRefused" | "TxUnconfirmed"
    this.hash = hash;
  }
}

/**
 * Decodes the contract error in a simulation's diagnostic text. The log
 * lists events newest first; the oldest error event names the contract
 * where the failure started (a token refusing a transfer inside `open_repo`).
 */
export function decodeSimulationError(text, kinds = new Map()) {
  // The surfaced code heads the message; error events are listed newest
  // first, so the oldest one with that code names the contract it came from.
  // An error a contract caught carries another code and is ignored.
  const surfaced = /^HostError: Error\(Contract, #(\d+)\)/.exec(String(text))?.[1];
  const events = [...String(text).matchAll(/contract:(C[A-Z0-9]{55}), topics:\[error, Error\(Contract, #(\d+)\)\](?:, data:([^\n]*))?/g)];
  const same = surfaced ? events.filter(([, , code]) => code === surfaced) : events;
  if (same.length) {
    const [, contractId, code] = same[same.length - 1];
    const kind = kinds.get(contractId) ?? "unknown";
    // Open Window passing on the refusal of a contract it called, whose own
    // event is missing, has not raised it: its code is the callee's (a Stellar
    // Asset Contract's #11 is not StalePrice), and the callee is unknown.
    const relayed = kind === "open-window" && same.some(([, id, , data]) => id === contractId && /contract call failed|failed host function call/.test(data ?? ""));
    return relayed ? new ContractError(Number(code), "unknown", text) : new ContractError(Number(code), kind, text, contractId);
  }
  const match = /Error\(Contract, #(\d+)\)/.exec(String(text));
  if (match) return new ContractError(Number(match[1]), "unknown", text);
  if (/Account not found|AccountMissing|account entry is missing/i.test(String(text))) {
    return new TransactionError("AccountMissing", "account not found");
  }
  return new Error(String(text) || "simulation failed");
}

// Each sentence may use the context the caller passes: `max` (what the
// shares secure), `available` (what the offer holds), `term` (allowed range),
// `code` (stablecoin code), `command` (onboarding command for this wallet).
// Sentences are translated when they are told (i18n.js); an optional tail is
// a sentence of its own, appended after a space.
const join = (...parts) => parts.filter(Boolean).join(" ");

const SENTENCES = {
  "open-window": {
    NotImplemented: () => t("This function is not available in this contract version."),
    FundNotAccepted: () => t("These fund shares are not accepted as collateral."),
    InvalidHaircut: () => t("The haircut setting of this fund is invalid."),
    InvalidAmount: () => t("Amounts must be greater than zero."),
    InvalidTerm: (c) => join(t("The term is outside what is allowed."), c.term ? t("Choose {term}.", { term: c.term }) : t("The minimum is 1 hour.")),
    NoPrice: () => t("The price feed has no price for this fund right now."),
    NotInitialized: () => t("The contract is not configured."),
    Paused: () => t("New loans and new offers are paused. Repurchases and withdrawals still work."),
    StablecoinNotAccepted: () => t("This stablecoin is not accepted by the contract."),
    CurrencyMismatch: () => t("The fund and the stablecoin are in different currencies."),
    StalePrice: () => t("The fund price or the exchange rate is too old to lend against. It works again after the next publication."),
    PriceOutOfBand: () => t("The latest price is outside its plausible range, so the contract refuses to lend against it."),
    LoanTooLarge: (c) => join(t("This is more than the shares can secure."), c.max && t("The maximum is {max}.", { max: c.max })),
    OfferNotFound: () => t("This offer does not exist."),
    InsufficientOffer: (c) => join(t("The offer does not hold enough for this amount."), c.available && t("It holds {available}.", { available: c.available })),
    RepoNotFound: () => t("This position does not exist."),
    RepoNotOpen: () => t("This position is already closed."),
    NotMatured: (c) => join(t("This position has not reached its term yet."), c.when && t("You can take the shares from {when}.", { when: c.when })),
    CapExceeded: () => t("This loan would go over a limit: per loan, per fund or for the whole currency. Try a smaller amount."),
    TooManyFunds: () => t("An offer must list between one and eight different funds."),
    LenderNotApproved: (c) =>
      c.action === "seize"
        ? t("Seized shares can only go to a lender the fund issuer approves, and your address is not approved for this fund any more. Ask the issuer to approve it again, then retry.")
        : c.action === "create_offer"
          ? t("Your address is not an approved lender for this fund. The fund issuer approves lenders.")
          : t("The lender of this offer is no longer approved by the fund issuer. Pick another offer."),
    TransferMismatch: () => t("A token transfer did not move the exact amount expected."),
    FundNotInOffer: () => t("This offer does not accept these fund shares."),
    InvalidRate: () => t("The rate must be between 0 % and 100 % a year."),
    ArithmeticOverflow: () => t("These amounts are too large to compute."),
    OutsideEnvelope: () => t("A setting lies outside the protocol risk limits."),
    FundFrozen: () => t("The fund issuer has suspended new loans on this fund."),
    InvalidPrice: () => t("The price feed returned an invalid price."),
    DuplicateFund: () => t("The fund is listed twice in the offer."),
    Unauthorized: () => t("This wallet does not hold the role this action needs."),
    PriceDivergence: () => t("The fund's two price feeds disagree, so no loan is priced until they agree again."),
    ReleaseBlocked: () => t("The fund issuer still refuses the transfer of these shares. They stay reserved for you; retry once the issuer lifts its block."),
    NothingToRelease: () => t("No shares are waiting for release on this repo."),
    TimelockPending: () => t("This change is waiting for its time delay to pass."),
    NotSoleLender: () => t("This instance is run by a single lender: only that lender can make offers here."),
    StewardCannotLend: () => t("The fund's issuer cannot lend against its own fund."),
    AttestationMissing: () => t("The issuer must record this lender's declaration before approving it."),
    FxBandExceedsHaircut: () => t("The exchange-rate band of this fund would be wider than its exchange-rate haircut, which the contract refuses."),
    SentinelNotIndependent: () => t("The sentinel must be a key that holds no other role."),
    NothingToMigrate: () => t("The contract's stored records are already at the current version."),
    SchemaOutdated: () =>
      t("The contract was just upgraded and its stored records are not migrated yet: new loans and offers resume once the governor migrates them. Repurchases, withdrawals and deliveries still work."),
  },
  "fund-token": {
    NotWhitelisted: (c) =>
      join(t("This wallet is not on the fund's allowlist."), c.command ? t("Ask the operator to run: {command}", { command: c.command }) : t("Ask the operator to onboard it.")),
    Frozen: () => t("The fund issuer has frozen the shares of this wallet."),
    InsufficientBalance: () => t("You hold fewer fund shares than this."),
  },
  "stellar-asset": {
    AccountMissing: () => t("This account does not exist on testnet yet. Fund it with test XLM first."),
    Balance: (c) => t("Your {code} balance is too low for this.", { code: c.code ?? "stablecoin" }),
    BalanceDeauthorized: (c) => t("Your {code} trustline is not authorized by the issuer.", { code: c.code ?? "stablecoin" }),
    TrustlineMissing: (c) => t("This wallet has no {code} trustline. Use \"Add {code}\" first.", { code: c.code ?? "stablecoin" }),
  },
};

/**
 * A human sentence for any error the interface can meet, plus a short name
 * to show next to it. Returns `{ text, name }`.
 */
export function describeError(error, context = {}) {
  if (error instanceof ContractError) {
    // A token's refusal names that token, not the coin the screen happens to show.
    const sentence = SENTENCES[error.contract]?.[error.bare];
    if (sentence) return { text: sentence(error.coin ? { ...context, code: error.coin } : context), name: error.name };
    const text =
      error.contract === "nav-oracle"
        ? t("The price feed refused the operation.")
        : error.contract === "unknown"
          ? t("A contract refused the operation.")
          : t("A token contract refused the operation.");
    return { text, name: error.message };
  }
  if (error instanceof WalletError) return { text: error.message, name: "Wallet" };
  if (error instanceof TransactionError) {
    if (error.name === "AccountMissing") return { text: t("This account does not exist on testnet yet. Fund it with test XLM first."), name: "AccountMissing" };
    if (error.name === "TxExpired") return { text: t("The transaction expired before it landed. Nothing changed on chain. You can try again."), name: "TxExpired" };
    if (error.name === "TxRefused") return { text: join(t("The network refused the transaction. Nothing changed on chain."), error.message), name: "TxRefused" };
    if (error.name === "TxUnconfirmed") {
      return {
        text: join(t("The transaction was sent and one RPC endpoint reports it confirmed, but a second endpoint did not confirm it. Check it on the explorer before relying on it or trying again."), error.message),
        name: "TxUnconfirmed",
      };
    }
    return { text: join(t("The transaction failed on chain. Nothing changed."), error.message), name: "TxFailed" };
  }
  const message = String(error?.message ?? error ?? "");
  if (/fetch|network|timeout|ECONN|Failed to fetch/i.test(message)) {
    return { text: t("The network did not answer. Check your connection and try again."), name: "Network" };
  }
  return { text: message || t("Something went wrong."), name: "Error" };
}
