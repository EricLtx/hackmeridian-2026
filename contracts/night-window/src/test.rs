#![cfg(test)]
// The security lints of the workspace target contract code. Tests assert,
// index and unwrap on purpose.
#![allow(
    clippy::arithmetic_side_effects,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::unwrap_used
)]
extern crate std;

use super::*;
use crate::math;
use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::{Address as _, ContractEvents, Events as _, Ledger as _, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    vec, Address, BytesN, Env, Event as _, IntoVal, Symbol, Val,
};

// ---------------------------------------------------------------------------
// Mock SEP-40 oracle
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone)]
enum MockKey {
    Base,
    Decimals,
    Price(Asset),
    Broken,
    Burning,
}

#[contract]
struct MockOracle;

#[contractimpl]
impl MockOracle {
    pub fn __constructor(env: Env, base: Asset, decimals: u32) {
        env.storage().instance().set(&MockKey::Base, &base);
        env.storage().instance().set(&MockKey::Decimals, &decimals);
    }

    pub fn set_price(env: Env, asset: Asset, price: i128, timestamp: u64) {
        env.storage()
            .instance()
            .set(&MockKey::Price(asset), &PriceData { price, timestamp });
    }

    pub fn base(env: Env) -> Asset {
        env.storage().instance().get(&MockKey::Base).unwrap()
    }

    pub fn decimals(env: Env) -> u32 {
        env.storage().instance().get(&MockKey::Decimals).unwrap()
    }

    /// Changes the decimals, which a SEP-40 feed should never do.
    pub fn set_decimals(env: Env, decimals: u32) {
        env.storage().instance().set(&MockKey::Decimals, &decimals);
    }

    pub fn lastprice(env: Env, asset: Asset) -> Option<PriceData> {
        if env.storage().instance().has(&MockKey::Broken) {
            panic!("feed down");
        }
        if env.storage().instance().has(&MockKey::Burning) {
            // Hashes until the host stops it for exhausting the CPU budget.
            // Bounded, so that a test host without a budget still ends.
            let block = soroban_sdk::Bytes::from_array(&env, &[0u8; 1_024]);
            for _ in 0..1_000_000 {
                env.crypto().sha256(&block);
            }
        }
        env.storage().instance().get(&MockKey::Price(asset))
    }

    /// Makes `lastprice` burn the caller's CPU budget.
    pub fn set_burning(env: Env, burning: bool) {
        if burning {
            env.storage().instance().set(&MockKey::Burning, &true);
        } else {
            env.storage().instance().remove(&MockKey::Burning);
        }
    }

    /// Makes `lastprice` trap, like a feed whose contract is broken.
    pub fn set_broken(env: Env, broken: bool) {
        if broken {
            env.storage().instance().set(&MockKey::Broken, &true);
        } else {
            env.storage().instance().remove(&MockKey::Broken);
        }
    }

    /// Keeps the feed's instance live for 200 days of ledgers.
    pub fn keep_alive(env: Env) {
        env.storage()
            .instance()
            .extend_ttl(200 * 17_280, 200 * 17_280);
    }
}

// ---------------------------------------------------------------------------
// Constants of the scenario
// ---------------------------------------------------------------------------

/// One token unit with 7 decimals, like every Stellar asset.
const ONE: i128 = 10_000_000;
const NAV_DECIMALS: u32 = 14;
/// 1.05 EUR per share.
const NAV_EUR: i128 = 105_000_000_000_000;
/// 1.17 USD per share.
const NAV_USD: i128 = 117_000_000_000_000;
/// 1.1188 USD per EUR, as read on the Reflector testnet FX feed on 14 Oct 2026.
const EUR_USD: i128 = 111_880_000_000_000;
const T0: u64 = 1_800_000_000;
const HOUR: u64 = 3_600;
const DAY: u64 = 86_400;
const RATE_BPS: u32 = 300;

fn eur(env: &Env) -> Symbol {
    Symbol::new(env, "EUR")
}

fn usd(env: &Env) -> Symbol {
    Symbol::new(env, "USD")
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

struct Fixture {
    env: Env,
    contract_id: Address,
    client: OpenWindowClient<'static>,
    governor: Address,
    guardian: Address,
    steward: Address,
    lender: Address,
    borrower: Address,
    shares: Address,
    eurc: Address,
    nav_oracle: Address,
    oracle: MockOracleClient<'static>,
}

fn leak<T>(value: T) -> &'static T {
    std::boxed::Box::leak(std::boxed::Box::new(value))
}

fn new_token(env: &Env) -> Address {
    let issuer = Address::generate(env);
    let asset = env.register_stellar_asset_contract_v2(issuer);
    // A permissioned issuer can revoke authorization, like a real fund share:
    // needed to test an issuer deauthorizing the contract during a repo (S9).
    asset
        .issuer()
        .set_flag(soroban_sdk::testutils::IssuerFlags::RevocableFlag);
    asset.address()
}

fn mint(env: &Env, token: &Address, to: &Address, amount: i128) {
    StellarAssetClient::new(env, token).mint(to, &amount);
}

fn balance(env: &Env, token: &Address, who: &Address) -> i128 {
    TokenClient::new(env, token).balance(who)
}

/// Registers Open Window: the natively compiled contract, or in the WASM
/// test mode (`NIGHT_WINDOW_TEST_WASM=1`, see build.rs) the release WASM,
/// so that the whole suite runs in the VM on the stack that WASM was linked
/// with.
#[cfg(not(night_window_test_wasm))]
fn register_open_window(env: &Env, governor: &Address) -> Address {
    env.register(OpenWindow, (governor.clone(),))
}

#[cfg(night_window_test_wasm)]
fn register_open_window(env: &Env, governor: &Address) -> Address {
    env.register(NIGHT_WINDOW_WASM, (governor.clone(),))
}

/// Ledger entries an invocation of Open Window reads beyond those it reads
/// natively compiled: its code entry, in the WASM test mode.
const CODE_ENTRY: u32 = cfg!(night_window_test_wasm) as u32;

/// Deployed contract, roles, tokens and a EUR NAV oracle. Nothing admitted.
fn bare() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(T0);
    let governor = Address::generate(&env);
    let contract_id = register_open_window(&env, &governor);
    let client = OpenWindowClient::new(leak(env.clone()), leak(contract_id.clone()));
    let nav_oracle = env.register(MockOracle, (Asset::Other(eur(&env)), NAV_DECIMALS));
    let oracle = MockOracleClient::new(leak(env.clone()), leak(nav_oracle.clone()));
    let shares = new_token(&env);
    oracle.set_price(&Asset::Stellar(shares.clone()), &NAV_EUR, &T0);
    Fixture {
        guardian: governor.clone(),
        steward: Address::generate(&env),
        lender: Address::generate(&env),
        borrower: Address::generate(&env),
        eurc: new_token(&env),
        env,
        contract_id,
        client,
        governor,
        shares,
        nav_oracle,
        oracle,
    }
}

fn fund_config(f: &Fixture) -> FundConfig {
    FundConfig {
        oracle: f.nav_oracle.clone(),
        oracle_asset: Asset::Stellar(f.shares.clone()),
        haircut_bps: 200,
        steward: f.steward.clone(),
        currency: eur(&f.env),
        source: PriceSource::Direct,
        nav_max_age_secs: 26 * HOUR,
        corridor_floor_bps: 10,
        max_yield_bps: 500,
        max_principal_per_repo: 500_000 * ONE,
        max_outstanding: 5_000_000 * ONE,
    }
}

/// Hash of a lender's off-chain declaration, as the lender and the steward
/// sign it.
fn declaration(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

/// Attests then approves `lender` for `fund`: from version 4 an approval
/// needs the attestation the lender and the steward signed.
fn admit_lender(client: &OpenWindowClient, env: &Env, fund: &Address, lender: &Address) {
    client.attest_lender(fund, lender, &declaration(env, 0xA7));
    client.approve_lender(fund, lender, &true);
}

/// Fund admitted, EURC registered with a cap, lender attested and approved,
/// balances minted, one offer of 100,000 EURC at 3 %.
fn ready() -> (Fixture, u64) {
    ready_from(bare())
}

/// `ready` on a fixture prepared beforehand, for instance in sole-lender
/// mode.
fn ready_from(f: Fixture) -> (Fixture, u64) {
    let config = fund_config(&f);
    ready_with(f, config)
}

/// `ready` with another configuration of the fund.
fn ready_with(f: Fixture, config: FundConfig) -> (Fixture, u64) {
    f.client.set_stablecoin(&f.eurc, &eur(&f.env));
    f.client.set_currency_cap(&eur(&f.env), &(10_000_000 * ONE));
    f.client.set_fund(&f.shares, &config);
    admit_lender(&f.client, &f.env, &f.shares, &f.lender);
    mint(&f.env, &f.eurc, &f.lender, 1_000_000 * ONE);
    mint(&f.env, &f.eurc, &f.borrower, 100_000 * ONE);
    mint(&f.env, &f.shares, &f.borrower, 1_000_000 * ONE);
    let offer_id = f.client.create_offer(
        &f.lender,
        &f.eurc,
        &(100_000 * ONE),
        &RATE_BPS,
        &(7 * DAY),
        &vec![&f.env, f.shares.clone()],
    );
    (f, offer_id)
}

/// Opens a repo of 10,000 shares against 10,000 EURC for 64 hours.
fn open(f: &Fixture, offer_id: u64) -> u64 {
    f.client.open_repo(
        &f.borrower,
        &offer_id,
        &f.shares,
        &(10_000 * ONE),
        &(10_000 * ONE),
        &(64 * HOUR),
    )
}

fn advance(f: &Fixture, seconds: u64) {
    let now = f.env.ledger().timestamp();
    f.env.ledger().set_timestamp(now + seconds);
}

/// Publishes a NAV for the fund's shares, stamped at the current ledger time.
fn publish_nav(f: &Fixture, nav: i128) {
    let now = f.env.ledger().timestamp();
    f.oracle
        .set_price(&Asset::Stellar(f.shares.clone()), &nav, &now);
}

/// Events published by Open Window itself during the last invocation, in
/// XDR, for comparison with the expected `#[contractevent]` values.
fn own_events(f: &Fixture) -> ContractEvents {
    f.env.events().all().filter_by_contract(&f.contract_id)
}

/// Appoints a guardian distinct from the governor. After the first
/// admission the appointment goes through the time delay; the NAV is then
/// republished so the fixture stays priced.
fn appoint_guardian(f: &Fixture) -> Address {
    let guardian = Address::generate(&f.env);
    f.client.set_guardian(&guardian);
    if f.client.pending_guardian_change().is_some() {
        advance(f, f.client.timelock_delay());
        f.client.apply_guardian_change();
        let reference = f
            .client
            .get_fund_state(&f.shares)
            .map_or(NAV_EUR, |state| state.reference_nav);
        publish_nav(f, reference);
    }
    assert_eq!(f.client.guardian(), guardian);
    guardian
}

/// TTL the contract gives a persistent entry when it extends it: 120 days.
const BUMP_TO_LEDGERS: u32 = 120 * 17_280;
/// Below this TTL (30 days) the contract extends an entry it touches.
const BUMP_THRESHOLD_LEDGERS: u32 = 30 * 17_280;

/// Lets 91 days of ledgers pass without touching anything: an entry written
/// just before is left with 29 days, under the extension threshold, while
/// every entry written during the test stays live.
fn age_ledgers(f: &Fixture) {
    f.env
        .ledger()
        .with_mut(|ledger| ledger.sequence_number += 91 * 17_280);
}

fn entry_ttl(f: &Fixture, key: &DataKey) -> u32 {
    use soroban_sdk::testutils::storage::Persistent as _;
    f.env
        .as_contract(&f.contract_id, || f.env.storage().persistent().get_ttl(key))
}

/// A contract error as raised by an entry point that returns no `Result`.
fn raised(error: Error) -> soroban_sdk::Error {
    soroban_sdk::Error::from_contract_error(error as u32)
}

// ---------------------------------------------------------------------------
// Governor, guardian and envelope
// ---------------------------------------------------------------------------

#[test]
fn constructor_sets_roles_and_defaults() {
    let f = bare();
    assert_eq!(f.client.admin(), f.governor);
    assert_eq!(f.client.guardian(), f.governor);
    assert_eq!(f.client.version(), 4);
    assert_eq!(f.client.timelock_delay(), DEFAULT_TIMELOCK_SECS);
    assert_eq!(f.client.pending_upgrade(), None);
    assert_eq!(f.client.max_term(), DEFAULT_MAX_TERM_SECS);
    assert_eq!(f.client.envelope(), default_envelope());
    assert!(!f.client.is_paused());
    assert_eq!(f.client.currency_cap(&eur(&f.env)), 0);
}

#[test]
fn intruder_cannot_take_the_governor_role() {
    let f = bare();
    let intruder = Address::generate(&f.env);
    f.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "set_admin",
            args: (intruder.clone(),).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_set_admin(&intruder).is_err());
    assert_eq!(f.client.admin(), f.governor);
}

#[test]
fn governor_handover_takes_two_steps() {
    let f = bare();
    let successor = Address::generate(&f.env);
    f.client.set_admin(&successor);
    assert_eq!(f.client.admin(), f.governor);
    f.client.accept_admin();
    assert_eq!(f.env.auths()[0].0, successor);
    assert_eq!(f.client.admin(), successor);
    assert_eq!(f.client.try_accept_admin(), Err(Ok(Error::Unauthorized)));
}

#[test]
fn intruder_cannot_upgrade() {
    let f = bare();
    let intruder = Address::generate(&f.env);
    let hash = soroban_sdk::BytesN::from_array(&f.env, &[7u8; 32]);
    f.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "upgrade",
            args: (hash.clone(),).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_upgrade(&hash).is_err());
}

#[test]
fn max_term_cannot_go_below_the_minimum_term() {
    let f = bare();
    assert_eq!(
        f.client.try_set_max_term(&(MIN_TERM_SECS - 1)),
        Err(Ok(Error::InvalidTerm))
    );
    assert_eq!(
        f.client.try_set_max_term(&(MAX_TERM_CEILING_SECS + 1)),
        Err(Ok(Error::InvalidTerm))
    );
    f.client.set_max_term(&(3 * DAY));
    assert_eq!(f.client.max_term(), 3 * DAY);
}

#[test]
fn envelope_rejects_a_haircut_of_one_unit() {
    let f = bare();
    let mut envelope = default_envelope();
    envelope.min_haircut_bps = 10_000;
    assert_eq!(
        f.client.try_set_envelope(&envelope),
        Err(Ok(Error::InvalidHaircut))
    );
}

#[test]
fn guardian_pauses_intruder_cannot_and_only_governor_unpauses() {
    let f = bare();
    let guardian = Address::generate(&f.env);
    f.client.set_guardian(&guardian);
    let intruder = Address::generate(&f.env);
    assert_eq!(f.client.try_pause(&intruder), Err(Ok(Error::Unauthorized)));
    f.client.pause(&guardian);
    assert_eq!(f.env.auths()[0].0, guardian);
    assert!(f.client.is_paused());
    f.client.unpause();
    assert_eq!(f.env.auths()[0].0, f.governor);
    assert!(!f.client.is_paused());
}

// ---------------------------------------------------------------------------
// Fund admission: two keys, envelope, currencies, fresh price
// ---------------------------------------------------------------------------

#[test]
fn admission_requires_the_steward_signature_too() {
    let f = bare();
    let config = fund_config(&f);
    f.env.mock_auths(&[MockAuth {
        address: &f.governor,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "set_fund",
            args: (f.shares.clone(), config.clone()).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_set_fund(&f.shares, &config).is_err());
    assert!(f.client.get_fund(&f.shares).is_none());
}

#[test]
fn admission_reads_decimals_and_anchors_the_reference() {
    let f = bare();
    f.client.set_fund(&f.shares, &fund_config(&f));
    let state = f.client.get_fund_state(&f.shares).unwrap();
    assert_eq!(state.share_decimals, 7);
    assert_eq!(state.nav_decimals, NAV_DECIMALS);
    assert_eq!(state.reference_nav, NAV_EUR);
    assert_eq!(state.reference_time, T0);
    assert_eq!(state.outstanding, 0);
    assert_eq!(state.currency, eur(&f.env));
}

#[test]
fn admission_enforces_the_envelope() {
    let f = bare();
    let mut low_haircut = fund_config(&f);
    low_haircut.haircut_bps = 50;
    let mut wide_floor = fund_config(&f);
    wide_floor.corridor_floor_bps = 100;
    let mut no_age = fund_config(&f);
    no_age.nav_max_age_secs = 0;
    let mut fast_growth = fund_config(&f);
    fast_growth.max_yield_bps = 2_000;
    for config in [low_haircut, wide_floor, no_age, fast_growth] {
        assert_eq!(
            f.client.try_set_fund(&f.shares, &config),
            Err(Ok(Error::OutsideEnvelope))
        );
    }
    let mut caps = fund_config(&f);
    caps.max_principal_per_repo = caps.max_outstanding + 1;
    assert_eq!(
        f.client.try_set_fund(&f.shares, &caps),
        Err(Ok(Error::InvalidAmount))
    );
}

#[test]
fn admission_refuses_an_oracle_in_the_wrong_currency() {
    let f = bare();
    let mut config = fund_config(&f);
    config.currency = usd(&f.env);
    assert_eq!(
        f.client.try_set_fund(&f.shares, &config),
        Err(Ok(Error::CurrencyMismatch))
    );
}

#[test]
fn admission_needs_a_fresh_price() {
    let f = bare();
    advance(&f, 27 * HOUR);
    assert_eq!(
        f.client.try_set_fund(&f.shares, &fund_config(&f)),
        Err(Ok(Error::StalePrice))
    );
    let unknown = new_token(&f.env);
    let mut config = fund_config(&f);
    config.oracle_asset = Asset::Stellar(unknown);
    assert_eq!(
        f.client.try_set_fund(&f.shares, &config),
        Err(Ok(Error::NoPrice))
    );
}

/// A SEP-40 feed in `base` publishing with `decimals`.
fn feed_with_decimals(
    f: &Fixture,
    base: Symbol,
    decimals: u32,
) -> (Address, MockOracleClient<'static>) {
    let id = f.env.register(MockOracle, (Asset::Other(base), decimals));
    let feed = MockOracleClient::new(leak(f.env.clone()), leak(id.clone()));
    (id, feed)
}

/// Review finding arith-4 (20 October 2026): the corridor and the bands are
/// computed in units of the feed, and with 2 decimals a 0.5 % floor admitted
/// a whole percent either way. A NAV, FX or fallback feed publishing with
/// fewer than `MIN_FEED_DECIMALS` (6) is refused: at admission, at a
/// replacement, and when a fallback is proposed or applied.
#[test]
fn a_feed_with_fewer_than_six_decimals_is_refused() {
    let f = bare();
    let shares = Asset::Stellar(f.shares.clone());
    let (coarse, coarse_feed) = feed_with_decimals(&f, eur(&f.env), MIN_FEED_DECIMALS - 1);
    coarse_feed.set_price(&shares, &105_000, &T0);
    let coarse_config = FundConfig {
        oracle: coarse,
        ..fund_config(&f)
    };
    assert_eq!(
        f.client.try_set_fund(&f.shares, &coarse_config),
        Err(Ok(Error::OutsideEnvelope))
    );
    let (fine, fine_feed) = feed_with_decimals(&f, eur(&f.env), MIN_FEED_DECIMALS);
    fine_feed.set_price(&shares, &1_050_000, &T0);
    f.client.set_fund(
        &f.shares,
        &FundConfig {
            oracle: fine,
            ..fund_config(&f)
        },
    );
    assert_eq!(
        f.client.get_fund_state(&f.shares).unwrap().nav_decimals,
        MIN_FEED_DECIMALS
    );
    // A replacement by the coarse feed.
    assert_eq!(
        f.client.try_set_fund(&f.shares, &coarse_config),
        Err(Ok(Error::OutsideEnvelope))
    );

    // A fallback, proposed then applied.
    let (backup, backup_feed) = feed_with_decimals(&f, eur(&f.env), MIN_FEED_DECIMALS - 1);
    backup_feed.set_price(&shares, &105_000, &T0);
    let proposal = fallback_feed(&f, &backup);
    assert_eq!(
        f.client.try_propose_fallback(&f.shares, &proposal),
        Err(Ok(Error::OutsideEnvelope))
    );
    backup_feed.set_decimals(&MIN_FEED_DECIMALS);
    backup_feed.set_price(&shares, &1_050_000, &T0);
    f.client.propose_fallback(&f.shares, &proposal);
    advance(&f, DEFAULT_TIMELOCK_SECS);
    let now = f.env.ledger().timestamp();
    fine_feed.set_price(&shares, &1_050_000, &now);
    backup_feed.set_price(&shares, &1_050_000, &now);
    backup_feed.set_decimals(&(MIN_FEED_DECIMALS - 1));
    assert_eq!(
        f.client.try_apply_fallback(&f.shares),
        Err(Ok(Error::OutsideEnvelope))
    );
    backup_feed.set_decimals(&MIN_FEED_DECIMALS);
    f.client.apply_fallback(&f.shares);
    assert!(f.client.get_fallback(&f.shares).is_some());

    // The FX feed of a cross fund.
    let f = bare();
    let (nav_oracle, nav_feed) = feed_with_decimals(&f, usd(&f.env), NAV_DECIMALS);
    nav_feed.set_price(&Asset::Stellar(f.shares.clone()), &NAV_USD, &T0);
    let (fx_oracle, fx_feed) = feed_with_decimals(&f, usd(&f.env), MIN_FEED_DECIMALS - 1);
    fx_feed.set_price(&Asset::Other(eur(&f.env)), &111_880, &T0);
    let config = FundConfig {
        oracle: nav_oracle,
        source: PriceSource::Cross(FxLeg {
            oracle: fx_oracle,
            asset: Asset::Other(eur(&f.env)),
            haircut_bps: 200,
            max_age_secs: 3 * DAY,
            band_bps: 200,
        }),
        ..fund_config(&f)
    };
    assert_eq!(
        f.client.try_set_fund(&f.shares, &config),
        Err(Ok(Error::OutsideEnvelope))
    );
    fx_feed.set_decimals(&MIN_FEED_DECIMALS);
    fx_feed.set_price(&Asset::Other(eur(&f.env)), &1_118_800, &T0);
    f.client.set_fund(&f.shares, &config);
    assert_eq!(
        f.client.get_fund_state(&f.shares).unwrap().fx_decimals,
        MIN_FEED_DECIMALS
    );
}

/// Review finding VAL-3 (20 October 2026): a feed publishing with more than
/// `MAX_FEED_DECIMALS` (18) is refused wherever the floor of six decimals
/// is checked: at admission and at a replacement (NAV and FX feeds), at a
/// fallback's proposal, and at a re-anchor. Beyond 18 decimals the share
/// value leaves the domain its arithmetic covers, and a fund could be
/// admitted that never prices.
#[test]
fn a_feed_with_more_than_eighteen_decimals_is_refused() {
    let f = bare();
    let shares = Asset::Stellar(f.shares.clone());
    let (finest, finest_feed) = feed_with_decimals(&f, eur(&f.env), MAX_FEED_DECIMALS + 1);
    finest_feed.set_price(&shares, &(NAV_EUR * 100_000), &T0);
    let finest_config = FundConfig {
        oracle: finest,
        ..fund_config(&f)
    };
    assert_eq!(
        f.client.try_set_fund(&f.shares, &finest_config),
        Err(Ok(Error::OutsideEnvelope))
    );
    let (fine, fine_feed) = feed_with_decimals(&f, eur(&f.env), MAX_FEED_DECIMALS);
    fine_feed.set_price(&shares, &(NAV_EUR * 10_000), &T0);
    f.client.set_fund(
        &f.shares,
        &FundConfig {
            oracle: fine,
            ..fund_config(&f)
        },
    );
    assert_eq!(
        f.client.get_fund_state(&f.shares).unwrap().nav_decimals,
        MAX_FEED_DECIMALS
    );
    // A replacement by the finer feed.
    assert_eq!(
        f.client.try_set_fund(&f.shares, &finest_config),
        Err(Ok(Error::OutsideEnvelope))
    );
    // A fallback.
    let (backup, backup_feed) = feed_with_decimals(&f, eur(&f.env), MAX_FEED_DECIMALS + 1);
    backup_feed.set_price(&shares, &(NAV_EUR * 100_000), &T0);
    assert_eq!(
        f.client
            .try_propose_fallback(&f.shares, &fallback_feed(&f, &backup)),
        Err(Ok(Error::OutsideEnvelope))
    );
    // A re-anchor, reading a feed that now reports more decimals, which a
    // SEP-40 feed should never do.
    fine_feed.set_decimals(&(MAX_FEED_DECIMALS + 1));
    fine_feed.set_price(&shares, &(NAV_EUR * 100_000), &T0);
    assert_eq!(
        f.client
            .try_propose_reanchor(&f.shares, &(NAV_EUR * 100_000), &0),
        Err(Ok(Error::OutsideEnvelope))
    );
    assert_eq!(f.client.pending_reanchor(&f.shares), None);

    // The FX feed of a cross fund.
    let f = bare();
    let (nav_oracle, nav_feed) = feed_with_decimals(&f, usd(&f.env), NAV_DECIMALS);
    nav_feed.set_price(&Asset::Stellar(f.shares.clone()), &NAV_USD, &T0);
    let (fx_oracle, fx_feed) = feed_with_decimals(&f, usd(&f.env), MAX_FEED_DECIMALS + 1);
    fx_feed.set_price(&Asset::Other(eur(&f.env)), &(EUR_USD * 100_000), &T0);
    let config = FundConfig {
        oracle: nav_oracle,
        source: PriceSource::Cross(FxLeg {
            oracle: fx_oracle,
            asset: Asset::Other(eur(&f.env)),
            haircut_bps: 200,
            max_age_secs: 3 * DAY,
            band_bps: 200,
        }),
        ..fund_config(&f)
    };
    assert_eq!(
        f.client.try_set_fund(&f.shares, &config),
        Err(Ok(Error::OutsideEnvelope))
    );
    fx_feed.set_decimals(&MAX_FEED_DECIMALS);
    fx_feed.set_price(&Asset::Other(eur(&f.env)), &(EUR_USD * 10_000), &T0);
    f.client.set_fund(&f.shares, &config);
    assert_eq!(
        f.client.get_fund_state(&f.shares).unwrap().fx_decimals,
        MAX_FEED_DECIMALS
    );
}

/// Review finding VAL-3 (20 October 2026): a cross fund whose NAV and FX
/// feeds both publish with 18 decimals. The cross price formed the NAV
/// times 10^18 before dividing by the rate, which exceeds i128 above 170.14
/// per share: a 1,000 USD share was admitted, then every quote and opening
/// failed with `ArithmeticOverflow`. It now prices at the exact floor of
/// the division, at the old edge and above it, and an opening lends what
/// the quote announces.
#[test]
fn an_eighteen_decimal_cross_fund_prices_a_thousand_dollar_share() {
    let e18 = 10i128.pow(18);
    let rate = 112 * e18 / 100;
    for nav in [170 * e18, 171 * e18, 1_000 * e18] {
        let f = bare();
        let (nav_oracle, nav_feed) = feed_with_decimals(&f, usd(&f.env), 18);
        let (fx_oracle, fx_feed) = feed_with_decimals(&f, usd(&f.env), 18);
        nav_feed.set_price(&Asset::Stellar(f.shares.clone()), &nav, &T0);
        fx_feed.set_price(&Asset::Other(eur(&f.env)), &rate, &T0);
        let config = FundConfig {
            oracle: nav_oracle,
            source: PriceSource::Cross(FxLeg {
                oracle: fx_oracle,
                asset: Asset::Other(eur(&f.env)),
                haircut_bps: 200,
                max_age_secs: 3 * DAY,
                band_bps: 200,
            }),
            ..fund_config(&f)
        };
        let (f, offer_id) = ready_with(f, config);
        let quote = f.client.quote(&f.shares, &ONE, &f.eurc);
        // floor(nav * 10^18 / (1.12 * 10^18)), the price of one share in EUR.
        let price = nav * 100 / 112;
        assert_eq!((quote.price, quote.price_decimals), (price, 18));
        assert_eq!(quote.haircut_bps, 400);
        assert_eq!(quote.max_principal, ONE * price / e18 * 9_600 / 10_000);
        let repo_id = f.client.open_repo(
            &f.borrower,
            &offer_id,
            &f.shares,
            &ONE,
            &quote.max_principal,
            &DAY,
        );
        assert_eq!(
            f.client.get_repo(&repo_id).unwrap().principal,
            quote.max_principal
        );
    }
}

/// Review finding VAL-3, second round (20 October 2026): the split still
/// formed the remainder times `10^d`, which overflows for an 18-decimal
/// rate above about 170, so a cross fund with JPY-based feeds at EUR/JPY
/// 175 was admitted, priced at 345 JPY a share and failed with
/// `ArithmeticOverflow` at 349 JPY, where the remainder is 174 x 10^18. The
/// remainder now goes through a wide product: both NAVs price at the exact
/// floor, about 1.97 and 1.99 EUR, and an opening lends what the quote
/// announces.
#[test]
fn an_eighteen_decimal_rate_above_one_hundred_seventy_prices_every_nav() {
    let e18 = 10i128.pow(18);
    let rate = 175 * e18;
    let price_of = |nav: i128| {
        let f = bare();
        let jpy = Symbol::new(&f.env, "JPY");
        let (nav_oracle, nav_feed) = feed_with_decimals(&f, jpy.clone(), 18);
        let (fx_oracle, fx_feed) = feed_with_decimals(&f, jpy, 18);
        nav_feed.set_price(&Asset::Stellar(f.shares.clone()), &nav, &T0);
        fx_feed.set_price(&Asset::Other(eur(&f.env)), &rate, &T0);
        let config = FundConfig {
            oracle: nav_oracle,
            source: PriceSource::Cross(FxLeg {
                oracle: fx_oracle,
                asset: Asset::Other(eur(&f.env)),
                haircut_bps: 200,
                max_age_secs: 3 * DAY,
                band_bps: 200,
            }),
            ..fund_config(&f)
        };
        let (f, offer_id) = ready_with(f, config);
        let quote = f.client.quote(&f.shares, &ONE, &f.eurc);
        let repo_id = f.client.open_repo(
            &f.borrower,
            &offer_id,
            &f.shares,
            &ONE,
            &quote.max_principal,
            &DAY,
        );
        assert_eq!(
            f.client.get_repo(&repo_id).unwrap().principal,
            quote.max_principal
        );
        (quote.price, quote.price_decimals)
    };
    // floor(nav x 10^18 / (175 x 10^18)) = floor(nav / 175), in 18 decimals.
    assert_eq!(price_of(345 * e18), (345 * e18 / 175, 18));
    assert!((174 * e18).checked_mul(e18).is_none());
    assert_eq!(price_of(349 * e18), (349 * e18 / 175, 18));
}

/// A re-anchor installs references in the decimals of the feeds it reads,
/// so the same rule holds there: a NAV or FX feed publishing with fewer than
/// `MIN_FEED_DECIMALS` is refused when the re-anchor is proposed, and when
/// one proposed before rc5 applies. The feed here changes its decimals,
/// which a SEP-40 feed should never do, as a fund admitted under rc4 with a
/// coarse feed would read.
#[test]
fn a_reanchor_needs_feeds_of_six_decimals_or_more() {
    let (f, _) = ready();
    let shares = Asset::Stellar(f.shares.clone());
    f.oracle.set_decimals(&(MIN_FEED_DECIMALS - 1));
    f.oracle.set_price(&shares, &105_000, &T0);
    assert_eq!(
        f.client.try_propose_reanchor(&f.shares, &105_000, &0),
        Err(Ok(Error::OutsideEnvelope))
    );
    assert_eq!(f.client.pending_reanchor(&f.shares), None);

    // The same readings, proposed under rc4.
    f.env.as_contract(&f.contract_id, || {
        crate::storage::set_pending_reanchor(
            &f.env,
            &f.shares,
            &PendingReanchor {
                nav_oracle: f.nav_oracle.clone(),
                nav_asset: shares.clone(),
                nav: 105_000,
                nav_time: T0,
                nav_decimals: MIN_FEED_DECIMALS - 1,
                fx: AnchorFx::Direct,
                eta: T0,
            },
        );
    });
    assert_eq!(
        f.client.try_apply_reanchor(&f.shares),
        Err(Ok(Error::OutsideEnvelope))
    );
    let state = f.client.get_fund_state(&f.shares).unwrap();
    assert_eq!(
        (state.reference_nav, state.nav_decimals),
        (NAV_EUR, NAV_DECIMALS)
    );

    // The FX feed of a cross fund, refused below six decimals, read at six.
    let (f, fx_oracle) = cross_fund();
    let fx_feed = MockOracleClient::new(&f.env, &fx_oracle);
    let eur_asset = Asset::Other(eur(&f.env));
    fx_feed.set_decimals(&(MIN_FEED_DECIMALS - 1));
    fx_feed.set_price(&eur_asset, &111_880, &T0);
    assert_eq!(
        f.client.try_propose_reanchor(&f.shares, &NAV_USD, &111_880),
        Err(Ok(Error::OutsideEnvelope))
    );
    fx_feed.set_decimals(&MIN_FEED_DECIMALS);
    fx_feed.set_price(&eur_asset, &1_118_800, &T0);
    f.client.propose_reanchor(&f.shares, &NAV_USD, &1_118_800);
    let pending = f.client.pending_reanchor(&f.shares).unwrap();
    assert_eq!(
        pending.fx.rate().map(|rate| rate.decimals),
        Some(MIN_FEED_DECIMALS)
    );
}

// ---------------------------------------------------------------------------
// Valuation: direct, cross, corridor, freshness
// ---------------------------------------------------------------------------

#[test]
fn quote_values_shares_minus_the_haircut() {
    let (f, _) = ready();
    let quote = f.client.quote(&f.shares, &(10_000 * ONE), &f.eurc);
    assert_eq!(quote.price, NAV_EUR);
    assert_eq!(quote.haircut_bps, 200);
    // 10,000 shares x 1.05 EUR x 98 % = 10,290 EUR.
    assert_eq!(quote.max_principal, 10_290 * ONE);
    // A fund priced directly has no FX leg.
    assert!(contract_valuation(&f).fx.is_none());
}

/// A fund whose NAV oracle reports in USD, borrowed against in EUR through an
/// FX feed reporting in the same USD base.
fn cross_fund() -> (Fixture, Address) {
    let f = bare();
    let usd_oracle = f
        .env
        .register(MockOracle, (Asset::Other(usd(&f.env)), NAV_DECIMALS));
    let usd_client = MockOracleClient::new(&f.env, &usd_oracle);
    usd_client.set_price(&Asset::Stellar(f.shares.clone()), &NAV_USD, &T0);
    let fx_oracle = f
        .env
        .register(MockOracle, (Asset::Other(usd(&f.env)), NAV_DECIMALS));
    MockOracleClient::new(&f.env, &fx_oracle).set_price(&Asset::Other(eur(&f.env)), &EUR_USD, &T0);
    let mut config = fund_config(&f);
    config.oracle = usd_oracle;
    config.source = PriceSource::Cross(FxLeg {
        oracle: fx_oracle.clone(),
        asset: Asset::Other(eur(&f.env)),
        haircut_bps: 200,
        max_age_secs: 3 * DAY,
        band_bps: 200,
    });
    f.client.set_stablecoin(&f.eurc, &eur(&f.env));
    // Raised before the first admission: afterwards an increase waits.
    f.client.set_currency_cap(&eur(&f.env), &(10_000_000 * ONE));
    f.client.set_fund(&f.shares, &config);
    (f, fx_oracle)
}

#[test]
fn cross_price_converts_the_nav_and_adds_the_fx_haircut() {
    let (f, _) = cross_fund();
    let quote = f.client.quote(&f.shares, &(10_000 * ONE), &f.eurc);
    let expected_price = NAV_USD * 10i128.pow(NAV_DECIMALS) / EUR_USD;
    assert_eq!(quote.price, expected_price);
    assert_eq!(quote.haircut_bps, 400);
    let value = 10_000 * ONE * expected_price / 10i128.pow(NAV_DECIMALS);
    assert_eq!(quote.max_principal, value * 9_600 / 10_000);
}

#[test]
fn cross_fund_refuses_an_fx_feed_in_another_base() {
    let f = bare();
    let usd_oracle = f
        .env
        .register(MockOracle, (Asset::Other(usd(&f.env)), NAV_DECIMALS));
    MockOracleClient::new(&f.env, &usd_oracle).set_price(
        &Asset::Stellar(f.shares.clone()),
        &NAV_USD,
        &T0,
    );
    let eur_based = f
        .env
        .register(MockOracle, (Asset::Other(eur(&f.env)), NAV_DECIMALS));
    let mut config = fund_config(&f);
    config.oracle = usd_oracle;
    config.source = PriceSource::Cross(FxLeg {
        oracle: eur_based,
        asset: Asset::Other(eur(&f.env)),
        haircut_bps: 200,
        max_age_secs: 3 * DAY,
        band_bps: 200,
    });
    assert_eq!(
        f.client.try_set_fund(&f.shares, &config),
        Err(Ok(Error::CurrencyMismatch))
    );
}

#[test]
fn cross_fund_refuses_an_fx_haircut_below_the_envelope() {
    let f = bare();
    let usd_oracle = f
        .env
        .register(MockOracle, (Asset::Other(usd(&f.env)), NAV_DECIMALS));
    MockOracleClient::new(&f.env, &usd_oracle).set_price(
        &Asset::Stellar(f.shares.clone()),
        &NAV_USD,
        &T0,
    );
    let fx = f
        .env
        .register(MockOracle, (Asset::Other(usd(&f.env)), NAV_DECIMALS));
    let mut config = fund_config(&f);
    config.oracle = usd_oracle;
    config.source = PriceSource::Cross(FxLeg {
        oracle: fx,
        asset: Asset::Other(eur(&f.env)),
        haircut_bps: 100,
        max_age_secs: 3 * DAY,
        band_bps: 200,
    });
    assert_eq!(
        f.client.try_set_fund(&f.shares, &config),
        Err(Ok(Error::OutsideEnvelope))
    );
}

/// Economic model of 17 October 2026 (I16) and decision S22: the FX band may
/// not exceed the FX haircut, otherwise an in-band wrong rate lends beyond
/// the haircut-adjusted value.
#[test]
fn fx_band_wider_than_the_fx_haircut_is_refused_at_admission() {
    let f = bare();
    let usd_oracle = f
        .env
        .register(MockOracle, (Asset::Other(usd(&f.env)), NAV_DECIMALS));
    MockOracleClient::new(&f.env, &usd_oracle).set_price(
        &Asset::Stellar(f.shares.clone()),
        &NAV_USD,
        &T0,
    );
    let fx = f
        .env
        .register(MockOracle, (Asset::Other(usd(&f.env)), NAV_DECIMALS));
    MockOracleClient::new(&f.env, &fx).set_price(&Asset::Other(eur(&f.env)), &EUR_USD, &T0);
    f.client.set_stablecoin(&f.eurc, &eur(&f.env));
    let mut config = fund_config(&f);
    config.oracle = usd_oracle;
    let leg = |band_bps: u32| FxLeg {
        oracle: fx.clone(),
        asset: Asset::Other(eur(&f.env)),
        haircut_bps: 200,
        max_age_secs: 3 * DAY,
        band_bps,
    };
    config.source = PriceSource::Cross(leg(201));
    assert_eq!(
        f.client.try_set_fund(&f.shares, &config),
        Err(Ok(Error::FxBandExceedsHaircut))
    );
    // Equal is allowed: a rate below the reference is priced at the
    // reference (rc5, review finding arith-1), so a rate the band admits
    // overvalues the shares by at most the market's move above the
    // reference. That move is at most the band, or honest rates would fail
    // the band, and the FX haircut covers the band.
    config.source = PriceSource::Cross(leg(200));
    f.client.set_fund(&f.shares, &config);
}

/// Review finding M3: a faulty FX feed cannot inflate the collateral.
#[test]
fn fx_rate_outside_its_band_blocks_the_quote() {
    let (f, fx_oracle) = cross_fund();
    MockOracleClient::new(&f.env, &fx_oracle).set_price(
        &Asset::Other(eur(&f.env)),
        &(EUR_USD * 97 / 100),
        &T0,
    );
    assert_eq!(
        f.client.try_quote(&f.shares, &ONE, &f.eurc),
        Err(Ok(Error::PriceOutOfBand))
    );
    MockOracleClient::new(&f.env, &fx_oracle).set_price(
        &Asset::Other(eur(&f.env)),
        &(EUR_USD * 99 / 100),
        &T0,
    );
    assert!(f.client.try_quote(&f.shares, &ONE, &f.eurc).is_ok());
}

#[test]
fn stale_fx_rate_blocks_the_quote() {
    let (f, _) = cross_fund();
    advance(&f, 3 * DAY + 1);
    MockOracleClient::new(&f.env, &f.client.get_fund(&f.shares).unwrap().oracle).set_price(
        &Asset::Stellar(f.shares.clone()),
        &NAV_USD,
        &(T0 + 3 * DAY),
    );
    assert_eq!(
        f.client.try_quote(&f.shares, &ONE, &f.eurc),
        Err(Ok(Error::StalePrice))
    );
}

/// A cross fund at the settings of review finding arith-1 (20 October
/// 2026): fund haircut 1 %, FX haircut and FX band 1.5 % each, the band as
/// wide as S22 allows. An approved lender offers 100,000 EURC and the
/// borrower holds 10,000 shares. Returns the offer, the NAV feed and the FX
/// feed.
fn cross_fund_at_the_band_limit() -> (
    Fixture,
    u64,
    MockOracleClient<'static>,
    MockOracleClient<'static>,
) {
    let f = bare();
    let nav_oracle = f
        .env
        .register(MockOracle, (Asset::Other(usd(&f.env)), NAV_DECIMALS));
    let nav_feed = MockOracleClient::new(leak(f.env.clone()), leak(nav_oracle.clone()));
    let fx_oracle = f
        .env
        .register(MockOracle, (Asset::Other(usd(&f.env)), NAV_DECIMALS));
    let fx_feed = MockOracleClient::new(leak(f.env.clone()), leak(fx_oracle.clone()));
    publish_cross(&f, &nav_feed, &fx_feed, EUR_USD);
    let mut config = fund_config(&f);
    config.oracle = nav_oracle;
    config.haircut_bps = 100;
    config.source = PriceSource::Cross(FxLeg {
        oracle: fx_oracle,
        asset: Asset::Other(eur(&f.env)),
        haircut_bps: 150,
        max_age_secs: 3 * DAY,
        band_bps: 150,
    });
    f.client.set_stablecoin(&f.eurc, &eur(&f.env));
    f.client.set_currency_cap(&eur(&f.env), &(10_000_000 * ONE));
    f.client.set_fund(&f.shares, &config);
    admit_lender(&f.client, &f.env, &f.shares, &f.lender);
    mint(&f.env, &f.eurc, &f.lender, 100_000 * ONE);
    mint(&f.env, &f.shares, &f.borrower, 10_000 * ONE);
    let offer_id = f.client.create_offer(
        &f.lender,
        &f.eurc,
        &(100_000 * ONE),
        &RATE_BPS,
        &(7 * DAY),
        &vec![&f.env, f.shares.clone()],
    );
    (f, offer_id, nav_feed, fx_feed)
}

/// Publishes the fund's USD NAV, unchanged, and an EUR/USD rate, both stamped
/// at the current ledger time.
fn publish_cross(f: &Fixture, nav_feed: &MockOracleClient, fx_feed: &MockOracleClient, rate: i128) {
    let now = f.env.ledger().timestamp();
    nav_feed.set_price(&Asset::Stellar(f.shares.clone()), &NAV_USD, &now);
    fx_feed.set_price(&Asset::Other(eur(&f.env)), &rate, &now);
}

/// Price of one share in EUR, with the NAV feed's decimals, when the NAV is
/// divided by `rate`.
fn eur_price_at(rate: i128) -> i128 {
    NAV_USD * 10i128.pow(NAV_DECIMALS) / rate
}

/// The contract's own valuation of the fund's shares, the one `quote` and
/// `open_repo` compute.
fn contract_valuation(f: &Fixture) -> crate::oracle::Valuation {
    let config = f.client.get_fund(&f.shares).unwrap();
    let state = f.client.get_fund_state(&f.shares).unwrap();
    f.env.as_contract(&f.contract_id, || {
        let fallback = crate::storage::fallback_for_pricing(&f.env, &f.shares);
        crate::oracle::value(&f.env, &config, &state, fallback.as_ref()).unwrap()
    })
}

/// Review findings arith-1 and oracle-2 (20 October 2026): two weeks after
/// the admission, EUR/USD stands 1.49 % above the reference, inside the
/// 1.5 % band, and the FX feed publishes one wrong rate at the other edge of
/// the band. Read as published (rc4), that rate valued the shares 3 % above
/// their worth against 2.5 % of haircuts: the loan exceeded the collateral.
/// Priced on the lender's side, at the reference, the loan stays below the
/// shares' true value, and `open_repo` lends what `quote` announces, not one
/// unit more.
#[test]
fn a_wrong_fx_rate_inside_the_band_lends_no_more_than_the_true_value() {
    let (f, offer_id, nav_feed, fx_feed) = cross_fund_at_the_band_limit();
    advance(&f, 14 * DAY);
    let market = EUR_USD * 10_149 / 10_000;
    let wrong = EUR_USD * 9_850 / 10_000;
    publish_cross(&f, &nav_feed, &fx_feed, wrong);
    let shares = 10_000 * ONE;
    let worth = |price: i128| shares * price / 10i128.pow(NAV_DECIMALS);
    let true_value = worth(eur_price_at(market));
    let quote = f.client.quote(&f.shares, &shares, &f.eurc);
    assert_eq!(quote.price, eur_price_at(EUR_USD));
    assert_eq!(quote.haircut_bps, 250);
    // 10,196.19 EURC against shares worth 10,304.10 EUR.
    assert_eq!(quote.max_principal, 101_961_923_489);
    assert_eq!(true_value, 103_041_020_577);
    // At the wrong rate, rc4 lent 10,351.46 EURC.
    assert_eq!(worth(eur_price_at(wrong)) * 9_750 / 10_000, 103_514_643_136);
    assert_eq!(
        f.client.try_open_repo(
            &f.borrower,
            &offer_id,
            &f.shares,
            &shares,
            &(quote.max_principal + 1),
            &DAY,
        ),
        Err(Ok(Error::LoanTooLarge))
    );
    let repo_id = f.client.open_repo(
        &f.borrower,
        &offer_id,
        &f.shares,
        &shares,
        &quote.max_principal,
        &DAY,
    );
    assert_eq!(
        f.client.get_repo(&repo_id).unwrap().principal,
        quote.max_principal
    );
    assert_eq!(balance(&f.env, &f.eurc, &f.borrower), quote.max_principal);
}

/// Decision S22 from rc5: the NAV is divided by the rate read when that rate
/// is at or above the fund's FX reference, by the reference when the rate is
/// below it. Both edges of the band are accepted, one unit beyond either is
/// refused, and `open_repo` lends what `quote` announces at either edge.
#[test]
fn fx_leg_is_priced_at_the_higher_of_the_rate_and_the_reference() {
    let (f, offer_id, nav_feed, fx_feed) = cross_fund_at_the_band_limit();
    // The band's half-width, 1.5 % of the reference: an exact number of
    // units, so the edges do not depend on rounding.
    let edge = EUR_USD * 150 / 10_000;
    assert_eq!(edge * 10_000, EUR_USD * 150);
    for (rate, applied) in [
        (EUR_USD, EUR_USD),
        (EUR_USD + 1, EUR_USD + 1),
        (EUR_USD * 10_100 / 10_000, EUR_USD * 10_100 / 10_000),
        (EUR_USD + edge, EUR_USD + edge),
        (EUR_USD - 1, EUR_USD),
        (EUR_USD * 9_900 / 10_000, EUR_USD),
        (EUR_USD - edge, EUR_USD),
    ] {
        publish_cross(&f, &nav_feed, &fx_feed, rate);
        let fx = contract_valuation(&f).fx.unwrap();
        assert_eq!(fx.rate.price.mantissa(), rate);
        assert_eq!(fx.rate.timestamp, f.env.ledger().timestamp());
        assert_eq!(fx.applied.mantissa(), applied, "rate {rate}");
        assert_eq!(fx.applied.decimals(), NAV_DECIMALS);
        assert_eq!(
            f.client.quote(&f.shares, &ONE, &f.eurc).price,
            eur_price_at(applied),
            "rate {rate}"
        );
    }
    for rate in [EUR_USD + edge + 1, EUR_USD - edge - 1] {
        publish_cross(&f, &nav_feed, &fx_feed, rate);
        assert_eq!(
            f.client.try_quote(&f.shares, &ONE, &f.eurc),
            Err(Ok(Error::PriceOutOfBand))
        );
    }
    let shares = 1_000 * ONE;
    for rate in [EUR_USD + edge, EUR_USD - edge] {
        publish_cross(&f, &nav_feed, &fx_feed, rate);
        let ceiling = f.client.quote(&f.shares, &shares, &f.eurc).max_principal;
        assert_eq!(
            ceiling,
            shares * eur_price_at(rate.max(EUR_USD)) / 10i128.pow(NAV_DECIMALS) * 9_750 / 10_000
        );
        assert_eq!(
            f.client.try_open_repo(
                &f.borrower,
                &offer_id,
                &f.shares,
                &shares,
                &(ceiling + 1),
                &DAY,
            ),
            Err(Ok(Error::LoanTooLarge))
        );
        f.client
            .open_repo(&f.borrower, &offer_id, &f.shares, &shares, &ceiling, &DAY);
    }
}

#[test]
fn corridor_refuses_a_drop_below_the_floor() {
    let (f, _) = ready();
    // Floor is 10 bps: a 0.2 % drop is a faulty price, not a market move.
    publish_nav(&f, NAV_EUR * 998 / 1_000);
    assert_eq!(
        f.client.try_quote(&f.shares, &ONE, &f.eurc),
        Err(Ok(Error::PriceOutOfBand))
    );
}

#[test]
fn corridor_refuses_a_jump_faster_than_the_maximum_yield() {
    let (f, _) = ready();
    advance(&f, DAY);
    // +1 % in a day while the corridor allows 5 % a year plus 0.1 %.
    publish_nav(&f, NAV_EUR * 101 / 100);
    assert_eq!(
        f.client.try_quote(&f.shares, &ONE, &f.eurc),
        Err(Ok(Error::PriceOutOfBand))
    );
}

#[test]
fn corridor_follows_a_normal_accrual() {
    let (f, _) = ready();
    advance(&f, DAY);
    // 2.2 % a year is 0.006 % a day.
    publish_nav(&f, NAV_EUR + NAV_EUR * 6 / 100_000);
    assert!(f.client.try_quote(&f.shares, &ONE, &f.eurc).is_ok());
}

#[test]
fn stale_nav_blocks_the_quote() {
    let (f, _) = ready();
    advance(&f, 26 * HOUR + 1);
    assert_eq!(
        f.client.try_quote(&f.shares, &ONE, &f.eurc),
        Err(Ok(Error::StalePrice))
    );
}

#[test]
fn future_timestamp_is_an_invalid_price() {
    let (f, _) = ready();
    f.oracle
        .set_price(&Asset::Stellar(f.shares.clone()), &NAV_EUR, &(T0 + 10));
    assert_eq!(
        f.client.try_quote(&f.shares, &ONE, &f.eurc),
        Err(Ok(Error::InvalidPrice))
    );
}

#[test]
fn anyone_refreshes_the_reference_along_the_corridor() {
    let (f, _) = ready();
    advance(&f, DAY);
    let nav = NAV_EUR + NAV_EUR * 6 / 100_000;
    publish_nav(&f, nav);
    f.env.set_auths(&[]);
    let reference = f.client.refresh_reference(&f.shares);
    assert_eq!(reference.price, nav);
    assert_eq!(
        f.client.get_fund_state(&f.shares).unwrap().reference_nav,
        nav
    );
}

/// Review finding H1: a feed publishing +floor at every ledger must not walk
/// the reference away. It may only follow the model path.
#[test]
fn reference_cannot_be_ratcheted_by_a_faulty_feed() {
    let (f, _) = ready();
    let mut nav = NAV_EUR;
    for _ in 0..700 {
        advance(&f, 5);
        nav = nav * 10_010 / 10_000;
        publish_nav(&f, nav);
        let _ = f.client.try_refresh_reference(&f.shares);
    }
    let state = f.client.get_fund_state(&f.shares).unwrap();
    let path = math::model_path(NAV_EUR, T0, T0 + 3_500, 500, 26 * HOUR).unwrap();
    assert!(
        state.reference_nav <= path,
        "{} > {}",
        state.reference_nav,
        path
    );
    assert_eq!(
        f.client.try_quote(&f.shares, &ONE, &f.eurc),
        Err(Ok(Error::PriceOutOfBand))
    );
}

#[test]
fn refresh_cannot_follow_a_faulty_price() {
    let (f, _) = ready();
    publish_nav(&f, NAV_EUR / 2);
    assert_eq!(
        f.client.try_refresh_reference(&f.shares),
        Err(Ok(Error::PriceOutOfBand))
    );
}

#[test]
fn steward_cannot_raise_the_reference() {
    let (f, _) = ready();
    advance(&f, HOUR);
    publish_nav(&f, NAV_EUR + NAV_EUR / 1_000);
    assert_eq!(f.client.reset_reference(&f.shares).price, NAV_EUR);
}

#[test]
fn steward_re_anchors_after_a_legitimate_drop() {
    let (f, _) = ready();
    let nav = NAV_EUR * 99 / 100;
    publish_nav(&f, nav);
    assert_eq!(f.client.reset_reference(&f.shares).price, nav);
    assert_eq!(f.env.auths()[0].0, f.steward);
    assert!(f.client.try_quote(&f.shares, &ONE, &f.eurc).is_ok());
}

/// The loosest NAV settings the default envelope allows (corridor floor
/// 0.5 %, 10 % a year of growth, NAV age 3 days), with the smallest haircut
/// that covers that corridor from rc5 on: 2 x 50 + ceil(1,000 x 3 / 365) =
/// 109 bps, where the envelope alone asks for 100.
fn loosest_config(f: &Fixture) -> FundConfig {
    FundConfig {
        haircut_bps: 109,
        corridor_floor_bps: 50,
        max_yield_bps: 1_000,
        nav_max_age_secs: 3 * DAY,
        ..fund_config(f)
    }
}

/// Top of the corridor of `config` around `reference`, its growth counted
/// over at most `window`.
fn corridor_top(config: &FundConfig, reference: i128, from: u64, to: u64, window: u64) -> i128 {
    math::corridor(
        reference,
        from,
        to,
        config.corridor_floor_bps,
        config.max_yield_bps,
        window,
    )
    .unwrap()
    .1
}

/// Review findings arith-2, oracle-1 and econ-1 (20 October 2026), first
/// path: for 30 days nobody opens a repo or refreshes the reference while
/// the operator republishes a constant NAV. One wrong publication at the
/// rc4 top of the corridor, which grew with the age of the reference, lent
/// 10,522.84 EURC against shares worth 10,500 EUR. The growth now counts
/// over at most the NAV age bound: that publication is refused, the top is
/// that of a three-day-old reference, and the loan it allows stays below
/// the value.
#[test]
fn a_quiet_month_grants_no_more_growth_than_one_nav_age() {
    let f = bare();
    let config = loosest_config(&f);
    let (f, offer_id) = ready_with(f, config.clone());
    for _ in 0..30 {
        advance(&f, DAY);
        publish_nav(&f, NAV_EUR);
    }
    let now = f.env.ledger().timestamp();
    let shares = 10_000 * ONE;
    let lent_at = |nav: i128| shares * nav / 10i128.pow(NAV_DECIMALS) * 9_891 / 10_000;
    let true_value = shares * NAV_EUR / 10i128.pow(NAV_DECIMALS);
    let rc4_top = corridor_top(&config, NAV_EUR, T0, now, u64::MAX);
    assert_eq!(
        (lent_at(rc4_top), true_value),
        (105_228_384_348, 105_000_000_000)
    );
    publish_nav(&f, rc4_top);
    assert_eq!(
        f.client.try_quote(&f.shares, &shares, &f.eurc),
        Err(Ok(Error::PriceOutOfBand))
    );
    assert_eq!(
        f.client
            .try_open_repo(&f.borrower, &offer_id, &f.shares, &shares, &ONE, &DAY),
        Err(Ok(Error::PriceOutOfBand))
    );
    let top = corridor_top(&config, NAV_EUR, T0, now, config.nav_max_age_secs);
    assert_eq!(
        top,
        corridor_top(&config, NAV_EUR, T0, T0 + 3 * DAY, u64::MAX)
    );
    publish_nav(&f, top + 1);
    assert_eq!(
        f.client.try_quote(&f.shares, &shares, &f.eurc),
        Err(Ok(Error::PriceOutOfBand))
    );
    publish_nav(&f, top);
    let quote = f.client.quote(&f.shares, &shares, &f.eurc);
    assert_eq!(quote.max_principal, lent_at(top));
    assert!(quote.max_principal < true_value);
    // The honest NAV passes.
    publish_nav(&f, NAV_EUR);
    f.client
        .open_repo(&f.borrower, &offer_id, &f.shares, &shares, &ONE, &DAY);
}

/// Review finding arith-2, second path: the honest NAV sits at the bottom of
/// the corridor, half a percent under the reference, and a wrong
/// publication three days later, within the NAV age bound, sits at its top.
/// That span, two floors plus three days of growth, exceeded the 100 bps
/// haircut the envelope allowed (by 8.02 EURC on 10,000 shares); the
/// 109 bps the cross-invariant demands cover it.
#[test]
fn the_haircut_covers_the_corridor_from_its_bottom_to_its_top() {
    let f = bare();
    let config = loosest_config(&f);
    let (f, offer_id) = ready_with(f, config.clone());
    let shares = 10_000 * ONE;
    let bottom = NAV_EUR * 9_950 / 10_000;
    advance(&f, HOUR);
    publish_nav(&f, bottom);
    assert!(f.client.try_quote(&f.shares, &shares, &f.eurc).is_ok());
    f.client.refresh_reference(&f.shares);
    // The reference never falls; its time moves.
    let state = f.client.get_fund_state(&f.shares).unwrap();
    assert_eq!(
        (state.reference_nav, state.reference_time),
        (NAV_EUR, T0 + HOUR)
    );
    advance(&f, 3 * DAY);
    let now = f.env.ledger().timestamp();
    let top = corridor_top(&config, NAV_EUR, T0 + HOUR, now, config.nav_max_age_secs);
    publish_nav(&f, top);
    let quote = f.client.quote(&f.shares, &shares, &f.eurc);
    let true_value = shares * bottom / 10i128.pow(NAV_DECIMALS);
    assert_eq!(
        (quote.max_principal, true_value),
        (104_460_138_184, 104_475_000_000)
    );
    // With the 100 bps the envelope alone asks for: 10,455.52 EURC.
    assert_eq!(
        shares * top / 10i128.pow(NAV_DECIMALS) * 9_900 / 10_000,
        104_555_188_355
    );
    f.client.open_repo(
        &f.borrower,
        &offer_id,
        &f.shares,
        &shares,
        &quote.max_principal,
        &DAY,
    );
}

/// A stale reference fails closed (review findings arith-2 and oracle-1).
/// The fund's NAV truly grows 3 % a year. Ten days without anyone moving the
/// reference leave the NAV inside the corridor, the floor absorbing the gap;
/// each refresh then steps the reference forward by at most one NAV age of
/// growth, and thirteen daily publications later it has caught up. Thirty
/// more quiet days and the NAV has outgrown the floor plus one NAV age of
/// growth: quotes, openings and `refresh_reference` are refused until the
/// governor and the steward re-anchor the fund.
#[test]
fn a_stale_reference_fails_closed_and_refreshes_step_it_forward() {
    let (f, offer_id) = ready();
    let config = fund_config(&f);
    let nav_at = |t: u64| NAV_EUR + NAV_EUR * 300 * i128::from(t - T0) / (10_000 * 31_536_000);
    let publish = |f: &Fixture| publish_nav(f, nav_at(f.env.ledger().timestamp()));
    let reference = |f: &Fixture| {
        let state = f.client.get_fund_state(&f.shares).unwrap();
        (state.reference_nav, state.reference_time)
    };

    advance(&f, 10 * DAY);
    publish(&f);
    assert!(f.client.try_quote(&f.shares, &ONE, &f.eurc).is_ok());
    f.client.refresh_reference(&f.shares);
    let now = f.env.ledger().timestamp();
    let path =
        |window: u64| math::model_path(NAV_EUR, T0, now, config.max_yield_bps, window).unwrap();
    assert_eq!(reference(&f), (path(config.nav_max_age_secs), now));
    assert!(path(config.nav_max_age_secs) < path(u64::MAX));
    let mut steps = 0;
    while reference(&f).0 < nav_at(f.env.ledger().timestamp()) {
        assert!(steps < 30, "the reference does not catch up");
        advance(&f, DAY);
        publish(&f);
        f.client.refresh_reference(&f.shares);
        steps += 1;
    }
    assert_eq!(steps, 13);

    // 24.6 bps of growth against a corridor of 11.5 bps.
    advance(&f, 30 * DAY);
    publish(&f);
    assert_eq!(
        f.client.try_quote(&f.shares, &ONE, &f.eurc),
        Err(Ok(Error::PriceOutOfBand))
    );
    assert_eq!(
        f.client
            .try_open_repo(&f.borrower, &offer_id, &f.shares, &ONE, &ONE, &DAY),
        Err(Ok(Error::PriceOutOfBand))
    );
    assert_eq!(
        f.client.try_refresh_reference(&f.shares),
        Err(Ok(Error::PriceOutOfBand))
    );
    let nav = nav_at(f.env.ledger().timestamp());
    f.client.propose_reanchor(&f.shares, &nav, &0);
    advance(&f, DEFAULT_TIMELOCK_SECS);
    publish(&f);
    f.client.apply_reanchor(&f.shares);
    f.client
        .open_repo(&f.borrower, &offer_id, &f.shares, &ONE, &ONE, &DAY);
}

/// The envelope's cross-invariant (review findings arith-2, oracle-1 and
/// econ-1): a fund's haircut covers its NAV corridor, two floors plus the
/// growth over its NAV age bound, rounded up. Each bound of the envelope may
/// hold while their sum does not. Checked at admission, at a replacement and
/// when the steward tunes the haircut. The fixtures' 200 / 10 / 500 / 26 h
/// need 22 bps.
#[test]
fn the_haircut_must_cover_the_corridor() {
    let f = bare();
    assert_eq!(corridor_haircut_bps(&fund_config(&f)), Ok(22));
    assert_eq!(corridor_haircut_bps(&loosest_config(&f)), Ok(109));
    // The growth rounds up: 5 % a year over 126,144 seconds is exactly
    // 2 bps, one second more needs 3.
    let mut config = fund_config(&f);
    config.nav_max_age_secs = 126_144;
    assert_eq!(corridor_haircut_bps(&config), Ok(22));
    config.nav_max_age_secs = 126_145;
    assert_eq!(corridor_haircut_bps(&config), Ok(23));

    // Admission, on fresh fixtures whose envelope accepts any haircut.
    let admit = |haircut_bps: u32, nav_max_age_secs: u64, loosest: bool| {
        let f = bare();
        let mut envelope = default_envelope();
        envelope.min_haircut_bps = 0;
        f.client.set_envelope(&envelope);
        let base = if loosest {
            loosest_config(&f)
        } else {
            fund_config(&f)
        };
        let config = FundConfig {
            haircut_bps,
            nav_max_age_secs,
            ..base
        };
        f.client.try_set_fund(&f.shares, &config)
    };
    assert_eq!(admit(21, 26 * HOUR, false), Err(Ok(Error::OutsideEnvelope)));
    assert_eq!(admit(22, 26 * HOUR, false), Ok(Ok(())));
    assert_eq!(admit(22, 126_144, false), Ok(Ok(())));
    assert_eq!(admit(22, 126_145, false), Err(Ok(Error::OutsideEnvelope)));
    assert_eq!(admit(108, 3 * DAY, true), Err(Ok(Error::OutsideEnvelope)));
    assert_eq!(admit(109, 3 * DAY, true), Ok(Ok(())));

    // The steward tunes the haircut of an admitted fund.
    let f = bare();
    let config = loosest_config(&f);
    let (f, _) = ready_with(f, config.clone());
    let limits = |haircut_bps: u32| {
        f.client.try_set_fund_limits(
            &f.shares,
            &haircut_bps,
            &config.max_principal_per_repo,
            &config.max_outstanding,
        )
    };
    assert_eq!(limits(108), Err(Ok(Error::OutsideEnvelope)));
    assert_eq!(limits(150), Ok(Ok(())));
    assert_eq!(f.client.get_fund(&f.shares).unwrap().haircut_bps, 150);
    // Back to 109: a loosening, which waits, and is allowed.
    assert_eq!(limits(109), Ok(Ok(())));
    assert_eq!(
        f.client
            .pending_fund_limits_change(&f.shares)
            .map(|p| p.haircut_bps),
        Some(109)
    );

    // A replacement covers its own corridor.
    let uncovered = FundConfig {
        haircut_bps: 108,
        ..config.clone()
    };
    assert_eq!(
        f.client.try_set_fund(&f.shares, &uncovered),
        Err(Ok(Error::OutsideEnvelope))
    );
    // A shorter NAV age needs less: 100 + ceil(1,000 x 1 / 365) = 103.
    let covered = FundConfig {
        haircut_bps: 103,
        nav_max_age_secs: DAY,
        ..config
    };
    f.client.set_fund(&f.shares, &covered);
    assert_eq!(
        f.client.pending_fund_change(&f.shares).map(|p| p.config),
        Some(covered)
    );
}

// ---------------------------------------------------------------------------
// Fallback NAV feed
// ---------------------------------------------------------------------------

/// The fallback feed publishes with fewer decimals than the primary one, so
/// every comparison goes through the rescaling.
const FALLBACK_DECIMALS: u32 = 8;
/// 1.05 EUR per share, with 8 decimals.
const NAV_EUR_8: i128 = 105_000_000;

/// A second SEP-40 feed in the primary feed's base, publishing the same NAV
/// now.
fn second_feed(f: &Fixture, base: Symbol) -> (Address, MockOracleClient<'static>) {
    let id = f
        .env
        .register(MockOracle, (Asset::Other(base), FALLBACK_DECIMALS));
    let feed = MockOracleClient::new(leak(f.env.clone()), leak(id.clone()));
    publish_on(f, &feed, NAV_EUR_8);
    (id, feed)
}

/// Publishes a NAV on `feed`, stamped at the current ledger time.
fn publish_on(f: &Fixture, feed: &MockOracleClient, nav: i128) {
    let now = f.env.ledger().timestamp();
    feed.set_price(&Asset::Stellar(f.shares.clone()), &nav, &now);
}

fn fallback_feed(f: &Fixture, oracle: &Address) -> FallbackFeed {
    FallbackFeed {
        oracle: oracle.clone(),
        asset: Asset::Stellar(f.shares.clone()),
        max_age_secs: 26 * HOUR,
        max_divergence_bps: 20,
    }
}

/// `ready()` plus an active fallback feed. The delay has elapsed, and both
/// feeds have just published the admission NAV.
fn ready_with_fallback() -> (Fixture, u64, MockOracleClient<'static>) {
    let (f, offer_id) = ready();
    let (oracle, feed) = second_feed(&f, eur(&f.env));
    f.client
        .propose_fallback(&f.shares, &fallback_feed(&f, &oracle));
    advance(&f, DEFAULT_TIMELOCK_SECS);
    publish_nav(&f, NAV_EUR);
    publish_on(&f, &feed, NAV_EUR_8);
    f.client.apply_fallback(&f.shares);
    (f, offer_id, feed)
}

#[test]
fn fallback_needs_two_keys_and_the_delay() {
    let (f, _) = ready();
    let (oracle, feed) = second_feed(&f, eur(&f.env));
    let proposal = fallback_feed(&f, &oracle);
    // The governor alone cannot add a price source.
    f.env.mock_auths(&[MockAuth {
        address: &f.governor,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "propose_fallback",
            args: (f.shares.clone(), proposal.clone()).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_propose_fallback(&f.shares, &proposal).is_err());
    f.env.mock_all_auths();

    f.client.propose_fallback(&f.shares, &proposal);
    assert_eq!(f.env.auths()[0].0, f.governor);
    assert_eq!(f.env.auths()[1].0, f.steward);
    let eta = T0 + DEFAULT_TIMELOCK_SECS;
    assert_eq!(
        own_events(&f),
        std::vec![FallbackProposed {
            fund: f.shares.clone(),
            oracle: oracle.clone(),
            eta
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(
        f.client.pending_fallback(&f.shares),
        Some(PendingFallback {
            feed: proposal.clone(),
            eta
        })
    );
    assert_eq!(f.client.get_fallback(&f.shares), None);
    assert_eq!(
        f.client.try_apply_fallback(&f.shares),
        Err(Ok(Error::TimelockPending))
    );
    advance(&f, DEFAULT_TIMELOCK_SECS);
    publish_nav(&f, NAV_EUR);
    publish_on(&f, &feed, NAV_EUR_8);
    f.env.set_auths(&[]);
    f.client.apply_fallback(&f.shares);
    assert_eq!(
        own_events(&f),
        std::vec![FallbackSet {
            fund: f.shares.clone(),
            oracle
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.get_fallback(&f.shares), Some(proposal));
    assert_eq!(f.client.pending_fallback(&f.shares), None);
    assert_eq!(
        f.client.try_apply_fallback(&f.shares),
        Err(Ok(Error::NotProposed))
    );
}

#[test]
fn fallback_proposal_checks() {
    let (f, _) = ready();
    let (oracle, feed) = second_feed(&f, eur(&f.env));
    let base = fallback_feed(&f, &oracle);
    let with = |change: fn(&mut FallbackFeed)| {
        let mut feed = base.clone();
        change(&mut feed);
        f.client.try_propose_fallback(&f.shares, &feed)
    };
    let outside = Err(Ok(Error::OutsideEnvelope));
    assert_eq!(with(|feed| feed.max_age_secs = 0), outside);
    assert_eq!(with(|feed| feed.max_age_secs = 3 * DAY + 1), outside);
    // Review finding L4: never older than the fund allows its primary feed
    // (26 hours here), even inside the envelope's 3 days.
    assert_eq!(with(|feed| feed.max_age_secs = 26 * HOUR + 1), outside);
    assert_eq!(with(|feed| feed.max_divergence_bps = 0), outside);
    assert_eq!(with(|feed| feed.max_divergence_bps = 51), outside);
    let unknown = new_token(&f.env);
    assert_eq!(
        f.client.try_propose_fallback(&unknown, &base),
        Err(Ok(Error::FundNotAccepted))
    );
    // A feed in another base cannot be compared with the NAV oracle.
    let (usd_oracle, _) = second_feed(&f, usd(&f.env));
    assert_eq!(
        f.client
            .try_propose_fallback(&f.shares, &fallback_feed(&f, &usd_oracle)),
        Err(Ok(Error::CurrencyMismatch))
    );
    // The feed must track the shares now.
    let mut other_asset = base.clone();
    other_asset.asset = Asset::Stellar(unknown);
    assert_eq!(
        f.client.try_propose_fallback(&f.shares, &other_asset),
        Err(Ok(Error::NoPrice))
    );
    // 0.3 % away from the primary NAV, for a tolerance of 0.2 %.
    publish_on(&f, &feed, NAV_EUR_8 * 1_003 / 1_000);
    assert_eq!(
        f.client.try_propose_fallback(&f.shares, &base),
        Err(Ok(Error::PriceDivergence))
    );
    assert_eq!(f.client.pending_fallback(&f.shares), None);
}

#[test]
fn fallback_is_checked_again_when_applied() {
    let (f, _) = ready();
    let (oracle, feed) = second_feed(&f, eur(&f.env));
    f.client
        .propose_fallback(&f.shares, &fallback_feed(&f, &oracle));
    advance(&f, DEFAULT_TIMELOCK_SECS);
    publish_nav(&f, NAV_EUR);
    // The fallback stopped publishing during the delay.
    assert_eq!(
        f.client.try_apply_fallback(&f.shares),
        Err(Ok(Error::StalePrice))
    );
    publish_on(&f, &feed, NAV_EUR_8 * 1_003 / 1_000);
    assert_eq!(
        f.client.try_apply_fallback(&f.shares),
        Err(Ok(Error::PriceDivergence))
    );
    assert!(f.client.pending_fallback(&f.shares).is_some());
    publish_on(&f, &feed, NAV_EUR_8);
    f.client.apply_fallback(&f.shares);
}

/// Review finding oracle-5 (20 October 2026): the primary feed was accepted
/// as its own fallback, a backup that agrees by construction and goes silent
/// with the primary. It is refused at the proposal, and at the apply of a
/// proposal made before rc5.
#[test]
fn the_primary_feed_cannot_be_its_own_fallback() {
    let (f, _) = ready();
    let itself = fallback_feed(&f, &f.nav_oracle);
    assert_eq!(
        f.client.try_propose_fallback(&f.shares, &itself),
        Err(Ok(Error::OutsideEnvelope))
    );
    assert_eq!(f.client.pending_fallback(&f.shares), None);

    let eta = f.env.ledger().timestamp() + f.client.timelock_delay();
    f.env.as_contract(&f.contract_id, || {
        crate::storage::set_pending_fallback(
            &f.env,
            &f.shares,
            &PendingFallback {
                feed: itself.clone(),
                eta,
            },
        );
    });
    advance(&f, DEFAULT_TIMELOCK_SECS);
    publish_nav(&f, NAV_EUR);
    assert_eq!(
        f.client.try_apply_fallback(&f.shares),
        Err(Ok(Error::OutsideEnvelope))
    );
    assert_eq!(f.client.get_fallback(&f.shares), None);
}

/// Review finding oracle-5 (20 October 2026): a fallback that agreed with
/// the primary when proposed was applied, by anyone, at a moment the
/// primary was stale, and compared with nothing: 0.3 % away for a 0.2 %
/// tolerance, it then priced the fund alone. A fallback is proposed and
/// applied only against a fresh primary it agrees with.
#[test]
fn a_fallback_is_installed_only_against_a_fresh_primary() {
    let (f, _) = ready();
    let (oracle, feed) = second_feed(&f, eur(&f.env));
    advance(&f, 26 * HOUR + 1);
    publish_on(&f, &feed, NAV_EUR_8);
    assert_eq!(
        f.client
            .try_propose_fallback(&f.shares, &fallback_feed(&f, &oracle)),
        Err(Ok(Error::StalePrice))
    );
    publish_nav(&f, NAV_EUR);
    f.client
        .propose_fallback(&f.shares, &fallback_feed(&f, &oracle));

    // The primary went stale during the delay, and the fallback drifted
    // beyond its tolerance.
    advance(&f, DEFAULT_TIMELOCK_SECS);
    publish_on(&f, &feed, NAV_EUR_8 * 1_003 / 1_000);
    assert_eq!(
        f.client.try_apply_fallback(&f.shares),
        Err(Ok(Error::StalePrice))
    );
    assert_eq!(f.client.get_fallback(&f.shares), None);
    publish_nav(&f, NAV_EUR);
    assert_eq!(
        f.client.try_apply_fallback(&f.shares),
        Err(Ok(Error::PriceDivergence))
    );
    publish_on(&f, &feed, NAV_EUR_8);
    f.client.apply_fallback(&f.shares);
    assert!(f.client.get_fallback(&f.shares).is_some());
}

#[test]
fn stale_primary_falls_back_to_a_fresh_fallback() {
    let (f, offer_id, feed) = ready_with_fallback();
    advance(&f, 26 * HOUR + 1);
    publish_on(&f, &feed, NAV_EUR_8);
    let quote = f.client.quote(&f.shares, &(10_000 * ONE), &f.eurc);
    // Rescaled to the primary feed's 14 decimals.
    assert_eq!(quote.price, NAV_EUR);
    assert_eq!(quote.price_decimals, NAV_DECIMALS);
    assert_eq!(quote.nav_timestamp, f.env.ledger().timestamp());
    assert_eq!(quote.max_principal, 10_290 * ONE);
    open(&f, offer_id);
    // The reference moves with the fallback reading, along the model only.
    assert_eq!(
        f.client.refresh_reference(&f.shares).timestamp,
        f.env.ledger().timestamp()
    );
}

#[test]
fn diverging_feeds_block_the_valuation() {
    let (f, offer_id, feed) = ready_with_fallback();
    advance(&f, HOUR);
    publish_nav(&f, NAV_EUR);
    publish_on(&f, &feed, NAV_EUR_8 * 1_003 / 1_000);
    assert_eq!(
        f.client.try_quote(&f.shares, &ONE, &f.eurc),
        Err(Ok(Error::PriceDivergence))
    );
    assert_eq!(
        f.client.try_open_repo(
            &f.borrower,
            &offer_id,
            &f.shares,
            &(10_000 * ONE),
            &ONE,
            &DAY
        ),
        Err(Ok(Error::PriceDivergence))
    );
    assert_eq!(
        f.client.try_refresh_reference(&f.shares),
        Err(Ok(Error::PriceDivergence))
    );
    // Within the tolerance, the primary NAV is used.
    publish_on(&f, &feed, NAV_EUR_8 * 1_001 / 1_000);
    assert_eq!(f.client.quote(&f.shares, &ONE, &f.eurc).price, NAV_EUR);
}

#[test]
fn stale_fallback_is_ignored_while_the_primary_is_fresh() {
    let (f, _, feed) = ready_with_fallback();
    // An old, diverging fallback price: too old to count.
    publish_on(&f, &feed, NAV_EUR_8 * 2);
    advance(&f, 26 * HOUR + 1);
    publish_nav(&f, NAV_EUR);
    assert_eq!(f.client.quote(&f.shares, &ONE, &f.eurc).price, NAV_EUR);
}

#[test]
fn both_feeds_stale_is_a_stale_price() {
    let (f, _, _) = ready_with_fallback();
    advance(&f, 26 * HOUR + 1);
    assert_eq!(
        f.client.try_quote(&f.shares, &ONE, &f.eurc),
        Err(Ok(Error::StalePrice))
    );
}

#[test]
fn fallback_price_goes_through_the_corridor() {
    let (f, _, feed) = ready_with_fallback();
    advance(&f, 26 * HOUR + 1);
    publish_on(&f, &feed, NAV_EUR_8 * 102 / 100);
    assert_eq!(
        f.client.try_quote(&f.shares, &ONE, &f.eurc),
        Err(Ok(Error::PriceOutOfBand))
    );
}

#[test]
fn guardian_cancels_a_fallback_and_the_steward_removes_one_at_once() {
    let (f, _, _) = ready_with_fallback();
    let guardian = appoint_guardian(&f);
    let (oracle, _) = second_feed(&f, eur(&f.env));
    f.client
        .propose_fallback(&f.shares, &fallback_feed(&f, &oracle));
    let intruder = Address::generate(&f.env);
    assert_eq!(
        f.client.try_cancel_fallback(&f.shares, &intruder),
        Err(Ok(Error::Unauthorized))
    );
    f.client.cancel_fallback(&f.shares, &guardian);
    assert_eq!(f.env.auths()[0].0, guardian);
    assert_eq!(
        own_events(&f),
        std::vec![FallbackCancelled {
            fund: f.shares.clone(),
            by: guardian.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.pending_fallback(&f.shares), None);
    assert_eq!(
        f.client.try_cancel_fallback(&f.shares, &guardian),
        Err(Ok(Error::NotProposed))
    );

    // Removal is immediate, and the guardian may do it alone.
    f.client.remove_fallback(&f.shares, &guardian);
    assert_eq!(f.env.auths().len(), 1);
    assert_eq!(f.env.auths()[0].0, guardian);
    assert_eq!(
        own_events(&f),
        std::vec![FallbackRemoved {
            fund: f.shares.clone(),
            by: guardian.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.get_fallback(&f.shares), None);
    assert_eq!(
        f.client.try_remove_fallback(&f.shares, &guardian),
        Err(Ok(Error::NoFallback))
    );
    // Without the fallback, a stale primary stops valuation again.
    advance(&f, 26 * HOUR + 1);
    assert_eq!(
        f.client.try_quote(&f.shares, &ONE, &f.eurc),
        Err(Ok(Error::StalePrice))
    );
}

/// Review finding L2: with a fallback, a primary feed whose contract traps
/// counts as silent, and the fallback stands in.
#[test]
fn a_reverting_primary_falls_back() {
    let (f, _, _) = ready_with_fallback();
    f.oracle.set_broken(&true);
    let quote = f.client.quote(&f.shares, &ONE, &f.eurc);
    assert_eq!(quote.price, NAV_EUR);
    // Without the fallback, the same failure reverts the valuation.
    f.client.remove_fallback(&f.shares, &f.governor);
    assert!(f.client.try_quote(&f.shares, &ONE, &f.eurc).is_err());
}

/// Review finding L3: a fresh but unusable fallback price fails closed; a
/// stale or reverting fallback is ignored.
#[test]
fn a_fresh_but_invalid_fallback_fails_closed() {
    let (f, _, feed) = ready_with_fallback();
    publish_on(&f, &feed, 0);
    assert_eq!(
        f.client.try_quote(&f.shares, &ONE, &f.eurc),
        Err(Ok(Error::PriceDivergence))
    );
    let now = f.env.ledger().timestamp();
    feed.set_price(&Asset::Stellar(f.shares.clone()), &NAV_EUR_8, &(now + 60));
    assert_eq!(
        f.client.try_quote(&f.shares, &ONE, &f.eurc),
        Err(Ok(Error::PriceDivergence))
    );
    // A backup that traps is silent, not invalid: the primary is used.
    feed.set_broken(&true);
    assert_eq!(f.client.quote(&f.shares, &ONE, &f.eurc).price, NAV_EUR);
}

/// A backup feed whose call fails is ignored by a real opening too, not only
/// by a quote: the repo opens on the fresh primary. A callee that exhausts
/// the CPU budget is not caught this way (`try_` calls do not catch budget
/// exhaustion): the whole transaction fails, a documented host limitation.
#[test]
fn a_reverting_fallback_does_not_block_an_opening() {
    let (f, offer_id, feed) = ready_with_fallback();
    feed.set_broken(&true);
    let repo_id = open(&f, offer_id);
    assert_eq!(f.client.get_repo(&repo_id).unwrap().principal, 10_000 * ONE);
}

/// Review finding L6: the fallback entry is read by operations that never
/// write it; reading it to price the fund extends its TTL.
#[test]
fn pricing_extends_the_fallback_entry() {
    let (f, _, feed) = ready_with_fallback();
    f.oracle.keep_alive();
    feed.keep_alive();
    let key = DataKey::Fallback(f.shares.clone());
    age_ledgers(&f);
    assert!(entry_ttl(&f, &key) < BUMP_THRESHOLD_LEDGERS);
    publish_nav(&f, NAV_EUR);
    publish_on(&f, &feed, NAV_EUR_8);
    f.env.set_auths(&[]);
    f.client.refresh_reference(&f.shares);
    assert_eq!(entry_ttl(&f, &key), BUMP_TO_LEDGERS);
}

/// Review finding L7: the fallback decimals live in instance storage, so the
/// number of funds with a fallback is capped.
#[test]
fn fallbacks_are_capped() {
    let (f, _) = ready();
    let count = |f: &Fixture| -> u32 {
        f.env.as_contract(&f.contract_id, || {
            f.env
                .storage()
                .instance()
                .get(&DataKey::FallbackCount)
                .unwrap_or(0)
        })
    };
    f.env.as_contract(&f.contract_id, || {
        f.env
            .storage()
            .instance()
            .set(&DataKey::FallbackCount, &MAX_FALLBACKS);
    });
    let (oracle, _) = second_feed(&f, eur(&f.env));
    assert_eq!(
        f.client
            .try_propose_fallback(&f.shares, &fallback_feed(&f, &oracle)),
        Err(Ok(Error::LimitReached))
    );
    f.env.as_contract(&f.contract_id, || {
        f.env
            .storage()
            .instance()
            .set(&DataKey::FallbackCount, &0u32);
    });
    let (f, _, _) = ready_with_fallback();
    assert_eq!(count(&f), 1);
    f.client.remove_fallback(&f.shares, &f.governor);
    assert_eq!(count(&f), 0);
}

/// Review finding VAL-4 (20 October 2026): the rule that a fallback is
/// never the primary feed itself (oracle-5) was checked only when a
/// fallback is proposed or applied. A replacement making the active
/// fallback's feed the primary kept the fallback: one source twice, one
/// silent feed silencing both, and a slot of `MAX_FALLBACKS` held. The
/// replacement now removes that fallback, published as `FallbackRemoved` by
/// the contract. During the delay the fallback still stands in for the
/// silent primary; afterwards the fund prices on its new primary, and the
/// old primary, still publishing, may be proposed as the new fallback.
#[test]
fn promoting_the_fallback_to_primary_removes_it() {
    let (f, _offer_id, feed) = ready_with_fallback();
    let fallback = f.client.get_fallback(&f.shares).unwrap();
    let next = FundConfig {
        oracle: fallback.oracle.clone(),
        oracle_asset: fallback.asset.clone(),
        ..fund_config(&f)
    };
    f.client.set_fund(&f.shares, &next);
    advance(&f, DEFAULT_TIMELOCK_SECS);
    publish_on(&f, &feed, NAV_EUR_8);
    // The primary last published two days ago: the fallback stands in.
    assert!(f.client.try_quote(&f.shares, &ONE, &f.eurc).is_ok());
    f.client.apply_fund_change(&f.shares);
    assert_eq!(
        own_events(&f),
        std::vec![
            FallbackRemoved {
                fund: f.shares.clone(),
                by: f.contract_id.clone()
            }
            .to_xdr(&f.env, &f.contract_id),
            FundSet {
                fund: f.shares.clone(),
                oracle: fallback.oracle.clone(),
                haircut_bps: 200
            }
            .to_xdr(&f.env, &f.contract_id)
        ]
    );
    assert_eq!(f.client.get_fund(&f.shares), Some(next));
    assert_eq!(f.client.get_fallback(&f.shares), None);
    let count = f
        .env
        .as_contract(&f.contract_id, || crate::storage::fallback_count(&f.env));
    assert_eq!(count, 0);
    assert!(f.client.try_quote(&f.shares, &ONE, &f.eurc).is_ok());
    // The promoted feed cannot come back as its own fallback; the old
    // primary can be proposed as one.
    assert_eq!(
        f.client.try_propose_fallback(&f.shares, &fallback),
        Err(Ok(Error::OutsideEnvelope))
    );
    publish_nav(&f, NAV_EUR);
    f.client
        .propose_fallback(&f.shares, &fallback_feed(&f, &f.nav_oracle));
}

/// Review finding VAL-4, second round (20 October 2026): only a replacement
/// that promotes the fallback itself, its oracle and its asset, removes it.
/// A replacement keeping the primary, one moving to a third feed, and one
/// on the fallback's oracle but another asset all keep the active fallback
/// and publish no `FallbackRemoved`; nobody but an applied two-key
/// replacement reaches the removal. A drop on the oracle alone passed every
/// earlier test.
#[test]
fn only_a_replacement_promoting_the_fallback_removes_it() {
    let removed = |f: &Fixture| {
        own_events(f).events().contains(
            &FallbackRemoved {
                fund: f.shares.clone(),
                by: f.contract_id.clone(),
            }
            .to_xdr(&f.env, &f.contract_id),
        )
    };
    // The same primary, a higher haircut.
    let (f, _, feed) = ready_with_fallback();
    let active = f.client.get_fallback(&f.shares).unwrap();
    f.client.set_fund(
        &f.shares,
        &FundConfig {
            haircut_bps: 300,
            ..fund_config(&f)
        },
    );
    advance(&f, DEFAULT_TIMELOCK_SECS);
    publish_nav(&f, NAV_EUR);
    publish_on(&f, &feed, NAV_EUR_8);
    f.client.apply_fund_change(&f.shares);
    assert!(!removed(&f));
    assert_eq!(f.client.get_fallback(&f.shares), Some(active));

    // A third feed.
    let (f, _, feed) = ready_with_fallback();
    let active = f.client.get_fallback(&f.shares).unwrap();
    let (third, third_feed) = feed_with_decimals(&f, eur(&f.env), NAV_DECIMALS);
    publish_on(&f, &third_feed, NAV_EUR);
    f.client.set_fund(
        &f.shares,
        &FundConfig {
            oracle: third.clone(),
            ..fund_config(&f)
        },
    );
    advance(&f, DEFAULT_TIMELOCK_SECS);
    publish_on(&f, &third_feed, NAV_EUR);
    publish_on(&f, &feed, NAV_EUR_8);
    f.client.apply_fund_change(&f.shares);
    assert!(!removed(&f));
    assert_eq!(f.client.get_fallback(&f.shares), Some(active));
    assert_eq!(f.client.get_fund(&f.shares).unwrap().oracle, third);

    // The fallback's oracle, another asset.
    let (f, _, feed) = ready_with_fallback();
    let active = f.client.get_fallback(&f.shares).unwrap();
    let other = Asset::Other(Symbol::new(&f.env, "SHAREB"));
    let now = f.env.ledger().timestamp();
    feed.set_price(&other, &NAV_EUR_8, &now);
    f.client.set_fund(
        &f.shares,
        &FundConfig {
            oracle: active.oracle.clone(),
            oracle_asset: other.clone(),
            ..fund_config(&f)
        },
    );
    advance(&f, DEFAULT_TIMELOCK_SECS);
    let now = f.env.ledger().timestamp();
    feed.set_price(&other, &NAV_EUR_8, &now);
    publish_on(&f, &feed, NAV_EUR_8);
    f.client.apply_fund_change(&f.shares);
    assert!(!removed(&f));
    assert_eq!(f.client.get_fallback(&f.shares), Some(active));

    // An intruder reaches neither path.
    let (f, _, _) = ready_with_fallback();
    let intruder = Address::generate(&f.env);
    f.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "set_fund",
            args: (f.shares.clone(), fund_config(&f)).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_set_fund(&f.shares, &fund_config(&f)).is_err());
    f.env.mock_all_auths();
    assert_eq!(
        f.client.try_apply_fund_change(&f.shares),
        Err(Ok(Error::NotProposed))
    );
    assert!(f.client.get_fallback(&f.shares).is_some());
}

#[test]
fn removing_a_fund_removes_its_fallback() {
    let (f, _, _) = ready_with_fallback();
    f.client.remove_fund(&f.shares);
    assert_eq!(f.client.get_fallback(&f.shares), None);
}

/// A NAV feed in another base cannot replace the primary: first the active
/// fallback is in the way, then the new NAV, in other units, does not lie
/// on the fund's path (review finding H1).
#[test]
fn fund_change_to_an_oracle_in_another_base_is_refused() {
    let (f, _, _) = ready_with_fallback();
    let (usd_oracle, usd_feed) = second_feed(&f, usd(&f.env));
    publish_on(&f, &usd_feed, NAV_USD / 1_000_000);
    let fx_oracle = f
        .env
        .register(MockOracle, (Asset::Other(usd(&f.env)), NAV_DECIMALS));
    let fx_feed = MockOracleClient::new(&f.env, &fx_oracle);
    let now = f.env.ledger().timestamp();
    fx_feed.set_price(&Asset::Other(eur(&f.env)), &EUR_USD, &now);
    let mut config = fund_config(&f);
    config.oracle = usd_oracle;
    config.source = PriceSource::Cross(FxLeg {
        oracle: fx_oracle,
        asset: Asset::Other(eur(&f.env)),
        haircut_bps: 200,
        max_age_secs: 3 * DAY,
        band_bps: 200,
    });
    assert_eq!(
        f.client.try_set_fund(&f.shares, &config),
        Err(Ok(Error::CurrencyMismatch))
    );
    f.client.remove_fallback(&f.shares, &f.governor);
    assert_eq!(
        f.client.try_set_fund(&f.shares, &config),
        Err(Ok(Error::PriceOutOfBand))
    );
    assert_eq!(f.client.pending_fund_change(&f.shares), None);
}

/// Review finding L1: a single governor or steward key cannot remove a
/// fallback; both together can, and so can the guardian alone.
#[test]
fn removing_a_fallback_takes_the_guardian_or_both_governor_and_steward() {
    let (f, _, _) = ready_with_fallback();
    // While the governor is also the guardian, its key alone is the
    // guardian's: appoint a separate one.
    appoint_guardian(&f);
    for (alone, caller) in [(&f.governor, &f.governor), (&f.steward, &f.steward)] {
        f.env.mock_auths(&[MockAuth {
            address: alone,
            invoke: &MockAuthInvoke {
                contract: &f.contract_id,
                fn_name: "remove_fallback",
                args: (f.shares.clone(), caller.clone()).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        assert!(f.client.try_remove_fallback(&f.shares, caller).is_err());
    }
    f.env.mock_all_auths();
    assert!(f.client.get_fallback(&f.shares).is_some());
    let intruder = Address::generate(&f.env);
    assert_eq!(
        f.client.try_remove_fallback(&f.shares, &intruder),
        Err(Ok(Error::Unauthorized))
    );
    f.client.remove_fallback(&f.shares, &f.governor);
    let signers: std::vec::Vec<Address> = f.env.auths().into_iter().map(|a| a.0).collect();
    assert_eq!(signers, std::vec![f.governor.clone(), f.steward.clone()]);
    assert_eq!(
        own_events(&f),
        std::vec![FallbackRemoved {
            fund: f.shares.clone(),
            by: f.governor.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.get_fallback(&f.shares), None);
}

// ---------------------------------------------------------------------------
// Steward powers
// ---------------------------------------------------------------------------

#[test]
fn intruder_cannot_approve_a_lender() {
    let (f, _) = ready();
    let intruder = Address::generate(&f.env);
    f.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "approve_lender",
            args: (f.shares.clone(), intruder.clone(), true).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f
        .client
        .try_approve_lender(&f.shares, &intruder, &true)
        .is_err());
    assert!(!f.client.is_lender_approved(&f.shares, &intruder));
}

#[test]
fn steward_tunes_limits_only_inside_the_envelope() {
    let (f, _) = ready();
    f.client
        .set_fund_limits(&f.shares, &300, &(1_000 * ONE), &(2_000 * ONE));
    assert_eq!(f.env.auths()[0].0, f.steward);
    assert_eq!(f.client.get_fund(&f.shares).unwrap().haircut_bps, 300);
    assert_eq!(
        f.client
            .try_set_fund_limits(&f.shares, &50, &(1_000 * ONE), &(2_000 * ONE)),
        Err(Ok(Error::OutsideEnvelope))
    );
}

#[test]
fn sponsor_mark_requires_the_fund_in_the_offer() {
    let (f, offer_id) = ready();
    f.client.set_sponsor(&offer_id, &f.shares, &true);
    assert!(f.client.get_offer(&offer_id).unwrap().sponsor);
    let other = new_token(&f.env);
    let mut config = fund_config(&f);
    config.oracle_asset = Asset::Stellar(other.clone());
    f.oracle
        .set_price(&Asset::Stellar(other.clone()), &NAV_EUR, &T0);
    f.client.set_fund(&other, &config);
    assert_eq!(
        f.client.try_set_sponsor(&offer_id, &other, &true),
        Err(Ok(Error::FundNotInOffer))
    );
}

// ---------------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------------

#[test]
fn offer_pulls_the_stablecoins() {
    let (f, offer_id) = ready();
    assert_eq!(balance(&f.env, &f.eurc, &f.contract_id), 100_000 * ONE);
    assert_eq!(balance(&f.env, &f.eurc, &f.lender), 900_000 * ONE);
    let offer = f.client.get_offer(&offer_id).unwrap();
    assert_eq!(offer.available, 100_000 * ONE);
    assert!(!offer.sponsor);
}

#[test]
fn offer_checks() {
    let (f, _) = ready();
    let funds = vec![&f.env, f.shares.clone()];
    let unapproved = Address::generate(&f.env);
    mint(&f.env, &f.eurc, &unapproved, ONE);
    assert_eq!(
        f.client
            .try_create_offer(&unapproved, &f.eurc, &ONE, &RATE_BPS, &DAY, &funds),
        Err(Ok(Error::LenderNotApproved))
    );
    let unknown_coin = new_token(&f.env);
    assert_eq!(
        f.client
            .try_create_offer(&f.lender, &unknown_coin, &ONE, &RATE_BPS, &DAY, &funds),
        Err(Ok(Error::StablecoinNotAccepted))
    );
    let usdc = new_token(&f.env);
    // After the first admission a stablecoin waits for the delay (rc4).
    f.client.set_stablecoin(&usdc, &usd(&f.env));
    advance(&f, f.client.timelock_delay());
    f.client.apply_stablecoin_change(&usdc);
    assert_eq!(
        f.client
            .try_create_offer(&f.lender, &usdc, &ONE, &RATE_BPS, &DAY, &funds),
        Err(Ok(Error::CurrencyMismatch))
    );
    assert_eq!(
        f.client
            .try_create_offer(&f.lender, &f.eurc, &0, &RATE_BPS, &DAY, &funds),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(
        f.client
            .try_create_offer(&f.lender, &f.eurc, &ONE, &10_001, &DAY, &funds),
        Err(Ok(Error::InvalidRate))
    );
    assert_eq!(
        f.client
            .try_create_offer(&f.lender, &f.eurc, &ONE, &RATE_BPS, &(HOUR - 1), &funds),
        Err(Ok(Error::InvalidTerm))
    );
    assert_eq!(
        f.client
            .try_create_offer(&f.lender, &f.eurc, &ONE, &RATE_BPS, &(8 * DAY), &funds),
        Err(Ok(Error::InvalidTerm))
    );
    let duplicate = vec![&f.env, f.shares.clone(), f.shares.clone()];
    assert_eq!(
        f.client
            .try_create_offer(&f.lender, &f.eurc, &ONE, &RATE_BPS, &DAY, &duplicate),
        Err(Ok(Error::TooManyFunds))
    );
    let empty = soroban_sdk::Vec::<Address>::new(&f.env);
    assert_eq!(
        f.client
            .try_create_offer(&f.lender, &f.eurc, &ONE, &RATE_BPS, &DAY, &empty),
        Err(Ok(Error::TooManyFunds))
    );
    let mut nine = soroban_sdk::Vec::<Address>::new(&f.env);
    for _ in 0..9 {
        nine.push_back(Address::generate(&f.env));
    }
    assert_eq!(
        f.client
            .try_create_offer(&f.lender, &f.eurc, &ONE, &RATE_BPS, &DAY, &nine),
        Err(Ok(Error::TooManyFunds))
    );
    f.client.pause(&f.guardian);
    assert_eq!(
        f.client
            .try_create_offer(&f.lender, &f.eurc, &ONE, &RATE_BPS, &DAY, &funds),
        Err(Ok(Error::Paused))
    );
}

#[test]
fn withdrawal_returns_unlent_stablecoins_even_when_paused() {
    let (f, offer_id) = ready();
    f.client.pause(&f.guardian);
    f.client.withdraw_offer(&offer_id, &(40_000 * ONE));
    assert_eq!(f.env.auths()[0].0, f.lender);
    assert_eq!(
        f.client.get_offer(&offer_id).unwrap().available,
        60_000 * ONE
    );
    assert_eq!(balance(&f.env, &f.eurc, &f.lender), 940_000 * ONE);
    assert_eq!(
        f.client.try_withdraw_offer(&offer_id, &(60_000 * ONE + 1)),
        Err(Ok(Error::InsufficientOffer))
    );
}

#[test]
fn intruder_cannot_withdraw_an_offer() {
    let (f, offer_id) = ready();
    let intruder = Address::generate(&f.env);
    f.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "withdraw_offer",
            args: (offer_id, ONE).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_withdraw_offer(&offer_id, &ONE).is_err());
}

// ---------------------------------------------------------------------------
// Opening a repo
// ---------------------------------------------------------------------------

#[test]
fn open_moves_shares_in_and_stablecoins_out_in_one_transaction() {
    let (f, offer_id) = ready();
    let repo_id = open(&f, offer_id);
    assert_eq!(f.env.auths()[0].0, f.borrower);
    assert_eq!(balance(&f.env, &f.shares, &f.contract_id), 10_000 * ONE);
    assert_eq!(balance(&f.env, &f.eurc, &f.borrower), 110_000 * ONE);
    let repo = f.client.get_repo(&repo_id).unwrap();
    assert_eq!(repo.status, RepoStatus::Open);
    assert_eq!(repo.lender, f.lender);
    assert_eq!(repo.rate_bps, RATE_BPS);
    assert_eq!(repo.maturity, T0 + 64 * HOUR);
    assert_eq!(
        f.client.get_offer(&offer_id).unwrap().available,
        90_000 * ONE
    );
    assert_eq!(
        f.client.get_fund_state(&f.shares).unwrap().outstanding,
        10_000 * ONE
    );
    assert_eq!(f.client.currency_outstanding(&eur(&f.env)), 10_000 * ONE);
}

/// Review finding oracle-4 (20 October 2026): every opening publishes the
/// valuation behind the loan right after `RepoOpened`, and an opening that
/// moves the NAV reference publishes `ReferenceUpdated`, as a refresh does.
/// A fund priced directly has no FX leg.
#[test]
fn opening_a_repo_publishes_its_valuation_and_any_move_of_the_reference() {
    let (f, offer_id) = ready();
    let opened = |repo_id: u64, maturity: u64| {
        RepoOpened {
            repo_id,
            borrower: f.borrower.clone(),
            offer_id,
            lender: f.lender.clone(),
            fund: f.shares.clone(),
            shares: 10_000 * ONE,
            principal: 10_000 * ONE,
            rate_bps: RATE_BPS,
            maturity,
        }
        .to_xdr(&f.env, &f.contract_id)
    };
    let valued = |repo_id: u64, nav: i128, nav_time: u64| {
        RepoValued {
            repo_id,
            fund: f.shares.clone(),
            nav,
            nav_time,
            fallback: false,
            fx: 0,
            fx_applied: 0,
            fx_time: 0,
            price: nav,
            haircut_bps: 200,
        }
        .to_xdr(&f.env, &f.contract_id)
    };

    // The NAV read is the reference's own reading: the reference stays.
    let first = open(&f, offer_id);
    assert_eq!(
        own_events(&f),
        std::vec![opened(first, T0 + 64 * HOUR), valued(first, NAV_EUR, T0)]
    );

    // An hour later the feed publishes 1.050001 EUR, below the model path:
    // the opening moves the reference to it and says so.
    advance(&f, HOUR);
    let nav = NAV_EUR + 100_000_000;
    publish_nav(&f, nav);
    let second = open(&f, offer_id);
    assert_eq!(
        own_events(&f),
        std::vec![
            opened(second, T0 + 65 * HOUR),
            valued(second, nav, T0 + HOUR),
            ReferenceUpdated {
                fund: f.shares.clone(),
                nav,
                timestamp: T0 + HOUR
            }
            .to_xdr(&f.env, &f.contract_id)
        ]
    );
    let state = f.client.get_fund_state(&f.shares).unwrap();
    assert_eq!(
        (state.reference_nav, state.reference_time),
        (nav, T0 + HOUR)
    );

    // The same reading again: the reference does not move.
    let third = open(&f, offer_id);
    assert_eq!(
        own_events(&f),
        std::vec![opened(third, T0 + 65 * HOUR), valued(third, nav, T0 + HOUR)]
    );
}

/// The same record for a fund priced across currencies: the rate read, the
/// divisor applied and the rate's time. Below the FX reference the
/// reference divides the NAV, above it the rate itself (decision S22).
#[test]
fn opening_a_cross_priced_repo_publishes_its_fx_leg() {
    let (f, offer_id, _nav_feed, fx_feed) = cross_fund_at_the_band_limit();
    let (shares, principal) = (1_000 * ONE, 1_000 * ONE);
    for (rate, applied) in [
        (EUR_USD * 9_900 / 10_000, EUR_USD),
        (EUR_USD * 10_100 / 10_000, EUR_USD * 10_100 / 10_000),
    ] {
        // Only the rate is published again: the NAV, read at the time of
        // the reference, leaves it where it is.
        fx_feed.set_price(&Asset::Other(eur(&f.env)), &rate, &T0);
        let repo_id =
            f.client
                .open_repo(&f.borrower, &offer_id, &f.shares, &shares, &principal, &DAY);
        assert_eq!(
            own_events(&f),
            std::vec![
                RepoOpened {
                    repo_id,
                    borrower: f.borrower.clone(),
                    offer_id,
                    lender: f.lender.clone(),
                    fund: f.shares.clone(),
                    shares,
                    principal,
                    rate_bps: RATE_BPS,
                    maturity: T0 + DAY,
                }
                .to_xdr(&f.env, &f.contract_id),
                RepoValued {
                    repo_id,
                    fund: f.shares.clone(),
                    nav: NAV_USD,
                    nav_time: T0,
                    fallback: false,
                    fx: rate,
                    fx_applied: applied,
                    fx_time: T0,
                    price: eur_price_at(applied),
                    haircut_bps: 250,
                }
                .to_xdr(&f.env, &f.contract_id)
            ]
        );
    }
}

/// Review finding VAL-5 (20 October 2026): `RepoValued` recorded the NAV
/// and its time, not which feed supplied them, so a loan priced by the
/// fallback while the primary was stale read exactly like one priced by the
/// primary, a value the primary never published. It now says so: false
/// while the primary is fresh, even with a fallback that agrees, true when
/// the fallback stands in.
#[test]
fn an_opening_records_whether_the_fallback_priced_it() {
    let (f, offer_id, feed) = ready_with_fallback();
    let valued = |repo_id: u64, nav: i128, nav_time: u64, fallback: bool| {
        RepoValued {
            repo_id,
            fund: f.shares.clone(),
            nav,
            nav_time,
            fallback,
            fx: 0,
            fx_applied: 0,
            fx_time: 0,
            price: nav,
            haircut_bps: 200,
        }
        .to_xdr(&f.env, &f.contract_id)
    };
    let published = f.env.ledger().timestamp();
    let first = open(&f, offer_id);
    assert!(own_events(&f)
        .events()
        .contains(&valued(first, NAV_EUR, published, false)));

    // The primary goes stale; the fallback publishes 1.0501 EUR (8 decimals).
    advance(&f, 26 * HOUR + 1);
    let now = f.env.ledger().timestamp();
    publish_on(&f, &feed, NAV_EUR_8 + 10_000);
    let second = open(&f, offer_id);
    let nav = (NAV_EUR_8 + 10_000) * 1_000_000;
    let events = own_events(&f);
    assert!(events.events().contains(&valued(second, nav, now, true)));
    assert!(!events.events().contains(&valued(second, nav, now, false)));
    let primary = f
        .oracle
        .lastprice(&Asset::Stellar(f.shares.clone()))
        .unwrap();
    assert_eq!((primary.price, primary.timestamp), (NAV_EUR, published));
}

#[test]
fn open_lends_exactly_the_ceiling_and_not_one_unit_more() {
    let (f, offer_id) = ready();
    let shares = 10_000 * ONE;
    let ceiling = f.client.quote(&f.shares, &shares, &f.eurc).max_principal;
    assert_eq!(
        f.client.try_open_repo(
            &f.borrower,
            &offer_id,
            &f.shares,
            &shares,
            &(ceiling + 1),
            &DAY
        ),
        Err(Ok(Error::LoanTooLarge))
    );
    assert!(f
        .client
        .try_open_repo(&f.borrower, &offer_id, &f.shares, &shares, &ceiling, &DAY)
        .is_ok());
}

#[test]
fn open_checks_terms_offer_and_fund() {
    let (f, offer_id) = ready();
    let shares = 10_000 * ONE;
    let principal = 1_000 * ONE;
    let try_open = |term: u64| {
        f.client.try_open_repo(
            &f.borrower,
            &offer_id,
            &f.shares,
            &shares,
            &principal,
            &term,
        )
    };
    assert_eq!(try_open(HOUR - 1), Err(Ok(Error::InvalidTerm)));
    assert_eq!(try_open(7 * DAY + 1), Err(Ok(Error::InvalidTerm)));
    assert_eq!(
        f.client.try_open_repo(
            &f.borrower,
            &offer_id,
            &f.shares,
            &(1_000_000 * ONE),
            &(100_000 * ONE + 1),
            &DAY
        ),
        Err(Ok(Error::InsufficientOffer))
    );
    let other = new_token(&f.env);
    assert_eq!(
        f.client
            .try_open_repo(&f.borrower, &offer_id, &other, &shares, &principal, &DAY),
        Err(Ok(Error::FundNotInOffer))
    );
    assert_eq!(
        f.client
            .try_open_repo(&f.borrower, &99, &f.shares, &shares, &principal, &DAY),
        Err(Ok(Error::OfferNotFound))
    );
    f.client.freeze_fund(&f.shares, &true);
    assert_eq!(try_open(DAY), Err(Ok(Error::FundFrozen)));
    f.client.freeze_fund(&f.shares, &false);
    f.client.pause(&f.guardian);
    assert_eq!(try_open(DAY), Err(Ok(Error::Paused)));
}

#[test]
fn open_enforces_the_three_caps() {
    let (f, offer_id) = ready();
    let shares = 100_000 * ONE;
    f.client
        .set_fund_limits(&f.shares, &200, &(5_000 * ONE), &(8_000 * ONE));
    let try_open = |principal: i128| {
        f.client
            .try_open_repo(&f.borrower, &offer_id, &f.shares, &shares, &principal, &DAY)
    };
    assert_eq!(try_open(5_000 * ONE + 1), Err(Ok(Error::CapExceeded)));
    assert!(try_open(5_000 * ONE).is_ok());
    assert_eq!(try_open(3_000 * ONE + 1), Err(Ok(Error::CapExceeded)));
    f.client.set_currency_cap(&eur(&f.env), &(7_000 * ONE));
    assert_eq!(try_open(2_000 * ONE + 1), Err(Ok(Error::CapExceeded)));
    assert!(try_open(2_000 * ONE).is_ok());
}

#[test]
fn open_refuses_a_faulty_or_stale_price() {
    let (f, offer_id) = ready();
    publish_nav(&f, NAV_EUR * 2);
    assert_eq!(
        f.client.try_open_repo(
            &f.borrower,
            &offer_id,
            &f.shares,
            &(10_000 * ONE),
            &ONE,
            &DAY
        ),
        Err(Ok(Error::PriceOutOfBand))
    );
    publish_nav(&f, NAV_EUR);
    advance(&f, 27 * HOUR);
    assert_eq!(
        f.client.try_open_repo(
            &f.borrower,
            &offer_id,
            &f.shares,
            &(10_000 * ONE),
            &ONE,
            &DAY
        ),
        Err(Ok(Error::StalePrice))
    );
}

#[test]
fn open_with_a_removed_stablecoin_is_refused() {
    let (f, offer_id) = ready();
    f.client.remove_stablecoin(&f.eurc);
    assert_eq!(
        f.client.try_open_repo(
            &f.borrower,
            &offer_id,
            &f.shares,
            &(10_000 * ONE),
            &ONE,
            &DAY
        ),
        Err(Ok(Error::StablecoinNotAccepted))
    );
}

#[test]
fn cross_currency_repo_opens_and_closes() {
    let (f, _) = cross_fund();
    admit_lender(&f.client, &f.env, &f.shares, &f.lender);
    mint(&f.env, &f.eurc, &f.lender, 100_000 * ONE);
    mint(&f.env, &f.shares, &f.borrower, 10_000 * ONE);
    mint(&f.env, &f.eurc, &f.borrower, 100 * ONE);
    let offer_id = f.client.create_offer(
        &f.lender,
        &f.eurc,
        &(100_000 * ONE),
        &RATE_BPS,
        &(7 * DAY),
        &vec![&f.env, f.shares.clone()],
    );
    let ceiling = f
        .client
        .quote(&f.shares, &(10_000 * ONE), &f.eurc)
        .max_principal;
    let repo_id = f.client.open_repo(
        &f.borrower,
        &offer_id,
        &f.shares,
        &(10_000 * ONE),
        &ceiling,
        &DAY,
    );
    advance(&f, HOUR);
    f.client.repurchase(&repo_id);
    assert_eq!(balance(&f.env, &f.shares, &f.borrower), 10_000 * ONE);
}

/// Review finding M5: a revoked lender's offer stops lending.
#[test]
fn revoked_lender_offers_stop_lending() {
    let (f, offer_id) = ready();
    f.client.approve_lender(&f.shares, &f.lender, &false);
    assert_eq!(
        f.client.try_open_repo(
            &f.borrower,
            &offer_id,
            &f.shares,
            &(10_000 * ONE),
            &ONE,
            &DAY
        ),
        Err(Ok(Error::LenderNotApproved))
    );
    // The lender can still take the stablecoins back.
    f.client.withdraw_offer(&offer_id, &(100_000 * ONE));
}

/// Review finding M1: replacing a fund's configuration needs its current
/// steward too, not only the governor and whoever the governor names.
#[test]
fn replacing_a_steward_needs_the_current_steward() {
    let (f, _) = ready();
    let mut config = fund_config(&f);
    let successor = Address::generate(&f.env);
    config.steward = successor.clone();
    f.env.mock_auths(&[
        MockAuth {
            address: &f.governor,
            invoke: &MockAuthInvoke {
                contract: &f.contract_id,
                fn_name: "set_fund",
                args: (f.shares.clone(), config.clone()).into_val(&f.env),
                sub_invokes: &[],
            },
        },
        MockAuth {
            address: &successor,
            invoke: &MockAuthInvoke {
                contract: &f.contract_id,
                fn_name: "set_fund",
                args: (f.shares.clone(), config.clone()).into_val(&f.env),
                sub_invokes: &[],
            },
        },
    ]);
    assert!(f.client.try_set_fund(&f.shares, &config).is_err());
    f.env.mock_all_auths();
    assert_eq!(f.client.get_fund(&f.shares).unwrap().steward, f.steward);
    assert_eq!(f.client.pending_fund_change(&f.shares), None);
}

/// Review finding M4: the currency cannot change under open repos.
#[test]
fn currency_cannot_change_while_repos_are_open() {
    let (f, offer_id) = ready();
    open(&f, offer_id);
    let usd_oracle = f
        .env
        .register(MockOracle, (Asset::Other(usd(&f.env)), NAV_DECIMALS));
    MockOracleClient::new(&f.env, &usd_oracle).set_price(
        &Asset::Stellar(f.shares.clone()),
        &NAV_USD,
        &T0,
    );
    let mut config = fund_config(&f);
    config.oracle = usd_oracle;
    config.currency = usd(&f.env);
    assert_eq!(
        f.client.try_set_fund(&f.shares, &config),
        Err(Ok(Error::CurrencyMismatch))
    );
}

// ---------------------------------------------------------------------------
// Time delay on upgrades and fund changes (decision S7)
// ---------------------------------------------------------------------------

fn wasm_hash(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

#[test]
fn upgrade_needs_a_proposal_its_delay_and_the_same_hash() {
    let f = bare();
    let hash = wasm_hash(&f.env, 7);
    assert_eq!(
        f.client.try_upgrade(&hash),
        Err(Ok(raised(Error::NotProposed)))
    );
    // A newer proposal replaces the older one and restarts the delay.
    f.client.propose_upgrade(&wasm_hash(&f.env, 6));
    advance(&f, HOUR);
    f.client.propose_upgrade(&hash);
    assert_eq!(f.env.auths()[0].0, f.governor);
    let eta = T0 + HOUR + DEFAULT_TIMELOCK_SECS;
    assert_eq!(
        own_events(&f),
        std::vec![UpgradeProposed {
            wasm_hash: hash.clone(),
            eta
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(
        f.client.pending_upgrade(),
        Some(PendingUpgrade {
            wasm_hash: hash.clone(),
            eta
        })
    );
    advance(&f, DEFAULT_TIMELOCK_SECS - 1);
    assert_eq!(
        f.client.try_upgrade(&hash),
        Err(Ok(raised(Error::TimelockPending)))
    );
    advance(&f, 1);
    assert_eq!(
        f.client.try_upgrade(&wasm_hash(&f.env, 6)),
        Err(Ok(raised(Error::NotProposed)))
    );
    // The refusals left the proposal in place.
    assert_eq!(f.client.pending_upgrade().unwrap().wasm_hash, hash);
}

#[test]
fn guardian_cancels_an_upgrade_and_an_intruder_cannot() {
    let f = bare();
    let guardian = Address::generate(&f.env);
    f.client.set_guardian(&guardian);
    let hash = wasm_hash(&f.env, 7);
    f.client.propose_upgrade(&hash);
    let intruder = Address::generate(&f.env);
    assert_eq!(
        f.client.try_cancel_upgrade(&intruder),
        Err(Ok(Error::Unauthorized))
    );
    f.client.cancel_upgrade(&guardian);
    assert_eq!(f.env.auths()[0].0, guardian);
    assert_eq!(
        own_events(&f),
        std::vec![UpgradeCancelled {
            wasm_hash: hash.clone(),
            by: guardian.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.pending_upgrade(), None);
    assert_eq!(
        f.client.try_cancel_upgrade(&guardian),
        Err(Ok(Error::NotProposed))
    );
    advance(&f, DEFAULT_TIMELOCK_SECS);
    assert_eq!(
        f.client.try_upgrade(&hash),
        Err(Ok(raised(Error::NotProposed)))
    );
}

#[test]
fn intruder_cannot_propose_an_upgrade_or_cancel_in_the_governors_name() {
    let f = bare();
    let intruder = Address::generate(&f.env);
    let hash = wasm_hash(&f.env, 7);
    f.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "propose_upgrade",
            args: (hash.clone(),).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_propose_upgrade(&hash).is_err());
    f.env.mock_all_auths();
    assert_eq!(f.client.pending_upgrade(), None);
    f.client.propose_upgrade(&hash);
    f.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "cancel_upgrade",
            args: (f.governor.clone(),).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_cancel_upgrade(&f.governor).is_err());
    f.env.mock_all_auths();
    assert!(f.client.pending_upgrade().is_some());
}

#[test]
fn delay_moves_freely_before_the_first_admission_then_only_grows() {
    let f = bare();
    f.client.set_timelock_delay(&600);
    assert_eq!(
        own_events(&f),
        std::vec![TimelockDelayChanged { delay: 600 }.to_xdr(&f.env, &f.contract_id)]
    );
    // Nothing is at stake yet: a demonstration may shorten it.
    f.client.set_timelock_delay(&300);
    assert_eq!(f.client.timelock_delay(), 300);
    assert_eq!(
        f.client.try_set_timelock_delay(&(MIN_TIMELOCK_SECS - 1)),
        Err(Ok(Error::OutsideEnvelope))
    );
    assert_eq!(
        f.client.try_set_timelock_delay(&(MAX_TIMELOCK_SECS + 1)),
        Err(Ok(Error::OutsideEnvelope))
    );
    f.client.set_fund(&f.shares, &fund_config(&f));
    assert_eq!(
        f.client.try_set_timelock_delay(&299),
        Err(Ok(Error::DelayCannotDecrease))
    );
    f.client.set_timelock_delay(&DEFAULT_TIMELOCK_SECS);
    assert_eq!(f.client.timelock_delay(), DEFAULT_TIMELOCK_SECS);
    assert_eq!(
        f.client
            .try_set_timelock_delay(&(DEFAULT_TIMELOCK_SECS - 1)),
        Err(Ok(Error::DelayCannotDecrease))
    );
}

/// A contract upgraded from version 2 has admitted funds but no admission
/// flag; its offers are enough to close the bootstrap window.
#[test]
fn delay_cannot_decrease_on_a_contract_upgraded_with_offers() {
    let (f, _) = ready();
    f.env.as_contract(&f.contract_id, || {
        f.env.storage().instance().remove(&DataKey::FundsAdmitted);
        f.env.storage().instance().remove(&DataKey::TimelockDelay);
    });
    assert_eq!(f.client.timelock_delay(), DEFAULT_TIMELOCK_SECS);
    assert_eq!(
        f.client.try_set_timelock_delay(&300),
        Err(Ok(Error::DelayCannotDecrease))
    );
}

#[test]
fn intruder_cannot_change_the_delay() {
    let f = bare();
    let intruder = Address::generate(&f.env);
    f.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "set_timelock_delay",
            args: (300u64,).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_set_timelock_delay(&300).is_err());
    assert_eq!(f.client.timelock_delay(), DEFAULT_TIMELOCK_SECS);
}

/// The admitted configuration with a higher haircut.
fn replacement(f: &Fixture) -> FundConfig {
    let mut config = fund_config(f);
    config.haircut_bps = 300;
    config
}

#[test]
fn fund_replacement_waits_for_the_delay_then_anyone_applies_it() {
    let (f, _) = ready();
    let config = replacement(&f);
    f.client.set_fund(&f.shares, &config);
    let eta = T0 + DEFAULT_TIMELOCK_SECS;
    assert_eq!(
        own_events(&f),
        std::vec![FundChangeProposed {
            fund: f.shares.clone(),
            eta
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(
        f.client.pending_fund_change(&f.shares),
        Some(PendingFundChange {
            config: config.clone(),
            fx_anchor: 0,
            eta
        })
    );
    // Nothing changed yet: offers keep lending on the admitted terms.
    assert_eq!(f.client.get_fund(&f.shares).unwrap().haircut_bps, 200);
    assert_eq!(f.client.quote(&f.shares, &ONE, &f.eurc).haircut_bps, 200);
    advance(&f, DEFAULT_TIMELOCK_SECS - 1);
    publish_nav(&f, NAV_EUR);
    assert_eq!(
        f.client.try_apply_fund_change(&f.shares),
        Err(Ok(Error::TimelockPending))
    );
    advance(&f, 1);
    // Whoever applies picks the moment, here one with a higher spot NAV.
    publish_nav(&f, NAV_EUR * 10_005 / 10_000);
    f.env.set_auths(&[]);
    f.client.apply_fund_change(&f.shares);
    assert!(f.env.auths().is_empty());
    assert_eq!(
        own_events(&f),
        std::vec![FundSet {
            fund: f.shares.clone(),
            oracle: f.nav_oracle.clone(),
            haircut_bps: 300
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.get_fund(&f.shares), Some(config));
    assert_eq!(f.client.pending_fund_change(&f.shares), None);
    // Review finding H1: same feed, so the references carry over; the spot
    // price at the moment of the apply anchors nothing.
    let state = f.client.get_fund_state(&f.shares).unwrap();
    assert_eq!((state.reference_nav, state.reference_time), (NAV_EUR, T0));
    assert_eq!(
        f.client.try_apply_fund_change(&f.shares),
        Err(Ok(Error::NotProposed))
    );
}

#[test]
fn steward_cancels_a_fund_replacement_and_an_intruder_cannot() {
    let (f, _) = ready();
    f.client.set_fund(&f.shares, &replacement(&f));
    let intruder = Address::generate(&f.env);
    assert_eq!(
        f.client.try_cancel_fund_change(&f.shares, &intruder),
        Err(Ok(Error::Unauthorized))
    );
    f.client.cancel_fund_change(&f.shares, &f.steward);
    assert_eq!(f.env.auths()[0].0, f.steward);
    assert_eq!(
        own_events(&f),
        std::vec![FundChangeCancelled {
            fund: f.shares.clone(),
            by: f.steward.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.pending_fund_change(&f.shares), None);
    assert_eq!(
        f.client.try_cancel_fund_change(&f.shares, &f.governor),
        Err(Ok(Error::NotProposed))
    );
    advance(&f, DEFAULT_TIMELOCK_SECS);
    assert_eq!(
        f.client.try_apply_fund_change(&f.shares),
        Err(Ok(Error::NotProposed))
    );
    assert_eq!(f.client.get_fund(&f.shares).unwrap().haircut_bps, 200);
}

#[test]
fn guardian_cancels_a_fund_replacement() {
    let (f, _) = ready();
    let guardian = appoint_guardian(&f);
    f.client.set_fund(&f.shares, &replacement(&f));
    f.client.cancel_fund_change(&f.shares, &guardian);
    assert_eq!(f.env.auths()[0].0, guardian);
    assert_eq!(f.client.pending_fund_change(&f.shares), None);
}

#[test]
fn fund_change_is_checked_again_when_applied() {
    let (f, _) = ready();
    f.client.set_fund(&f.shares, &replacement(&f));
    advance(&f, DEFAULT_TIMELOCK_SECS);
    // The NAV published at admission is stale by now: the change waits.
    assert_eq!(
        f.client.try_apply_fund_change(&f.shares),
        Err(Ok(Error::StalePrice))
    );
    assert!(f.client.pending_fund_change(&f.shares).is_some());
    // A tighter envelope set in the meantime applies too.
    let mut envelope = default_envelope();
    envelope.min_haircut_bps = 400;
    f.client.set_envelope(&envelope);
    publish_nav(&f, NAV_EUR);
    assert_eq!(
        f.client.try_apply_fund_change(&f.shares),
        Err(Ok(Error::OutsideEnvelope))
    );
    // Loosening it back waits for its own delay.
    f.client.set_envelope(&default_envelope());
    advance(&f, DEFAULT_TIMELOCK_SECS);
    f.client.apply_envelope_change();
    publish_nav(&f, NAV_EUR);
    f.client.apply_fund_change(&f.shares);
    assert_eq!(f.client.get_fund(&f.shares).unwrap().haircut_bps, 300);
}

#[test]
fn currency_rule_is_checked_again_when_applied() {
    let (f, offer_id) = ready();
    let usd_oracle = f
        .env
        .register(MockOracle, (Asset::Other(usd(&f.env)), NAV_DECIMALS));
    let usd_feed = MockOracleClient::new(&f.env, &usd_oracle);
    // The new feed publishes a value on the fund's current path, so that it
    // passes the corridor and only the currency rule is at stake.
    usd_feed.set_price(&Asset::Stellar(f.shares.clone()), &NAV_EUR, &T0);
    let mut config = fund_config(&f);
    config.oracle = usd_oracle;
    config.currency = usd(&f.env);
    // No repo is open yet: the proposal passes.
    f.client.set_fund(&f.shares, &config);
    open(&f, offer_id);
    advance(&f, DEFAULT_TIMELOCK_SECS);
    let now = f.env.ledger().timestamp();
    usd_feed.set_price(&Asset::Stellar(f.shares.clone()), &NAV_EUR, &now);
    assert_eq!(
        f.client.try_apply_fund_change(&f.shares),
        Err(Ok(Error::CurrencyMismatch))
    );
    assert!(f.client.pending_fund_change(&f.shares).is_some());
}

#[test]
fn removing_a_fund_drops_its_pending_change_and_its_readmission_waits() {
    let (f, _) = ready();
    let guardian = appoint_guardian(&f);
    f.client.set_fund(&f.shares, &replacement(&f));
    f.client.remove_fund(&f.shares);
    assert_eq!(
        own_events(&f),
        std::vec![
            FundChangeCancelled {
                fund: f.shares.clone(),
                by: f.governor.clone()
            }
            .to_xdr(&f.env, &f.contract_id),
            FundRemoved {
                fund: f.shares.clone()
            }
            .to_xdr(&f.env, &f.contract_id)
        ]
    );
    assert_eq!(f.client.pending_fund_change(&f.shares), None);
    // Removing then re-admitting is a replacement: it waits too.
    f.client.set_fund(&f.shares, &fund_config(&f));
    assert_eq!(f.client.get_fund(&f.shares), None);
    assert!(f.client.pending_fund_change(&f.shares).is_some());
    // With no steward in place, the guardian holds the veto.
    f.client.cancel_fund_change(&f.shares, &guardian);
    assert_eq!(f.client.pending_fund_change(&f.shares), None);
}

// -- Guardian, term ceiling and envelope behind the same delay --------------

#[test]
fn guardian_is_appointed_at_once_before_the_first_admission() {
    let f = bare();
    let guardian = Address::generate(&f.env);
    f.client.set_guardian(&guardian);
    assert_eq!(
        own_events(&f),
        std::vec![GuardianChanged {
            guardian: guardian.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.guardian(), guardian);
    assert_eq!(f.client.pending_guardian_change(), None);
}

#[test]
fn guardian_change_waits_after_the_first_admission_then_anyone_applies_it() {
    let (f, _) = ready();
    let successor = Address::generate(&f.env);
    f.client.set_guardian(&successor);
    assert_eq!(f.env.auths()[0].0, f.governor);
    let eta = T0 + DEFAULT_TIMELOCK_SECS;
    assert_eq!(
        own_events(&f),
        std::vec![GuardianChangeProposed {
            guardian: successor.clone(),
            eta
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(
        f.client.pending_guardian_change(),
        Some(PendingGuardianChange {
            guardian: successor.clone(),
            eta
        })
    );
    assert_eq!(f.client.guardian(), f.governor);
    advance(&f, DEFAULT_TIMELOCK_SECS - 1);
    assert_eq!(
        f.client.try_apply_guardian_change(),
        Err(Ok(Error::TimelockPending))
    );
    advance(&f, 1);
    f.env.set_auths(&[]);
    f.client.apply_guardian_change();
    assert!(f.env.auths().is_empty());
    assert_eq!(
        own_events(&f),
        std::vec![GuardianChanged {
            guardian: successor.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.guardian(), successor);
    assert_eq!(f.client.pending_guardian_change(), None);
    assert_eq!(
        f.client.try_apply_guardian_change(),
        Err(Ok(Error::NotProposed))
    );
}

#[test]
fn current_guardian_or_governor_cancels_a_guardian_change() {
    let (f, _) = ready();
    let guardian = appoint_guardian(&f);
    let successor = Address::generate(&f.env);
    f.client.set_guardian(&successor);
    let intruder = Address::generate(&f.env);
    assert_eq!(
        f.client.try_cancel_guardian_change(&intruder),
        Err(Ok(Error::Unauthorized))
    );
    // The proposed guardian holds no role until the change applies.
    assert_eq!(
        f.client.try_cancel_guardian_change(&successor),
        Err(Ok(Error::Unauthorized))
    );
    f.client.cancel_guardian_change(&guardian);
    assert_eq!(f.env.auths()[0].0, guardian);
    assert_eq!(
        own_events(&f),
        std::vec![GuardianChangeCancelled {
            guardian: successor.clone(),
            by: guardian.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.pending_guardian_change(), None);
    assert_eq!(
        f.client.try_cancel_guardian_change(&guardian),
        Err(Ok(Error::NotProposed))
    );
    f.client.set_guardian(&successor);
    f.client.cancel_guardian_change(&f.governor);
    assert_eq!(f.env.auths()[0].0, f.governor);
    assert_eq!(f.client.pending_guardian_change(), None);
    assert_eq!(f.client.guardian(), guardian);
}

#[test]
fn intruder_cannot_replace_the_guardian() {
    let (f, _) = ready();
    let intruder = Address::generate(&f.env);
    f.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "set_guardian",
            args: (intruder.clone(),).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_set_guardian(&intruder).is_err());
    f.env.mock_all_auths();
    assert_eq!(f.client.pending_guardian_change(), None);
    assert_eq!(f.client.guardian(), f.governor);
}

/// The bypass this delay closes: with the governor key alone, an attacker
/// proposes a malicious upgrade and, to stop the guardian from vetoing it,
/// a guardian of their own. Both wait for the same delay, and the current
/// guardian cancels the guardian change first, then the upgrade.
#[test]
fn governor_key_alone_cannot_remove_the_veto_within_one_window() {
    let (f, _) = ready();
    let guardian = appoint_guardian(&f);
    let accomplice = Address::generate(&f.env);
    let malicious = wasm_hash(&f.env, 66);
    f.client.propose_upgrade(&malicious);
    f.client.set_guardian(&accomplice);
    // Inside the window, the accomplice is not the guardian yet.
    assert_eq!(
        f.client.try_cancel_upgrade(&accomplice),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(
        f.client.try_apply_guardian_change(),
        Err(Ok(Error::TimelockPending))
    );
    advance(&f, DEFAULT_TIMELOCK_SECS - 1);
    f.client.cancel_guardian_change(&guardian);
    f.client.cancel_upgrade(&guardian);
    assert_eq!(f.env.auths()[0].0, guardian);
    advance(&f, 1);
    assert_eq!(
        f.client.try_apply_guardian_change(),
        Err(Ok(Error::NotProposed))
    );
    assert_eq!(
        f.client.try_upgrade(&malicious),
        Err(Ok(raised(Error::NotProposed)))
    );
    assert_eq!(f.client.guardian(), guardian);
}

#[test]
fn max_term_moves_freely_before_the_first_admission() {
    let f = bare();
    f.client.set_max_term(&(10 * DAY));
    assert_eq!(
        own_events(&f),
        std::vec![MaxTermChanged { max_term: 10 * DAY }.to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.max_term(), 10 * DAY);
    assert_eq!(f.client.pending_max_term_change(), None);
}

#[test]
fn max_term_decrease_is_immediate_and_an_increase_waits() {
    let (f, _) = ready();
    f.client.set_max_term(&(3 * DAY));
    assert_eq!(
        own_events(&f),
        std::vec![MaxTermChanged { max_term: 3 * DAY }.to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.max_term(), 3 * DAY);
    f.client.set_max_term(&(10 * DAY));
    let eta = T0 + DEFAULT_TIMELOCK_SECS;
    assert_eq!(
        own_events(&f),
        std::vec![MaxTermChangeProposed {
            max_term: 10 * DAY,
            eta
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(
        f.client.pending_max_term_change(),
        Some(PendingMaxTermChange {
            max_term: 10 * DAY,
            eta
        })
    );
    assert_eq!(f.client.max_term(), 3 * DAY);
    assert_eq!(
        f.client.try_set_max_term(&(MAX_TERM_CEILING_SECS + 1)),
        Err(Ok(Error::InvalidTerm))
    );
    advance(&f, DEFAULT_TIMELOCK_SECS - 1);
    assert_eq!(
        f.client.try_apply_max_term_change(),
        Err(Ok(Error::TimelockPending))
    );
    advance(&f, 1);
    f.env.set_auths(&[]);
    f.client.apply_max_term_change();
    assert!(f.env.auths().is_empty());
    assert_eq!(
        own_events(&f),
        std::vec![MaxTermChanged { max_term: 10 * DAY }.to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.max_term(), 10 * DAY);
    assert_eq!(f.client.pending_max_term_change(), None);
    assert_eq!(
        f.client.try_apply_max_term_change(),
        Err(Ok(Error::NotProposed))
    );
}

#[test]
fn guardian_or_governor_cancels_a_max_term_increase() {
    let (f, _) = ready();
    let guardian = appoint_guardian(&f);
    f.client.set_max_term(&(10 * DAY));
    let intruder = Address::generate(&f.env);
    assert_eq!(
        f.client.try_cancel_max_term_change(&intruder),
        Err(Ok(Error::Unauthorized))
    );
    f.client.cancel_max_term_change(&guardian);
    assert_eq!(f.env.auths()[0].0, guardian);
    assert_eq!(
        own_events(&f),
        std::vec![MaxTermChangeCancelled {
            max_term: 10 * DAY,
            by: guardian.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.pending_max_term_change(), None);
    assert_eq!(
        f.client.try_cancel_max_term_change(&guardian),
        Err(Ok(Error::NotProposed))
    );
    f.client.set_max_term(&(10 * DAY));
    f.client.cancel_max_term_change(&f.governor);
    assert_eq!(f.client.pending_max_term_change(), None);
    assert_eq!(f.client.max_term(), DEFAULT_MAX_TERM_SECS);
}

#[test]
fn intruder_cannot_change_the_max_term() {
    let (f, _) = ready();
    let intruder = Address::generate(&f.env);
    f.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "set_max_term",
            args: (10 * DAY,).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_set_max_term(&(10 * DAY)).is_err());
    f.env.mock_all_auths();
    assert_eq!(f.client.pending_max_term_change(), None);
}

/// The default envelope with a faster maximum yield: a loosening.
fn looser_envelope() -> RiskEnvelope {
    let mut envelope = default_envelope();
    envelope.max_yield_bps = 2_000;
    envelope
}

#[test]
fn envelope_moves_freely_before_the_first_admission() {
    let f = bare();
    f.client.set_envelope(&looser_envelope());
    assert_eq!(
        own_events(&f),
        std::vec![EnvelopeChanged {
            envelope: looser_envelope()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.envelope(), looser_envelope());
    assert_eq!(f.client.pending_envelope_change(), None);
}

#[test]
fn envelope_tightening_is_immediate_and_any_loosening_waits() {
    let (f, _) = ready();
    let mut tighter = default_envelope();
    tighter.min_haircut_bps = 150;
    tighter.max_nav_age_secs = 2 * DAY;
    f.client.set_envelope(&tighter);
    assert_eq!(
        own_events(&f),
        std::vec![EnvelopeChanged {
            envelope: tighter.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.envelope(), tighter);
    // One bound tighter and one looser is still a loosening.
    let mut mixed = tighter.clone();
    mixed.min_fx_haircut_bps = 300;
    mixed.max_fx_band_bps = 600;
    f.client.set_envelope(&mixed);
    let eta = T0 + DEFAULT_TIMELOCK_SECS;
    assert_eq!(
        own_events(&f),
        std::vec![EnvelopeChangeProposed {
            envelope: mixed.clone(),
            eta
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(
        f.client.pending_envelope_change(),
        Some(PendingEnvelopeChange {
            envelope: mixed.clone(),
            eta
        })
    );
    assert_eq!(f.client.envelope(), tighter);
    // An invalid envelope is refused at once, queued or not.
    let mut invalid = looser_envelope();
    invalid.min_haircut_bps = 10_000;
    assert_eq!(
        f.client.try_set_envelope(&invalid),
        Err(Ok(Error::InvalidHaircut))
    );
    advance(&f, DEFAULT_TIMELOCK_SECS - 1);
    assert_eq!(
        f.client.try_apply_envelope_change(),
        Err(Ok(Error::TimelockPending))
    );
    advance(&f, 1);
    f.env.set_auths(&[]);
    f.client.apply_envelope_change();
    assert!(f.env.auths().is_empty());
    assert_eq!(
        own_events(&f),
        std::vec![EnvelopeChanged {
            envelope: mixed.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.envelope(), mixed);
    assert_eq!(f.client.pending_envelope_change(), None);
    assert_eq!(
        f.client.try_apply_envelope_change(),
        Err(Ok(Error::NotProposed))
    );
}

#[test]
fn guardian_or_governor_cancels_an_envelope_loosening() {
    let (f, _) = ready();
    let guardian = appoint_guardian(&f);
    f.client.set_envelope(&looser_envelope());
    let intruder = Address::generate(&f.env);
    assert_eq!(
        f.client.try_cancel_envelope_change(&intruder),
        Err(Ok(Error::Unauthorized))
    );
    f.client.cancel_envelope_change(&guardian);
    assert_eq!(f.env.auths()[0].0, guardian);
    assert_eq!(
        own_events(&f),
        std::vec![EnvelopeChangeCancelled {
            envelope: looser_envelope(),
            by: guardian.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.pending_envelope_change(), None);
    assert_eq!(
        f.client.try_cancel_envelope_change(&guardian),
        Err(Ok(Error::NotProposed))
    );
    f.client.set_envelope(&looser_envelope());
    f.client.cancel_envelope_change(&f.governor);
    assert_eq!(f.client.pending_envelope_change(), None);
    assert_eq!(f.client.envelope(), default_envelope());
}

#[test]
fn intruder_cannot_change_the_envelope() {
    let (f, _) = ready();
    let intruder = Address::generate(&f.env);
    f.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "set_envelope",
            args: (looser_envelope(),).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_set_envelope(&looser_envelope()).is_err());
    f.env.mock_all_auths();
    assert_eq!(f.client.pending_envelope_change(), None);
    assert_eq!(f.client.envelope(), default_envelope());
}

// -- Review of version 3: references, expiry, issuer, limits, guardian -----

/// Review finding H1: a new NAV feed must agree with the reference the fund
/// has followed, at the proposal and again at the apply; the reference
/// carries over in the new feed's decimals.
#[test]
fn a_new_nav_feed_must_lie_on_the_funds_path() {
    let (f, _) = ready();
    let (oracle, feed) = second_feed(&f, eur(&f.env));
    let mut config = fund_config(&f);
    config.oracle = oracle;
    // 2 % above the reference in a day: outside the corridor.
    publish_on(&f, &feed, NAV_EUR_8 * 102 / 100);
    assert_eq!(
        f.client.try_set_fund(&f.shares, &config),
        Err(Ok(Error::PriceOutOfBand))
    );
    publish_on(&f, &feed, NAV_EUR_8);
    f.client.set_fund(&f.shares, &config);
    advance(&f, DEFAULT_TIMELOCK_SECS);
    publish_nav(&f, NAV_EUR);
    // The applier picks a moment when the new feed is off the path: refused,
    // and the proposal waits.
    publish_on(&f, &feed, NAV_EUR_8 * 102 / 100);
    assert_eq!(
        f.client.try_apply_fund_change(&f.shares),
        Err(Ok(Error::PriceOutOfBand))
    );
    assert!(f.client.pending_fund_change(&f.shares).is_some());
    publish_on(&f, &feed, NAV_EUR_8);
    f.client.apply_fund_change(&f.shares);
    let state = f.client.get_fund_state(&f.shares).unwrap();
    assert_eq!(state.nav_decimals, FALLBACK_DECIMALS);
    assert_eq!((state.reference_nav, state.reference_time), (NAV_EUR_8, T0));
}

/// Verification of review finding arith-2, same root on another path (20
/// October 2026): the new NAV feed of a replacement or a re-admission must
/// read inside the corridor around the fund's reference, and that corridor
/// grew with the time since the reference. After sixty quiet days, or sixty
/// days of removal, a feed reading 0.9 % above the reference passed. The
/// growth counts over at most the NAV age bound there too, at the proposal
/// and at the apply: the bound is that of a reference 26 hours old.
#[test]
fn a_new_nav_feed_after_a_quiet_spell_gets_one_nav_age_of_growth() {
    // Tops of the corridor around `reference` (published at T0) now, with
    // the growth counted over the NAV age bound, and as rc4 counted it.
    let tops = |f: &Fixture, reference: i128| {
        let config = fund_config(f);
        let now = f.env.ledger().timestamp();
        (
            corridor_top(&config, reference, T0, now, config.nav_max_age_secs),
            corridor_top(&config, reference, T0, now, u64::MAX),
        )
    };

    // Replacement of an admitted fund's NAV feed.
    let (f, _) = ready();
    let (oracle, feed) = second_feed(&f, eur(&f.env));
    let next = FundConfig {
        oracle,
        ..fund_config(&f)
    };
    advance(&f, 60 * DAY);
    let (top, rc4_top) = tops(&f, NAV_EUR_8);
    assert_eq!(
        top,
        corridor_top(&next, NAV_EUR_8, T0, T0 + 26 * HOUR, u64::MAX)
    );
    assert!(rc4_top > NAV_EUR_8 * 10_090 / 10_000);
    for refused in [rc4_top, top + 1] {
        publish_on(&f, &feed, refused);
        assert_eq!(
            f.client.try_set_fund(&f.shares, &next),
            Err(Ok(Error::PriceOutOfBand))
        );
    }
    publish_on(&f, &feed, top);
    f.client.set_fund(&f.shares, &next);
    advance(&f, DEFAULT_TIMELOCK_SECS);
    let (top, rc4_top) = tops(&f, NAV_EUR_8);
    publish_on(&f, &feed, rc4_top);
    assert_eq!(
        f.client.try_apply_fund_change(&f.shares),
        Err(Ok(Error::PriceOutOfBand))
    );
    publish_on(&f, &feed, top);
    f.client.apply_fund_change(&f.shares);
    let state = f.client.get_fund_state(&f.shares).unwrap();
    assert_eq!((state.reference_nav, state.reference_time), (NAV_EUR_8, T0));

    // Re-admission after sixty days of removal: the proposal defers the
    // check, the apply makes it with the same bound.
    let (f, _) = ready();
    f.client.remove_fund(&f.shares);
    advance(&f, 60 * DAY);
    publish_nav(&f, NAV_EUR);
    f.client.set_fund(&f.shares, &fund_config(&f));
    advance(&f, DEFAULT_TIMELOCK_SECS);
    let (top, rc4_top) = tops(&f, NAV_EUR);
    publish_nav(&f, rc4_top);
    assert_eq!(
        f.client.try_apply_fund_change(&f.shares),
        Err(Ok(Error::PriceOutOfBand))
    );
    publish_nav(&f, top);
    f.client.apply_fund_change(&f.shares);
    assert_eq!(f.client.get_fund(&f.shares), Some(fund_config(&f)));
}

/// Review finding H1, FX leg: a new FX feed must lie within the current band
/// around the current reference rate, which carries over.
#[test]
fn a_new_fx_feed_must_lie_within_the_current_band() {
    let (f, _) = cross_fund();
    let mut config = f.client.get_fund(&f.shares).unwrap();
    let nav_feed = MockOracleClient::new(&f.env, &config.oracle);
    let fx_oracle = f
        .env
        .register(MockOracle, (Asset::Other(usd(&f.env)), NAV_DECIMALS));
    let fx_feed = MockOracleClient::new(&f.env, &fx_oracle);
    let PriceSource::Cross(mut leg) = config.source.clone() else {
        panic!("cross fund");
    };
    leg.oracle = fx_oracle;
    config.source = PriceSource::Cross(leg);
    let publish = |rate: i128| {
        let now = f.env.ledger().timestamp();
        fx_feed.set_price(&Asset::Other(eur(&f.env)), &rate, &now);
        nav_feed.set_price(&Asset::Stellar(f.shares.clone()), &NAV_USD, &now);
    };
    // 3 % away from the reference rate, for a band of 2 %.
    publish(EUR_USD * 97 / 100);
    assert_eq!(
        f.client.try_set_fund(&f.shares, &config),
        Err(Ok(Error::PriceOutOfBand))
    );
    publish(EUR_USD * 99 / 100);
    f.client.set_fund(&f.shares, &config);
    advance(&f, DEFAULT_TIMELOCK_SECS);
    publish(EUR_USD * 97 / 100);
    assert_eq!(
        f.client.try_apply_fund_change(&f.shares),
        Err(Ok(Error::PriceOutOfBand))
    );
    publish(EUR_USD * 99 / 100);
    f.client.apply_fund_change(&f.shares);
    assert_eq!(
        f.client.get_fund_state(&f.shares).unwrap().reference_fx,
        EUR_USD
    );
}

/// Review findings H1b and M3: a proposal applies from its eta to the end of
/// its seven-day grace period, then it is gone.
#[test]
fn proposals_expire_after_their_grace_period() {
    let (f, _) = ready();
    f.client.set_fund(&f.shares, &replacement(&f));
    let hash = wasm_hash(&f.env, 7);
    f.client.propose_upgrade(&hash);
    advance(&f, DEFAULT_TIMELOCK_SECS + PROPOSAL_GRACE_SECS);
    publish_nav(&f, NAV_EUR);
    // The last second of the grace period still counts.
    assert!(f.client.pending_upgrade().is_some());
    f.client.apply_fund_change(&f.shares);
    advance(&f, 1);
    assert_eq!(f.client.pending_upgrade(), None);
    assert_eq!(
        f.client.try_upgrade(&hash),
        Err(Ok(raised(Error::ProposalExpired)))
    );
    f.client.set_max_term(&(10 * DAY));
    advance(&f, DEFAULT_TIMELOCK_SECS + PROPOSAL_GRACE_SECS + 1);
    assert_eq!(f.client.pending_max_term_change(), None);
    assert_eq!(
        f.client.try_apply_max_term_change(),
        Err(Ok(Error::ProposalExpired))
    );
    // A new proposal replaces the expired one.
    f.client.set_max_term(&(10 * DAY));
    assert!(f.client.pending_max_term_change().is_some());
}

/// Review finding H2: after a removal, re-admitting the fund under another
/// steward still needs the last one, who also keeps the right to cancel.
#[test]
fn readmission_after_removal_needs_the_last_steward() {
    let (f, _) = ready();
    f.client.remove_fund(&f.shares);
    let newcomer = Address::generate(&f.env);
    let mut config = fund_config(&f);
    config.steward = newcomer.clone();
    let signs = |address: &Address| MockAuth {
        address: leak(address.clone()),
        invoke: leak(MockAuthInvoke {
            contract: leak(f.contract_id.clone()),
            fn_name: "set_fund",
            args: (f.shares.clone(), config.clone()).into_val(&f.env),
            sub_invokes: &[],
        }),
    };
    f.env.mock_auths(&[signs(&f.governor), signs(&newcomer)]);
    assert!(f.client.try_set_fund(&f.shares, &config).is_err());
    f.env
        .mock_auths(&[signs(&f.governor), signs(&newcomer), signs(&f.steward)]);
    f.client.set_fund(&f.shares, &config);
    f.env.mock_all_auths();
    assert!(f.client.pending_fund_change(&f.shares).is_some());
    f.client.cancel_fund_change(&f.shares, &f.steward);
    assert_eq!(f.env.auths()[0].0, f.steward);
    assert_eq!(f.client.pending_fund_change(&f.shares), None);
}

#[test]
fn fund_limits_tighten_at_once_and_loosen_after_the_delay() {
    let (f, _) = ready();
    f.client
        .set_fund_limits(&f.shares, &300, &(400_000 * ONE), &(4_000_000 * ONE));
    assert_eq!(
        own_events(&f),
        std::vec![FundLimitsSet {
            fund: f.shares.clone(),
            haircut_bps: 300,
            max_principal_per_repo: 400_000 * ONE,
            max_outstanding: 4_000_000 * ONE
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    // A lower haircut is a loosening, even with the caps unchanged.
    f.client
        .set_fund_limits(&f.shares, &200, &(400_000 * ONE), &(4_000_000 * ONE));
    let eta = T0 + DEFAULT_TIMELOCK_SECS;
    assert_eq!(
        own_events(&f),
        std::vec![FundLimitsChangeProposed {
            fund: f.shares.clone(),
            haircut_bps: 200,
            max_principal_per_repo: 400_000 * ONE,
            max_outstanding: 4_000_000 * ONE,
            eta
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(
        f.client.pending_fund_limits_change(&f.shares),
        Some(PendingFundLimitsChange {
            haircut_bps: 200,
            max_principal_per_repo: 400_000 * ONE,
            max_outstanding: 4_000_000 * ONE,
            eta
        })
    );
    assert_eq!(f.client.get_fund(&f.shares).unwrap().haircut_bps, 300);
    assert_eq!(
        f.client.try_apply_fund_limits_change(&f.shares),
        Err(Ok(Error::TimelockPending))
    );
    advance(&f, DEFAULT_TIMELOCK_SECS);
    f.env.set_auths(&[]);
    f.client.apply_fund_limits_change(&f.shares);
    assert!(f.env.auths().is_empty());
    assert_eq!(f.client.get_fund(&f.shares).unwrap().haircut_bps, 200);
    assert_eq!(f.client.pending_fund_limits_change(&f.shares), None);
    assert_eq!(
        f.client.try_apply_fund_limits_change(&f.shares),
        Err(Ok(Error::NotProposed))
    );
}

#[test]
fn fund_limits_loosening_is_cancelled_by_the_right_roles_or_a_tightening() {
    let (f, _) = ready();
    let guardian = appoint_guardian(&f);
    let loosen = || {
        f.client
            .set_fund_limits(&f.shares, &200, &(600_000 * ONE), &(5_000_000 * ONE))
    };
    loosen();
    let intruder = Address::generate(&f.env);
    assert_eq!(
        f.client.try_cancel_fund_limits_change(&f.shares, &intruder),
        Err(Ok(Error::Unauthorized))
    );
    f.client.cancel_fund_limits_change(&f.shares, &guardian);
    assert_eq!(
        own_events(&f),
        std::vec![FundLimitsChangeCancelled {
            fund: f.shares.clone(),
            by: guardian.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    loosen();
    f.client.cancel_fund_limits_change(&f.shares, &f.governor);
    assert_eq!(f.client.pending_fund_limits_change(&f.shares), None);
    loosen();
    // Review finding M3: a direct tightening drops the pending loosening.
    f.client
        .set_fund_limits(&f.shares, &250, &(500_000 * ONE), &(5_000_000 * ONE));
    assert_eq!(
        own_events(&f),
        std::vec![
            FundLimitsChangeCancelled {
                fund: f.shares.clone(),
                by: f.steward.clone()
            }
            .to_xdr(&f.env, &f.contract_id),
            FundLimitsSet {
                fund: f.shares.clone(),
                haircut_bps: 250,
                max_principal_per_repo: 500_000 * ONE,
                max_outstanding: 5_000_000 * ONE
            }
            .to_xdr(&f.env, &f.contract_id)
        ]
    );
    assert_eq!(f.client.pending_fund_limits_change(&f.shares), None);
    // An intruder cannot touch the limits at all.
    f.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "set_fund_limits",
            args: (f.shares.clone(), 200u32, 600_000 * ONE, 5_000_000 * ONE).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f
        .client
        .try_set_fund_limits(&f.shares, &200, &(600_000 * ONE), &(5_000_000 * ONE))
        .is_err());
    f.env.mock_all_auths();
    assert_eq!(f.client.pending_fund_limits_change(&f.shares), None);
}

#[test]
fn currency_cap_moves_freely_before_the_first_admission() {
    let f = bare();
    f.client.set_currency_cap(&eur(&f.env), &(10 * ONE));
    assert_eq!(f.client.currency_cap(&eur(&f.env)), 10 * ONE);
    assert_eq!(f.client.pending_currency_cap_change(&eur(&f.env)), None);
}

#[test]
fn currency_cap_decrease_is_immediate_and_an_increase_waits() {
    let (f, _) = ready();
    let cap = |amount: i128| f.client.set_currency_cap(&eur(&f.env), &amount);
    cap(5_000_000 * ONE);
    assert_eq!(
        own_events(&f),
        std::vec![CurrencyCapSet {
            currency: eur(&f.env),
            cap: 5_000_000 * ONE
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    cap(20_000_000 * ONE);
    let eta = T0 + DEFAULT_TIMELOCK_SECS;
    assert_eq!(
        own_events(&f),
        std::vec![CurrencyCapChangeProposed {
            currency: eur(&f.env),
            cap: 20_000_000 * ONE,
            eta
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(
        f.client.pending_currency_cap_change(&eur(&f.env)),
        Some(PendingCurrencyCapChange {
            cap: 20_000_000 * ONE,
            eta
        })
    );
    assert_eq!(f.client.currency_cap(&eur(&f.env)), 5_000_000 * ONE);
    assert_eq!(
        f.client.try_apply_currency_cap_change(&eur(&f.env)),
        Err(Ok(Error::TimelockPending))
    );
    advance(&f, DEFAULT_TIMELOCK_SECS);
    f.env.set_auths(&[]);
    f.client.apply_currency_cap_change(&eur(&f.env));
    assert!(f.env.auths().is_empty());
    assert_eq!(f.client.currency_cap(&eur(&f.env)), 20_000_000 * ONE);
    assert_eq!(
        f.client.try_apply_currency_cap_change(&eur(&f.env)),
        Err(Ok(Error::NotProposed))
    );
}

#[test]
fn currency_cap_increase_is_cancelled_by_the_right_roles_or_a_decrease() {
    let (f, _) = ready();
    let guardian = appoint_guardian(&f);
    let raise = || f.client.set_currency_cap(&eur(&f.env), &(20_000_000 * ONE));
    raise();
    let intruder = Address::generate(&f.env);
    assert_eq!(
        f.client
            .try_cancel_currency_cap_change(&eur(&f.env), &intruder),
        Err(Ok(Error::Unauthorized))
    );
    f.client.cancel_currency_cap_change(&eur(&f.env), &guardian);
    assert_eq!(
        own_events(&f),
        std::vec![CurrencyCapChangeCancelled {
            currency: eur(&f.env),
            by: guardian.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    raise();
    f.client
        .cancel_currency_cap_change(&eur(&f.env), &f.governor);
    raise();
    f.client.set_currency_cap(&eur(&f.env), &(1_000 * ONE));
    assert_eq!(
        own_events(&f),
        std::vec![
            CurrencyCapChangeCancelled {
                currency: eur(&f.env),
                by: f.governor.clone()
            }
            .to_xdr(&f.env, &f.contract_id),
            CurrencyCapSet {
                currency: eur(&f.env),
                cap: 1_000 * ONE
            }
            .to_xdr(&f.env, &f.contract_id)
        ]
    );
    assert_eq!(f.client.pending_currency_cap_change(&eur(&f.env)), None);
    f.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "set_currency_cap",
            args: (eur(&f.env), 2_000 * ONE).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f
        .client
        .try_set_currency_cap(&eur(&f.env), &(2_000 * ONE))
        .is_err());
    f.env.mock_all_auths();
    // At most eight currencies wait at once.
    for i in 0..MAX_PENDING_CURRENCY_CAPS {
        let currency = Symbol::new(&f.env, &std::format!("C{i}"));
        f.client.set_currency_cap(&currency, &ONE);
    }
    assert_eq!(
        f.client.try_set_currency_cap(&usd(&f.env), &ONE),
        Err(Ok(Error::LimitReached))
    );
}

/// Review finding M2: the current guardian can always hand its role over,
/// at once, to the backup it registered with the governor (I13).
#[test]
fn guardian_hands_over_its_role_at_once() {
    let (f, _) = ready();
    let guardian = appoint_guardian(&f);
    let successor = Address::generate(&f.env);
    f.client.set_guardian_backup(&successor);
    let intruder = Address::generate(&f.env);
    f.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "hand_over_guardian",
            args: (intruder.clone(),).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_hand_over_guardian(&intruder).is_err());
    f.env.mock_all_auths();
    f.client.hand_over_guardian(&successor);
    assert_eq!(f.env.auths()[0].0, guardian);
    assert_eq!(
        own_events(&f),
        std::vec![GuardianChanged {
            guardian: successor.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.guardian(), successor);
}

/// Review finding M2: a lost or hostile guardian cannot freeze governance.
/// The governor forces a new one after thirty days, and the guardian it
/// replaces cannot cancel that.
#[test]
fn governor_forces_a_guardian_change_after_thirty_days() {
    let (f, _) = ready();
    let guardian = appoint_guardian(&f);
    let successor = Address::generate(&f.env);
    f.client.force_guardian_change(&successor);
    let eta = f.env.ledger().timestamp() + MAX_TIMELOCK_SECS;
    assert_eq!(
        own_events(&f),
        std::vec![GuardianChangeForced {
            guardian: successor.clone(),
            eta
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(
        f.client.pending_forced_guardian_change(),
        Some(PendingGuardianChange {
            guardian: successor.clone(),
            eta
        })
    );
    // The guardian's veto covers ordinary changes, not this one.
    assert_eq!(
        f.client.try_cancel_guardian_change(&guardian),
        Err(Ok(Error::NotProposed))
    );
    f.env.mock_auths(&[MockAuth {
        address: &guardian,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "cancel_forced_guardian_change",
            args: ().into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_cancel_forced_guardian_change().is_err());
    f.env.mock_all_auths();
    advance(&f, MAX_TIMELOCK_SECS - 1);
    assert_eq!(
        f.client.try_apply_forced_guardian_change(),
        Err(Ok(Error::TimelockPending))
    );
    advance(&f, 1);
    f.env.set_auths(&[]);
    f.client.apply_forced_guardian_change();
    f.env.mock_all_auths();
    assert_eq!(f.client.guardian(), successor);

    // The governor may withdraw its own forced change.
    f.client.force_guardian_change(&guardian);
    f.client.cancel_forced_guardian_change();
    assert_eq!(
        own_events(&f),
        std::vec![ForcedGuardianChangeCancelled {
            guardian: guardian.clone(),
            by: f.governor.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.pending_forced_guardian_change(), None);
}

/// Review finding M3: a direct tightening drops the pending loosening of
/// the same setting.
#[test]
fn a_direct_tightening_drops_the_pending_loosening() {
    let (f, _) = ready();
    f.client.set_max_term(&(10 * DAY));
    f.client.set_max_term(&(3 * DAY));
    assert_eq!(
        own_events(&f),
        std::vec![
            MaxTermChangeCancelled {
                max_term: 10 * DAY,
                by: f.governor.clone()
            }
            .to_xdr(&f.env, &f.contract_id),
            MaxTermChanged { max_term: 3 * DAY }.to_xdr(&f.env, &f.contract_id)
        ]
    );
    assert_eq!(f.client.pending_max_term_change(), None);
    f.client.set_envelope(&looser_envelope());
    let mut tighter = default_envelope();
    tighter.min_haircut_bps = 150;
    f.client.set_envelope(&tighter);
    assert_eq!(
        own_events(&f),
        std::vec![
            EnvelopeChangeCancelled {
                envelope: looser_envelope(),
                by: f.governor.clone()
            }
            .to_xdr(&f.env, &f.contract_id),
            EnvelopeChanged {
                envelope: tighter.clone()
            }
            .to_xdr(&f.env, &f.contract_id)
        ]
    );
    assert_eq!(f.client.pending_envelope_change(), None);
}

/// Review finding M3: a new governor starts with none of the previous
/// governor's own proposals; those a steward signed stay.
#[test]
fn governor_handover_drops_the_governors_proposals() {
    let (f, _) = ready();
    let hash = wasm_hash(&f.env, 7);
    let pending_guardian = Address::generate(&f.env);
    let forced_guardian = Address::generate(&f.env);
    f.client.propose_upgrade(&hash);
    f.client.set_guardian(&pending_guardian);
    f.client.force_guardian_change(&forced_guardian);
    f.client.set_max_term(&(10 * DAY));
    f.client.set_envelope(&looser_envelope());
    f.client.set_currency_cap(&eur(&f.env), &(20_000_000 * ONE));
    f.client.set_fund(&f.shares, &replacement(&f));
    let successor = Address::generate(&f.env);
    f.client.set_admin(&successor);
    // After the first admission the handover waits for the delay (I12).
    advance(&f, DEFAULT_TIMELOCK_SECS);
    f.client.accept_admin();
    let by = successor.clone();
    assert_eq!(
        own_events(&f),
        std::vec![
            UpgradeCancelled {
                wasm_hash: hash,
                by: by.clone()
            }
            .to_xdr(&f.env, &f.contract_id),
            GuardianChangeCancelled {
                guardian: pending_guardian,
                by: by.clone()
            }
            .to_xdr(&f.env, &f.contract_id),
            ForcedGuardianChangeCancelled {
                guardian: forced_guardian,
                by: by.clone()
            }
            .to_xdr(&f.env, &f.contract_id),
            MaxTermChangeCancelled {
                max_term: 10 * DAY,
                by: by.clone()
            }
            .to_xdr(&f.env, &f.contract_id),
            EnvelopeChangeCancelled {
                envelope: looser_envelope(),
                by: by.clone()
            }
            .to_xdr(&f.env, &f.contract_id),
            CurrencyCapChangeCancelled {
                currency: eur(&f.env),
                by: by.clone()
            }
            .to_xdr(&f.env, &f.contract_id),
            AdminChanged {
                previous: f.governor.clone(),
                admin: successor.clone()
            }
            .to_xdr(&f.env, &f.contract_id)
        ]
    );
    assert_eq!(f.client.pending_upgrade(), None);
    assert_eq!(f.client.pending_guardian_change(), None);
    assert_eq!(f.client.pending_forced_guardian_change(), None);
    assert_eq!(f.client.pending_max_term_change(), None);
    assert_eq!(f.client.pending_envelope_change(), None);
    assert_eq!(f.client.pending_currency_cap_change(&eur(&f.env)), None);
    assert!(f.client.pending_fund_change(&f.shares).is_some());
}

// -- Second review of version 3 -----------------------------------------------

/// Second review, M1: a fund admitted before the steward record existed
/// (here: the record erased) is recorded at its removal, and reading the
/// record extends its TTL.
#[test]
fn removal_records_the_steward_and_reading_it_keeps_it_alive() {
    let (f, _) = ready();
    f.env.as_contract(&f.contract_id, || {
        f.env
            .storage()
            .persistent()
            .remove(&DataKey::LastSteward(f.shares.clone()));
    });
    f.client.remove_fund(&f.shares);
    let newcomer = Address::generate(&f.env);
    let mut config = fund_config(&f);
    config.steward = newcomer.clone();
    let signs = |address: &Address| MockAuth {
        address: leak(address.clone()),
        invoke: leak(MockAuthInvoke {
            contract: leak(f.contract_id.clone()),
            fn_name: "set_fund",
            args: (f.shares.clone(), config.clone()).into_val(&f.env),
            sub_invokes: &[],
        }),
    };
    f.env.mock_auths(&[signs(&f.governor), signs(&newcomer)]);
    assert!(f.client.try_set_fund(&f.shares, &config).is_err());
    f.env.mock_all_auths();
    f.client.set_fund(&f.shares, &config);
    let key = DataKey::LastSteward(f.shares.clone());
    age_ledgers(&f);
    assert!(entry_ttl(&f, &key) < BUMP_THRESHOLD_LEDGERS);
    f.client.cancel_fund_change(&f.shares, &f.steward);
    assert_eq!(entry_ttl(&f, &key), BUMP_TO_LEDGERS);
}

/// Second review, M2 (a) and M3: a replacement drops the loosened limits and
/// the re-anchor proposed against the configuration it replaces.
#[test]
fn a_replacement_drops_proposals_made_against_the_old_configuration() {
    let (f, _) = ready();
    f.client.set_fund(&f.shares, &replacement(&f));
    f.client
        .set_fund_limits(&f.shares, &200, &(600_000 * ONE), &(5_000_000 * ONE));
    f.client.propose_reanchor(&f.shares, &NAV_EUR, &0);
    advance(&f, DEFAULT_TIMELOCK_SECS);
    publish_nav(&f, NAV_EUR);
    f.client.apply_fund_change(&f.shares);
    let by = f.contract_id.clone();
    assert_eq!(
        own_events(&f),
        std::vec![
            FundLimitsChangeCancelled {
                fund: f.shares.clone(),
                by: by.clone()
            }
            .to_xdr(&f.env, &f.contract_id),
            ReanchorCancelled {
                fund: f.shares.clone(),
                by
            }
            .to_xdr(&f.env, &f.contract_id),
            FundSet {
                fund: f.shares.clone(),
                oracle: f.nav_oracle.clone(),
                haircut_bps: 300
            }
            .to_xdr(&f.env, &f.contract_id)
        ]
    );
    assert_eq!(f.client.pending_fund_limits_change(&f.shares), None);
    assert_eq!(f.client.pending_reanchor(&f.shares), None);
}

/// Second review, M2 (b): the steward's direct tightening drops a pending
/// replacement, which would otherwise overwrite it.
#[test]
fn a_limits_tightening_drops_a_pending_replacement() {
    let (f, _) = ready();
    f.client.set_fund(&f.shares, &replacement(&f));
    f.client
        .set_fund_limits(&f.shares, &300, &(400_000 * ONE), &(4_000_000 * ONE));
    assert_eq!(
        own_events(&f),
        std::vec![
            FundChangeCancelled {
                fund: f.shares.clone(),
                by: f.steward.clone()
            }
            .to_xdr(&f.env, &f.contract_id),
            FundLimitsSet {
                fund: f.shares.clone(),
                haircut_bps: 300,
                max_principal_per_repo: 400_000 * ONE,
                max_outstanding: 4_000_000 * ONE
            }
            .to_xdr(&f.env, &f.contract_id)
        ]
    );
    assert_eq!(f.client.pending_fund_change(&f.shares), None);
}

/// Second review, M2 (c): when a replacement changes the steward, the
/// fallback the previous steward signed goes.
#[test]
fn a_new_steward_drops_the_fallback_the_previous_one_signed() {
    let (f, _) = ready();
    let mut config = fund_config(&f);
    config.steward = Address::generate(&f.env);
    f.client.set_fund(&f.shares, &config);
    let (oracle, feed) = second_feed(&f, eur(&f.env));
    f.client
        .propose_fallback(&f.shares, &fallback_feed(&f, &oracle));
    advance(&f, DEFAULT_TIMELOCK_SECS);
    publish_nav(&f, NAV_EUR);
    publish_on(&f, &feed, NAV_EUR_8);
    f.client.apply_fund_change(&f.shares);
    assert_eq!(
        own_events(&f),
        std::vec![
            FallbackCancelled {
                fund: f.shares.clone(),
                by: f.contract_id.clone()
            }
            .to_xdr(&f.env, &f.contract_id),
            FundSet {
                fund: f.shares.clone(),
                oracle: f.nav_oracle.clone(),
                haircut_bps: 200
            }
            .to_xdr(&f.env, &f.contract_id)
        ]
    );
    assert_eq!(f.client.pending_fallback(&f.shares), None);
}

/// Second review, M3: after a legitimate drop, the governor and the steward
/// re-anchor the fund on the readings of the proposal; whoever applies can
/// neither choose the anchor nor apply it against a feed that moved away.
/// From rc5 on the apply carries the reference from the proposal's reading
/// to its own along the model path (review finding VAL-1, 20 October 2026):
/// never below the proposal, never above the path.
#[test]
fn reanchor_carries_the_readings_of_the_proposal_along_the_model() {
    let (f, offer_id) = ready();
    let dropped = NAV_EUR * 98 / 100;
    publish_nav(&f, dropped);
    assert_eq!(
        f.client.try_quote(&f.shares, &ONE, &f.eurc),
        Err(Ok(Error::PriceOutOfBand))
    );
    // Two keys: the governor alone cannot propose it.
    f.env.mock_auths(&[MockAuth {
        address: &f.governor,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "propose_reanchor",
            args: (f.shares.clone(), dropped, 0i128).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f
        .client
        .try_propose_reanchor(&f.shares, &dropped, &0)
        .is_err());
    f.env.mock_all_auths();
    f.client.propose_reanchor(&f.shares, &dropped, &0);
    let signers: std::vec::Vec<Address> = f.env.auths().into_iter().map(|a| a.0).collect();
    assert_eq!(signers, std::vec![f.governor.clone(), f.steward.clone()]);
    let eta = T0 + DEFAULT_TIMELOCK_SECS;
    assert_eq!(
        own_events(&f),
        std::vec![ReanchorProposed {
            fund: f.shares.clone(),
            nav: dropped,
            nav_time: T0,
            fx: 0,
            eta
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(
        f.client.pending_reanchor(&f.shares),
        Some(PendingReanchor {
            nav_oracle: f.nav_oracle.clone(),
            nav_asset: Asset::Stellar(f.shares.clone()),
            nav: dropped,
            nav_time: T0,
            nav_decimals: NAV_DECIMALS,
            fx: AnchorFx::Direct,
            eta
        })
    );
    assert_eq!(
        f.client.try_apply_reanchor(&f.shares),
        Err(Ok(Error::TimelockPending))
    );
    advance(&f, DEFAULT_TIMELOCK_SECS);
    // Review of the re-anchor round, item 3: the apply follows the model
    // from the proposed NAV. 0.2 % up in two days is faster than the
    // corridor (0.1 % floor plus 5 % a year over the two days of the delay,
    // 12.74 bps), 0.15 % down is below its floor: both refused. So is
    // 0.13 % up. The growth counts over the real elapsed time (review
    // finding VAL-1): over at most the NAV age bound, 26 hours, as rc5
    // first counted it, 0.12 % up was refused too.
    for moved in [
        dropped * 1_002 / 1_000,
        dropped * 9_985 / 10_000,
        dropped * 10_013 / 10_000,
    ] {
        publish_nav(&f, moved);
        assert_eq!(
            f.client.try_apply_reanchor(&f.shares),
            Err(Ok(Error::PriceOutOfBand))
        );
    }
    assert!(f.client.pending_reanchor(&f.shares).is_some());
    // 0.11 % up: more than the 0.1 % floor, but on the model, which a
    // symmetric band would wrongly refuse. The spot is not installed: the
    // reference is carried from the proposal along the model path, at most
    // 5 % a year over the two days, 2.74 bps.
    publish_nav(&f, dropped * 10_011 / 10_000);
    f.env.set_auths(&[]);
    f.client.apply_reanchor(&f.shares);
    assert!(f.env.auths().is_empty());
    let now = T0 + DEFAULT_TIMELOCK_SECS;
    let path = math::model_path(dropped, T0, now, 500, u64::MAX).unwrap();
    assert!(dropped < path && path < dropped * 10_011 / 10_000);
    assert_eq!(
        own_events(&f),
        std::vec![Reanchored {
            fund: f.shares.clone(),
            nav: path,
            nav_time: now,
            fx: 0
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    let state = f.client.get_fund_state(&f.shares).unwrap();
    assert_eq!((state.reference_nav, state.reference_time), (path, now));
    assert_eq!(f.client.pending_reanchor(&f.shares), None);
    f.env.mock_all_auths();
    f.client.open_repo(
        &f.borrower,
        &offer_id,
        &f.shares,
        &(10_000 * ONE),
        &(1_000 * ONE),
        &DAY,
    );
}

#[test]
fn reanchor_is_cancelled_by_the_right_roles() {
    let (f, _) = ready();
    let guardian = appoint_guardian(&f);
    f.client.propose_reanchor(&f.shares, &NAV_EUR, &0);
    let intruder = Address::generate(&f.env);
    assert_eq!(
        f.client.try_cancel_reanchor(&f.shares, &intruder),
        Err(Ok(Error::Unauthorized))
    );
    f.client.cancel_reanchor(&f.shares, &guardian);
    assert_eq!(
        own_events(&f),
        std::vec![ReanchorCancelled {
            fund: f.shares.clone(),
            by: guardian.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(
        f.client.try_cancel_reanchor(&f.shares, &guardian),
        Err(Ok(Error::NotProposed))
    );
    for caller in [&f.steward, &f.governor] {
        f.client.propose_reanchor(&f.shares, &NAV_EUR, &0);
        f.client.cancel_reanchor(&f.shares, caller);
        assert_eq!(f.env.auths()[0].0, *caller);
    }
    assert_eq!(f.client.pending_reanchor(&f.shares), None);
}

/// Second review, M3: a removed fund whose NAV left the old path is
/// re-admitted through a re-anchor on the feed of its pending re-admission.
#[test]
fn readmission_off_the_path_goes_through_a_reanchor() {
    let (f, _) = ready();
    f.client.remove_fund(&f.shares);
    let dropped = NAV_EUR * 98 / 100;
    publish_nav(&f, dropped);
    // The proposal of a removed fund's re-admission defers the path check.
    f.client.set_fund(&f.shares, &fund_config(&f));
    f.client.propose_reanchor(&f.shares, &dropped, &0);
    advance(&f, DEFAULT_TIMELOCK_SECS);
    publish_nav(&f, dropped);
    assert_eq!(
        f.client.try_apply_fund_change(&f.shares),
        Err(Ok(Error::PriceOutOfBand))
    );
    f.client.apply_reanchor(&f.shares);
    f.client.apply_fund_change(&f.shares);
    // The NAV did not move since the proposal: the anchor is the proposed
    // NAV, at the time of the apply's reading (review finding VAL-1).
    let state = f.client.get_fund_state(&f.shares).unwrap();
    assert_eq!(
        (state.reference_nav, state.reference_time),
        (dropped, T0 + DEFAULT_TIMELOCK_SECS)
    );
    assert!(f.client.get_fund(&f.shares).is_some());
}

/// A NAV accruing `bps` a year from `base` at T0, as the demo's feeds
/// publish (4 % a year).
fn accruing(base: i128, bps: i128, at: u64) -> i128 {
    base + base * bps * i128::from(at - T0) / (10_000 * 31_536_000)
}

/// Review finding VAL-1 (20 October 2026): the apply of a re-anchor counted
/// the NAV's growth since the proposal over at most the NAV age bound,
/// while the proposal's reading is at least one delay old. Under a delay of
/// about ten days or more, an honest NAV accruing 4 % a year never passed,
/// and a fund that had failed closed stayed unpriced: the delay cannot come
/// down after the first admission. The growth now counts over the real
/// elapsed time, and the reference is carried to the apply's reading. Under
/// 14- and 30-day delays, a fund that failed closed after twelve quiet days
/// is re-anchored three days into the grace period, and prices again.
#[test]
fn a_reanchor_applies_under_the_longest_delays() {
    for delay in [14 * DAY, MAX_TIMELOCK_SECS] {
        let f = bare();
        f.client.set_timelock_delay(&delay);
        let (f, _) = ready_from(f);
        let config = fund_config(&f);
        advance(&f, 12 * DAY);
        let proposed_at = f.env.ledger().timestamp();
        let proposed = accruing(NAV_EUR, 400, proposed_at);
        publish_nav(&f, proposed);
        assert_eq!(
            f.client.try_quote(&f.shares, &ONE, &f.eurc),
            Err(Ok(Error::PriceOutOfBand))
        );
        f.client.propose_reanchor(&f.shares, &proposed, &0);
        advance(&f, delay + 3 * DAY);
        let now = f.env.ledger().timestamp();
        let honest = accruing(NAV_EUR, 400, now);
        publish_nav(&f, honest);
        f.client.apply_reanchor(&f.shares);
        let state = f.client.get_fund_state(&f.shares).unwrap();
        assert_eq!((state.reference_nav, state.reference_time), (honest, now));
        assert!(
            honest
                <= math::model_path(proposed, proposed_at, now, config.max_yield_bps, u64::MAX)
                    .unwrap()
        );
        f.client.quote(&f.shares, &ONE, &f.eurc);
    }
}

/// Review finding VAL-1: whoever applies a re-anchor picks the moment, not
/// the anchor. Under a 14-day delay, a reading at the top of the corridor
/// around the proposal installs the model path from the proposal, one unit
/// more is refused, and a reading below the proposal installs the proposal:
/// the apply can neither lift the anchor above the path nor lower it.
#[test]
fn the_reading_at_the_apply_is_clamped_to_the_model_path() {
    let f = bare();
    f.client.set_timelock_delay(&(14 * DAY));
    let (f, _) = ready_from(f);
    let config = fund_config(&f);
    f.client.propose_reanchor(&f.shares, &NAV_EUR, &0);
    advance(&f, 14 * DAY);
    let now = f.env.ledger().timestamp();
    let path = math::model_path(NAV_EUR, T0, now, config.max_yield_bps, u64::MAX).unwrap();
    let top = corridor_top(&config, NAV_EUR, T0, now, u64::MAX);
    assert!(NAV_EUR < path && path < top);
    publish_nav(&f, top + 1);
    assert_eq!(
        f.client.try_apply_reanchor(&f.shares),
        Err(Ok(Error::PriceOutOfBand))
    );
    publish_nav(&f, top);
    f.client.apply_reanchor(&f.shares);
    assert_eq!(
        own_events(&f),
        std::vec![Reanchored {
            fund: f.shares.clone(),
            nav: path,
            nav_time: now,
            fx: 0
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    let state = f.client.get_fund_state(&f.shares).unwrap();
    assert_eq!((state.reference_nav, state.reference_time), (path, now));

    let f = bare();
    f.client.set_timelock_delay(&(14 * DAY));
    let (f, _) = ready_from(f);
    f.client.propose_reanchor(&f.shares, &NAV_EUR, &0);
    advance(&f, 14 * DAY);
    let now = f.env.ledger().timestamp();
    publish_nav(&f, NAV_EUR * 9_995 / 10_000);
    f.client.apply_reanchor(&f.shares);
    let state = f.client.get_fund_state(&f.shares).unwrap();
    assert_eq!((state.reference_nav, state.reference_time), (NAV_EUR, now));
}

/// Review finding VAL-1, the reviewer's case: a 14-day delay chosen before
/// the first admission, which never comes down, and a NAV accruing 4 % a
/// year that a keeper refreshes daily. The re-anchor applies at its eta
/// (rc5 as first written refused it on every day of its grace). After
/// twelve quiet days the fund fails closed, and the re-anchor, the way out,
/// applies under the same delay.
#[test]
fn a_reanchor_applies_under_a_two_week_delay() {
    let f = bare();
    f.client.set_timelock_delay(&(14 * DAY));
    let (f, offer_id) = ready_from(f);
    let publish = |f: &Fixture| {
        let nav = accruing(NAV_EUR, 400, f.env.ledger().timestamp());
        publish_nav(f, nav);
        nav
    };
    advance(&f, DAY);
    let nav = publish(&f);
    f.client.refresh_reference(&f.shares);
    f.client.propose_reanchor(&f.shares, &nav, &0);
    for _ in 0..14 {
        advance(&f, DAY);
        publish(&f);
        f.client.refresh_reference(&f.shares);
        f.client.quote(&f.shares, &ONE, &f.eurc);
    }
    f.client.apply_reanchor(&f.shares);
    f.client.quote(&f.shares, &ONE, &f.eurc);
    assert_eq!(
        f.client.try_set_timelock_delay(&(2 * DAY)),
        Err(Ok(Error::DelayCannotDecrease))
    );

    for _ in 0..12 {
        advance(&f, DAY);
        publish(&f);
    }
    assert_eq!(
        f.client.try_quote(&f.shares, &ONE, &f.eurc),
        Err(Ok(Error::PriceOutOfBand))
    );
    assert_eq!(
        f.client.try_refresh_reference(&f.shares),
        Err(Ok(Error::PriceOutOfBand))
    );
    let nav = publish(&f);
    f.client.propose_reanchor(&f.shares, &nav, &0);
    advance(&f, 14 * DAY);
    publish(&f);
    f.client.apply_reanchor(&f.shares);
    f.client
        .open_repo(&f.borrower, &offer_id, &f.shares, &ONE, &ONE, &DAY);
}

/// The haircut a re-anchor of `f`'s fund needs under the delay set on it.
fn reanchor_cover(f: &Fixture, config: &FundConfig) -> i128 {
    f.env
        .as_contract(&f.contract_id, || reanchor_haircut_bps(&f.env, config))
        .unwrap()
}

/// Review finding VAL-1, second round (20 October 2026): since the apply
/// carries the reference along the model path from the proposal, one wrong
/// primary reading at the apply, made by anyone at a moment of its choosing
/// within the grace, lifts the reference by the growth over the delay, the
/// grace and the NAV age at once, where a refresh grants one NAV age of
/// growth per reading. At the loosest settings the default envelope allows
/// (haircut 109, the cover of the corridor alone), under a 14-day or a
/// 30-day delay and a flat true NAV republished daily, that lift (57 and
/// 101 bps) exceeded the cover: a second wrong reading three days later at
/// the top of the new corridor lent more than 10,500 EURC against 10,000
/// shares worth that much. Such a re-anchor is now refused at its proposal
/// until the steward widens the haircut to two floors plus the growth over
/// the delay, the grace and two NAV ages (174 and 218 bps), and refused at
/// its apply when the delay grew meanwhile. Under the widened haircut the
/// same two readings lend less than the value, also in the strict case the
/// bound is sized for; the honest NAV still fails closed after the first
/// one, as any NAV under its corridor does, until `reset_reference`.
#[test]
fn a_reanchor_needs_a_haircut_that_covers_one_wrong_reading_at_its_apply() {
    for (delay, bound) in [(14 * DAY, 174), (MAX_TIMELOCK_SECS, 218)] {
        let f = bare();
        f.client.set_timelock_delay(&delay);
        let config = loosest_config(&f);
        assert_eq!(corridor_haircut_bps(&config), Ok(109));
        let (f, offer_id) = ready_with(f, config.clone());
        assert_eq!(reanchor_cover(&f, &config), bound);
        let outside = Err(Ok(Error::OutsideEnvelope));
        assert_eq!(
            f.client.try_propose_reanchor(&f.shares, &NAV_EUR, &0),
            outside
        );
        // One basis point short is still refused; the bound itself passes.
        // Widening the haircut tightens, so it applies at once.
        let widen = |haircut_bps: i128| {
            f.client.set_fund_limits(
                &f.shares,
                &u32::try_from(haircut_bps).unwrap(),
                &config.max_principal_per_repo,
                &config.max_outstanding,
            );
        };
        widen(bound - 1);
        assert_eq!(
            f.client.try_propose_reanchor(&f.shares, &NAV_EUR, &0),
            outside
        );
        widen(bound);
        let config = f.client.get_fund(&f.shares).unwrap();
        f.client.propose_reanchor(&f.shares, &NAV_EUR, &0);

        let shares = 10_000 * ONE;
        let true_value = shares * NAV_EUR / 10i128.pow(NAV_DECIMALS);
        for _ in 0..(delay + PROPOSAL_GRACE_SECS) / DAY {
            advance(&f, DAY);
            publish_nav(&f, NAV_EUR);
            f.client.refresh_reference(&f.shares);
            assert!(f.client.try_quote(&f.shares, &shares, &f.eurc).is_ok());
        }
        let applied_at = f.env.ledger().timestamp();
        publish_nav(&f, corridor_top(&config, NAV_EUR, T0, applied_at, u64::MAX));
        f.client.apply_reanchor(&f.shares);
        let path =
            math::model_path(NAV_EUR, T0, applied_at, config.max_yield_bps, u64::MAX).unwrap();
        let state = f.client.get_fund_state(&f.shares).unwrap();
        assert_eq!(
            (state.reference_nav, state.reference_time),
            (path, applied_at)
        );
        let lift_bps = (path - NAV_EUR) * 10_000 / NAV_EUR;
        assert!(lift_bps > i128::from(config.corridor_floor_bps));
        assert!(lift_bps <= bound - 2 * i128::from(config.corridor_floor_bps));
        publish_nav(&f, NAV_EUR);
        assert_eq!(
            f.client.try_quote(&f.shares, &shares, &f.eurc),
            Err(Ok(Error::PriceOutOfBand))
        );
        advance(&f, config.nav_max_age_secs);
        let later = f.env.ledger().timestamp();
        let top = corridor_top(&config, path, applied_at, later, config.nav_max_age_secs);
        publish_nav(&f, top);
        let quote = f.client.quote(&f.shares, &shares, &f.eurc);
        // At the 109 bps the corridor alone needs, this reading lent more
        // than the shares are worth; the cover across the re-anchor holds.
        let value_read = shares * top / 10i128.pow(NAV_DECIMALS);
        assert!(value_read * 9_891 / 10_000 > true_value);
        assert_eq!(quote.max_principal, value_read * (10_000 - bound) / 10_000);
        assert!(quote.max_principal < true_value);
        f.client.open_repo(
            &f.borrower,
            &offer_id,
            &f.shares,
            &shares,
            &quote.max_principal,
            &DAY,
        );
    }

    // The apply reads the delay of its own day: grown from 14 to 30 days
    // after the proposal, the cover is checked against the longer life.
    let f = bare();
    f.client.set_timelock_delay(&(14 * DAY));
    let config = FundConfig {
        haircut_bps: 174,
        ..loosest_config(&f)
    };
    let (f, _) = ready_with(f, config.clone());
    f.client.propose_reanchor(&f.shares, &NAV_EUR, &0);
    f.client.set_timelock_delay(&MAX_TIMELOCK_SECS);
    assert_eq!(reanchor_cover(&f, &config), 218);
    advance(&f, 14 * DAY);
    publish_nav(&f, NAV_EUR);
    assert_eq!(
        f.client.try_apply_reanchor(&f.shares),
        Err(Ok(Error::OutsideEnvelope))
    );
    f.client.set_fund_limits(
        &f.shares,
        &218,
        &config.max_principal_per_repo,
        &config.max_outstanding,
    );
    f.client.apply_reanchor(&f.shares);
    assert_eq!(f.client.pending_reanchor(&f.shares), None);

    // The strict case the bound is sized for: the proposal reads a NAV
    // already one NAV age old, which the true NAV sits a floor under; the
    // keeper reads that true NAV daily; the apply comes at the end of the
    // grace on a wrong reading, and a second one follows one NAV age later
    // at the top of the new corridor. At the bound the loan stays below the
    // shares' value.
    for (delay, bound) in [(14 * DAY, 174u32), (MAX_TIMELOCK_SECS, 218)] {
        let f = bare();
        f.client.set_timelock_delay(&delay);
        let config = FundConfig {
            haircut_bps: bound,
            ..loosest_config(&f)
        };
        let (f, offer_id) = ready_with(f, config.clone());
        let shares = 10_000 * ONE;
        let bottom = NAV_EUR * (10_000 - i128::from(config.corridor_floor_bps)) / 10_000;
        let true_value = shares * bottom / 10i128.pow(NAV_DECIMALS);
        advance(&f, config.nav_max_age_secs);
        f.client.propose_reanchor(&f.shares, &NAV_EUR, &0);
        assert_eq!(f.client.pending_reanchor(&f.shares).unwrap().nav_time, T0);
        for _ in 0..(delay + PROPOSAL_GRACE_SECS) / DAY {
            advance(&f, DAY);
            publish_nav(&f, bottom);
            f.client.refresh_reference(&f.shares);
            assert!(f.client.try_quote(&f.shares, &shares, &f.eurc).is_ok());
        }
        let applied_at = f.env.ledger().timestamp();
        assert_eq!(
            applied_at,
            T0 + config.nav_max_age_secs + delay + PROPOSAL_GRACE_SECS
        );
        publish_nav(&f, corridor_top(&config, NAV_EUR, T0, applied_at, u64::MAX));
        f.client.apply_reanchor(&f.shares);
        let path =
            math::model_path(NAV_EUR, T0, applied_at, config.max_yield_bps, u64::MAX).unwrap();
        assert_eq!(
            f.client.get_fund_state(&f.shares).unwrap().reference_nav,
            path
        );
        advance(&f, config.nav_max_age_secs);
        let later = f.env.ledger().timestamp();
        let top = corridor_top(&config, path, applied_at, later, config.nav_max_age_secs);
        publish_nav(&f, top);
        let quote = f.client.quote(&f.shares, &shares, &f.eurc);
        let value_read = shares * top / 10i128.pow(NAV_DECIMALS);
        assert_eq!(
            quote.max_principal,
            value_read * (10_000 - i128::from(bound)) / 10_000
        );
        std::println!(
            "strict case, delay {} d: loan {} against shares worth {}",
            delay / DAY,
            quote.max_principal,
            true_value
        );
        assert!(quote.max_principal < true_value);
        f.client.open_repo(
            &f.borrower,
            &offer_id,
            &f.shares,
            &shares,
            &quote.max_principal,
            &DAY,
        );
    }
}

/// Review finding VAL-1, second round: at the 48-hour default and the
/// fixtures' settings (10 / 500 / 26 h) the re-anchor needs 36 bps and the
/// 200 bps haircut covers it; under the five-minute delay of a
/// demonstration, 33. One wrong reading at the apply still lifts the
/// reference by the model path over the delay and the grace, 12.3 bps,
/// above the 10 bps floor: the honest flat NAV then fails closed, which the
/// cover makes safe and the steward undoes with `reset_reference`.
#[test]
fn at_the_default_delay_one_wrong_reading_at_the_apply_fails_the_honest_nav_closed() {
    let f = bare();
    f.client.set_timelock_delay(&300);
    assert_eq!(reanchor_cover(&f, &fund_config(&f)), 33);

    let (f, _) = ready();
    let config = fund_config(&f);
    assert_eq!(reanchor_cover(&f, &config), 36);
    f.client.propose_reanchor(&f.shares, &NAV_EUR, &0);
    for _ in 0..9 {
        advance(&f, DAY);
        publish_nav(&f, NAV_EUR);
        f.client.refresh_reference(&f.shares);
    }
    let now = f.env.ledger().timestamp();
    assert_eq!(now, T0 + DEFAULT_TIMELOCK_SECS + PROPOSAL_GRACE_SECS);
    let top = corridor_top(&config, NAV_EUR, T0, now, u64::MAX);
    publish_nav(&f, top);
    f.client.apply_reanchor(&f.shares);
    let lifted = f.client.get_fund_state(&f.shares).unwrap().reference_nav;
    // 12.32 bps, in hundredths.
    assert_eq!((lifted - NAV_EUR) * 1_000_000 / NAV_EUR, 1_232);
    // The reading that lifted it values the shares under the cover.
    let shares = 10_000 * ONE;
    let quote = f.client.quote(&f.shares, &shares, &f.eurc);
    assert!(quote.max_principal < shares * NAV_EUR / 10i128.pow(NAV_DECIMALS));
    advance(&f, HOUR);
    publish_nav(&f, NAV_EUR);
    assert_eq!(
        f.client.try_quote(&f.shares, &ONE, &f.eurc),
        Err(Ok(Error::PriceOutOfBand))
    );
    f.client.reset_reference(&f.shares);
    assert!(f.client.try_quote(&f.shares, &ONE, &f.eurc).is_ok());
}

/// A cross fund admitted under `delay`, its USD NAV accruing `growth_bps` a
/// year, refreshed daily by a keeper. EUR/USD moves 2.5 % up, beyond the
/// 2 % band: the fund stops pricing until a re-anchor on the new rate
/// applies, one delay later. Returns the result of that apply.
fn cross_reanchor_after(delay: u64, growth_bps: i128) -> Result<(), Error> {
    let f = bare();
    f.client.set_timelock_delay(&delay);
    let (nav_oracle, nav_feed) = feed_with_decimals(&f, usd(&f.env), NAV_DECIMALS);
    let (fx_oracle, fx_feed) = feed_with_decimals(&f, usd(&f.env), NAV_DECIMALS);
    let publish = |f: &Fixture, rate: i128| {
        let now = f.env.ledger().timestamp();
        let nav = accruing(NAV_USD, growth_bps, now);
        nav_feed.set_price(&Asset::Stellar(f.shares.clone()), &nav, &now);
        fx_feed.set_price(&Asset::Other(eur(&f.env)), &rate, &now);
        nav
    };
    publish(&f, EUR_USD);
    let mut config = fund_config(&f);
    config.oracle = nav_oracle;
    config.source = PriceSource::Cross(FxLeg {
        oracle: fx_oracle,
        asset: Asset::Other(eur(&f.env)),
        haircut_bps: 200,
        max_age_secs: 3 * DAY,
        band_bps: 200,
    });
    let (f, _) = ready_with(f, config);
    let moved = EUR_USD * 10_250 / 10_000;
    advance(&f, DAY);
    publish(&f, moved);
    f.client.refresh_reference(&f.shares);
    assert_eq!(
        f.client.try_quote(&f.shares, &ONE, &f.eurc),
        Err(Ok(Error::PriceOutOfBand))
    );
    let nav = publish(&f, moved);
    f.client.propose_reanchor(&f.shares, &nav, &moved);
    let mut waited = 0;
    while waited < delay {
        let step = DAY.min(delay - waited);
        advance(&f, step);
        waited += step;
        publish(&f, moved);
        f.client.refresh_reference(&f.shares);
    }
    match f.client.try_apply_reanchor(&f.shares) {
        Ok(Ok(())) => {}
        Err(Ok(error)) => return Err(error),
        _ => panic!("unexpected result"),
    }
    assert_eq!(
        f.client.get_fund_state(&f.shares).unwrap().reference_fx,
        moved
    );
    f.client.quote(&f.shares, &ONE, &f.eurc);
    Ok(())
}

/// Review finding VAL-1, cross fund: its FX reference moves only by a
/// re-anchor, so a fund whose rate left the band waits for one. Under a
/// 14-day delay and a NAV accruing 4 % a year, the re-anchor on the new
/// rate was refused by its NAV check (from 11 days on, for this fund); it
/// now applies under any delay, up to the 30-day ceiling.
#[test]
fn a_cross_fund_follows_the_fx_market_under_a_long_delay() {
    assert_eq!(cross_reanchor_after(DEFAULT_TIMELOCK_SECS, 400), Ok(()));
    assert_eq!(cross_reanchor_after(14 * DAY, 0), Ok(()));
    assert_eq!(cross_reanchor_after(11 * DAY, 400), Ok(()));
    assert_eq!(cross_reanchor_after(14 * DAY, 400), Ok(()));
    assert_eq!(cross_reanchor_after(MAX_TIMELOCK_SECS, 400), Ok(()));
}

/// Review finding VAL-2 (20 October 2026): a fund without a fallback whose
/// NAV feed stops publishing after its admission. Eleven days later, the
/// NAV accruing 4 % a year, a new feed reads outside the corridor around the
/// old reference, which counts its growth over at most the NAV age bound
/// with the current settings, and every route that reads the dead feed is
/// refused: a replacement keeping it, a fallback (it needs a fresh
/// primary), a refresh and a re-anchor. The way out, as the comment of
/// `carry_nav_reference` describes it: remove the fund, propose its
/// re-admission on the new feed and a re-anchor read from that proposal,
/// then after one delay apply the re-anchor, then the re-admission.
#[test]
fn a_dead_nav_feed_without_fallback_is_replaced_through_a_removal() {
    let (f, _) = ready();
    let config = fund_config(&f);
    let shares = Asset::Stellar(f.shares.clone());
    advance(&f, 11 * DAY);
    let now = f.env.ledger().timestamp();
    let honest = accruing(NAV_EUR, 400, now);
    let (b, b_feed) = feed_with_decimals(&f, eur(&f.env), NAV_DECIMALS);
    b_feed.set_price(&shares, &honest, &now);

    let next = FundConfig {
        oracle: b.clone(),
        ..config.clone()
    };
    assert_eq!(
        f.client.try_set_fund(&f.shares, &next),
        Err(Ok(Error::PriceOutOfBand))
    );
    // A wider corridor does not help: the check uses the current settings.
    let next_wide = FundConfig {
        corridor_floor_bps: 50,
        ..next.clone()
    };
    assert_eq!(
        f.client.try_set_fund(&f.shares, &next_wide),
        Err(Ok(Error::PriceOutOfBand))
    );
    let wide = FundConfig {
        corridor_floor_bps: 50,
        ..config.clone()
    };
    assert_eq!(
        f.client.try_set_fund(&f.shares, &wide),
        Err(Ok(Error::StalePrice))
    );
    assert_eq!(
        f.client
            .try_propose_fallback(&f.shares, &fallback_feed(&f, &b)),
        Err(Ok(Error::StalePrice))
    );
    assert_eq!(
        f.client.try_refresh_reference(&f.shares),
        Err(Ok(Error::StalePrice))
    );
    assert_eq!(
        f.client.try_propose_reanchor(&f.shares, &honest, &0),
        Err(Ok(Error::StalePrice))
    );

    f.client.remove_fund(&f.shares);
    f.client.set_fund(&f.shares, &next);
    f.client.propose_reanchor(&f.shares, &honest, &0);
    advance(&f, DEFAULT_TIMELOCK_SECS);
    let now = f.env.ledger().timestamp();
    b_feed.set_price(&shares, &accruing(NAV_EUR, 400, now), &now);
    // The re-admission alone still meets the old reference.
    assert_eq!(
        f.client.try_apply_fund_change(&f.shares),
        Err(Ok(Error::PriceOutOfBand))
    );
    f.client.apply_reanchor(&f.shares);
    f.client.apply_fund_change(&f.shares);
    assert_eq!(f.client.get_fund(&f.shares), Some(next));
    f.client.quote(&f.shares, &ONE, &f.eurc);
}

/// Review finding VAL-2: how long a replacement on a new feed stays open
/// after the only feed of a fund died, and what the removal route costs.
/// Under the 48-hour default, a new feed proposed up to eight days after
/// the last move of the reference still applies, and nine days is refused.
/// Thirty days after the feed died, the removal route takes one delay, the
/// re-admission and the re-anchor running side by side; under a 14-day
/// delay too, with the fund's own corridor, since the re-anchor carries the
/// reference to its apply (review finding VAL-1).
#[test]
fn a_dead_feed_is_replaced_within_eight_days_or_through_one_delay() {
    let shares = |f: &Fixture| Asset::Stellar(f.shares.clone());
    let replace_after = |days: u64| -> Result<(), Error> {
        let (f, _) = ready();
        let (b, b_feed) = feed_with_decimals(&f, eur(&f.env), NAV_DECIMALS);
        advance(&f, days * DAY);
        let now = f.env.ledger().timestamp();
        b_feed.set_price(&shares(&f), &accruing(NAV_EUR, 400, now), &now);
        let next = FundConfig {
            oracle: b,
            ..fund_config(&f)
        };
        match f.client.try_set_fund(&f.shares, &next) {
            Ok(Ok(())) => {}
            Err(Ok(error)) => return Err(error),
            _ => panic!("unexpected result"),
        }
        advance(&f, DEFAULT_TIMELOCK_SECS);
        let now = f.env.ledger().timestamp();
        b_feed.set_price(&shares(&f), &accruing(NAV_EUR, 400, now), &now);
        match f.client.try_apply_fund_change(&f.shares) {
            Ok(Ok(())) => {}
            Err(Ok(error)) => return Err(error),
            _ => panic!("unexpected result"),
        }
        f.client.quote(&f.shares, &ONE, &f.eurc);
        Ok(())
    };
    assert_eq!(replace_after(2), Ok(()));
    assert_eq!(replace_after(8), Ok(()));
    assert_eq!(replace_after(9), Err(Error::PriceOutOfBand));

    for delay in [DEFAULT_TIMELOCK_SECS, 14 * DAY] {
        let f = bare();
        f.client.set_timelock_delay(&delay);
        let (f, _) = ready_from(f);
        let (b, b_feed) = feed_with_decimals(&f, eur(&f.env), NAV_DECIMALS);
        advance(&f, 30 * DAY);
        let now = f.env.ledger().timestamp();
        let honest = accruing(NAV_EUR, 400, now);
        b_feed.set_price(&shares(&f), &honest, &now);
        f.client.remove_fund(&f.shares);
        f.client.set_fund(
            &f.shares,
            &FundConfig {
                oracle: b,
                ..fund_config(&f)
            },
        );
        f.client.propose_reanchor(&f.shares, &honest, &0);
        let started = f.env.ledger().timestamp();
        advance(&f, delay);
        let now = f.env.ledger().timestamp();
        b_feed.set_price(&shares(&f), &accruing(NAV_EUR, 400, now), &now);
        f.client.apply_reanchor(&f.shares);
        f.client.apply_fund_change(&f.shares);
        f.client.quote(&f.shares, &ONE, &f.eurc);
        assert_eq!(f.env.ledger().timestamp() - started, delay);
    }
}

/// Re-anchor round, item 1: the signers sign the values. Readings away from
/// them, a rate expected for a directly priced fund, or a value too large
/// for the apply's arithmetic are refused at the proposal.
#[test]
fn reanchor_signers_sign_the_values() {
    let (f, _) = ready();
    // 0.2 % away from the expected NAV, for a 0.1 % floor.
    assert_eq!(
        f.client
            .try_propose_reanchor(&f.shares, &(NAV_EUR * 1_002 / 1_000), &0),
        Err(Ok(Error::PriceOutOfBand))
    );
    assert_eq!(
        f.client.try_propose_reanchor(&f.shares, &NAV_EUR, &EUR_USD),
        Err(Ok(Error::PriceOutOfBand))
    );
    let huge = i128::MAX / 2;
    publish_nav(&f, huge);
    assert_eq!(
        f.client.try_propose_reanchor(&f.shares, &huge, &0),
        Err(Ok(Error::ArithmeticOverflow))
    );
    assert_eq!(f.client.pending_reanchor(&f.shares), None);
}

/// Re-anchor round, item 1, cross price: the expected rate is checked
/// against the leg's band, and the rate is bound to its feed.
#[test]
fn reanchor_of_a_cross_fund_checks_the_expected_rate() {
    let (f, _) = cross_fund();
    let config = f.client.get_fund(&f.shares).unwrap();
    let PriceSource::Cross(leg) = config.source.clone() else {
        panic!("cross fund");
    };
    // 3 % away from the rate, for a band of 2 %.
    assert_eq!(
        f.client
            .try_propose_reanchor(&f.shares, &NAV_USD, &(EUR_USD * 103 / 100)),
        Err(Ok(Error::PriceOutOfBand))
    );
    f.client.propose_reanchor(&f.shares, &NAV_USD, &EUR_USD);
    let pending = f.client.pending_reanchor(&f.shares).unwrap();
    assert_eq!(
        pending.fx,
        AnchorFx::Cross(AnchorRate {
            oracle: leg.oracle,
            asset: leg.asset,
            rate: EUR_USD,
            decimals: NAV_DECIMALS
        })
    );
}

/// Review finding VAL-1, second round (20 October 2026), the FX leg: the
/// rate read at the apply only has to lie in the band around the signed
/// rate; the FX reference installed, and published, is the signed rate,
/// never the apply's. The rate moves 1.5 % between the proposal and the
/// apply, inside the 2 % band; 2.5 % is refused. No earlier test moved the
/// rate between the two, and an apply installing its own rate passed them.
#[test]
fn the_fx_reference_of_a_reanchor_is_the_signed_rate_not_the_rate_at_the_apply() {
    let (f, fx_oracle) = cross_fund();
    let config = f.client.get_fund(&f.shares).unwrap();
    let nav_feed = MockOracleClient::new(&f.env, &config.oracle);
    let fx_feed = MockOracleClient::new(&f.env, &fx_oracle);
    let publish = |rate: i128| {
        let now = f.env.ledger().timestamp();
        nav_feed.set_price(&Asset::Stellar(f.shares.clone()), &NAV_USD, &now);
        fx_feed.set_price(&Asset::Other(eur(&f.env)), &rate, &now);
    };
    let signed = EUR_USD * 10_150 / 10_000;
    publish(signed);
    f.client.propose_reanchor(&f.shares, &NAV_USD, &signed);
    advance(&f, DEFAULT_TIMELOCK_SECS);
    publish(signed * 10_250 / 10_000);
    assert_eq!(
        f.client.try_apply_reanchor(&f.shares),
        Err(Ok(Error::PriceOutOfBand))
    );
    let at_apply = signed * 10_150 / 10_000;
    publish(at_apply);
    f.client.apply_reanchor(&f.shares);
    let now = T0 + DEFAULT_TIMELOCK_SECS;
    assert_eq!(
        own_events(&f),
        std::vec![Reanchored {
            fund: f.shares.clone(),
            nav: NAV_USD,
            nav_time: now,
            fx: signed
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    let state = f.client.get_fund_state(&f.shares).unwrap();
    assert_eq!(state.reference_fx, signed);
    assert_ne!(state.reference_fx, at_apply);
}

/// Re-anchor round, item 2: a re-anchor is bound to the feeds it read. A
/// fund priced by other feeds at the apply refuses it, and the removed
/// fund's re-anchor goes with the re-admission it was read from.
#[test]
fn reanchor_is_bound_to_the_feeds_it_read() {
    let (f, _) = ready();
    f.client.propose_reanchor(&f.shares, &NAV_EUR, &0);
    // Simulate a fund now priced by another NAV feed than the proposal's.
    f.env.as_contract(&f.contract_id, || {
        let key = DataKey::PendingReanchor(f.shares.clone());
        let mut pending: PendingReanchor = f.env.storage().persistent().get(&key).unwrap();
        pending.nav_oracle = Address::generate(&f.env);
        f.env.storage().persistent().set(&key, &pending);
    });
    advance(&f, DEFAULT_TIMELOCK_SECS);
    publish_nav(&f, NAV_EUR);
    assert_eq!(
        f.client.try_apply_reanchor(&f.shares),
        Err(Ok(Error::NotProposed))
    );

    // Removed fund: overwriting or cancelling the re-admission drops the
    // re-anchor read from it.
    f.client.cancel_reanchor(&f.shares, &f.governor);
    f.client.remove_fund(&f.shares);
    f.client.set_fund(&f.shares, &fund_config(&f));
    f.client.propose_reanchor(&f.shares, &NAV_EUR, &0);
    f.client.set_fund(&f.shares, &replacement(&f));
    assert_eq!(f.client.pending_reanchor(&f.shares), None);
    f.client.propose_reanchor(&f.shares, &NAV_EUR, &0);
    f.client.cancel_fund_change(&f.shares, &f.steward);
    assert_eq!(
        own_events(&f),
        std::vec![
            ReanchorCancelled {
                fund: f.shares.clone(),
                by: f.steward.clone()
            }
            .to_xdr(&f.env, &f.contract_id),
            FundChangeCancelled {
                fund: f.shares.clone(),
                by: f.steward.clone()
            }
            .to_xdr(&f.env, &f.contract_id)
        ]
    );
    assert_eq!(f.client.pending_reanchor(&f.shares), None);
}

/// Re-anchor round, item 4: the NAV for a re-anchor follows the pricing
/// rule. A fresh fallback that disagrees blocks it, and a fallback cannot
/// stand in for a stale primary.
#[test]
fn reanchor_reads_the_nav_under_the_pricing_rule() {
    let (f, _, feed) = ready_with_fallback();
    let dropped = NAV_EUR * 98 / 100;
    publish_nav(&f, dropped);
    assert_eq!(
        f.client.try_propose_reanchor(&f.shares, &dropped, &0),
        Err(Ok(Error::PriceDivergence))
    );
    advance(&f, 26 * HOUR + 1);
    publish_on(&f, &feed, NAV_EUR_8 * 98 / 100);
    assert_eq!(
        f.client.try_propose_reanchor(&f.shares, &dropped, &0),
        Err(Ok(Error::StalePrice))
    );
    publish_nav(&f, dropped);
    f.client.propose_reanchor(&f.shares, &dropped, &0);
}

/// Second review, L1: a replacement that gives a directly priced fund its
/// first FX leg anchors it on the rate read at the proposal; the apply only
/// checks today's rate lies within the band of it.
#[test]
fn a_first_fx_leg_is_anchored_at_the_proposal() {
    let (f, _) = ready();
    let usd_oracle = f
        .env
        .register(MockOracle, (Asset::Other(usd(&f.env)), NAV_DECIMALS));
    let nav_feed = MockOracleClient::new(&f.env, &usd_oracle);
    let fx_oracle = f
        .env
        .register(MockOracle, (Asset::Other(usd(&f.env)), NAV_DECIMALS));
    let fx_feed = MockOracleClient::new(&f.env, &fx_oracle);
    let publish = |rate: i128| {
        let now = f.env.ledger().timestamp();
        // A NAV on the fund's current path, so that only the FX is at stake.
        nav_feed.set_price(&Asset::Stellar(f.shares.clone()), &NAV_EUR, &now);
        fx_feed.set_price(&Asset::Other(eur(&f.env)), &rate, &now);
    };
    let mut config = fund_config(&f);
    config.oracle = usd_oracle;
    config.source = PriceSource::Cross(FxLeg {
        oracle: fx_oracle,
        asset: Asset::Other(eur(&f.env)),
        haircut_bps: 200,
        max_age_secs: 3 * DAY,
        band_bps: 200,
    });
    publish(EUR_USD);
    f.client.set_fund(&f.shares, &config);
    assert_eq!(
        f.client.pending_fund_change(&f.shares).unwrap().fx_anchor,
        EUR_USD
    );
    advance(&f, DEFAULT_TIMELOCK_SECS);
    publish(EUR_USD * 97 / 100);
    assert_eq!(
        f.client.try_apply_fund_change(&f.shares),
        Err(Ok(Error::PriceOutOfBand))
    );
    publish(EUR_USD * 99 / 100);
    f.client.apply_fund_change(&f.shares);
    assert_eq!(
        f.client.get_fund_state(&f.shares).unwrap().reference_fx,
        EUR_USD
    );
}

/// Second review, L2: an ordinary guardian change, which the old guardian
/// could veto, settles a forced one still waiting; a hand-over does not.
#[test]
fn an_ordinary_guardian_change_settles_a_forced_one() {
    let (f, _) = ready();
    let forced = Address::generate(&f.env);
    let chosen = Address::generate(&f.env);
    f.client.force_guardian_change(&forced);
    f.client.hand_over_guardian(&Address::generate(&f.env));
    assert!(f.client.pending_forced_guardian_change().is_some());
    f.client.set_guardian(&chosen);
    advance(&f, DEFAULT_TIMELOCK_SECS);
    f.client.apply_guardian_change();
    assert_eq!(
        own_events(&f),
        std::vec![
            ForcedGuardianChangeCancelled {
                guardian: forced,
                by: f.contract_id.clone()
            }
            .to_xdr(&f.env, &f.contract_id),
            GuardianChanged {
                guardian: chosen.clone()
            }
            .to_xdr(&f.env, &f.contract_id)
        ]
    );
    assert_eq!(f.client.pending_forced_guardian_change(), None);
    assert_eq!(f.client.guardian(), chosen);
}

/// Second review, L3: the governor withdraws a handover it proposed.
#[test]
fn governor_cancels_a_proposed_handover() {
    let f = bare();
    let successor = Address::generate(&f.env);
    assert_eq!(f.client.try_cancel_admin(), Err(Ok(Error::NotProposed)));
    f.client.set_admin(&successor);
    let intruder = Address::generate(&f.env);
    f.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "cancel_admin",
            args: ().into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_cancel_admin().is_err());
    f.env.mock_all_auths();
    f.client.cancel_admin();
    assert_eq!(f.env.auths()[0].0, f.governor);
    assert_eq!(
        own_events(&f),
        std::vec![AdminProposalCancelled {
            proposed: successor,
            by: f.governor.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.try_accept_admin(), Err(Ok(Error::Unauthorized)));
    assert_eq!(f.client.admin(), f.governor);
}

/// Second review, L4: an expired cap proposal no longer holds one of the
/// eight slots.
#[test]
fn expired_currency_cap_proposals_free_their_slot() {
    let (f, _) = ready();
    for i in 0..MAX_PENDING_CURRENCY_CAPS {
        let currency = Symbol::new(&f.env, &std::format!("C{i}"));
        f.client.set_currency_cap(&currency, &ONE);
    }
    assert_eq!(
        f.client.try_set_currency_cap(&usd(&f.env), &ONE),
        Err(Ok(Error::LimitReached))
    );
    advance(&f, DEFAULT_TIMELOCK_SECS + PROPOSAL_GRACE_SECS + 1);
    f.client.set_currency_cap(&usd(&f.env), &ONE);
    assert!(f.client.pending_currency_cap_change(&usd(&f.env)).is_some());
}

// ---------------------------------------------------------------------------
// Repurchase
// ---------------------------------------------------------------------------

#[test]
fn repurchase_after_a_weekend_pays_interest_to_the_lender() {
    let (f, offer_id) = ready();
    let repo_id = open(&f, offer_id);
    advance(&f, 64 * HOUR);
    let principal = 10_000 * ONE;
    let expected = math::interest(principal, RATE_BPS, 64 * HOUR).unwrap();
    // 10,000 EUR at 3 % for 64 hours: 2.19 EUR (219 EUR per million),
    // rounded up to the stroop.
    assert_eq!(expected, 21_917_809);
    assert_eq!(f.client.repo_due(&repo_id), expected);
    let lender_before = balance(&f.env, &f.eurc, &f.lender);
    f.client.repurchase(&repo_id);
    assert_eq!(f.env.auths()[0].0, f.borrower);
    // Nothing is pushed to the lender in the borrower's exit path.
    assert_eq!(balance(&f.env, &f.eurc, &f.lender), lender_before);
    assert_eq!(balance(&f.env, &f.shares, &f.borrower), 1_000_000 * ONE);
    assert_eq!(balance(&f.env, &f.shares, &f.contract_id), 0);
    let repo = f.client.get_repo(&repo_id).unwrap();
    assert_eq!(repo.status, RepoStatus::Repurchased);
    // Principal and interest flow back into the offer; the lender withdraws.
    assert_eq!(
        f.client.get_offer(&offer_id).unwrap().available,
        100_000 * ONE + expected
    );
    f.client
        .withdraw_offer(&offer_id, &(100_000 * ONE + expected));
    assert_eq!(
        balance(&f.env, &f.eurc, &f.lender),
        lender_before + 100_000 * ONE + expected
    );
    assert_eq!(f.client.get_fund_state(&f.shares).unwrap().outstanding, 0);
    assert_eq!(f.client.currency_outstanding(&eur(&f.env)), 0);
}

#[test]
fn interest_accrues_per_started_hour() {
    let (f, offer_id) = ready();
    let repo_id = open(&f, offer_id);
    advance(&f, 64 * HOUR + 1);
    assert_eq!(
        f.client.repo_due(&repo_id),
        math::interest(10_000 * ONE, RATE_BPS, 65 * HOUR).unwrap()
    );
    // The amount a borrower signs for holds for the rest of the hour.
    let signed = f.client.repo_due(&repo_id);
    advance(&f, HOUR - 2);
    assert_eq!(f.client.repo_due(&repo_id), signed);
}

#[test]
fn early_repurchase_pays_the_minimum_hour() {
    let (f, offer_id) = ready();
    let repo_id = open(&f, offer_id);
    advance(&f, 60);
    assert_eq!(
        f.client.repo_due(&repo_id),
        math::interest(10_000 * ONE, RATE_BPS, HOUR).unwrap()
    );
}

#[test]
fn interest_keeps_running_after_maturity() {
    let (f, offer_id) = ready();
    let repo_id = open(&f, offer_id);
    advance(&f, 64 * HOUR + DAY);
    assert_eq!(
        f.client.repo_due(&repo_id),
        math::interest(10_000 * ONE, RATE_BPS, 64 * HOUR + DAY).unwrap()
    );
    f.client.repurchase(&repo_id);
}

#[test]
fn repurchase_works_while_paused_and_only_once() {
    let (f, offer_id) = ready();
    let repo_id = open(&f, offer_id);
    f.client.pause(&f.guardian);
    f.client.repurchase(&repo_id);
    assert_eq!(
        f.client.try_repurchase(&repo_id),
        Err(Ok(Error::RepoNotOpen))
    );
    assert_eq!(f.client.try_repurchase(&42), Err(Ok(Error::RepoNotFound)));
}

#[test]
fn intruder_cannot_repurchase() {
    let (f, offer_id) = ready();
    let repo_id = open(&f, offer_id);
    let intruder = Address::generate(&f.env);
    f.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "repurchase",
            args: (repo_id,).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_repurchase(&repo_id).is_err());
}

#[test]
fn terms_are_frozen_at_opening() {
    let (f, offer_id) = ready();
    let repo_id = open(&f, offer_id);
    f.client.set_fund_limits(&f.shares, &5_000, &ONE, &ONE);
    f.client.remove_fund(&f.shares);
    advance(&f, 64 * HOUR);
    f.client.repurchase(&repo_id);
    assert_eq!(
        f.client.get_repo(&repo_id).unwrap().status,
        RepoStatus::Repurchased
    );
    assert_eq!(f.client.currency_outstanding(&eur(&f.env)), 0);
}

// ---------------------------------------------------------------------------
// Seizure
// ---------------------------------------------------------------------------

#[test]
fn seizure_waits_for_maturity_and_goes_to_an_approved_address() {
    let (f, offer_id) = ready();
    let repo_id = open(&f, offer_id);
    assert_eq!(
        f.client.try_seize(&repo_id, &f.lender),
        Err(Ok(Error::NotMatured))
    );
    advance(&f, 64 * HOUR);
    let stranger = Address::generate(&f.env);
    assert_eq!(
        f.client.try_seize(&repo_id, &stranger),
        Err(Ok(Error::LenderNotApproved))
    );
    f.client.pause(&f.guardian);
    f.client.seize(&repo_id, &f.lender);
    assert_eq!(f.env.auths()[0].0, f.lender);
    assert_eq!(balance(&f.env, &f.shares, &f.lender), 10_000 * ONE);
    let repo = f.client.get_repo(&repo_id).unwrap();
    assert_eq!(repo.status, RepoStatus::Defaulted);
    // The principal is lost to the lender: it does not return to the offer.
    assert_eq!(
        f.client.get_offer(&offer_id).unwrap().available,
        90_000 * ONE
    );
    assert_eq!(f.client.currency_outstanding(&eur(&f.env)), 0);
    assert_eq!(
        f.client.try_repurchase(&repo_id),
        Err(Ok(Error::RepoNotOpen))
    );
}

#[test]
fn intruder_cannot_seize() {
    let (f, offer_id) = ready();
    let repo_id = open(&f, offer_id);
    advance(&f, 64 * HOUR);
    let intruder = Address::generate(&f.env);
    f.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "seize",
            args: (repo_id, intruder.clone()).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_seize(&repo_id, &intruder).is_err());
}

/// Review findings auth-1, econ-2 and state-2 (20 October 2026), decision
/// S8: the steward revokes the lender while its repo is open. In rc4 the
/// seizure needed the approval the revocation removed, so a matured repo
/// could not be seized and the borrower kept a free option. The lender of
/// record now seizes: the default settles at once, and the shares wait in
/// the contract, recorded for the lender, until the steward approves it
/// again. Anyone else still needs an approval to receive them.
#[test]
fn a_revoked_lender_still_seizes_and_its_shares_wait_for_an_approval() {
    let (f, offer_id) = ready();
    let repo_id = open(&f, offer_id);
    f.client.approve_lender(&f.shares, &f.lender, &false);
    assert!(!f.client.is_lender_approved(&f.shares, &f.lender));
    advance(&f, 64 * HOUR);
    let stranger = Address::generate(&f.env);
    assert_eq!(
        f.client.try_seize(&repo_id, &stranger),
        Err(Ok(Error::LenderNotApproved))
    );

    f.client.seize(&repo_id, &f.lender);
    assert_eq!(f.env.auths()[0].0, f.lender);
    let shares = 10_000 * ONE;
    assert_eq!(
        own_events(&f),
        std::vec![
            RepoSeized {
                repo_id,
                to: f.lender.clone(),
                shares
            }
            .to_xdr(&f.env, &f.contract_id),
            ReleaseDeferred {
                repo_id,
                to: f.lender.clone(),
                shares
            }
            .to_xdr(&f.env, &f.contract_id)
        ]
    );
    assert_eq!(
        f.client.get_repo(&repo_id).unwrap().status,
        RepoStatus::Defaulted
    );
    assert_eq!(f.client.get_fund_state(&f.shares).unwrap().outstanding, 0);
    assert_eq!(f.client.currency_outstanding(&eur(&f.env)), 0);
    assert_eq!(
        f.client.pending_release(&repo_id),
        Some(PendingRelease {
            fund: f.shares.clone(),
            to: f.lender.clone(),
            shares
        })
    );
    assert_eq!(balance(&f.env, &f.shares, &f.lender), 0);
    assert_eq!(balance(&f.env, &f.shares, &f.contract_id), shares);
    check_invariants(&f, &[offer_id], &[repo_id]);
    assert_eq!(
        f.client.try_repurchase(&repo_id),
        Err(Ok(Error::RepoNotOpen))
    );

    // Anyone may retry; while the lender is not approved, the record stays.
    f.env.set_auths(&[]);
    assert!(!f.client.release(&repo_id));
    assert!(own_events(&f).events().is_empty());
    f.env.mock_all_auths();
    assert!(f.client.pending_release(&repo_id).is_some());
    assert_eq!(balance(&f.env, &f.shares, &f.contract_id), shares);

    // A fresh attestation, signed by the lender and the steward, and a new
    // approval: the release delivers.
    f.client
        .attest_lender(&f.shares, &f.lender, &declaration(&f.env, 0x5E));
    f.client.approve_lender(&f.shares, &f.lender, &true);
    f.env.set_auths(&[]);
    assert!(f.client.release(&repo_id));
    assert_eq!(
        own_events(&f),
        std::vec![SharesReleased {
            repo_id,
            to: f.lender.clone(),
            shares
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    f.env.mock_all_auths();
    assert_eq!(balance(&f.env, &f.shares, &f.lender), shares);
    assert_eq!(f.client.pending_release(&repo_id), None);
    check_invariants(&f, &[offer_id], &[repo_id]);
}

/// The revoked lender of record may send its seized shares to a holder the
/// steward approved instead, and only to one.
#[test]
fn a_revoked_lender_redirects_its_seized_shares_to_an_approved_holder() {
    let (f, offer_id) = ready();
    let repo_id = open(&f, offer_id);
    f.client.approve_lender(&f.shares, &f.lender, &false);
    advance(&f, 64 * HOUR);
    f.client.seize(&repo_id, &f.lender);
    let other = Address::generate(&f.env);
    assert_eq!(
        f.client.try_redirect_release(&repo_id, &other),
        Err(Ok(Error::LenderNotApproved))
    );
    admit_lender(&f.client, &f.env, &f.shares, &other);
    f.client.redirect_release(&repo_id, &other);
    assert_eq!(f.env.auths()[0].0, f.lender);
    f.env.set_auths(&[]);
    assert!(f.client.release(&repo_id));
    f.env.mock_all_auths();
    assert_eq!(balance(&f.env, &f.shares, &other), 10_000 * ONE);
    assert_eq!(f.client.pending_release(&repo_id), None);
    check_invariants(&f, &[offer_id], &[repo_id]);
}

/// The stolen-key variant of finding auth-1: the playbook answers a stolen
/// steward key by removing the fund, after which nobody can approve anyone
/// on it, which made the block final in rc4. The seizure still settles, and
/// the lender sends the shares to a holder approved before the removal.
#[test]
fn a_revoked_lender_seizes_on_a_removed_fund() {
    let (f, offer_id) = ready();
    let other = Address::generate(&f.env);
    admit_lender(&f.client, &f.env, &f.shares, &other);
    let repo_id = open(&f, offer_id);
    f.client.approve_lender(&f.shares, &f.lender, &false);
    f.client.remove_fund(&f.shares);
    advance(&f, 64 * HOUR);

    f.client.seize(&repo_id, &f.lender);
    assert_eq!(
        f.client.get_repo(&repo_id).unwrap().status,
        RepoStatus::Defaulted
    );
    check_invariants(&f, &[offer_id], &[repo_id]);
    assert_eq!(f.client.pending_release(&repo_id).unwrap().to, f.lender);
    assert!(!f.client.release(&repo_id));
    assert_eq!(
        f.client
            .try_attest_lender(&f.shares, &f.lender, &declaration(&f.env, 0x5E)),
        Err(Ok(Error::FundNotAccepted))
    );
    f.client.redirect_release(&repo_id, &other);
    assert!(f.client.release(&repo_id));
    assert_eq!(balance(&f.env, &f.shares, &other), 10_000 * ONE);
    check_invariants(&f, &[offer_id], &[repo_id]);
}

/// Decision S8 keeps the steward out (MMF Regulation, Art. 35): seized
/// shares never go to it, even when it is the lender of record, which a
/// revocation lets the governor and the issuer name steward. A record left
/// for an address that became the steward is not released either, even
/// with an approval granted before version 4.
#[test]
fn seized_shares_never_go_to_the_steward() {
    let (f, offer_id) = ready();
    let deferred = open(&f, offer_id);
    let still_open = open(&f, offer_id);
    advance(&f, 64 * HOUR);
    assert_eq!(
        f.client.try_seize(&deferred, &f.steward),
        Err(Ok(Error::StewardCannotLend))
    );
    f.client.approve_lender(&f.shares, &f.lender, &false);
    f.client.seize(&deferred, &f.lender);
    assert_eq!(f.client.pending_release(&deferred).unwrap().to, f.lender);

    // The revoked lender becomes the steward.
    let mut config = replacement(&f);
    config.steward = f.lender.clone();
    publish_nav(&f, NAV_EUR);
    f.client.set_fund(&f.shares, &config);
    advance(&f, DEFAULT_TIMELOCK_SECS);
    publish_nav(&f, NAV_EUR);
    f.client.apply_fund_change(&f.shares);
    assert_eq!(f.client.get_fund(&f.shares).unwrap().steward, f.lender);
    assert_eq!(
        f.client.try_seize(&still_open, &f.lender),
        Err(Ok(Error::StewardCannotLend))
    );
    assert_eq!(
        f.client.get_repo(&still_open).unwrap().status,
        RepoStatus::Open
    );

    // An approval of the steward granted before version 4.
    f.env.as_contract(&f.contract_id, || {
        f.env
            .storage()
            .persistent()
            .set(&DataKey::Lender(f.shares.clone(), f.lender.clone()), &true);
    });
    assert!(!f.client.release(&deferred));
    assert_eq!(f.client.pending_release(&deferred).unwrap().to, f.lender);
    assert_eq!(balance(&f.env, &f.shares, &f.lender), 0);
}

/// A release refused for want of an approval extends the record and its
/// repo, as a refusal of the token does (review finding L6): a new approval
/// may take months.
#[test]
fn a_release_waiting_for_an_approval_extends_the_record() {
    let (f, offer_id) = ready();
    let repo_id = open(&f, offer_id);
    f.client.approve_lender(&f.shares, &f.lender, &false);
    advance(&f, 64 * HOUR);
    f.client.seize(&repo_id, &f.lender);
    let key = DataKey::PendingRelease(repo_id);
    let repo_key = DataKey::Repo(repo_id);
    age_ledgers(&f);
    assert!(entry_ttl(&f, &key) < BUMP_THRESHOLD_LEDGERS);
    assert!(entry_ttl(&f, &repo_key) < BUMP_THRESHOLD_LEDGERS);
    assert!(!f.client.release(&repo_id));
    assert_eq!(entry_ttl(&f, &key), BUMP_TO_LEDGERS);
    assert_eq!(entry_ttl(&f, &repo_key), BUMP_TO_LEDGERS);
}

// ---------------------------------------------------------------------------
// Invariants and cost
// ---------------------------------------------------------------------------

/// Deterministic pseudo-random generator (64-bit LCG), no dependency.
struct Lcg(u64);

impl Lcg {
    fn next(&mut self, bound: u64) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        (self.0 >> 33) % bound
    }
}

/// I1: stablecoins held cover the offers; I2: shares held equal the open
/// repos plus the shares awaiting release (decision S9); totals equal the sum
/// of open principals.
fn check_invariants(f: &Fixture, offers: &[u64], repos: &[u64]) {
    let available: i128 = offers
        .iter()
        .map(|id| f.client.get_offer(id).unwrap().available)
        .sum();
    assert_eq!(balance(&f.env, &f.eurc, &f.contract_id), available);
    let open: std::vec::Vec<Repo> = repos
        .iter()
        .map(|id| f.client.get_repo(id).unwrap())
        .filter(|r| r.status == RepoStatus::Open)
        .collect();
    let locked: i128 = open.iter().map(|r| r.shares).sum();
    let awaiting: i128 = repos
        .iter()
        .filter_map(|id| f.client.pending_release(id))
        .filter(|p| p.fund == f.shares)
        .map(|p| p.shares)
        .sum();
    assert_eq!(
        balance(&f.env, &f.shares, &f.contract_id),
        locked + awaiting
    );
    let principal: i128 = open.iter().map(|r| r.principal).sum();
    assert_eq!(f.client.currency_outstanding(&eur(&f.env)), principal);
    assert_eq!(
        f.client.get_fund_state(&f.shares).unwrap().outstanding,
        principal
    );
}

#[test]
fn invariants_hold_over_random_sequences() {
    let (f, first_offer) = ready();
    let mut offers = std::vec![first_offer];
    let mut repos: std::vec::Vec<u64> = std::vec::Vec::new();
    let mut rng = Lcg(0x5EED);
    for _ in 0..300 {
        match rng.next(5) {
            0 => {
                let amount = (rng.next(5_000) as i128 + 1) * ONE;
                let id = f.client.create_offer(
                    &f.lender,
                    &f.eurc,
                    &amount,
                    &RATE_BPS,
                    &(7 * DAY),
                    &vec![&f.env, f.shares.clone()],
                );
                offers.push(id);
            }
            1 => {
                let id = offers[rng.next(offers.len() as u64) as usize];
                let available = f.client.get_offer(&id).unwrap().available;
                if available > 0 {
                    let amount = (rng.next(available as u64 / ONE as u64 + 1) as i128).max(1) * ONE;
                    let _ = f.client.try_withdraw_offer(&id, &amount.min(available));
                }
            }
            2 => {
                let id = offers[rng.next(offers.len() as u64) as usize];
                let principal = (rng.next(1_000) as i128 + 1) * ONE;
                if let Ok(Ok(repo_id)) = f.client.try_open_repo(
                    &f.borrower,
                    &id,
                    &f.shares,
                    &(principal * 2),
                    &principal,
                    &(rng.next(6 * DAY) + HOUR),
                ) {
                    repos.push(repo_id);
                }
            }
            3 => {
                if !repos.is_empty() {
                    let id = repos[rng.next(repos.len() as u64) as usize];
                    let _ = f.client.try_repurchase(&id);
                }
            }
            _ => {
                advance(&f, rng.next(2 * DAY));
                publish_nav(
                    &f,
                    f.client.get_fund_state(&f.shares).unwrap().reference_nav,
                );
                if !repos.is_empty() {
                    let id = repos[rng.next(repos.len() as u64) as usize];
                    let _ = f.client.try_seize(&id, &f.lender);
                }
            }
        }
        check_invariants(&f, &offers, &repos);
    }
    assert!(repos.len() > 10, "the sequence must exercise repos");
}

/// I6 and the scalability goal: opening a repo touches the same number of
/// ledger entries whether 1 or 150 repos are open. The footprint is what the
/// network meters: a transaction declares the entries it touches and the host
/// loads only those.
///
/// Instructions are printed, not asserted. The test host keeps the whole
/// ledger in one map and its cost grows with every entry: as a control, a
/// read-only `get_offer`, unrelated to repos, goes from 37,863 to 49,199
/// instructions after 150 repos.
#[test]
fn opening_a_repo_touches_a_constant_number_of_entries() {
    let (f, offer_id) = ready();
    let (read, written) = constant_open_footprint(&f, offer_id, "no fallback");
    // Version 2 read 17 entries and wrote 9. Extending the instance alone
    // (`storage::bump_instance`) no longer reads the code entry: 16. The
    // fallback check costs a fund without fallback nothing. Run from its
    // WASM (WASM test mode), the contract's code entry is read to run it.
    assert_eq!((read, written), (16 + CODE_ENTRY, 9));
}

/// The same with a fallback feed: the footprint grows by the fallback's own
/// entries and stays constant.
#[test]
fn opening_a_repo_with_a_fallback_touches_a_constant_number_of_entries() {
    let (f, offer_id, feed) = ready_with_fallback();
    // The fallback must be fresh, or it is not read beyond its first entry.
    publish_on(&f, &feed, NAV_EUR_8);
    let (read, written) = constant_open_footprint(&f, offer_id, "with a fallback");
    // The fallback's entry and its oracle's instance.
    assert_eq!((read, written), (18 + CODE_ENTRY, 9));
}

/// Opens 152 repos and checks the second and the last touch the same number
/// of entries. Returns that footprint (read, written).
fn constant_open_footprint(f: &Fixture, offer_id: u64, label: &str) -> (u32, u32) {
    let measure = |f: &Fixture| {
        f.client.open_repo(
            &f.borrower,
            &offer_id,
            &f.shares,
            &(20 * ONE),
            &(10 * ONE),
            &DAY,
        );
        f.env.cost_estimate().resources()
    };
    // The first repo creates the contract's share balance entry: warm up.
    measure(f);
    let first = measure(f);
    for _ in 0..150 {
        measure(f);
    }
    let last = measure(f);
    let read = last.disk_read_entries + last.memory_read_entries;
    assert_eq!(read, first.disk_read_entries + first.memory_read_entries);
    assert_eq!(last.write_entries, first.write_entries);
    std::println!(
        "open_repo footprint, {label}: {read} entries read, {} written; \
         instructions {} -> {} (test host)",
        last.write_entries,
        first.instructions,
        last.instructions
    );
    (read, last.write_entries)
}

/// Ledger entries an invocation read and wrote, and its instructions (test
/// host), from the same metering as the test above.
fn footprint(env: &Env) -> (u32, u32, i64) {
    let resources = env.cost_estimate().resources();
    (
        resources.disk_read_entries + resources.memory_read_entries,
        resources.write_entries,
        resources.instructions,
    )
}

/// Load test (roadmap step 1, review gate "avant le testnet public"): 200
/// repos over four offers from two lenders and five borrowers, then all
/// repurchased. Every `open_repo` and every `repurchase` touches the same
/// number of ledger entries, whether it is the first or the last: nothing in
/// the contract walks the open positions. The invariants hold at the peak and
/// at the end.
#[test]
fn many_repos_keep_a_constant_footprint_per_operation() {
    const REPOS: usize = 200;
    let (f, first_offer) = ready();
    let second_lender = Address::generate(&f.env);
    admit_lender(&f.client, &f.env, &f.shares, &second_lender);
    mint(&f.env, &f.eurc, &second_lender, 1_000_000 * ONE);
    let mut offers = std::vec![first_offer];
    for (lender, rate_bps) in [
        (&f.lender, 250),
        (&second_lender, 300),
        (&second_lender, 400),
    ] {
        offers.push(f.client.create_offer(
            lender,
            &f.eurc,
            &(100_000 * ONE),
            &rate_bps,
            &(7 * DAY),
            &vec![&f.env, f.shares.clone()],
        ));
    }
    let borrowers: std::vec::Vec<Address> = (0..5)
        .map(|_| {
            let borrower = Address::generate(&f.env);
            mint(&f.env, &f.shares, &borrower, 1_000 * ONE);
            mint(&f.env, &f.eurc, &borrower, 1_000 * ONE);
            borrower
        })
        .collect();

    // Five borrowers and four offers: the 200 repos cover every pair.
    let mut repos = std::vec::Vec::with_capacity(REPOS);
    let mut opens = std::vec::Vec::with_capacity(REPOS);
    for i in 0..REPOS {
        repos.push(f.client.open_repo(
            &borrowers[i % borrowers.len()],
            &offers[i % offers.len()],
            &f.shares,
            &(20 * ONE),
            &(10 * ONE),
            &DAY,
        ));
        opens.push(footprint(&f.env));
    }
    check_invariants(&f, &offers, &repos);
    assert_eq!(
        f.client.currency_outstanding(&eur(&f.env)),
        REPOS as i128 * 10 * ONE
    );

    advance(&f, HOUR);
    let mut repurchases = std::vec::Vec::with_capacity(REPOS);
    for repo_id in &repos {
        f.client.repurchase(repo_id);
        repurchases.push(footprint(&f.env));
    }
    check_invariants(&f, &offers, &repos);
    assert_eq!(f.client.currency_outstanding(&eur(&f.env)), 0);
    assert_eq!(balance(&f.env, &f.shares, &f.contract_id), 0);

    // The very first repo creates the contract's share balance entry; from
    // the second on, the footprint must not move.
    let entries = |m: &(u32, u32, i64)| (m.0, m.1);
    let first_open = opens[1];
    let last_open = opens[REPOS - 1];
    for (i, measured) in opens.iter().enumerate().skip(1) {
        assert_eq!(
            entries(measured),
            entries(&first_open),
            "open_repo #{}",
            i + 1
        );
    }
    let first_repurchase = repurchases[0];
    let last_repurchase = repurchases[REPOS - 1];
    for (i, measured) in repurchases.iter().enumerate() {
        assert_eq!(
            entries(measured),
            entries(&first_repurchase),
            "repurchase #{}",
            i + 1
        );
    }
    std::println!(
        "load test, {} repos: open_repo {} entries read, {} written (2nd and last); \
         instructions {} -> {} (test host)",
        REPOS,
        last_open.0,
        last_open.1,
        first_open.2,
        last_open.2
    );
    std::println!(
        "load test, {} repos: repurchase {} entries read, {} written (first and last); \
         instructions {} -> {} (test host)",
        REPOS,
        last_repurchase.0,
        last_repurchase.1,
        first_repurchase.2,
        last_repurchase.2
    );
}

// ---------------------------------------------------------------------------
// Upgrade to the WASM built by `stellar contract build`
// ---------------------------------------------------------------------------

#[cfg(not(night_window_wasm))]
compile_error!(
    "the upgrade test needs target/wasm32v1-none/release/night_window.wasm: \
     run `stellar contract build` before `cargo test` or `cargo clippy --all-targets` \
     (see contracts/night-window/build.rs)"
);

/// The release WASM produced by `stellar contract build`, located by build.rs.
#[cfg(night_window_wasm)]
const NIGHT_WINDOW_WASM: &[u8] = include_bytes!(env!("NIGHT_WINDOW_WASM"));

/// The WASM hash the ledger holds as `contract`'s executable, read from its
/// instance entry. A natively compiled test contract has a pseudo hash here.
#[cfg(night_window_wasm)]
fn executable_hash(env: &Env, contract: &Address) -> Option<[u8; 32]> {
    use soroban_sdk::xdr::{
        ContractExecutable as XdrExecutable, LedgerEntryData, ScAddress, ScVal,
    };
    let address = ScAddress::from(contract);
    env.to_ledger_snapshot()
        .ledger_entries
        .iter()
        .find_map(|(_, (entry, _))| match &entry.data {
            LedgerEntryData::ContractData(data)
                if data.contract == address && data.key == ScVal::LedgerKeyContractInstance =>
            {
                match &data.val {
                    ScVal::ContractInstance(instance) => match &instance.executable {
                        XdrExecutable::Wasm(hash) => Some(hash.0),
                        _ => None,
                    },
                    _ => None,
                }
            }
            _ => None,
        })
}

/// Everything the upgrade must keep, read through the public interface.
#[cfg(night_window_wasm)]
#[derive(Debug, PartialEq)]
struct Snapshot {
    admin: Address,
    guardian: Address,
    paused: bool,
    max_term: u64,
    timelock_delay: u64,
    envelope: RiskEnvelope,
    stablecoin: Option<StablecoinConfig>,
    currency_cap: i128,
    currency_outstanding: i128,
    fund: Option<FundConfig>,
    fund_state: Option<FundState>,
    lender_approved: bool,
    offers: std::vec::Vec<Option<Offer>>,
    repos: std::vec::Vec<Option<Repo>>,
    stablecoins_held: i128,
    shares_held: i128,
}

#[cfg(night_window_wasm)]
fn snapshot(f: &Fixture, offers: &[u64], repos: &[u64]) -> Snapshot {
    Snapshot {
        admin: f.client.admin(),
        guardian: f.client.guardian(),
        paused: f.client.is_paused(),
        max_term: f.client.max_term(),
        timelock_delay: f.client.timelock_delay(),
        envelope: f.client.envelope(),
        stablecoin: f.client.get_stablecoin(&f.eurc),
        currency_cap: f.client.currency_cap(&eur(&f.env)),
        currency_outstanding: f.client.currency_outstanding(&eur(&f.env)),
        fund: f.client.get_fund(&f.shares),
        fund_state: f.client.get_fund_state(&f.shares),
        lender_approved: f.client.is_lender_approved(&f.shares, &f.lender),
        offers: offers.iter().map(|id| f.client.get_offer(id)).collect(),
        repos: repos.iter().map(|id| f.client.get_repo(id)).collect(),
        stablecoins_held: balance(&f.env, &f.eurc, &f.contract_id),
        shares_held: balance(&f.env, &f.shares, &f.contract_id),
    }
}

/// Roadmap step 1 and review gate "avant le testnet public": the nominal
/// upgrade path with a really uploaded WASM. The contract starts as the
/// natively compiled code, holds offers, open repos and a closed one, a
/// separate guardian, a changed term ceiling and the pause flag; the governor
/// proposes the release WASM, waits for the time delay (S7), then switches
/// the contract to it. Every value survives, and the WASM, now
/// running in the VM, still serves the open repos, opens new ones and refuses
/// an intruder's upgrade. In the WASM test mode the contract already runs
/// the release WASM, and the same path installs the same code.
#[cfg(night_window_wasm)]
#[test]
fn upgrade_to_the_built_wasm_keeps_offers_repos_and_roles() {
    let (f, first_offer) = ready();
    let second_offer = f.client.create_offer(
        &f.lender,
        &f.eurc,
        &(50_000 * ONE),
        &500,
        &(3 * DAY),
        &vec![&f.env, f.shares.clone()],
    );
    f.client.set_sponsor(&second_offer, &f.shares, &true);
    let long_repo = open(&f, first_offer);
    let short_repo = f.client.open_repo(
        &f.borrower,
        &second_offer,
        &f.shares,
        &(4_000 * ONE),
        &(3_000 * ONE),
        &(2 * DAY),
    );
    let closed_repo = open(&f, first_offer);
    advance(&f, HOUR);
    f.client.repurchase(&closed_repo);
    let guardian = appoint_guardian(&f);
    f.client.set_max_term(&(5 * DAY));
    f.client.pause(&guardian);

    let offers = [first_offer, second_offer];
    let repos = [long_repo, short_repo, closed_repo];

    // Decision S7: the upgrade is proposed, waits for its delay, and only
    // then can the governor apply it.
    let hash = f.env.deployer().upload_contract_wasm(NIGHT_WINDOW_WASM);
    let initial = executable_hash(&f.env, &f.contract_id);
    assert!(initial.is_some());
    if cfg!(night_window_test_wasm) {
        assert_eq!(initial, Some(hash.to_array()));
    } else {
        // A natively compiled contract has a pseudo hash.
        assert_ne!(initial, Some(hash.to_array()));
    }
    f.client.propose_upgrade(&hash);
    assert_eq!(f.env.auths()[0].0, f.governor);
    assert_eq!(
        f.client.try_upgrade(&hash),
        Err(Ok(raised(Error::TimelockPending)))
    );
    advance(&f, DEFAULT_TIMELOCK_SECS);
    assert_eq!(executable_hash(&f.env, &f.contract_id), initial);
    // The NAV feed kept publishing during the delay.
    publish_nav(&f, NAV_EUR);

    let before = snapshot(&f, &offers, &repos);
    assert!(before.paused);
    assert_eq!(
        before.repos[2].as_ref().unwrap().status,
        RepoStatus::Repurchased
    );
    f.client.upgrade(&hash);
    assert_eq!(f.env.auths()[0].0, f.governor);
    assert_eq!(
        own_events(&f),
        std::vec![Upgraded {
            wasm_hash: hash.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(
        executable_hash(&f.env, &f.contract_id),
        Some(hash.to_array())
    );

    // From here on, every call runs the uploaded WASM in the VM.
    assert_eq!(snapshot(&f, &offers, &repos), before);
    assert_eq!(f.client.version(), 4);
    assert_eq!(f.client.pending_upgrade(), None);
    check_invariants(&f, &offers, &repos);

    // The pause survived: entries stay closed, exits stay open.
    assert_eq!(
        f.client.try_open_repo(
            &f.borrower,
            &first_offer,
            &f.shares,
            &(20 * ONE),
            &(10 * ONE),
            &DAY
        ),
        Err(Ok(Error::Paused))
    );
    advance(&f, HOUR);
    let due = f.client.repo_due(&long_repo);
    f.client.repurchase(&long_repo);
    assert_eq!(f.env.auths()[0].0, f.borrower);
    assert_eq!(
        f.client.get_offer(&first_offer).unwrap().available,
        before.offers[0].as_ref().unwrap().available + 10_000 * ONE + due
    );

    // The governor lifts the pause and a new repo opens on the old offer.
    f.client.unpause();
    assert_eq!(f.env.auths()[0].0, f.governor);
    let new_repo = f.client.open_repo(
        &f.borrower,
        &first_offer,
        &f.shares,
        &(2_000 * ONE),
        &(1_000 * ONE),
        &DAY,
    );
    assert_eq!(new_repo, closed_repo + 1);
    let all_repos = [long_repo, short_repo, closed_repo, new_repo];
    check_invariants(&f, &offers, &all_repos);
    f.client.repurchase(&short_repo);
    f.client.repurchase(&new_repo);
    check_invariants(&f, &offers, &all_repos);
    assert_eq!(f.client.currency_outstanding(&eur(&f.env)), 0);

    // The upgraded contract still refuses an intruder's upgrade, even one
    // whose delay has elapsed.
    f.client.propose_upgrade(&hash);
    advance(&f, DEFAULT_TIMELOCK_SECS);
    let intruder = Address::generate(&f.env);
    let other = soroban_sdk::BytesN::from_array(&f.env, &[7u8; 32]);
    f.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "upgrade",
            args: (hash.clone(),).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_upgrade(&hash).is_err());
    assert!(f.client.try_upgrade(&other).is_err());
    assert_eq!(
        executable_hash(&f.env, &f.contract_id),
        Some(hash.to_array())
    );
}

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

#[test]
fn arithmetic_rounds_in_favour_of_the_lender() {
    // One stroop of interest is still charged.
    assert_eq!(math::interest(1, 1, 1).unwrap(), 1);
    assert_eq!(math::interest(0, RATE_BPS, DAY).unwrap(), 0);
    let price = math::Price::new(NAV_EUR, NAV_DECIMALS).unwrap();
    let haircut = math::Bps::haircut(200).unwrap();
    // 1 stroop of share is worth 1.05 stroop, floored to 1, then 0.98 after
    // the haircut, floored to 0: dust secures nothing.
    assert_eq!(math::max_principal(1, 7, price, 7, haircut).unwrap(), 0);
    // Decimals conversion: 6-decimal stablecoin.
    assert_eq!(
        math::max_principal(10 * ONE, 7, price, 6, haircut).unwrap(),
        10_290_000
    );
    assert_eq!(math::Price::new(0, 7), Err(Error::InvalidPrice));
    assert_eq!(math::Bps::haircut(10_000), Err(Error::InvalidHaircut));
}

#[test]
fn arithmetic_overflow_is_a_typed_error() {
    let price = math::Price::new(i128::MAX / 2, 0).unwrap();
    let haircut = math::Bps::haircut(0).unwrap();
    assert_eq!(
        math::max_principal(i128::MAX / 2, 7, price, 7, haircut),
        Err(Error::ArithmeticOverflow)
    );
    assert_eq!(
        math::interest(i128::MAX, 10_000, u64::MAX),
        Err(Error::ArithmeticOverflow)
    );
}

#[test]
fn corridor_bounds() {
    let year = 31_536_000;
    let (low, high) = math::corridor(1_000_000, 0, 0, 10, 500, 26 * HOUR).unwrap();
    assert_eq!((low, high), (999_000, 1_001_000));
    // A year later the top grows by the maximum yield over a year-long
    // window...
    let (_, high) = math::corridor(1_000_000, 0, year, 10, 500, year).unwrap();
    assert_eq!(high, 1_051_000);
    // ...and over a tenth of a year when that is the window: a year-old
    // reference grants no more growth than one window.
    let (_, high) = math::corridor(1_000_000, 0, year, 10, 500, year / 10).unwrap();
    assert_eq!(high, 1_006_000);
    assert_eq!(
        math::model_path(1_000_000, 0, year, 500, year / 10),
        Ok(1_005_000)
    );
}

/// Review finding arith-4 (20 October 2026): the bounds rounded outward, by
/// up to one unit of the feed. With 2 decimals and a 0.5 % floor the
/// corridor was [0.99, 1.01]; it is now [1.00, 1.00]: inward, the reference
/// still passing. A 2-decimal rate of 1.12 with a 1.5 % band admitted
/// [1.10, 1.14], 1.79 % either way; now [1.11, 1.13]. At 6 decimals the
/// bounds are exact.
#[test]
fn bounds_round_inward() {
    assert_eq!(math::corridor(100, 0, DAY, 50, 0, DAY), Ok((100, 100)));
    for (value, inside) in [(99, false), (100, true), (101, false)] {
        assert_eq!(math::within_band(value, 100, 50), Ok(inside));
    }
    for (value, inside) in [(110, false), (111, true), (113, true), (114, false)] {
        assert_eq!(math::within_band(value, 112, 150), Ok(inside));
    }
    assert_eq!(
        math::corridor(1_000_000, 0, DAY, 50, 0, DAY),
        Ok((995_000, 1_005_000))
    );
}

// ---------------------------------------------------------------------------
// Integration with the demo contracts: the allowlisted share token and the
// operator-fed SEP-40 feed, compiled natively.
// ---------------------------------------------------------------------------

mod integration {
    use super::*;
    use fund_token::{FundToken, FundTokenClient};
    use nav_oracle::{Asset as FeedAsset, NavOracle, NavOracleClient};
    use soroban_sdk::String;

    struct Live {
        f: Fixture,
        token: FundTokenClient<'static>,
        offer_id: u64,
    }

    /// Open Window with a permissioned share token whose NAV is published in
    /// USD and crossed through a second feed publishing EUR in USD.
    fn live(whitelist_contract: bool) -> Live {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(T0);
        let governor = Address::generate(&env);
        let steward = Address::generate(&env);
        let lender = Address::generate(&env);
        let borrower = Address::generate(&env);
        let contract_id = register_open_window(&env, &governor);
        let client = OpenWindowClient::new(leak(env.clone()), leak(contract_id.clone()));

        let shares = env.register(
            FundToken,
            (
                steward.clone(),
                7u32,
                String::from_str(&env, "Test EU T-bill fund share"),
                String::from_str(&env, "tEUTBL"),
            ),
        );
        let token = FundTokenClient::new(leak(env.clone()), leak(shares.clone()));
        for holder in [&borrower, &lender] {
            token.set_whitelisted(holder, &true);
        }
        if whitelist_contract {
            token.set_whitelisted(&contract_id, &true);
        }
        token.mint(&borrower, &(100_000 * ONE));

        let usd = FeedAsset::Other(Symbol::new(&env, "USD"));
        let nav_feed = env.register(
            NavOracle,
            (steward.clone(), usd.clone(), NAV_DECIMALS, 300u32),
        );
        NavOracleClient::new(&env, &nav_feed).publish(
            &FeedAsset::Stellar(shares.clone()),
            &NAV_USD,
            &T0,
        );
        let fx_feed = env.register(NavOracle, (steward.clone(), usd, NAV_DECIMALS, 300u32));
        NavOracleClient::new(&env, &fx_feed).publish(
            &FeedAsset::Other(Symbol::new(&env, "EUR")),
            &EUR_USD,
            &T0,
        );

        let eurc = new_token(&env);
        client.set_stablecoin(&eurc, &eur(&env));
        client.set_currency_cap(&eur(&env), &(10_000_000 * ONE));
        client.set_fund(
            &shares,
            &FundConfig {
                oracle: nav_feed.clone(),
                oracle_asset: Asset::Stellar(shares.clone()),
                haircut_bps: 200,
                steward: steward.clone(),
                currency: eur(&env),
                source: PriceSource::Cross(FxLeg {
                    oracle: fx_feed,
                    asset: Asset::Other(eur(&env)),
                    haircut_bps: 200,
                    max_age_secs: 3 * DAY,
                    band_bps: 200,
                }),
                nav_max_age_secs: 26 * HOUR,
                corridor_floor_bps: 10,
                max_yield_bps: 500,
                max_principal_per_repo: 500_000 * ONE,
                max_outstanding: 5_000_000 * ONE,
            },
        );
        admit_lender(&client, &env, &shares, &lender);
        mint(&env, &eurc, &lender, 100_000 * ONE);
        mint(&env, &eurc, &borrower, 1_000 * ONE);
        let offer_id = client.create_offer(
            &lender,
            &eurc,
            &(100_000 * ONE),
            &RATE_BPS,
            &(7 * DAY),
            &vec![&env, shares.clone()],
        );
        let oracle = MockOracleClient::new(leak(env.clone()), leak(nav_feed.clone()));
        Live {
            f: Fixture {
                env,
                contract_id,
                client,
                governor: governor.clone(),
                guardian: governor,
                steward,
                lender,
                borrower,
                shares,
                eurc,
                nav_oracle: nav_feed,
                oracle,
            },
            token,
            offer_id,
        }
    }

    #[test]
    fn full_cycle_with_the_permissioned_share_token_and_live_feeds() {
        let live = live(true);
        let f = &live.f;
        let quote = f.client.quote(&f.shares, &(10_000 * ONE), &f.eurc);
        assert_eq!(quote.haircut_bps, 400);
        let repo_id = f.client.open_repo(
            &f.borrower,
            &live.offer_id,
            &f.shares,
            &(10_000 * ONE),
            &(10_000 * ONE),
            &(64 * HOUR),
        );
        assert_eq!(live.token.balance(&f.contract_id), 10_000 * ONE);
        advance(f, 64 * HOUR);
        f.client.repurchase(&repo_id);
        assert_eq!(live.token.balance(&f.borrower), 100_000 * ONE);
        assert_eq!(live.token.balance(&f.contract_id), 0);
    }

    #[test]
    fn seizure_delivers_permissioned_shares_to_the_whitelisted_lender() {
        let live = live(true);
        let f = &live.f;
        let repo_id = f.client.open_repo(
            &f.borrower,
            &live.offer_id,
            &f.shares,
            &(10_000 * ONE),
            &(10_000 * ONE),
            &(2 * HOUR),
        );
        advance(f, 2 * HOUR);
        f.client.seize(&repo_id, &f.lender);
        assert_eq!(live.token.balance(&f.lender), 10_000 * ONE);
    }

    #[test]
    fn issuer_must_whitelist_the_contract_before_any_repo() {
        let live = live(false);
        let f = &live.f;
        assert!(f
            .client
            .try_open_repo(
                &f.borrower,
                &live.offer_id,
                &f.shares,
                &(10_000 * ONE),
                &(10_000 * ONE),
                &DAY,
            )
            .is_err());
        // Nothing moved: the whole transaction reverted.
        assert_eq!(live.token.balance(&f.borrower), 100_000 * ONE);
        assert_eq!(
            f.client.get_offer(&live.offer_id).unwrap().available,
            100_000 * ONE
        );
    }

    // -- Decision S9 (version 1.1): issuer freeze, allowlist removal or
    // clawback while a repo is open. The debt still settles; the shares wait
    // as a pending release that anyone can retry.

    const SHARES: i128 = 10_000 * ONE;

    fn open_live(live: &Live, term: u64) -> u64 {
        let f = &live.f;
        f.client.open_repo(
            &f.borrower,
            &live.offer_id,
            &f.shares,
            &SHARES,
            &(10_000 * ONE),
            &term,
        )
    }

    /// Checks the debt side settled, the shares stayed in the contract and
    /// are recorded for `to`, and `release` reports a refusal while the token
    /// still refuses, keeping the record.
    fn assert_deferred(live: &Live, repo_id: u64, to: &Address) {
        let f = &live.f;
        assert_eq!(
            f.client.pending_release(&repo_id),
            Some(PendingRelease {
                fund: f.shares.clone(),
                to: to.clone(),
                shares: SHARES
            })
        );
        assert_eq!(f.client.get_fund_state(&f.shares).unwrap().outstanding, 0);
        assert_eq!(f.client.currency_outstanding(&eur(&f.env)), 0);
        f.env.set_auths(&[]);
        assert!(!f.client.release(&repo_id));
        f.env.mock_all_auths();
        assert!(f.client.pending_release(&repo_id).is_some());
    }

    /// Review finding L6: a record may wait months for the issuer; each
    /// refused attempt extends its TTL.
    #[test]
    fn a_refused_release_extends_the_record() {
        let live = live(true);
        let f = &live.f;
        let repo_id = open_live(&live, DAY);
        live.token.set_frozen(&f.contract_id, &true);
        f.client.repurchase(&repo_id);
        let key = DataKey::PendingRelease(repo_id);
        let repo_key = DataKey::Repo(repo_id);
        age_ledgers(f);
        assert!(entry_ttl(f, &key) < BUMP_THRESHOLD_LEDGERS);
        assert!(entry_ttl(f, &repo_key) < BUMP_THRESHOLD_LEDGERS);
        assert!(!f.client.release(&repo_id));
        assert_eq!(entry_ttl(f, &key), BUMP_TO_LEDGERS);
        // Second review, L5: the repo, which `redirect_release` reads, too.
        assert_eq!(entry_ttl(f, &repo_key), BUMP_TO_LEDGERS);
    }

    /// Anyone retries the release once the token accepts again.
    fn assert_released(live: &Live, repo_id: u64, to: &Address, before: i128) {
        let f = &live.f;
        f.env.set_auths(&[]);
        assert!(f.client.release(&repo_id));
        assert!(f.env.auths().is_empty());
        assert_eq!(
            own_events(f),
            std::vec![SharesReleased {
                repo_id,
                to: to.clone(),
                shares: SHARES
            }
            .to_xdr(&f.env, &f.contract_id)]
        );
        f.env.mock_all_auths();
        assert_eq!(live.token.balance(to), before + SHARES);
        assert_eq!(f.client.pending_release(&repo_id), None);
        assert_eq!(
            f.client.try_release(&repo_id),
            Err(Ok(Error::NothingToRelease))
        );
    }

    #[test]
    fn issuer_freeze_defers_the_shares_and_the_borrower_still_repays() {
        let live = live(true);
        let f = &live.f;
        let repo_id = open_live(&live, DAY);
        advance(f, HOUR);
        live.token.set_frozen(&f.contract_id, &true);
        let interest = f.client.repo_due(&repo_id);
        let borrower_shares = live.token.balance(&f.borrower);
        f.client.repurchase(&repo_id);
        assert_eq!(
            own_events(f),
            std::vec![
                RepoRepurchased {
                    repo_id,
                    principal: 10_000 * ONE,
                    interest
                }
                .to_xdr(&f.env, &f.contract_id),
                ReleaseDeferred {
                    repo_id,
                    to: f.borrower.clone(),
                    shares: SHARES
                }
                .to_xdr(&f.env, &f.contract_id)
            ]
        );
        // The lender is paid; interest stops; the shares stay attributed to
        // the borrower.
        assert_eq!(
            f.client.get_repo(&repo_id).unwrap().status,
            RepoStatus::Repurchased
        );
        assert_eq!(
            f.client.get_offer(&live.offer_id).unwrap().available,
            100_000 * ONE + interest
        );
        assert_eq!(live.token.balance(&f.contract_id), SHARES);
        assert_deferred(&live, repo_id, &f.borrower);
        check_invariants(f, &[live.offer_id], &[repo_id]);
        assert_eq!(
            f.client.try_repurchase(&repo_id),
            Err(Ok(Error::RepoNotOpen))
        );

        live.token.set_frozen(&f.contract_id, &false);
        assert_released(&live, repo_id, &f.borrower, borrower_shares);
        assert_eq!(live.token.balance(&f.contract_id), 0);
        check_invariants(f, &[live.offer_id], &[repo_id]);
    }

    #[test]
    fn seizure_of_frozen_shares_waits_for_the_release() {
        let live = live(true);
        let f = &live.f;
        let repo_id = open_live(&live, 2 * HOUR);
        advance(f, 2 * HOUR);
        live.token.set_frozen(&f.contract_id, &true);
        f.client.seize(&repo_id, &f.lender);
        assert_eq!(
            own_events(f),
            std::vec![
                RepoSeized {
                    repo_id,
                    to: f.lender.clone(),
                    shares: SHARES
                }
                .to_xdr(&f.env, &f.contract_id),
                ReleaseDeferred {
                    repo_id,
                    to: f.lender.clone(),
                    shares: SHARES
                }
                .to_xdr(&f.env, &f.contract_id)
            ]
        );
        assert_eq!(
            f.client.get_repo(&repo_id).unwrap().status,
            RepoStatus::Defaulted
        );
        assert_deferred(&live, repo_id, &f.lender);
        live.token.set_frozen(&f.contract_id, &false);
        assert_released(&live, repo_id, &f.lender, 0);
    }

    #[test]
    fn borrower_removed_from_the_allowlist_still_repays() {
        let live = live(true);
        let f = &live.f;
        let repo_id = open_live(&live, DAY);
        live.token.set_whitelisted(&f.borrower, &false);
        let borrower_shares = live.token.balance(&f.borrower);
        f.client.repurchase(&repo_id);
        assert_deferred(&live, repo_id, &f.borrower);
        // A frozen recipient blocks the release the same way.
        live.token.set_whitelisted(&f.borrower, &true);
        live.token.set_frozen(&f.borrower, &true);
        assert_deferred(&live, repo_id, &f.borrower);
        live.token.set_frozen(&f.borrower, &false);
        assert_released(&live, repo_id, &f.borrower, borrower_shares);
    }

    #[test]
    fn clawback_leaving_too_few_shares_defers_the_release() {
        let live = live(true);
        let f = &live.f;
        let repo_id = open_live(&live, DAY);
        live.token.clawback(&f.contract_id, &(SHARES / 2));
        let borrower_shares = live.token.balance(&f.borrower);
        f.client.repurchase(&repo_id);
        assert_deferred(&live, repo_id, &f.borrower);
        // The issuer restores the shares it took; the release goes through.
        live.token.mint(&f.contract_id, &(SHARES / 2));
        assert_released(&live, repo_id, &f.borrower, borrower_shares);
    }

    #[test]
    fn a_failed_repayment_still_reverts_the_whole_repurchase() {
        let live = live(true);
        let f = &live.f;
        let repo_id = open_live(&live, DAY);
        live.token.set_frozen(&f.contract_id, &true);
        // The borrower spends the stablecoins: the repayment cannot be pulled.
        let spent = balance(&f.env, &f.eurc, &f.borrower);
        let elsewhere = Address::generate(&f.env);
        TokenClient::new(&f.env, &f.eurc).transfer(&f.borrower, &elsewhere, &spent);
        assert!(f.client.try_repurchase(&repo_id).is_err());
        assert_eq!(
            f.client.get_repo(&repo_id).unwrap().status,
            RepoStatus::Open
        );
        assert_eq!(f.client.pending_release(&repo_id), None);
        assert_eq!(
            f.client.get_fund_state(&f.shares).unwrap().outstanding,
            10_000 * ONE
        );
    }

    /// Review finding L8: after a repurchase, the borrower may send its
    /// deferred shares to another address; nobody else can.
    #[test]
    fn borrower_redirects_a_deferred_release() {
        let live = live(true);
        let f = &live.f;
        let repo_id = open_live(&live, DAY);
        live.token.set_whitelisted(&f.borrower, &false);
        f.client.repurchase(&repo_id);
        let custodian = Address::generate(&f.env);
        live.token.set_whitelisted(&custodian, &true);
        f.env.mock_auths(&[MockAuth {
            address: &f.lender,
            invoke: &MockAuthInvoke {
                contract: &f.contract_id,
                fn_name: "redirect_release",
                args: (repo_id, custodian.clone()).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        assert!(f.client.try_redirect_release(&repo_id, &custodian).is_err());
        f.env.mock_all_auths();
        // Second review, L6: never to the contract itself, which would keep
        // the shares while dropping the record.
        assert_eq!(
            f.client.try_redirect_release(&repo_id, &f.contract_id),
            Err(Ok(Error::TransferMismatch))
        );
        f.client.redirect_release(&repo_id, &custodian);
        assert_eq!(f.env.auths()[0].0, f.borrower);
        assert_eq!(
            own_events(f),
            std::vec![ReleaseRedirected {
                repo_id,
                to: custodian.clone()
            }
            .to_xdr(&f.env, &f.contract_id)]
        );
        assert_released(&live, repo_id, &custodian, 0);
    }

    /// Review finding L8: after a seizure, the lender may redirect its
    /// deferred shares, but only to an address the steward approved.
    #[test]
    fn lender_redirects_a_seized_release_to_an_approved_lender() {
        let live = live(true);
        let f = &live.f;
        let repo_id = open_live(&live, 2 * HOUR);
        advance(f, 2 * HOUR);
        live.token.set_whitelisted(&f.lender, &false);
        f.client.seize(&repo_id, &f.lender);
        assert_deferred(&live, repo_id, &f.lender);
        let other = Address::generate(&f.env);
        live.token.set_whitelisted(&other, &true);
        assert_eq!(
            f.client.try_redirect_release(&repo_id, &other),
            Err(Ok(Error::LenderNotApproved))
        );
        admit_lender(&f.client, &f.env, &f.shares, &other);
        f.client.redirect_release(&repo_id, &other);
        assert_eq!(f.env.auths()[0].0, f.lender);
        assert_released(&live, repo_id, &other, 0);
    }

    /// Storage: redirecting seized shares reads the new recipient's
    /// approval and extends it.
    #[test]
    fn redirecting_seized_shares_extends_the_approval_it_reads() {
        let live = live(true);
        let f = &live.f;
        let repo_id = open_live(&live, 2 * HOUR);
        advance(f, 2 * HOUR);
        live.token.set_whitelisted(&f.lender, &false);
        f.client.seize(&repo_id, &f.lender);
        let other = Address::generate(&f.env);
        admit_lender(&f.client, &f.env, &f.shares, &other);
        let key = DataKey::Lender(f.shares.clone(), other.clone());
        age_ledgers(f);
        assert!(entry_ttl(f, &key) < BUMP_THRESHOLD_LEDGERS);
        f.client.redirect_release(&repo_id, &other);
        assert_eq!(entry_ttl(f, &key), BUMP_TO_LEDGERS);
    }

    #[test]
    fn release_of_an_unknown_repo_is_refused() {
        let live = live(true);
        assert_eq!(
            live.f.client.try_release(&42),
            Err(Ok(Error::NothingToRelease))
        );
    }

    /// Review finding arith-5 (20 October 2026): with 18-decimal shares and
    /// an 18-decimal NAV feed, `shares x price` overflowed i128 above about
    /// 162 shares, so quote and open_repo failed for any real position. The
    /// product is now split: 170 shares and a million shares are priced, and
    /// a repo of 100,000 shares opens at its ceiling and is repurchased.
    #[test]
    fn eighteen_decimal_shares_priced_by_an_eighteen_decimal_feed() {
        let f = bare();
        let fund = f.env.register(
            FundToken,
            (
                f.steward.clone(),
                18u32,
                String::from_str(&f.env, "Test fund share, 18 decimals"),
                String::from_str(&f.env, "tFUND18"),
            ),
        );
        let token = FundTokenClient::new(&f.env, &fund);
        for holder in [&f.borrower, &f.lender, &f.contract_id] {
            token.set_whitelisted(holder, &true);
        }
        let share = 10i128.pow(18);
        token.mint(&f.borrower, &(1_000_000 * share));
        let feed = f
            .env
            .register(MockOracle, (Asset::Other(eur(&f.env)), 18u32));
        // 1.05 EUR per share, with 18 decimals.
        MockOracleClient::new(&f.env, &feed).set_price(
            &Asset::Stellar(fund.clone()),
            &(105 * 10i128.pow(16)),
            &T0,
        );
        f.client.set_stablecoin(&f.eurc, &eur(&f.env));
        f.client.set_currency_cap(&eur(&f.env), &(10_000_000 * ONE));
        f.client.set_fund(
            &fund,
            &FundConfig {
                oracle: feed,
                oracle_asset: Asset::Stellar(fund.clone()),
                ..fund_config(&f)
            },
        );
        let state = f.client.get_fund_state(&fund).unwrap();
        assert_eq!((state.share_decimals, state.nav_decimals), (18, 18));
        // 170 x 1.05 x 98 % = 174.93 EURC: an overflow in rc4.
        assert_eq!(
            f.client.quote(&fund, &(170 * share), &f.eurc).max_principal,
            1_749_300_000
        );
        assert_eq!(
            f.client
                .quote(&fund, &(1_000_000 * share), &f.eurc)
                .max_principal,
            1_029_000 * ONE
        );

        admit_lender(&f.client, &f.env, &fund, &f.lender);
        mint(&f.env, &f.eurc, &f.lender, 200_000 * ONE);
        mint(&f.env, &f.eurc, &f.borrower, 1_000 * ONE);
        let offer_id = f.client.create_offer(
            &f.lender,
            &f.eurc,
            &(200_000 * ONE),
            &RATE_BPS,
            &(7 * DAY),
            &vec![&f.env, fund.clone()],
        );
        let pledged = 100_000 * share;
        let ceiling = f.client.quote(&fund, &pledged, &f.eurc).max_principal;
        assert_eq!(ceiling, 102_900 * ONE);
        let repo_id = f
            .client
            .open_repo(&f.borrower, &offer_id, &fund, &pledged, &ceiling, &DAY);
        assert_eq!(token.balance(&f.contract_id), pledged);
        advance(&f, HOUR);
        f.client.repurchase(&repo_id);
        assert_eq!(token.balance(&f.borrower), 1_000_000 * share);
    }
}

/// Operations extend the contract instance but never the WASM code entry:
/// code rent grows with its size, and an ordinary user must not pay it (see
/// `storage::bump_instance`). The operator extends the code separately.
#[cfg(night_window_wasm)]
#[test]
fn operations_extend_the_instance_but_not_the_code() {
    use soroban_sdk::testutils::Deployer as _;
    let env = Env::default();
    env.mock_all_auths();
    let governor = Address::generate(&env);
    let id = env.register(NIGHT_WINDOW_WASM, (governor.clone(),));
    let client = OpenWindowClient::new(&env, &id);
    let instance_before = env.deployer().get_contract_instance_ttl(&id);
    let code_before = env.deployer().get_contract_code_ttl(&id);

    client.set_currency_cap(&eur(&env), &1);

    let instance_after = env.deployer().get_contract_instance_ttl(&id);
    let code_after = env.deployer().get_contract_code_ttl(&id);
    assert!(instance_after > instance_before, "the instance is extended");
    assert_eq!(instance_after, 120 * 17_280);
    assert_eq!(
        code_after, code_before,
        "the code entry is left to the operator"
    );
}

/// Real permissioned shares are often a classic asset with authorization
/// required, held through its Stellar Asset Contract. When the issuer
/// deauthorizes the contract, the asset contract refuses the transfer: the
/// repurchase must still settle and the shares wait, as with `fund-token`.
#[test]
fn asset_contract_deauthorizing_the_contract_defers_the_release() {
    let (f, offer_id) = ready();
    let repo_id = open(&f, offer_id);
    let shares_before = balance(&f.env, &f.shares, &f.borrower);
    let issuer = StellarAssetClient::new(&f.env, &f.shares);

    issuer.set_authorized(&f.contract_id, &false);
    f.client.repurchase(&repo_id);
    let pending = f
        .client
        .pending_release(&repo_id)
        .expect("shares recorded as owed");
    assert_eq!(pending.to, f.borrower);
    assert_eq!(pending.shares, 10_000 * ONE);
    assert!(
        !f.client.release(&repo_id),
        "still refused while deauthorized"
    );
    assert_eq!(balance(&f.env, &f.shares, &f.borrower), shares_before);

    issuer.set_authorized(&f.contract_id, &true);
    assert!(f.client.release(&repo_id));
    assert_eq!(f.client.pending_release(&repo_id), None);
    assert_eq!(
        balance(&f.env, &f.shares, &f.borrower),
        shares_before + 10_000 * ONE
    );
}

// ---------------------------------------------------------------------------
// Version 4: lenders independent of the fund (MMF Regulation, Art. 35)
// ---------------------------------------------------------------------------

/// Mocks the signatures of `signers` only, for one call of `fn_name`.
fn sign_only(f: &Fixture, signers: &[&Address], fn_name: &str, args: soroban_sdk::Vec<Val>) {
    let invoke = MockAuthInvoke {
        contract: &f.contract_id,
        fn_name,
        args,
        sub_invokes: &[],
    };
    let mocks: std::vec::Vec<MockAuth> = signers
        .iter()
        .map(|address| MockAuth {
            address,
            invoke: &invoke,
        })
        .collect();
    f.env.mock_auths(&mocks);
}

/// The addresses whose authorization the last invocation required.
fn signers(f: &Fixture) -> std::vec::Vec<Address> {
    f.env
        .auths()
        .into_iter()
        .map(|(address, _)| address)
        .collect()
}

#[test]
fn steward_cannot_attest_or_approve_itself() {
    let (f, _) = ready();
    assert_eq!(
        f.client
            .try_attest_lender(&f.shares, &f.steward, &declaration(&f.env, 1)),
        Err(Ok(Error::StewardCannotLend))
    );
    assert_eq!(
        f.client.try_approve_lender(&f.shares, &f.steward, &true),
        Err(Ok(Error::StewardCannotLend))
    );
    assert!(!f.client.is_lender_approved(&f.shares, &f.steward));
    // The steward on record is checked too, whatever the configuration says.
    let recorded = Address::generate(&f.env);
    f.env.as_contract(&f.contract_id, || {
        f.env
            .storage()
            .persistent()
            .set(&DataKey::LastSteward(f.shares.clone()), &recorded)
    });
    assert_eq!(
        f.client.try_approve_lender(&f.shares, &recorded, &true),
        Err(Ok(Error::StewardCannotLend))
    );
}

#[test]
fn a_steward_cannot_lend_on_any_fund_an_offer_lists() {
    let (f, _) = ready();
    // A second fund whose steward is the lender of the first.
    let other_fund = new_token(&f.env);
    f.oracle
        .set_price(&Asset::Stellar(other_fund.clone()), &NAV_EUR, &T0);
    let mut config = fund_config(&f);
    config.oracle_asset = Asset::Stellar(other_fund.clone());
    config.steward = f.lender.clone();
    f.client.set_fund(&other_fund, &config);
    assert_eq!(
        f.client.try_create_offer(
            &f.lender,
            &f.eurc,
            &ONE,
            &RATE_BPS,
            &DAY,
            &vec![&f.env, f.shares.clone(), other_fund.clone()]
        ),
        Err(Ok(Error::StewardCannotLend))
    );
    // An approval granted before version 4 does not let a steward through.
    f.env.as_contract(&f.contract_id, || {
        f.env
            .storage()
            .persistent()
            .set(&DataKey::Lender(f.shares.clone(), f.steward.clone()), &true)
    });
    mint(&f.env, &f.eurc, &f.steward, ONE);
    assert_eq!(
        f.client.try_create_offer(
            &f.steward,
            &f.eurc,
            &ONE,
            &RATE_BPS,
            &DAY,
            &vec![&f.env, f.shares.clone()]
        ),
        Err(Ok(Error::StewardCannotLend))
    );
}

/// The other way round: an approved lender can become the steward neither
/// by a replacement nor as the steward's backup; approving the backup
/// during a recovery is a steward action, which cancels the recovery.
#[test]
fn an_approved_lender_cannot_become_the_steward() {
    let (f, _) = ready();
    let mut config = replacement(&f);
    config.steward = f.lender.clone();
    assert_eq!(
        f.client.try_set_fund(&f.shares, &config),
        Err(Ok(Error::StewardCannotLend))
    );
    assert_eq!(
        f.client.try_set_steward_backup(&f.shares, &f.lender),
        Err(Ok(Error::StewardCannotLend))
    );
    appoint_guardian(&f);
    let candidate = Address::generate(&f.env);
    f.client.set_steward_backup(&f.shares, &candidate);
    f.client.propose_steward_recovery(&f.shares, &candidate);
    admit_lender(&f.client, &f.env, &f.shares, &candidate);
    assert_eq!(f.client.pending_steward_recovery(&f.shares), None);
    advance(&f, MAX_TIMELOCK_SECS);
    assert_eq!(
        f.client.try_apply_steward_recovery(&f.shares),
        Err(Ok(Error::NotProposed))
    );
    assert_eq!(
        f.client.try_propose_steward_recovery(&f.shares, &candidate),
        Err(Ok(Error::StewardCannotLend))
    );
    assert_eq!(f.client.get_fund(&f.shares).unwrap().steward, f.steward);
    let unknown = new_token(&f.env);
    assert_eq!(
        f.client.try_propose_steward_recovery(&unknown, &candidate),
        Err(Ok(Error::FundNotAccepted))
    );
}

#[test]
fn sole_lender_is_chosen_once_before_anything_is_at_stake() {
    let f = bare();
    let intruder = Address::generate(&f.env);
    sign_only(
        &f,
        &[&intruder],
        "set_sole_lender",
        (f.lender.clone(),).into_val(&f.env),
    );
    assert!(f.client.try_set_sole_lender(&f.lender).is_err());
    f.env.mock_all_auths();
    assert_eq!(f.client.sole_lender(), None);
    f.client.set_sole_lender(&f.lender);
    assert_eq!(f.env.auths()[0].0, f.governor);
    assert_eq!(
        own_events(&f),
        std::vec![SoleLenderSet {
            lender: f.lender.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.sole_lender(), Some(f.lender.clone()));
    assert_eq!(
        f.client.try_set_sole_lender(&f.borrower),
        Err(Ok(Error::SoleLenderFixed))
    );

    // Once a fund is admitted, a multi-lender instance stays one.
    let (g, _) = ready();
    assert_eq!(
        g.client.try_set_sole_lender(&g.lender),
        Err(Ok(Error::SoleLenderFixed))
    );
    assert_eq!(g.client.sole_lender(), None);
}

#[test]
fn a_second_lender_is_refused_in_sole_lender_mode() {
    let f = bare();
    f.client.set_sole_lender(&f.lender);
    let (f, offer_id) = ready_from(f);
    // The steward may still approve another address, as a recipient of
    // seized shares for instance; it cannot lend.
    let second = Address::generate(&f.env);
    admit_lender(&f.client, &f.env, &f.shares, &second);
    mint(&f.env, &f.eurc, &second, 1_000 * ONE);
    assert_eq!(
        f.client.try_create_offer(
            &second,
            &f.eurc,
            &(1_000 * ONE),
            &RATE_BPS,
            &(7 * DAY),
            &vec![&f.env, f.shares.clone()]
        ),
        Err(Ok(Error::NotSoleLender))
    );
    let repo_id = open(&f, offer_id);
    assert_eq!(f.client.get_repo(&repo_id).unwrap().lender, f.lender);
}

/// The mode lives in instance storage, which every call loads: an offer
/// touches the same ledger entries with or without it.
#[test]
fn sole_lender_mode_leaves_the_offer_footprint_unchanged() {
    let measure = |f: &Fixture| {
        f.client.create_offer(
            &f.lender,
            &f.eurc,
            &(1_000 * ONE),
            &RATE_BPS,
            &(7 * DAY),
            &vec![&f.env, f.shares.clone()],
        );
        footprint(&f.env)
    };
    let (open_instance, _) = ready();
    let sole = bare();
    sole.client.set_sole_lender(&sole.lender);
    let (sole, _) = ready_from(sole);
    let (without, with) = (measure(&open_instance), measure(&sole));
    assert_eq!((without.0, without.1), (with.0, with.1));
    // With one fund listed: 10 entries. The approval read carries the
    // steward that granted it, so no attestation is read (rc2, second review).
    assert_eq!((with.0, with.1), (10 + CODE_ENTRY, 5));
    std::println!(
        "create_offer footprint: {} entries read, {} written, with or without a sole lender",
        with.0,
        with.1
    );
}

#[test]
fn approval_needs_an_attestation_signed_by_the_lender_and_the_steward() {
    let f = bare();
    f.client.set_fund(&f.shares, &fund_config(&f));
    assert_eq!(
        f.client.try_approve_lender(&f.shares, &f.lender, &true),
        Err(Ok(Error::AttestationMissing))
    );
    let hash = declaration(&f.env, 0x42);
    let args: soroban_sdk::Vec<Val> =
        (f.shares.clone(), f.lender.clone(), hash.clone()).into_val(&f.env);
    for signer in [&f.lender, &f.steward] {
        sign_only(&f, &[signer], "attest_lender", args.clone());
        assert!(f
            .client
            .try_attest_lender(&f.shares, &f.lender, &hash)
            .is_err());
    }
    f.env.mock_all_auths();
    assert_eq!(f.client.lender_attestation(&f.shares, &f.lender), None);
    f.client.attest_lender(&f.shares, &f.lender, &hash);
    let signed = signers(&f);
    assert!(signed.contains(&f.steward) && signed.contains(&f.lender));
    assert_eq!(
        own_events(&f),
        std::vec![LenderAttested {
            fund: f.shares.clone(),
            lender: f.lender.clone(),
            declaration: hash.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(
        f.client.lender_attestation(&f.shares, &f.lender),
        Some(LenderAttestation {
            declaration: hash.clone(),
            steward: f.steward.clone(),
            at: T0
        })
    );
    // Approving reads the attestation and extends it.
    let key = DataKey::LenderAttestation(f.shares.clone(), f.lender.clone());
    age_ledgers(&f);
    assert!(entry_ttl(&f, &key) < BUMP_THRESHOLD_LEDGERS);
    f.client.approve_lender(&f.shares, &f.lender, &true);
    assert_eq!(
        own_events(&f),
        std::vec![LenderApproval {
            fund: f.shares.clone(),
            lender: f.lender.clone(),
            approved: true
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(entry_ttl(&f, &key), BUMP_TO_LEDGERS);
    // Revoking removes the attestation (the events keep the trail): a
    // revoked lender comes back only with a fresh one.
    f.client.approve_lender(&f.shares, &f.lender, &false);
    assert!(!f.client.is_lender_approved(&f.shares, &f.lender));
    assert_eq!(f.client.lender_attestation(&f.shares, &f.lender), None);
    assert_eq!(
        f.client.try_approve_lender(&f.shares, &f.lender, &true),
        Err(Ok(Error::AttestationMissing))
    );
    f.client
        .attest_lender(&f.shares, &f.lender, &declaration(&f.env, 0x43));
    f.client.approve_lender(&f.shares, &f.lender, &true);
    assert!(f.client.is_lender_approved(&f.shares, &f.lender));
}

// ---------------------------------------------------------------------------
// Version 4: custody gaps I12 (governor), I13 (guardian), I14 (steward)
// ---------------------------------------------------------------------------

#[test]
fn governor_handover_waits_for_the_delay_after_the_first_admission() {
    let (f, _) = ready();
    let successor = Address::generate(&f.env);
    f.client.set_admin(&successor);
    let eta = T0 + DEFAULT_TIMELOCK_SECS;
    assert_eq!(
        own_events(&f),
        std::vec![
            AdminProposed {
                current: f.governor.clone(),
                proposed: successor.clone()
            }
            .to_xdr(&f.env, &f.contract_id),
            AdminChangeProposed {
                admin: successor.clone(),
                eta
            }
            .to_xdr(&f.env, &f.contract_id)
        ]
    );
    assert_eq!(
        f.client.pending_admin(),
        Some(PendingAdminChange {
            admin: successor.clone(),
            eta
        })
    );
    assert_eq!(f.client.try_accept_admin(), Err(Ok(Error::TimelockPending)));
    advance(&f, DEFAULT_TIMELOCK_SECS);
    f.client.accept_admin();
    assert_eq!(f.env.auths()[0].0, successor);
    assert_eq!(f.client.admin(), successor);
    assert_eq!(f.client.pending_admin(), None);
}

#[test]
fn governor_handover_is_immediate_before_the_first_admission_and_expires() {
    let f = bare();
    let successor = Address::generate(&f.env);
    f.client.set_admin(&successor);
    assert_eq!(
        f.client.pending_admin(),
        Some(PendingAdminChange {
            admin: successor.clone(),
            eta: T0
        })
    );
    advance(&f, PROPOSAL_GRACE_SECS + 1);
    assert_eq!(f.client.pending_admin(), None);
    assert_eq!(f.client.try_accept_admin(), Err(Ok(Error::ProposalExpired)));
    f.client.set_admin(&successor);
    f.client.accept_admin();
    assert_eq!(f.client.admin(), successor);
}

/// Custody gap I12: a thief holding the governor quorum proposes itself;
/// the guardian vetoes within the window, as often as needed.
#[test]
fn stolen_governor_quorum_cannot_install_a_governor_inside_one_window() {
    let (f, _) = ready();
    let guardian = appoint_guardian(&f);
    let thief = Address::generate(&f.env);
    f.client.set_admin(&thief);
    let intruder = Address::generate(&f.env);
    assert_eq!(
        f.client.try_veto_admin(&intruder),
        Err(Ok(Error::Unauthorized))
    );
    sign_only(
        &f,
        &[&intruder],
        "veto_admin",
        (guardian.clone(),).into_val(&f.env),
    );
    assert!(f.client.try_veto_admin(&guardian).is_err());
    f.env.mock_all_auths();
    f.client.veto_admin(&guardian);
    assert_eq!(f.env.auths()[0].0, guardian);
    assert_eq!(
        own_events(&f),
        std::vec![AdminProposalCancelled {
            proposed: thief.clone(),
            by: guardian.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    advance(&f, DEFAULT_TIMELOCK_SECS);
    assert_eq!(f.client.try_accept_admin(), Err(Ok(Error::Unauthorized)));
    assert_eq!(
        f.client.try_veto_admin(&guardian),
        Err(Ok(Error::NotProposed))
    );
    // Proposing again restarts the window, and the guardian vetoes again.
    f.client.set_admin(&thief);
    advance(&f, DEFAULT_TIMELOCK_SECS - 1);
    assert_eq!(f.client.try_accept_admin(), Err(Ok(Error::TimelockPending)));
    f.client.veto_admin(&guardian);
    advance(&f, 1);
    assert_eq!(f.client.try_accept_admin(), Err(Ok(Error::Unauthorized)));
    assert_eq!(f.client.admin(), f.governor);
}

/// Review M1: a contract upgraded from version 3 may hold a handover in the
/// old key, proposed without any delay. It is never accepted: it counts as
/// expired and can only be cleared, by a new proposal, a cancellation or a
/// veto.
#[test]
fn a_handover_proposed_before_version_4_is_never_accepted() {
    let (f, _) = ready();
    let successor = Address::generate(&f.env);
    let set_legacy = |f: &Fixture, admin: &Address| {
        f.env.as_contract(&f.contract_id, || {
            f.env
                .storage()
                .instance()
                .set(&DataKey::PendingAdmin, admin)
        })
    };
    let has_legacy = |f: &Fixture| {
        f.env.as_contract(&f.contract_id, || {
            f.env.storage().instance().has(&DataKey::PendingAdmin)
        })
    };
    set_legacy(&f, &successor);
    assert_eq!(f.client.pending_admin(), None);
    assert_eq!(f.client.try_accept_admin(), Err(Ok(Error::ProposalExpired)));
    assert_eq!(f.client.admin(), f.governor);
    // Cleared by a cancellation, with its event.
    f.client.cancel_admin();
    assert_eq!(
        own_events(&f),
        std::vec![AdminProposalCancelled {
            proposed: successor.clone(),
            by: f.governor.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert!(!has_legacy(&f));
    // Cleared by a veto.
    set_legacy(&f, &successor);
    f.client.veto_admin(&f.guardian);
    assert!(!has_legacy(&f));
    // Replaced by a version 4 proposal, which waits for the delay.
    set_legacy(&f, &successor);
    let next = Address::generate(&f.env);
    f.client.set_admin(&next);
    assert!(!has_legacy(&f));
    assert_eq!(f.client.pending_admin().unwrap().admin, next);
    assert_eq!(f.client.try_accept_admin(), Err(Ok(Error::TimelockPending)));
}

/// Review L1: a handover proposed during bootstrap was due at once; the
/// first admission drops it, so it cannot be accepted once value is at
/// stake.
#[test]
fn the_first_admission_drops_a_bootstrap_handover() {
    let f = bare();
    let successor = Address::generate(&f.env);
    f.client.set_admin(&successor);
    f.client.set_fund(&f.shares, &fund_config(&f));
    assert_eq!(
        own_events(&f),
        std::vec![
            AdminProposalCancelled {
                proposed: successor.clone(),
                by: f.contract_id.clone(),
            }
            .to_xdr(&f.env, &f.contract_id),
            FundSet {
                fund: f.shares.clone(),
                oracle: f.nav_oracle.clone(),
                haircut_bps: 200
            }
            .to_xdr(&f.env, &f.contract_id)
        ]
    );
    assert_eq!(f.client.pending_admin(), None);
    assert_eq!(f.client.try_accept_admin(), Err(Ok(Error::Unauthorized)));
    assert_eq!(f.client.admin(), f.governor);
}

/// Review finding auth-4 (20 October 2026): before the first admission the
/// governor may shorten the delay at will. An upgrade proposed under a
/// one-minute delay kept that eta once value was at stake, the delay back
/// at 48 hours. The first admission drops it, as it drops a bootstrap
/// handover. What else the governor sets during bootstrap takes effect at
/// once and leaves no proposal, and a forced guardian change keeps its
/// thirty days.
#[test]
fn the_first_admission_drops_a_bootstrap_upgrade() {
    let f = bare();
    f.client.set_timelock_delay(&MIN_TIMELOCK_SECS);
    let hash = wasm_hash(&f.env, 5);
    f.client.propose_upgrade(&hash);
    assert_eq!(
        f.client.pending_upgrade().map(|p| p.eta),
        Some(T0 + MIN_TIMELOCK_SECS)
    );
    f.client.set_timelock_delay(&DEFAULT_TIMELOCK_SECS);
    let guardian = Address::generate(&f.env);
    f.client.set_guardian(&guardian);
    f.client.set_max_term(&(10 * DAY));
    f.client.set_envelope(&looser_envelope());
    f.client.set_stablecoin(&f.eurc, &eur(&f.env));
    f.client.set_currency_cap(&eur(&f.env), &(10_000_000 * ONE));
    let forced = Address::generate(&f.env);
    f.client.force_guardian_change(&forced);

    f.client.set_fund(&f.shares, &fund_config(&f));
    assert_eq!(
        own_events(&f),
        std::vec![
            UpgradeCancelled {
                wasm_hash: hash.clone(),
                by: f.contract_id.clone()
            }
            .to_xdr(&f.env, &f.contract_id),
            FundSet {
                fund: f.shares.clone(),
                oracle: f.nav_oracle.clone(),
                haircut_bps: 200
            }
            .to_xdr(&f.env, &f.contract_id)
        ]
    );
    assert_eq!(f.client.pending_upgrade(), None);
    assert_eq!(f.client.guardian(), guardian);
    assert_eq!(f.client.max_term(), 10 * DAY);
    assert_eq!(f.client.envelope(), looser_envelope());
    assert_eq!(f.client.pending_guardian_change(), None);
    assert_eq!(f.client.pending_max_term_change(), None);
    assert_eq!(f.client.pending_envelope_change(), None);
    assert_eq!(f.client.pending_currency_cap_change(&eur(&f.env)), None);
    assert_eq!(f.client.pending_stablecoin_change(&f.eurc), None);
    assert_eq!(
        f.client.pending_forced_guardian_change().map(|p| p.eta),
        Some(T0 + MAX_TIMELOCK_SECS)
    );

    // A minute later there is nothing to apply; proposed again, the upgrade
    // waits for the delay in force.
    advance(&f, MIN_TIMELOCK_SECS);
    assert_eq!(
        f.client.try_upgrade(&hash),
        Err(Ok(raised(Error::NotProposed)))
    );
    f.client.propose_upgrade(&hash);
    assert_eq!(
        f.client.pending_upgrade().map(|p| p.eta),
        Some(T0 + MIN_TIMELOCK_SECS + DEFAULT_TIMELOCK_SECS)
    );
}

/// A contract upgraded from version 2 has offers but no admission flag. It
/// left the bootstrap with its first offer, so its proposals waited for the
/// delay in force: the admission that sets the flag keeps them.
#[test]
fn an_admission_on_a_contract_upgraded_with_offers_keeps_its_proposals() {
    let (f, _) = ready();
    f.env.as_contract(&f.contract_id, || {
        f.env.storage().instance().remove(&DataKey::FundsAdmitted);
    });
    let hash = wasm_hash(&f.env, 6);
    f.client.propose_upgrade(&hash);
    let successor = Address::generate(&f.env);
    f.client.set_admin(&successor);
    let other = new_token(&f.env);
    f.oracle
        .set_price(&Asset::Stellar(other.clone()), &NAV_EUR, &T0);
    let config = FundConfig {
        oracle_asset: Asset::Stellar(other.clone()),
        ..fund_config(&f)
    };
    f.client.set_fund(&other, &config);
    assert_eq!(
        own_events(&f),
        std::vec![FundSet {
            fund: other,
            oracle: f.nav_oracle.clone(),
            haircut_bps: 200
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(
        f.client.pending_upgrade().map(|p| p.eta),
        Some(T0 + DEFAULT_TIMELOCK_SECS)
    );
    assert_eq!(f.client.pending_admin().map(|p| p.admin), Some(successor));
}

/// Custody gap I13: a thief holding the hot guardian key cannot hand the
/// role to itself; the legitimate rotation goes to the registered backup.
#[test]
fn stolen_guardian_key_cannot_hand_over_to_a_fresh_address() {
    let (f, _) = ready();
    let guardian = appoint_guardian(&f);
    let thief = Address::generate(&f.env);
    assert_eq!(
        f.client.try_hand_over_guardian(&thief),
        Err(Ok(raised(Error::NotGuardianBackup)))
    );
    let backup = Address::generate(&f.env);
    f.client.set_guardian_backup(&backup);
    assert_eq!(
        f.client.try_hand_over_guardian(&thief),
        Err(Ok(raised(Error::NotGuardianBackup)))
    );
    assert_eq!(f.client.guardian(), guardian);
    f.client.hand_over_guardian(&backup);
    assert_eq!(f.env.auths()[0].0, guardian);
    assert_eq!(f.client.guardian(), backup);
    // The backup is consumed: the new guardian registers its own.
    assert_eq!(f.client.guardian_backup(), None);
    assert_eq!(
        f.client.try_hand_over_guardian(&thief),
        Err(Ok(raised(Error::NotGuardianBackup)))
    );
}

#[test]
fn guardian_backup_needs_the_governor_and_the_guardian() {
    let (f, _) = ready();
    let guardian = appoint_guardian(&f);
    let backup = Address::generate(&f.env);
    let args: soroban_sdk::Vec<Val> = (backup.clone(),).into_val(&f.env);
    for signer in [&f.governor, &guardian] {
        sign_only(&f, &[signer], "set_guardian_backup", args.clone());
        assert!(f.client.try_set_guardian_backup(&backup).is_err());
    }
    assert_eq!(f.client.guardian_backup(), None);
    sign_only(&f, &[&f.governor, &guardian], "set_guardian_backup", args);
    f.client.set_guardian_backup(&backup);
    let signed = signers(&f);
    assert!(signed.contains(&f.governor) && signed.contains(&guardian));
    assert_eq!(
        own_events(&f),
        std::vec![GuardianBackupSet {
            backup: backup.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.guardian_backup(), Some(backup));
}

/// While the governor holds the guardian role, handing it over gives its
/// key nothing it did not have; any other way of installing a guardian drops
/// the backup agreed with the one leaving.
#[test]
fn a_guardian_that_is_the_governor_hands_over_freely_and_a_new_guardian_drops_the_backup() {
    let f = bare();
    let first = Address::generate(&f.env);
    f.client.hand_over_guardian(&first);
    assert_eq!(f.env.auths()[0].0, f.governor);
    assert_eq!(f.client.guardian(), first);
    let backup = Address::generate(&f.env);
    f.client.set_guardian_backup(&backup);
    let second = Address::generate(&f.env);
    f.client.set_guardian(&second);
    assert_eq!(f.client.guardian(), second);
    assert_eq!(f.client.guardian_backup(), None);
    assert_eq!(
        f.client.try_hand_over_guardian(&backup),
        Err(Ok(raised(Error::NotGuardianBackup)))
    );
}

/// Custody gap I14 and review H1: a lost steward key is replaced only by
/// the backup the steward named, after thirty days, with the governor and a
/// distinct guardian; the backup consents when named and accepts at the end.
#[test]
fn lost_steward_key_is_replaced_by_its_backup_after_thirty_days() {
    let (f, _) = ready();
    let guardian = appoint_guardian(&f);
    let new_steward = Address::generate(&f.env);
    // Only the steward names its backup, and the backup consents: the
    // governance keys cannot, nor can the steward alone (a typo would leave
    // the fund unrecoverable).
    let backup_args: soroban_sdk::Vec<Val> =
        (f.shares.clone(), new_steward.clone()).into_val(&f.env);
    for signing in [
        std::vec![&f.governor, &guardian, &new_steward],
        std::vec![&f.steward],
    ] {
        sign_only(&f, &signing, "set_steward_backup", backup_args.clone());
        assert!(f
            .client
            .try_set_steward_backup(&f.shares, &new_steward)
            .is_err());
    }
    f.env.mock_all_auths();
    f.client.set_steward_backup(&f.shares, &new_steward);
    let signed = signers(&f);
    assert_eq!(signed.len(), 2);
    assert!(signed.contains(&f.steward) && signed.contains(&new_steward));
    assert_eq!(
        own_events(&f),
        std::vec![StewardBackupSet {
            fund: f.shares.clone(),
            backup: new_steward.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(
        f.client.steward_backup(&f.shares),
        Some(new_steward.clone())
    );
    // An attestation the steward co-signs before losing its key.
    let lender = Address::generate(&f.env);
    f.client
        .attest_lender(&f.shares, &lender, &declaration(&f.env, 3));

    let args: soroban_sdk::Vec<Val> = (f.shares.clone(), new_steward.clone()).into_val(&f.env);
    for signer in [&f.governor, &guardian] {
        sign_only(&f, &[signer], "propose_steward_recovery", args.clone());
        assert!(f
            .client
            .try_propose_steward_recovery(&f.shares, &new_steward)
            .is_err());
    }
    f.env.mock_all_auths();
    f.client.propose_steward_recovery(&f.shares, &new_steward);
    let signed = signers(&f);
    assert!(signed.contains(&f.governor) && signed.contains(&guardian));
    let eta = f.env.ledger().timestamp() + MAX_TIMELOCK_SECS;
    assert_eq!(
        own_events(&f),
        std::vec![StewardRecoveryProposed {
            fund: f.shares.clone(),
            steward: new_steward.clone(),
            eta
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(
        f.client.pending_steward_recovery(&f.shares),
        Some(PendingStewardRecovery {
            steward: new_steward.clone(),
            previous: f.steward.clone(),
            // One guardian change so far, in `appoint_guardian`.
            generation: 1,
            eta
        })
    );
    advance(&f, MAX_TIMELOCK_SECS - 1);
    assert_eq!(
        f.client.try_apply_steward_recovery(&f.shares),
        Err(Ok(Error::TimelockPending))
    );
    advance(&f, 1);
    // The backup accepts the role, as a successor governor does; nobody
    // else can apply it in its place.
    let intruder = Address::generate(&f.env);
    sign_only(
        &f,
        &[&intruder, &f.governor, &guardian],
        "apply_steward_recovery",
        (f.shares.clone(),).into_val(&f.env),
    );
    assert!(f.client.try_apply_steward_recovery(&f.shares).is_err());
    f.env.mock_all_auths();
    assert!(f.client.apply_steward_recovery(&f.shares));
    assert_eq!(signers(&f), std::vec![new_steward.clone()]);
    assert_eq!(
        own_events(&f),
        std::vec![StewardRecovered {
            fund: f.shares.clone(),
            previous: f.steward.clone(),
            steward: new_steward.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.get_fund(&f.shares).unwrap().steward, new_steward);
    assert_eq!(f.client.pending_steward_recovery(&f.shares), None);
    assert_eq!(f.client.steward_backup(&f.shares), None);

    // Review M4: the attestation the replaced steward co-signed backs no
    // approval; the new steward attests again.
    f.env.mock_all_auths();
    assert_eq!(
        f.client.try_approve_lender(&f.shares, &lender, &true),
        Err(Ok(Error::AttestationMissing))
    );
    f.client
        .attest_lender(&f.shares, &lender, &declaration(&f.env, 4));
    assert!(signers(&f).contains(&new_steward));
    f.client.approve_lender(&f.shares, &lender, &true);
    // The old key no longer acts.
    sign_only(
        &f,
        &[&f.steward],
        "freeze_fund",
        (f.shares.clone(), true).into_val(&f.env),
    );
    assert!(f.client.try_freeze_fund(&f.shares, &true).is_err());
}

/// Review H1: one key holding the governor and guardian roles cannot
/// replace an issuer on its own.
#[test]
fn one_key_holding_both_roles_cannot_recover_a_steward() {
    let (f, _) = ready();
    assert_eq!(f.client.guardian(), f.governor);
    let backup = Address::generate(&f.env);
    f.client.set_steward_backup(&f.shares, &backup);
    assert_eq!(
        f.client.try_propose_steward_recovery(&f.shares, &backup),
        Err(Ok(Error::Unauthorized))
    );
}

/// Review H1: the governor and the guardian cannot pick the issuer's
/// replacement, even after removing the fund: a recovery installs only
/// the backup the steward named.
#[test]
fn steward_recovery_goes_only_to_the_stewards_backup() {
    let (f, _) = ready();
    appoint_guardian(&f);
    let chosen_by_governance = Address::generate(&f.env);
    assert_eq!(
        f.client
            .try_propose_steward_recovery(&f.shares, &chosen_by_governance),
        Err(Ok(Error::NoStewardBackup))
    );
    let backup = Address::generate(&f.env);
    f.client.set_steward_backup(&f.shares, &backup);
    assert_eq!(
        f.client
            .try_propose_steward_recovery(&f.shares, &chosen_by_governance),
        Err(Ok(Error::NoStewardBackup))
    );
    f.client.remove_fund(&f.shares);
    assert_eq!(
        f.client
            .try_propose_steward_recovery(&f.shares, &chosen_by_governance),
        Err(Ok(Error::NoStewardBackup))
    );
    f.client.propose_steward_recovery(&f.shares, &backup);
    assert_eq!(
        f.client
            .pending_steward_recovery(&f.shares)
            .unwrap()
            .steward,
        backup
    );
}

/// One action the steward signs, in `any_steward_action_cancels_a_pending_recovery`.
type StewardAction = std::boxed::Box<dyn Fn(&Fixture)>;

/// Review H1: any action the steward signs on the fund proves its key is
/// not lost and cancels a pending recovery.
#[test]
fn any_steward_action_cancels_a_pending_recovery() {
    let (f, offer_id) = ready();
    appoint_guardian(&f);
    let backup = Address::generate(&f.env);
    f.client.set_steward_backup(&f.shares, &backup);
    f.client.propose_steward_recovery(&f.shares, &backup);
    f.client.freeze_fund(&f.shares, &false);
    assert_eq!(
        own_events(&f),
        std::vec![
            StewardRecoveryCancelled {
                fund: f.shares.clone(),
                by: f.steward.clone()
            }
            .to_xdr(&f.env, &f.contract_id),
            FundFrozen {
                fund: f.shares.clone(),
                frozen: false
            }
            .to_xdr(&f.env, &f.contract_id)
        ]
    );
    assert_eq!(f.client.pending_steward_recovery(&f.shares), None);

    let lender = f.lender.clone();
    let named = backup.clone();
    let actions: std::vec::Vec<StewardAction> = std::vec![
        std::boxed::Box::new(move |f: &Fixture| f.client.set_sponsor(&offer_id, &f.shares, &false)),
        std::boxed::Box::new(|f: &Fixture| {
            f.client
                .set_fund_limits(&f.shares, &300, &(500_000 * ONE), &(5_000_000 * ONE))
        }),
        std::boxed::Box::new(move |f: &Fixture| f.client.approve_lender(&f.shares, &lender, &true)),
        std::boxed::Box::new(|f: &Fixture| {
            f.client.attest_lender(
                &f.shares,
                &Address::generate(&f.env),
                &declaration(&f.env, 9),
            )
        }),
        std::boxed::Box::new(|f: &Fixture| {
            f.client.reset_reference(&f.shares);
        }),
        std::boxed::Box::new(move |f: &Fixture| f.client.set_steward_backup(&f.shares, &named)),
        std::boxed::Box::new(|f: &Fixture| {
            f.client.set_fund(&f.shares, &replacement(f));
        }),
        std::boxed::Box::new(|f: &Fixture| {
            f.client.cancel_fund_change(&f.shares, &f.steward);
        }),
    ];
    for (i, action) in actions.iter().enumerate() {
        f.client.propose_steward_recovery(&f.shares, &backup);
        action(&f);
        assert_eq!(
            f.client.pending_steward_recovery(&f.shares),
            None,
            "action #{i}"
        );
    }
}

/// Review M3: a recovery signed by governance keys that have since been
/// replaced dies, whether the governor or the guardian changed. The view
/// stops showing it at once, and the apply removes it without the backup's
/// signature.
#[test]
fn a_recovery_signed_by_replaced_governance_keys_dies() {
    let (f, _) = ready();
    appoint_guardian(&f);
    let backup = Address::generate(&f.env);
    f.client.set_steward_backup(&f.shares, &backup);
    let removed = |f: &Fixture| {
        f.env.set_auths(&[]);
        assert!(!f.client.apply_steward_recovery(&f.shares));
        assert_eq!(
            own_events(f),
            std::vec![StewardRecoveryCancelled {
                fund: f.shares.clone(),
                by: f.contract_id.clone()
            }
            .to_xdr(&f.env, &f.contract_id)]
        );
        f.env.mock_all_auths();
        assert_eq!(
            f.client.try_apply_steward_recovery(&f.shares),
            Err(Ok(Error::NotProposed))
        );
    };

    f.client.propose_steward_recovery(&f.shares, &backup);
    let successor = Address::generate(&f.env);
    f.client.set_admin(&successor);
    advance(&f, f.client.timelock_delay());
    f.client.accept_admin();
    assert_eq!(f.client.pending_steward_recovery(&f.shares), None);
    advance(&f, MAX_TIMELOCK_SECS);
    removed(&f);

    f.client.propose_steward_recovery(&f.shares, &backup);
    let next_guardian = Address::generate(&f.env);
    f.client.set_guardian_backup(&next_guardian);
    f.client.hand_over_guardian(&next_guardian);
    assert_eq!(f.client.pending_steward_recovery(&f.shares), None);
    advance(&f, MAX_TIMELOCK_SECS);
    removed(&f);
    assert_eq!(f.client.get_fund(&f.shares).unwrap().steward, f.steward);
}

/// Review M3: a steward rotation that completes drops a recovery proposed
/// against the steward leaving, and the backup that steward named.
#[test]
fn a_steward_rotation_drops_a_pending_recovery_and_the_backup() {
    let (f, _) = ready();
    appoint_guardian(&f);
    let backup = Address::generate(&f.env);
    f.client.set_steward_backup(&f.shares, &backup);
    let next_steward = Address::generate(&f.env);
    let mut config = replacement(&f);
    config.steward = next_steward.clone();
    f.client.set_fund(&f.shares, &config);
    f.client.propose_steward_recovery(&f.shares, &backup);
    advance(&f, f.client.timelock_delay());
    publish_nav(&f, NAV_EUR);
    f.client.apply_fund_change(&f.shares);
    assert_eq!(
        own_events(&f),
        std::vec![
            StewardRecoveryCancelled {
                fund: f.shares.clone(),
                by: f.contract_id.clone()
            }
            .to_xdr(&f.env, &f.contract_id),
            FundSet {
                fund: f.shares.clone(),
                oracle: f.nav_oracle.clone(),
                haircut_bps: 300
            }
            .to_xdr(&f.env, &f.contract_id)
        ]
    );
    assert_eq!(f.client.pending_steward_recovery(&f.shares), None);
    assert_eq!(f.client.steward_backup(&f.shares), None);
    assert_eq!(f.client.get_fund(&f.shares).unwrap().steward, next_steward);
}

#[test]
fn steward_recovery_is_cancelled_by_the_steward_or_the_governor_not_the_guardian() {
    let (f, _) = ready();
    let guardian = appoint_guardian(&f);
    let new_steward = Address::generate(&f.env);
    let intruder = Address::generate(&f.env);
    assert_eq!(
        f.client.try_cancel_steward_recovery(&f.shares, &f.steward),
        Err(Ok(Error::NotProposed))
    );
    f.client.set_steward_backup(&f.shares, &new_steward);
    f.client.propose_steward_recovery(&f.shares, &new_steward);
    for caller in [&guardian, &intruder, &new_steward] {
        assert_eq!(
            f.client.try_cancel_steward_recovery(&f.shares, caller),
            Err(Ok(Error::Unauthorized))
        );
    }
    f.client.cancel_steward_recovery(&f.shares, &f.steward);
    assert_eq!(f.env.auths()[0].0, f.steward);
    assert_eq!(
        own_events(&f),
        std::vec![StewardRecoveryCancelled {
            fund: f.shares.clone(),
            by: f.steward.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.pending_steward_recovery(&f.shares), None);

    f.client.propose_steward_recovery(&f.shares, &new_steward);
    f.client.cancel_steward_recovery(&f.shares, &f.governor);
    assert_eq!(
        own_events(&f),
        std::vec![StewardRecoveryCancelled {
            fund: f.shares.clone(),
            by: f.governor.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );

    // A forgotten recovery expires like any proposal; the apply then
    // removes it rather than leave it to archive.
    f.client.propose_steward_recovery(&f.shares, &new_steward);
    advance(&f, MAX_TIMELOCK_SECS + PROPOSAL_GRACE_SECS + 1);
    assert_eq!(f.client.pending_steward_recovery(&f.shares), None);
    assert!(!f.client.apply_steward_recovery(&f.shares));
    assert_eq!(
        f.client.try_apply_steward_recovery(&f.shares),
        Err(Ok(Error::NotProposed))
    );
    // So does any steward action that finds an expired one.
    f.client.propose_steward_recovery(&f.shares, &new_steward);
    advance(&f, MAX_TIMELOCK_SECS + PROPOSAL_GRACE_SECS + 1);
    f.client.freeze_fund(&f.shares, &false);
    assert_eq!(
        own_events(&f),
        std::vec![
            StewardRecoveryCancelled {
                fund: f.shares.clone(),
                by: f.steward.clone()
            }
            .to_xdr(&f.env, &f.contract_id),
            FundFrozen {
                fund: f.shares.clone(),
                frozen: false
            }
            .to_xdr(&f.env, &f.contract_id)
        ]
    );
    assert_eq!(
        f.client.try_apply_steward_recovery(&f.shares),
        Err(Ok(Error::NotProposed))
    );
}

/// Review L3: a backup may wait years for the emergency it exists for;
/// proposing the recovery reads it and extends it.
#[test]
fn proposing_a_recovery_extends_the_steward_backup() {
    let (f, _) = ready();
    appoint_guardian(&f);
    let backup = Address::generate(&f.env);
    f.client.set_steward_backup(&f.shares, &backup);
    let key = DataKey::StewardBackup(f.shares.clone());
    age_ledgers(&f);
    assert!(entry_ttl(&f, &key) < BUMP_THRESHOLD_LEDGERS);
    f.client.propose_steward_recovery(&f.shares, &backup);
    assert_eq!(entry_ttl(&f, &key), BUMP_TO_LEDGERS);
}

/// What the previous steward signed before the recovery goes with it: a
/// pending replacement would put the lost key back, and a loosening carries
/// a signature that may now be a thief's. Proposals signed after the
/// recovery was proposed already cancelled it (proof of life); these were
/// signed before, under a 30-day delay that keeps them pending.
#[test]
fn steward_recovery_drops_what_the_previous_steward_signed() {
    let (f, _) = ready();
    appoint_guardian(&f);
    let new_steward = Address::generate(&f.env);
    f.client.set_steward_backup(&f.shares, &new_steward);
    f.client.set_timelock_delay(&MAX_TIMELOCK_SECS);
    f.client
        .set_fund_limits(&f.shares, &150, &(500_000 * ONE), &(5_000_000 * ONE));
    f.client.set_fund(&f.shares, &replacement(&f));
    f.client.propose_steward_recovery(&f.shares, &new_steward);
    assert!(f.client.pending_fund_limits_change(&f.shares).is_some());
    assert!(f.client.pending_fund_change(&f.shares).is_some());
    advance(&f, MAX_TIMELOCK_SECS);
    f.client.apply_steward_recovery(&f.shares);
    let by = f.contract_id.clone();
    assert_eq!(
        own_events(&f),
        std::vec![
            FundChangeCancelled {
                fund: f.shares.clone(),
                by: by.clone()
            }
            .to_xdr(&f.env, &f.contract_id),
            FundLimitsChangeCancelled {
                fund: f.shares.clone(),
                by
            }
            .to_xdr(&f.env, &f.contract_id),
            StewardRecovered {
                fund: f.shares.clone(),
                previous: f.steward.clone(),
                steward: new_steward.clone()
            }
            .to_xdr(&f.env, &f.contract_id)
        ]
    );
    assert_eq!(f.client.pending_fund_change(&f.shares), None);
    assert_eq!(f.client.pending_fund_limits_change(&f.shares), None);
    assert_eq!(f.client.get_fund(&f.shares).unwrap().haircut_bps, 200);
}

/// A removed fund whose steward key is lost can come back: its re-admission
/// then needs the recovered steward, and no longer the lost key.
#[test]
fn steward_recovery_lets_a_removed_fund_return_without_the_lost_key() {
    let (f, _) = ready();
    appoint_guardian(&f);
    f.client.remove_fund(&f.shares);
    let new_steward = Address::generate(&f.env);
    // The steward on record of a removed fund still names its backup.
    f.client.set_steward_backup(&f.shares, &new_steward);
    assert_eq!(f.env.auths()[0].0, f.steward);
    f.client.propose_steward_recovery(&f.shares, &new_steward);
    advance(&f, MAX_TIMELOCK_SECS);
    f.client.apply_steward_recovery(&f.shares);
    assert_eq!(f.client.get_fund(&f.shares), None);
    publish_nav(&f, NAV_EUR);
    let mut config = fund_config(&f);
    config.steward = new_steward.clone();
    sign_only(
        &f,
        &[&f.governor, &new_steward],
        "set_fund",
        (f.shares.clone(), config.clone()).into_val(&f.env),
    );
    f.client.set_fund(&f.shares, &config);
    assert_eq!(
        f.client
            .pending_fund_change(&f.shares)
            .unwrap()
            .config
            .steward,
        new_steward
    );
}

/// Review M5: an offer the steward made under an approval granted before
/// version 4 never lends, and seized shares never go to the steward.
#[test]
fn a_steward_approved_before_version_4_neither_lends_nor_receives_seized_shares() {
    let (f, offer_id) = ready();
    let repo_id = open(&f, offer_id);
    f.env.as_contract(&f.contract_id, || {
        let storage = f.env.storage().persistent();
        storage.set(&DataKey::Lender(f.shares.clone(), f.steward.clone()), &true);
        let mut offer: Offer = storage.get(&DataKey::Offer(offer_id)).unwrap();
        offer.lender = f.steward.clone();
        storage.set(&DataKey::Offer(offer_id), &offer);
    });
    assert_eq!(
        f.client.try_open_repo(
            &f.borrower,
            &offer_id,
            &f.shares,
            &(10_000 * ONE),
            &ONE,
            &DAY
        ),
        Err(Ok(Error::StewardCannotLend))
    );
    advance(&f, 64 * HOUR);
    assert_eq!(
        f.client.try_seize(&repo_id, &f.steward),
        Err(Ok(Error::StewardCannotLend))
    );
    f.client.seize(&repo_id, &f.lender);
}

/// Review M2: an opening extends the lender's approval whenever it has
/// less than 45 days left, longer than the longest repo, so the approval a
/// seizure needs outlives the repo.
#[test]
fn opening_a_repo_extends_the_lenders_approval() {
    let (f, offer_id) = ready();
    f.oracle.keep_alive();
    let key = DataKey::Lender(f.shares.clone(), f.lender.clone());
    // 80 days of ledgers: 40 days left, above the general threshold (30
    // days) but under the approval's (45 days).
    f.env
        .ledger()
        .with_mut(|ledger| ledger.sequence_number += 80 * 17_280);
    let left = entry_ttl(&f, &key);
    assert!(left > BUMP_THRESHOLD_LEDGERS && left < 45 * 17_280);
    publish_nav(&f, NAV_EUR);
    open(&f, offer_id);
    assert_eq!(entry_ttl(&f, &key), BUMP_TO_LEDGERS);
}

/// Storage: a seizure reads the recipient's approval, possibly months after
/// it was written, and extends it.
#[test]
fn seizure_extends_the_approval_it_reads() {
    let (f, offer_id) = ready();
    let repo_id = open(&f, offer_id);
    advance(&f, 64 * HOUR);
    let key = DataKey::Lender(f.shares.clone(), f.lender.clone());
    age_ledgers(&f);
    assert!(entry_ttl(&f, &key) < BUMP_THRESHOLD_LEDGERS);
    f.client.seize(&repo_id, &f.lender);
    assert_eq!(entry_ttl(&f, &key), BUMP_TO_LEDGERS);
}

// ---------------------------------------------------------------------------
// Audit candidate rc2: trustee (independent consent to upgrades)
// ---------------------------------------------------------------------------

/// Mode D3: the lender runs the instance and holds the governor and the
/// guardian roles (one key here); the fund's issuer is the trustee. Named
/// during bootstrap, then the fixture is made ready.
fn ready_with_trustee() -> (Fixture, Address) {
    let f = bare();
    let trustee = Address::generate(&f.env);
    f.client.set_trustee(&trustee);
    let (f, _) = ready_from(f);
    (f, trustee)
}

#[test]
fn trustee_is_named_once_before_anything_is_at_stake() {
    let f = bare();
    let trustee = Address::generate(&f.env);
    let args: soroban_sdk::Vec<Val> = (trustee.clone(),).into_val(&f.env);
    for signer in [&f.governor, &trustee] {
        sign_only(&f, &[signer], "set_trustee", args.clone());
        assert!(f.client.try_set_trustee(&trustee).is_err());
    }
    f.env.mock_all_auths();
    assert_eq!(f.client.trustee(), None);
    f.client.set_trustee(&trustee);
    let signed = signers(&f);
    assert!(signed.contains(&f.governor) && signed.contains(&trustee));
    assert_eq!(
        own_events(&f),
        std::vec![TrusteeSet {
            trustee: trustee.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.trustee(), Some(trustee.clone()));
    // Only the trustee replaces itself.
    let other = Address::generate(&f.env);
    assert_eq!(
        f.client.try_set_trustee(&other),
        Err(Ok(Error::TrusteeFixed))
    );
    // The trustee cannot become the sole lender.
    assert_eq!(
        f.client.try_set_sole_lender(&trustee),
        Err(Ok(Error::TrusteeNotIndependent))
    );

    // Once value can be at stake, no trustee can be named any more.
    let (g, _) = ready();
    assert_eq!(
        g.client.try_set_trustee(&Address::generate(&g.env)),
        Err(Ok(Error::TrusteeFixed))
    );
    assert_eq!(g.client.trustee(), None);
}

/// A trustee holding a governance role, or lending, would consent to its
/// own changes.
#[test]
fn trustee_must_be_independent() {
    let f = bare();
    assert_eq!(
        f.client.try_set_trustee(&f.governor),
        Err(Ok(Error::TrusteeNotIndependent))
    );
    let guardian = appoint_guardian(&f);
    assert_eq!(
        f.client.try_set_trustee(&guardian),
        Err(Ok(Error::TrusteeNotIndependent))
    );
    f.client.set_sole_lender(&f.lender);
    assert_eq!(
        f.client.try_set_trustee(&f.lender),
        Err(Ok(Error::TrusteeNotIndependent))
    );
    let trustee = Address::generate(&f.env);
    f.client.set_trustee(&trustee);
    for successor in [&f.governor, &guardian, &f.lender] {
        assert_eq!(
            f.client.try_hand_over_trustee(successor),
            Err(Ok(Error::TrusteeNotIndependent))
        );
    }
}

/// Mode D3: the lender's key holds the governor and the guardian roles. With
/// a trustee, that key alone can neither propose an upgrade nor force a
/// guardian change.
#[test]
fn with_a_trustee_an_upgrade_needs_its_signature() {
    let (f, trustee) = ready_with_trustee();
    assert_eq!(f.client.guardian(), f.governor);
    let hash = wasm_hash(&f.env, 1);
    let args: soroban_sdk::Vec<Val> = (hash.clone(),).into_val(&f.env);
    sign_only(&f, &[&f.governor], "propose_upgrade", args.clone());
    assert!(f.client.try_propose_upgrade(&hash).is_err());
    sign_only(&f, &[&trustee], "propose_upgrade", args.clone());
    assert!(f.client.try_propose_upgrade(&hash).is_err());
    assert_eq!(f.client.pending_upgrade(), None);
    sign_only(&f, &[&f.governor, &trustee], "propose_upgrade", args);
    f.client.propose_upgrade(&hash);
    let signed = signers(&f);
    assert!(signed.contains(&f.governor) && signed.contains(&trustee));
    assert_eq!(f.client.pending_upgrade().unwrap().wasm_hash, hash);

    let successor = Address::generate(&f.env);
    let args: soroban_sdk::Vec<Val> = (successor.clone(),).into_val(&f.env);
    sign_only(&f, &[&f.governor], "force_guardian_change", args.clone());
    assert!(f.client.try_force_guardian_change(&successor).is_err());
    assert_eq!(f.client.pending_forced_guardian_change(), None);
    sign_only(&f, &[&f.governor, &trustee], "force_guardian_change", args);
    f.client.force_guardian_change(&successor);
    let signed = signers(&f);
    assert!(signed.contains(&f.governor) && signed.contains(&trustee));
    assert!(f.client.pending_forced_guardian_change().is_some());
}

#[test]
fn trustee_vetoes_an_upgrade_a_forced_guardian_and_a_governor_handover() {
    let (f, trustee) = ready_with_trustee();
    let intruder = Address::generate(&f.env);
    let hash = wasm_hash(&f.env, 1);
    f.client.propose_upgrade(&hash);
    assert_eq!(
        f.client.try_cancel_upgrade(&intruder),
        Err(Ok(Error::Unauthorized))
    );
    f.client.cancel_upgrade(&trustee);
    assert_eq!(f.env.auths()[0].0, trustee);
    assert_eq!(
        own_events(&f),
        std::vec![UpgradeCancelled {
            wasm_hash: hash.clone(),
            by: trustee.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    advance(&f, DEFAULT_TIMELOCK_SECS);
    assert_eq!(
        f.client.try_upgrade(&hash),
        Err(Ok(raised(Error::NotProposed)))
    );

    let successor = Address::generate(&f.env);
    assert_eq!(
        f.client.try_veto_forced_guardian_change(&trustee),
        Err(Ok(Error::NotProposed))
    );
    f.client.force_guardian_change(&successor);
    assert_eq!(
        f.client.try_veto_forced_guardian_change(&intruder),
        Err(Ok(Error::Unauthorized))
    );
    f.client.veto_forced_guardian_change(&trustee);
    assert_eq!(f.env.auths()[0].0, trustee);
    assert_eq!(
        own_events(&f),
        std::vec![ForcedGuardianChangeCancelled {
            guardian: successor.clone(),
            by: trustee.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    advance(&f, MAX_TIMELOCK_SECS);
    assert_eq!(
        f.client.try_apply_forced_guardian_change(),
        Err(Ok(Error::NotProposed))
    );
    // The governor may withdraw its own forced change this way too.
    f.client.force_guardian_change(&successor);
    f.client.veto_forced_guardian_change(&f.governor);
    assert_eq!(f.client.pending_forced_guardian_change(), None);

    f.client.set_admin(&successor);
    assert_eq!(
        f.client.try_veto_admin(&intruder),
        Err(Ok(Error::Unauthorized))
    );
    f.client.veto_admin(&trustee);
    assert_eq!(
        own_events(&f),
        std::vec![AdminProposalCancelled {
            proposed: successor.clone(),
            by: trustee.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    advance(&f, DEFAULT_TIMELOCK_SECS);
    assert_eq!(f.client.try_accept_admin(), Err(Ok(Error::Unauthorized)));
    assert_eq!(f.client.admin(), f.governor);
}

#[test]
fn trustee_hands_over_only_to_a_successor_who_signs() {
    let (f, trustee) = ready_with_trustee();
    let successor = Address::generate(&f.env);
    let args: soroban_sdk::Vec<Val> = (successor.clone(),).into_val(&f.env);
    for signing in [
        std::vec![&trustee],
        std::vec![&successor],
        std::vec![&f.governor, &successor],
    ] {
        sign_only(&f, &signing, "hand_over_trustee", args.clone());
        assert!(f.client.try_hand_over_trustee(&successor).is_err());
    }
    f.env.mock_all_auths();
    f.client.hand_over_trustee(&successor);
    let signed = signers(&f);
    assert_eq!(signed.len(), 2);
    assert!(signed.contains(&trustee) && signed.contains(&successor));
    assert_eq!(
        own_events(&f),
        std::vec![TrusteeChanged {
            previous: trustee.clone(),
            trustee: successor.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.trustee(), Some(successor.clone()));
    // The previous trustee no longer acts.
    f.client.propose_upgrade(&wasm_hash(&f.env, 2));
    assert_eq!(
        f.client.try_cancel_upgrade(&trustee),
        Err(Ok(Error::Unauthorized))
    );
    f.client.cancel_upgrade(&successor);
    // Without a trustee there is nothing to hand over.
    let (g, _) = ready();
    assert_eq!(
        g.client.try_hand_over_trustee(&Address::generate(&g.env)),
        Err(Ok(Error::Unauthorized))
    );
}

/// A proposal made during bootstrap without the trustee's consent does not
/// survive its naming.
#[test]
fn naming_a_trustee_drops_proposals_made_without_it() {
    let f = bare();
    let hash = wasm_hash(&f.env, 3);
    f.client.propose_upgrade(&hash);
    let successor = Address::generate(&f.env);
    f.client.force_guardian_change(&successor);
    let trustee = Address::generate(&f.env);
    f.client.set_trustee(&trustee);
    assert_eq!(
        own_events(&f),
        std::vec![
            UpgradeCancelled {
                wasm_hash: hash,
                by: f.contract_id.clone()
            }
            .to_xdr(&f.env, &f.contract_id),
            ForcedGuardianChangeCancelled {
                guardian: successor,
                by: f.contract_id.clone()
            }
            .to_xdr(&f.env, &f.contract_id),
            TrusteeSet { trustee }.to_xdr(&f.env, &f.contract_id)
        ]
    );
    assert_eq!(f.client.pending_upgrade(), None);
    assert_eq!(f.client.pending_forced_guardian_change(), None);
}

/// The intended property: once a trustee is named, no key or sequence of
/// governance changes removes it. A lost trustee key means no upgrade ever
/// (decision S15 in practice); exits are unaffected.
#[test]
fn a_lost_trustee_key_blocks_upgrades_for_good() {
    let (f, trustee) = ready_with_trustee();
    let offer_id = 1;
    let repo_id = open(&f, offer_id);
    // A new governor and a new guardian change nothing.
    let governor = Address::generate(&f.env);
    f.client.set_admin(&governor);
    advance(&f, DEFAULT_TIMELOCK_SECS);
    f.client.accept_admin();
    let guardian = Address::generate(&f.env);
    f.client.set_guardian(&guardian);
    advance(&f, DEFAULT_TIMELOCK_SECS);
    f.client.apply_guardian_change();
    assert_eq!(f.client.trustee(), Some(trustee.clone()));
    assert_eq!(
        f.client.try_set_trustee(&governor),
        Err(Ok(Error::TrusteeFixed))
    );
    let hash = wasm_hash(&f.env, 4);
    sign_only(
        &f,
        &[&governor, &guardian],
        "propose_upgrade",
        (hash.clone(),).into_val(&f.env),
    );
    assert!(f.client.try_propose_upgrade(&hash).is_err());
    let replacement_trustee = Address::generate(&f.env);
    sign_only(
        &f,
        &[&governor, &guardian, &replacement_trustee],
        "hand_over_trustee",
        (replacement_trustee.clone(),).into_val(&f.env),
    );
    assert!(f
        .client
        .try_hand_over_trustee(&replacement_trustee)
        .is_err());
    f.env.mock_all_auths();
    assert_eq!(f.client.pending_upgrade(), None);
    assert_eq!(f.client.trustee(), Some(trustee));
    // Exits never needed it.
    f.client.repurchase(&repo_id);
}

// ---------------------------------------------------------------------------
// Audit candidate rc2: approvals bound to the current steward
// ---------------------------------------------------------------------------

/// After a steward rotation, an approval the previous steward granted backs
/// no new offer and no new loan on an existing offer, until the current
/// steward co-signs the lender's attestation and approves it again (second
/// review of rc2, M2).
#[test]
fn a_new_offer_needs_the_current_stewards_approval() {
    let (f, offer_id) = ready();
    let next_steward = Address::generate(&f.env);
    let mut config = replacement(&f);
    config.steward = next_steward.clone();
    f.client.set_fund(&f.shares, &config);
    advance(&f, DEFAULT_TIMELOCK_SECS);
    publish_nav(&f, NAV_EUR);
    f.client.apply_fund_change(&f.shares);
    assert!(!f.client.is_lender_approved(&f.shares, &f.lender));
    let create = |f: &Fixture| {
        f.client.try_create_offer(
            &f.lender,
            &f.eurc,
            &(1_000 * ONE),
            &RATE_BPS,
            &(7 * DAY),
            &vec![&f.env, f.shares.clone()],
        )
    };
    assert_eq!(create(&f), Err(Ok(Error::LenderNotApproved)));
    assert_eq!(
        f.client.try_open_repo(
            &f.borrower,
            &offer_id,
            &f.shares,
            &(10_000 * ONE),
            &(10_000 * ONE),
            &(64 * HOUR)
        ),
        Err(Ok(Error::LenderNotApproved))
    );

    // The current steward cannot approve without a fresh attestation.
    assert_eq!(
        f.client.try_approve_lender(&f.shares, &f.lender, &true),
        Err(Ok(Error::AttestationMissing))
    );
    f.client
        .attest_lender(&f.shares, &f.lender, &declaration(&f.env, 0x51));
    assert!(signers(&f).contains(&next_steward));
    // Attested but not yet approved by the current steward: still no offer.
    assert_eq!(create(&f), Err(Ok(Error::LenderNotApproved)));
    f.client.approve_lender(&f.shares, &f.lender, &true);
    assert!(f.client.is_lender_approved(&f.shares, &f.lender));
    assert!(create(&f).is_ok());
    open(&f, offer_id);
}

/// The same after a recovery: no new offer and no new loan.
#[test]
fn a_recovered_steward_must_approve_again_before_new_offers() {
    let (f, offer_id) = ready();
    appoint_guardian(&f);
    let backup = Address::generate(&f.env);
    f.client.set_steward_backup(&f.shares, &backup);
    f.client.propose_steward_recovery(&f.shares, &backup);
    advance(&f, MAX_TIMELOCK_SECS);
    f.client.apply_steward_recovery(&f.shares);
    publish_nav(&f, NAV_EUR);
    assert_eq!(
        f.client.try_create_offer(
            &f.lender,
            &f.eurc,
            &ONE,
            &RATE_BPS,
            &DAY,
            &vec![&f.env, f.shares.clone()]
        ),
        Err(Ok(Error::LenderNotApproved))
    );
    assert_eq!(
        f.client.try_open_repo(
            &f.borrower,
            &offer_id,
            &f.shares,
            &(10_000 * ONE),
            &(10_000 * ONE),
            &(64 * HOUR)
        ),
        Err(Ok(Error::LenderNotApproved))
    );
}

// ---------------------------------------------------------------------------
// Audit candidate rc2: replacing a steward backup waits for the delay
// ---------------------------------------------------------------------------

#[test]
fn replacing_a_steward_backup_waits_for_the_delay() {
    let (f, _) = ready();
    let first = Address::generate(&f.env);
    f.client.set_steward_backup(&f.shares, &first);
    assert_eq!(f.client.steward_backup(&f.shares), Some(first.clone()));

    let second = Address::generate(&f.env);
    let args: soroban_sdk::Vec<Val> = (f.shares.clone(), second.clone()).into_val(&f.env);
    sign_only(&f, &[&f.steward], "set_steward_backup", args);
    assert!(f.client.try_set_steward_backup(&f.shares, &second).is_err());
    f.env.mock_all_auths();
    f.client.set_steward_backup(&f.shares, &second);
    let signed = signers(&f);
    assert!(signed.contains(&f.steward) && signed.contains(&second));
    let eta = T0 + DEFAULT_TIMELOCK_SECS;
    assert_eq!(
        own_events(&f),
        std::vec![StewardBackupChangeProposed {
            fund: f.shares.clone(),
            backup: second.clone(),
            eta
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(
        f.client.pending_steward_backup(&f.shares),
        Some(PendingStewardBackup {
            backup: second.clone(),
            steward: f.steward.clone(),
            eta
        })
    );
    // The current backup stays the only one until the apply.
    assert_eq!(f.client.steward_backup(&f.shares), Some(first.clone()));
    assert_eq!(
        f.client.try_apply_steward_backup_change(&f.shares),
        Err(Ok(Error::TimelockPending))
    );
    advance(&f, DEFAULT_TIMELOCK_SECS);
    f.env.set_auths(&[]);
    f.client.apply_steward_backup_change(&f.shares);
    assert_eq!(
        own_events(&f),
        std::vec![StewardBackupSet {
            fund: f.shares.clone(),
            backup: second.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.steward_backup(&f.shares), Some(second.clone()));
    assert_eq!(f.client.pending_steward_backup(&f.shares), None);
    f.env.mock_all_auths();
    assert_eq!(
        f.client.try_apply_steward_backup_change(&f.shares),
        Err(Ok(Error::NotProposed))
    );

    // Confirming the current backup cancels a pending replacement.
    let third = Address::generate(&f.env);
    f.client.set_steward_backup(&f.shares, &third);
    f.client.set_steward_backup(&f.shares, &second);
    assert_eq!(
        own_events(&f),
        std::vec![
            StewardBackupChangeCancelled {
                fund: f.shares.clone(),
                backup: third.clone(),
                by: f.steward.clone()
            }
            .to_xdr(&f.env, &f.contract_id),
            StewardBackupSet {
                fund: f.shares.clone(),
                backup: second.clone()
            }
            .to_xdr(&f.env, &f.contract_id)
        ]
    );
    assert_eq!(f.client.pending_steward_backup(&f.shares), None);

    // A replacement not applied in its grace period expires.
    f.client.set_steward_backup(&f.shares, &third);
    advance(&f, DEFAULT_TIMELOCK_SECS + PROPOSAL_GRACE_SECS + 1);
    assert_eq!(f.client.pending_steward_backup(&f.shares), None);
    assert_eq!(
        f.client.try_apply_steward_backup_change(&f.shares),
        Err(Ok(Error::ProposalExpired))
    );
}

/// The thief of a steward key swaps the backup for its own: the governor
/// cancels the swap, or governance proposes a recovery to the backup still in
/// place, which drops the swap.
#[test]
fn a_stolen_steward_key_cannot_swap_the_backup_under_a_recovery() {
    let (f, _) = ready();
    let guardian = appoint_guardian(&f);
    let backup = Address::generate(&f.env);
    f.client.set_steward_backup(&f.shares, &backup);
    let thief = Address::generate(&f.env);

    f.client.set_steward_backup(&f.shares, &thief);
    let intruder = Address::generate(&f.env);
    for caller in [&guardian, &intruder, &thief] {
        assert_eq!(
            f.client.try_cancel_steward_backup_change(&f.shares, caller),
            Err(Ok(Error::Unauthorized))
        );
    }
    f.client
        .cancel_steward_backup_change(&f.shares, &f.governor);
    assert_eq!(f.env.auths()[0].0, f.governor);
    assert_eq!(
        own_events(&f),
        std::vec![StewardBackupChangeCancelled {
            fund: f.shares.clone(),
            backup: thief.clone(),
            by: f.governor.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(
        f.client
            .try_cancel_steward_backup_change(&f.shares, &f.governor),
        Err(Ok(Error::NotProposed))
    );

    // During the delay, only the backup in place can be recovered to, and
    // proposing that recovery drops the swap.
    f.client.set_steward_backup(&f.shares, &thief);
    assert_eq!(
        f.client.try_propose_steward_recovery(&f.shares, &thief),
        Err(Ok(Error::NoStewardBackup))
    );
    f.client.propose_steward_recovery(&f.shares, &backup);
    assert_eq!(
        own_events(&f),
        std::vec![
            StewardBackupChangeCancelled {
                fund: f.shares.clone(),
                backup: thief.clone(),
                by: f.governor.clone()
            }
            .to_xdr(&f.env, &f.contract_id),
            StewardRecoveryProposed {
                fund: f.shares.clone(),
                steward: backup.clone(),
                eta: f.env.ledger().timestamp() + MAX_TIMELOCK_SECS
            }
            .to_xdr(&f.env, &f.contract_id)
        ]
    );
    assert_eq!(f.client.pending_steward_backup(&f.shares), None);
    advance(&f, DEFAULT_TIMELOCK_SECS);
    assert_eq!(
        f.client.try_apply_steward_backup_change(&f.shares),
        Err(Ok(Error::NotProposed))
    );
    advance(&f, MAX_TIMELOCK_SECS - DEFAULT_TIMELOCK_SECS);
    f.client.apply_steward_recovery(&f.shares);
    assert_eq!(f.client.get_fund(&f.shares).unwrap().steward, backup);
}

/// The steward cancels its own swap (a steward action, which also proves its
/// key alive); a swap whose backup was approved as a lender meanwhile is
/// refused; a steward change drops the swap.
#[test]
fn steward_backup_swap_cancel_lender_check_and_steward_change() {
    let (f, _) = ready();
    let first = Address::generate(&f.env);
    f.client.set_steward_backup(&f.shares, &first);
    let second = Address::generate(&f.env);
    f.client.set_steward_backup(&f.shares, &second);
    f.client.cancel_steward_backup_change(&f.shares, &f.steward);
    assert_eq!(f.env.auths()[0].0, f.steward);
    assert_eq!(f.client.pending_steward_backup(&f.shares), None);

    f.client.set_steward_backup(&f.shares, &second);
    admit_lender(&f.client, &f.env, &f.shares, &second);
    advance(&f, DEFAULT_TIMELOCK_SECS);
    assert_eq!(
        f.client.try_apply_steward_backup_change(&f.shares),
        Err(Ok(Error::StewardCannotLend))
    );
    assert_eq!(f.client.steward_backup(&f.shares), Some(first.clone()));

    let third = Address::generate(&f.env);
    f.client.set_steward_backup(&f.shares, &third);
    let mut config = replacement(&f);
    config.steward = Address::generate(&f.env);
    publish_nav(&f, NAV_EUR);
    f.client.set_fund(&f.shares, &config);
    advance(&f, DEFAULT_TIMELOCK_SECS);
    publish_nav(&f, NAV_EUR);
    f.client.apply_fund_change(&f.shares);
    assert!(own_events(&f).events().contains(
        &StewardBackupChangeCancelled {
            fund: f.shares.clone(),
            backup: third,
            by: f.contract_id.clone()
        }
        .to_xdr(&f.env, &f.contract_id)
    ));
    assert_eq!(f.client.pending_steward_backup(&f.shares), None);
    assert_eq!(f.client.steward_backup(&f.shares), None);
}

// ---------------------------------------------------------------------------
// Audit candidate rc2, second review (15 October 2026)
// ---------------------------------------------------------------------------

/// M1: a trustee hand-over drops the upgrade and the forced guardian change
/// the previous trustee co-signed. The new trustee consents to nothing it
/// did not sign, and the governor alone can apply nothing afterwards.
#[test]
fn handing_over_the_trustee_drops_what_the_previous_one_co_signed() {
    let (f, trustee) = ready_with_trustee();
    let hash = wasm_hash(&f.env, 6);
    f.client.propose_upgrade(&hash);
    let forced = Address::generate(&f.env);
    f.client.force_guardian_change(&forced);
    assert!(f.client.pending_upgrade().is_some());
    assert!(f.client.pending_forced_guardian_change().is_some());

    let next = Address::generate(&f.env);
    f.client.hand_over_trustee(&next);
    assert_eq!(
        own_events(&f),
        std::vec![
            UpgradeCancelled {
                wasm_hash: hash.clone(),
                by: f.contract_id.clone()
            }
            .to_xdr(&f.env, &f.contract_id),
            ForcedGuardianChangeCancelled {
                guardian: forced.clone(),
                by: f.contract_id.clone()
            }
            .to_xdr(&f.env, &f.contract_id),
            TrusteeChanged {
                previous: trustee.clone(),
                trustee: next.clone()
            }
            .to_xdr(&f.env, &f.contract_id),
        ]
    );
    assert_eq!(f.client.trustee(), Some(next.clone()));
    assert_eq!(f.client.pending_upgrade(), None);
    assert_eq!(f.client.pending_forced_guardian_change(), None);
    advance(&f, MAX_TIMELOCK_SECS);
    assert_eq!(
        f.client.try_upgrade(&hash),
        Err(Ok(raised(Error::NotProposed)))
    );
    assert_eq!(
        f.client.try_apply_forced_guardian_change(),
        Err(Ok(Error::NotProposed))
    );
}

/// L1: independence holds both ways. The trustee can be named to no other
/// role, during bootstrap or after, and no backup or proposed governor can
/// become the trustee.
#[test]
fn trustee_cannot_be_given_another_role() {
    let f = bare();
    let trustee = Address::generate(&f.env);
    f.client.set_trustee(&trustee);
    let refused = Err(Ok(raised(Error::TrusteeNotIndependent)));
    // During bootstrap a guardian would apply at once: refused all the same.
    assert_eq!(f.client.try_set_guardian(&trustee), refused);
    assert_eq!(f.client.try_set_guardian_backup(&trustee), refused);
    assert_eq!(f.client.try_set_admin(&trustee), refused);

    let (f, _) = ready_from(f);
    appoint_guardian(&f);
    assert_eq!(f.client.try_set_guardian(&trustee), refused);
    assert_eq!(f.client.try_hand_over_guardian(&trustee), refused);
    assert_eq!(f.client.try_force_guardian_change(&trustee), refused);
    assert_eq!(f.client.try_set_guardian_backup(&trustee), refused);
    assert_eq!(f.client.try_set_admin(&trustee), refused);
    assert_eq!(f.client.pending_admin(), None);

    let backup = Address::generate(&f.env);
    f.client.set_guardian_backup(&backup);
    assert_eq!(
        f.client.try_hand_over_trustee(&backup),
        Err(Ok(Error::TrusteeNotIndependent))
    );
    let proposed = Address::generate(&f.env);
    f.client.set_admin(&proposed);
    assert_eq!(
        f.client.try_hand_over_trustee(&proposed),
        Err(Ok(Error::TrusteeNotIndependent))
    );
    assert_eq!(f.client.trustee(), Some(trustee));
}

/// Review finding auth-5 (20 October 2026): the trustee's independence was
/// checked against the roles in office only. A proposed guardian could take
/// the trustee role during the delay and then hold both, so that the
/// governor and that one key proposed upgrades; the sentinel, a hot key,
/// could take it too. Both are refused, and a guardian change is checked
/// again when it applies, for a proposal made before rc5.
#[test]
fn trustee_cannot_be_a_proposed_guardian_or_the_sentinel() {
    let f = bare();
    let sentinel = Address::generate(&f.env);
    f.client.set_sentinel(&sentinel);
    assert_eq!(
        f.client.try_set_trustee(&sentinel),
        Err(Ok(Error::TrusteeNotIndependent))
    );
    f.client.clear_sentinel(&f.governor);
    let trustee = Address::generate(&f.env);
    f.client.set_trustee(&trustee);

    let (f, _) = ready_from(f);
    let proposed = Address::generate(&f.env);
    f.client.set_guardian(&proposed);
    assert_eq!(
        f.client.try_hand_over_trustee(&proposed),
        Err(Ok(Error::TrusteeNotIndependent))
    );
    let sentinel = Address::generate(&f.env);
    f.client.set_sentinel(&sentinel);
    assert_eq!(
        f.client.try_hand_over_trustee(&sentinel),
        Err(Ok(Error::TrusteeNotIndependent))
    );
    assert_eq!(f.client.trustee(), Some(trustee.clone()));

    // Under rc4 the proposed guardian could become trustee, or sentinel,
    // during the delay: the apply refuses either.
    let instance_set = |key: DataKey, who: &Address| {
        f.env.as_contract(&f.contract_id, || {
            f.env.storage().instance().set(&key, who);
        });
    };
    instance_set(DataKey::Trustee, &proposed);
    advance(&f, DEFAULT_TIMELOCK_SECS);
    assert_eq!(
        f.client.try_apply_guardian_change(),
        Err(Ok(Error::TrusteeNotIndependent))
    );
    instance_set(DataKey::Trustee, &trustee);
    instance_set(DataKey::Sentinel, &proposed);
    assert_eq!(
        f.client.try_apply_guardian_change(),
        Err(Ok(Error::SentinelNotIndependent))
    );
    f.client.clear_sentinel(&f.governor);
    f.client.apply_guardian_change();
    assert_eq!(f.client.guardian(), proposed);
    assert_eq!(f.client.trustee(), Some(trustee));
}

/// Review finding auth-5 (20 October 2026): the sentinel, the monitoring
/// host's hot key, holds no other role, now checked both ways. No role,
/// backup, sole lender or proposal may name it, during bootstrap or after;
/// and no key about to take a role, as proposed governor or guardian,
/// forced or not, may be named sentinel.
#[test]
fn sentinel_cannot_be_given_another_role() {
    let f = bare();
    let sentinel = Address::generate(&f.env);
    f.client.set_sentinel(&sentinel);
    let refused = Err(Ok(raised(Error::SentinelNotIndependent)));
    assert_eq!(f.client.try_set_guardian(&sentinel), refused);
    assert_eq!(f.client.try_hand_over_guardian(&sentinel), refused);
    assert_eq!(f.client.try_set_guardian_backup(&sentinel), refused);
    assert_eq!(f.client.try_force_guardian_change(&sentinel), refused);
    assert_eq!(f.client.try_set_admin(&sentinel), refused);
    assert_eq!(
        f.client.try_set_sole_lender(&sentinel),
        Err(Ok(Error::SentinelNotIndependent))
    );
    assert_eq!(f.client.guardian(), f.governor);
    assert_eq!(f.client.guardian_backup(), None);
    assert_eq!(f.client.pending_admin(), None);
    assert_eq!(f.client.sole_lender(), None);

    let (f, _) = ready_from(f);
    assert_eq!(f.client.try_set_guardian(&sentinel), refused);
    assert_eq!(f.client.pending_guardian_change(), None);

    let proposed_governor = Address::generate(&f.env);
    f.client.set_admin(&proposed_governor);
    let proposed_guardian = Address::generate(&f.env);
    f.client.set_guardian(&proposed_guardian);
    let forced_guardian = Address::generate(&f.env);
    f.client.force_guardian_change(&forced_guardian);
    for candidate in [&proposed_governor, &proposed_guardian, &forced_guardian] {
        assert_eq!(
            f.client.try_set_sentinel(candidate),
            Err(Ok(Error::SentinelNotIndependent))
        );
    }
    assert_eq!(f.client.sentinel(), Some(sentinel));
}

/// Review finding STATE-1 (20 October 2026): since rc5 the sentinel is
/// refused as a forced guardian and as a trustee, and the guardian alone
/// could put any address in that slot. A hostile guardian named the
/// governor's candidate for a forced change, or the trustee's chosen
/// successor, and blocked the recovery path against itself. Naming a
/// sentinel now takes the named key's signature as well as the guardian's:
/// the guardian alone names nobody, the forced change and the handover go
/// through, and the guardian with the key's consent names it.
#[test]
fn naming_a_sentinel_takes_its_own_signature() {
    let f = bare();
    let guardian = appoint_guardian(&f);
    let trustee = Address::generate(&f.env);
    f.client.set_trustee(&trustee);
    let candidate = Address::generate(&f.env);
    let successor = Address::generate(&f.env);
    for named in [&candidate, &successor] {
        let args: soroban_sdk::Vec<Val> = (named.clone(),).into_val(&f.env);
        sign_only(&f, &[&guardian], "set_sentinel", args);
        assert!(f.client.try_set_sentinel(named).is_err());
        f.env.mock_all_auths();
        assert_eq!(f.client.sentinel(), None);
    }
    f.client.force_guardian_change(&candidate);
    assert_eq!(
        f.client
            .pending_forced_guardian_change()
            .map(|pending| pending.guardian),
        Some(candidate)
    );
    f.client.hand_over_trustee(&successor);
    assert_eq!(f.client.trustee(), Some(successor));

    let sentinel = Address::generate(&f.env);
    let args: soroban_sdk::Vec<Val> = (sentinel.clone(),).into_val(&f.env);
    sign_only(&f, &[&guardian, &sentinel], "set_sentinel", args);
    f.client.set_sentinel(&sentinel);
    assert_eq!(signers(&f), std::vec![guardian, sentinel.clone()]);
    f.env.mock_all_auths();
    assert_eq!(f.client.sentinel(), Some(sentinel));
}

/// Review finding STATE-1: the checks that keep the trustee and the
/// sentinel out of other roles counted a pending appointment after it had
/// expired, when it can never apply. A governor or guardian proposal then
/// held the trustee's chosen successor out for good, and the trustee
/// cannot cancel it. A live proposal still refuses the address it names;
/// an expired one no longer does, and still never applies.
#[test]
fn an_expired_appointment_no_longer_blocks_the_trustee_or_the_sentinel() {
    let f = bare();
    let trustee = Address::generate(&f.env);
    f.client.set_trustee(&trustee);
    let (f, _) = ready_from(f);
    let next_guardian = Address::generate(&f.env);
    let next_governor = Address::generate(&f.env);
    let forced = Address::generate(&f.env);
    f.client.set_guardian(&next_guardian);
    f.client.set_admin(&next_governor);
    f.client.force_guardian_change(&forced);
    for candidate in [&next_guardian, &next_governor] {
        assert_eq!(
            f.client.try_hand_over_trustee(candidate),
            Err(Ok(Error::TrusteeNotIndependent))
        );
    }
    for candidate in [&next_guardian, &next_governor, &forced] {
        assert_eq!(
            f.client.try_set_sentinel(candidate),
            Err(Ok(Error::SentinelNotIndependent))
        );
    }

    // The guardian and governor appointments expire; the forced one, with
    // its 30-day delay, is still live.
    advance(&f, DEFAULT_TIMELOCK_SECS + PROPOSAL_GRACE_SECS + 1);
    assert_eq!(f.client.pending_guardian_change(), None);
    assert_eq!(f.client.pending_admin(), None);
    assert_eq!(
        f.client.try_set_sentinel(&forced),
        Err(Ok(Error::SentinelNotIndependent))
    );
    f.client.set_sentinel(&next_governor);
    assert_eq!(f.client.sentinel(), Some(next_governor.clone()));
    assert_eq!(f.client.try_accept_admin(), Err(Ok(Error::ProposalExpired)));

    // Then the forced one.
    advance(&f, MAX_TIMELOCK_SECS);
    assert_eq!(f.client.pending_forced_guardian_change(), None);
    f.client.set_sentinel(&forced);
    assert_eq!(f.client.sentinel(), Some(forced));
    assert_eq!(
        f.client.try_apply_forced_guardian_change(),
        Err(Ok(Error::ProposalExpired))
    );

    f.client.hand_over_trustee(&next_guardian);
    assert_eq!(f.client.trustee(), Some(next_guardian));
    assert_eq!(
        f.client.try_apply_guardian_change(),
        Err(Ok(Error::ProposalExpired))
    );
    assert_eq!(f.client.guardian(), f.governor);
}

/// Test 7 of the second review: the positive control of the signature
/// requirement, with exactly the governor and the trustee signing.
#[test]
fn naming_the_trustee_takes_the_governor_and_the_trustee() {
    let f = bare();
    let trustee = Address::generate(&f.env);
    let args: soroban_sdk::Vec<Val> = (trustee.clone(),).into_val(&f.env);
    sign_only(&f, &[&f.governor, &trustee], "set_trustee", args);
    f.client.set_trustee(&trustee);
    assert_eq!(f.client.trustee(), Some(trustee));
}

/// M2: a steward rotation ends the lending of the lenders the previous
/// steward approved, on offers already made too, while the positions they
/// opened before stay deliverable to them (decision S8): the approval stays
/// on record, so the seized shares reach the lender at once. A revocation
/// removes it; the seizure still settles and the shares wait for a new
/// approval, as tested by
/// `a_revoked_lender_still_seizes_and_its_shares_wait_for_an_approval`.
#[test]
fn a_steward_rotation_stops_new_loans_but_not_the_seizure_of_old_ones() {
    let (f, offer_id) = ready();
    let repo_id = open(&f, offer_id);
    let next_steward = Address::generate(&f.env);
    let mut config = replacement(&f);
    config.steward = next_steward.clone();
    f.client.set_fund(&f.shares, &config);
    advance(&f, DEFAULT_TIMELOCK_SECS);
    publish_nav(&f, NAV_EUR);
    f.client.apply_fund_change(&f.shares);
    assert!(!f.client.is_lender_approved(&f.shares, &f.lender));
    assert_eq!(
        f.client.try_open_repo(
            &f.borrower,
            &offer_id,
            &f.shares,
            &(10_000 * ONE),
            &(10_000 * ONE),
            &(64 * HOUR)
        ),
        Err(Ok(Error::LenderNotApproved))
    );

    // The repo opened before matures unpaid: the lender still receives the shares.
    advance(&f, 65 * HOUR);
    f.client.seize(&repo_id, &f.lender);
    assert_eq!(
        f.client.get_repo(&repo_id).unwrap().status,
        RepoStatus::Defaulted
    );
    assert_eq!(balance(&f.env, &f.shares, &f.lender), 10_000 * ONE);
    assert_eq!(f.client.pending_release(&repo_id), None);

    // The current steward attests and approves: lending resumes on the same offer.
    f.client
        .attest_lender(&f.shares, &f.lender, &declaration(&f.env, 0x52));
    f.client.approve_lender(&f.shares, &f.lender, &true);
    assert!(f.client.is_lender_approved(&f.shares, &f.lender));
    publish_nav(&f, NAV_EUR);
    open(&f, offer_id);
}

/// L2 and test 5 of the second review: once the governor cancels a backup
/// replacement nothing applies it, and after a rotation the previous
/// steward's proposal is gone and that steward can no longer cancel.
#[test]
fn a_cancelled_or_orphaned_backup_replacement_never_applies() {
    let (f, _) = ready();
    let backup = Address::generate(&f.env);
    f.client.set_steward_backup(&f.shares, &backup);
    let other = Address::generate(&f.env);
    f.client.set_steward_backup(&f.shares, &other);
    f.client
        .cancel_steward_backup_change(&f.shares, &f.governor);
    advance(&f, DEFAULT_TIMELOCK_SECS);
    assert_eq!(
        f.client.try_apply_steward_backup_change(&f.shares),
        Err(Ok(Error::NotProposed))
    );
    assert_eq!(f.client.steward_backup(&f.shares), Some(backup.clone()));

    f.client.set_steward_backup(&f.shares, &other);
    assert!(f.client.pending_steward_backup(&f.shares).is_some());
    let next_steward = Address::generate(&f.env);
    let mut config = replacement(&f);
    config.steward = next_steward.clone();
    publish_nav(&f, NAV_EUR);
    f.client.set_fund(&f.shares, &config);
    advance(&f, DEFAULT_TIMELOCK_SECS);
    publish_nav(&f, NAV_EUR);
    f.client.apply_fund_change(&f.shares);
    assert_eq!(f.client.pending_steward_backup(&f.shares), None);
    assert_eq!(
        f.client.try_apply_steward_backup_change(&f.shares),
        Err(Ok(Error::NotProposed))
    );
    assert_eq!(
        f.client
            .try_cancel_steward_backup_change(&f.shares, &f.steward),
        Err(Ok(Error::Unauthorized))
    );
}

/// Test 6 of the second review: under a trustee, an upgrade proposed by the
/// governor and the trustee applies after the delay, and the trustee stays.
#[test]
fn an_upgrade_applies_under_a_trustee() {
    let (f, trustee) = ready_with_trustee();
    let hash = f.env.deployer().upload_contract_wasm(NIGHT_WINDOW_WASM);
    f.client.propose_upgrade(&hash);
    let signed = signers(&f);
    assert!(signed.contains(&f.governor) && signed.contains(&trustee));
    advance(&f, DEFAULT_TIMELOCK_SECS);
    f.client.upgrade(&hash);
    assert_eq!(
        executable_hash(&f.env, &f.contract_id),
        Some(hash.to_array())
    );
    assert_eq!(f.client.trustee(), Some(trustee));
    f.client.version();
}

// ---------------------------------------------------------------------------
// Technical watch (15 October 2026)
// ---------------------------------------------------------------------------

/// The ledger up to which a persistent entry of the contract lives, read
/// from the ledger snapshot: unlike `entry_ttl`, this works for an archived
/// entry too.
fn live_until(f: &Fixture, key: &DataKey) -> u32 {
    use soroban_sdk::xdr::{LedgerKey, ScAddress, ScVal};
    use soroban_sdk::TryFromVal;
    let address = ScAddress::from(&f.contract_id);
    let key: Val = key.into_val(&f.env);
    let key = ScVal::try_from_val(&f.env, &key).unwrap();
    f.env
        .to_ledger_snapshot()
        .ledger_entries
        .iter()
        .find_map(|(ledger_key, (_, live_until))| match ledger_key.as_ref() {
            LedgerKey::ContractData(data) if data.contract == address && data.key == key => {
                *live_until
            }
            _ => None,
        })
        .unwrap()
}

/// (a) Exits on archived entries. The TTL policy keeps every entry an exit
/// needs live for the life of a repo: the repo is written with 120 days, the
/// approval extended to at least 45 days at the opening, and a term lasts 30
/// days at most. Past that, nobody touching the contract for 120 days
/// archives them. Since protocol 23 (CAP-66) an invocation restores the
/// archived persistent entries of its footprint itself, at the caller's
/// expense, and the test host models that: the exit works, and the restore
/// shows as extra written entries. On a network without automatic
/// restoration, any account would first submit a RestoreFootprint operation
/// for the same entries; nothing in the contract needs them live.
#[test]
fn exits_work_on_archived_entries() {
    // The policy, in ledgers of 5 seconds.
    let lender_threshold = 45 * 17_280;
    assert!(MAX_TERM_CEILING_SECS / 5 < u64::from(lender_threshold));
    assert!(lender_threshold < BUMP_TO_LEDGERS);
    let (f, offer_id) = ready();
    let repurchased = open(&f, offer_id);
    let seized = open(&f, offer_id);
    let opened_at = f.env.ledger().sequence();
    let repo_key = DataKey::Repo(seized);
    let lender_key = DataKey::Lender(f.shares.clone(), f.lender.clone());
    assert_eq!(live_until(&f, &repo_key), opened_at + BUMP_TO_LEDGERS);
    assert!(live_until(&f, &lender_key) >= opened_at + lender_threshold);

    // A reference exit on live entries, in a twin fixture.
    let (g, g_offer) = ready();
    let g_repo = open(&g, g_offer);
    advance(&g, HOUR);
    g.client.repurchase(&g_repo);
    let live = footprint(&g.env);

    // Nobody touches anything for 121 days.
    f.env.ledger().with_mut(|ledger| {
        ledger.sequence_number += BUMP_TO_LEDGERS + 17_280;
        ledger.timestamp += 121 * DAY;
    });
    let now = f.env.ledger().sequence();
    for key in [&repo_key, &DataKey::Repo(repurchased), &lender_key] {
        assert!(live_until(&f, key) < now, "archived");
    }
    f.client.repurchase(&repurchased);
    let restored = footprint(&f.env);
    assert!(
        restored.1 > live.1,
        "{} entries written, {} without archival",
        restored.1,
        live.1
    );
    assert_eq!(
        f.client.get_repo(&repurchased).unwrap().status,
        RepoStatus::Repurchased
    );
    f.client.seize(&seized, &f.lender);
    assert_eq!(
        f.client.get_repo(&seized).unwrap().status,
        RepoStatus::Defaulted
    );
    // The exit extended what it restored.
    assert_eq!(live_until(&f, &repo_key), now + BUMP_TO_LEDGERS);
    assert_eq!(live_until(&f, &lender_key), now + BUMP_TO_LEDGERS);
    std::println!(
        "repurchase on archived entries: {} read, {} written (live: {} read, {} written)",
        restored.0,
        restored.1,
        live.0,
        live.1
    );
}

/// `ready_with_fallback` plus a distinct guardian; both feeds then publish
/// again, so that only the fallback's behaviour decides.
fn ready_with_fallback_and_guardian() -> (Fixture, u64, MockOracleClient<'static>, Address) {
    let (f, offer_id, feed) = ready_with_fallback();
    let guardian = appoint_guardian(&f);
    publish_nav(&f, NAV_EUR);
    publish_on(&f, &feed, NAV_EUR_8);
    (f, offer_id, feed, guardian)
}

/// (b) A backup feed that burns the CPU budget. `try_` calls do not catch
/// budget exhaustion (documented host limit): the whole call fails although
/// the primary feed is fresh, not only the backup's reading. Even the test
/// client's `try_` cannot return it: the host escalates the exhaustion to a
/// panic, caught here. The test host is unusable after that panic, so the
/// remedy is shown by the next test.
#[test]
fn a_fallback_that_burns_the_budget_fails_the_whole_call() {
    let (f, offer_id, feed, _) = ready_with_fallback_and_guardian();
    open(&f, offer_id);
    feed.set_burning(&true);
    let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = f.client.try_open_repo(
            &f.borrower,
            &offer_id,
            &f.shares,
            &(10_000 * ONE),
            &(10_000 * ONE),
            &(64 * HOUR),
        );
    }))
    .expect_err("the opening fails as a whole");
    let message = payload
        .downcast_ref::<std::string::String>()
        .cloned()
        .unwrap_or_default();
    assert!(message.contains("Budget, ExceededLimit"), "{message}");
}

/// (b, continued) The guardian alone removes the burning backup, at once,
/// and pricing works again on the primary feed.
#[test]
fn removing_a_burning_fallback_restores_pricing() {
    let (f, offer_id, feed, guardian) = ready_with_fallback_and_guardian();
    feed.set_burning(&true);
    f.client.remove_fallback(&f.shares, &guardian);
    assert_eq!(signers(&f), std::vec![guardian]);
    assert_eq!(f.client.get_fallback(&f.shares), None);
    assert_eq!(f.client.quote(&f.shares, &ONE, &f.eurc).price, NAV_EUR);
    open(&f, offer_id);
}

/// (c) Two large NAV moves in a row, each at the very top of the corridor at
/// its own time. The corridor is measured from the reference, which follows
/// the model path, never the NAV: the floor tolerance is granted once, not
/// accumulated, and a second move measured from the first NAV is refused.
#[test]
fn two_moves_at_the_top_of_the_corridor_cannot_ratchet_the_reference() {
    let (f, _) = ready();
    let config = fund_config(&f);
    let corridor = |reference: i128, from: u64, to: u64| {
        math::corridor(
            reference,
            from,
            to,
            config.corridor_floor_bps,
            config.max_yield_bps,
            config.nav_max_age_secs,
        )
        .unwrap()
        .1
    };
    let path = |reference: i128, from: u64, to: u64| {
        math::model_path(
            reference,
            from,
            to,
            config.max_yield_bps,
            config.nav_max_age_secs,
        )
        .unwrap()
    };
    let (t1, t2) = (T0 + DAY, T0 + 2 * DAY);

    advance(&f, DAY);
    let first = corridor(NAV_EUR, T0, t1);
    publish_nav(&f, first);
    assert_eq!(f.client.quote(&f.shares, &ONE, &f.eurc).price, first);
    f.client.refresh_reference(&f.shares);
    let reference = f.client.get_fund_state(&f.shares).unwrap().reference_nav;
    assert_eq!(reference, path(NAV_EUR, T0, t1));
    assert!(reference < first);

    advance(&f, DAY);
    let ratchet = corridor(first, t1, t2);
    publish_nav(&f, ratchet);
    assert_eq!(
        f.client.try_refresh_reference(&f.shares),
        Err(Ok(Error::PriceOutOfBand))
    );
    assert_eq!(
        f.client.try_quote(&f.shares, &ONE, &f.eurc),
        Err(Ok(Error::PriceOutOfBand))
    );

    let second = corridor(reference, t1, t2);
    assert!(second < ratchet);
    publish_nav(&f, second);
    f.client.refresh_reference(&f.shares);
    let reference = f.client.get_fund_state(&f.shares).unwrap().reference_nav;
    assert_eq!(reference, path(path(NAV_EUR, T0, t1), t1, t2));
    // Chaining two steps of the path compounds the yield, a second-order
    // excess (about 2e-8 here), far below the floor (1e-3). Each step spans
    // a day, within the NAV age bound, so the comparison is with the
    // two-day path itself, which a single update could no longer take
    // (rc5: one update grows the reference by at most one NAV age).
    let single = math::model_path(NAV_EUR, T0, t2, config.max_yield_bps, u64::MAX).unwrap();
    assert!(path(NAV_EUR, T0, t2) < single);
    assert!(reference >= single && reference - single < NAV_EUR / 1_000_000);
    // A third move measured from the second NAV is refused as well.
    advance(&f, DAY);
    publish_nav(&f, corridor(second, t2, t2 + DAY));
    assert_eq!(
        f.client.try_refresh_reference(&f.shares),
        Err(Ok(Error::PriceOutOfBand))
    );
}

// ---------------------------------------------------------------------------
// rc4: stablecoin registration behind the delay, sentinel, schema version
// ---------------------------------------------------------------------------

/// Covers: S5, S7
#[test]
fn stablecoin_registration_is_immediate_before_admission_and_waits_after() {
    let (f, _offer_id) = ready();
    // EURC was registered before the admission: at once.
    assert!(f.client.get_stablecoin(&f.eurc).is_some());
    let usdc = new_token(&f.env);
    let eta = f.env.ledger().timestamp() + f.client.timelock_delay();
    f.client.set_stablecoin(&usdc, &usd(&f.env));
    assert_eq!(f.env.auths()[0].0, f.governor);
    assert_eq!(
        own_events(&f),
        std::vec![StablecoinChangeProposed {
            stablecoin: usdc.clone(),
            currency: usd(&f.env),
            eta
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.get_stablecoin(&usdc), None);
    assert_eq!(
        f.client.pending_stablecoin_change(&usdc),
        Some(PendingStablecoinChange {
            currency: usd(&f.env),
            eta
        })
    );
    // Nobody lends in it meanwhile.
    assert_eq!(
        f.client.try_create_offer(
            &f.lender,
            &usdc,
            &(1_000 * ONE),
            &RATE_BPS,
            &(7 * DAY),
            &vec![&f.env, f.shares.clone()],
        ),
        Err(Ok(Error::StablecoinNotAccepted))
    );
    assert_eq!(
        f.client.try_apply_stablecoin_change(&usdc),
        Err(Ok(Error::TimelockPending))
    );
    advance(&f, f.client.timelock_delay());
    f.client.apply_stablecoin_change(&usdc);
    assert_eq!(signers(&f), std::vec![f.governor.clone()]);
    assert_eq!(
        f.client.get_stablecoin(&usdc).unwrap().currency,
        usd(&f.env)
    );
    assert_eq!(f.client.pending_stablecoin_change(&usdc), None);
    assert_eq!(
        f.client.try_apply_stablecoin_change(&usdc),
        Err(Ok(Error::NotProposed))
    );
}

/// Covers: S5, S7
#[test]
fn a_proposed_stablecoin_is_cancelled_dropped_by_a_removal_or_expires() {
    let (f, _offer_id) = ready();
    let guardian = appoint_guardian(&f);
    let usdc = new_token(&f.env);
    f.client.set_stablecoin(&usdc, &usd(&f.env));
    let intruder = Address::generate(&f.env);
    assert_eq!(
        f.client.try_cancel_stablecoin_change(&usdc, &intruder),
        Err(Ok(Error::Unauthorized))
    );
    f.client.cancel_stablecoin_change(&usdc, &guardian);
    assert_eq!(f.client.pending_stablecoin_change(&usdc), None);
    assert_eq!(
        f.client.try_cancel_stablecoin_change(&usdc, &guardian),
        Err(Ok(Error::NotProposed))
    );
    // A currency change of a registered token waits too; removing the token drops it.
    f.client.set_stablecoin(&f.eurc, &usd(&f.env));
    assert!(f.client.pending_stablecoin_change(&f.eurc).is_some());
    assert_eq!(
        f.client.get_stablecoin(&f.eurc).unwrap().currency,
        eur(&f.env)
    );
    f.client.remove_stablecoin(&f.eurc);
    assert_eq!(f.client.pending_stablecoin_change(&f.eurc), None);
    assert_eq!(f.client.get_stablecoin(&f.eurc), None);
    // An expired proposal is gone and cannot be applied.
    f.client.set_stablecoin(&usdc, &usd(&f.env));
    advance(&f, f.client.timelock_delay() + PROPOSAL_GRACE_SECS + 1);
    assert_eq!(f.client.pending_stablecoin_change(&usdc), None);
    assert_eq!(
        f.client.try_apply_stablecoin_change(&usdc),
        Err(Ok(Error::ProposalExpired))
    );
}

/// Review finding auth-3 (20 October 2026): a governor handover drops what
/// the governor proposed alone, but not a stablecoin registration, kept per
/// token where nothing can list it. A compromised governor key proposes a
/// coin of its own, the operator answers with a handover: the proposal
/// survives it, due. Only the governor in office applies it, so neither the
/// replaced key nor anyone else can, and the successor takes it up or lets
/// it expire.
#[test]
fn a_stablecoin_proposed_by_a_replaced_governor_needs_its_successor() {
    let (f, _offer_id) = ready();
    let rogue = new_token(&f.env);
    f.client.set_stablecoin(&rogue, &usd(&f.env));
    let successor = Address::generate(&f.env);
    f.client.set_admin(&successor);
    advance(&f, DEFAULT_TIMELOCK_SECS);
    f.client.accept_admin();
    assert!(f.client.pending_stablecoin_change(&rogue).is_some());

    let args: soroban_sdk::Vec<Val> = (rogue.clone(),).into_val(&f.env);
    let intruder = Address::generate(&f.env);
    for signer in [&intruder, &f.governor] {
        sign_only(&f, &[signer], "apply_stablecoin_change", args.clone());
        assert!(f.client.try_apply_stablecoin_change(&rogue).is_err());
    }
    f.env.set_auths(&[]);
    assert!(f.client.try_apply_stablecoin_change(&rogue).is_err());
    assert_eq!(f.client.get_stablecoin(&rogue), None);

    sign_only(&f, &[&successor], "apply_stablecoin_change", args);
    f.client.apply_stablecoin_change(&rogue);
    assert_eq!(signers(&f), std::vec![successor]);
    assert_eq!(
        f.client.get_stablecoin(&rogue).unwrap().currency,
        usd(&f.env)
    );
}

/// A SEP-41 token with `decimals` decimals: the demo's allowlisted share
/// token, standing for a Soroban-native or bridged stablecoin.
fn sep41_token(env: &Env, decimals: u32) -> Address {
    env.register(
        fund_token::FundToken,
        (
            Address::generate(env),
            decimals,
            soroban_sdk::String::from_str(env, "Test euro stablecoin"),
            soroban_sdk::String::from_str(env, "tEURX"),
        ),
    )
}

/// Review findings arith-3 and token-3 (20 October 2026): caps and
/// outstanding totals add base units across the stablecoins of a currency.
/// A coin with 6 decimals multiplied every cap by ten, one with 18 made them
/// useless. Only coins with 7 decimals are registered, the decimals of every
/// Stellar classic asset through its Stellar Asset Contract: before the
/// first admission, at once or not at all.
#[test]
fn a_stablecoin_needs_seven_decimals_to_be_registered() {
    let f = bare();
    for decimals in [6, 18] {
        let coin = sep41_token(&f.env, decimals);
        assert_eq!(
            f.client.try_set_stablecoin(&coin, &eur(&f.env)),
            Err(Ok(raised(Error::StablecoinNotAccepted)))
        );
        assert_eq!(f.client.get_stablecoin(&coin), None);
    }
    let coin = sep41_token(&f.env, STABLECOIN_DECIMALS);
    f.client.set_stablecoin(&coin, &eur(&f.env));
    assert_eq!(
        f.client.get_stablecoin(&coin),
        Some(StablecoinConfig {
            currency: eur(&f.env),
            decimals: 7
        })
    );
}

/// After the first admission the decimals are checked at the proposal, so
/// that a coin the registry would refuse never waits for the delay, and
/// again at the apply: a proposal made before rc5 was not checked.
#[test]
fn a_stablecoin_needs_seven_decimals_at_its_proposal_and_its_apply() {
    let (f, _offer_id) = ready();
    let six = sep41_token(&f.env, 6);
    assert_eq!(
        f.client.try_set_stablecoin(&six, &eur(&f.env)),
        Err(Ok(raised(Error::StablecoinNotAccepted)))
    );
    assert_eq!(f.client.pending_stablecoin_change(&six), None);

    // The same coin, proposed under rc4.
    let eta = f.env.ledger().timestamp() + f.client.timelock_delay();
    f.env.as_contract(&f.contract_id, || {
        crate::storage::set_pending_stablecoin(
            &f.env,
            &six,
            &PendingStablecoinChange {
                currency: eur(&f.env),
                eta,
            },
        );
    });
    let seven = sep41_token(&f.env, 7);
    f.client.set_stablecoin(&seven, &eur(&f.env));
    advance(&f, f.client.timelock_delay());
    assert_eq!(
        f.client.try_apply_stablecoin_change(&six),
        Err(Ok(Error::StablecoinNotAccepted))
    );
    assert_eq!(f.client.get_stablecoin(&six), None);
    assert!(f.client.pending_stablecoin_change(&six).is_some());
    f.client.apply_stablecoin_change(&seven);
    assert_eq!(
        f.client.get_stablecoin(&seven),
        Some(StablecoinConfig {
            currency: eur(&f.env),
            decimals: 7
        })
    );
}

/// Covers: S7, S26
#[test]
fn sentinel_pauses_and_cancels_but_neither_vetoes_nor_decides() {
    let (f, _offer_id) = ready();
    let guardian = appoint_guardian(&f);
    let sentinel = Address::generate(&f.env);
    // A sentinel holds no role of weight.
    assert_eq!(
        f.client.try_set_sentinel(&guardian),
        Err(Ok(Error::SentinelNotIndependent))
    );
    assert_eq!(
        f.client.try_set_sentinel(&f.governor),
        Err(Ok(Error::SentinelNotIndependent))
    );
    f.client.set_sentinel(&sentinel);
    assert_eq!(f.env.auths()[0].0, guardian);
    assert_eq!(f.client.sentinel(), Some(sentinel.clone()));
    // Pause: yes. Lifting it stays with the governor.
    f.client.pause(&sentinel);
    assert!(f.client.is_paused());
    f.client.unpause();
    // Cancel an upgrade and a stablecoin proposal: yes.
    f.client.propose_upgrade(&wasm_hash(&f.env, 9));
    f.client.cancel_upgrade(&sentinel);
    assert_eq!(f.client.pending_upgrade(), None);
    let usdc = new_token(&f.env);
    f.client.set_stablecoin(&usdc, &usd(&f.env));
    f.client.cancel_stablecoin_change(&usdc, &sentinel);
    assert_eq!(f.client.pending_stablecoin_change(&usdc), None);
    // Veto a governor handover: no, that is the guardian's and the trustee's.
    let successor = Address::generate(&f.env);
    f.client.set_admin(&successor);
    assert_eq!(
        f.client.try_veto_admin(&sentinel),
        Err(Ok(Error::Unauthorized))
    );
    f.client.cancel_admin();
    // Cleared by the governor, it can do nothing; a stranger cannot clear it.
    let stranger = Address::generate(&f.env);
    assert_eq!(
        f.client.try_clear_sentinel(&stranger),
        Err(Ok(Error::Unauthorized))
    );
    f.client.clear_sentinel(&f.governor);
    assert_eq!(f.client.sentinel(), None);
    assert_eq!(f.client.try_pause(&sentinel), Err(Ok(Error::Unauthorized)));
}

/// Covers: S14, S15
#[test]
fn a_fresh_instance_is_at_the_current_schema_and_has_nothing_to_migrate() {
    let f = bare();
    assert_eq!(f.client.schema_version(), SCHEMA_VERSION);
    assert_eq!(f.client.try_migrate(), Err(Ok(Error::NothingToMigrate)));
}

/// The WASM deployed as rc2 on testnet (hash 5cdbfd0c…), kept so that the
/// upgrade path from a live layout is exercised, not only the same-code one.
#[cfg(night_window_wasm)]
const RC2_WASM: &[u8] = include_bytes!("../tests/fixtures/night_window_rc2.wasm");

/// Covers: S6, S14, S15
#[cfg(night_window_wasm)]
#[test]
fn an_rc2_instance_upgrades_then_migrates_with_a_repo_open() {
    // The `bare` fixture, on the rc2 code.
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(T0);
    let governor = Address::generate(&env);
    let contract_id = env.register(RC2_WASM, (governor.clone(),));
    let client = OpenWindowClient::new(leak(env.clone()), leak(contract_id.clone()));
    let nav_oracle = env.register(MockOracle, (Asset::Other(eur(&env)), NAV_DECIMALS));
    let oracle = MockOracleClient::new(leak(env.clone()), leak(nav_oracle.clone()));
    let shares = new_token(&env);
    oracle.set_price(&Asset::Stellar(shares.clone()), &NAV_EUR, &T0);
    let f = Fixture {
        guardian: governor.clone(),
        steward: Address::generate(&env),
        lender: Address::generate(&env),
        borrower: Address::generate(&env),
        eurc: new_token(&env),
        env,
        contract_id,
        client,
        governor,
        shares,
        nav_oracle,
        oracle,
    };
    let (f, offer_id) = ready_from(f);
    let repo_id = open(&f, offer_id);
    assert_eq!(f.client.version(), 4);

    let hash = f.env.deployer().upload_contract_wasm(NIGHT_WINDOW_WASM);
    f.client.propose_upgrade(&hash);
    advance(&f, f.client.timelock_delay());
    publish_nav(&f, NAV_EUR);
    f.client.upgrade(&hash);

    // Until the migration the layout is at 1: reads and exits work, entries wait.
    assert_eq!(f.client.schema_version(), 1);
    assert_eq!(f.client.get_repo(&repo_id).unwrap().shares, 10_000 * ONE);
    assert!(f.client.get_fund(&f.shares).is_some());
    assert_eq!(
        f.client.try_open_repo(
            &f.borrower,
            &offer_id,
            &f.shares,
            &(1_000 * ONE),
            &(1_000 * ONE),
            &(24 * HOUR),
        ),
        Err(Ok(Error::SchemaOutdated))
    );
    f.client.repurchase(&repo_id);

    f.client.migrate();
    assert_eq!(f.env.auths()[0].0, f.governor);
    assert_eq!(f.client.schema_version(), SCHEMA_VERSION);
    assert_eq!(f.client.try_migrate(), Err(Ok(Error::NothingToMigrate)));
    let again = open(&f, offer_id);
    assert!(again > repo_id);
}
