//! **Opt-in, isolated local test fixture only** (`localnet-expedition-play
//! --wide-destination public-quicknet`): makes the wide Province (129, 0) a
//! REAL province of the runner's chain, so an expedition can be revealed
//! into it.
//!
//! What is SYNTHETIC (and reported so in the metadata, never as a normal
//! ring request or as occupancy reached):
//!
//! - the **requested** ring-129 `WideRingSeed` record, written with
//!   `Chain::set_account` from the program's own model
//!   (`world_index::land::WideRingSeed::request`: previous ring seeded, a
//!   bell since, the beacon round bound to `t_open` = the chain's time at
//!   bootstrap, never back-dated). `WideRequestRingSeed` did NOT run: its θ
//!   occupancy gate and six-wedge-fund gate were neither met nor checked;
//! - the Season's `authority`: a fresh in-memory test key (never read from
//!   anywhere, stored, persisted or printed) so the REAL `WideSetRules` can
//!   be signed by the Season's stored authority.
//!
//! What is REAL, in order, each submitted to this node and landed on its own
//! ticker (a refusal or an unknown outcome stops the task; nothing is
//! retried or taken for a success):
//!
//! 1. `WideConsumeRingSeed(129)` with the bound round's public Quicknet
//!    signature, fetched from the public drand API and verified against the
//!    pinned key (the program verifies it again and derives the seed);
//! 2. `WideSetRules` (one candidate per rule, [`RULES`]);
//! 3. `WideOpenProvince(129, 0)`: the program generates the terrain from the
//!    verified seed (no terrain is written here) and creates the province
//!    from the wedge fund.
//!
//! Only accounts read back after those instructions landed are captured
//! (address, owner, size, lamports, sha256 and a few decoded public fields).
//! Nothing is sent anywhere but this node and the public drand API.
use std::time::{Duration, Instant};

use fclient::{AccountMeta, Address, Instruction, Keypair, Signer};
use frontier_abi::addr::AddrCtx;
use frontier_abi::world_index::{
    land::{self as wl, PreviousRing, SeedStatus, WideProvince, WideRingSeed},
    rules::{self as wr, CampRule, FreeCityRule, KeepHolderRule, RegionRule},
    wide_ix as wix, WideCoord, WorldId,
};
use localnet::server::{lock, Shared};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::expedition_play::PROGRAM;
use crate::keeper_loop::{stopped, submit_and_wait, Sent, LAND_TIMEOUT};
use crate::local_keeper as lk;

pub const SCHEMA: &str = "frontier-local-play-wide-destination-v1";
/// The only mode: the public drand Quicknet API, verified.
pub const MODE: &str = "public-quicknet";
/// The province made real.
pub const DEST: (i64, i64) = (129, 0);
/// Its ring.
pub const RING: u64 = 129;
/// The fixture's rule choice, one candidate each (the program refuses
/// anything else): interleaved keeps, no genesis Free City, no initial
/// camp, the sort-key-hash region.
pub const RULES: wr::RuleBytes = wr::RuleBytes {
    keep_holder: KeepHolderRule::MixedInterleaved as u8,
    free_city: FreeCityRule::NoFreeCity as u8,
    camp: CampRule::NoCamp as u8,
    region: RegionRule::SortKeyHashV1 as u8,
};
/// How long the bound round may take to be served by the public API.
pub const ROUND_DEADLINE: Duration = Duration::from_secs(30 * 60);
const AUTHORITY_LAMPORTS: u64 = 1_000_000_000;

/// The Season's address context.
pub fn ctx(season: &Address) -> AddrCtx {
    AddrCtx { program: PROGRAM, season: season.to_bytes() }
}

