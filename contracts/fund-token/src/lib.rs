#![no_std]
//! Fund Token (crate `fund-token`): a test and demo token that behaves like a
//! regulated tokenized money market fund share.
//!
//! It is a SEP-41 fungible token whose movements are restricted to an
//! allowlist kept by the issuer (the admin):
//!
//! - `transfer` and `transfer_from` require both `from` and `to` to be
//!   whitelisted and not frozen. A contract address is whitelisted like any
//!   account, which lets a repo contract hold the shares as collateral.
//! - `mint` only credits a whitelisted, non-frozen account; `burn` and
//!   `burn_from` only debit one.
//! - The issuer can freeze an account (it can neither send nor receive) and
//!   claw back shares from any account, frozen or not.
//!
//! This contract is not a production fund token. It exists so the repo
//! contract can be exercised on testnet against the same transfer
//! restrictions a real fund share imposes.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contractmeta, contracttype,
    panic_with_error, token::TokenInterface, Address, Env, MuxedAddress, String,
};

contractmeta!(key = "binver", val = "0.1.0");
contractmeta!(
    key = "desc",
    val = "Fund Token: allowlisted SEP-41 test token mimicking a money market fund share"
);

// Ledgers close about every 5 seconds: 17,280 ledgers a day.
const DAY_IN_LEDGERS: u32 = 17_280;
const BUMP_THRESHOLD: u32 = 30 * DAY_IN_LEDGERS;
const BUMP_TO: u32 = 120 * DAY_IN_LEDGERS;

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/// Storage keys. Admin and metadata live in instance storage; every
/// per-address value is its own persistent entry; allowances are temporary
/// entries that expire with their `live_until_ledger`.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Instance: issuer address.
    Admin,
    /// Instance: decimals, name and symbol.
    Metadata,
    /// Persistent: balance of an address.
    Balance(Address),
    /// Persistent: present when the address is on the allowlist.
    Whitelisted(Address),
    /// Persistent: present when the address is frozen.
    Frozen(Address),
    /// Temporary: allowance granted by `from` to `spender`.
    Allowance(AllowanceKey),
}

#[contracttype]
#[derive(Clone)]
pub struct AllowanceKey {
    pub from: Address,
    pub spender: Address,
}

/// An allowance and the last ledger at which it may be spent.
#[contracttype]
#[derive(Clone)]
pub struct AllowanceValue {
    pub amount: i128,
    pub live_until_ledger: u32,
}

#[contracttype]
#[derive(Clone)]
pub struct TokenMetadata {
    pub decimals: u32,
    pub name: String,
    pub symbol: String,
}

// ---------------------------------------------------------------------------
// Errors and events
// ---------------------------------------------------------------------------

/// Error codes are public ABI: add new ones, never renumber.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum TokenError {
    /// The address is not on the issuer's allowlist.
    NotWhitelisted = 1,
    /// The address is frozen by the issuer.
    Frozen = 2,
    /// The balance does not cover the amount.
    InsufficientBalance = 3,
    /// The allowance does not cover the amount.
    InsufficientAllowance = 4,
    /// Amounts must be zero or positive.
    NegativeAmount = 5,
    /// The result does not fit in an `i128`.
    Overflow = 6,
    /// Instance storage lost its configuration. Unreachable with a constructor
    /// deployment; kept as a typed failure rather than an opaque trap.
    NotInitialized = 7,
    /// `live_until_ledger` is in the past for a non-zero allowance, or beyond
    /// the longest TTL the network accepts.
    InvalidExpiration = 8,
}

/// SEP-41 transfer to a plain address: data is the amount.
#[contractevent(topics = ["transfer"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Transfer {
    #[topic]
    pub from: Address,
    #[topic]
    pub to: Address,
    pub amount: i128,
}

/// SEP-41 transfer to a muxed address: data is a map with the amount and
/// the muxed identifier of the recipient.
#[contractevent(topics = ["transfer"], data_format = "map")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TransferMuxed {
    #[topic]
    pub from: Address,
    #[topic]
    pub to: Address,
    pub to_muxed_id: u64,
    pub amount: i128,
}

#[contractevent(topics = ["mint"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Mint {
    #[topic]
    pub to: Address,
    pub amount: i128,
}

#[contractevent(topics = ["burn"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Burn {
    #[topic]
    pub from: Address,
    pub amount: i128,
}

#[contractevent(topics = ["clawback"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Clawback {
    #[topic]
    pub from: Address,
    pub amount: i128,
}

/// SEP-41 approval: data is `[amount, live_until_ledger]`.
#[contractevent(topics = ["approve"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Approve {
    #[topic]
    pub from: Address,
    #[topic]
    pub spender: Address,
    pub amount: i128,
    pub live_until_ledger: u32,
}

