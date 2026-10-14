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
    contract, contractimpl,
    testutils::{
        Address as _, Events as _, Ledger as _, MockAuth, MockAuthInvoke, MuxedAddress as _,
    },
    Address, Env, Event as _, IntoVal, Val, Vec,
};

// ---------------------------------------------------------------------------
// A contract that can hold shares, standing in for the repo contract
// ---------------------------------------------------------------------------

#[contract]
struct Vault;

#[contractimpl]
impl Vault {}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

struct Fixture {
    env: Env,
    admin: Address,
    contract_id: Address,
    client: FundTokenClient<'static>,
}

fn setup() -> Fixture {
    let env = Env::default();
    let admin = Address::generate(&env);
    let contract_id = env.register(
        FundToken,
        (
            admin.clone(),
            6u32,
            String::from_str(&env, "Demo Money Market Fund"),
            String::from_str(&env, "DMMF"),
        ),
    );
    // The client borrows the Env; leaking a clone keeps the fixture simple.
    let leaked_env: &'static Env = std::boxed::Box::leak(std::boxed::Box::new(env.clone()));
    let leaked_id: &'static Address =
        std::boxed::Box::leak(std::boxed::Box::new(contract_id.clone()));
    let client = FundTokenClient::new(leaked_env, leaked_id);
    Fixture {
        env,
        admin,
        contract_id,
        client,
    }
}

impl Fixture {
    /// A new account, whitelisted by the issuer. Requires mocked auths.
    fn holder(&self) -> Address {
        let holder = Address::generate(&self.env);
        self.client.set_whitelisted(&holder, &true);
        holder
    }

    /// A new whitelisted account holding `amount` shares. Requires mocked auths.
    fn holder_with(&self, amount: i128) -> Address {
        let holder = self.holder();
        self.client.mint(&holder, &amount);
        holder
    }

    /// Only `intruder` signs the next call to `fn_name` with `args`.
    fn sign_as_intruder(&self, intruder: &Address, fn_name: &str, args: Vec<Val>) {
        self.env.mock_auths(&[MockAuth {
            address: intruder,
            invoke: &MockAuthInvoke {
                contract: &self.contract_id,
                fn_name,
                args,
                sub_invokes: &[],
            },
        }]);
    }
}

/// The SEP-41 entry points return `()`, so they fail through
/// `panic_with_error!` and their `try_` clients report a raw contract error
/// carrying the `TokenError` code.
fn sep41(error: TokenError) -> soroban_sdk::Error {
    error.into()
}

// ---------------------------------------------------------------------------
// Constructor and metadata
// ---------------------------------------------------------------------------

#[test]
fn constructor_sets_admin_and_metadata() {
    let f = setup();
    assert_eq!(f.client.admin(), f.admin);
    assert_eq!(f.client.decimals(), 6);
    assert_eq!(
        f.client.name(),
        String::from_str(&f.env, "Demo Money Market Fund")
    );
    assert_eq!(f.client.symbol(), String::from_str(&f.env, "DMMF"));
}

// ---------------------------------------------------------------------------
// Issuer functions
// ---------------------------------------------------------------------------

