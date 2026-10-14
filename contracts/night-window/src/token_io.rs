//! Token movements. Incoming transfers are measured on the contract's own
//! balance: a permissioned share token or a fee-on-transfer token must not
//! be able to credit less than the books record.

use soroban_sdk::{token::TokenClient, Address, Env};

use crate::error::Error;

/// Moves `amount` of `token` from `from` to the contract and checks the
/// contract received exactly `amount`. `from` must have authorized the call.
pub fn pull(env: &Env, token: &Address, from: &Address, amount: i128) -> Result<(), Error> {
    let client = TokenClient::new(env, token);
    let me = env.current_contract_address();
    let before = client.balance(&me);
    client.transfer(from, &me, &amount);
    let received = client
        .balance(&me)
        .checked_sub(before)
        .ok_or(Error::ArithmeticOverflow)?;
    if received != amount {
        return Err(Error::TransferMismatch);
    }
    Ok(())
}

/// Moves `amount` of `token` from the contract to `to`.
pub fn push(env: &Env, token: &Address, to: &Address, amount: i128) {
    TokenClient::new(env, token).transfer(&env.current_contract_address(), to, &amount);
}

pub fn decimals(env: &Env, token: &Address) -> u32 {
    TokenClient::new(env, token).decimals()
}
