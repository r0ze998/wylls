//! VWL, part 5 — the wide HOST and the BELL of a playable-lane season
//! (Q16-1 = A continued, 2026-11-19): **WideMuster** (0xDA op 1, the wallet
//! form) and **WideResolve** (0xDC op 1), and with them the wide **keep
//! capture**: the 72-bell hold (`keep_bells` of the Season) is counted bell
//! by bell inside WideResolve (`world_index::resolve::step` →
//! `keep::advance_with`), so a re-run of every WideResolve is a re-run of
//! the capture. The program's handlers are `permutation-frontier`
//! `proc/wide.rs` `muster_as` and `resolve_inner` (the plain
//! `resolve`, never `resolve_with_conquest`).
//!
//! * **WideMuster** `[actor] [payer w] [season] [citizen w] [holding w]
//!   [province w] [roster w] [system]`, in the handler's order: the player
//!   prologue (wallet or unexpired session), this build's Running Season;
//!   the holding at its canonical wide address, of this world, the
//!   Citizen's (`NotOwner`); its province canonical, the holding not
//!   capture-locked; the holding final (`NotFinal`); the province resolved
//!   through `b − 2` (`NotResident`); the unit a host unit, the reserve
//!   (`Insufficient`), the kernel's host bounds (`Host::muster`); the tile
//!   passable; the caps and the first free entry (`ProvinceFull`); the
//!   roster at its address, present (this province's) or created from the
//!   payer, paired with the entry table, the alias claimed at the entry;
//!   the Citizen's bucket and end bell. Written: the muster-pending entry
//!   (`from_bell = b + 1`, the doctrine's Hold `dealt`), `roster_epoch + 1`,
//!   `n_entries + 1`; the holding touched, the reserve debited, `host_seq +
//!   1`, the host identity allocated at its first muster; the Citizen's
//!   bucket and action time; the `WIDE_MUSTER` record chained to the
//!   province and the holding, compared with the one the transaction
//!   printed.
//! * **WideResolve** `[fee_payer w] [season] [province w] [roster w] [seed]
//!   [anchor] [clash_inputs] [arrivalday] [system]`: the keeper prologue,
//!   this build's Season Running or Ended; the province canonical; the
//!   bell `resolved_next` and before the end bell; THE anchor's reveal
//!   window closed at the transaction's time (`TooEarly`) and THE anchor's
//!   SeedCache seed of `(bell, region)` (as WideSettleTicket's; an
//!   AnchorArchive read is `MissingData`); the ArrivalDay bit; the
//!   ClashInputs absent (no arrival: the residents alone) or present, this
//!   province's and bell's, fully gathered and not resolved; the roster
//!   present or absent while no entry is live (then created from the fee
//!   payer only if the bell claims an entry). Then the shared kernel
//!   `resolve_bell` (build, clash under the seed, apply, settle, the keep
//!   step, finish) over the archive's bytes, the resolved arrivals and the
//!   resolver, the resolve summary, the input and output digests and the
//!   `WIDE_RESOLVE` record chained to the province, compared with the one
//!   printed; every written byte compared.
//!
//! What this part does **not** prove: the ClashInputs' own provenance
//! (the raw WideGather and WideReveal are VX's since verifier-coverage-2:
//! re-executed, not ported; the raw WideReveal never runs on the
//! devnet-playable binary, V0 `GateClosed`), THE anchor's and the
//! SeedCache's provenance (PostAnchor / PostSeed, the S1 checks' job), and
//! anything the program and the shared kernels have in common (as V7, VL).
//! WideResolveWithConquest is VX's through the expedition dispatch envelope
//! (its raw form never succeeds: `CONQUEST_LIFECYCLE_ENABLED = false`), and
//! an NFT resident's WideResidentAct(Muster) is a V0 FAIL in the playable
//! lane, whose program refuses every WideResidentAct (verifier-coverage).
//! WideDissolve, WideReturn, WideCloseRoster and WideDisbandStranded, the
//! rest of the host lifecycle, are re-executed by VX (`vx_reexec::native_of`).

