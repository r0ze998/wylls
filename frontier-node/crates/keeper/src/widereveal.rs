//! **Read-only, opt-in** (feature `wide-world-experimental`): planning of
//! an **unsigned** WideReveal (0xEE) candidate from a
//! [`crate::wideproof::DepartProof`], a caller-supplied seal **opening**,
//! a **public drand round signature** and current account reads, with the
//! dispatcher's account table and refusals replayed over the decoded
//! state. Nothing here signs, simulates, sends or queues; the engine never
//! sees the instruction; the production debit gate stays closed; the
//! legacy PSW1 feed guard is untouched.
//!
//! **Source of truth.** `permutation-frontier/src/proc/wide.rs::reveal`:
//! `[fee_payer s,w] [season r] [holding r] [transit r] [anchor r] [archive
//! r] [beaconlog r] [inputs r] [dest_province r] [arrivalday r|w] [slot × 4
//! (exactly `target_i` writable)] [ix_sysvar r] [system]` then 0–3
//! `[path_province r]` in first-entered order (`wide_ix::REVEAL`). The
//! planner replays the handler's refusals — holding and in-transit record,
//! the Ended clause, `seal::unpack`/`validate`, the commitment, the
//! destination and its region, THE anchor's window and the beacon log, the
//! latch, the committed path over the province masks and the doctrine's
//! travel time, the site shield, the four-slot quota, the ArrivalDay. **Its
//! order is not the handler's everywhere**: the path's provinces are
//! derived from the plaintext's directions (geometry only) before the
//! window and the latch are judged, because the planner must know which
//! accounts to read; the mask walk itself runs after the latch, as the
//! handler's does. The set of refusals is the handler's; the first one
//! reported may differ from the program's.
//!
//! **Publication gate: nothing destination-bearing leaves without it.** A
//! reveal publishes the plaintext (the destination, the tile, the path)
//! and the salt. The planner exports an instruction only when **all** of
//! the following hold, for both openings: THE canonical BellAnchor of
//! `(arrive, region)` is present (an archive alone or nothing is a typed
//! refusal, `AnchorRequired`); a public drand signature is supplied for
//! exactly `SeasonClock::tlock_round(arrive)` (`BeaconRound` otherwise);
//! its public key hashes to the Season's `quicknet_pk_hash` (`BeaconKey`);
//! the signature verifies under that key with `fclient::beacon::verify`
//! (`BeaconSignatureInvalid`); and the anchor's stored round is that round
//! (`NotCanonical("anchor")` — the stored round alone proves nothing).
//! This is a verification of supplied public vectors; no key or signature
//! is generated here. The gate runs right after the Season is read, before
//! the transit record or the plaintext is looked at.
//!
//! **The opening is the caller's and labelled.** `Opening::Supplied {
//! plain, salt }` is checked against the proof's commitment and the
//! record's root: `Crypto::CommitmentOnly`, the program's own check and no
//! statement about who produced the bytes. `Opening::FromBeacon` opens the
//! IBE block with the stock opener under the **verified** round signature
//! (`fclient::seal::open_ibe`) and the body with the ABI's `open_body`
//! against the proof's commitment: `Crypto::IbeOpened`. Without an opening
//! the plan blocks (`NoOpening`); the planner never derives a plaintext
//! from a root.
//!
//! **The proof is rebound to the record as it is now.** The transit record
//! must agree with the proof on host, transit slot (by address), arrival
//! bell, seal root, standing/origin province, departure bell, tip,
//! departure mass and march stamina (`ProofMismatch` names the field): a
//! slot re-used by a later march of the same host, or any other march,
//! is refused.
//!
//! **What stays unverified, said on the candidate.** The reads are a
//! lower-bound snapshot and the clock a separate call (not coherent) unless
//! they re-verify as one sealed same-response snapshot
//! (`Reads::coherent_snapshot`, `crate::widesnapshot`), which is coherence
//! at a context slot and nothing more;
//! the march's history before the applied records is unknown; the proof's
//! source is a feed record bound by wire and frame, its signatures
//! unverified; the fee evidence the handler reads from the instructions
//! sysvar (the legacy keeper sends a ComputeBudget prefix as **policy**;
//! the handler's evidence parser accepts defaults when none is present),
//! the rent of the slot and day accounts the reveal may create, and the
//! fee payer's funding are not checked here. `RevealFacts::unverified`
//! lists them. A `RevealCandidate` is an unsigned instruction the handler's
//! refusals did not fire on against these bytes — not a validated or
//! executable transaction.
//!
//! **Mirrored program logic.** `walk_wide` and `wide_admit` are
//! `pub(crate)` in the program and are mirrored here over the ABI's
//! `WideTile::neighbors`, `path_step`, `wide_slot_key` and the kernel's
//! travel constants, for the prediction only. The program applies its own.

use fclient::beacon::{pk_hash, verify};
use fclient::clock::SeasonClock;
use fclient::decode::{BeaconLog, BellAnchor};
use fclient::ports::{ChainPort, ClockSysvar};
use fclient::seal::open_ibe;
use frontier_abi::addr::archive_part_of;
use frontier_abi::bytes::{rd_i64, rd_u32, rd_u64, rd_u8};
use frontier_abi::entry::unit_from_u8;
use frontier_abi::layout::province::province as PV;
use frontier_abi::layout::province::site as SM;
use frontier_abi::prologue::Wr;
use frontier_abi::v2::layout::player::holding as H;
use frontier_abi::world_index::wide_ix::{self as wix, Reveal};
use frontier_abi::world_index::{
    arrival as wa, holding as wh, land as wl, march as wm, seal as wseal, ProvinceKey, TileAddress,
    WideHostRef, WidePlain, WideTile, WorldId, WIDE_PLAIN_LEN,
};
use permutation_rules::frontier::doctrine::of_faction_v3;
use permutation_rules::frontier::seal::{path_step, salt_of};
use permutation_rules::frontier::travel::{
    check_arrival_bell, is_cavalry, FLAT_HEX_SECS, MAX_PATH_PROVINCES, MAX_PATH_STEPS,
    ROUGH_HEX_SECS,
};
use serde_json::{json, Value};
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};

