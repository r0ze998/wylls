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
//! the pass moves later: it runs to its end (the owner's decision,
//! 2026-11-07); the check that admitted it is recorded on the run
//! ([`RunAuthority`]). Every new request after a transfer needs the new
//! holder.

use frontier_abi::resident_auth::{holder, Account, Authority, Binding, Refusal};
use serde::{Deserialize, Serialize};

/// The requester as the caller (the gateway's credential layer)
/// authenticated it: its key, the pass generation it signed for, and the
/// Citizen it acts for (whose `citizen_tag` must be the run's `owner`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Requester {
    pub actor: [u8; 32],
    pub generation: u32,
    pub citizen: [u8; 32],
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

/// The pass of a Citizen, from the chain. `Ok(None)`: that Citizen is not
/// an NFT pass's (a citizen without a pass may not ask for runs).
pub trait Passes {
    fn pass_of(&self, citizen: &[u8; 32]) -> Result<Option<PassView>, String>;
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
    if permutation_rules::frontier::addr::citizen_tag(&link.citizen) != owner_tag
        || link.citizen != req.citizen
    {
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

/// Whether `req` may ask for `spec` now: the requester's Citizen is the
/// run's, it has a pass, and the requester is that pass's current holder.
/// Nothing is stored; the `run accept` command calls this before it opens
/// the store.
pub fn authorize(
    spec: &crate::model::RunSpec,
    req: &Requester,
    passes: &impl Passes,
) -> Result<RunAuthority, String> {
    if permutation_rules::frontier::addr::citizen_tag(&req.citizen) != spec.owner {
        return Err("the requester's citizen is not the run's (citizen_tag differs)".into());
    }
    let pass = passes
        .pass_of(&req.citizen)?
        .ok_or("no NFT pass for the run's citizen: every player needs a pass")?;
    check_requester(spec.owner, &pass, req)
}

/// The intake: the requester checked against the pass ([`authorize`],
/// before the store is asked, also for a repeated run id), then the spec
/// (`validate_spec`), then the run stored with the check as its first
/// detail (the executor's `accept_as`).
pub fn accept_checked(
    store: &crate::store::Store,
    spec: &crate::model::RunSpec,
    req: &Requester,
    passes: &impl Passes,
    now_slot: u64,
) -> Result<crate::store::Accept, String> {
    let authority = authorize(spec, req, passes)?;
    crate::executor::validate_spec(spec)?;
    store.accept_with(spec, now_slot, &first_detail(authority))
}

/// The first detail of a run admitted by `authority`.
pub fn first_detail(authority: RunAuthority) -> crate::model::Detail {
    crate::model::Detail {
        authority: Some(authority),
        ..crate::model::Detail::default()
    }
}
