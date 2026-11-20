//! **TEST-ONLY local play rules and wide PLAY** (owner t379u 「広い版がんばれ」, 2026-11-19): what makes the centre and
//! the wide land playable in a LOCAL natural world. Nothing here is a devnet or on-chain default: the program, its
//! presets (`frontier_abi::v2::presets`) and the devnet `.so` are unchanged. Every knob below is a byte of the local
//! world's OWN CreateSeason (the program validates it as for any season), or a step the runner takes with the
//! program's own instructions.
//!
//! **The knobs** ([`local_free`], [`local_wide`]; stated on the runner's first line as `local_rules`):
//!
//! - every natural local world (plain, kept, demo-free; and the wide one): conquest byte 81 `centre` =
//!   `CENTRE_FREE` (⑭ R2, #69): no Concord, no Seats; rings 0–1 are ordinary land. The presets keep
//!   `CENTRE_PLAYABLE` = `CENTRE_CONCORD` (the devnet switch stays r0ze's). The ring-1 provinces are opened by the
//!   setup ([`centre_provinces`]); (0,0) is not, because the page's wasm `generate_province` still draws the
//!   Concord's land there (the program and verifier use `generate_province_in(.., centre_free)`).
//! - the wide world only: conquest byte `outpost_tier_min` = 0 (a Hamlet first home anchors a wide claim; Town = 1
//!   takes 6 h and 1,000/600/300 units after a rim home exists). Since owner decision Q-W1 (2026-11-20) the wide
//!   world's own preset `S1_DEVNET_WIDE_7D` says 0 too, so this byte no longer differs from it (`S1_LOCAL_7D` keeps 1)
//!   and [`rules_metadata`] lists it only if a preset ever differs again.
//!
//! **The steps** (wide world only):
//!
//! - [`settle_rim`], in the setup on its synthetic clock: on the rim provinces opened beside the wide land, one TEST
//!   participant per nation per province takes a REAL first home by the legacy ticket (FileTicket → PostAnchor →
//!   PostSeed with public Quicknet rounds → SettleTicket). A first home on the rim cannot come from PlaceHome (⑭ R3:
//!   outside the heartland a PlaceHome needs a settled target or a settled witness within `spawn_reach` 2, and the
//!   heartland is 125 rings away). Once settled, a rim province is a legal PlaceHome target for anyone of its
//!   nation (R3: `target_used > 0`): the page and the AI residents place their homes there, with no witness.
//! - [`run_claims`], after `ready-for-join`: the wide claims' class-D duty that no live keeper has yet (gap 1 of
//!   verify-pr70): for every open wide ticket (0xD9 WideClaimSite, filed by a player or an AI resident) it posts the
//!   ticket bell's anchor and seed in the wide province's region (public rounds) and lands 0xDC WideSettleTicket;
//!   for every provisional wide holding, 0xDF WideFinalize once due.
use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use fclient::addr::Addresses;
use fclient::{ix, AccountMeta, Address, Instruction, Keypair, Signer};
use frontier_abi::addr::AddrCtx;
use frontier_abi::v2::presets::{ConquestParams, SeasonParamsV2, CENTRE_FREE};
use frontier_abi::world_index::holding::{self as wh, WideHolding};
use frontier_abi::world_index::land::{self as wl, WideProvince};
use frontier_abi::world_index::ticket::{self as wt, TicketStatus, WideTicket};
use frontier_abi::world_index::wide_ix as wix;
use frontier_abi::world_index::WideCoord;
use localnet::server::{lock, Shared};
use permutation_rules::frontier::geometry::{home_nation_in, ProvinceCoord};
use serde_json::{json, Value};

use crate::expedition_play::PROGRAM;
use crate::local_keeper as lk;

pub const LOCAL_RULES_MODE: &str = "local-rules-v1";
pub const WIDE_PLAY_SCHEMA: &str = "frontier-localnet-wide-play-v1";
/// The wide world's `outpost_tier_min`: 0 = Hamlet (`S1_DEVNET_WIDE_7D` has it too since Q-W1; the other presets: 1 = Town).
pub const WIDE_OUTPOST_TIER_MIN: u8 = 0;
/// Rim provinces settled per nation by the setup's TEST participants.
pub const RIM_PER_NATION: usize = 2;
const SETTLER_LAMPORTS: u64 = 5_000_000_000;