use frontier_abi::entry::{write_entry, Entry};
use frontier_abi::layout::beacon::bell_anchor as BA;
use frontier_abi::layout::header as HDR;
use frontier_abi::layout::player::{citizen as C, holding as H};
use frontier_abi::layout::province::{entry as E, summary as SU};
use frontier_abi::prologue::resident_ok;
use frontier_abi::v2::presets::CONQUEST_VERSION;
use frontier_abi::world_index::arrival::{
    self as wa, wide_clash_inputs as WCI, WideArrivalDay, WideClashInputsHdr,
};
use frontier_abi::world_index::event::{self as wev, WideEntity, WideKind, WideLink};
use frontier_abi::world_index::holding::{self as wh, WideHolding};
use frontier_abi::world_index::march::wide_host_alias;
use frontier_abi::world_index::resolve as wres;
use frontier_abi::world_index::roster::{self as wro, WideRoster};
use frontier_abi::world_index::{ProvinceKey, WideHostRef};
use permutation_rules::fixed::MilliTroops;
use permutation_rules::frontier::beacon::{self as kb, WindowSchedule};
use permutation_rules::frontier::catalog;
use permutation_rules::frontier::clash::frontier_ruleset;
use permutation_rules::frontier::doctrine::of_faction_v3;
use permutation_rules::frontier::host::Host;
use permutation_rules::frontier::stance::{Posture, Stance};

use super::claims::{
    capture_locked, holding_rec, province_of, seed_of_bell, signed, wide_before, wr_i64,
};
use super::*;
use crate::holding as hr;

pub(super) fn judged(cmd: &WideCommand) -> Option<&'static str> {
    match cmd {
        WideCommand::Muster(_) => Some("WideMuster"),
        WideCommand::Resolve(_) => Some("WideResolve"),
        _ => None,
    }
}

/// The program's `prepare_wide`: the record's body, every link from the
/// headers as they are, the tail, then the headers advanced.
pub(super) fn wide_record(
    kind: WideKind,
    bell: u32,
    key: &[u8],
    payload: &[u8],
    chained: &mut [(WideEntity, &mut [u8])],
) -> Result<Vec<u8>, Wrong> {
    if chained.len() > wev::MAX_LINKS || chained.len() != kind.links().len() {
        return Err(fail(WIDE_RULE, "the record's link set"));
    }
    let mut out = [0u8; wev::MAX_BODY];
    let n = wev::write_body(kind, bell, key, payload, &mut out)
        .ok_or_else(|| fail(WIDE_RULE, "the record's widths"))?;
    let mut links = vec![];
    for (entity, d) in chained.iter() {
        let seq = le(d, HDR::EVENT_SEQ, 8);
        let head: [u8; 32] = d
            .get(HDR::EVENT_HEAD..HDR::EVENT_HEAD + 32)
            .and_then(|s| s.try_into().ok())
            .ok_or_else(|| fail(WIDE_ACCOUNTS, "a chained account is short"))?;
        links.push(
            wev::advance(*entity, seq, &head, &out[..n])
                .ok_or_else(|| fail(WIDE_RULE, "an event chain overflows"))?,
        );
    }
    let m = wev::write_tail(kind, &links, &mut out, n)
        .ok_or_else(|| fail(WIDE_RULE, "the record's tail"))?;
    for (l, (_, d)) in links.iter().zip(chained.iter_mut()) {
        set_chain(d, l);
    }
    Ok(out[..m].to_vec())
}

fn set_chain(d: &mut [u8], l: &WideLink) {
    wr_u64(d, HDR::EVENT_SEQ, l.seq);
    d[HDR::EVENT_HEAD..HDR::EVENT_HEAD + 32].copy_from_slice(&l.head);
}

