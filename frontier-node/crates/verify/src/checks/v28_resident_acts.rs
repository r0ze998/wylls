//! V28 — ResidentAct (⑳'s 0xE2, `nft-experimental` programs; provisional
//! number). Every successful top-level ResidentAct ran one player
//! instruction for one NFT Citizen as `permutation-frontier` `proc::resident::act`
//! runs it, for the pass's holder at that moment:
//!
//! - **inner instruction:** one the program runs for an NFT Citizen
//!   (`resident_wire::ACT_RUNS`; SetSession and every other tag are refused);
//! - **accounts:** the four proof accounts `[policy, link, asset, resident]`
//!   read-only, the Citizen writable, the Season this Season's; the policy,
//!   link, resident account and Citizen are the ones this pass's JoinResident
//!   used in this Season (V27 judges those; nothing is derived here);
//! - **result (archives with post-states):** the Citizen is still this
//!   asset's NFT Citizen (zero wallet, the asset as its resident asset) and
//!   the prologue ran for it at the transaction's time (`LAST_ACTION_TS`);
//! - **holder (with the resident program's record, [`ResidentFeed`]):** the
//!   generation the actor signed is the pass's holder generation, and the
//!   actor is the holder ([`resident_auth::Holder`], the one definition the
//!   game and the prize read) or its live session. A signed generation below
//!   one the record shows before the act is a FAIL (a signature from before a
//!   transfer was accepted). With the record whole up to the act (the
//!   combined feed has no gap), an actor that is neither the owner nor its
//!   live session, such as a previous owner or a previous owner's session, is
//!   a FAIL; with a gap it is UNVERIFIABLE (a SetSession may be missing).
//!
//! **Inner instruction (2026-11-08):** the world lists a ResidentAct also as
//! the player instruction it ran (`world::unwrap_resident`, the act's own
//! accounts without the proof accounts), so the check that models that
//! instruction for a wallet Citizen judges it; V23 hands a SendCaravan to
//! another player to V28 as the owner's only (`Ctx::owner_required`), and
//! CloseVault and CloseStructure are always the owner's only: a session
//! accepted for them is `ResidentOwnerRequired` (with the record whole).
//!
//! UNVERIFIABLE, never PASS: an inner instruction no check models in this
//! season (`v0_coverage::supported`: `ResidentInnerUnmodelled`); the
//! holder without the resident program's record (`ResidentActUnproven`); a
//! pass with no JoinResident in the archive; post-states the archive lacks.
//!
//! Not judged: the actor's signature (the runtime's, as for a wallet), the
//! policy's address (the program checks it at join and act). Codes:
//! `ResidentActMismatch`, `ResidentOldAuthority`, `ResidentActUnproven`,
//! `ResidentInnerUnmodelled`, `NonCanonicalAddress`, `MissingPostState`.

use fclient::ports::Account;
use frontier_abi::layout::player::citizen as C;
use frontier_abi::resident_auth::{self as ra, Refusal};
use frontier_abi::resident_wire::{self, Command};

use super::Ctx;
use crate::codes::*;
use crate::world::{Ix, Key, Tx, World};
use crate::Severity;

const V: &str = "V28";

/// JoinResident's positions (V27): `[owner] [payer] [season] [frontier]
/// [citizen] [system] [policy] [link] [asset] [resident] [join_gate?]`.
const J_CITIZEN: usize = 4;
const J_POLICY: usize = 6;
const J_LINK: usize = 7;
const J_ASSET: usize = 8;
const J_RESIDENT: usize = 9;
/// The inner instruction's own accounts begin `[actor, payer, season, citizen]`.
const ACTOR: usize = 0;
const SEASON: usize = 2;
const CITIZEN: usize = 3;

/// One finding: severity, code, transaction, detail.
pub type Found = (Severity, &'static str, usize, String);

pub use crate::resident_feed::{ResidentFeed, ResidentTx};

/// What V28 reads besides the archive.
pub struct ActCtx<'a> {
    /// This Season's address context (its Season and program).
    pub addr: frontier_abi::addr::AddrCtx,
    pub feed: Option<&'a ResidentFeed>,
    /// Where the Frontier transactions came from (⑲'s `history`).
    pub history: &'a crate::history::History,
    /// The acts another check found to need the pass's owner itself (V23:
    /// a SendCaravan to another player), as `(transaction, instruction)`.
    pub owner_required: &'a std::collections::BTreeSet<(usize, usize)>,
    /// The season's rules (`Ctx::v3`, `Ctx::s1`): which inner instructions
    /// the verifier models (`v0_coverage::supported`).
    pub v3: bool,
    pub s1: bool,
    /// Judge the wide world's WideResidentAct (0xDD) instead of the
    /// deployed ResidentAct (0xE2): [`run_wide`].
    pub wide: bool,
}

/// The inner commands `permutation-frontier` `proc::wide::resident_act`
/// runs for an NFT Citizen, by their `WideCommand` variant: WideClaimSite,
/// WideDepart, 0xDA's player Muster and Dissolve, and the wide economy's
/// Harvest/Build/Train (0xDA op 3). A test keeps this list equal to the
/// program's dispatch (`wide_act_runs_exactly_the_programs_dispatch`).
#[cfg(feature = "wide-world-experimental")]
pub const WIDE_ACT_COMMANDS: [&str; 5] = ["ClaimSite", "Depart", "Muster", "Dissolve", "Economy"];

/// A successful WideResidentAct's generation, inner command and its name, as
/// `proc::wide::resident_act` runs it: the ABI's own decode, then one of
/// [`WIDE_ACT_COMMANDS`] (`None`: the program refuses it).
#[cfg(feature = "wide-world-experimental")]
pub fn wide_act(d: &[u8]) -> Option<(u32, &[u8], &'static str)> {
    use frontier_abi::world_index::wide_ix::{ResidentAct, WideCommand as W};
    let x = ResidentAct::decode(d).ok()?;
    let name = match x.command().ok()? {
        W::ClaimSite(_) => "WideClaimSite",
        W::Depart(_) => "WideDepart",
        W::Muster(_) => "WideMuster",
        W::Dissolve(_) => "WideDissolve",
        W::Economy(_) => "WideEconomy",
        _ => return None,
    };
    Some((x.generation, x.inner, name))
}

/// Whether the program lets only the pass's owner (not its session) run
/// this inner instruction for an NFT Citizen in every case (CloseVault and
/// CloseStructure need the wallet, `WalletRequired`, for an NFT Citizen the
/// Core owner); a SendCaravan to another player is found by V23.
fn owner_only_always(inner: Option<frontier_abi::v2::Ix>) -> bool {
    use frontier_abi::v2::Ix::*;
    matches!(inner, Some(CloseVault | CloseStructure))
}