/// SYNTHETIC: the requested ring-129 record from the program's own model.
/// `season` and `legacy_ring_seed` are the installed Season and ring-128
/// RingSeed bytes; `now` the chain's time. Returns the address, the bytes
/// and the bound round.
pub fn requested_ring_seed(season: &Address, season_bytes: &[u8], legacy_ring_seed: &[u8], now: i64, payer: &Address) -> Result<(Address, Vec<u8>, u64), String> {
    use frontier_abi::layout::world::ring_seed as RS;
    let s = fclient::decode::Season::decode(season_bytes).map_err(|e| format!("season: {e:?}"))?;
    let clock = fclient::clock::SeasonClock::from_season(&s);
    let c = ctx(season);
    let world = WorldId::derive_legacy_season(&c.season, &c.program).map_err(|e| format!("world: {e:?}"))?;
    let rd = |o: usize, n: usize| legacy_ring_seed.get(o..o + n).ok_or("legacy ring seed bytes");
    if u16::from_le_bytes(rd(RS::D, 2)?.try_into().unwrap()) != 128 {
        return Err("the previous ring seed is not ring 128".into());
    }
    let previous = PreviousRing {
        ring: 128,
        seeded: legacy_ring_seed.get(RS::STATUS) == Some(&RS::STATUS_SEEDED),
        opened_bell: u32::from_le_bytes(rd(RS::OPENED_BELL, 4)?.try_into().unwrap()),
    };
    let season_id = u64::from_le_bytes(season_bytes.get(8..16).ok_or("season header")?.try_into().unwrap());
    let now_bell = clock.bell_at(now).ok_or("the chain's time is before the season")?;
    let beacon = permutation_rules::frontier::beacon::BeaconClock { genesis: clock.drand.genesis, period: clock.drand.period as i64 };
    let rec = WideRingSeed::request(world, season_id, RING, previous, now_bell, now, &beacon, clock.seed_margin, payer.to_bytes())
        .map_err(|e| format!("the ring-129 request model refused: {e:?}"))?;
    let mut d = vec![0u8; wl::ring_seed::SIZE];
    rec.write(&mut d).map_err(|e| format!("ring seed bytes: {e:?}"))?;
    Ok((Address::new_from_array(wl::ring_seed_address(&c, RING)), d, rec.round))
}

fn ix(accounts: Vec<AccountMeta>, data: Vec<u8>) -> Instruction {
    Instruction { program_id: Address::new_from_array(PROGRAM), accounts, data }
}

/// 0xD7 WideConsumeRingSeed: K + `[wide_ringseed w]`.
pub fn consume_ix(season: &Address, payer: &Address, round: u64, sig48: [u8; 48]) -> Result<Instruction, String> {
    let hints: [u8; frontier_abi::ix::HINTS_LEN] = fclient::beacon::hints_bytes(round).try_into().map_err(|_| "hints length")?;
    let data = wix::ConsumeRingSeed { ring: RING, round, sig48, hints }.to_bytes().to_vec();
    let c = ctx(season);
    Ok(ix(vec![AccountMeta::new(*payer, true), AccountMeta::new_readonly(*season, false),
        AccountMeta::new(Address::new_from_array(wl::ring_seed_address(&c, RING)), false)], data))
}

/// 0xDB WideSetRules: `[authority s,w] [season r] [rules_config w] [system]`.
pub fn set_rules_ix(season: &Address, authority: &Address) -> Instruction {
    set_rules_ix_with(season, authority, &RULES)
}

/// As [`set_rules_ix`] with the given rule bytes (an explicit opt-in preset;
/// the expedition world always uses [`RULES`]).
pub fn set_rules_ix_with(season: &Address, authority: &Address, rules: &wr::RuleBytes) -> Instruction {
    let data = wix::SetRules { config_version: wr::WIDE_RULES_CONFIG_VERSION, keep_holder: rules.keep_holder, free_city: rules.free_city,
        camp: rules.camp, region: rules.region }.to_bytes().to_vec();
    let c = ctx(season);
    ix(vec![AccountMeta::new(*authority, true), AccountMeta::new_readonly(*season, false),
        AccountMeta::new(Address::new_from_array(wr::rules_config_address(&c)), false), AccountMeta::new_readonly(fclient::addr::system_program(), false)], data)
}

/// The wide Province (129, 0)'s address and its wedge fund's.
pub fn dest_accounts(season: &Address) -> Result<(Address, Address), String> {
    let c = ctx(season);
    let coord = WideCoord::checked(DEST.0, DEST.1).map_err(|e| format!("{e:?}"))?;
    let wedge = coord.wedge().ok_or("no wedge")?;
    Ok((Address::new_from_array(wl::province_address(&c, coord)), Address::new_from_array(c.province_fund(wedge))))
}