use crate::wideduty::{
    self, addr, ctx_of, holding_at, metas, missing, presence, province_at, season_of, transit_at,
    Block, Bound, Canon, Reads, Scope, Step, AUTOMATIC_SEND,
};
use crate::wideindex::WideDiscovery;
use crate::wideproof::{DepartProof, Provenance};
use crate::widesnapshot::{snapshot_plan, Snapshot, SnapshotMeta, SnapshotPort};

/// The public drand beacon of `T(arrive)`: the round, its signature and
/// the public key it is claimed under. Verified by the planner against
/// the Season's pinned key hash and the computed round; never produced
/// here.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Publication {
    pub round: u64,
    pub sig48: [u8; 48],
    pub pk96: [u8; 96],
}

/// How the plaintext and the salt of the reveal are obtained.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Opening {
    /// The owner's (or a parent-supplied) plaintext and salt. Checked
    /// against the commitment only.
    Supplied {
        plain: [u8; WIDE_PLAIN_LEN],
        salt: [u8; 32],
    },
    /// Open the IBE block with the verified round signature of the
    /// [`Publication`] and the body against the proof's commitment.
    FromBeacon,
}

/// What the plaintext's provenance is, said plainly.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Crypto {
    /// The supplied plaintext and salt reproduce the record's root. That
    /// is the program's check and no cryptographic statement about who
    /// could have produced them.
    CommitmentOnly,
    /// The IBE block opened under the verified round signature and the
    /// body reproduced the proof's commitment.
    IbeOpened,
}

/// The publication evidence the plan verified.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PublicationFacts {
    /// `SeasonClock::tlock_round(arrive)`, equal to the supplied round and
    /// to THE anchor's stored round.
    pub round: u64,
    /// `sha256(pk96)`, equal to the Season's `quicknet_pk_hash`.
    pub pk_hash: [u8; 32],
    /// Always `true` on a candidate: `fclient::beacon::verify` accepted the
    /// signature under that key for that round.
    pub signature_verified: bool,
}

/// THE anchor's window evidence: the close time, the seed round, the
/// log's latest round, and the observed clock the test was judged by.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Window {
    pub a_ts: i64,
    pub reveal_close: i64,
    pub seed_round: u64,
    pub latest_round: u64,
    pub judged_at: i64,
}

/// What this slice does not verify, named on every candidate (the planner
/// itself; `crate::widefees` calculates rent, base fee and the payer bound
/// from a same-response snapshot where one exists, and declares the rest).
pub const UNVERIFIED: [&str; 5] = [
    "fee evidence: the handler reads the ComputeBudget prefix from the instructions sysvar; the prefix is keeper policy, the evidence parser accepts defaults when none is present; not checked by the planner",
    "rent: the slot and the day account the reveal may create are funded by the fee payer; calculated by the fee review only from a same-response Rent sysvar",
    "payer funding: bounded by the fee review only from the payer's account in the same response; never a future balance",
    "history: the march's records before the applied history are unknown",
    "source: the departure proof is a feed record bound by wire and frame; its signatures were not verified",
];
/// Appended when the reads are not one response.
pub const UNVERIFIED_COHERENCE: &str =
    "coherence: the account reads are a lower-bound snapshot and the clock a separate call";
/// Appended when the reads are one response: coherent, but not current.
pub const UNVERIFIED_CURRENCY: &str =
    "currency: the snapshot's context slot is the slot the RPC served, not proof the data is current";

/// What a Reveal plan established from the reads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RevealFacts {
    pub host: WideHostRef,
    pub transit_slot: u8,
    pub arrive_bell: u32,
    pub dest: ProvinceKey,
    pub dest_tile: u8,
    pub region: u8,
    pub target_i: u8,
    /// The slot's present occupant this arrival would displace.
    pub displaced: Option<WideHostRef>,
    pub day_present: bool,
    pub day_bit_set: bool,
    pub window: Window,
    pub publication: PublicationFacts,
    /// The path provinces other than the destination, first-entered order.
    pub path_provinces: Vec<ProvinceKey>,
    pub travel_secs: u32,
    pub crypto: Crypto,
    /// The proof's provenance, carried verbatim (unproven source).
    pub source: Provenance,
    /// Keeper policy, not a handler mandate: the legacy keeper sends a
    /// ComputeBudget prefix so the fee evidence is explicit; the handler
    /// accepts the parser's defaults when none is present.
    pub budget_prefix_policy: &'static str,
    /// [`UNVERIFIED`], on every candidate.
    pub unverified: Vec<&'static str>,
}