/// Every natural local world: the centre free (⑭ R2). Every other byte unchanged.
pub fn local_free(p: SeasonParamsV2) -> SeasonParamsV2 {
    let mut q = p;
    q.cq.centre = CENTRE_FREE;
    q
}

/// The wide local world: [`local_free`] and a Hamlet first home anchors a wide claim.
pub fn local_wide(p: SeasonParamsV2) -> SeasonParamsV2 {
    let mut q = local_free(p);
    q.cq.outpost_tier_min = WIDE_OUTPOST_TIER_MIN;
    q
}

/// The statement on the runner's first line: which bytes differ from the named preset, and why.
pub fn rules_metadata(preset: &str, wide: bool) -> Value {
    let mut changed = vec![
        json!({"byte": "conquest.centre (81)", "preset": 0, "local": 1,
        "why": "⑭ R2 centre-free: no Concord or Seats, rings 0-1 ordinary land (presets keep CENTRE_PLAYABLE = 0 until r0ze switches devnet)"}),
    ];
    // (the wide world runs on `S1_DEVNET_WIDE_7D`, whose own byte is the Hamlet since Q-W1: listed only if it differs)
    let wide_preset_tier = frontier_abi::v2::presets::S1_DEVNET_WIDE_7D
        .cq
        .outpost_tier_min;
    if wide && wide_preset_tier != WIDE_OUTPOST_TIER_MIN {
        changed.push(
            json!({"byte": "conquest.outpost_tier_min", "preset": wide_preset_tier, "local": WIDE_OUTPOST_TIER_MIN,
            "why": "a Hamlet rim home anchors a wide claim (Q-W1)"}),
        );
    }
    json!({"mode": LOCAL_RULES_MODE, "preset": preset, "test_only": true, "changed": changed,
        "not_devnet": "the program, its presets and the devnet .so are unchanged; only this local world's CreateSeason bytes differ"})
}

/// The ring-1 provinces of a centre-free Season, `(p, q, nation)` (the mixed nation of ⑭ R2). (0,0) is left out (the
/// page's terrain kernel, module doc). None when the Season keeps its centre.
pub fn centre_provinces(cq: &ConquestParams, seed: &[u8; 32]) -> Vec<(i16, i16, u8)> {
    if cq.centre != CENTRE_FREE {
        return vec![];
    }
    let mut out = vec![];
    for (p, q) in [(1, 0), (1, -1), (0, -1), (-1, 0), (-1, 1), (0, 1)] {
        let c = ProvinceCoord::new(p, q);
        if let Some(n) = home_nation_in(c, cq.placement, cq.heartland_max_ring, seed, true) {
            out.push((p as i16, q as i16, n));
        }
    }
    out
}

/// The rim provinces each nation's TEST participants settle: per nation `n`, the first province of that mixed nation in
/// the rim arcs of wedges `n`, `n + 3`, … (mod 6, in `rim`'s order), [`RIM_PER_NATION`] of them, so the nations start
/// spread around the world. Pure.
pub fn rim_homes(rim: &[(i32, i32)], cq: &ConquestParams, seed: &[u8; 32]) -> Vec<(i16, i16, u8)> {
    let nation = |p: i32, q: i32| {
        home_nation_in(
            ProvinceCoord::new(p, q),
            cq.placement,
            cq.heartland_max_ring,
            seed,
            cq.centre == CENTRE_FREE,
        )
    };
    let mut out = vec![];
    for n in 0..6u8 {
        let mut got = 0;
        for k in [0u8, 3, 1, 4, 2, 5] {
            if got >= RIM_PER_NATION {
                break;
            }
            let w = (n + k) % 6;
            if let Some(&(p, q)) = rim.iter().find(|&&(p, q)| {
                ProvinceCoord::new(p, q).wedge() == Some(w) && nation(p, q) == Some(n)
            }) {
                out.push((p as i16, q as i16, n));
                got += 1;
            }
        }
    }
    out
}

fn step(s: &str, extra: Value) {
    let mut v = json!({"schema": WIDE_PLAY_SCHEMA, "wide_play_step": s, "test_only": true});
    if let (Some(o), Value::Object(e)) = (v.as_object_mut(), extra) {
        o.extend(e);
    }
    eprintln!("{v}");
}

fn read(state: &Shared, k: &Address) -> Option<Vec<u8>> {
    lock(state).account(k).map(|x| x.data)
}

