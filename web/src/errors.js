// Contract errors, decoded and told in plain words. Error codes are public
// ABI (contracts/night-window/src/error.rs): appended, never renumbered, so
// these tables stay valid across contract upgrades.

/** Open Window error codes. */
export const ERRORS = {
  1: "NotImplemented", 2: "FundNotAccepted", 3: "InvalidHaircut", 4: "InvalidAmount",
  5: "InvalidTerm", 6: "NoPrice", 7: "NotInitialized", 8: "Paused",
  9: "StablecoinNotAccepted", 10: "CurrencyMismatch", 11: "StalePrice", 12: "PriceOutOfBand",
  13: "LoanTooLarge", 14: "OfferNotFound", 15: "InsufficientOffer", 16: "RepoNotFound",
  17: "RepoNotOpen", 18: "NotMatured", 19: "CapExceeded", 20: "TooManyFunds",
  21: "LenderNotApproved", 22: "TransferMismatch", 23: "FundNotInOffer", 24: "InvalidRate",
  25: "ArithmeticOverflow", 26: "OutsideEnvelope", 27: "FundFrozen", 28: "InvalidPrice",
  29: "DuplicateFund", 30: "Unauthorized",
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
 * never mistaken for an Open Window one.
 */
export class ContractError extends Error {
  constructor(code, contract, detail = "") {
    const bare = ERROR_TABLES[contract]?.[code] ?? "Error";
    const name = contract === "open-window" ? bare : `${contract}:${bare}`;
    super(`${name} (#${code})`);
    this.code = code;
    this.contract = contract;
    this.name = name;
    this.bare = bare;
    this.detail = detail;
  }
}

/** The wallet refused or failed to sign. */
export class WalletError extends Error {
  constructor(message) {
    super(message);
    this.name = "WalletError";
  }
}

/** A definitive transaction outcome other than success. */
export class TransactionError extends Error {
  constructor(kind, message, hash = null) {
    super(message);
    this.name = kind; // "TxFailed" | "TxExpired" | "TxRefused"
    this.hash = hash;
  }
}

/**
 * Decodes the contract error in a simulation's diagnostic text. The log
 * lists events newest first; the oldest error event names the contract
 * where the failure started (a token refusing a transfer inside `open_repo`).
 */
export function decodeSimulationError(text, kinds = new Map()) {
  const events = [...String(text).matchAll(/contract:(C[A-Z0-9]{55}), topics:\[error, Error\(Contract, #(\d+)\)\]/g)];
  if (events.length) {
    const [, contractId, code] = events[events.length - 1];
    return new ContractError(Number(code), kinds.get(contractId) ?? "unknown", text);
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
const SENTENCES = {
  "open-window": {
    NotImplemented: () => "This function is not available in this contract version.",
    FundNotAccepted: () => "These fund shares are not accepted as collateral.",
    InvalidHaircut: () => "The haircut setting of this fund is invalid.",
    InvalidAmount: () => "Amounts must be greater than zero.",
    InvalidTerm: (c) => `The term is outside what is allowed.${c.term ? ` Choose ${c.term}.` : " The minimum is 1 hour."}`,
    NoPrice: () => "The price feed has no price for this fund right now.",
    NotInitialized: () => "The contract is not configured.",
    Paused: () => "New loans and new offers are paused. Repurchases and withdrawals still work.",
    StablecoinNotAccepted: () => "This stablecoin is not accepted by the contract.",
    CurrencyMismatch: () => "The fund and the stablecoin are in different currencies.",
    StalePrice: () => "The fund price or the exchange rate is too old to lend against. It works again after the next publication.",
    PriceOutOfBand: () => "The latest price is outside its plausible range, so the contract refuses to lend against it.",
    LoanTooLarge: (c) => `This is more than the shares can secure.${c.max ? ` The maximum is ${c.max}.` : ""}`,
    OfferNotFound: () => "This offer does not exist.",
    InsufficientOffer: (c) => `The offer does not hold enough for this amount.${c.available ? ` It holds ${c.available}.` : ""}`,
    RepoNotFound: () => "This position does not exist.",
    RepoNotOpen: () => "This position is already closed.",
    NotMatured: () => "This position has not reached its maturity yet.",
    CapExceeded: () => "This loan would go over a limit: per loan, per fund or for the whole currency. Try a smaller amount.",
    TooManyFunds: () => "An offer must list between one and eight different funds.",
    LenderNotApproved: () => "The lender is not approved by the fund issuer.",
    TransferMismatch: () => "A token transfer did not move the exact amount expected.",
    FundNotInOffer: () => "This offer does not accept these fund shares.",
    InvalidRate: () => "The rate must be between 0 % and 100 % a year.",
    ArithmeticOverflow: () => "These amounts are too large to compute.",
    OutsideEnvelope: () => "A setting lies outside the protocol risk limits.",
    FundFrozen: () => "The fund issuer has suspended new loans on this fund.",
    InvalidPrice: () => "The price feed returned an invalid price.",
    DuplicateFund: () => "The fund is listed twice in the offer.",
    Unauthorized: () => "This wallet does not hold the role this action needs.",
  },
  "fund-token": {
    NotWhitelisted: (c) => `This wallet is not on the fund's allowlist.${c.command ? ` Ask the operator to run: ${c.command}` : " Ask the operator to onboard it."}`,
    Frozen: () => "The fund issuer has frozen the shares of this wallet.",
    InsufficientBalance: () => "You hold fewer fund shares than this.",
  },
  "stellar-asset": {
    AccountMissing: () => "This account does not exist on testnet yet. Fund it with test XLM first.",
    Balance: (c) => `Your ${c.code ?? "stablecoin"} balance is too low for this.`,
    BalanceDeauthorized: (c) => `Your ${c.code ?? "stablecoin"} trustline is not authorized by the issuer.`,
    TrustlineMissing: (c) => `This wallet has no ${c.code ?? "stablecoin"} trustline. Use "Add ${c.code ?? "stablecoin"}" first.`,
  },
};

/**
 * A human sentence for any error the interface can meet, plus a short name
 * to show next to it. Returns `{ text, name }`.
 */
export function describeError(error, context = {}) {
  if (error instanceof ContractError) {
    const sentence = SENTENCES[error.contract]?.[error.bare];
    if (sentence) return { text: sentence(context), name: error.name };
    const who = error.contract === "nav-oracle" ? "The price feed" : error.contract === "unknown" ? "A contract" : "A token contract";
    return { text: `${who} refused the operation.`, name: error.message };
  }
  if (error instanceof WalletError) return { text: error.message, name: "Wallet" };
  if (error instanceof TransactionError) {
    if (error.name === "AccountMissing") return { text: "This account does not exist on testnet yet. Fund it with test XLM first.", name: "AccountMissing" };
    if (error.name === "TxExpired") return { text: "The transaction expired before it landed. Nothing changed on chain. You can try again.", name: "TxExpired" };
    if (error.name === "TxRefused") return { text: `The network refused the transaction. Nothing changed on chain. ${error.message}`, name: "TxRefused" };
    return { text: `The transaction failed on chain. Nothing changed. ${error.message}`, name: "TxFailed" };
  }
  const message = String(error?.message ?? error ?? "");
  if (/fetch|network|timeout|ECONN|Failed to fetch/i.test(message)) {
    return { text: "The network did not answer. Check your connection and try again.", name: "Network" };
  }
  return { text: message || "Something went wrong.", name: "Error" };
}