/// The policy at `key`: from a successful CreateResidentPolicy in the
/// archive (its data is the policy, its account 1 the policy account), else
/// from the resident record's policy accounts (written once: any read is its
/// value), owned by the program.
fn policy_of(w: &World, ac: &ActCtx, key: &Key) -> Option<ra::Policy> {
    let created = w
        .txs
        .iter()
        .filter(|t| t.ok)
        .flat_map(|t| t.ixs.iter())
        .filter(|x| x.tag() == Some(resident_wire::CREATE_RESIDENT_POLICY))
        .filter(|x| x.key(1).as_ref() == Some(key))
        .find_map(|x| match resident_wire::decode(&x.data) {
            Some(Command::CreatePolicy(p)) => Some(p),
            _ => None,
        });
    created.or_else(|| {
        ac.feed?
            .policies
            .get(key)
            .filter(|a| a.owner.to_bytes() == ac.addr.program)
            .and_then(|a| frontier_abi::resident_policy::read(&a.data))
    })
}

/// Which of the act's accounts are not at their canonical addresses (the
/// program's `resident_binding::canonical` and `read_policy`; PDAs and the
/// Citizen's seeded address of public program addresses, no key involved).
fn non_canonical(
    ac: &ActCtx,
    policy_data: Option<&ra::Policy>,
    [policy, link, asset, resident, citizen]: [Key; 5],
) -> Vec<&'static str> {
    use fclient::addr as fa;
    let a = solana_address::Address::new_from_array;
    let program = a(ac.addr.program);
    let mut bad = vec![];
    if policy != fa::resident_policy(&program).to_bytes() {
        bad.push("policy");
    }
    if link != fa::resident_link(&program, &a(ac.addr.season), &a(asset)).to_bytes() {
        bad.push("link");
    }
    let tag15 = frontier_abi::resident_citizen::resident_tag15(&asset);
    if citizen != ac.addr.citizen_by_tag15(&tag15) {
        bad.push("Citizen");
    }
    if let Some(p) = policy_data {
        let rp = a(p.resident_program);
        if resident != fa::resident_account(&rp, &a(asset)).to_bytes() {
            bad.push("resident account");
        }
        if p.guard_authority != fa::resident_guard(&rp).to_bytes() {
            bad.push("policy's guard authority");
        }
    }
    bad
}

fn view<'a>(key: Key, a: &'a Account) -> ra::Account<'a> {
    ra::Account {
        key,
        owner: a.owner.to_bytes(),
        data: &a.data,
    }
}

/// The successful JoinResident of `asset` at or before `(i, index)`.
fn join_of<'a>(w: &'a World, asset: &Key, i: usize, index: usize) -> Option<&'a Ix> {
    w.txs[..=i]
        .iter()
        .enumerate()
        .filter(|(_, t)| t.ok)
        .flat_map(|(j, t)| t.ixs.iter().map(move |x| (j, x)))
        .filter(|(j, x)| *j < i || x.index < index)
        .filter(|(_, x)| x.tag() == Some(resident_wire::JOIN_RESIDENT))
        .filter(|(_, x)| x.key(J_ASSET).as_ref() == Some(asset))
        .map(|(_, x)| x)
        .next_back()
}

/// The holder judgement of one act (FAIL, UNVERIFIABLE or nothing).
#[allow(clippy::too_many_arguments)]
fn judge_holder(
    w: &World,
    ac: &ActCtx,
    t: &Tx,
    binding: &ra::Binding,
    policy_key: &Key,
    actor: &Key,
    generation: u32,
    owner_only: bool,
) -> Option<(Severity, &'static str, String)> {
    let unproven = |d: &str| {
        Some((
            Severity::Unverifiable,
            RESIDENT_ACT_UNPROVEN,
            format!("the holder is not judged: {d}"),
        ))
    };
    let Some(feed) = ac.feed else {
        return unproven(
            "no record of the resident program (owner, generation, session) was given",
        );
    };
    let Some(policy) = policy_of(w, ac, policy_key) else {
        return unproven(
            "the policy account the act names is in neither the archive nor the record",
        );
    };
    if feed.program.to_bytes() != policy.resident_program {
        return unproven("the feed was filtered by another resident program");
    }
    let (Some(asset), Some(resident)) = (
        feed.state_before(&binding.asset, t.seq),
        feed.state_before(&binding.resident, t.seq),
    ) else {
        return unproven("the record has no state of the asset and resident before the act");
    };
    let gaps = feed.gaps_before(w, ac.history, t.seq);
    let firm = |d: String| {
        if gaps.is_empty() {
            Some((Severity::Fail, RESIDENT_OLD_AUTHORITY, d))
        } else {
            Some((
                Severity::Unverifiable,
                RESIDENT_ACT_UNPROVEN,
                format!("{d}; not decided: {}", gaps.join("; ")),
            ))
        }
    };
    let h = match ra::holder(
        binding,
        &policy,
        &view(binding.asset, asset),
        &view(binding.resident, resident),
    ) {
        Ok(h) => h,
        Err(r) => {
            return firm(format!(
                "the pass before the act is not one the program accepts ({r:?})"
            ))
        }
    };
    // The generation only grows (every change of holder adds one).
    if generation < h.generation {
        return Some((
            Severity::Fail,
            RESIDENT_OLD_AUTHORITY,
            format!(
                "the act signed generation {generation}; the pass was at generation {} before it: a signature from before a transfer was accepted",
                h.generation
            ),
        ));
    }
    if generation > h.generation {
        return firm(format!(
            "the act signed generation {generation}; the record shows generation {} and no later transfer",
            h.generation
        ));
    }
    match h.authority(actor, generation, t.time, !owner_only) {
        Ok(_) if gaps.is_empty() => None,
        Ok(_) => unproven(&format!(
            "the recorded authority matches, but its current state is unproven: {}",
            gaps.join("; ")
        )),
        Err(Refusal::NotCurrentAuthority)
            if owner_only && h.authority(actor, generation, t.time, true).is_ok() =>
        {
            let (sev, code, d) = firm(
                "the actor is the pass's live session; this act is the owner's only (the program refuses a session: WalletRequired)"
                    .to_string(),
            )?;
            Some((
                sev,
                if sev == Severity::Fail {
                    RESIDENT_OWNER_REQUIRED
                } else {
                    code
                },
                d,
            ))
        }
        Err(Refusal::NotCurrentAuthority) => {
            // Name what the actor was, for the report.
            let was_owner = feed
                .states_before(&binding.asset, t.seq)
                .any(|a| a.data.get(1..33) == Some(&actor[..]));
            let was_session = feed
                .states_before(&binding.resident, t.seq)
                .any(|r| r.data.get(52..84) == Some(&actor[..]));
            let who = if was_owner {
                "a previous owner"
            } else if was_session {
                "a session that is not live (another owner's, another generation's, or expired)"
            } else {
                "neither the owner nor its session"
            };
            firm(format!(
                "the actor is {who}, not the holder of generation {generation} or its live session"
            ))
        }
        Err(r) => firm(format!("the holder refuses the actor ({r:?})")),
    }
}