fn ctx(a: &Addresses) -> AddrCtx {
    AddrCtx {
        program: PROGRAM,
        season: a.season.to_bytes(),
    }
}
fn addr(b: [u8; 32]) -> Address {
    Address::new_from_array(b)
}

/// Where the beacon evidence of one (bell, region) stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Seed {
    /// The SeedCache (nonce 0) is there.
    Ready,
    /// The next step can be sent no earlier than this chain time.
    Wait(i64),
}

/// One step toward the SeedCache of (`bell`, `region`), nonce 0: the anchor (round T(bell), after the bell ended),
/// then the seed (round S(bell, A), after the anchor's reveal window closed). Sends at most one instruction (with
/// `send_ix`); the rounds come from the public drand API, verified against the pinned key.
pub async fn seed_step<F>(
    state: &Shared,
    a: &Addresses,
    payer: &Keypair,
    bell: u32,
    region: u8,
    mut send_ix: F,
) -> Result<Seed, String>
where
    F: FnMut(Instruction, String) -> Result<(), String>,
{
    if read(state, &a.seed_cache(bell, region, 0)).is_some() {
        return Ok(Seed::Ready);
    }
    let (clock, now, landed) = {
        let c = lock(state);
        (
            lk::season_clock(&c, a)?,
            c.unix_timestamp(),
            lk::anchor_landed(&c, a, bell, region)?,
        )
    };
    match landed {
        None => {
            let round = clock.tlock_round(bell);
            let at = clock.drand.round_time(round);
            if now < at {
                return Ok(Seed::Wait(at));
            }
            let sig = lk::fetch_round_at(round).await?;
            let r = lk::RoundProvenance {
                bell,
                round,
                signature_hex: hex::encode(sig),
                source: format!("{}/public/{round}", lk::DRAND_URL),
                verified_against:
                    "fclient::beacon::quicknet_info().public_key (pinned Quicknet key)",
            };
            send_ix(
                lk::post_anchor_ix(a, &payer.pubkey(), region, &r)?,
                format!("PostAnchor(bell {bell}, region {region})"),
            )?;
            Ok(Seed::Wait(now))
        }
        Some(anchor_ts) => {
            let round = clock.seed_round(bell, anchor_ts);
            let at = clock.drand.round_time(round);
            if now < at {
                return Ok(Seed::Wait(at));
            }
            let sig = lk::fetch_round_at(round).await?;
            let arg = ix::BeaconArg {
                round,
                sig48: sig,
                hints: fclient::beacon::hints_bytes(round),
            };
            send_ix(
                ix::post_seed(a, payer.pubkey(), region, bell, 0, &arg, &payer.pubkey()),
                format!("PostSeed(bell {bell}, region {region})"),
            )?;
            Ok(Seed::Wait(now))
        }
    }
}