/// The one wide record the transaction printed must be `want`.
pub(super) fn printed_is(e: &Env, want: &[u8], what: &str) -> Result<(), Wrong> {
    let logs = e.recs.get(e.tx).map(|t| t.logs.as_slice()).unwrap_or(&[]);
    let program = b58(&e.ctx.program);
    let bodies = super::super::vw_chains::psw1_bodies(logs, &program).map_err(|why| {
        Missing(format!(
            "the transaction's logs do not read ({why}): its {what} record is not in the archive"
        ))
    })?;
    match bodies.as_slice() {
        [] => Err(Missing(format!(
            "the transaction's logs carry no wide record: the {what} record is not in the archive"
        ))),
        [one] if one == want => Ok(()),
        [one] => Err(fail(
            WIDE_REPLAY_MISMATCH,
            format!(
                "the printed {what} record is not the re-run's ({})",
                first_diff(one, want)
            ),
        )),
        many => Err(fail(
            WIDE_REPLAY_MISMATCH,
            format!(
                "{} wide records (the handler prints exactly one)",
                many.len()
            ),
        )),
    }
}

fn res(er: wres::ResolveError) -> Wrong {
    fail(
        WIDE_RULE,
        format!("the resolve model refuses ({er:?}; the program refuses)"),
    )
}

/// The roster position before: `Some((record, bytes))` present and this
/// province's; `None` absent.
fn roster_before(
    e: &Env,
    k: &Key,
    pkey: ProvinceKey,
) -> Result<Option<(WideRoster, Vec<u8>)>, Wrong> {
    match wide_before(e, k, "the roster")? {
        None => Ok(None),
        Some(a) => {
            let r = WideRoster::read(&a.data)
                .map_err(|er| fail(WIDE_ACCOUNTS, format!("the roster: {er:?}")))?;
            if r.season_id != e.sid || r.province != pkey {
                return Err(fail(
                    WIDE_ACCOUNTS,
                    "the roster is of another season or province",
                ));
            }
            Ok(Some((r, a.data)))
        }
    }
}

/// A roster created by the instruction: exactly the re-run's bytes,
/// program-owned (its lamports are the runtime's rent from the payer).
fn created_roster(e: &Env, k: &Key, want: &[u8]) -> Result<(), Wrong> {
    expect_after(e, k, want, "the created roster").map(|_| ())
}

// ------------------------------------------------------------ 0xDA op 1