/// 0xD8 WideOpenProvince(129, 0): `[payer s,w] [season r] [wide_ringseed w]
/// [pfund w] [province w] [rules_config r] [system]`.
pub fn open_ix(season: &Address, payer: &Address) -> Result<Instruction, String> {
    let c = ctx(season);
    let (province, fund) = dest_accounts(season)?;
    let data = wix::OpenProvince { p: DEST.0, q: DEST.1 }.to_bytes().to_vec();
    Ok(ix(vec![AccountMeta::new(*payer, true), AccountMeta::new_readonly(*season, false),
        AccountMeta::new(Address::new_from_array(wl::ring_seed_address(&c, RING)), false), AccountMeta::new(fund, false), AccountMeta::new(province, false),
        AccountMeta::new_readonly(Address::new_from_array(wr::rules_config_address(&c)), false), AccountMeta::new_readonly(fclient::addr::system_program(), false)], data))
}

/// What every captured record must say (from the Season and the plan).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Expect {
    pub season_id: u64,
    pub world: WorldId,
    pub round: u64,
    pub t_open: i64,
    pub authority: [u8; 32],
}

fn want(ok: bool, what: &str) -> Result<(), String> {
    if ok { Ok(()) } else { Err(format!("captured record mismatch: {what}")) }
}

/// The ring-129 seed after Consume (`provinces` = 0) or after the opening
/// (`provinces` = 1): this Season and world, ring 129, Seeded with the
/// bound round and a nonzero seed, the bootstrap's t_open.
pub fn check_seed(rec: &WideRingSeed, e: &Expect, provinces: u64) -> Result<(), String> {
    want(rec.season_id == e.season_id, "ring seed season")?;
    want(rec.world == e.world, "ring seed world")?;
    want(rec.ring == RING, "ring seed ring")?;
    want(rec.status == SeedStatus::Seeded, "ring seed status")?;
    want(rec.round == e.round, "ring seed round")?;
    want(rec.seed != [0; 32], "ring seed is zero")?;
    want(rec.t_open == e.t_open, "ring seed t_open")?;
    want(rec.provinces_created == provinces, "ring seed provinces_created")
}

/// The rules configuration: this Season and world, the current table, the
/// fixture's four candidates, written by the Season's authority.
pub fn check_rules(cfg: &wr::WideRulesConfig, e: &Expect) -> Result<(), String> {
    check_rules_with(cfg, e, &RULES)
}

/// As [`check_rules`] against the given rule bytes.
pub fn check_rules_with(cfg: &wr::WideRulesConfig, e: &Expect, rules: &wr::RuleBytes) -> Result<(), String> {
    want(cfg.season_id == e.season_id, "rules season")?;
    want(cfg.world == e.world, "rules world")?;
    want(cfg.config_version == wr::WIDE_RULES_CONFIG_VERSION, "rules version")?;
    want((cfg.keep_holder as u8, cfg.free_city as u8, cfg.camp as u8, cfg.region as u8) == (rules.keep_holder, rules.free_city, rules.camp, rules.region), "rule candidates")?;
    want(cfg.authority == e.authority, "rules authority")
}

/// The opened province: this Season and world, (129, 0), its geometric
/// wedge, the region the configured rule gives, made from `seed` of the
/// bound round.
pub fn check_province(prov: &WideProvince, e: &Expect, seed: &[u8; 32]) -> Result<(), String> {
    let coord = WideCoord::checked(DEST.0, DEST.1).map_err(|e| format!("{e:?}"))?;
    want(prov.season_id == e.season_id, "province season")?;
    want(prov.world == e.world, "province world")?;
    want(prov.coord == coord, "province coordinate")?;
    want(Some(prov.wedge) == coord.wedge(), "province wedge")?;
    want(prov.region == wr::wide_region(coord), "province region (SortKeyHashV1)")?;
    want(prov.seed_round == e.round, "province seed round")?;
    want(&prov.ring_seed == seed, "province ring seed")
}

/// What the bootstrap prepared: the in-memory authority (never printed:
/// no Debug), the season and the bound round.
pub struct Plan {
    authority: Keypair,
    pub season: Address,
    pub round: u64,
    pub t_open: i64,
}
impl Plan {
    pub fn new(authority: Keypair, season: Address, round: u64, t_open: i64) -> Plan {
        Plan { authority, season, round, t_open }
    }
    /// The public key the synthetic Season stores as its authority.
    pub fn authority(&self) -> Address {
        self.authority.pubkey()
    }
}