#[contractevent(topics = ["set_admin"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SetAdmin {
    #[topic]
    pub admin: Address,
    pub new_admin: Address,
}

#[contractevent(topics = ["set_whitelisted"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SetWhitelisted {
    #[topic]
    pub id: Address,
    pub whitelisted: bool,
}

#[contractevent(topics = ["set_frozen"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SetFrozen {
    #[topic]
    pub id: Address,
    pub frozen: bool,
}

// ---------------------------------------------------------------------------
// Amount: a quantity of shares that cannot be negative
// ---------------------------------------------------------------------------

/// A non-negative quantity of shares. Every amount entering the contract is
/// validated into an `Amount`, and balances and allowances are only changed
/// through its checked operations, so a negative value never reaches storage.
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
struct Amount(i128);

impl Amount {
    const ZERO: Amount = Amount(0);

    fn new(raw: i128) -> Result<Self, TokenError> {
        if raw < 0 {
            return Err(TokenError::NegativeAmount);
        }
        Ok(Amount(raw))
    }

    fn get(self) -> i128 {
        self.0
    }

    fn plus(self, other: Amount) -> Result<Self, TokenError> {
        self.0
            .checked_add(other.0)
            .map(Amount)
            .ok_or(TokenError::Overflow)
    }

    /// `self - other`, failing with `shortfall` when `other` exceeds `self`.
    fn minus(self, other: Amount, shortfall: TokenError) -> Result<Self, TokenError> {
        if other > self {
            return Err(shortfall);
        }
        self.0
            .checked_sub(other.0)
            .map(Amount)
            .ok_or(TokenError::Overflow)
    }
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct FundToken;

#[contractimpl]
impl FundToken {
    /// Deploys the token with its issuer and metadata. Runs once, at deploy time.
    pub fn __constructor(env: Env, admin: Address, decimals: u32, name: String, symbol: String) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(
            &DataKey::Metadata,
            &TokenMetadata {
                decimals,
                name,
                symbol,
            },
        );
        bump_instance(&env);
    }

    // -- Issuer -------------------------------------------------------------

    pub fn admin(env: Env) -> Result<Address, TokenError> {
        read_admin(&env)
    }

    /// Hands the issuer role to `new_admin`. Requires the current admin.
    pub fn set_admin(env: Env, new_admin: Address) -> Result<(), TokenError> {
        let admin = require_admin(&env)?;
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        bump_instance(&env);
        SetAdmin { admin, new_admin }.publish(&env);
        Ok(())
    }

    /// Adds `id` to the allowlist or removes it. Requires the admin.
    pub fn set_whitelisted(env: Env, id: Address, whitelisted: bool) -> Result<(), TokenError> {
        require_admin(&env)?;
        write_flag(&env, &DataKey::Whitelisted(id.clone()), whitelisted);
        bump_instance(&env);
        SetWhitelisted { id, whitelisted }.publish(&env);
        Ok(())
    }

    /// Freezes `id` (it can neither send nor receive) or unfreezes it.
    /// Requires the admin.
    pub fn set_frozen(env: Env, id: Address, frozen: bool) -> Result<(), TokenError> {
        require_admin(&env)?;
        write_flag(&env, &DataKey::Frozen(id.clone()), frozen);
        bump_instance(&env);
        SetFrozen { id, frozen }.publish(&env);
        Ok(())
    }

    /// Issues `amount` new shares to `to`, which must be whitelisted and not
    /// frozen. Requires the admin.
    pub fn mint(env: Env, to: Address, amount: i128) -> Result<(), TokenError> {
        require_admin(&env)?;
        let amount = Amount::new(amount)?;
        require_active(&env, &to)?;
        credit(&env, &to, amount)?;
        bump_instance(&env);
        Mint {
            to,
            amount: amount.get(),
        }
        .publish(&env);
        Ok(())
    }

    /// Takes `amount` shares back from `from`, whatever its allowlist or
    /// frozen status. The shares are destroyed. Requires the admin.
    pub fn clawback(env: Env, from: Address, amount: i128) -> Result<(), TokenError> {
        require_admin(&env)?;
        let amount = Amount::new(amount)?;
        debit(&env, &from, amount)?;
        bump_instance(&env);
        Clawback {
            from,
            amount: amount.get(),
        }
        .publish(&env);
        Ok(())
    }

    pub fn is_whitelisted(env: Env, id: Address) -> bool {
        read_flag(&env, &DataKey::Whitelisted(id))
    }