/// An **unsigned** WideReveal the handler's refusals did not fire on
/// against these bytes, and the facts it rests on. Not validated for
/// execution: see [`RevealFacts::unverified`].
#[derive(Clone, Debug, PartialEq)]
pub struct RevealCandidate {
    pub facts: RevealFacts,
    pub instruction: Instruction,
    pub fee_payer: Address,
    pub beneficiary: Address,
    pub min_slot: u64,
    pub observed_clock: Option<ClockSysvar>,
    /// The verified same-response snapshot the plan ran over, bound to a
    /// digest of this candidate's content (crate-private, set only by the
    /// planner). Read through [`RevealCandidate::snapshot`].
    pub(crate) bound: Option<Bound>,
    pub status_promoted_by_clock: bool,
    /// Always `false`.
    pub signed: bool,
    /// Always [`AUTOMATIC_SEND`] (`false`).
    pub automatic_send: bool,
}

impl Window {
    pub(crate) fn canon(&self, c: &mut Canon) {
        c.i64(self.a_ts);
        c.i64(self.reveal_close);
        c.u64(self.seed_round);
        c.u64(self.latest_round);
        c.i64(self.judged_at);
    }
}

impl PublicationFacts {
    pub(crate) fn canon(&self, c: &mut Canon) {
        c.u64(self.round);
        c.bytes(&self.pk_hash);
        c.bool(self.signature_verified);
    }
}

impl Provenance {
    pub(crate) fn canon(&self, c: &mut Canon) {
        c.u64(self.seq);
        c.u64(self.slot);
        c.bytes(&self.signature);
        c.usize(self.instruction_index);
        c.bool(self.signatures_verified);
        c.str(self.method);
    }
}

impl RevealFacts {
    /// Every field, in declaration order, by full canonical bytes.
    pub(crate) fn canon(&self, c: &mut Canon) {
        c.host(&self.host);
        c.u8(self.transit_slot);
        c.u32(self.arrive_bell);
        c.province(&self.dest);
        c.u8(self.dest_tile);
        c.u8(self.region);
        c.u8(self.target_i);
        c.option(self.displaced.as_ref(), Canon::host);
        c.bool(self.day_present);
        c.bool(self.day_bit_set);
        self.window.canon(c);
        self.publication.canon(c);
        c.len(self.path_provinces.len());
        for k in &self.path_provinces {
            c.province(k);
        }
        c.u32(self.travel_secs);
        c.u8(match self.crypto {
            Crypto::CommitmentOnly => 1,
            Crypto::IbeOpened => 2,
        });
        self.source.canon(c);
        c.str(self.budget_prefix_policy);
        c.len(self.unverified.len());
        for s in &self.unverified {
            c.str(s);
        }
    }
}

impl RevealCandidate {
    /// The digest of everything the candidate exposes: the instruction,
    /// every fact (full identity bytes), the fee payer, the beneficiary,
    /// the slot bound, the observed clock, the status flag and the two
    /// always-false flags. Not the bound. Canonical bytes, never `Debug`.
    fn content(&self) -> [u8; 32] {
        let mut c = Canon::new(b"PSF-KEEPER-WIDE-REVEAL-CANDIDATE-v2");
        c.instruction(&self.instruction);
        self.facts.canon(&mut c);
        c.address(&self.fee_payer);
        c.address(&self.beneficiary);
        c.u64(self.min_slot);
        c.clock(self.observed_clock);
        c.bool(self.status_promoted_by_clock);
        c.bool(self.signed);
        c.bool(self.automatic_send);
        c.digest()
    }

    /// `true` exactly when every account and the clock the plan used came
    /// from one verified `getMultipleAccounts` response **and** the
    /// candidate is still exactly what the planner produced: coherence at
    /// that context slot — not currency, not completeness, not permission.
    pub fn coherent(&self) -> bool {
        self.snapshot().is_some()
    }

    /// The sealed meta of the response the plan ran over, if any and if
    /// the candidate's content still matches the digest it was bound with.
    pub fn snapshot(&self) -> Option<&SnapshotMeta> {
        let content = self.content();
        self.bound
            .as_ref()
            .filter(|b| b.content == content)
            .map(|b| &b.meta)
    }

    pub fn describe(&self) -> Value {
        let f = &self.facts;
        json!({
            "kind": "WideReveal",
            "host": hex::encode(f.host.to_bytes()),
            "transit_slot": f.transit_slot,
            "arrive_bell": f.arrive_bell,
            "dest": hex::encode(f.dest.to_bytes()),
            "dest_tile": f.dest_tile,
            "region": f.region,
            "target_i": f.target_i,
            "displaced": f.displaced.map(|h| hex::encode(h.to_bytes())),
            "day_present": f.day_present,
            "day_bit_set": f.day_bit_set,
            "window": format!("{:?}", f.window),
            "publication_round": f.publication.round,
            "publication_pk_hash": hex::encode(f.publication.pk_hash),
            "publication_signature_verified": f.publication.signature_verified,
            "path_provinces": f.path_provinces.len(),
            "travel_secs": f.travel_secs,
            "crypto": format!("{:?}", f.crypto),
            "source_signatures_verified": f.source.signatures_verified,
            "source_method": f.source.method,
            "budget_prefix_policy": f.budget_prefix_policy,
            "unverified": f.unverified,
            "accounts": self.instruction.accounts.len(),
            "fee_payer": self.fee_payer.to_string(),
            "min_slot": self.min_slot,
            "observed_clock_slot": self.observed_clock.map(|c| c.slot),
            "coherent": self.coherent(),
            "snapshot": self.snapshot().map(SnapshotMeta::describe),
            "status_promoted_by_clock": self.status_promoted_by_clock,
            "signed": self.signed,
            "automatic_send": self.automatic_send,
            "executable": "unverified",
        })
    }
}

macro_rules! need {
    ($reads:expr, $want:expr) => {{
        let m = missing($reads, &$want);
        if !m.is_empty() {
            return Step::Need(m);
        }
    }};
}