/// The setup's rim settlers (module doc): for each of `homes` (rim provinces, [`rim_homes`]) one TEST participant of
/// its nation Joins, files a one-site ticket on its first free site, and the ticket is settled on the bell's real
/// beacon evidence. `send` / `advance_to` are the natural world's synthetic-clock helpers. Returns one JSON row per
/// settler.
pub async fn settle_rim(
    state: &Shared,
    a: &Addresses,
    payer: &Keypair,
    homes: &[(i16, i16, u8)],
    send: &impl Fn(&Shared, &[&Keypair], &[Instruction], &str) -> Result<String, String>,
    advance_to: &impl Fn(&Shared, i64) -> Result<(), String>,
) -> Result<Vec<Value>, String> {
    use frontier_abi::v2::layout::player::citizen as C;
    let now = || lock(state).unix_timestamp();
    let mut filed = vec![];
    for &(p, q, nation) in homes {
        let k = Keypair::new();
        let w = k.pubkey();
        {
            let mut c = lock(state);
            c.airdrop(&w, SETTLER_LAMPORTS)?;
            c.produce_block();
        }
        send(
            state,
            &[&k],
            &[ix::join(a, w, w, nation, &w, now() + 30 * 86_400, None)],
            "rim participant Join",
        )?;
        let site = crate::wide_land::free_site(state, a, p, q).ok_or("no free rim site")?;
        let s = ix::Site { p, q, site };
        let player = ix::Player {
            actor: w,
            payer: w,
            wallet: w,
        };
        send(
            state,
            &[&k],
            &[ix::file_ticket(a, &player, &[s])],
            "rim participant FileTicket",
        )?;
        let cd = read(state, &a.citizen(&w)).ok_or("the rim participant's Citizen")?;
        let bell = u32::from_le_bytes(cd[C::TICKET_BELL..C::TICKET_BELL + 4].try_into().unwrap());
        filed.push((k, nation, s, bell, ix::region_of(p as i32, q as i32)));
    }
    // the beacon evidence of every (bell, region), on the synthetic clock
    let keys: BTreeSet<(u32, u8)> = filed.iter().map(|f| (f.3, f.4)).collect();
    for (bell, region) in keys {
        for _ in 0..6 {
            let mut sent = vec![];
            let st = seed_step(state, a, payer, bell, region, |i, what| {
                sent.push((i, what));
                Ok(())
            })
            .await?;
            for (i, what) in sent {
                send(state, &[payer], &[i], &what)?;
            }
            match st {
                Seed::Ready => break,
                Seed::Wait(t) => advance_to(state, t.max(now()) + 1)?,
            }
        }
        if read(state, &a.seed_cache(bell, region, 0)).is_none() {
            return Err(format!("no seed for bell {bell} region {region}"));
        }
    }
    let mut out = vec![];
    for (k, nation, s, bell, _) in &filed {
        let w = k.pubkey();
        send(
            state,
            &[payer],
            &[ix::settle_ticket(
                a,
                payer.pubkey(),
                &w,
                *nation,
                0,
                *s,
                *bell,
                &[*s],
                ix::SeedSource::Cache { nonce: 0 },
                None,
            )],
            "rim participant SettleTicket",
        )?;
        out.push(
            json!({"nation": nation, "p": s.p, "q": s.q, "site": s.site, "ticket_bell": bell}),
        );
    }
    step("rim_settled", json!({"settlers": out}));
    Ok(out)
}

// ------------------------------------------------------------------ the wide claims' duty (after ready-for-join)

/// 0xDC WideSettleTicket(0) of `rec` (no displacement): `[payer s,w] [season r] [citizen w] [record w] [holding w]
/// [wide province w] [joinshard w] [seedcache r] [anchor r] [system]`.
pub fn wide_settle_ix(
    a: &Addresses,
    payer: Address,
    rec: &WideTicket,
    faction: u8,
    shard: u8,
    region: u8,
) -> Instruction {
    let c = ctx(a);
    let m = vec![
        AccountMeta::new(payer, true),
        AccountMeta::new_readonly(a.season, false),
        AccountMeta::new(addr(rec.citizen), false),
        AccountMeta::new(addr(wt::ticket_address(&c, &rec.citizen)), false),
        AccountMeta::new(addr(wh::holding_address(&c, rec.coord, rec.site)), false),
        AccountMeta::new(addr(wl::province_address(&c, rec.coord)), false),
        AccountMeta::new(a.join_shard(faction, shard), false),
        AccountMeta::new_readonly(a.seed_cache(rec.bell, region, 0), false),
        AccountMeta::new_readonly(a.anchor(rec.bell, region), false),
        AccountMeta::new_readonly(fclient::addr::system_program(), false),
    ];
    Instruction {
        program_id: a.program,
        accounts: m,
        data: wix::SettleTicket { k: 0 }.to_bytes().to_vec(),
    }
}

/// 0xDF WideFinalize: `[anyone s] [season r] [holding w] [wide province r]`.
pub fn wide_finalize_ix(a: &Addresses, payer: Address, coord: WideCoord, site: u8) -> Instruction {
    let c = ctx(a);
    Instruction {
        program_id: a.program,
        accounts: vec![
            AccountMeta::new(payer, true),
            AccountMeta::new_readonly(a.season, false),
            AccountMeta::new(addr(wh::holding_address(&c, coord, site)), false),
            AccountMeta::new_readonly(addr(wl::province_address(&c, coord)), false),
        ],
        data: wix::Finalize {}.to_bytes().to_vec(),
    }
}

/// An open LEGACY ticket of a Citizen (FileTicket — a first home, e.g. on the rim — or FileOutpost): its wallet, nation,
/// bell, sites and the next site to settle.
#[derive(Clone, Debug)]
pub struct LegacyTicket {
    pub wallet: Address,
    pub faction: u8,
    pub bell: u32,
    pub sites: Vec<ix::Site>,
    pub next: u8,
}

