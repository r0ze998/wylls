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
//! UNVERIFIABLE, never PASS: the inner instruction's own effects (no replay
//! of an NFT Citizen's instruction yet: `ResidentInnerUnmodelled`); the
//! holder without the resident program's record (`ResidentActUnproven`; a
//! Frontier archive does not hold it); a pass with no JoinResident in the
//! archive; post-states the archive lacks.
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
    match h.authority(actor, generation, t.time, true) {
        Ok(_) => None,
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
        if ix.tag() != Some(resident_wire::RESIDENT_ACT) {
            continue;
        }
        // V0 fails data that does not decode.
        let Some(Command::Act { generation, inner }) = resident_wire::decode(&ix.data) else {
            continue;
        };
        let mut push = |sev, code, d: String| out.push((sev, code, i, d));
        let inner_ix = frontier_abi::v2::Ix::from_tag(inner[0]);
        if !resident_wire::act_runs(inner[0]) {
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
        if let Some((sev, code, d)) = judge_holder(w, ac, t, &binding, &policy, &actor, generation)
        {
            push(sev, code, d);
        }
        push(
            Severity::Unverifiable,
            RESIDENT_INNER_UNMODELLED,
            format!("the inner {inner_ix:?}'s own effects are not replayed for an NFT Citizen"),
        );
    }
    out
}

/// V28 over the archive, with the resident program's feed when one is given.
pub fn run_with(cx: &mut Ctx, feed: Option<&ResidentFeed>) {
    let ac = ActCtx {
        addr: cx.f.ctx,
        feed,
        history: &cx.input.history,
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
        let ac = ActCtx {
            addr: addr_ctx(),
            feed: f,
            history,
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
        assert_eq!(fails(&v), vec![]);
        // Each act is still UNVERIFIABLE for its inner instruction only.
        for (_, sev, code) in &v {
            assert_eq!(
                (*sev, *code),
                (Severity::Unverifiable, RESIDENT_INNER_UNMODELLED)
            );
        }
        assert_eq!(v.len(), 5);
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
}