#[test]
fn admin_mints_to_a_whitelisted_account() {
    let f = setup();
    f.env.mock_all_auths();
    let alice = f.holder();

    f.client.mint(&alice, &1_000);

    let auths = f.env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, f.admin);
    assert_eq!(
        f.env.events().all(),
        std::vec![Mint {
            to: alice.clone(),
            amount: 1_000,
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.balance(&alice), 1_000);
}

#[test]
fn non_admin_cannot_mint() {
    let f = setup();
    f.env.mock_all_auths();
    let alice = f.holder();
    let intruder = Address::generate(&f.env);
    f.sign_as_intruder(&intruder, "mint", (&alice, 1_000i128).into_val(&f.env));

    assert!(f.client.try_mint(&alice, &1_000).is_err());
    assert_eq!(f.client.balance(&alice), 0);
}

#[test]
fn mint_requires_an_active_recipient() {
    let f = setup();
    f.env.mock_all_auths();
    let outsider = Address::generate(&f.env);
    let frozen = f.holder();
    f.client.set_frozen(&frozen, &true);

    assert_eq!(
        f.client.try_mint(&outsider, &1_000),
        Err(Ok(TokenError::NotWhitelisted))
    );
    assert_eq!(
        f.client.try_mint(&frozen, &1_000),
        Err(Ok(TokenError::Frozen))
    );
    assert_eq!(
        f.client.try_mint(&f.holder(), &-1),
        Err(Ok(TokenError::NegativeAmount))
    );
}

#[test]
fn mint_rejects_an_overflowing_balance() {
    let f = setup();
    f.env.mock_all_auths();
    let alice = f.holder_with(i128::MAX);

    assert_eq!(f.client.try_mint(&alice, &1), Err(Ok(TokenError::Overflow)));
    assert_eq!(f.client.balance(&alice), i128::MAX);
}

#[test]
fn admin_whitelists_and_delists_with_events() {
    let f = setup();
    f.env.mock_all_auths();
    let alice = Address::generate(&f.env);
    assert!(!f.client.is_whitelisted(&alice));

    f.client.set_whitelisted(&alice, &true);
    assert_eq!(
        f.env.events().all(),
        std::vec![SetWhitelisted {
            id: alice.clone(),
            whitelisted: true,
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert!(f.client.is_whitelisted(&alice));

    f.client.set_whitelisted(&alice, &false);
    assert!(!f.client.is_whitelisted(&alice));
}

#[test]
fn intruder_cannot_whitelist() {
    let f = setup();
    let intruder = Address::generate(&f.env);
    f.sign_as_intruder(
        &intruder,
        "set_whitelisted",
        (&intruder, true).into_val(&f.env),
    );

    assert!(f.client.try_set_whitelisted(&intruder, &true).is_err());
    assert!(!f.client.is_whitelisted(&intruder));
}

#[test]
fn intruder_cannot_freeze() {
    let f = setup();
    f.env.mock_all_auths();
    let alice = f.holder();
    let intruder = Address::generate(&f.env);
    f.sign_as_intruder(&intruder, "set_frozen", (&alice, true).into_val(&f.env));

    assert!(f.client.try_set_frozen(&alice, &true).is_err());
    assert!(!f.client.is_frozen(&alice));
}

#[test]
fn admin_hands_over_the_issuer_role() {
    let f = setup();
    f.env.mock_all_auths();
    let new_admin = Address::generate(&f.env);

    f.client.set_admin(&new_admin);

    assert_eq!(f.env.auths()[0].0, f.admin);
    assert_eq!(
        f.env.events().all(),
        std::vec![SetAdmin {
            admin: f.admin.clone(),
            new_admin: new_admin.clone(),
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.admin(), new_admin);
}

#[test]
fn intruder_cannot_take_the_issuer_role() {
    let f = setup();
    let intruder = Address::generate(&f.env);
    f.sign_as_intruder(&intruder, "set_admin", (&intruder,).into_val(&f.env));

    assert!(f.client.try_set_admin(&intruder).is_err());
    assert_eq!(f.client.admin(), f.admin);
}

#[test]
fn admin_claws_back_even_from_a_frozen_account() {
    let f = setup();
    f.env.mock_all_auths();
    let alice = f.holder_with(1_000);
    f.client.set_frozen(&alice, &true);

    f.client.clawback(&alice, &400);

    assert_eq!(f.env.auths()[0].0, f.admin);
    assert_eq!(
        f.env.events().all(),
        std::vec![Clawback {
            from: alice.clone(),
            amount: 400,
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.balance(&alice), 600);
    assert_eq!(
        f.client.try_clawback(&alice, &601),
        Err(Ok(TokenError::InsufficientBalance))
    );
}

#[test]
fn intruder_cannot_claw_back() {
    let f = setup();
    f.env.mock_all_auths();
    let alice = f.holder_with(1_000);
    let intruder = Address::generate(&f.env);
    f.sign_as_intruder(&intruder, "clawback", (&alice, 1_000i128).into_val(&f.env));

    assert!(f.client.try_clawback(&alice, &1_000).is_err());
    assert_eq!(f.client.balance(&alice), 1_000);
}

// ---------------------------------------------------------------------------
// Transfers between allowlisted holders
// ---------------------------------------------------------------------------

#[test]
fn transfer_between_two_whitelisted_accounts() {
    let f = setup();
    f.env.mock_all_auths();
    let alice = f.holder_with(1_000);
    let bob = f.holder();

    f.client.transfer(&alice, &bob, &300);

    let auths = f.env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, alice);
    assert_eq!(
        f.env.events().all(),
        std::vec![Transfer {
            from: alice.clone(),
            to: bob.clone(),
            amount: 300,
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.balance(&alice), 700);
    assert_eq!(f.client.balance(&bob), 300);
}

#[test]
fn transfer_of_zero_is_allowed() {
    let f = setup();
    f.env.mock_all_auths();
    let alice = f.holder_with(1_000);
    let bob = f.holder();

    f.client.transfer(&alice, &bob, &0);
    assert_eq!(f.client.balance(&alice), 1_000);
    assert_eq!(f.client.balance(&bob), 0);
}

#[test]
fn transfer_refused_when_receiver_is_not_whitelisted() {
    let f = setup();
    f.env.mock_all_auths();
    let alice = f.holder_with(1_000);
    let outsider = Address::generate(&f.env);

    assert_eq!(
        f.client.try_transfer(&alice, &outsider, &300),
        Err(Ok(sep41(TokenError::NotWhitelisted)))
    );
    assert_eq!(f.client.balance(&alice), 1_000);
}

#[test]
fn transfer_refused_when_sender_is_delisted() {
    let f = setup();
    f.env.mock_all_auths();
    let alice = f.holder_with(1_000);
    let bob = f.holder();
    f.client.set_whitelisted(&alice, &false);

    assert_eq!(
        f.client.try_transfer(&alice, &bob, &300),
        Err(Ok(sep41(TokenError::NotWhitelisted)))
    );
    assert_eq!(f.client.balance(&bob), 0);
}

#[test]
fn transfer_refused_beyond_balance_or_when_negative() {
    let f = setup();
    f.env.mock_all_auths();
    let alice = f.holder_with(1_000);
    let bob = f.holder();

    assert_eq!(
        f.client.try_transfer(&alice, &bob, &1_001),
        Err(Ok(sep41(TokenError::InsufficientBalance)))
    );
    assert_eq!(
        f.client.try_transfer(&alice, &bob, &-1),
        Err(Ok(sep41(TokenError::NegativeAmount)))
    );
}

#[test]
fn transfer_requires_the_sender_signature() {
    let f = setup();
    f.env.mock_all_auths();
    let alice = f.holder_with(1_000);
    let bob = f.holder();
    f.sign_as_intruder(&bob, "transfer", (&alice, &bob, 1_000i128).into_val(&f.env));

    assert!(f.client.try_transfer(&alice, &bob, &1_000).is_err());
    assert_eq!(f.client.balance(&alice), 1_000);
}

#[test]
fn frozen_account_can_neither_send_nor_receive() {
    let f = setup();
    f.env.mock_all_auths();
    let alice = f.holder_with(1_000);
    let bob = f.holder_with(1_000);
    f.client.set_frozen(&alice, &true);
    assert!(f.client.is_frozen(&alice));

    assert_eq!(
        f.client.try_transfer(&alice, &bob, &100),
        Err(Ok(sep41(TokenError::Frozen)))
    );
    assert_eq!(
        f.client.try_transfer(&bob, &alice, &100),
        Err(Ok(sep41(TokenError::Frozen)))
    );

    f.client.set_frozen(&alice, &false);
    f.client.transfer(&bob, &alice, &100);
    assert_eq!(f.client.balance(&alice), 1_100);
}

#[test]
fn a_whitelisted_contract_receives_shares() {
    let f = setup();
    f.env.mock_all_auths();
    let vault = f.env.register(Vault, ());
    let alice = f.holder_with(1_000);

    assert_eq!(
        f.client.try_transfer(&alice, &vault, &400),
        Err(Ok(sep41(TokenError::NotWhitelisted)))
    );

    f.client.set_whitelisted(&vault, &true);
    f.client.transfer(&alice, &vault, &400);
    assert_eq!(f.client.balance(&vault), 400);
    assert_eq!(f.client.balance(&alice), 600);
}

#[test]
fn transfer_to_a_muxed_address_emits_the_muxed_id() {
    let f = setup();
    f.env.mock_all_auths();
    let alice = f.holder_with(1_000);
    // Only accounts can be multiplexed: the allowlist holds the account part.
    let bob_muxed = MuxedAddress::generate(&f.env);
    let bob = bob_muxed.address();
    f.client.set_whitelisted(&bob, &true);

    f.client.transfer(&alice, &bob_muxed, &300);

    assert_eq!(
        f.env.events().all(),
        std::vec![TransferMuxed {
            from: alice.clone(),
            to: bob.clone(),
            to_muxed_id: bob_muxed.id().unwrap(),
            amount: 300,
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.balance(&bob), 300);
}

// ---------------------------------------------------------------------------
// Allowances
// ---------------------------------------------------------------------------

#[test]
fn approve_then_transfer_from() {
    let f = setup();
    f.env.mock_all_auths();
    let alice = f.holder_with(1_000);
    let bob = f.holder();
    let spender = Address::generate(&f.env);
    let live_until = f.env.ledger().sequence() + 1_000;

    f.client.approve(&alice, &spender, &500, &live_until);
    assert_eq!(f.env.auths()[0].0, alice);
    assert_eq!(
        f.env.events().all(),
        std::vec![Approve {
            from: alice.clone(),
            spender: spender.clone(),
            amount: 500,
            live_until_ledger: live_until,
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.allowance(&alice, &spender), 500);

    f.client.transfer_from(&spender, &alice, &bob, &200);
    assert_eq!(f.env.auths()[0].0, spender);
    assert_eq!(
        f.env.events().all(),
        std::vec![Transfer {
            from: alice.clone(),
            to: bob.clone(),
            amount: 200,
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.allowance(&alice, &spender), 300);
    assert_eq!(f.client.balance(&alice), 800);
    assert_eq!(f.client.balance(&bob), 200);

    assert_eq!(
        f.client.try_transfer_from(&spender, &alice, &bob, &301),
        Err(Ok(sep41(TokenError::InsufficientAllowance)))
    );
}

#[test]
fn transfer_from_still_requires_whitelisted_parties() {
    let f = setup();
    f.env.mock_all_auths();
    let alice = f.holder_with(1_000);
    let outsider = Address::generate(&f.env);
    let spender = Address::generate(&f.env);
    let live_until = f.env.ledger().sequence() + 1_000;
    f.client.approve(&alice, &spender, &500, &live_until);

    assert_eq!(
        f.client
            .try_transfer_from(&spender, &alice, &outsider, &200),
        Err(Ok(sep41(TokenError::NotWhitelisted)))
    );
    assert_eq!(f.client.allowance(&alice, &spender), 500);
}

#[test]
fn allowance_expires_after_its_ledger() {
    let f = setup();
    f.env.mock_all_auths();
    let alice = f.holder_with(1_000);
    let bob = f.holder();
    let spender = Address::generate(&f.env);
    let live_until = f.env.ledger().sequence() + 10;
    f.client.approve(&alice, &spender, &500, &live_until);

    f.env.ledger().set_sequence_number(live_until + 1);

    assert_eq!(f.client.allowance(&alice, &spender), 0);
    assert_eq!(
        f.client.try_transfer_from(&spender, &alice, &bob, &1),
        Err(Ok(sep41(TokenError::InsufficientAllowance)))
    );
}

#[test]
fn approve_rejects_a_past_expiration() {
    let f = setup();
    f.env.mock_all_auths();
    let alice = f.holder_with(1_000);
    let spender = Address::generate(&f.env);
    f.env.ledger().set_sequence_number(100);

    assert_eq!(
        f.client.try_approve(&alice, &spender, &500, &99),
        Err(Ok(sep41(TokenError::InvalidExpiration)))
    );
    // Revoking with a zero amount is accepted whatever the expiration.
    f.client.approve(&alice, &spender, &0, &0);
    assert_eq!(f.client.allowance(&alice, &spender), 0);
}

// ---------------------------------------------------------------------------
// Burning
// ---------------------------------------------------------------------------

#[test]
fn holder_burns_shares() {
    let f = setup();
    f.env.mock_all_auths();
    let alice = f.holder_with(1_000);

    f.client.burn(&alice, &250);

    assert_eq!(f.env.auths()[0].0, alice);
    assert_eq!(
        f.env.events().all(),
        std::vec![Burn {
            from: alice.clone(),
            amount: 250,
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.balance(&alice), 750);
    assert_eq!(
        f.client.try_burn(&alice, &751),
        Err(Ok(sep41(TokenError::InsufficientBalance)))
    );
}

#[test]
fn frozen_holder_cannot_burn() {
    let f = setup();
    f.env.mock_all_auths();
    let alice = f.holder_with(1_000);
    f.client.set_frozen(&alice, &true);

    assert_eq!(
        f.client.try_burn(&alice, &100),
        Err(Ok(sep41(TokenError::Frozen)))
    );
}

#[test]
fn spender_burns_from_an_allowance() {
    let f = setup();
    f.env.mock_all_auths();
    let alice = f.holder_with(1_000);
    let spender = Address::generate(&f.env);
    let live_until = f.env.ledger().sequence() + 1_000;
    f.client.approve(&alice, &spender, &300, &live_until);

    f.client.burn_from(&spender, &alice, &300);

    assert_eq!(f.env.auths()[0].0, spender);
    assert_eq!(f.client.balance(&alice), 700);
    assert_eq!(f.client.allowance(&alice, &spender), 0);
    assert_eq!(
        f.client.try_burn_from(&spender, &alice, &1),
        Err(Ok(sep41(TokenError::InsufficientAllowance)))
    );
}