/// The open wide tickets, the provisional wide holdings and the open legacy tickets on the chain.
fn scan(state: &Shared, a: &Addresses) -> (Vec<WideTicket>, Vec<WideHolding>, Vec<LegacyTicket>) {
    use frontier_abi::layout::player::holding as H;
    let accounts = lock(state).program_accounts(&a.program);
    let citizen_magic = frontier_abi::v2::layout::AccountKind::Citizen.magic();
    let mut tickets = vec![];
    let mut holdings = vec![];
    let mut legacy = vec![];
    for (_, acc) in accounts {
        let d = &acc.data;
        if d.get(..8) == Some(citizen_magic.as_slice()) {
            if let Ok(c) = fclient::decode::Citizen::decode(d) {
                if c.ticket_bell != frontier_abi::layout::player::citizen::NO_TICKET
                    && c.wallet != Address::default()
                {
                    let sites: Vec<ix::Site> = c
                        .ticket_sites
                        .iter()
                        .take_while(|s| (s.p, s.q, s.site) != (0, 0, 0))
                        .map(|s| ix::Site {
                            p: s.p,
                            q: s.q,
                            site: s.site,
                        })
                        .collect();
                    if (c.ticket_next as usize) < sites.len() {
                        legacy.push(LegacyTicket {
                            wallet: c.wallet,
                            faction: c.faction,
                            bell: c.ticket_bell,
                            sites,
                            next: c.ticket_next,
                        });
                    }
                }
            }
        } else if d.get(..8) == Some(wt::wide_ticket::MAGIC.as_slice()) {
            if let Ok(t) = WideTicket::read(d) {
                if t.status == TicketStatus::Open && t.next == 0 {
                    tickets.push(t);
                }
            }
        } else if let Ok(h) = WideHolding::read(d) {
            if d.get(H::STATE) == Some(&H::STATE_PROVISIONAL) {
                holdings.push(h);
            }
        }
    }
    (tickets, holdings, legacy)
}