macro_rules! tri {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(b) => return Step::Done(Err(b)),
        }
    };
}

// ------------------------------------------------------------ mirrored program logic

/// A province's walkable masks (the program's `WideLand`).
#[derive(Clone, Copy, Debug)]
struct Land {
    key: ProvinceKey,
    passable: u64,
    rough: u64,
    road: u64,
}

fn land_of(pd: &[u8], key: ProvinceKey) -> Result<Land, Block> {
    let u = |o: usize| rd_u64(pd, o).ok_or(Block::Unreadable("province"));
    Ok(Land {
        key,
        passable: u(PV::PASSABLE_MASK)?,
        rough: u(PV::ROUGH_MASK)?,
        road: u(PV::ROAD_MASK)?,
    })
}

/// The provinces the committed path enters other than the destination, in
/// first-entered order (the accounts the handler requires after the fixed
/// positions). Geometry only; no mask is read.
fn path_provinces(
    plain: &WidePlain,
    origin: TileAddress,
    dest: ProvinceKey,
) -> Result<Vec<ProvinceKey>, Block> {
    let n = plain.path_len as usize;
    if n == 0 || n > MAX_PATH_STEPS {
        return Err(Block::Path("length"));
    }
    let mut tile = WideTile::of(origin);
    let mut out: Vec<ProvinceKey> = Vec::new();
    for i in 0..n {
        let dir = path_step(&plain.path, i) as usize;
        tile = *tile
            .neighbors()
            .get(dir)
            .and_then(|t| t.as_ref())
            .ok_or(Block::Path("step leaves the world"))?;
        let k = tile.province();
        if k != dest && !out.contains(&k) {
            out.push(k);
            if out.len() + 1 > MAX_PATH_PROVINCES {
                return Err(Block::Path("too many provinces"));
            }
        }
    }
    if tile.province() != dest || tile.local() != plain.dest_tile {
        return Err(Block::Path("end tile"));
    }
    Ok(out)
}

/// The program's `walk_wide`: raw travel seconds before the doctrine's
/// bias; `lands[0]` the destination, `lands[1..]` the path provinces in
/// first-entered order.
fn walk(
    plain: &WidePlain,
    origin: TileAddress,
    lands: &[Land],
    cavalry: bool,
) -> Result<u32, Block> {
    let n = plain.path_len as usize;
    let dest = lands.first().ok_or(Block::Path("no destination"))?;
    if n == 0 || n > MAX_PATH_STEPS || lands.len() > MAX_PATH_PROVINCES {
        return Err(Block::Path("length"));
    }
    let mut tile = WideTile::of(origin);
    let mut entered = 0usize;
    let mut secs = 0u32;
    let half = cavalry as u32;
    for i in 0..n {
        let dir = path_step(&plain.path, i) as usize;
        tile = *tile
            .neighbors()
            .get(dir)
            .and_then(|t| t.as_ref())
            .ok_or(Block::Path("step leaves the world"))?;
        let k = tile.province();
        let land = if k == dest.key {
            dest
        } else if let Some(l) = lands[1..1 + entered].iter().find(|l| l.key == k) {
            l
        } else {
            match lands.get(1 + entered) {
                Some(l) if l.key == k => {
                    entered += 1;
                    l
                }
                _ => return Err(Block::Path("province order")),
            }
        };
        let bit = 1u64 << tile.local();
        if land.passable & bit == 0 {
            return Err(Block::Path("impassable tile"));
        }
        let st = if land.rough & bit != 0 {
            ROUGH_HEX_SECS
        } else {
            FLAT_HEX_SECS
        };
        secs = secs.wrapping_add(st >> (half + (land.road & bit != 0) as u32));
    }
    if tile.province() != dest.key || tile.local() != plain.dest_tile || entered + 1 != lands.len()
    {
        return Err(Block::Path("end tile"));
    }
    Ok(secs)
}

/// An arrival in the quota's terms (the program's `WideSlotEntry`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct SlotEntry {
    host: WideHostRef,
    citizen: [u8; 32],
    troops: u32,
}

enum Admit {
    Fill(u8),
    Displace(u8, SlotEntry),
    AlreadyIn,
    CitizenHasLarger,
    Full,
}

/// The program's `wide_admit`: one arrival per host; one per Citizen (a
/// larger host of the same Citizen displaces); a free slot fills; else the
/// lowest-ranked present arrival is displaced when outranked. Rank: more
/// troops first, then `wide_slot_key(dest, bell, host)`, then the host
/// reference bytes.
fn admit(dest: ProvinceKey, bell: u32, slots: &[Option<SlotEntry>; 4], x: SlotEntry) -> Admit {
    use core::cmp::Reverse;
    if slots.iter().flatten().any(|e| e.host == x.host) {
        return Admit::AlreadyIn;
    }
    let rank = |e: &SlotEntry| {
        (
            Reverse(e.troops),
            wm::wide_slot_key(dest, bell, &e.host),
            e.host.to_bytes(),
        )
    };
    if let Some((i, e)) = slots
        .iter()
        .enumerate()
        .find_map(|(i, e)| e.filter(|e| e.citizen == x.citizen).map(|e| (i, e)))
    {
        return if rank(&x) < rank(&e) {
            Admit::Displace(i as u8, e)
        } else {
            Admit::CitizenHasLarger
        };
    }
    if let Some(i) = slots.iter().position(Option::is_none) {
        return Admit::Fill(i as u8);
    }
    let mut low: Option<(usize, SlotEntry)> = None;
    for (i, e) in slots.iter().enumerate() {
        if let Some(e) = e {
            if low.is_none_or(|(_, l)| rank(e) >= rank(&l)) {
                low = Some((i, *e));
            }
        }
    }
    match low {
        Some((i, e)) if rank(&x) < rank(&e) => Admit::Displace(i as u8, e),
        _ => Admit::Full,
    }
}

