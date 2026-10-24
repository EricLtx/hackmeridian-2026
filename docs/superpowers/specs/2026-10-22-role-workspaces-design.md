# Role workspaces on the web platform — design

Date: 22 October 2026. Status: design approved for phase 0 by the maintainer's request to proceed without a question round; later phases are described so that phase 0 does not close them off. Phase 0 delivered on 22 October 2026 (plan `docs/superpowers/plans/2026-10-22-role-workspaces-phase0.md`), except repos past maturity in the Health panel, moved to phase 1; phase 0b delivered on 24 October 2026.

## Intent

Every party to an Open Window instance should meet its requirements on the platform, not in a terminal. Today the page serves two roles: the **holder** of fund shares, who borrows, repays and follows positions, and the **lender**, who creates and withdraws offers and seizes at maturity. The page reads 29 of the contract's 113 entry points and writes 6. The **operator** of an instance (in the single-lender mode, the regulated lender itself, which also holds the instance's governance) and the fund's **issuer as steward** still need the scripts in `demo/` for everything else: governance proposals, cancellations and vetoes, pause, lender approvals, fund limits, freezes, re-anchors, rent and references.

The platform becomes one place where a connected wallet learns which roles it holds on the instance and finds the actions those roles allow, while anyone can read the instance's state and its protections.

## Users

| User | Holds | Needs from the platform |
|---|---|---|
| Holder | fund shares | see what the shares can secure, borrow in one signature, repurchase, follow each position to its end |
| Operator (lender of the instance) | the sole-lender address; usually also the governor's signers | offers; the instance's health; every pending proposal with its countdown; cancel, veto, pause; the register and the exports |
| Issuer as steward | the fund's steward key and its backup | attest and approve lenders, fund limits, freeze, backup feed, re-anchor with the governor |
| Governance co-signers | a governor signer, the guardian, the trustee, the sentinel | the one action each of them takes, with what it does and when it applies |
| Anyone | nothing | read the instance and its protections; apply a proposal once due; step a price reference; deliver held-back shares |

## Goals

1. Recognise the connected wallet's roles from the chain, without trusting the page for it.
2. Give the operator and the steward a workspace each, readable by anyone, actionable by the role.
3. Make every action state, before signing, what it changes, who else must sign, and when it applies.
4. Support actions that need two parties (governor and steward, governor and trustee, lender and steward) without a server.
5. Keep the holder's path as short as it is now.

## Non-goals

- No contract change: everything uses the entry points of the tag `audit-v4-rc5`.
- No backend, no account system, no stored secret: the page stays static.
- The monitor stays a host process: the page shows what it would see, it does not replace an always-on watch.
- Rent extension of the contract code stays with the keeper's tooling (it is a ledger operation, not a contract call).

## Anti-goals

The work fails, even if it runs, if:

- a role's action appears to a wallet that cannot perform it, or the page claims a role the chain does not confirm;
- a governance action can be signed without the page saying what it changes and that it waits for the time delay;
- the holder's borrow path gets longer or noisier;
- a co-signature request can be altered between the two parties without the second party seeing it.

## Constraints

- Web stack as it is: Vite, plain JavaScript, `@stellar/stellar-sdk`, `@stellar/freighter-api`, the chain module `src/chain.js`; content security policy unchanged unless an endpoint is added.
- Every visible string written in English, marked with `t()`, translated in French and Spanish; `npm run check:i18n` and `npm test` pass.
- Values read from the chain are untrusted and checked at the boundary before display.
- The same pre-signing checks as today: fee cap, simulation-derived fee, confirmation on a second endpoint.
- Accessibility as recorded in `web/DESIGN.md`: text at 4.5:1, control outlines at 3:1, 44 px targets on touch screens.
- Public repository: no business content, no event content.

## Information architecture