/// The findings for one successful transaction's ResidentActs.
pub fn judge_tx(w: &World, ac: &ActCtx, i: usize, t: &Tx) -> Vec<Found> {
    let mut out = vec![];
    for ix in &t.ixs {
        let mut push = |sev, code, d: String| out.push((sev, code, i, d));
        let (generation, inner, wide_name): (u32, &[u8], Option<&'static str>) = match ix.tag() {
            Some(resident_wire::RESIDENT_ACT) if !ac.wide => {
                // V0 fails data that does not decode.
                let Some(Command::Act { generation, inner }) = resident_wire::decode(&ix.data)
                else {
                    continue;
                };
                (generation, inner, None)
            }
            #[cfg(feature = "wide-world-experimental")]
            Some(frontier_abi::world_index::wide_ix::TAG_RESIDENT_ACT) if ac.wide => {
                match wide_act(&ix.data) {
                    Some((g, inner, name)) => (g, inner, Some(name)),
                    None => {
                        push(
                            Severity::Fail,
                            RESIDENT_ACT_MISMATCH,
                            "WideResidentAct succeeded with data the program refuses (not a whole player command it runs: WideClaimSite, WideDepart, the player Muster or Dissolve)".into(),
                        );
                        continue;
                    }
                }
            }
            _ => continue,
        };
        let inner_ix = match wide_name {
            None => frontier_abi::v2::Ix::from_tag(inner[0]),
            Some(_) => None,
        };
        if wide_name.is_none() && !resident_wire::act_runs(inner[0]) {
            push(
                Severity::Fail,
                RESIDENT_ACT_MISMATCH,
                format!(
                    "ResidentAct succeeded with inner {inner_ix:?} (tag {:#04x}), which the program refuses for an NFT Citizen",
                    inner[0]
                ),
            );
            continue;
        }
        let n = ix.accounts.len();
        if n < 8 {
            push(
                Severity::Fail,
                RESIDENT_ACT_MISMATCH,
                format!("ResidentAct succeeded with {n} accounts (the program needs 4 + 4)"),
            );
            continue;
        }
        let key = |p: usize| ix.accounts[p].0;
        let (policy, link, asset, resident) = (key(n - 4), key(n - 3), key(n - 2), key(n - 1));
        let (actor, citizen) = (key(ACTOR), key(CITIZEN));
        if ix.accounts[n - 4..].iter().any(|a| a.1) {
            push(
                Severity::Fail,
                RESIDENT_ACT_MISMATCH,
                "a proof account of the ResidentAct is writable (the program refuses it)".into(),
            );
        }
        if !ix.accounts[CITIZEN].1 {
            push(
                Severity::Fail,
                RESIDENT_ACT_MISMATCH,
                "the ResidentAct's Citizen is read-only (the program refuses it)".into(),
            );
        }
        if key(SEASON) != ac.addr.season {
            push(
                Severity::Fail,
                NON_CANONICAL_ADDRESS,
                "the ResidentAct's Season is not this Season".into(),
            );
        }
        let bad = non_canonical(
            ac,
            policy_of(w, ac, &policy).as_ref(),
            [policy, link, asset, resident, citizen],
        );
        if !bad.is_empty() {
            push(
                Severity::Fail,
                NON_CANONICAL_ADDRESS,
                format!(
                    "the ResidentAct's {} are not this pass's canonical ones in this Season",
                    bad.join(", ")
                ),
            );
        }
        // The accounts this pass joined with in this Season (one link per Season).
        match join_of(w, &asset, i, ix.index) {
            Some(j) => {
                let mut bad = vec![];
                for (what, have, pos) in [
                    ("policy", policy, J_POLICY),
                    ("link", link, J_LINK),
                    ("resident account", resident, J_RESIDENT),
                    ("Citizen", citizen, J_CITIZEN),
                ] {
                    if j.key(pos) != Some(have) {
                        bad.push(what);
                    }
                }
                if !bad.is_empty() {
                    push(
                        Severity::Fail,
                        RESIDENT_ACT_MISMATCH,
                        format!(
                            "the ResidentAct's {} differ from the ones this pass joined with",
                            bad.join(", ")
                        ),
                    );
                }
            }
            None => push(
                Severity::Unverifiable,
                RESIDENT_ACT_UNPROVEN,
                "the archive has no JoinResident of this pass in this Season".into(),
            ),
        }
        // The result: the prologue ran for this asset's NFT Citizen, now.
        if w.has_post {
            match t.post.get(&citizen) {
                Some(Some(a)) => {
                    let d = &a.data;
                    let mut bad = vec![];
                    if frontier_abi::resident_citizen::resident_asset(d) != Some(asset) {
                        bad.push("resident asset");
                    }
                    if d.get(C::WALLET..C::WALLET + 32) != Some(&[0u8; 32][..]) {
                        bad.push("zero wallet");
                    }
                    if d.get(C::LAST_ACTION_TS..C::LAST_ACTION_TS + 8)
                        != Some(&t.time.to_le_bytes()[..])
                    {
                        bad.push("last action time");
                    }
                    if !bad.is_empty() {
                        push(
                            Severity::Fail,
                            RESIDENT_ACT_MISMATCH,
                            format!(
                                "after the ResidentAct the Citizen's {} are not this pass's act at this time",
                                bad.join(", ")
                            ),
                        );
                    }
                }
                _ => push(
                    Severity::Unverifiable,
                    MISSING_POST_STATE,
                    "the archive has no post-state of the Citizen the ResidentAct wrote".into(),
                ),
            }
        }
        let binding = ra::Binding { asset, resident };
        // The wide commands take the owner or its live session alike
        // (`wide::player_start_as`: session allowed).
        let owner_only = wide_name.is_none()
            && (owner_only_always(inner_ix) || ac.owner_required.contains(&(i, ix.index)));
        if let Some((sev, code, d)) =
            judge_holder(w, ac, t, &binding, &policy, &actor, generation, owner_only)
        {
            push(sev, code, d);
        }
        // The inner instruction is listed in the transaction as itself
        // (`world::unwrap_resident`): the check that models it for a wallet
        // Citizen judges it. Only an inner instruction no check models
        // stays UNVERIFIABLE here.
        if let Some(name) = wide_name {
            // The wide command is VW's (workstream 4): no model of it yet.
            push(
                Severity::Unverifiable,
                RESIDENT_INNER_UNMODELLED,
                format!("the inner {name} is the wide world's; VW does not model it yet (WideUnmodelled)"),
            );
        } else if !inner_ix.is_some_and(|x| super::v0_coverage::supported(x, ac.v3, ac.s1)) {
            push(
                Severity::Unverifiable,
                RESIDENT_INNER_UNMODELLED,
                format!(
                    "the inner {inner_ix:?}: no check of this verifier models it for this season"
                ),
            );
        }
    }
    out
}

