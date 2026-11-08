//! **Protocol v4: a march to a chosen, newly opened province** (2026-11-08).
//! See `docs/frontier/map-growth/LOCAL-CHOSEN-MARCH-20261108.md`.
//!
//! `depart_route DIRS`, while `ready`, recomputes the route quote on the
//! current province bytes and takes the destination province and tile from
//! the walked path. It refuses every destination this slice does not support.
//! It rebuilds the march order from the published material
//! (`order_material`), after reproducing the recorded order byte for byte. It
//! runs the real Depart on a staged copy. It then rehearses the real
//! SettleDeparture and post_reveal (the destination's preparation, PostAnchor
//! and Reveal) on a copy that is dropped, so a route the real Reveal would
//! refuse is refused now, atomically, instead of stranding a departed host.
//! Only then is the staged copy kept, for the controller to render, bound and
//! commit.
//!
//! The later phase steps of a chosen march run real handlers only: the
//! destination's preparation through bell 19 (`prepare_destination`:
//! synthetic non-arrival pairs, real WideResolve, the clock never moved
//! back), PostAnchor and PostSeed over the published bell-20 signatures,
//! Reveal, Gather, the arrival Resolve, SettleTransit, Resolves 21 to 23,
//! Dissolve and Return. Each is dispatched over a bounded sub-map
//! (`dispatch_sub_map`) holding only the accounts it lists. Absent planned
//! accounts are staged for that one instruction and dropped unless the
//! handler created them, so the persistent map stays within 96 images. Each
//! is judged by [`judge_march`]: its receipt (kind, province, host, bell),
//! the exact images it may change or create, the receipt chains of the
//! holding and of every province held, and lamports.
//!
//! **Refused explicitly, never re-routed:** a destination in the origin
//! province (the host's own roster and entry aliasing are not modelled for a
//! march), in the exported fixture destination (`depart` sends the recorded
//! order there), or in a province with resolve history or live entries; and
//! an arrival fate other than "stays" (`ARRIVAL_FATE_UNSUPPORTED`). No enemy
//! is staged at an opened province: its combat is whatever the real handlers
//! produce, possibly none.
use crate::destination_stage::{self as ds, PlannedAccount, SubMapCall};
use crate::engine::{
    unhex, verify_chains, Quote, Sandbox, FINAL_BELL, GENESIS, MAX_ROUTE_DIRS, SOURCE_FIXTURE,
};
use crate::land_bootstrap::{Images, GATED, MAX_TOTAL_IMAGES, PROVINCE_PREFIX};
use crate::order_material::{
    self as om, OrderBinding, OrderMaterial, OrderRequest, Snapshot, ARRIVE_BELL,
};
use crate::runtime::{Meta, PROGRAM};
use frontier_abi::bytes::{rd_u32, rd_u8};
use frontier_abi::v2::layout::province::province as PV2;
use frontier_abi::world_index::arrival as wa;
use frontier_abi::world_index::event::{self as ev, WideKind};
use frontier_abi::world_index::wide_ix as wix;
use frontier_abi::world_index::{
    MarchState, ProvinceKey, WideCoord, WideHostRef, WideProvince, WideTransit,
};
use permutation_frontier::layout::{holding as H, province as PV, Ro};
use permutation_rules::frontier::travel::MAX_PATH_PROVINCES;
use std::collections::BTreeMap;

/// Path provinces a Reveal may list besides the destination
/// (`walk_wide`: at most `MAX_PATH_PROVINCES` lands, the destination first).
pub const PATH_PROVINCES_MAX: usize = MAX_PATH_PROVINCES - 1;
/// Bound on the per-destination accounts a binding names (`accounts`).
pub const MARCH_ACCOUNTS_MAX: usize = 16;
/// Bound on the provenance trail of a binding (`trail`).
pub const MARCH_TRAIL_MAX: usize = 24;
/// The resolver, slot and settlement beneficiary the recorded flow names.
const BENEFICIARY: [u8; 32] = [0xd4; 32];
/// `depart_route` refusals decided before any dispatch.
pub const ROUTE_REFUSALS: [&str; 4] = [
    "ROUTE_UNREACHABLE",
    "ROUTE_DESTINATION_ORIGIN",
    "ROUTE_DESTINATION_FIXTURE",
    "ROUTE_DESTINATION_UNSUPPORTED",
];
/// Where the order of a binding came from.
pub const ORDER_RECORDED: &str = "RECORDED_FIXTURE_ORDER";
pub const ORDER_REBUILT: &str = "REBUILT_FROM_PUBLIC_MATERIAL_T20";

/// Which order a march was sent with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarchKind {
    /// `depart`: the recorded fixture order to the recorded destination.
    Recorded,
    /// `depart_route`: an order rebuilt from public material to a chosen,
    /// session-opened province.
    Chosen,
}
impl MarchKind {
    pub const fn token(self) -> &'static str {
        match self {
            MarchKind::Recorded => "recorded",
            MarchKind::Chosen => "chosen",
        }
    }
}

/// What `prepare_destination` did for a chosen destination at post_reveal.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Preparation {
    pub from_bell: u32,
    pub to_bell: u32,
    pub resolved_next: u32,
    pub score_next_bell: u32,
    pub at: i64,
    pub resolves: usize,
    pub region: u8,
    pub pairs_aliased: usize,
    pub provenance: &'static str,
}

/// The departed march: what was sent where, bound explicitly. The map's
/// `destination` image is never repointed; `dest_name` names the bound one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MarchBinding {
    pub kind: MarchKind,
    pub directions: Vec<u8>,
    /// The image name of the destination province (`destination` for the
    /// recorded march, `land_province_{p}_{q}` for a chosen one).
    pub dest_name: String,
    pub dest_key: ProvinceKey,
    pub dest_tile: u8,
    /// The tiles the route enters, in order (the host's quote).
    pub steps: Vec<(i64, i64, u8)>,
    /// `verify_route`'s provinces, first-entered order.
    pub entered: Vec<(i64, i64)>,
    /// The Reveal's trailing path provinces: `entered` without the
    /// destination, by image name.
    pub path: Vec<String>,
    pub commit: [u8; 32],
    pub root: [u8; 32],
    /// The rebuilt order (chosen only; the recorded march uses the fixture's).
    pub order: Option<OrderMaterial>,
    /// The host's milli-troops standing before the departure.
    pub departed_milli: u32,
    pub preparation: Option<Preparation>,
    /// `(role, image name)` of every per-destination planned account a chosen
    /// march's instruction created or wrote, in first-touch order.
    pub accounts: Vec<(String, String)>,
    /// Fixed provenance tokens, in the order the steps produced them.
    pub trail: Vec<&'static str>,
}
impl MarchBinding {
    pub fn dest_pq(&self) -> (i64, i64) {
        (self.dest_key.coord().p(), self.dest_key.coord().q())
    }
    fn mark(&mut self, token: &'static str) -> Result<(), String> {
        if !self.trail.contains(&token) {
            self.trail.push(token);
        }
        if self.trail.len() > MARCH_TRAIL_MAX {
            return Err("MARCH_TRAIL_BOUND".into());
        }
        Ok(())
    }
}