/// The wide claims' duty (module doc), until `stop`: every couple of seconds, one step per open ticket and one
/// finalize attempt per due holding per bell. Prints one JSON line per landed or failed send.
pub async fn run_claims(
    state: Shared,
    a: Addresses,
    mut stop: tokio::sync::watch::Receiver<bool>,
    out: impl Fn(Value),
) -> Result<(), String> {
    let payer = crate::keeper_loop::fund_fresh(&state, &mut stop).await?;
    let mut tried_final: BTreeMap<(i64, i64, u8), u32> = BTreeMap::new();
    let mut failed: BTreeMap<String, u32> = BTreeMap::new();
    out(
        json!({"schema": WIDE_PLAY_SCHEMA, "wide_play_step": "claims_duty", "test_only": true, "payer": payer.pubkey().to_string()}),
    );
    loop {
        if *stop.borrow() {
            return Ok(());
        }
        let (clock, now) = {
            let c = lock(&state);
            (lk::season_clock(&c, &a)?, c.unix_timestamp())
        };
        let bell_now = clock.bell_at(now).unwrap_or(0);
        let (tickets, holdings, legacy) = scan(&state, &a);
        // (legacy tickets: a first home filed on the rim by a page or an AI resident — PlaceHome cannot reach past the
        //  Season's base r_max, FileTicket can — and any FileOutpost: SettleTicket(k) on the bell's beacon evidence)
        for t in legacy {
            if t.bell >= bell_now {
                continue;
            }
            let s0 = t.sites[t.next as usize];
            let region = ix::region_of(s0.p as i32, s0.q as i32);
            let mut sends = vec![];
            let expired = bell_now
                >= t.bell
                    .saturating_add(frontier_abi::layout::province::province::COHORT_BELLS);
            let ready = expired
                || matches!(
                    seed_step(&state, &a, &payer, t.bell, region, |i, what| {
                        sends.push((i, what));
                        Ok(())
                    })
                    .await,
                    Ok(Seed::Ready)
                );
            if ready {
                sends.push((
                    ix::settle_ticket(
                        &a,
                        payer.pubkey(),
                        &t.wallet,
                        t.faction,
                        t.next,
                        s0,
                        t.bell,
                        &t.sites,
                        ix::SeedSource::Cache { nonce: 0 },
                        None,
                    ),
                    format!(
                        "SettleTicket({}, {} site {}, k {})",
                        s0.p, s0.q, s0.site, t.next
                    ),
                ));
            }
            for (i, what) in sends {
                if failed.get(&what).is_some_and(|b| *b == bell_now) {
                    continue;
                }
                match crate::keeper_loop::submit_and_wait(
                    &state,
                    &payer,
                    i,
                    &what,
                    Duration::from_secs(20),
                    &mut stop,
                )
                .await
                {
                    crate::keeper_loop::Sent::Landed(sig) => out(
                        json!({"schema": WIDE_PLAY_SCHEMA, "wide_play_step": "sent", "test_only": true, "what": what, "signature": sig, "bell": bell_now}),
                    ),
                    other => {
                        failed.insert(what.clone(), bell_now);
                        out(
                            json!({"schema": WIDE_PLAY_SCHEMA, "wide_play_step": "failed", "test_only": true, "what": what, "why": format!("{other:?}"), "bell": bell_now}),
                        )
                    }
                }
            }
        }
        for t in tickets {
            if t.bell >= bell_now {
                continue; // (the cohort's bell has not ended)
            }
            let c = ctx(&a);
            let Some(pd) = read(&state, &addr(wl::province_address(&c, t.coord))) else {
                continue;
            };
            let Ok(prov) = WideProvince::read(&pd) else {
                continue;
            };
            let region = prov.region;
            let Some(cd) = read(&state, &addr(t.citizen)) else {
                continue;
            };
            let Ok(cz) = fclient::decode::Citizen::decode(&cd) else {
                continue;
            };
            let mut sends = vec![];
            let expired = bell_now
                >= t.bell
                    .saturating_add(frontier_abi::layout::province::province::COHORT_BELLS);
            let ready = expired
                || matches!(
                    seed_step(&state, &a, &payer, t.bell, region, |i, what| {
                        sends.push((i, what));
                        Ok(())
                    })
                    .await,
                    Ok(Seed::Ready)
                );
            if ready {
                sends.push((
                    wide_settle_ix(&a, payer.pubkey(), &t, cz.faction, cz.join_shard, region),
                    format!(
                        "WideSettleTicket({}, {} site {})",
                        t.coord.p(),
                        t.coord.q(),
                        t.site
                    ),
                ));
            }
            for (i, what) in sends {
                if failed.get(&what).is_some_and(|b| *b == bell_now) {
                    continue; // (one retry per bell)
                }
                match crate::keeper_loop::submit_and_wait(
                    &state,
                    &payer,
                    i,
                    &what,
                    Duration::from_secs(20),
                    &mut stop,
                )
                .await
                {
                    crate::keeper_loop::Sent::Landed(sig) => out(
                        json!({"schema": WIDE_PLAY_SCHEMA, "wide_play_step": "sent", "test_only": true, "what": what, "signature": sig, "bell": bell_now}),
                    ),
                    other => {
                        failed.insert(what.clone(), bell_now);
                        out(
                            json!({"schema": WIDE_PLAY_SCHEMA, "wide_play_step": "failed", "test_only": true, "what": what, "why": format!("{other:?}"), "bell": bell_now}),
                        )
                    }
                }
            }
        }
        for h in holdings {
            let key = (h.coord.p(), h.coord.q(), h.site);
            if tried_final.get(&key).is_some_and(|b| *b == bell_now) {
                continue;
            }
            tried_final.insert(key, bell_now);
            let what = format!(
                "WideFinalize({}, {} site {})",
                h.coord.p(),
                h.coord.q(),
                h.site
            );
            let i = wide_finalize_ix(&a, payer.pubkey(), h.coord, h.site);
            // (simulated first: TooEarly is the common answer and is not worth a landed failure)
            let fits = {
                let c = lock(&state);
                lk::simulate_ix(&c, &payer, &i).is_ok_and(|r| r.err.is_none())
            };
            if fits {
                if let crate::keeper_loop::Sent::Landed(sig) = crate::keeper_loop::submit_and_wait(
                    &state,
                    &payer,
                    i,
                    &what,
                    Duration::from_secs(20),
                    &mut stop,
                )
                .await
                {
                    out(
                        json!({"schema": WIDE_PLAY_SCHEMA, "wide_play_step": "sent", "test_only": true, "what": what, "signature": sig, "bell": bell_now}),
                    );
                }
            }
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(2)) => {}
            _ = stop.changed() => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use frontier_abi::v2::presets::{
        CENTRE_CONCORD, CENTRE_PLAYABLE, S1_DEVNET_WIDE_7D, S1_LOCAL_7D,
    };

    #[test]
    fn the_knobs_change_only_their_bytes_and_validate() {
        for base in [S1_LOCAL_7D, S1_DEVNET_WIDE_7D] {
            let f = local_free(base);
            assert_eq!(f.cq.centre, CENTRE_FREE);
            let mut back = f;
            back.cq.centre = base.cq.centre;
            assert_eq!(back.to_bytes(), base.to_bytes());
            assert_eq!(f.validate(), Ok(()));
            let w = local_wide(base);
            assert_eq!(w.cq.outpost_tier_min, 0);
            let mut back = w;
            back.cq.centre = base.cq.centre;
            back.cq.outpost_tier_min = base.cq.outpost_tier_min;
            assert_eq!(back.to_bytes(), base.to_bytes());
            assert_eq!(w.validate(), Ok(()));
        }
        // (the presets keep the Concord; since Q-W1 (owner 2026-11-20) the devnet wide preset has the local wide
        //  world's Hamlet anchor itself, so `local_wide` changes only the centre there; S1_LOCAL_7D keeps a Town)
        assert_eq!(CENTRE_PLAYABLE, CENTRE_CONCORD);
        assert_eq!(S1_LOCAL_7D.cq.centre, CENTRE_CONCORD);
        assert_eq!(S1_DEVNET_WIDE_7D.cq.centre, CENTRE_CONCORD);
        assert_eq!(S1_DEVNET_WIDE_7D.cq.outpost_tier_min, WIDE_OUTPOST_TIER_MIN);
        assert_eq!(S1_LOCAL_7D.cq.outpost_tier_min, 1);
        // (verify-pr104: the runner's statement names only bytes that differ from the wide world's preset)
        let wide = rules_metadata("S1_DEVNET_WIDE_7D", true);
        let bytes: Vec<&str> = wide["changed"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["byte"].as_str().unwrap())
            .collect();
        assert_eq!(bytes, ["conquest.centre (81)"]);
        assert_eq!(
            local_wide(S1_DEVNET_WIDE_7D).to_bytes(),
            local_free(S1_DEVNET_WIDE_7D).to_bytes()
        );
    }

    #[test]
    fn the_centre_provinces_are_ring_one_with_every_nation_once() {
        let seed = [7u8; 32];
        let cq = local_free(S1_LOCAL_7D).cq;
        let v = centre_provinces(&cq, &seed);
        assert_eq!(v.len(), 6);
        let nations: BTreeSet<u8> = v.iter().map(|x| x.2).collect();
        assert_eq!(
            nations.len(),
            6,
            "ring 1: one province per nation (⑭ R2 mixed)"
        );
        assert!(v
            .iter()
            .all(|&(p, q, _)| ProvinceCoord::new(p as i32, q as i32).ring() == 1));
        assert!(centre_provinces(&S1_LOCAL_7D.cq, &seed).is_empty());
    }

    #[test]
    fn rim_homes_are_per_nation_and_on_the_rim() {
        let seed = [9u8; 32];
        let cq = local_wide(S1_DEVNET_WIDE_7D).cq;
        let plan = crate::wide_land::wide_plan(129, crate::wide_land::PER_WEDGE);
        let rim = crate::wide_land::rim_plan(&plan);
        let v = rim_homes(&rim, &cq, &seed);
        let mut per: BTreeMap<u8, usize> = BTreeMap::new();
        for &(p, q, n) in &v {
            assert_eq!(ProvinceCoord::new(p as i32, q as i32).ring(), 128);
            *per.entry(n).or_default() += 1;
        }
        assert_eq!(per.len(), 6, "every nation has a rim home");
        assert!(per.values().all(|k| *k == RIM_PER_NATION));
        // (spread: a nation's rim homes are in different wedges)
        for n in 0..6u8 {
            let w: BTreeSet<_> = v
                .iter()
                .filter(|h| h.2 == n)
                .map(|h| ProvinceCoord::new(h.0 as i32, h.1 as i32).wedge())
                .collect();
            assert_eq!(w.len(), RIM_PER_NATION, "nation {n}");
        }
    }
}