/// V28 over the archive, with the resident program's feed when one is given.
pub fn run_with(cx: &mut Ctx, feed: Option<&ResidentFeed>) {
    run_acts(cx, feed, false)
}

/// V28 over the wide world's WideResidentAct (0xDD; experimental build,
/// beside VW): the same holder, generation, session, accounts and result
/// as a ResidentAct; the inner wide command is handed to VW.
#[cfg(feature = "wide-world-experimental")]
pub fn run_wide(cx: &mut Ctx) {
    let input = cx.input;
    run_acts(cx, input.resident_feed.as_ref(), true)
}

fn run_acts(cx: &mut Ctx, feed: Option<&ResidentFeed>, wide: bool) {
    let owner_required = cx.owner_required.clone();
    let ac = ActCtx {
        addr: cx.f.ctx,
        feed,
        history: &cx.input.history,
        owner_required: &owner_required,
        v3: cx.v3,
        s1: cx.s1,
        wide,
    };
    let w = cx.w;
    let mut found = vec![];
    for (i, t) in w.txs.iter().enumerate() {
        if t.ok {
            found.extend(judge_tx(w, &ac, i, t));
        }
    }
    for (sev, code, i, d) in found {
        let entity = format!("tx#{i}");
        match sev {
            Severity::Fail => cx.fail(V, code, entity, 0, Some(i), d),
            _ => cx.unverifiable(V, code, entity, 0, Some(i), d),
        }
    }
}

/// V28 with the input's `resident_feed` (absent: the holder is UNVERIFIABLE).
pub fn run(cx: &mut Ctx) {
    let input = cx.input;
    run_with(cx, input.resident_feed.as_ref())
}

#[cfg(test)]
mod tests {
    //! Literal bytes and a literal feed. No key pair is generated or
    //! derived and nothing is signed. The policy, link, resident account,
    //! guard authority and Citizen are the canonical addresses of literal
    //! program, Season and asset addresses (PDAs and the Citizen's seeded
    //! address: sha256 and the curve check, allowed by the owner 2026-11-06).
    use super::*;
    use crate::history::History;
    use solana_address::Address;

    const PROGRAM: Key = [0x11; 32];
    const SEASON_K: Key = [0x22; 32];
    const CORE: Key = [0x33; 32];
    const RPROG: Key = [0x44; 32];
    const COLLECTION: Key = [0x55; 32];
    const NFT: Key = [0x5a; 32];
    const A: Key = [0xa1; 32];
    fn adr(k: Key) -> solana_address::Address {
        solana_address::Address::new_from_array(k)
    }
    fn addr_ctx() -> frontier_abi::addr::AddrCtx {
        frontier_abi::addr::AddrCtx {
            season: SEASON_K,
            program: PROGRAM,
        }
    }
    #[allow(non_snake_case)]
    fn GUARD() -> Key {
        fclient::addr::resident_guard(&adr(RPROG)).to_bytes()
    }
    #[allow(non_snake_case)]
    fn POLICY() -> Key {
        fclient::addr::resident_policy(&adr(PROGRAM)).to_bytes()
    }
    #[allow(non_snake_case)]
    fn LINK() -> Key {
        fclient::addr::resident_link(&adr(PROGRAM), &adr(SEASON_K), &adr(NFT)).to_bytes()
    }
    #[allow(non_snake_case)]
    fn RES() -> Key {
        fclient::addr::resident_account(&adr(RPROG), &adr(NFT)).to_bytes()
    }
    #[allow(non_snake_case)]
    fn CIT() -> Key {
        addr_ctx().citizen_by_tag15(&frontier_abi::resident_citizen::resident_tag15(&NFT))
    }
    const B: Key = [0xb2; 32];
    const SA: Key = [0xa5; 32];
    const SB: Key = [0xb5; 32];
    const T: i64 = 1_000_000;

    fn acc(owner: Key, data: Vec<u8>) -> Account {
        Account {
            lamports: 1,
            data,
            owner: Address::new_from_array(owner),
            executable: false,
        }
    }

    /// The guarded AssetV1 of `owner` (resident_auth's test layout).
    fn asset(owner: Key) -> Account {
        let mut d = vec![0u8; 75];
        d[0] = 1;
        d[1..33].copy_from_slice(&owner);
        d[33] = 2;
        d[34..66].copy_from_slice(&COLLECTION);
        let base = 75usize;
        let (freeze_at, transfer_at, registry_at) = (base + 9, base + 11, base + 12);
        d.push(3);
        d.extend_from_slice(&(registry_at as u64).to_le_bytes());
        d.extend_from_slice(&[5, 1, 7]);
        d.push(4);
        d.extend_from_slice(&2u32.to_le_bytes());
        for (kind, at) in [(5u8, freeze_at), (7u8, transfer_at)] {
            d.extend_from_slice(&[kind, 3]);
            d.extend_from_slice(&GUARD());
            d.extend_from_slice(&(at as u64).to_le_bytes());
        }
        d.extend_from_slice(&0u32.to_le_bytes());
        acc(CORE, d)
    }

    /// The resident account at `generation`, with `(session, setter)` set in it.
    fn resident(generation: u32, session: Option<(Key, Key)>) -> Account {
        let mut r = vec![0u8; 133];
        r[0] = 0xc2;
        r[1..33].copy_from_slice(&NFT);
        r[48..52].copy_from_slice(&generation.to_le_bytes());
        if let Some((s, setter)) = session {
            r[52..84].copy_from_slice(&s);
            r[84..92].copy_from_slice(&(T + 10_000).to_le_bytes());
            r[92..96].copy_from_slice(&generation.to_le_bytes());
            r[96..128].copy_from_slice(&setter);
        }
        acc(RPROG, r)
    }

    fn policy_account() -> Account {
        let mut d = vec![0u8; frontier_abi::resident_policy::LEN];
        assert!(frontier_abi::resident_policy::write_once(
            &mut d,
            &ra::Policy {
                core_program: CORE,
                resident_program: RPROG,
                collection: COLLECTION,
                guard_authority: GUARD(),
            }
        ));
        acc(PROGRAM, d)
    }

