//! Who may ask for a run (workstream 04, 2026-11-07): the run's citizen is
//! an NFT pass's Citizen (every player holds a pass, the owner's rule), and
//! only the pass's current holder may ask, as the game's ResidentAct allows
//! an action: workstream 20's single definition
//! (`frontier_abi::resident_auth::holder` + `Holder::authority`):
//!
//! - the owner is the asset's live Core owner;
//! - the generation goes up by one on every transfer (which clears the
//!   session); a request signed for another generation is refused
//!   (`StaleGeneration`);
//! - a session (the delegation) acts only when its owner set it in this
//!   generation and it has not expired; a previous owner or a previous
//!   owner's session is refused (`NotCurrentAuthority`).
//!
//! The accounts come from the chain through a [`Passes`] port: the
//! Citizen's link (`["nft-citizen-link", season, asset]`), the policy, the
//! asset and the resident record, with their owners. The link must be the
//! game program's and name the run's Citizen (its `citizen_tag` is the
//! run's `owner`), the policy the game program's.
//!
//! **Not here (limits):** that the requester signed the request is the
//! caller's to establish (the gateway's credential layer, workstreams 3 and
//! 5); this module takes the requester's key as authenticated, as the
//! runtime takes `is_signer`. A run already accepted is not re-checked when
//! the pass moves later (what a transfer does to a run in flight is
//! undecided); the check that admitted it is recorded on the run
//! ([`RunAuthority`]).

use frontier_abi::resident_auth::{holder, Account, Authority, Binding, Refusal};
use serde::{Deserialize, Serialize};

/// The requester as the caller authenticated it: its key and the pass
/// generation it signed for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Requester {
    pub actor: [u8; 32],
    pub generation: u32,
}

/// The pass behind a run's citizen, as read from the chain at one point.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PassView {
    /// The game program (owner of the link and the policy).
    pub program: [u8; 32],
    pub link: PassAccount,
    pub policy: PassAccount,
    pub asset: PassAccount,
    pub resident: PassAccount,
    /// The chain's unix time at the read (a session's expiry is against it).
    pub now: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PassAccount {
    pub key: [u8; 32],
    pub owner: [u8; 32],
    pub data: Vec<u8>,
}

/// The run's citizen's pass, from the chain. `Ok(None)`: no pass link for
/// that citizen (a citizen without a pass may not ask for runs).
pub trait Passes {
    fn pass_of(&self, owner_tag: u64) -> Result<Option<PassView>, String>;
}

/// How the requester holds the pass.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum AuthorityKind {
    Owner,
    Session,
}

/// The check that admitted a run, kept on it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunAuthority {
    pub actor: [u8; 32],
    pub asset: [u8; 32],
    /// The pass's owner at the check (the actor itself, or the session's
    /// owner).
    pub owner: [u8; 32],
    pub generation: u32,
    pub by: AuthorityKind,
    /// The chain's unix time the pass was read at.
    pub checked_at: i64,
}

fn refusal(r: Refusal) -> String {
    match r {
        Refusal::NotSigned => "the requester did not sign".into(),
        Refusal::Asset => "the pass's asset is not the bound asset of the collection".into(),
        Refusal::Unguarded => "the pass's asset has no transfer guard".into(),
        Refusal::Resident => "the pass's resident record is not the bound one".into(),
        Refusal::StaleGeneration => {
            "the request was signed for another pass generation (the pass moved): refused".into()
        }
        Refusal::NotCurrentAuthority => {
            "the requester is not the pass's current owner nor its live session: refused".into()
        }
    }
}

/// Whether `req` may ask for a run of citizen `owner_tag`, from `pass`.
pub fn check_requester(
    owner_tag: u64,
    pass: &PassView,
    req: &Requester,
) -> Result<RunAuthority, String> {
    use frontier_abi::{resident_binding, resident_policy};
    if pass.link.owner != pass.program || pass.policy.owner != pass.program {
        return Err("the pass link or the policy is not the game program's".into());
    }
    let link = resident_binding::read(&pass.link.data).ok_or("the pass link does not decode")?;
    if permutation_rules::frontier::addr::citizen_tag(&link.citizen) != owner_tag {
        return Err("the pass link names another citizen than the run's".into());
    }
    let policy = resident_policy::read(&pass.policy.data).ok_or("the policy does not decode")?;
    fn acct(a: &PassAccount) -> Account<'_> {
        Account {
            key: a.key,
            owner: a.owner,
            data: &a.data,
        }
    }
    let h = holder(
        &Binding {
            asset: link.asset,
            resident: link.resident,
        },
        &policy,
        &acct(&pass.asset),
        &acct(&pass.resident),
    )
    .map_err(refusal)?;
    let by = h
        .authority(&req.actor, req.generation, pass.now, true)
        .map_err(refusal)?;
    Ok(RunAuthority {
        actor: req.actor,
        asset: h.asset,
        owner: h.owner,
        generation: h.generation,
        by: match by {
            Authority::Owner => AuthorityKind::Owner,
            Authority::Session => AuthorityKind::Session,
        },
        checked_at: pass.now,
    })
}