// ------------------------------------------------------------ the gates

/// The publication gate over the Season: the supplied beacon is for
/// exactly `T(arrive)`, under the pinned key, and verifies.
fn publication_gate(
    clock: &SeasonClock,
    pinned_pk_hash: [u8; 32],
    arrive: u32,
    publication: Option<&Publication>,
) -> Result<PublicationFacts, Block> {
    let Some(p) = publication else {
        return Err(Block::PublicationMissing);
    };
    let expected = clock.tlock_round(arrive);
    if p.round != expected {
        return Err(Block::BeaconRound {
            expected,
            got: p.round,
        });
    }
    let h = pk_hash(&p.pk96);
    if h != pinned_pk_hash {
        return Err(Block::BeaconKey);
    }
    if !verify(p.round, &p.sig48, &p.pk96) {
        return Err(Block::BeaconSignatureInvalid);
    }
    Ok(PublicationFacts {
        round: p.round,
        pk_hash: h,
        signature_verified: true,
    })
}

/// The plaintext and salt of `opening` against the proof's seal, and the
/// label. The commitment is recomputed with the ABI's functions and must
/// reproduce the proof's commitment and root.
fn open(
    proof: &DepartProof,
    opening: &Opening,
    publication: &Publication,
) -> Result<([u8; WIDE_PLAIN_LEN], [u8; 32], Crypto), Block> {
    let ct = wseal::ct_hash(&proof.seal);
    match opening {
        Opening::Supplied { plain, salt } => {
            let c = wseal::commit(plain, salt);
            if c != proof.commit || wseal::seal_root(&c, &ct) != proof.seal_root {
                return Err(Block::CommitMismatch);
            }
            Ok((*plain, *salt, Crypto::CommitmentOnly))
        }
        Opening::FromBeacon => {
            let k = open_ibe(&wseal::ibe_block(&proof.seal), &publication.sig48)
                .map_err(|e| Block::SealOpen(format!("{e:?}")))?;
            let plain =
                wseal::open_body(&k, &proof.seal, &proof.commit).ok_or(Block::CommitMismatch)?;
            let salt = salt_of(&k);
            if wseal::seal_root(&proof.commit, &ct) != proof.seal_root {
                return Err(Block::CommitMismatch);
            }
            Ok((plain, salt, Crypto::IbeOpened))
        }
    }
}

// ------------------------------------------------------------ the plan