    fn citizen_after(time: i64) -> Account {
        let mut d = vec![0u8; C::SIZE];
        d[..8].copy_from_slice(&C::MAGIC);
        assert!(frontier_abi::resident_citizen::mark(&mut d, &NFT));
        d[C::LAST_ACTION_TS..C::LAST_ACTION_TS + 8].copy_from_slice(&time.to_le_bytes());
        acc(PROGRAM, d)
    }

    fn tx(seq: u64, ixs: Vec<Ix>, post: Vec<(Key, Account)>) -> Tx {
        Tx {
            seq,
            slot: seq,
            time: T + seq as i64,
            sig: format!("f{seq}"),
            ok: true,
            code: None,
            fee_payer: None,
            keys: vec![],
            ixs,
            recs: vec![],
            post: post.into_iter().map(|(k, a)| (k, Some(a))).collect(),
            cu_price: 0,
            cu_limit: 0,
            loaded_limit: 0,
        }
    }

    fn join() -> Ix {
        let keys: [Key; 10] = [
            A,
            A,
            SEASON_K,
            [0x33; 32],
            CIT(),
            [0; 32],
            POLICY(),
            LINK(),
            NFT,
            RES(),
        ];
        Ix {
            index: 0,
            data: vec![resident_wire::JOIN_RESIDENT, 0, 0, 0, 0, 1],
            accounts: keys.iter().map(|k| (*k, true)).collect(),
        }
    }

    /// A ResidentAct of Harvest (0x40) by `actor` at the signed `generation`.
    fn act(actor: Key, generation: u32) -> Ix {
        let mut data = vec![resident_wire::RESIDENT_ACT];
        data.extend_from_slice(&generation.to_le_bytes());
        data.push(0x40);
        let accounts = vec![
            (actor, false),
            (actor, true),
            (SEASON_K, false),
            (CIT(), true),
            (POLICY(), false),
            (LINK(), false),
            (NFT, false),
            (RES(), false),
        ];
        Ix {
            index: 0,
            data,
            accounts,
        }
    }

    /// A Season: the join at seq 1, then the acts at the given seqs (one
    /// ledger order with the feed's seqs).
    fn season(acts: Vec<(u64, Ix)>) -> World {
        let mut txs = vec![tx(1, vec![join()], vec![(CIT(), citizen_after(T + 1))])];
        for (seq, ix) in acts {
            let t = T + seq as i64;
            txs.push(tx(seq, vec![ix], vec![(CIT(), citizen_after(t))]));
        }
        World {
            program: PROGRAM,
            txs,
            has_post: true,
            ..Default::default()
        }
    }

    fn rtx(seq: u64, post: Vec<(Key, Account)>) -> ResidentTx {
        ResidentTx {
            seq,
            signature: format!("r{seq}"),
            ok: true,
            post: post.into_iter().collect(),
        }
    }

    /// The resident feed read through seq 11 (after the whole Season) from
    /// the same recorded order as the archive (two fixtures: as given).
    fn feed(txs: Vec<ResidentTx>) -> ResidentFeed {
        feed_through(txs, 11)
    }

    fn feed_through(txs: Vec<ResidentTx>, through: u64) -> ResidentFeed {
        ResidentFeed {
            program: adr(RPROG),
            history: History::default(),
            after: 0,
            through,
            tip: None,
            txs: txs.into_iter().filter(|t| t.seq <= through).collect(),
            policies: [(POLICY(), policy_account())].into_iter().collect(),
        }
    }

    fn judge(w: &World, f: Option<&ResidentFeed>) -> Vec<(usize, Severity, &'static str)> {
        judge_from(w, f, &History::default())
    }

    fn judge_from(
        w: &World,
        f: Option<&ResidentFeed>,
        history: &History,
    ) -> Vec<(usize, Severity, &'static str)> {
        judge_with(w, f, history, &Default::default(), true)
    }

    /// An S1 season (`s1`) unless said otherwise, with V23's owner-only acts.
    fn judge_with(
        w: &World,
        f: Option<&ResidentFeed>,
        history: &History,
        owner_required: &std::collections::BTreeSet<(usize, usize)>,
        s1: bool,
    ) -> Vec<(usize, Severity, &'static str)> {
        let ac = ActCtx {
            addr: addr_ctx(),
            feed: f,
            history,
            owner_required,
            v3: s1,
            s1,
            wide: false,
        };
        let mut out = vec![];
        for (i, t) in w.txs.iter().enumerate() {
            for (sev, code, j, _) in judge_tx(w, &ac, i, t) {
                out.push((j, sev, code));
            }
        }
        out
    }