    pub fn is_frozen(env: Env, id: Address) -> bool {
        read_flag(&env, &DataKey::Frozen(id))
    }
}

/// SEP-41. The trait returns `()`, so failures surface through
/// `panic_with_error!` with a [`TokenError`] code.
#[contractimpl]
impl TokenInterface for FundToken {
    fn allowance(env: Env, from: Address, spender: Address) -> i128 {
        read_allowance(&env, &from, &spender).get()
    }

    fn approve(env: Env, from: Address, spender: Address, amount: i128, live_until_ledger: u32) {
        from.require_auth();
        let result = Amount::new(amount)
            .and_then(|amount| write_allowance(&env, &from, &spender, amount, live_until_ledger));
        result.or_panic(&env);
        bump_instance(&env);
        Approve {
            from,
            spender,
            amount,
            live_until_ledger,
        }
        .publish(&env);
    }

    fn balance(env: Env, id: Address) -> i128 {
        read_balance(&env, &id).get()
    }

    fn transfer(env: Env, from: Address, to: MuxedAddress, amount: i128) {
        from.require_auth();
        let recipient = to.address();
        let amount = Amount::new(amount).or_panic(&env);
        move_shares(&env, &from, &recipient, amount).or_panic(&env);
        bump_instance(&env);
        publish_transfer(&env, from, &to, amount);
    }

    fn transfer_from(env: Env, spender: Address, from: Address, to: Address, amount: i128) {
        spender.require_auth();
        let amount = Amount::new(amount).or_panic(&env);
        spend_allowance(&env, &from, &spender, amount).or_panic(&env);
        move_shares(&env, &from, &to, amount).or_panic(&env);
        bump_instance(&env);
        Transfer {
            from,
            to,
            amount: amount.get(),
        }
        .publish(&env);
    }

    fn burn(env: Env, from: Address, amount: i128) {
        from.require_auth();
        let amount = Amount::new(amount).or_panic(&env);
        destroy_shares(&env, &from, amount).or_panic(&env);
        bump_instance(&env);
        Burn {
            from,
            amount: amount.get(),
        }
        .publish(&env);
    }

    fn burn_from(env: Env, spender: Address, from: Address, amount: i128) {
        spender.require_auth();
        let amount = Amount::new(amount).or_panic(&env);
        spend_allowance(&env, &from, &spender, amount).or_panic(&env);
        destroy_shares(&env, &from, amount).or_panic(&env);
        bump_instance(&env);
        Burn {
            from,
            amount: amount.get(),
        }
        .publish(&env);
    }

    fn decimals(env: Env) -> u32 {
        read_metadata(&env).decimals
    }

    fn name(env: Env) -> String {
        read_metadata(&env).name
    }

    fn symbol(env: Env) -> String {
        read_metadata(&env).symbol
    }
}

// ---------------------------------------------------------------------------
// Movements of shares
// ---------------------------------------------------------------------------

/// Moves shares between two active holders.
fn move_shares(env: &Env, from: &Address, to: &Address, amount: Amount) -> Result<(), TokenError> {
    require_active(env, from)?;
    require_active(env, to)?;
    debit(env, from, amount)?;
    credit(env, to, amount)
}

/// Destroys shares held by an active holder (redemption).
fn destroy_shares(env: &Env, from: &Address, amount: Amount) -> Result<(), TokenError> {
    require_active(env, from)?;
    debit(env, from, amount)
}

/// An active holder is on the allowlist and not frozen.
fn require_active(env: &Env, id: &Address) -> Result<(), TokenError> {
    if !read_flag(env, &DataKey::Whitelisted(id.clone())) {
        return Err(TokenError::NotWhitelisted);
    }
    if read_flag(env, &DataKey::Frozen(id.clone())) {
        return Err(TokenError::Frozen);
    }
    Ok(())
}

fn credit(env: &Env, id: &Address, amount: Amount) -> Result<(), TokenError> {
    let balance = read_balance(env, id).plus(amount)?;
    write_balance(env, id, balance);
    Ok(())
}

fn debit(env: &Env, id: &Address, amount: Amount) -> Result<(), TokenError> {
    let balance = read_balance(env, id).minus(amount, TokenError::InsufficientBalance)?;
    write_balance(env, id, balance);
    Ok(())
}

fn publish_transfer(env: &Env, from: Address, to: &MuxedAddress, amount: Amount) {
    let recipient = to.address();
    match to.id() {
        Some(to_muxed_id) => TransferMuxed {
            from,
            to: recipient,
            to_muxed_id,
            amount: amount.get(),
        }
        .publish(env),
        None => Transfer {
            from,
            to: recipient,
            amount: amount.get(),
        }
        .publish(env),
    }
}