/// The receipt an instruction must leave.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Receipt {
    /// PostAnchor/PostSeed: one beacon log (the runtime's), no wide receipt.
    Beacon,
    /// Exactly one wide receipt of this kind, of the destination (and, when
    /// host-keyed, of this host).
    Kind(WideKind),
    /// Exactly one Resolve of this bell, keyed by the destination.
    Resolve(u32),
}

/// One instruction of a chosen march, everything from the engine.
struct MarchCall<'a> {
    name: &'static str,
    metas: &'a [Meta],
    data: &'a [u8],
    permitted: &'a [PlannedAccount],
    receipt: Receipt,
    /// Every image name the instruction may change or create.
    allowed: &'a [&'a str],
}

fn acct(name: &str, signer: bool, writable: bool) -> Meta {
    Meta {
        name: name.into(),
        signer,
        writable,
    }
}
fn r(n: &str) -> Meta {
    acct(n, false, false)
}
fn w(n: &str) -> Meta {
    acct(n, false, true)
}
fn s(n: &str, writable: bool) -> Meta {
    acct(n, true, writable)
}

fn role(plan: &[PlannedAccount], name: &str) -> Result<PlannedAccount, String> {
    plan.iter()
        .find(|a| a.role == name)
        .cloned()
        .ok_or_else(|| format!("MARCH_PLAN:{name}"))
}

/// The fixed Depart account list (the recorded flow's, `engine.rs` depart).
fn depart_metas() -> Vec<Meta> {
    let mut a = vec![
        s("actor", false),
        s("payer", true),
        r("season"),
        w("citizen"),
        w("holding"),
        w("origin"),
        r("system"),
        r("origin"),
    ];
    for i in 0..4 {
        a.push(if i == 0 {
            w(&format!("transit_{i}"))
        } else {
            r(&format!("transit_{i}"))
        });
    }
    a.push(r("origin_roster"));
    a
}

fn total_lamports(m: &Images) -> u128 {
    let mut by_key = BTreeMap::new();
    for im in m.values() {
        by_key.entry(im.key).or_insert(im.lamports);
    }
    by_key.values().map(|l| u128::from(*l)).sum()
}

/// Judges one chosen-march instruction over the whole persistent map before
/// and after its sub-map dispatch: the receipt (count, kind, the destination
/// as its province, this host when host-keyed, the bell of a Resolve); no
/// image removed; every image changed or added named in `allowed`; the map
/// within 96 images; the chains of the holding and of every province held
/// ([`verify_chains`]); lamports conserved by key. `Err` is a fault code.
pub(crate) fn judge_march(
    before: &Images,
    after: &Images,
    recs: &[Vec<u8>],
    receipt: Receipt,
    allowed: &[&str],
    host: WideHostRef,
    dest: ProvinceKey,
) -> Result<(), String> {
    let want = match receipt {
        Receipt::Beacon => None,
        Receipt::Kind(kind) => Some((kind, None)),
        Receipt::Resolve(bell) => Some((WideKind::Resolve, Some(bell))),
    };
    match want {
        None => {
            if !recs.is_empty() {
                return Err("MARCH_BEACON_RECEIPT".into());
            }
        }
        Some((kind, bell)) => {
            let [body] = recs else {
                return Err("MARCH_RECEIPT_COUNT".into());
            };
            let rec = ev::WideRecord::decode(body).map_err(|_| "MARCH_RECEIPT")?;
            if rec.kind != kind
                || rec.province_of() != Some(dest)
                || bell.is_some_and(|b| rec.bell != b)
                || (kind.host_keyed() && rec.host() != Some(host))
            {
                return Err(format!("MARCH_RECEIPT:{kind:?}"));
            }
        }
    }
    if before.keys().any(|n| !after.contains_key(n)) {
        return Err("MARCH_NAME_SET".into());
    }
    for (n, a) in after {
        if before.get(n) != Some(a) && !allowed.contains(&n.as_str()) {
            return Err(format!("MARCH_FOREIGN_WRITE:{n}"));
        }
    }
    if after.len() > MAX_TOTAL_IMAGES {
        return Err("MARCH_ACCOUNT_BOUND".into());
    }
    verify_chains(host, before, after, recs)?;
    if total_lamports(before) != total_lamports(after) {
        return Err("MARCH_LAMPORTS".into());
    }
    Ok(())
}

/// The real SettleDeparture and post_reveal of a just-departed chosen march
/// on a copy that is dropped afterwards (`depart_route`'s rehearsal).
fn rehearse(mut copy: Sandbox) -> Result<(), String> {
    copy.step("settle_departure")?;
    copy.step("post_reveal")
}