    fn fails(v: &[(usize, Severity, &'static str)]) -> Vec<(usize, &'static str)> {
        v.iter()
            .filter(|x| x.1 == Severity::Fail)
            .map(|x| (x.0, x.2))
            .collect()
    }

    /// A → B → A: mint to A (seq 0... the record starts before the Season),
    /// A's session; transfer to B (generation 1), B's session; transfer back
    /// to A (generation 2).
    fn history() -> Vec<ResidentTx> {
        vec![
            rtx(2, vec![(NFT, asset(A)), (RES(), resident(0, None))]),
            rtx(3, vec![(RES(), resident(0, Some((SA, A))))]),
            // seq 4: A acts (owner), seq 5: A's session acts.
            rtx(6, vec![(NFT, asset(B)), (RES(), resident(1, None))]),
            rtx(7, vec![(RES(), resident(1, Some((SB, B))))]),
            // seq 8: B acts, seq 9: B's session acts.
            rtx(10, vec![(NFT, asset(A)), (RES(), resident(2, None))]),
            // seq 11: A acts at generation 2.
        ]
    }

    /// The honest acts of [`history`]'s Season (tx 1 to 5), with the act at
    /// `seq` replaced by `ix`.
    fn honest_with(seq: u64, ix: Option<Ix>) -> (World, usize) {
        let mut acts = vec![
            (4, act(A, 0)),
            (5, act(SA, 0)),
            (8, act(B, 1)),
            (9, act(SB, 1)),
            (11, act(A, 2)),
        ];
        let at = acts.iter().position(|a| a.0 == seq);
        if let (Some(p), Some(ix)) = (at, ix) {
            acts[p].1 = ix;
        }
        (season(acts), at.map_or(0, |p| p + 1))
    }

    #[test]
    fn the_holder_and_its_live_session_act_through_a_to_b_to_a() {
        let (w, _) = honest_with(0, None);
        let f = feed(history());
        let v = judge(&w, Some(&f));
        // Whole record, canonical accounts, the holder or its live session:
        // nothing left for V28 (the inner Harvest is judged as a Harvest,
        // `world::unwrap_resident`).
        assert_eq!(v, vec![]);
    }

    /// An act of `inner` (its tag only) by `actor` at `generation`.
    fn act_of(actor: Key, generation: u32, inner: frontier_abi::v2::Ix) -> Ix {
        let mut ix = act(actor, generation);
        ix.data[5] = inner as u8;
        ix
    }

    #[test]
    fn owner_only_acts_refuse_the_session() {
        use frontier_abi::v2::Ix as V;
        let f = feed(history());
        for inner in [V::CloseVault, V::CloseStructure] {
            // A's live session at generation 0 (seq 5): refused; A itself: fine.
            let (w, at) = honest_with(5, Some(act_of(SA, 0, inner)));
            assert_eq!(
                fails(&judge(&w, Some(&f))),
                vec![(at, RESIDENT_OWNER_REQUIRED)],
                "{inner:?}"
            );
            let (w, _) = honest_with(5, Some(act_of(A, 0, inner)));
            assert_eq!(
                fails(&judge(&w, Some(&f))),
                vec![],
                "{inner:?} by the owner"
            );
        }
        // V23 marks a SendCaravan to another player: B's session at seq 9.
        let (w, at) = honest_with(9, Some(act_of(SB, 1, V::SendCaravan)));
        let marked = [(at, 0usize)].into_iter().collect();
        let v = judge_with(&w, Some(&f), &History::default(), &marked, true);
        assert_eq!(fails(&v), vec![(at, RESIDENT_OWNER_REQUIRED)]);
        // Unmarked (a send to its own place): the session may.
        let v = judge_with(&w, Some(&f), &History::default(), &Default::default(), true);
        assert_eq!(fails(&v), vec![]);
        // With a stale copy of the record, a session's owner-only act is not decided.
        let (w, at) = honest_with(5, Some(act_of(SA, 0, V::CloseVault)));
        let v = judge(&w, Some(&feed_through(history(), 3)));
        assert_eq!(fails(&v), vec![]);
        assert!(v.contains(&(at, Severity::Unverifiable, RESIDENT_ACT_UNPROVEN)));
    }

    #[test]
    fn an_inner_instruction_no_check_models_stays_unverifiable() {
        use frontier_abi::v2::Ix as V;
        let f = feed(history());
        // S1's SendCaravan in a season without S1's rules: no check models it.
        let (w, at) = honest_with(4, Some(act_of(A, 0, V::SendCaravan)));
        let v = judge_with(
            &w,
            Some(&f),
            &History::default(),
            &Default::default(),
            false,
        );
        assert!(v.contains(&(at, Severity::Unverifiable, RESIDENT_INNER_UNMODELLED)));
        // Harvest is modelled everywhere.
        let (w, _) = honest_with(4, None);
        let v = judge_with(
            &w,
            Some(&f),
            &History::default(),
            &Default::default(),
            false,
        );
        assert!(!v.iter().any(|x| x.2 == RESIDENT_INNER_UNMODELLED));
    }

    #[test]
    fn a_resident_act_is_listed_as_the_instruction_it_ran() {
        let ix = act(A, 0);
        let inner = crate::world::unwrap_resident(&ix).expect("a Harvest act unwraps");
        assert_eq!(inner.data, vec![0x40]);
        assert_eq!(
            inner.accounts,
            ix.accounts[..4].to_vec(),
            "without the proof accounts"
        );
        assert_eq!(inner.index, ix.index);
        let mut t = tx(4, vec![ix.clone(), inner.clone()], vec![]);
        assert!(t.via_resident(&inner));
        assert!(!t.via_resident(&ix), "the act itself is not");
        // A plain Harvest of the same accounts in another instruction slot is not.
        let mut plain = inner.clone();
        plain.index = 1;
        t.ixs.push(plain.clone());
        assert!(!t.via_resident(&plain));
        // Nothing for a refused inner tag or too few accounts.
        let mut bad = act(A, 0);
        bad.data[5] = frontier_abi::v2::Ix::SetSession as u8;
        assert!(crate::world::unwrap_resident(&bad).is_none());
        let mut short = act(A, 0);
        short.accounts.truncate(7);
        assert!(crate::world::unwrap_resident(&short).is_none());
    }

    #[test]
    fn old_owners_old_sessions_and_old_generations_accepted_are_fails() {
        for (seq, ix, what) in [
            (8, act(A, 1), "A after the transfer to B, at B's generation"),
            (8, act(A, 0), "A's signature from before the transfer"),
            (8, act(SA, 1), "A's session after the transfer"),
            (11, act(B, 2), "B after the buy-back"),
            (11, act(SB, 2), "B's session after the buy-back"),
            (
                11,
                act(A, 0),
                "A's generation-0 signature after A bought back",
            ),
            (11, act(SA, 2), "A's old session after A bought back"),
        ] {
            let (w, at) = honest_with(seq, Some(ix));
            let f = feed(history());
            let v = judge(&w, Some(&f));
            assert_eq!(fails(&v), vec![(at, RESIDENT_OLD_AUTHORITY)], "{what}");
        }
    }

    #[test]
    fn without_a_whole_record_only_a_stale_generation_is_a_fail() {
        // No record at all: UNVERIFIABLE, never PASS.
        let w = season(vec![(8, act(A, 1))]);
        let v = judge(&w, None);
        assert_eq!(fails(&v), vec![]);
        assert!(v.contains(&(1, Severity::Unverifiable, RESIDENT_ACT_UNPROVEN)));
        // A stale copy read through seq 6 (before B's SetSession at 7): an
        // actor that is not the owner may be a session the copy lacks.
        let f = feed_through(history(), 6);
        let (w, at) = honest_with(9, None);
        let v = judge(&w, Some(&f));
        assert_eq!(fails(&v), vec![]);
        assert!(v.contains(&(at, Severity::Unverifiable, RESIDENT_ACT_UNPROVEN)));
        // Read through the Season, the same act by A (no longer the holder) is a FAIL.
        let (w, at) = honest_with(9, Some(act(A, 1)));
        assert_eq!(
            fails(&judge(&w, Some(&feed(history())))),
            vec![(at, RESIDENT_OLD_AUTHORITY)]
        );
        // A signed generation below one the copy shows is a FAIL even from
        // the stale copy: the generation never goes back.
        let (w, at) = honest_with(8, Some(act(A, 0)));
        assert_eq!(
            fails(&judge(&w, Some(&f))),
            vec![(at, RESIDENT_OLD_AUTHORITY)]
        );
        // A signed generation above the copy's (read through 5, before the
        // transfer at 6): the transfer is missing.
        let (w, at) = honest_with(8, None);
        let v = judge(&w, Some(&feed_through(history(), 5)));
        assert_eq!(fails(&v), vec![]);
        assert!(v.contains(&(at, Severity::Unverifiable, RESIDENT_ACT_UNPROVEN)));
        // A feed whose seq 1 is another transaction than the archive's
        // (two separate numberings): not one order.
        let mut h3 = history();
        h3[0].seq = 1;
        let (w, at) = honest_with(8, Some(act(A, 1)));
        let v = judge(&w, Some(&feed(h3)));
        assert_eq!(fails(&v), vec![]);
        assert!(v.contains(&(at, Severity::Unverifiable, RESIDENT_ACT_UNPROVEN)));
        // The game history over public RPC (⑲: unproven): not decided either.
        let rpc = History::rpc(serde_json::json!({"state": "cross_checked"}), "rpc x");
        let v = judge_from(&w, Some(&feed(history())), &rpc);
        assert_eq!(fails(&v), vec![]);
        assert!(v.contains(&(at, Severity::Unverifiable, RESIDENT_ACT_UNPROVEN)));
    }

    #[test]
    fn inner_accounts_and_result_are_judged_against_the_join() {
        let f = feed(history());
        // SetSession inside: the program refuses it for an NFT Citizen.
        let mut ix = act(A, 0);
        ix.data[5] = frontier_abi::v2::Ix::SetSession as u8;
        ix.data.extend_from_slice(&[0; 40]);
        let w = season(vec![(4, ix)]);
        assert_eq!(
            fails(&judge(&w, Some(&f))),
            vec![(1, RESIDENT_ACT_MISMATCH)]
        );
        // Another pass's link: not canonical, and not the one it joined with.
        let mut ix = act(A, 0);
        ix.accounts[5].0 = [0x78; 32];
        let w = season(vec![(4, ix)]);
        assert_eq!(
            fails(&judge(&w, Some(&f))),
            vec![(1, NON_CANONICAL_ADDRESS), (1, RESIDENT_ACT_MISMATCH)]
        );
        let mut ix = act(A, 0);
        ix.accounts[7].1 = true;
        let w = season(vec![(4, ix)]);
        assert_eq!(
            fails(&judge(&w, Some(&f))),
            vec![(1, RESIDENT_ACT_MISMATCH)]
        );
        // Another Season's account.
        let mut ix = act(A, 0);
        ix.accounts[2].0 = [0x23; 32];
        let w = season(vec![(4, ix)]);
        assert_eq!(
            fails(&judge(&w, Some(&f))),
            vec![(1, NON_CANONICAL_ADDRESS)]
        );
        // The Citizen after the act is not this pass's, or not acted at this time.
        let mut w = season(vec![(4, act(A, 0))]);
        w.txs[1].post.insert(CIT(), Some(citizen_after(T)));
        assert_eq!(
            fails(&judge(&w, Some(&f))),
            vec![(1, RESIDENT_ACT_MISMATCH)]
        );
        let mut w = season(vec![(4, act(A, 0))]);
        let mut c = citizen_after(T + 4);
        c.data[C::WALLET] = 1;
        w.txs[1].post.insert(CIT(), Some(c));
        assert_eq!(
            fails(&judge(&w, Some(&f))),
            vec![(1, RESIDENT_ACT_MISMATCH)]
        );
        // No JoinResident of this pass in the archive: UNVERIFIABLE.
        let mut w = season(vec![(4, act(A, 0))]);
        w.txs[0].ixs.clear();
        let v = judge(&w, Some(&f));
        assert_eq!(fails(&v), vec![]);
        assert!(v.contains(&(1, Severity::Unverifiable, RESIDENT_ACT_UNPROVEN)));
    }

    /// CreateResidentPolicy in the archive: `[authority] [policy] ..` and its data.
    fn create_policy(guard: Key) -> Ix {
        let mut data = vec![resident_wire::CREATE_RESIDENT_POLICY];
        for k in [CORE, RPROG, COLLECTION, guard] {
            data.extend_from_slice(&k);
        }
        Ix {
            index: 0,
            data,
            accounts: vec![([0x70; 32], true), (POLICY(), true)],
        }
    }

    #[test]
    fn canonical_addresses_are_judged_with_or_without_the_join() {
        // Without the JoinResident and without the record: the addresses are
        // still the program's to compute, so a wrong one is a FAIL.
        let mut w = season(vec![(4, act(A, 0))]);
        w.txs[0].ixs.clear();
        let v = judge(&w, None);
        assert_eq!(fails(&v), vec![], "canonical: only UNVERIFIABLE");
        for (pos, what) in [(4, "policy"), (5, "link"), (3, "Citizen")] {
            let mut ix = act(A, 0);
            ix.accounts[pos].0 = [0x78; 32];
            let mut w = season(vec![(4, ix)]);
            w.txs[0].ixs.clear();
            assert_eq!(
                fails(&judge(&w, None)),
                vec![(1, NON_CANONICAL_ADDRESS)],
                "{what}"
            );
        }
        // The link of the same pass in another Season is not this Season's.
        let mut ix = act(A, 0);
        ix.accounts[5].0 =
            fclient::addr::resident_link(&adr(PROGRAM), &adr([0x23; 32]), &adr(NFT)).to_bytes();
        let mut w = season(vec![(4, ix)]);
        w.txs[0].ixs.clear();
        assert_eq!(fails(&judge(&w, None)), vec![(1, NON_CANONICAL_ADDRESS)]);
        // The resident account is judged once the policy is known: from the
        // archive's CreateResidentPolicy, with no record.
        let mut ix = act(A, 0);
        ix.accounts[7].0 = [0x78; 32];
        let mut w = season(vec![(4, ix.clone())]);
        w.txs[0].ixs = vec![create_policy(GUARD())];
        assert_eq!(fails(&judge(&w, None)), vec![(1, NON_CANONICAL_ADDRESS)]);
        let mut w = season(vec![(4, ix)]);
        w.txs[0].ixs.clear();
        assert_eq!(
            fails(&judge(&w, None)),
            vec![],
            "policy unknown: not judged"
        );
        // A policy whose guard authority is not the resident program's.
        let mut w = season(vec![(4, act(A, 0))]);
        w.txs[0].ixs = vec![create_policy([0x67; 32]), join()];
        assert_eq!(fails(&judge(&w, None)), vec![(1, NON_CANONICAL_ADDRESS)]);
    }
    #[test]
    fn a_wrong_program_feed_cannot_judge_a_holder() {
        let (w, _) = honest_with(0, None);
        let mut f = feed(history());
        f.program = solana_address::Address::new_from_array([0x91; 32]);
        let v = judge(&w, Some(&f));
        assert!(fails(&v).is_empty());
        assert_eq!(
            v.iter()
                .filter(|(_, severity, code)| *severity == Severity::Unverifiable
                    && *code == RESIDENT_ACT_UNPROVEN)
                .count(),
            5
        );
    }

    #[test]
    fn matching_authority_in_a_partial_feed_is_still_unproven() {
        let (w, _) = honest_with(0, None);
        let mut f = feed(history());
        f.after = 1;
        let v = judge(&w, Some(&f));
        assert!(fails(&v).is_empty());
        assert_eq!(
            v.iter()
                .filter(|(_, severity, code)| *severity == Severity::Unverifiable
                    && *code == RESIDENT_ACT_UNPROVEN)
                .count(),
            5
        );
    }

    /// A WideResidentAct (0xDD) of a WideClaimSite by `actor` at `generation`,
    /// over the same accounts as [`act`].
    #[cfg(feature = "wide-world-experimental")]
    fn wide(actor: Key, generation: u32) -> Ix {
        use frontier_abi::world_index::wide_ix::{ClaimSite, ResidentAct};
        let inner = ClaimSite {
            p: 3,
            q: -2,
            site: 1,
            slot: 0,
        }
        .to_bytes();
        let mut data = vec![0u8; ResidentAct::HEAD + inner.len()];
        let n = ResidentAct {
            generation,
            inner: &inner,
        }
        .encode_into(&mut data)
        .unwrap();
        data.truncate(n);
        Ix {
            data,
            ..act(actor, generation)
        }
    }

    #[cfg(feature = "wide-world-experimental")]
    fn judge_wide(w: &World, f: Option<&ResidentFeed>) -> Vec<(usize, Severity, &'static str)> {
        let empty = Default::default();
        let h = History::default();
        let ac = ActCtx {
            addr: addr_ctx(),
            feed: f,
            history: &h,
            owner_required: &empty,
            v3: true,
            s1: true,
            wide: true,
        };
        let mut out = vec![];
        for (i, t) in w.txs.iter().enumerate() {
            for (sev, code, j, _) in judge_tx(w, &ac, i, t) {
                out.push((j, sev, code));
            }
        }
        out
    }

    /// The wide world's NFT entry (0xDD) under the same holder contract:
    /// the holder and its live session through A→B→A, an old owner, an old
    /// session and a pre-transfer signature refused, the inner wide command
    /// handed to VW (UNVERIFIABLE), refused data FAIL. Literal bytes only.
    #[cfg(feature = "wide-world-experimental")]
    #[test]
    fn the_wide_resident_act_is_judged_by_the_same_holder_contract() {
        let f = feed(history());
        let acts = |sub: Option<(u64, Ix)>| {
            let mut v = vec![
                (4, wide(A, 0)),
                (5, wide(SA, 0)),
                (8, wide(B, 1)),
                (9, wide(SB, 1)),
                (11, wide(A, 2)),
            ];
            let mut at = 0;
            if let Some((seq, ix)) = sub {
                let p = v.iter().position(|a| a.0 == seq).unwrap();
                v[p].1 = ix;
                at = p + 1;
            }
            (season(v), at)
        };
        let (w, _) = acts(None);
        let v = judge_wide(&w, Some(&f));
        assert_eq!(fails(&v), vec![]);
        assert_eq!(v.len(), 5, "{v:?}");
        assert!(v
            .iter()
            .all(|x| x.1 == Severity::Unverifiable && x.2 == RESIDENT_INNER_UNMODELLED));
        for (seq, ix, what) in [
            (8, wide(A, 1), "A after the transfer"),
            (8, wide(A, 0), "A's signature from before the transfer"),
            (8, wide(SA, 1), "A's session after the transfer"),
            (11, wide(SB, 2), "B's session after the buy-back"),
        ] {
            let (w, at) = acts(Some((seq, ix)));
            assert_eq!(
                fails(&judge_wide(&w, Some(&f))),
                vec![(at, RESIDENT_OLD_AUTHORITY)],
                "{what}"
            );
        }
        // Refused data: an inner that is no player command of the band.
        let mut bad = wide(A, 0);
        bad.data[5] = frontier_abi::v2::Ix::Harvest as u8;
        let (w, at) = acts(Some((4, bad)));
        assert_eq!(
            fails(&judge_wide(&w, Some(&f))),
            vec![(at, RESIDENT_ACT_MISMATCH)]
        );
        // The two entries do not judge each other's acts.
        let (w, _) = acts(None);
        assert_eq!(judge(&w, Some(&f)), vec![], "0xDD is not V28's 0xE2 path");
        let (w, _) = honest_with(0, None);
        assert_eq!(
            judge_wide(&w, Some(&f)),
            vec![],
            "0xE2 is not the wide path"
        );
    }

    /// The program's dispatch, read as text (no build of the program): the
    /// `C::<Variant>(..) =>` arms of `proc::wide::resident_act`.
    #[cfg(feature = "wide-world-experimental")]
    #[test]
    fn wide_act_runs_exactly_the_programs_dispatch() {
        let src = include_str!("../../../../../permutation-frontier/src/proc/wide.rs");
        let start = src.find("pub fn resident_act(").expect("resident_act");
        let body = &src[start..];
        let body = &body[..body.find("\n}\n").expect("end of resident_act")];
        let mut arms: Vec<&str> = body
            .lines()
            .filter_map(|l| l.trim().strip_prefix("C::"))
            .filter_map(|l| l.split('(').next())
            .collect();
        arms.sort();
        let mut want = WIDE_ACT_COMMANDS.to_vec();
        want.sort();
        assert_eq!(
            arms, want,
            "V28's WideResidentAct list drifted from the program"
        );
    }

    /// The wide economy through 0xDD (Harvest, op 3): judged like the other
    /// four (no FAIL for the holder; the inner is VW's), a stale owner refused.
    #[cfg(feature = "wide-world-experimental")]
    #[test]
    fn a_wide_economy_act_is_accepted_like_the_other_commands() {
        use frontier_abi::world_index::economy::Action;
        use frontier_abi::world_index::wide_ix::{Economy, ResidentAct};
        let econ = |actor: Key, generation: u32| {
            // The ABI's own canonical envelope of a Harvest (0xDA op 3).
            let inner = Economy {
                action: Action::Harvest,
            }
            .to_bytes()
            .unwrap();
            let mut data = vec![0u8; ResidentAct::HEAD + inner.len()];
            let n = ResidentAct {
                generation,
                inner: &inner,
            }
            .encode_into(&mut data)
            .unwrap();
            data.truncate(n);
            Ix {
                data,
                ..act(actor, generation)
            }
        };
        let f = feed(history());
        let w = season(vec![(4, econ(A, 0))]);
        let v = judge_wide(&w, Some(&f));
        assert_eq!(fails(&v), vec![], "{v:?}");
        assert!(v.contains(&(1, Severity::Unverifiable, RESIDENT_INNER_UNMODELLED)));
        let w = season(vec![(8, econ(A, 1))]);
        assert_eq!(
            fails(&judge_wide(&w, Some(&f))),
            vec![(1, RESIDENT_OLD_AUTHORITY)]
        );
    }
}