// ---------------------------------------------------------------------------
// Balances and allowances
// ---------------------------------------------------------------------------

fn read_balance(env: &Env, id: &Address) -> Amount {
    // Only `write_balance` stores balances, and it only stores `Amount`s.
    let raw: i128 = env
        .storage()
        .persistent()
        .get(&DataKey::Balance(id.clone()))
        .unwrap_or(0);
    Amount(raw)
}

fn write_balance(env: &Env, id: &Address, balance: Amount) {
    let key = DataKey::Balance(id.clone());
    env.storage().persistent().set(&key, &balance.get());
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
}

fn allowance_key(from: &Address, spender: &Address) -> DataKey {
    DataKey::Allowance(AllowanceKey {
        from: from.clone(),
        spender: spender.clone(),
    })
}

/// Allowance still spendable at the current ledger; zero once expired.
fn read_allowance(env: &Env, from: &Address, spender: &Address) -> Amount {
    let stored: Option<AllowanceValue> =
        env.storage().temporary().get(&allowance_key(from, spender));
    match stored {
        Some(value) if value.live_until_ledger >= env.ledger().sequence() => Amount(value.amount),
        _ => Amount::ZERO,
    }
}

fn read_allowance_expiration(env: &Env, from: &Address, spender: &Address) -> u32 {
    let stored: Option<AllowanceValue> =
        env.storage().temporary().get(&allowance_key(from, spender));
    stored.map_or(0, |value| value.live_until_ledger)
}

/// Stores an allowance valid up to `live_until_ledger` included. A zero
/// allowance removes the entry.
fn write_allowance(
    env: &Env,
    from: &Address,
    spender: &Address,
    amount: Amount,
    live_until_ledger: u32,
) -> Result<(), TokenError> {
    let key = allowance_key(from, spender);
    if amount == Amount::ZERO {
        env.storage().temporary().remove(&key);
        return Ok(());
    }
    let live_for = live_until_ledger
        .checked_sub(env.ledger().sequence())
        .ok_or(TokenError::InvalidExpiration)?;
    if live_for > env.storage().max_ttl() {
        return Err(TokenError::InvalidExpiration);
    }
    let value = AllowanceValue {
        amount: amount.get(),
        live_until_ledger,
    };
    env.storage().temporary().set(&key, &value);
    env.storage()
        .temporary()
        .extend_ttl(&key, live_for, live_for);
    Ok(())
}

fn spend_allowance(
    env: &Env,
    from: &Address,
    spender: &Address,
    amount: Amount,
) -> Result<(), TokenError> {
    let remaining =
        read_allowance(env, from, spender).minus(amount, TokenError::InsufficientAllowance)?;
    if amount == Amount::ZERO {
        return Ok(());
    }
    let live_until_ledger = read_allowance_expiration(env, from, spender);
    write_allowance(env, from, spender, remaining, live_until_ledger)
}

// ---------------------------------------------------------------------------
// Flags, admin and metadata
// ---------------------------------------------------------------------------

fn read_flag(env: &Env, key: &DataKey) -> bool {
    env.storage().persistent().has(key)
}

/// A flag is a persistent entry that exists while the flag is set.
fn write_flag(env: &Env, key: &DataKey, on: bool) {
    if on {
        env.storage().persistent().set(key, &true);
        env.storage()
            .persistent()
            .extend_ttl(key, BUMP_THRESHOLD, BUMP_TO);
    } else {
        env.storage().persistent().remove(key);
    }
}

fn read_admin(env: &Env) -> Result<Address, TokenError> {
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(TokenError::NotInitialized)
}

/// Loads the admin from storage and requires its authorization. Returns it.
fn require_admin(env: &Env) -> Result<Address, TokenError> {
    let admin = read_admin(env)?;
    admin.require_auth();
    Ok(admin)
}

fn read_metadata(env: &Env) -> TokenMetadata {
    env.storage()
        .instance()
        .get(&DataKey::Metadata)
        .unwrap_or_else(|| panic_with_error!(env, TokenError::NotInitialized))
}

fn bump_instance(env: &Env) {
    env.storage().instance().extend_ttl(BUMP_THRESHOLD, BUMP_TO);
}

/// Turns a typed error into a contract failure, for the SEP-41 entry points
/// whose signatures return `()`.
trait OrPanic<T> {
    fn or_panic(self, env: &Env) -> T;
}

impl<T> OrPanic<T> for Result<T, TokenError> {
    fn or_panic(self, env: &Env) -> T {
        self.unwrap_or_else(|error| panic_with_error!(env, error))
    }
}

mod test;