pub(super) fn muster(e: &Env, ix: &Ix, x: &wix::Muster) -> Result<Vec<(Key, Lam)>, Wrong> {
    n_accounts(ix, 8, "WideMuster")?;
    let k = |i: usize| ix.accounts[i].0;
    let (citizen, holding, province, roster_k) = (k(3), k(4), k(5), k(6));
    for (i, what) in [
        (3, "the Citizen"),
        (4, "the holding"),
        (5, "the province"),
        (6, "the roster"),
    ] {
        writable(ix, i, what, true)?;
    }
    if k(7) != SYSTEM {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the eighth account is not the system program",
        ));
    }
    // The player prologue (steps 1–2), this build's Running Season.
    let sk = e.ctx.season;
    if k(2) != sk {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the third account is not this season's Season",
        ));
    }
    let sd = e.before(&sk, "the Season")?.data;
    let mut cd = e.before(&citizen, "the Citizen")?.data;
    let start = {
        let (a0, a1) = (k(0), k(1));
        let views = [
            signed(e, &a0, &[], ix.accounts[0].1),
            signed(e, &a1, &[], ix.accounts[1].1),
            signed(e, &sk, &sd, ix.accounts[2].1),
            signed(e, &citizen, &cd, ix.accounts[3].1),
        ];
        frontier_abi::prologue::player_prologue(
            &views,
            &e.ctx.program,
            &RULESET_HASH_V3,
            e.now,
            true,
        )
        .map_err(|er| {
            fail(
                WIDE_ACCOUNTS,
                format!("the player prologue refuses ({er:?})"),
            )
        })?
    };
    e.season_at(ix, 2, &[S::STATUS_RUNNING])?;
    let now_bell = start.season.bell(e.now).ok_or_else(|| {
        fail(
            WIDE_RULE,
            "before genesis (the program refuses WrongStatus)",
        )
    })?;
    let world = e.world()?;
    // 1. the holding and its own province.
    let ha = wide_before(e, &holding, "the holding")?.ok_or_else(|| {
        fail(
            WIDE_ACCOUNTS,
            "the holding is absent (the program refuses BadAccount)",
        )
    })?;
    let h = holding_rec(e, &ha.data)?;
    if h.world != world {
        return Err(fail(WIDE_ACCOUNTS, "the holding is of another world"));
    }
    if holding != wh::holding_address(&e.ctx, h.coord, h.site) {
        return Err(fail(WIDE_ACCOUNTS, "the holding is not at its address"));
    }
    if h.owner_citizen != citizen {
        return Err(fail(
            WIDE_RULE,
            "the holding is not this Citizen's (the program refuses NotOwner)",
        ));
    }
    let (_prov, pd) = province_of(e, &province, h.coord, world)?;
    capture_locked(&pd, &ha.data)?;
    let pkey = ProvinceKey::new(world, h.coord);
    // 2. the deployed Muster's checks, in its order.
    let hd = ha.data;
    let unit_ok = (x.unit as usize) < H::RESERVE_N;
    let (faction, seq) = (hd[H::FACTION], le(&hd, H::HOST_SEQ, 4) as u32);
    let have = if unit_ok {
        le(&hd, H::reserve(x.unit as usize), 4) as u32
    } else {
        0
    };
    if hd[H::STATE] != H::STATE_FINAL {
        return Err(fail(
            WIDE_RULE,
            "the holding is not final (the program refuses NotFinal)",
        ));
    }
    let rn = le(&pd, PV::RESOLVED_NEXT, 4) as u32;
    if !resident_ok(rn, now_bell) {
        return Err(fail(
            WIDE_RULE,
            format!(
                "the province is resolved to bell {rn}, not through bell {} (the program refuses NotResident)",
                now_bell.saturating_sub(2)
            ),
        ));
    }
    let unit = catalog::unit_of(x.unit)
        .filter(|_| unit_ok)
        .ok_or_else(|| fail(WIDE_RULE, "not a unit (the program refuses BadData)"))?;
    if have < x.troops {
        return Err(fail(
            WIDE_RULE,
            format!(
                "{} troops from a reserve of {have} (the program refuses Insufficient)",
                x.troops
            ),
        ));
    }
    let milli: MilliTroops = x.troops.checked_mul(MILLI as u32).ok_or_else(|| {
        fail(
            WIDE_RULE,
            "the host is too large (the program refuses Kernel)",
        )
    })?;
    let host = WideHostRef::new(pkey, h.site, h.gen, seq)
        .map_err(|er| fail(WIDE_ACCOUNTS, format!("the host reference: {er:?}")))?;
    let alias = wide_host_alias(&host);
    let kh = Host::muster(alias, alias, faction, unit, milli, now_bell).map_err(|er| {
        fail(
            WIDE_RULE,
            format!("the host kernel refuses ({er:?}; the program refuses)"),
        )
    })?;
    let passable = le(&pd, PV::PASSABLE_MASK, 8);
    if x.tile as usize >= PV::TILES || passable & (1u64 << x.tile) == 0 {
        return Err(fail(
            WIDE_RULE,
            "the tile is not passable (the program refuses BadData)",
        ));
    }
    let dealt = of_faction_v3(faction)
        .ok_or_else(|| fail(WIDE_ACCOUNTS, "the holding's faction"))?
        .dealt_bps(Posture::Stance(Stance::Hold), false);
    let dealt = u16::try_from(dealt).map_err(|_| fail(WIDE_RULE, "the doctrine overflows"))?;
    let slot = {
        let (mut total, mut own, mut free) = (0usize, 0usize, None);
        for i in 0..PV::ENTRIES_N {
            let o = PV::entry(i);
            match pd[o + E::STATE] {
                E::STATE_FREE => {
                    free.get_or_insert(i);
                }
                E::STATE_ROSTER | E::STATE_MUSTER_PENDING => {
                    total += 1;
                    if pd[o + E::FACTION] == faction {
                        own += 1;
                    }
                }
                _ => {}
            }
        }
        if total >= PV::ROSTER_CAP || own >= PV::FACTION_CAP {
            return Err(fail(
                WIDE_RULE,
                "the province's caps (the program refuses ProvinceFull)",
            ));
        }
        free.ok_or_else(|| {
            fail(
                WIDE_RULE,
                "no free entry (the program refuses ProvinceFull)",
            )
        })?
    };
    // 3. the roster side table.
    if roster_k != wro::roster_address(&e.ctx, pkey) {
        return Err(fail(WIDE_ACCOUNTS, "the roster is not at its address"));
    }
    let (roster, mut rd, create) = match roster_before(e, &roster_k, pkey)? {
        Some((r, d)) => (r, d, false),
        None => {
            let r = WideRoster::new(e.sid, pkey, k(1));
            let mut d = vec![0u8; wro::wide_roster::SIZE];
            r.write_header(&mut d)
                .map_err(|er| fail(WIDE_ACCOUNTS, format!("the roster header: {er:?}")))?;
            (r, d, true)
        }
    };
    roster
        .validate_paired(&rd, &wres::live_ids(&pd).map_err(res)?)
        .map_err(|er| {
            fail(
                WIDE_RULE,
                format!("the roster is not paired with the entries ({er:?})"),
            )
        })?;
    let claimed = roster
        .claim(&mut rd, slot, &host)
        .map_err(|er| fail(WIDE_RULE, format!("the alias cannot be claimed ({er:?})")))?;
    if claimed != alias {
        return Err(fail(WIDE_RULE, "the claimed alias is not the host's"));
    }
    let entry = Entry::from_host(&kh, x.tile, E::STATE_MUSTER_PENDING, dealt, now_bell + 1);
    start
        .finish(&mut cd, e.now)
        .map_err(|er| fail(WIDE_RULE, format!("the bucket refuses ({er:?})")))?;
    let seq_next = seq
        .checked_add(1)
        .ok_or_else(|| fail(WIDE_RULE, "host_seq overflows"))?;
    // ---- the writes
    let mut pdw = pd.clone();
    write_entry(&mut pdw, slot, &entry)
        .map_err(|er| fail(WIDE_RULE, format!("the entry: {er:?}")))?;
    let epoch = (le(&pdw, PV::ROSTER_EPOCH, 4) as u32).wrapping_add(1);
    wr_u32(&mut pdw, PV::ROSTER_EPOCH, epoch);
    pdw[PV::N_ENTRIES] = pdw[PV::N_ENTRIES]
        .checked_add(1)
        .ok_or_else(|| fail(WIDE_RULE, "n_entries overflows"))?;
    let mut hdw = hr::touched(&hd, e.now)
        .map_err(|er| fail(WIDE_REPLAY_MISMATCH, format!("the holding's accrual: {er}")))?;
    // `holding::write` re-derives M1's shield for a layout that is not v2;
    // the program's `write_holding` keeps the shield a wide holding was
    // founded with (D-verifier-wide-march-2).
    hdw[H::SHIELD_UNTIL..H::SHIELD_UNTIL + 8]
        .copy_from_slice(&hd[H::SHIELD_UNTIL..H::SHIELD_UNTIL + 8]);
    wr_u32(&mut hdw, H::reserve(x.unit as usize), have - x.troops);
    wr_u32(&mut hdw, H::HOST_SEQ, seq_next);
    if h.host_identity == wh::HOST_IDENTITY_UNALLOCATED {
        WideHolding::allocate_identity(&mut hdw)
            .map_err(|er| fail(WIDE_RULE, format!("the host identity: {er:?}")))?;
    }
    wr_i64(&mut cd, C::LAST_ACTION_TS, e.now);
    let record = wide_record(
        WideKind::Muster,
        now_bell,
        &wev::host_key(&host, pkey),
        &wev::muster_payload(x.unit, x.troops, x.tile, slot as u8, alias),
        &mut [
            (WideEntity::Province, &mut pdw[..]),
            (WideEntity::Holding, &mut hdw[..]),
        ],
    )?;
    expect_after(e, &province, &pdw, "the wide province")?;
    expect_after(e, &holding, &hdw, "the holding")?;
    expect_after(e, &citizen, &cd, "the Citizen")?;
    let roster_lam = if create {
        created_roster(e, &roster_k, &rd)?;
        Lam::Created
    } else {
        expect_after(e, &roster_k, &rd, "the roster")?;
        Lam::Same
    };
    printed_is(e, &record, "WIDE_MUSTER")?;
    Ok(vec![
        (province, Lam::Same),
        (holding, Lam::Same),
        (citizen, Lam::Same),
        (roster_k, roster_lam),
    ])
}