impl Sandbox {
    pub fn is_chosen(&self) -> bool {
        self.march
            .as_ref()
            .is_some_and(|m| m.kind == MarchKind::Chosen)
    }
    fn chosen(&self) -> Result<MarchBinding, String> {
        match &self.march {
            Some(m) if m.kind == MarchKind::Chosen => Ok(m.clone()),
            _ => Err("MARCH_BINDING".into()),
        }
    }
    fn slot(&self) -> u64 {
        1000 + ((self.now - GENESIS) / 600) as u64
    }
    fn faction(&self) -> Result<u8, String> {
        u8::try_from(self.num("faction")?).map_err(|_| "FIXTURE_FACTION".into())
    }
    fn meta_i64(&self, k: &str) -> Result<i64, String> {
        self.meta
            .get(k)
            .ok_or("MISSING_META")?
            .parse()
            .map_err(|_| "FIXTURE_NUMBER".into())
    }
    fn snapshot(&self, n: &str) -> Result<Snapshot<'_>, String> {
        let im = self.images.get(n).ok_or_else(|| format!("MISSING_{n}"))?;
        Ok(Snapshot {
            key: im.key,
            owner: im.owner,
            data: &im.data,
        })
    }
    fn order_binding(&self) -> Result<OrderBinding, String> {
        OrderBinding::new(
            &PROGRAM,
            self.snapshot("season")?,
            self.snapshot("citizen")?,
            self.snapshot("holding")?,
            self.host()?,
        )
        .map_err(|e| format!("ORDER_BINDING:{e:?}"))
    }
    /// The recorded order rebuilt from the same public material must equal
    /// the fixture's `plain`, `seal`, `commit`, `ct_hash`, `root` and `salt`
    /// byte for byte before any chosen order is trusted.
    fn recorded_order_golden(&self, b: &OrderBinding) -> Result<(), String> {
        let dirs = unhex(self.meta.get("directions").ok_or("MISSING_META")?)?;
        let coord = WideCoord::checked(
            self.meta_i64("destination_p")?,
            self.meta_i64("destination_q")?,
        )
        .map_err(|_| "FIXTURE_COORD")?;
        let tile = u8::try_from(self.num("destination_tile")?).map_err(|_| "FIXTURE_TILE")?;
        let m = om::build_order(
            b,
            &OrderRequest {
                dest: ProvinceKey::new(b.world, coord),
                dest_tile: tile,
                directions: &dirs,
                stance: 0,
                retreat_bps: 0,
                arrive_bell: ARRIVE_BELL,
            },
        )
        .map_err(|e| format!("ORDER_GOLDEN:{e:?}"))?;
        let fields: [(&str, &[u8]); 6] = [
            ("plain", &m.plain[..]),
            ("seal", &m.seal[..]),
            ("commit", &m.commit[..]),
            ("ct_hash", &m.ct_hash[..]),
            ("root", &m.root[..]),
            ("salt", &m.salt[..]),
        ];
        for (k, v) in fields {
            let want = unhex(self.meta.get(k).ok_or("MISSING_META")?)?;
            if want != v {
                return Err(format!("ORDER_GOLDEN:{k}"));
            }
        }
        Ok(())
    }
    /// The Reveal's trailing path provinces for a quote ending at `dest`:
    /// `verify_route`'s first-entered provinces without the destination, each
    /// by the image name of a province this host holds.
    fn path_names(&self, quote: &Quote, dest: (i64, i64)) -> Result<Vec<String>, String> {
        let known = self.provinces()?;
        let mut out = Vec::with_capacity(PATH_PROVINCES_MAX);
        for &(p, q) in &quote.provinces {
            if (p, q) == dest {
                continue;
            }
            let k = known
                .iter()
                .find(|k| (k.province.coord.p(), k.province.coord.q()) == (p, q))
                .ok_or("ROUTE_UNREACHABLE")?;
            out.push(k.name.clone());
        }
        if out.len() > PATH_PROVINCES_MAX || !quote.provinces.contains(&dest) {
            return Err("ROUTE_UNREACHABLE".into());
        }
        Ok(out)
    }

    /// The recorded march's binding (`depart`): the fixture's directions,
    /// destination, tile, commit and root, its route re-walked by the host's
    /// quote (which must end on the recorded tile).
    pub(crate) fn recorded_binding(&self, departed_milli: u32) -> Result<MarchBinding, String> {
        let dirs = unhex(self.meta.get("directions").ok_or("MISSING_META")?)?;
        let quote = self.quote_route(&dirs)?;
        let dest = WideProvince::read(self.data("destination")?).map_err(|_| "DESTINATION")?;
        let (p, q) = (dest.coord.p(), dest.coord.q());
        let tile = u8::try_from(self.num("destination_tile")?).map_err(|_| "FIXTURE_TILE")?;
        if (
            self.meta_i64("destination_p")?,
            self.meta_i64("destination_q")?,
        ) != (p, q)
            || !quote.reachable
            || quote.end != Some((p, q, tile))
        {
            return Err("RECORDED_ROUTE".into());
        }
        let path = self.path_names(&quote, (p, q))?;
        Ok(MarchBinding {
            kind: MarchKind::Recorded,
            directions: dirs,
            dest_name: "destination".into(),
            dest_key: ProvinceKey::new(dest.world, dest.coord),
            dest_tile: tile,
            steps: quote.steps.iter().map(|s| (s.p, s.q, s.tile)).collect(),
            entered: quote.provinces.clone(),
            path,
            commit: self.bytes("commit")?,
            root: self.bytes("root")?,
            order: None,
            departed_milli,
            preparation: None,
            accounts: Vec::new(),
            trail: vec![ORDER_RECORDED, "REAL_DEPART"],
        })
    }

    /// `depart_route DIRS` while ready, all or nothing (module doc). On any
    /// refusal or fault `self` is untouched; on success it holds the departed
    /// chosen march, with the new instructions and receipts (Depart only).
    pub fn depart_route(&mut self, dirs: &[u8]) -> Result<(), String> {
        if self.phase != "ready" {
            return Err("BAD_PHASE".into());
        }
        if dirs.is_empty() || dirs.len() > MAX_ROUTE_DIRS {
            return Err("ROUTE_LEN".into());
        }
        if dirs.iter().any(|d| *d >= 6) {
            return Err("DIRECTION".into());
        }
        // 1. The quote, recomputed on the current province bytes.
        let quote = self.quote_route(dirs)?;
        let (p, q, tile) = match (quote.reachable, quote.end) {
            (true, Some(end)) => end,
            _ => return Err("ROUTE_UNREACHABLE".into()),
        };
        // 2. Its destination: a province opened in this session, without
        //    resolve history or entries.
        let known = self.provinces()?;
        let end = known
            .iter()
            .find(|k| (k.province.coord.p(), k.province.coord.q()) == (p, q))
            .ok_or("ROUTE_UNREACHABLE")?;
        if end.name == "origin" {
            return Err("ROUTE_DESTINATION_ORIGIN".into());
        }
        if end.source == SOURCE_FIXTURE {
            return Err("ROUTE_DESTINATION_FIXTURE".into());
        }
        let d = ds::destination(&self.images, p, q)
            .map_err(|_| "ROUTE_DESTINATION_UNSUPPORTED".to_string())?;
        let entries = rd_u8(self.data(&d.name)?, PV2::N_ENTRIES);
        if d.name != end.name
            || !d.name.starts_with(PROVINCE_PREFIX)
            || d.resolved_next != d.opened_bell
            || d.resolved_next == 0
            || d.resolved_next >= ARRIVE_BELL
            || entries != Some(0)
        {
            return Err("ROUTE_DESTINATION_UNSUPPORTED".into());
        }
        let path = self.path_names(&quote, (p, q))?;
        // 3. The order: the recorded one reproduced, then the chosen one.
        let binding = self.order_binding()?;
        self.recorded_order_golden(&binding)?;
        let order = om::build_order(
            &binding,
            &OrderRequest {
                dest: d.key,
                dest_tile: tile,
                directions: dirs,
                stance: 0,
                retreat_bps: 0,
                arrive_bell: ARRIVE_BELL,
            },
        )
        .map_err(|e| format!("ORDER_MATERIAL:{e:?}"))?;
        // 4. The real Depart on a staged copy.
        let mut next = self.clone();
        next.records.clear();
        next.instructions.clear();
        let host = next.host()?;
        let departed_milli = next.standing_milli()?;
        let tip = next.num("tip")?;
        next.invoke(
            "Depart",
            depart_metas(),
            order.depart(0, tip).to_bytes(),
            false,
        )?;
        let t = WideTransit::from_bytes(next.data("transit_0")?).map_err(|_| "DEPART_TRANSIT")?;
        if t.state != MarchState::Departed
            || t.host != host
            || t.seal_root != order.root
            || t.arrive_bell != ARRIVE_BELL
        {
            return Err("DEPART_MISMATCH".into());
        }
        next.phase = "departed";
        next.march = Some(MarchBinding {
            kind: MarchKind::Chosen,
            directions: dirs.to_vec(),
            dest_name: d.name.clone(),
            dest_key: d.key,
            dest_tile: tile,
            steps: quote.steps.iter().map(|s| (s.p, s.q, s.tile)).collect(),
            entered: quote.provinces.clone(),
            path,
            commit: order.commit,
            root: order.root,
            order: Some(order),
            departed_milli,
            preparation: None,
            accounts: Vec::new(),
            trail: vec![
                "RECORDED_ORDER_REPRODUCED",
                ORDER_REBUILT,
                "REAL_DEPART",
                "REVEAL_REHEARSED_ON_DROPPED_COPY",
            ],
        });
        // 5. The rehearsal: the real Reveal must accept this route now.
        rehearse(next.clone()).map_err(|e| format!("ROUTE_REHEARSAL_REFUSED:{e}"))?;
        *self = next;
        Ok(())
    }

    /// One chosen-march instruction over a bounded sub-map, judged by
    /// [`judge_march`]; its receipts and name are appended and the
    /// per-destination accounts it created or wrote are named in `m`.
    fn march_dispatch(&mut self, m: &mut MarchBinding, c: MarchCall<'_>) -> Result<(), String> {
        let host = self.host()?;
        let dest = m.dest_key;
        let call = SubMapCall {
            metas: c.metas,
            instruction: c.data,
            now: self.now,
            slot: self.slot(),
            allow_beacon_logs: c.receipt == Receipt::Beacon,
        };
        let (receipt, allowed) = (c.receipt, c.allowed);
        let out = ds::dispatch_sub_map(&mut self.images, c.permitted, &call, |b, a, recs| {
            judge_march(b, a, recs, receipt, allowed, host, dest)
        })
        .map_err(|e| format!("{e}:{}", c.name))?;
        for a in c.permitted {
            let touched = out.created.contains(&a.name) || out.changed.contains(&a.name);
            if touched && !m.accounts.iter().any(|(_, x)| *x == a.name) {
                m.accounts.push((a.role.clone(), a.name.clone()));
            }
        }
        if m.accounts.len() > MARCH_ACCOUNTS_MAX {
            return Err("MARCH_ACCOUNTS_BOUND".into());
        }
        self.records.extend(out.receipts);
        self.instructions.push(c.name.into());
        Ok(())
    }

    /// The real WideResolve of `bell` (20 to 23) at the chosen destination:
    /// THE anchor and cache of bell 20 (posted for real), or the synthetic
    /// non-arrival pair of bells 21 to 23 staged for this dispatch only; the
    /// cursor `bell → bell + 1`; the province's gated identity unchanged.
    fn chosen_resolve(&mut self, m: &mut MarchBinding, bell: u32) -> Result<(), String> {
        let (p, q) = m.dest_pq();
        let dest_name = m.dest_name.clone();
        let plan = ds::arrival_plan(&self.images, p, q)?;
        let (cache, anchor) = if bell == ARRIVE_BELL {
            (
                role(&plan, "arrival_cache")?,
                role(&plan, "arrival_anchor")?,
            )
        } else {
            (
                role(&plan, &format!("cache_{bell}"))?,
                role(&plan, &format!("anchor_{bell}"))?,
            )
        };
        if bell != ARRIVE_BELL {
            m.mark(if cache.temporary.is_some() {
                "PAIRS_21_23_SYNTHETIC_STAGED_PER_DISPATCH"
            } else {
                "PAIRS_21_23_EXISTING_IDENTICAL_RECORDS"
            })?;
        }
        let permitted = [
            role(&plan, "roster")?,
            cache,
            anchor,
            role(&plan, &format!("inputs_{bell}"))?,
            role(&plan, "day")?,
        ];
        let metas = [
            s("payer", true),
            r("season"),
            w(&dest_name),
            w(&permitted[0].name),
            r(&permitted[1].name),
            r(&permitted[2].name),
            w(&permitted[3].name),
            r(&permitted[4].name),
            r("system"),
        ];
        let mut allowed = vec![dest_name.as_str(), permitted[0].name.as_str()];
        if bell == ARRIVE_BELL {
            // the roster's creation is paid by the payer; the record resolved
            allowed.extend(["payer", permitted[3].name.as_str()]);
        }
        let pre = self.data(&dest_name)?.to_vec();
        let data = wix::Resolve {
            bell,
            beneficiary: BENEFICIARY,
        }
        .to_bytes();
        self.march_dispatch(
            m,
            MarchCall {
                name: "Resolve",
                metas: &metas,
                data: &data,
                permitted: &permitted,
                receipt: Receipt::Resolve(bell),
                allowed: &allowed,
            },
        )?;
        let post = self.data(&dest_name)?;
        if rd_u32(&pre, PV2::RESOLVED_NEXT) != Some(bell)
            || rd_u32(post, PV2::RESOLVED_NEXT) != bell.checked_add(1)
        {
            return Err("MARCH_CURSOR".into());
        }
        for (field, range) in &GATED {
            if pre.get(range.clone()) != post.get(range.clone()) {
                return Err(format!("MARCH_IDENTITY:{field}"));
            }
        }
        Ok(())
    }

    /// post_reveal of a chosen march (bell 21): the destination prepared
    /// through bell 19, the real PostAnchor of `(20, region)` over the
    /// published `sig_t`, then the real Reveal of the rebuilt order.
    pub(crate) fn chosen_post_reveal(&mut self) -> Result<(), String> {
        let mut m = self.chosen()?;
        let order = m.order.ok_or("MARCH_ORDER")?;
        let (p, q) = m.dest_pq();
        let dest_name = m.dest_name.clone();
        let host = self.host()?;
        let faction = self.faction()?;
        // 1. The preparation (synthetic non-arrival pairs, real WideResolve).
        self.now = GENESIS + 21 * 600 + 213;
        let (now, slot) = (self.now, self.slot());
        let before = self.images.clone();
        let prep = ds::prepare_destination(&mut self.images, p, q, now, slot)?;
        verify_chains(host, &before, &self.images, &prep.receipts)?;
        let span = prep
            .to_bell
            .checked_sub(prep.from_bell)
            .map(|n| n as usize + 1);
        if prep.name != dest_name
            || prep.resolved_next != ARRIVE_BELL
            || span != Some(prep.receipts.len())
        {
            return Err("MARCH_PREPARATION".into());
        }
        for (body, bell) in prep.receipts.iter().zip(prep.from_bell..) {
            let rec = ev::WideRecord::decode(body).map_err(|_| "MARCH_PREPARATION")?;
            if rec.kind != WideKind::Resolve
                || rec.bell != bell
                || rec.province() != Some(m.dest_key)
            {
                return Err("MARCH_PREPARATION".into());
            }
        }
        for body in &prep.receipts {
            self.records.push(body.clone());
            self.instructions.push("Resolve".into());
        }
        m.preparation = Some(Preparation {
            from_bell: prep.from_bell,
            to_bell: prep.to_bell,
            resolved_next: prep.resolved_next,
            score_next_bell: prep.score_next_bell,
            at: prep.now,
            resolves: prep.receipts.len(),
            region: prep.region,
            pairs_aliased: prep.pairs.iter().filter(|e| e.aliased).count(),
            provenance: prep.provenance,
        });
        m.mark("DESTINATION_PREPARED_THROUGH_BELL_19")?;
        // 2. THE anchor of (20, region), the published T(20) signature.
        let beacon = om::arrival_beacon(&self.meta).map_err(|e| format!("ARRIVAL_BEACON:{e:?}"))?;
        let plan = ds::arrival_plan(&self.images, p, q)?;
        let permitted = [role(&plan, "arrival_anchor")?, role(&plan, "archive")?];
        let metas = [
            s("payer", true),
            r("season"),
            w(&permitted[0].name),
            r(&permitted[1].name),
            r("ix_sysvar"),
            r("system"),
        ];
        let data = frontier_abi::ix::PostAnchor {
            region: prep.region,
            bell: ARRIVE_BELL,
            round: beacon.t_round,
            sig48: beacon.sig_t,
            hints: beacon.hints_t,
            beneficiary: BENEFICIARY,
        }
        .to_bytes();
        self.march_dispatch(
            &mut m,
            MarchCall {
                name: "PostAnchor",
                metas: &metas,
                data: &data,
                permitted: &permitted,
                receipt: Receipt::Beacon,
                allowed: &["payer", permitted[0].name.as_str()],
            },
        )?;
        m.mark("REAL_POSTANCHOR_PUBLIC_SIG_T20")?;
        // 3. The Reveal of the rebuilt order over the route's provinces.
        self.now = GENESIS + 21 * 600 + 300;
        let plan = ds::arrival_plan(&self.images, p, q)?;
        let mut permitted = vec![
            role(&plan, "arrival_anchor")?,
            role(&plan, "archive")?,
            role(&plan, "beacon_log")?,
            role(&plan, "inputs_20")?,
            role(&plan, "day")?,
        ];
        for i in 0..4 {
            permitted.push(role(&plan, &format!("slot_{faction}_{i}"))?);
        }
        m.mark(if permitted[2].temporary.is_some() {
            "BEACON_LOG_LOCAL_FIXTURE_STAGED_FOR_REVEAL"
        } else {
            "BEACON_LOG_EXISTING_RECORD"
        })?;
        let mut metas = vec![
            s("payer", true),
            r("season"),
            r("holding"),
            r("transit_0"),
            r(&permitted[0].name),
            r(&permitted[1].name),
            w(&permitted[2].name),
            r(&permitted[3].name),
            r(&dest_name),
            w(&permitted[4].name),
        ];
        for (i, a) in permitted[5..].iter().enumerate() {
            metas.push(if i == 0 { w(&a.name) } else { r(&a.name) });
        }
        metas.push(r("ix_sysvar"));
        metas.push(r("system"));
        for n in &m.path {
            metas.push(r(n));
        }
        let (plain, salt, ct_hash) = order.reveal_fields();
        let data = wix::Reveal {
            transit_slot: 0,
            target_i: 0,
            plain,
            salt,
            ct_hash,
            beneficiary: BENEFICIARY,
        }
        .to_bytes();
        let own_slot = permitted[5].name.clone();
        let day = permitted[4].name.clone();
        self.march_dispatch(
            &mut m,
            MarchCall {
                name: "Reveal",
                metas: &metas,
                data: &data,
                permitted: &permitted,
                receipt: Receipt::Kind(WideKind::Revealed),
                allowed: &["payer", day.as_str(), own_slot.as_str()],
            },
        )?;
        if !self
            .images
            .get(&own_slot)
            .is_some_and(|im| im.owner == PROGRAM && !im.data.is_empty())
        {
            return Err("REVEAL_SLOT".into());
        }
        m.mark("REAL_REVEAL")?;
        self.phase = "revealed";
        self.march = Some(m);
        Ok(())
    }

    /// resolve_arrival of a chosen march (bell 22): the real PostSeed of
    /// `(20, region)` over the published `sig_s`, the real Gather of the 24
    /// positions, the real arrival Resolve; the outcome judged from the
    /// gathered record as the handlers wrote it (no enemy is assumed).
    pub(crate) fn chosen_resolve_arrival(&mut self) -> Result<(), String> {
        let mut m = self.chosen()?;
        let (p, q) = m.dest_pq();
        let dest_name = m.dest_name.clone();
        let host = self.host()?;
        let faction = self.faction()?;
        self.now = GENESIS + 22 * 600 + 300;
        // 1. THE seed cache of (20, region), the published S(20, A).
        let beacon = om::arrival_beacon(&self.meta).map_err(|e| format!("ARRIVAL_BEACON:{e:?}"))?;
        let region = ds::destination(&self.images, p, q)?.region;
        let plan = ds::arrival_plan(&self.images, p, q)?;
        let permitted = [
            role(&plan, "arrival_anchor")?,
            role(&plan, "arrival_cache")?,
        ];
        let metas = [
            s("payer", true),
            r("season"),
            r(&permitted[0].name),
            w(&permitted[1].name),
            r("ix_sysvar"),
            r("system"),
        ];
        let data = frontier_abi::ix::PostSeed {
            region,
            bell: ARRIVE_BELL,
            nonce: 0,
            round: beacon.s_round,
            sig48: beacon.sig_s,
            hints: beacon.hints_s,
            beneficiary: BENEFICIARY,
        }
        .to_bytes();
        self.march_dispatch(
            &mut m,
            MarchCall {
                name: "PostSeed",
                metas: &metas,
                data: &data,
                permitted: &permitted,
                receipt: Receipt::Beacon,
                allowed: &["payer", permitted[1].name.as_str()],
            },
        )?;
        m.mark("REAL_POSTSEED_PUBLIC_SIG_S20")?;
        // 2. The Gather of every position (the 23 absent slots and the
        //    absent record staged for this dispatch only).
        let plan = ds::arrival_plan(&self.images, p, q)?;
        let mut permitted = vec![
            role(&plan, "arrival_anchor")?,
            role(&plan, "inputs_20")?,
            role(&plan, "day")?,
        ];
        let mut metas = vec![
            s("payer", true),
            r("season"),
            r(&dest_name),
            r(&permitted[0].name),
            w(&permitted[1].name),
            r(&permitted[2].name),
            r("ix_sysvar"),
            r("system"),
        ];
        for j in 0..wa::wide_clash_inputs::POSITIONS {
            let slot = role(&plan, &format!("slot_{}_{}", j / 4, j % 4))?;
            metas.push(r(&slot.name));
            metas.push(if j == wa::wide_clash_inputs::position(faction, 0) {
                w("transit_0")
            } else {
                r("system")
            });
            permitted.push(slot);
        }
        let inputs = permitted[1].name.clone();
        let data = wix::Gather {
            bell: ARRIVE_BELL,
            start: 0,
            n: 24,
        }
        .to_bytes();
        self.march_dispatch(
            &mut m,
            MarchCall {
                name: "Gather",
                metas: &metas,
                data: &data,
                permitted: &permitted,
                receipt: Receipt::Kind(WideKind::Gathered),
                allowed: &["payer", inputs.as_str(), "transit_0"],
            },
        )?;
        let ih = wa::WideClashInputsHdr::read(self.data(&inputs)?).map_err(|_| "GATHER_INPUTS")?;
        if ih.arrivals_mask != wa::wide_clash_inputs::ALL_GATHERED
            || ih.dest != m.dest_key
            || ih.bell != ARRIVE_BELL
        {
            return Err("GATHER_INPUTS".into());
        }
        m.mark("REAL_GATHER")?;
        // 3. The arrival Resolve of bell 20.
        self.chosen_resolve(&mut m, ARRIVE_BELL)?;
        m.mark("REAL_ARRIVAL_RESOLVE")?;
        // 4. The outcome, as the handlers wrote it.
        let ar = wa::WideArrival::read_at(
            self.data(&inputs)?,
            wa::wide_clash_inputs::position(faction, 0),
        )
        .map_err(|_| "ARRIVAL")?
        .ok_or("ARRIVAL")?;
        if ar.host != host {
            return Err("ARRIVAL".into());
        }
        if ar.fate != wa::wide_arrival::FATE_STAYS {
            return Err("ARRIVAL_FATE_UNSUPPORTED".into());
        }
        if !(1..=m.departed_milli).contains(&ar.troops_after) {
            return Err("ARRIVAL_OUTCOME".into());
        }
        self.arrival_survivors = Some(ar.troops_after);
        self.engagements = Ro(self.data(&dest_name)?)
            .u32(PV::RESOLVE_SUMMARY + frontier_abi::layout::province::summary::ENGAGEMENTS)
            .map_err(|_| "SUMMARY")?;
        self.phase = "resolved";
        self.march = Some(m);
        Ok(())
    }

    /// settle_transit of a chosen march (bell 23): the real SettleTransit
    /// with the rebuilt commit and seal; the camp's citizen listed exactly
    /// when the handler's own camp rule names this march.
    pub(crate) fn chosen_settle_transit(&mut self) -> Result<(), String> {
        let mut m = self.chosen()?;
        let order = m.order.ok_or("MARCH_ORDER")?;
        let (p, q) = m.dest_pq();
        let dest_name = m.dest_name.clone();
        let faction = self.faction()?;
        self.now = GENESIS + 23 * 600 + 300;
        let plan = ds::arrival_plan(&self.images, p, q)?;
        let permitted = [
            role(&plan, "inputs_20")?,
            role(&plan, &format!("slot_{faction}_0"))?,
            role(&plan, "arrival_anchor")?,
            role(&plan, "roster")?,
        ];
        // `camp_works` (`proc/wide.rs` settle_transit, I-56): the arrival
        // stays (checked at resolve_arrival) and the lowest position of the
        // resolved camp mask is this march's own.
        let ih = wa::WideClashInputsHdr::read(self.data(&permitted[0].name)?)
            .map_err(|_| "SETTLE_INPUTS")?;
        let camp = ih.camp_mask != 0
            && ih.camp_mask.trailing_zeros() as usize
                == wa::wide_clash_inputs::position(faction, 0);
        let mut metas = vec![
            s("payer", true),
            r("season"),
            w("holding"),
            w(&dest_name),
            w(&permitted[0].name),
            w(&permitted[1].name),
            w("origin"),
            r(&permitted[2].name),
            w("payer"),
            w("payer"),
            w("payer"),
            w("payer"),
            w("transit_0"),
            w("origin_roster"),
            r("system"),
            w(&permitted[3].name),
            w("payer"),
        ];
        let mut allowed = vec![
            "holding",
            dest_name.as_str(),
            permitted[0].name.as_str(),
            permitted[1].name.as_str(),
            "transit_0",
            "payer",
        ];
        if camp {
            metas.push(w("citizen"));
            allowed.push("citizen");
            m.mark("CAMP_CITIZEN_LISTED")?;
        }
        let data = wix::SettleTransit {
            transit_slot: 0,
            commit: order.commit,
            seal: order.seal,
            beneficiary: BENEFICIARY,
        }
        .to_bytes();
        self.march_dispatch(
            &mut m,
            MarchCall {
                name: "SettleTransit",
                metas: &metas,
                data: &data,
                permitted: &permitted,
                receipt: Receipt::Kind(WideKind::TransitSettled),
                allowed: &allowed,
            },
        )?;
        if !self.data("transit_0")?.is_empty()
            || Ro(self.data("holding")?)
                .u64(H::ESCROW)
                .map_err(|_| "HOLDING")?
                != 0
        {
            return Err("SETTLEMENT_MISMATCH".into());
        }
        m.mark("REAL_SETTLE_TRANSIT")?;
        self.phase = "settled";
        self.march = Some(m);
        Ok(())
    }

    /// dissolve_return of a chosen march, at the recorded flow's instants:
    /// Resolve 21 (bell 23), Dissolve, Resolve 22 (bell 24), Resolve 23 and
    /// Return (bell 25) into the same holding. The credit is judged against
    /// the reserve just before Return.
    pub(crate) fn chosen_dissolve_return(&mut self) -> Result<(), String> {
        let mut m = self.chosen()?;
        let (p, q) = m.dest_pq();
        let dest_name = m.dest_name.clone();
        let host = self.host()?;
        self.chosen_resolve(&mut m, ARRIVE_BELL + 1)?;
        let roster = role(&ds::arrival_plan(&self.images, p, q)?, "roster")?.name;
        let mut metas = vec![
            s("actor", false),
            s("payer", true),
            r("season"),
            w("citizen"),
            w("holding"),
            w(&dest_name),
            r(&roster),
            r("origin"),
        ];
        for i in 0..4 {
            metas.push(r(&format!("transit_{i}")));
        }
        let data = wix::Dissolve {
            host: host.to_bytes(),
        }
        .to_bytes();
        self.march_dispatch(
            &mut m,
            MarchCall {
                name: "Dissolve",
                metas: &metas,
                data: &data,
                permitted: &[],
                receipt: Receipt::Kind(WideKind::Dissolve),
                allowed: &["citizen", "holding", dest_name.as_str()],
            },
        )?;
        m.mark("REAL_DISSOLVE")?;
        self.now = GENESIS + 24 * 600 + 60;
        self.chosen_resolve(&mut m, ARRIVE_BELL + 2)?;
        self.now = GENESIS + FINAL_BELL as i64 * 600 + 60;
        self.chosen_resolve(&mut m, ARRIVE_BELL + 3)?;
        let left = self.standing_milli()?;
        let old = Ro(self.data("holding")?)
            .u32(H::reserve(0))
            .map_err(|_| "HOLDING")?;
        let mut metas = vec![
            s("payer", true),
            r("season"),
            w(&dest_name),
            w(&roster),
            w("holding"),
        ];
        for i in 0..4 {
            metas.push(r(&format!("transit_{i}")));
        }
        metas.push(r("origin"));
        let data = wix::Return.to_bytes();
        self.march_dispatch(
            &mut m,
            MarchCall {
                name: "Return",
                metas: &metas,
                data: &data,
                permitted: &[],
                receipt: Receipt::Kind(WideKind::Return),
                allowed: &[dest_name.as_str(), roster.as_str(), "holding"],
            },
        )?;
        let new = Ro(self.data("holding")?)
            .u32(H::reserve(0))
            .map_err(|_| "HOLDING")?;
        if !(1..=m.departed_milli).contains(&left) || Some(new) != old.checked_add(left / 1000) {
            return Err("RETURN_MISMATCH".into());
        }
        m.mark("REAL_RETURN")?;
        self.credited = left / 1000;
        self.phase = "returned";
        self.march = Some(m);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::INITIAL;
    use crate::runtime::Image;

    const LONG: [u8; 12] = [2; 12];

    fn opened() -> Sandbox {
        let mut c = Sandbox::new().unwrap();
        c.open_province(129, -2).unwrap();
        c
    }

    /// The departure refusals of the engine, each before any dispatch, each
    /// leaving the sandbox exactly as it was.
    #[test]
    fn chosen_march_depart_route_refusals_leave_the_sandbox_untouched() {
        let mut c = Sandbox::new().unwrap();
        let pre = c.clone();
        let same = |a: &Sandbox, b: &Sandbox| {
            a.images == b.images
                && a.phase == b.phase
                && a.now == b.now
                && a.march == b.march
                && a.records == b.records
        };
        // unknown land before any opening
        assert_eq!(c.depart_route(&LONG).unwrap_err(), "ROUTE_UNREACHABLE");
        // the origin and the exported fixture destination
        assert_eq!(
            c.depart_route(&[2]).unwrap_err(),
            "ROUTE_DESTINATION_ORIGIN"
        );
        assert_eq!(
            c.depart_route(&[2, 2, 2]).unwrap_err(),
            "ROUTE_DESTINATION_FIXTURE"
        );
        // bounds and directions (the protocol refuses these first)
        assert_eq!(c.depart_route(&[]).unwrap_err(), "ROUTE_LEN");
        assert_eq!(c.depart_route(&[2; 33]).unwrap_err(), "ROUTE_LEN");
        assert_eq!(c.depart_route(&[2, 6]).unwrap_err(), "DIRECTION");
        assert!(same(&c, &pre));
        // after the recorded departure the phase is not ready
        let mut d = opened();
        d.apply("depart").unwrap();
        let pre = d.clone();
        assert_eq!(d.depart_route(&LONG).unwrap_err(), "BAD_PHASE");
        assert!(same(&d, &pre));
    }

    /// A chosen departure: the real Depart of the rebuilt order (its seal
    /// root in the transit record), a binding distinct from the recorded one,
    /// the map's recorded destination untouched, the clock not moved.
    #[test]
    fn chosen_march_depart_route_binds_the_rebuilt_order_and_keeps_the_map() {
        let mut c = opened();
        let pre = c.clone();
        c.depart_route(&LONG).expect("depart_route");
        assert_eq!(c.phase, "departed");
        assert_eq!(c.now, INITIAL, "a departure never moves the clock");
        assert_eq!(c.instructions, vec!["Depart".to_string()]);
        assert_eq!(c.records.len(), 1, "the Depart receipt only");
        let m = c.march.clone().unwrap();
        assert_eq!(m.kind, MarchKind::Chosen);
        assert_eq!(m.dest_name, "land_province_129_-2");
        assert_eq!(m.dest_pq(), (129, -2));
        assert_eq!(m.directions, LONG.to_vec());
        assert_eq!(
            m.path,
            vec!["origin".to_string(), "destination".to_string()]
        );
        // not the recorded order
        let recorded = unhex(&c.meta["commit"]).unwrap();
        assert_ne!(m.commit.to_vec(), recorded);
        let order = m.order.unwrap();
        assert_eq!(order.seal[..128], unhex(&c.meta["seal"]).unwrap()[..128]);
        let t = WideTransit::from_bytes(c.data("transit_0").unwrap()).unwrap();
        assert_eq!(t.seal_root, m.root);
        // only the Depart's accounts changed; the destination is untouched
        for n in ["destination", "destination_roster", "land_province_129_-2"] {
            assert_eq!(c.images[n], pre.images[n], "{n}");
        }
        assert_eq!(c.images.len(), pre.images.len());
        // the quote stays a read
        let before = c.images.clone();
        let _ = c.quote_route(&LONG).unwrap();
        assert_eq!(c.images, before);
    }

    /// A real refusal inside the rehearsal (a program-owned record at the
    /// destination's ArrivalDay key, which the real resolves and Reveal read)
    /// refuses the departure itself: no Depart is kept.
    #[test]
    fn chosen_march_rehearsal_refusal_commits_no_departure() {
        let mut c = opened();
        let d = ds::destination(&c.images, 129, -2).unwrap();
        let ctx = frontier_abi::addr::AddrCtx {
            season: c.images["season"].key,
            program: PROGRAM,
        };
        c.images.insert(
            "intruder_day".into(),
            Image {
                key: wa::arrival_day_address(&ctx, d.key, wa::day_of(ARRIVE_BELL)),
                owner: PROGRAM,
                lamports: 1,
                data: vec![1; 8],
            },
        );
        let pre = c.clone();
        let e = c.depart_route(&LONG).unwrap_err();
        assert!(e.starts_with("ROUTE_REHEARSAL_REFUSED:"), "{e}");
        assert!(e.contains("Refused_"), "a handler refusal: {e}");
        assert_eq!(c.images, pre.images);
        assert_eq!((c.phase, c.march.is_none()), ("ready", true));
    }

    /// The judge over hand-made maps: a beacon step with a receipt, a step
    /// without its receipt, a receipt of another kind, an unlisted write, a
    /// removed image and a chain moved on an opened province are refused.
    #[test]
    fn chosen_march_judge_refuses_forged_stages() {
        let mut c = opened();
        c.depart_route(&LONG).unwrap();
        let host = c.host().unwrap();
        let dest = c.march.as_ref().unwrap().dest_key;
        let depart = c.records[0].clone();
        let base = c.images.clone();
        let ok = judge_march(&base, &base, &[], Receipt::Beacon, &[], host, dest);
        assert_eq!(ok, Ok(()));
        assert_eq!(
            judge_march(
                &base,
                &base,
                &[depart.clone()],
                Receipt::Beacon,
                &[],
                host,
                dest
            ),
            Err("MARCH_BEACON_RECEIPT".into())
        );
        assert_eq!(
            judge_march(
                &base,
                &base,
                &[],
                Receipt::Kind(WideKind::Revealed),
                &[],
                host,
                dest
            ),
            Err("MARCH_RECEIPT_COUNT".into())
        );
        assert!(judge_march(
            &base,
            &base,
            &[depart],
            Receipt::Kind(WideKind::Revealed),
            &[],
            host,
            dest
        )
        .unwrap_err()
        .starts_with("MARCH_RECEIPT:"));
        let mut foreign = base.clone();
        foreign.get_mut("destination").unwrap().data[200] ^= 1;
        assert_eq!(
            judge_march(&base, &foreign, &[], Receipt::Beacon, &[], host, dest),
            Err("MARCH_FOREIGN_WRITE:destination".into())
        );
        let mut removed = base.clone();
        removed.remove("archive");
        assert_eq!(
            judge_march(&base, &removed, &[], Receipt::Beacon, &[], host, dest),
            Err("MARCH_NAME_SET".into())
        );
        // a moved chain on an opened province, even where writes are allowed
        let mut chain = base.clone();
        let seq = frontier_abi::layout::header::EVENT_SEQ;
        chain.get_mut("land_province_129_-2").unwrap().data[seq] ^= 1;
        assert_eq!(
            judge_march(
                &base,
                &chain,
                &[],
                Receipt::Beacon,
                &["land_province_129_-2"],
                host,
                dest
            ),
            Err("CHAIN_MISMATCH".into())
        );
        assert_eq!(
            verify_chains(host, &base, &chain, &[]),
            Err("CHAIN_MISMATCH".into())
        );
    }

    /// The default names of the per-destination accounts never look like an
    /// opened province (the v4 naming fix in `destination_stage`).
    #[test]
    fn chosen_march_planned_names_never_alias_the_province_prefix() {
        let c = opened();
        let plan = ds::arrival_plan(&c.images, 129, -2).unwrap();
        for a in &plan {
            if a.temporary.is_some() {
                assert!(a.name.starts_with(ds::ACCOUNT_PREFIX), "{}", a.name);
                assert!(!a.name.starts_with(PROVINCE_PREFIX), "{}", a.name);
            }
        }
    }
}