/// The public facts of a captured program-owned account (only read back
/// after the instruction that made it landed).
fn capture(state: &Shared, key: &Address) -> Result<(Value, Vec<u8>), String> {
    let acc = lock(state).account(key).ok_or(format!("{key} is absent after its instruction landed"))?;
    if acc.owner != Address::new_from_array(PROGRAM) || acc.executable {
        return Err(format!("{key} is not a program-owned data account"));
    }
    let v = json!({"address": key.to_string(), "owner": acc.owner.to_string(), "bytes": acc.data.len(), "lamports": acc.lamports,
        "sha256": hex::encode(Sha256::digest(&acc.data))});
    Ok((v, acc.data))
}

fn landed(sent: Sent, what: &str) -> Result<String, String> {
    match sent {
        Sent::Landed(sig) => Ok(sig),
        Sent::Failed(e) => Err(e),
        Sent::Unknown { signature, why } => Err(format!("{what}: outcome unknown (signature {signature}, never resent): {why}")),
    }
}

/// Funds `key` from the node's disposable faucet and waits for it. The stop
/// flag is checked under the same chain lock as the airdrop: once stopped,
/// nothing on the chain is changed.
async fn fund(state: &Shared, key: &Address, lamports: u64, stop: &mut tokio::sync::watch::Receiver<bool>) -> Result<(), String> {
    {
        let mut c = lock(state);
        if *stop.borrow() {
            return Err("stopped before funding".into());
        }
        c.airdrop(key, lamports)?;
    }
    let deadline = Instant::now() + LAND_TIMEOUT;
    while lock(state).balance(key) == 0 {
        if *stop.borrow() {
            return Err("stopped while funding".into());
        }
        if Instant::now() >= deadline {
            return Err("not funded".into());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    Ok(())
}

/// Runs the three real instructions in order (module doc); `report` gets a
/// public status line after each step. Returns the capture, or why it
/// stopped (a refusal, an unknown outcome, a stop, an unserved round).
pub async fn run(state: Shared, plan: Plan, stop: tokio::sync::watch::Receiver<bool>, report: impl Fn(&Value)) -> Result<Value, String> {
    run_with_rules(state, plan, RULES, stop, report).await
}

/// As [`run`] with the given rule bytes: the same three real instructions,
/// only SetRules carries `rules` (an explicit opt-in preset, e.g.
/// `conquest_world::RULES`; the expedition world always runs [`run`]).
pub async fn run_with_rules(state: Shared, plan: Plan, rules: wr::RuleBytes, mut stop: tokio::sync::watch::Receiver<bool>, report: impl Fn(&Value))
    -> Result<Value, String> {
    let season = plan.season;
    let step = |name: &str, extra: Value| report(&json!({"schema": SCHEMA, "step": name, "detail": extra}));
    let payer = Keypair::new();
    fund(&state, &payer.pubkey(), 10_000_000_000, &mut stop).await?;
    fund(&state, &plan.authority(), AUTHORITY_LAMPORTS, &mut stop).await?;
    // 1. the bound round from the public API, verified against the pinned key
    let deadline = Instant::now() + ROUND_DEADLINE;
    let sig48 = loop {
        match tokio::select! { r = lk::fetch_round_at(plan.round) => r, _ = stopped(&mut stop) => return Err("stopped".into()) } {
            Ok(s) => break s,
            Err(e) if Instant::now() < deadline => {
                step("waiting-for-round", json!({"round": plan.round, "why": e}));
                tokio::select! { _ = tokio::time::sleep(Duration::from_secs(20)) => {}, _ = stopped(&mut stop) => return Err("stopped".into()) }
            }
            Err(e) => return Err(format!("round {} was not served in time: {e}", plan.round)),
        }
    };
    // the chain's own clock must have reached the round (natural 1x; never moved here)
    let round_time = {
        let c = lock(&state);
        let s = fclient::decode::Season::decode(&c.account(&season).ok_or("no Season")?.data).map_err(|e| format!("{e:?}"))?;
        fclient::clock::SeasonClock::from_season(&s).drand.round_time(plan.round)
    };
    while lock(&state).unix_timestamp() < round_time {
        tokio::select! { _ = tokio::time::sleep(Duration::from_secs(2)) => {}, _ = stopped(&mut stop) => return Err("stopped".into()) }
    }
    let c = ctx(&season);
    let season_id = {
        let d = lock(&state).account(&season).ok_or("no Season")?.data;
        u64::from_le_bytes(d.get(8..16).ok_or("season header")?.try_into().unwrap())
    };
    let e = Expect { season_id, world: WorldId::derive_legacy_season(&c.season, &c.program).map_err(|x| format!("{x:?}"))?, round: plan.round,
        t_open: plan.t_open, authority: plan.authority().to_bytes() };
    let ring_key = Address::new_from_array(wl::ring_seed_address(&c, RING));
    let consume = landed(submit_and_wait(&state, &payer, consume_ix(&season, &payer.pubkey(), plan.round, sig48)?, "WideConsumeRingSeed(129)", LAND_TIMEOUT, &mut stop).await, "WideConsumeRingSeed")?;
    let (ring_cap, rd) = capture(&state, &ring_key)?;
    let rec = WideRingSeed::read(&rd).map_err(|e| format!("ring seed after Consume: {e:?}"))?;
    check_seed(&rec, &e, 0)?;
    step("consumed", json!({"signature": consume, "round": plan.round}));
    // 2. the rules, signed by the Season's (in-memory test) authority
    let set_rules = landed(submit_and_wait(&state, &plan.authority, set_rules_ix_with(&season, &plan.authority(), &rules), "WideSetRules", LAND_TIMEOUT, &mut stop).await, "WideSetRules")?;
    let (rules_cap, cd) = capture(&state, &Address::new_from_array(wr::rules_config_address(&c)))?;
    check_rules_with(&wr::WideRulesConfig::read(&cd).map_err(|x| format!("rules config: {x:?}"))?, &e, &rules)?;
    step("rules-set", json!({"signature": set_rules}));
    // 3. the province, generated by the program from the verified seed
    let (province_key, _) = dest_accounts(&season)?;
    let open = landed(submit_and_wait(&state, &payer, open_ix(&season, &payer.pubkey())?, "WideOpenProvince(129, 0)", LAND_TIMEOUT, &mut stop).await, "WideOpenProvince")?;
    let (prov_cap, pd) = capture(&state, &province_key)?;
    let prov = WideProvince::read(&pd).map_err(|e| format!("province after WideOpenProvince: {e:?}"))?;
    // (129, 0), made from THE verified seed of the bound round
    check_province(&prov, &e, &rec.seed)?;
    let (ring_after, rd2) = capture(&state, &ring_key)?;
    let after = WideRingSeed::read(&rd2).map_err(|x| format!("ring seed after the opening: {x:?}"))?;
    check_seed(&after, &e, 1)?;
    want(after.seed == rec.seed, "the ring seed changed after the opening")?;
    let out = json!({"schema": SCHEMA, "dest": [DEST.0, DEST.1], "ring": RING,
        "signatures": {"consume_ring_seed": consume, "set_rules": set_rules, "open_province": open},
        "accounts": {"ring_seed_after_consume": ring_cap, "ring_seed_after_open": ring_after, "rules_config": rules_cap, "province": prov_cap},
        "province": {"region": prov.region, "wedge": prov.wedge, "opened_bell": prov.opened_bell, "seed_round": prov.seed_round},
        "rules": {"keep_holder": rules.keep_holder, "free_city": rules.free_city, "camp": rules.camp, "region": rules.region},
        "synthetic": synthetic_note(plan.t_open, plan.round)});
    step("opened", out.clone());
    Ok(out)
}

/// The explicit statement of what was synthetic (metadata and report).
pub fn synthetic_note(t_open: i64, round: u64) -> Value {
    json!({
        "requested_ring_seed": format!("SYNTHETIC: the requested ring-129 WideRingSeed record was written with Chain::set_account from WideRingSeed::request (the program's model; t_open = {t_open}, the chain's time at bootstrap, bound round {round}); WideRequestRingSeed did NOT run, and its θ occupancy and six-wedge-fund gates were neither met nor checked"),
        "season_authority": "SYNTHETIC: the Season's authority is a fresh in-memory test key (never read, stored, persisted or printed), so the REAL WideSetRules can be signed",
        "not_claimed": "not a normal ring request, not ring occupancy reached; an isolated local test fixture only",
        "real": "WideConsumeRingSeed (public Quicknet round verified against the pinned key, verified again by the program), WideSetRules, WideOpenProvince (terrain generated by the program from the verified seed)",
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::expedition_play::{Base, SEASON_ID};
    use frontier_abi::layout::world::ring_seed as RS;
    use frontier_abi::v2::layout::world::season as S;

    fn chain_with_base(authority: Option<&Address>) -> (localnet::Chain, Base) {
        let mut c = localnet::Chain::new(localnet::Config::default());
        c.produce_block();
        let mut base = Base::new(c.unix_timestamp()).unwrap();
        if let Some(a) = authority {
            base.set_authority(a);
        }
        base.install(&mut c).unwrap();
        c.produce_block();
        (c, base)
    }

    #[test]
    fn the_synthetic_season_authority_changes_only_the_authority() {
        let key = Address::new_from_array([3; 32]);
        let (c0, b0) = chain_with_base(None);
        let (c1, b1) = chain_with_base(Some(&key));
        let s0 = c0.account(&b0.season).unwrap().data;
        let s1 = c1.account(&b1.season).unwrap().data;
        assert_eq!(&s0[S::AUTHORITY..S::AUTHORITY + 32], &[0u8; 32], "no authority without the fixture");
        assert_eq!(&s1[S::AUTHORITY..S::AUTHORITY + 32], key.as_ref());
        // every other byte equal except the clock-derived genesis fields of two separate chains
        let differs: Vec<usize> = (0..s0.len()).filter(|&i| s0[i] != s1[i] && !(S::AUTHORITY..S::AUTHORITY + 32).contains(&i)).collect();
        let clock_fields = [S::GENESIS_TS, S::CREATED_TS, S::GENESIS_ROUND];
        assert!(differs.iter().all(|i| clock_fields.iter().any(|f| (*f..*f + 8).contains(i))), "{differs:?}");
    }

    #[test]
    fn the_requested_ring_seed_is_the_programs_model_bound_to_the_bootstrap_time() {
        let (c, base) = chain_with_base(Some(&Address::new_from_array([3; 32])));
        let now = c.unix_timestamp();
        let season = c.account(&base.season).unwrap().data;
        let legacy = c.account(&base.ring_seed).unwrap().data;
        let payer = Address::new_from_array([4; 32]);
        let (key, d, round) = requested_ring_seed(&base.season, &season, &legacy, now, &payer).unwrap();
        assert_eq!(key, Address::new_from_array(wl::ring_seed_address(&ctx(&base.season), RING)));
        let rec = WideRingSeed::read(&d).unwrap();
        assert_eq!((rec.ring, rec.status, rec.t_open, rec.round, rec.seed, rec.provinces_created, rec.season_id), (RING, SeedStatus::Requested, now, round, [0; 32], 0, SEASON_ID));
        assert_eq!(rec.payer, payer.to_bytes());
        // the bound round is the deployed rule's: first round at or after t_open + lead + margin (never back-dated)
        let s = fclient::decode::Season::decode(&season).unwrap();
        let clock = fclient::clock::SeasonClock::from_season(&s);
        assert_eq!(round, clock.drand.ring_seed_round(now, clock.seed_margin));
        assert!(clock.drand.round_time(round) >= now + permutation_rules::frontier::beacon::SEED_LEAD_SECS);
        // the previous ring must be ring 128 and seeded (the model's gate is kept)
        let mut unseeded = legacy.clone();
        unseeded[RS::STATUS] = 0;
        assert!(requested_ring_seed(&base.season, &season, &unseeded, now, &payer).is_err());
        let mut other = legacy.clone();
        other[RS::D..RS::D + 2].copy_from_slice(&127u16.to_le_bytes());
        assert!(requested_ring_seed(&base.season, &season, &other, now, &payer).is_err());
    }

    #[test]
    fn the_real_instructions_have_the_programs_wire_and_account_shape() {
        let season = Address::new_from_array([5; 32]);
        let (payer, auth) = (Address::new_from_array([6; 32]), Address::new_from_array([8; 32]));
        let shape = |ix: &Instruction| ix.accounts.iter().map(|m| (m.is_signer, m.is_writable)).collect::<Vec<_>>();
        let consume = consume_ix(&season, &payer, 77, [1; 48]).unwrap();
        assert!(matches!(wix::WideCommand::decode(&consume.data), Ok(wix::WideCommand::ConsumeRingSeed(x)) if x.ring == RING && x.round == 77));
        assert_eq!(shape(&consume), vec![(true, true), (false, false), (false, true)]);
        let rules = set_rules_ix(&season, &auth);
        assert!(matches!(wix::WideCommand::decode(&rules.data), Ok(wix::WideCommand::SetRules(x)) if x.config_version == wr::WIDE_RULES_CONFIG_VERSION
            && (x.keep_holder, x.free_city, x.camp, x.region) == (RULES.keep_holder, RULES.free_city, RULES.camp, RULES.region)));
        assert_eq!(shape(&rules), vec![(true, true), (false, false), (false, true), (false, false)]);
        assert_eq!(rules.accounts[0].pubkey, auth, "the Season's authority signs");
        let open = open_ix(&season, &payer).unwrap();
        assert!(matches!(wix::WideCommand::decode(&open.data), Ok(wix::WideCommand::OpenProvince(x)) if (x.p, x.q) == DEST));
        assert_eq!(shape(&open), vec![(true, true), (false, false), (false, true), (false, true), (false, true), (false, false), (false, false)]);
        let (province, fund) = dest_accounts(&season).unwrap();
        assert_eq!((open.accounts[3].pubkey, open.accounts[4].pubkey), (fund, province));
        // every rule byte is a known candidate
        assert!(KeepHolderRule::from_byte(RULES.keep_holder).is_ok() && FreeCityRule::from_byte(RULES.free_city).is_ok()
            && CampRule::from_byte(RULES.camp).is_ok() && RegionRule::from_byte(RULES.region).is_ok());
    }

    fn expect() -> Expect {
        let season = Address::new_from_array([5; 32]);
        let c = ctx(&season);
        Expect { season_id: SEASON_ID, world: WorldId::derive_legacy_season(&c.season, &c.program).unwrap(), round: 1234, t_open: 99, authority: [8; 32] }
    }

    #[test]
    fn captured_records_are_held_to_every_expected_value() {
        let e = expect();
        let prev = PreviousRing { ring: 128, seeded: true, opened_bell: 0 };
        let beacon = permutation_rules::frontier::beacon::BeaconClock { genesis: 1_692_803_367, period: 3 };
        let req = WideRingSeed::request(e.world, e.season_id, RING, prev, 5, e.t_open, &beacon, 0, [4; 32]).unwrap();
        let e = Expect { round: req.round, ..e };
        let seeded = req.seed_with(req.round, [7; 32]).unwrap();
        assert_eq!(check_seed(&seeded, &e, 0), Ok(()));
        assert!(check_seed(&seeded, &e, 1).is_err(), "provinces_created");
        assert!(check_seed(&req, &e, 0).is_err(), "still requested");
        for bad in [
            WideRingSeed { season_id: 9, ..seeded },
            WideRingSeed { world: WorldId::new([1; 32]).unwrap(), ..seeded },
            WideRingSeed { ring: 130, ..seeded },
            WideRingSeed { round: seeded.round + 1, ..seeded },
            WideRingSeed { t_open: 100, ..seeded },
            WideRingSeed { seed: [0; 32], ..seeded },
        ] {
            assert!(check_seed(&bad, &e, 0).is_err(), "{bad:?}");
        }
        let cfg = wr::WideRulesConfig::new(e.season_id, e.world, e.authority, RULES).unwrap();
        assert_eq!(check_rules(&cfg, &e), Ok(()));
        for bad in [
            wr::WideRulesConfig { authority: [9; 32], ..cfg },
            wr::WideRulesConfig { season_id: 9, ..cfg },
            wr::WideRulesConfig { world: WorldId::new([1; 32]).unwrap(), ..cfg },
            wr::WideRulesConfig { camp: CampRule::SortKeyDrawV1, ..cfg },
            wr::WideRulesConfig { free_city: FreeCityRule::CanonicalHashV1, ..cfg },
            wr::WideRulesConfig { keep_holder: KeepHolderRule::OrbitBalanced, ..cfg },
        ] {
            assert!(check_rules(&bad, &e).is_err(), "{bad:?}");
        }
        let coord = WideCoord::checked(DEST.0, DEST.1).unwrap();
        let prov = WideProvince { season_id: e.season_id, world: e.world, coord, wedge: coord.wedge().unwrap(), region: wr::wide_region(coord),
            opened_bell: 5, readiness: 0, seed_round: e.round, ring_seed: [7; 32], funded_lamports: 1 };
        assert_eq!(check_province(&prov, &e, &[7; 32]), Ok(()));
        assert!(check_province(&prov, &e, &[6; 32]).is_err(), "another seed");
        for bad in [
            WideProvince { coord: WideCoord::checked(130, 0).unwrap(), ..prov },
            WideProvince { region: (prov.region + 1) % 16, ..prov },
            WideProvince { wedge: (prov.wedge + 1) % 6, ..prov },
            WideProvince { seed_round: e.round + 1, ..prov },
            WideProvince { season_id: 9, ..prov },
            WideProvince { world: WorldId::new([1; 32]).unwrap(), ..prov },
        ] {
            assert!(check_province(&bad, &e, &[7; 32]).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_stop_before_funding_changes_nothing() {
        let (c, _) = chain_with_base(None);
        let state: Shared = std::sync::Arc::new(std::sync::Mutex::new(c));
        let key = Address::new_from_array([12; 32]);
        let (tx, mut rx) = tokio::sync::watch::channel(true);
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        assert!(rt.block_on(fund(&state, &key, 1_000, &mut rx)).is_err());
        assert_eq!(lock(&state).balance(&key), 0, "no airdrop after the stop");
        drop(tx);
    }

    #[test]
    fn the_report_states_what_was_synthetic() {
        let n = synthetic_note(100, 200).to_string();
        for s in ["SYNTHETIC: the requested ring-129", "WideRequestRingSeed did NOT run", "neither met nor checked", "in-memory test key", "not a normal ring request"] {
            assert!(n.contains(s), "{s}");
        }
    }

    /// Real artifact + public drand: the opt-in fixture's three REAL
    /// instructions land in order on the node's ticker and (129, 0) is a
    /// program-made province from the verified seed. Waits for the bound
    /// round in REAL time (about 11 minutes). Ignored without the artifact and
    /// `WYLLS_PUBLIC_DRAND=1`.
    #[test]
    #[ignore]
    fn the_wide_destination_is_opened_by_the_real_instructions() {
        let need = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("{k} is not set"));
        assert_eq!(need("WYLLS_PUBLIC_DRAND"), "1");
        let path = std::path::PathBuf::from(need("WYLLS_EXPEDITION_SBF"));
        let art = crate::expedition_play::inspect(path.clone(), std::fs::read(&path).unwrap(), &need("WYLLS_EXPEDITION_SBF_SHA256")).unwrap();
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let p = (41_930..41_937u16).find(|p| *p != crate::expedition_play::REFUSED_PORT && localnet::server::check_port(*p).is_ok()).unwrap();
            let q = (p + 1..41_938u16).find(|x| localnet::server::check_port(*x).is_ok()).unwrap();
            let mut play = crate::expedition_play::launch_full(&art, Keypair::new().pubkey(), p, q, false, true).await.unwrap();
            assert!(play.metadata["wide_destination"]["synthetic"]["requested_ring_seed"].as_str().unwrap().contains("did NOT run"));
            let plan = play.wide.take().expect("the plan");
            let state = play.running.state.clone();
            let (tx, rx) = tokio::sync::watch::channel(false);
            let out = run(state.clone(), plan, rx, |v| eprintln!("{v}")).await.unwrap();
            drop(tx);
            let (province, _) = dest_accounts(&play.fixture.season).unwrap();
            assert_eq!(out["accounts"]["province"]["address"], province.to_string());
            let pd = lock(&state).account(&province).unwrap().data;
            let prov = WideProvince::read(&pd).unwrap();
            assert_eq!((prov.coord.p(), prov.coord.q()), DEST);
            assert_eq!(out["province"]["seed_round"], prov.seed_round);
            play.running.stop();
        });
    }
}