One page, one header, spaces in the navigation in this order: **Market**, **Borrow**, **Positions**, **Lend**, **Operate**, **Fund**, **History**. Market, Operate and Fund are readable without a wallet. Borrow, Positions and Lend keep their current behaviour. A wallet's roles show as chips next to its address in the wallet card; a space whose role the wallet holds is marked in the navigation.

## Role recognition

On connection and after every refresh, the page reads, from the instance:

| Role | Read | Holds it when |
|---|---|---|
| Governor | `admin()` | the wallet is that address, or one of its signers with a weight above zero (read from the account's ledger entry) |
| Guardian, guardian backup | `guardian()`, `guardian_backup()` | the wallet is that address |
| Sentinel | `sentinel()` | idem |
| Trustee | `trustee()` | idem |
| Sole lender | `sole_lender()` | idem |
| Steward, steward backup of a fund | `get_fund(fund).steward`, `steward_backup(fund)` for each admitted fund | idem, per fund |
| Approved lender of a fund | `is_lender_approved(fund, wallet)` | the call answers true |
| Holder | share balance or an open repo as borrower | either |

A read that fails leaves that role unknown and says so; it never grants a role.

## Operate space

Readable by anyone, in four panels.

1. **Health**: paused or open; contract version and schema; each fund's NAV age against its bound, its price reference age, its cap usage; repos past maturity; the contract code's time to live when the page can read it.
2. **Roles**: who holds each role, with the role chip of the connected wallet.
3. **Proposals**: every pending proposal the contract exposes (upgrade, governor handover, guardian change, forced guardian change, envelope, term ceiling, currency cap, fund change, fund limits, backup feed, re-anchor, stablecoin, steward backup, steward recovery) with its effect in words, its proposer, and a countdown to the moment it can apply.
4. **Actions**, by role: pause (guardian, sentinel), unpause (governor), cancel a proposal (guardian, sentinel), veto (guardian for a governor handover, trustee for a forced guardian change), apply a due proposal (anyone), step a price reference (anyone), deliver held-back shares (anyone).

## Fund space

Per admitted fund, readable by anyone: the fund's configuration against the envelope, its feeds, its lenders. Actions for its steward: attest a lender (with the lender), approve or revoke a lender, change limits, freeze, register a backup, propose a backup feed, propose a re-anchor (with the governor), and the steward-recovery path for the backup key.

## Co-signature requests

An action that needs two parties is built by the first party on the page: the page simulates it, shows its effect, and signs the first party's authorization entry with the wallet. It then exports a **request**: the unsigned transaction and the signed entries, encoded in a link fragment (never sent to a server) and as a file. The second party opens the request on the platform; the page decodes it, re-simulates it against the chain, shows the same effect and checks, refuses it if anything differs from what the request states, signs its own entry, and submits. A request carries an expiry ledger, after which it is refused. A governor that is a multisig account collects one signature per signer on the same request before it is complete.

## Phasing

| Phase | Scope | When |
|---|---|---|
| 0 | The five interface defects of 22 October (terminal status band, total haircut, untranslated tape events, control outlines, touch targets); role recognition and role chips; the Operate space read-only (health, roles, proposals with countdowns); the total protection of a loan shown in one place | before the web freeze of 24 October, 18:00 |
| 0b | Positions summary at the top of the Positions space and of the lender's repos, read-only, from the rows the page already holds | before the web freeze of 24 October, 18:00 |
| 1 | Single-signer actions of the Operate and Fund spaces | after the freeze |
| 2 | Co-signature requests: admission (governor and steward), lender attestation (lender and steward), upgrade (governor and trustee), re-anchor (governor and steward) | after phase 1 |
| 3 | Instance selector once a second instance exists; a risk and jurisdiction acknowledgement before any mainnet use | before mainnet |

## Left to the builder

Panel layouts within the existing visual system (`web/DESIGN.md`); the wording of each action's effect, in the voice of the existing guide; how often the Operate space refreshes, within the current refresh cycle; the encoding of co-signature requests, within the rules above.