// ------------------------------------------------------------ 0xDC op 1

pub(super) fn resolve(e: &Env, ix: &Ix, x: &wix::Resolve) -> Result<Vec<(Key, Lam)>, Wrong> {
    n_accounts(ix, 9, "WideResolve")?;
    let k = |i: usize| ix.accounts[i].0;
    let (payer, province, roster_k, seed_k, anchor_k, inputs_k, day_k) =
        (k(0), k(2), k(3), k(4), k(5), k(6), k(7));
    writable(ix, 0, "the fee payer", true)?;
    writable(ix, 2, "the province", true)?;
    writable(ix, 3, "the roster", true)?;
    if k(8) != SYSTEM {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the ninth account is not the system program",
        ));
    }
    // The keeper prologue, this build's Season Running or Ended.
    let sk = e.ctx.season;
    if k(1) != sk {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the second account is not this season's Season",
        ));
    }
    let sd = e.season_at(ix, 1, &[S::STATUS_RUNNING, S::STATUS_ENDED])?;
    let hdr = {
        let views = [signed(e, &payer, &[], true), signed(e, &sk, &sd, false)];
        frontier_abi::prologue::keeper_prologue(
            &views,
            &e.ctx.program,
            &RULESET_HASH_V3,
            &[S::STATUS_RUNNING, S::STATUS_ENDED],
            e.now,
        )
        .map_err(|er| {
            fail(
                WIDE_ACCOUNTS,
                format!("the keeper prologue refuses ({er:?})"),
            )
        })?
    };
    let world = e.world()?;
    let pa = wide_before(e, &province, "the wide province")?.ok_or_else(|| {
        fail(
            WIDE_ACCOUNTS,
            "the wide province is absent (the program refuses BadAccount)",
        )
    })?;
    let coord = WideProvince::read(&pa.data)
        .map_err(|er| fail(WIDE_ACCOUNTS, format!("the wide province: {er:?}")))?
        .coord;
    let (prov, pd) = province_of(e, &province, coord, world)?;
    let pkey = ProvinceKey::new(world, coord);
    let rn = le(&pd, PV::RESOLVED_NEXT, 4) as u32;
    if x.bell != rn {
        return Err(fail(
            WIDE_RULE,
            format!(
                "bell {} is not the province's next ({rn}; the program refuses OutOfOrder)",
                x.bell
            ),
        ));
    }
    if x.bell >= hdr.end_bell {
        return Err(fail(
            WIDE_RULE,
            "the bell is at or after the end bell (the program refuses WrongStatus)",
        ));
    }
    // THE anchor's seed (its fields, address and round as the program
    // checks them), then the window over THE anchor's time.
    let (seed, _round) = seed_of_bell(e, &sd, &seed_k, &anchor_k, x.bell, prov.region)?;
    let a_ts = e
        .acct_before(&anchor_k)
        .map(|a| super::claims::rd_i64(&a.data, BA::A))
        .ok_or_else(|| Missing("the bell anchor: no state before".into()))?;
    let sched = WindowSchedule {
        reveal_window: le(&sd, S::REVEAL_WINDOW, 4) as u32,
        window_next: le(&sd, S::WINDOW_NEXT, 4) as u32,
        window_from_bell: le(&sd, S::WINDOW_FROM_BELL, 4) as u32,
    };
    let close = kb::reveal_close(a_ts, kb::window(&sched, x.bell));
    if e.now < close {
        return Err(fail(
            WIDE_RULE,
            format!(
                "the reveal window of bell {} closes at {close}, after the transaction (the program refuses TooEarly)",
                x.bell
            ),
        ));
    }
    // The arrival evidence.
    let day = wa::day_of(x.bell);
    if day_k != wa::arrival_day_address(&e.ctx, pkey, day) {
        return Err(fail(WIDE_ACCOUNTS, "the ArrivalDay is not at its address"));
    }
    let arrivals_expected = match wide_before(e, &day_k, "the ArrivalDay")? {
        None => false,
        Some(a) => {
            let rec = WideArrivalDay::read(&a.data)
                .map_err(|er| fail(WIDE_ACCOUNTS, format!("the ArrivalDay: {er:?}")))?;
            if rec.season_id != e.sid || rec.dest != pkey || rec.day != day {
                return Err(fail(
                    WIDE_ACCOUNTS,
                    "the ArrivalDay is of another season, destination or day",
                ));
            }
            rec.has(x.bell)
        }
    };
    if inputs_k != wa::clash_inputs_address(&e.ctx, pkey, x.bell) {
        return Err(fail(WIDE_ACCOUNTS, "the ClashInputs is not at its address"));
    }
    let cd_before: Vec<u8> = match wide_before(e, &inputs_k, "the ClashInputs")? {
        None => {
            if arrivals_expected {
                return Err(fail(
                    WIDE_RULE,
                    "the bell has arrivals and no gathered ClashInputs (the program refuses NotGathered)",
                ));
            }
            vec![]
        }
        Some(a) => {
            writable(ix, 6, "the ClashInputs", true)?;
            let ih = WideClashInputsHdr::read(&a.data)
                .map_err(|er| fail(WIDE_ACCOUNTS, format!("the ClashInputs: {er:?}")))?;
            if ih.season_id != e.sid || ih.dest != pkey || ih.bell != x.bell {
                return Err(fail(
                    WIDE_ACCOUNTS,
                    "the ClashInputs is of another season, province or bell",
                ));
            }
            if ih.arrivals_mask != WCI::ALL_GATHERED {
                return Err(fail(
                    WIDE_RULE,
                    "the ClashInputs is not fully gathered (the program refuses NotGathered)",
                ));
            }
            if ih.flags & WCI::FLAG_RESOLVED != 0 {
                return Err(fail(
                    WIDE_RULE,
                    "the ClashInputs is already resolved (the program refuses AlreadyDone)",
                ));
            }
            a.data
        }
    };
    let prm = frontier_abi::conquest_model::StepParams::of_season(&sd)
        .filter(|p| p.cq.conquest_version == CONQUEST_VERSION)
        .ok_or_else(|| fail(WIDE_ACCOUNTS, "the Season's step parameters"))?;
    if roster_k != wro::roster_address(&e.ctx, pkey) {
        return Err(fail(WIDE_ACCOUNTS, "the roster is not at its address"));
    }
    let mut pd_s = pd.clone();
    let (roster, mut rd_s, present) = match roster_before(e, &roster_k, pkey)? {
        Some((r, d)) => (r, d, true),
        None => {
            if wres::live_ids(&pd_s)
                .map_err(res)?
                .iter()
                .any(|e| e.is_some())
            {
                return Err(fail(
                    WIDE_RULE,
                    "live entries and no roster (the program refuses BadAccount)",
                ));
            }
            let r = WideRoster::new(e.sid, pkey, payer);
            let mut d = vec![0u8; wro::wide_roster::SIZE];
            r.write_header(&mut d)
                .map_err(|er| fail(WIDE_ACCOUNTS, format!("the roster header: {er:?}")))?;
            (r, d, false)
        }
    };
    let rd_initial = rd_s.clone();
    let input = wev::resolve_input_digest(pkey, x.bell, &seed, &sd, &pd_s, &rd_s, &cd_before);
    let mut cd_s = cd_before;
    let out = wres::resolve_bell(
        &mut pd_s,
        &roster,
        &mut rd_s,
        (!cd_s.is_empty()).then_some(&cd_s[..]),
        x.bell,
        &seed,
        &frontier_ruleset(),
        &prm,
    )
    .map_err(res)?;
    let n_arrivals = if cd_s.is_empty() {
        0
    } else {
        wres::write_resolved(&mut cd_s, &out.applied).map_err(res)?;
        let mut ih = WideClashInputsHdr::read(&cd_s)
            .map_err(|er| fail(WIDE_ACCOUNTS, format!("the ClashInputs: {er:?}")))?;
        ih.resolver = x.beneficiary;
        ih.resolved_ts = e
            .now
            .saturating_sub(hdr.genesis_ts)
            .clamp(0, u32::MAX as i64) as u32;
        ih.write(&mut cd_s)
            .map_err(|er| fail(WIDE_ACCOUNTS, format!("the ClashInputs: {er:?}")))?;
        ih.n_present
    };
    {
        let o = PV::RESOLVE_SUMMARY;
        wr_u32(&mut pd_s, o + SU::BELL, x.bell);
        wr_u32(&mut pd_s, o + SU::ENGAGEMENTS, out.clash.engagements);
        pd_s[o + SU::ARRIVALS] = n_arrivals;
        pd_s[o + SU::DESTROYED] = out.applied.destroyed;
        pd_s[o + SU::BOUNCED] = out.applied.bounced;
        pd_s[o + SU::RESOLVER..o + SU::RESOLVER + 8].copy_from_slice(&x.beneficiary[..8]);
    }
    let output = wev::resolve_output_digest(&out.clash.digest(), &pd_s, &rd_s, &cd_s);
    let create_roster = !present && rd_s != rd_initial;
    if create_roster
        && wres::live_ids(&pd_s)
            .map_err(res)?
            .iter()
            .all(|e| e.is_none())
    {
        return Err(fail(
            WIDE_RULE,
            "a roster created with no live entry (the program refuses BadAccount)",
        ));
    }
    let payload = wev::resolve_payload(
        &input,
        &output,
        out.clash.engagements,
        out.applied.destroyed,
        out.applied.bounced,
        out.settled,
    );
    let record = wide_record(
        WideKind::Resolve,
        x.bell,
        &pkey.to_bytes(),
        &payload,
        &mut [(WideEntity::Province, &mut pd_s[..])],
    )?;
    expect_after(e, &province, &pd_s, "the wide province")?;
    let mut wrote = vec![(province, Lam::Same)];
    if present {
        expect_after(e, &roster_k, &rd_s, "the roster")?;
        wrote.push((roster_k, Lam::Same));
    } else if create_roster {
        created_roster(e, &roster_k, &rd_s)?;
        wrote.push((roster_k, Lam::Created));
    }
    if !cd_s.is_empty() {
        expect_after(e, &inputs_k, &cd_s, "the ClashInputs")?;
        wrote.push((inputs_k, Lam::Same));
    }
    printed_is(e, &record, "WIDE_RESOLVE")?;
    Ok(wrote)
}
