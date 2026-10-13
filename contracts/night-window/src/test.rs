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
use soroban_sdk::{
    contract, contractimpl, symbol_short,
    testutils::{Address as _, Events as _, MockAuth, MockAuthInvoke},
    vec, Address, Env, Event as _, IntoVal,
};

// ---------------------------------------------------------------------------
// Mock SEP-40 oracle used by the tests
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone)]
enum MockKey {
    Decimals,
    Price(Asset),
}

#[contract]
struct MockOracle;

#[contractimpl]
impl MockOracle {
    pub fn __constructor(env: Env, decimals: u32) {
        env.storage().instance().set(&MockKey::Decimals, &decimals);
    }

    pub fn set_price(env: Env, asset: Asset, price: i128, timestamp: u64) {
        env.storage()
            .instance()
            .set(&MockKey::Price(asset), &PriceData { price, timestamp });
    }

    pub fn decimals(env: Env) -> u32 {
        env.storage().instance().get(&MockKey::Decimals).unwrap()
    }

    pub fn lastprice(env: Env, asset: Asset) -> Option<PriceData> {
        env.storage().instance().get(&MockKey::Price(asset))
    }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

struct Fixture {
    env: Env,
    admin: Address,
    contract_id: Address,
    client: NightWindowClient<'static>,
}

fn setup() -> Fixture {
    let env = Env::default();
    let admin = Address::generate(&env);
    let contract_id = env.register(NightWindow, (admin.clone(),));
    // The client borrows the Env; leaking a clone keeps the fixture simple.
    let leaked_env: &'static Env = std::boxed::Box::leak(std::boxed::Box::new(env.clone()));
    let leaked_id: &'static Address =
        std::boxed::Box::leak(std::boxed::Box::new(contract_id.clone()));
    let client = NightWindowClient::new(leaked_env, leaked_id);
    Fixture {
        env,
        admin,
        contract_id,
        client,
    }
}

fn fund_config(oracle: &Address, haircut_bps: u32) -> FundConfig {
    FundConfig {
        oracle: oracle.clone(),
        oracle_asset: Asset::Other(symbol_short!("USTBL")),
        haircut_bps,
    }
}

// ---------------------------------------------------------------------------
// Constructor and administration
// ---------------------------------------------------------------------------

#[test]
fn constructor_sets_admin_and_defaults() {
    let f = setup();
    assert_eq!(f.client.admin(), f.admin);
    assert_eq!(f.client.version(), 1);
    assert_eq!(f.client.max_term(), DEFAULT_MAX_TERM_SECS);
    assert_eq!(f.client.get_offer(&1), None);
    assert_eq!(f.client.get_repo(&1), None);
}

#[test]
fn set_admin_requires_current_admin_and_emits_event() {
    let f = setup();
    f.env.mock_all_auths();
    let new_admin = Address::generate(&f.env);

    f.client.set_admin(&new_admin);

    let auths = f.env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, f.admin);
    assert_eq!(
        f.env.events().all(),
        std::vec![AdminChanged {
            previous: f.admin.clone(),
            admin: new_admin.clone(),
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.admin(), new_admin);
}

#[test]
fn non_admin_cannot_change_admin() {
    let f = setup();
    let intruder = Address::generate(&f.env);
    f.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "set_admin",
            args: (&intruder,).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);

    assert!(f.client.try_set_admin(&intruder).is_err());
    assert_eq!(f.client.admin(), f.admin);
}

#[test]
fn set_max_term_validates_and_emits() {
    let f = setup();
    f.env.mock_all_auths();

    assert_eq!(f.client.try_set_max_term(&0), Err(Ok(Error::InvalidTerm)));

    f.client.set_max_term(&86_400);
    assert_eq!(
        f.env.events().all(),
        std::vec![MaxTermChanged { max_term: 86_400 }.to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.max_term(), 86_400);
}

#[test]
fn non_admin_cannot_upgrade() {
    let f = setup();
    let intruder = Address::generate(&f.env);
    let hash = BytesN::from_array(&f.env, &[7u8; 32]);
    f.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "upgrade",
            args: (&hash,).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);

    assert!(f.client.try_upgrade(&hash).is_err());
}

// ---------------------------------------------------------------------------
// Registry of accepted funds
// ---------------------------------------------------------------------------

#[test]
fn admin_registers_and_updates_a_fund() {
    let f = setup();
    f.env.mock_all_auths();
    let fund = Address::generate(&f.env);
    let oracle = Address::generate(&f.env);

    assert_eq!(f.client.get_fund(&fund), None);

    let config = fund_config(&oracle, 200);
    f.client.set_fund(&fund, &config);

    let auths = f.env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, f.admin);
    assert_eq!(
        f.env.events().all(),
        std::vec![FundSet {
            fund: fund.clone(),
            oracle: oracle.clone(),
            haircut_bps: 200,
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.get_fund(&fund), Some(config));

    let updated = fund_config(&oracle, 500);
    f.client.set_fund(&fund, &updated);
    assert_eq!(f.client.get_fund(&fund), Some(updated));
}

#[test]
fn haircut_must_be_below_one_unit() {
    let f = setup();
    f.env.mock_all_auths();
    let fund = Address::generate(&f.env);
    let oracle = Address::generate(&f.env);

    assert_eq!(
        f.client
            .try_set_fund(&fund, &fund_config(&oracle, BPS_DENOMINATOR)),
        Err(Ok(Error::InvalidHaircut))
    );
    assert_eq!(f.client.get_fund(&fund), None);

    f.client
        .set_fund(&fund, &fund_config(&oracle, BPS_DENOMINATOR - 1));
    assert!(f.client.get_fund(&fund).is_some());
}

#[test]
fn non_admin_cannot_register_a_fund() {
    let f = setup();
    let intruder = Address::generate(&f.env);
    let fund = Address::generate(&f.env);
    let config = fund_config(&Address::generate(&f.env), 200);
    f.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "set_fund",
            args: (&fund, &config).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);

    assert!(f.client.try_set_fund(&fund, &config).is_err());
    assert_eq!(f.client.get_fund(&fund), None);
}

#[test]
fn admin_removes_a_fund() {
    let f = setup();
    f.env.mock_all_auths();
    let fund = Address::generate(&f.env);
    let oracle = Address::generate(&f.env);

    assert_eq!(
        f.client.try_remove_fund(&fund),
        Err(Ok(Error::FundNotAccepted))
    );

    f.client.set_fund(&fund, &fund_config(&oracle, 200));
    f.client.remove_fund(&fund);
    assert_eq!(
        f.env.events().all(),
        std::vec![FundRemoved { fund: fund.clone() }.to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.get_fund(&fund), None);
}

// ---------------------------------------------------------------------------
// SEP-40 price lookup
// ---------------------------------------------------------------------------

#[test]
fn fund_price_reads_the_sep40_oracle() {
    let f = setup();
    f.env.mock_all_auths();
    let fund = Address::generate(&f.env);
    let oracle_id = f.env.register(MockOracle, (14u32,));
    let oracle = MockOracleClient::new(&f.env, &oracle_id);
    let asset = Asset::Other(symbol_short!("USTBL"));

    f.client.set_fund(&fund, &fund_config(&oracle_id, 200));

    // The oracle does not know the asset yet.
    assert_eq!(f.client.try_fund_price(&fund), Err(Ok(Error::NoPrice)));

    // 1.0325 with 14 decimals.
    oracle.set_price(&asset, &103_250_000_000_000, &1_700_000_000);
    assert_eq!(
        f.client.fund_price(&fund),
        PriceData {
            price: 103_250_000_000_000,
            timestamp: 1_700_000_000,
        }
    );
    assert_eq!(oracle.decimals(), 14);
}

#[test]
fn fund_price_rejects_unknown_fund() {
    let f = setup();
    let fund = Address::generate(&f.env);
    assert_eq!(
        f.client.try_fund_price(&fund),
        Err(Ok(Error::FundNotAccepted))
    );
}

// ---------------------------------------------------------------------------
// Lifecycle entry points wait for the specification
// ---------------------------------------------------------------------------

#[test]
fn lifecycle_entry_points_are_declared_but_not_implemented() {
    let f = setup();
    f.env.mock_all_auths();
    let user = Address::generate(&f.env);
    let token = Address::generate(&f.env);
    let funds = vec![&f.env, token.clone()];

    assert_eq!(
        f.client
            .try_create_offer(&user, &token, &1_000, &800, &DEFAULT_MAX_TERM_SECS, &funds),
        Err(Ok(Error::NotImplemented))
    );
    assert_eq!(
        f.client.try_withdraw_offer(&1, &1_000),
        Err(Ok(Error::NotImplemented))
    );
    assert_eq!(
        f.client
            .try_open_repo(&user, &1, &token, &1_000, &900, &86_400),
        Err(Ok(Error::NotImplemented))
    );
    assert_eq!(f.client.try_repurchase(&1), Err(Ok(Error::NotImplemented)));
    assert_eq!(f.client.try_seize(&1), Err(Ok(Error::NotImplemented)));
}