/// Plans a WideReveal of the march `proof` describes. Reads in rounds: the
/// Season, the holding and the transit; the destination province; then
/// the anchor, archive, beacon log, inputs, ArrivalDay, four slots and the
/// path provinces. The publication gate runs as soon as the Season is
/// read; without it nothing destination-bearing is produced.
pub fn plan_reveal(
    scope: &Scope,
    fee_payer: Address,
    beneficiary: Address,
    proof: &DepartProof,
    opening: Option<&Opening>,
    publication: Option<&Publication>,
    reads: &Reads,
) -> Step<RevealCandidate> {
    let ctx = ctx_of(scope);
    let world =
        tri!(WorldId::derive_legacy_season(&ctx.season, &ctx.program).map_err(|_| Block::World));
    let host = proof.host;
    if host.key().world() != world {
        return Step::Done(Err(Block::World));
    }
    if proof.transit_slot as usize >= H::TRANSIT_N {
        return Step::Done(Err(Block::BadSlot(proof.transit_slot)));
    }
    let Some(opening) = opening else {
        return Step::Done(Err(Block::NoOpening));
    };
    let holding_key = wh::holding_address(&ctx, host.key().coord(), host.site());
    let holding_addr = addr(holding_key);
    let transit_addr = addr(wm::transit_address(&ctx, &holding_key, proof.transit_slot));
    if proof.holding != holding_addr || proof.transit != transit_addr {
        return Step::Done(Err(Block::ProofMismatch("holding or transit address")));
    }
    need!(reads, [scope.season, holding_addr, transit_addr]);
    let (season, promoted) = tri!(season_of(scope, reads));
    let sid = season.h.season_id;
    let clock = SeasonClock::from_season(&season);
    // The publication gate, on the proof's arrival bell (the record must
    // agree with it below).
    let publication_facts = tri!(publication_gate(
        &clock,
        season.quicknet_pk_hash,
        proof.arrive_bell,
        publication
    ));
    let publication = publication.expect("the gate passed");
    // 2. the holding, the transit record, the plaintext.
    let (h, hd) = tri!(
        tri!(holding_at(reads, scope, &ctx, &holding_addr, sid, world))
            .ok_or(Block::Absent("holding"))
    );
    let t = tri!(tri!(transit_at(reads, scope, &transit_addr)).ok_or(Block::NoMarch));
    if !t.state.in_transit() {
        return Step::Done(Err(Block::TransitState(t.state)));
    }
    if t.host.key().coord() != h.coord || t.host.site() != h.site {
        return Step::Done(Err(Block::TransitOtherHost));
    }
    // The proof rebound to the record as it is now, field by field.
    if t.host != host {
        return Step::Done(Err(Block::ProofMismatch("host")));
    }
    if t.arrive_bell != proof.arrive_bell {
        return Step::Done(Err(Block::ProofMismatch("arrive_bell")));
    }
    if t.seal_root != proof.seal_root {
        return Step::Done(Err(Block::ProofMismatch("seal_root")));
    }
    if t.origin.key() != proof.standing {
        return Step::Done(Err(Block::ProofMismatch("standing")));
    }
    if t.depart_bell != proof.depart_bell {
        return Step::Done(Err(Block::ProofMismatch("depart_bell")));
    }
    if t.tip != proof.tip {
        return Step::Done(Err(Block::ProofMismatch("tip")));
    }
    if t.dep_mass != proof.dep_mass_milli {
        return Step::Done(Err(Block::ProofMismatch("dep_mass")));
    }
    if t.march_stamina != proof.march_stamina {
        return Step::Done(Err(Block::ProofMismatch("march_stamina")));
    }
    let arrive = t.arrive_bell;
    if season.status == fclient::abi::status::ENDED && arrive >= season.end_bell {
        return Step::Done(Err(Block::SeasonEnded));
    }
    let (plain_bytes, salt, crypto) = tri!(open(proof, opening, publication));
    let plain =
        tri!(wseal::unpack(&plain_bytes).map_err(|e| Block::BadPlaintext(format!("{e:?}"))));
    tri!(
        wseal::validate(&plain, &t.host, arrive).map_err(|e| Block::BadPlaintext(format!("{e:?}")))
    );
    // 3. the commitment, as the handler computes it.
    let ct_hash = wseal::ct_hash(&proof.seal);
    if wseal::seal_root(&wseal::commit(&plain_bytes, &salt), &ct_hash) != t.seal_root {
        return Step::Done(Err(Block::CommitMismatch));
    }
    // 4. the destination, its region and the window.
    let dest = plain.dest;
    if dest.world() != world {
        return Step::Done(Err(Block::World));
    }
    let dest_addr = addr(wl::province_address(&ctx, dest.coord()));
    need!(reads, [dest_addr]);
    let (dprov, dpd) = tri!(tri!(province_at(
        reads,
        scope,
        &ctx,
        &dest_addr,
        sid,
        world,
        "dest_province"
    ))
    .ok_or(Block::Absent("dest_province")));
    if dprov.coord != dest.coord() {
        return Step::Done(Err(Block::NotCanonical("dest_province")));
    }
    let region = dprov.region;
    // The path's provinces by geometry (which accounts to read); the mask
    // walk runs after the latch, as the handler's does.
    let path_keys = tri!(path_provinces(&plain, t.origin, dest));
    let anchor_addr = addr(ctx.bell_anchor(arrive, region));
    let part = archive_part_of(arrive);
    let archive_addr = addr(ctx.anchor_archive(region, part));
    let log_addr = addr(ctx.beacon_log(region));
    let inputs_addr = addr(wa::clash_inputs_address(&ctx, dest, arrive));
    let day = wa::day_of(arrive);
    let day_addr = addr(wa::arrival_day_address(&ctx, dest, day));
    let slot_addrs: [Address; 4] = std::array::from_fn(|i| {
        addr(wa::arrival_slot_address(
            &ctx, dest, arrive, t.faction, i as u8,
        ))
    });
    let path_addrs: Vec<Address> = path_keys
        .iter()
        .map(|k| addr(wl::province_address(&ctx, k.coord())))
        .collect();
    let mut want = vec![anchor_addr, archive_addr, log_addr, inputs_addr, day_addr];
    want.extend_from_slice(&slot_addrs);
    want.extend_from_slice(&path_addrs);
    need!(reads, want);
    // THE anchor, present: the one publication evidence the plan accepts
    // (an archive alone is a typed refusal: the handler would read it, the
    // keeper does not publish on it).
    let Some(anchor_acc) = tri!(presence(reads, &anchor_addr, &scope.program, "anchor")) else {
        let archived = tri!(presence(reads, &archive_addr, &scope.program, "archive")).is_some();
        return Step::Done(Err(Block::AnchorRequired(if archived {
            "archive-only"
        } else {
            "absent"
        })));
    };
    let a = tri!(BellAnchor::decode(&anchor_acc.data).map_err(|_| Block::Unreadable("anchor")));
    if a.season_id != sid
        || a.bell != arrive
        || a.region != region
        || a.round != publication_facts.round
    {
        return Step::Done(Err(Block::NotCanonical("anchor")));
    }
    let Some(now) = reads.clock else {
        return Step::Done(Err(Block::TimingNeedsClock));
    };
    let close = clock.reveal_close(arrive, a.a);
    if now.unix_timestamp >= close {
        return Step::Done(Err(Block::WindowClosed(
            "reveal_close by the observed clock",
        )));
    }
    let log = tri!(
        tri!(presence(reads, &log_addr, &scope.program, "beaconlog"))
            .ok_or(Block::Absent("beaconlog"))
    );
    let l = tri!(BeaconLog::decode(&log.data).map_err(|_| Block::Unreadable("beaconlog")));
    if l.season_id != sid || l.region != region {
        return Step::Done(Err(Block::NotCanonical("beaconlog")));
    }
    let seed_round = clock.seed_round(arrive, a.a);
    if l.latest_round >= seed_round {
        return Step::Done(Err(Block::WindowClosed(
            "beacon log at or past the seed round",
        )));
    }
    let window = Window {
        a_ts: a.a,
        reveal_close: close,
        seed_round,
        latest_round: l.latest_round,
        judged_at: now.unix_timestamp,
    };
    // 5. the latch.
    if tri!(presence(reads, &inputs_addr, &scope.program, "inputs")).is_some() {
        return Step::Done(Err(Block::LatchClosed("clash inputs present")));
    }
    let resolved_next =
        tri!(rd_u32(dpd, PV::RESOLVED_NEXT).ok_or(Block::Unreadable("dest_province")));
    if resolved_next > arrive {
        return Step::Done(Err(Block::LatchClosed(
            "destination resolved past the arrival",
        )));
    }
    // 6. the path over the masks and the arrival bell.
    let mut lands = vec![tri!(land_of(dpd, dest))];
    for (k, a) in path_keys.iter().zip(path_addrs.iter()) {
        let (pp, ppd) = tri!(tri!(province_at(
            reads,
            scope,
            &ctx,
            a,
            sid,
            world,
            "path_province"
        ))
        .ok_or(Block::Absent("path_province")));
        if pp.coord != k.coord() {
            return Step::Done(Err(Block::NotCanonical("path_province")));
        }
        lands.push(tri!(land_of(ppd, *k)));
    }
    let unit = tri!(unit_from_u8(t.unit).ok_or(Block::Unreadable("transit")));
    let raw = tri!(walk(&plain, t.origin, &lands, is_cavalry(unit)));
    let doctrine = tri!(of_faction_v3(t.faction).ok_or(Block::Unreadable("transit")));
    let secs = tri!(u32::try_from(doctrine.travel_secs(raw as u64))
        .map_err(|_| Block::Overflow("travel seconds")));
    if check_arrival_bell(season.genesis_ts, t.depart_ts, secs, arrive).is_err() {
        return Step::Done(Err(Block::ArrivalBell));
    }
    // The destination site under the committed tile, and the shield.
    let n_sites =
        tri!(rd_u8(dpd, PV::SITE_COUNT).ok_or(Block::Unreadable("dest_province"))) as usize;
    let site_at = (0..n_sites.min(PV::SITES_N))
        .find(|&k| dpd.get(PV::SITES + k).copied() == Some(plain.dest_tile));
    if let Some(k) = site_at {
        let o = PV::site(k);
        let state = tri!(rd_u8(dpd, o + SM::STATE).ok_or(Block::Unreadable("dest_province")));
        let owner = tri!(rd_u8(dpd, o + SM::FACTION).ok_or(Block::Unreadable("dest_province")));
        let shield_bell =
            tri!(rd_u32(dpd, o + SM::SHIELD_UNTIL_BELL).ok_or(Block::Unreadable("dest_province")));
        let other = state == SM::STATE_HOLDING && owner != t.faction;
        if other && shield_bell > arrive {
            return Step::Done(Err(Block::Shielded));
        }
        let shield_until = tri!(rd_i64(hd, H::SHIELD_UNTIL).ok_or(Block::Unreadable("holding")));
        let flags = tri!(rd_u8(hd, H::FLAGS).ok_or(Block::Unreadable("holding")));
        let dormant = flags & H::FLAG_DORMANT_CACHE != 0;
        let own_shielded = !dormant
            && shield_until
                > permutation_rules::frontier::beacon::bell_start(season.genesis_ts, arrive);
        if other && own_shielded {
            return Step::Done(Err(Block::Shielded));
        }
    }
    // 7. the quota.
    let mut slots: [Option<SlotEntry>; 4] = [None; 4];
    for (i, a) in slot_addrs.iter().enumerate() {
        let Some(acc) = tri!(presence(reads, a, &scope.program, "slot")) else {
            continue;
        };
        let s = tri!(wa::WideArrivalSlot::read(&acc.data).map_err(|_| Block::Unreadable("slot")));
        if s.season_id != sid
            || s.dest != dest
            || s.bell != arrive
            || s.faction != t.faction
            || s.i != i as u8
        {
            return Step::Done(Err(Block::NotCanonical("slot")));
        }
        slots[i] = Some(SlotEntry {
            host: s.host,
            citizen: s.citizen,
            troops: s.dep_mass,
        });
    }
    let me = SlotEntry {
        host: t.host,
        citizen: h.owner_citizen,
        troops: t.dep_mass,
    };
    let (target_i, displaced) = match admit(dest, arrive, &slots, me) {
        Admit::AlreadyIn => return Step::Done(Err(Block::AlreadyRevealed)),
        Admit::CitizenHasLarger => {
            return Step::Done(Err(Block::QuotaRefused("citizen has a larger arrival")))
        }
        Admit::Full => return Step::Done(Err(Block::QuotaRefused("full"))),
        Admit::Fill(i) => (i, None),
        Admit::Displace(i, e) => (i, Some(e.host)),
    };
    // 8. the ArrivalDay.
    let (day_present, day_bit_set) =
        match tri!(presence(reads, &day_addr, &scope.program, "arrivalday")) {
            Some(acc) => {
                let d = tri!(wa::WideArrivalDay::read(&acc.data)
                    .map_err(|_| Block::Unreadable("arrivalday")));
                if d.season_id != sid || d.dest != dest || d.day != day {
                    return Step::Done(Err(Block::NotCanonical("arrivalday")));
                }
                (true, d.has(arrive))
            }
            None => (false, false),
        };
    // The instruction: the fixed positions, then the path provinces.
    let mut keys = vec![
        fee_payer,
        scope.season,
        holding_addr,
        transit_addr,
        anchor_addr,
        archive_addr,
        log_addr,
        inputs_addr,
        dest_addr,
        day_addr,
    ];
    keys.extend_from_slice(&slot_addrs);
    keys.push(fclient::addr::instructions_sysvar());
    keys.push(fclient::addr::system_program());
    debug_assert_eq!(keys.len(), wix::REVEAL_FIXED);
    let mut accounts = metas(wix::REVEAL, &keys);
    for a in &path_addrs {
        accounts.push(AccountMeta::new_readonly(*a, false));
    }
    // `Wr::Either` positions as the handler decides them: the ArrivalDay
    // writable when its bit is not set (created or set here), exactly the
    // target slot writable.
    for (i, m) in accounts.iter_mut().enumerate() {
        if i == wix::REVEAL_DAY {
            m.is_writable = !day_bit_set;
        } else if (wix::REVEAL_SLOT0..wix::REVEAL_SLOT0 + 4).contains(&i) {
            m.is_writable = i == wix::REVEAL_SLOT0 + target_i as usize;
        }
    }
    debug_assert!(wix::REVEAL
        .iter()
        .flat_map(|g| g.specs.iter())
        .all(|s| !matches!(s.wr, Wr::W) || s.name == "fee_payer"));
    let data = Reveal {
        transit_slot: proof.transit_slot,
        target_i,
        plain: plain_bytes,
        salt,
        ct_hash,
        beneficiary: beneficiary.to_bytes(),
    }
    .to_bytes()
    .to_vec();
    let facts = RevealFacts {
        host,
        transit_slot: proof.transit_slot,
        arrive_bell: arrive,
        dest,
        dest_tile: plain.dest_tile,
        region,
        target_i,
        displaced,
        day_present,
        day_bit_set,
        window,
        publication: publication_facts,
        path_provinces: path_keys,
        travel_secs: secs,
        crypto,
        source: proof.provenance.clone(),
        budget_prefix_policy: "keeper policy: send a ComputeBudget prefix so the fee evidence is explicit; the handler's evidence parser accepts defaults when none is present; not verified here",
        unverified: {
            let mut u = UNVERIFIED.to_vec();
            u.push(if reads.coherent_snapshot().is_some() {
                UNVERIFIED_CURRENCY
            } else {
                UNVERIFIED_COHERENCE
            });
            u
        },
    };
    let mut c = RevealCandidate {
        facts,
        instruction: Instruction {
            program_id: scope.program,
            accounts,
            data,
        },
        fee_payer,
        beneficiary,
        min_slot: reads.min_slot,
        observed_clock: reads.clock,
        bound: None,
        status_promoted_by_clock: promoted,
        signed: false,
        automatic_send: AUTOMATIC_SEND,
    };
    c.bound = reads.coherent_snapshot().cloned().map(|meta| Bound {
        meta,
        content: c.content(),
    });
    Step::Done(Ok(c))
}

/// [`plan_reveal`] over **one** snapshot response
/// ([`crate::widesnapshot::snapshot_plan`]) with the Rent sysvar and the
/// fee payer's account in the same response, for the fee review. The
/// publication gate and every other check are unchanged.
#[allow(clippy::too_many_arguments)]
pub async fn reveal_snapshot<P: ChainPort + SnapshotPort>(
    port: &P,
    scope: &Scope,
    fee_payer: Address,
    beneficiary: Address,
    proof: &DepartProof,
    opening: Option<&Opening>,
    publication: Option<&Publication>,
    min_slot: u64,
) -> Result<(RevealCandidate, Snapshot), Block> {
    snapshot_plan(port, min_slot, true, &[fee_payer], |r| {
        plan_reveal(
            scope,
            fee_payer,
            beneficiary,
            proof,
            opening,
            publication,
            r,
        )
    })
    .await
}

/// [`plan_reveal`] over live reads: at least `min_slot`, the Clock read
/// once and separately (never coherent), at most six read rounds. Calls
/// only `clock` and `accounts`.
#[allow(clippy::too_many_arguments)]
pub async fn reveal_via<P: ChainPort>(
    port: &P,
    scope: &Scope,
    fee_payer: Address,
    beneficiary: Address,
    proof: &DepartProof,
    opening: Option<&Opening>,
    publication: Option<&Publication>,
    min_slot: u64,
) -> Result<RevealCandidate, Block> {
    let mut reads = Reads::new(min_slot);
    reads.clock = port.clock().await.ok();
    for _ in 0..6 {
        match plan_reveal(
            scope,
            fee_payer,
            beneficiary,
            proof,
            opening,
            publication,
            &reads,
        ) {
            Step::Done(r) => return r,
            Step::Need(addrs) => {
                let got = port
                    .accounts(&addrs, min_slot)
                    .await
                    .map_err(|e| Block::Read(e.to_string()))?;
                if got.len() != addrs.len() {
                    return Err(Block::Read("account count differs from the request".into()));
                }
                for (a, acc) in addrs.iter().zip(got) {
                    reads.accounts.insert(*a, acc);
                }
            }
        }
    }
    Err(Block::ReadLoop)
}

/// A **hint only**: of the proofs a page of feed records yielded, those
/// whose `(host, transit slot)` the discovery model still shows as an open
/// departure. It says nothing about the transit record now — a slot may
/// have been re-used by a later march, which [`plan_reveal`] refuses by
/// rebinding the proof to the record (`ProofMismatch`).
pub fn proofs_for(d: &WideDiscovery, proofs: &[DepartProof]) -> Vec<DepartProof> {
    let open = wideduty::settle_candidates(d);
    proofs
        .iter()
        .filter(|p| {
            open.iter()
                .any(|(h, s)| *h == p.host && *s == p.transit_slot)
        })
        .cloned()
        .collect()
}
