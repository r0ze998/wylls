//! MC herald formats (conquest contract v1.1 §8.4, unit CQ1-D): encoders
//! and validating decoders for
//!
//! | format | path | here |
//! |---|---|---|
//! | `PSFCT1`, the faction map | `/h/control/{bell}.bin` | [`ControlFile`] |
//! | WS `control` delta | `kind:"control"` messages | [`encode_control_delta`], [`decode_control_delta`], [`control_delta`] |
//! | `PSFOV2`, the overview v2 | `/h/overview2/{ring}/{bell}.bin` | [`Overview2File`] |
//! | `PSFSD1`, the standings series | `/h/standings/series.bin` | [`StandingsSeries`] |
//! | the active sieges and keep contests | `/h/sieges/{latest,bell}.json` | [`SiegesFile`] |
//! | the day's conquest events | `/h/conquest/{day}.json` | [`ConquestDay`] |
//!
//! The JS decoders are `permutation-server/web/frontier/herald.mjs`
//! (`decodeControl`, `decodeControlDelta`, `decodeOverviewV2`,
//! `decodeStandings`, `parseSieges`, `parseConquestDay`, `marchOrder`).
//! Both sides read the shared vectors in `frontier-node/fixtures/cq/formats/`
//! (one producer: [`vectors::files`]; freshness: `cq_formats_vectors_fresh`;
//! `FRONTIER_WRITE_FIXTURES=1 cargo test -p herald cq_formats_vectors_fresh`
//! rewrites them) and must refuse every invalid vector with the same code.
//!
//! **Format clarifications pinned here** (the contract leaves them open;
//! CQ1-D-NOTES lists them for the integrator as CF-1…CF-8):
//!
//! - **CF-1** `PSFCT1` `n_prov` = `provinces_within(R)`: whole rings
//!   0..=R, R ≤ 127 the highest ring the season has opened; a province not
//!   yet opened inside those rings has control 7. Readers derive R.
//! - **CF-2** The March section lists **every March with at least one member
//!   in rings 0..=R**, sorted by the dense index of its centre province
//!   (`march_members(m)[0]`, which may lie in ring R + 1). `n_march` must be
//!   that count, so a reader attaches (m, n) by position ([`march_order`]).
//! - **CF-3** Reserved header bytes are 0; province flags bit 128 and March
//!   flags bits 32–128 are 0. Value ranges are checked (see [`ControlFile`]).
//! - **CF-4** `PSFOV2` uses the `PSFOV1` header layout (season u64 · ring
//!   u16 · n u16 · bell u32 · slot u64); the per-site bit fields are
//!   little-endian with site i at bits 3i (occupier) or 2i (siege, kind) of
//!   their byte run, as `PSFOV1`'s owners and states; keep tile 0xFF = none
//!   (rings 0–1); byte 39's high nibble is 0.
//! - **CF-5** `PSFSD1`'s field list sums to 30 B; the record stays 32 B and
//!   its reserved tail is **6 B** (offsets 26..32, not "u32"). Factions in
//!   order 0..=5; header reserved 8 B are 0; the cumulative fields never
//!   decrease from one hour to the next.
//! - **CF-6** The WS `control` delta is n × 10 B `index u16 · record 8 B`,
//!   1 ≤ n ≤ 64, strictly increasing index; more than 64 changes (or a
//!   different province or March count) is a resync hint, not a delta.
//! - **CF-7** JSON: a citizen tag is the 16 lowercase hex characters of the
//!   tag's 8 bytes (the first 8 bytes of the Citizen address, as the roster
//!   file's u64 LE); a Free City's `owner` is `null` with `ownerFaction` 6;
//!   `pauseReason` is `null` exactly when `status` is `progressing`; sieges
//!   sorted by (p, q, site), keeps by (p, q), events by `seq` (stable); a
//!   March is `{"m":…,"n":…}`; `seq` is a decimal u64 string. Unknown fields
//!   are ignored by readers; writers emit §8.4's fields in §8.4's order.
//! - **CF-8** Conquest events: which of `p`, `q`, `site`, `march` an event
//!   carries depends on its kind ([`EventKind::shape`]); `from` and `to` are
//!   0–7 or `null`; `bell` lies in the file's day.

use std::collections::BTreeSet;

use permutation_rules::frontier::geometry::{
    march_members, march_of, provinces_within, MarchCoord, ProvinceCoord,
};
use serde_json::Value;

use crate::overview::OVERVIEW_HEADER;
use crate::OVERVIEW_RECORD;

// ------------------------------------------------------------------ errors

/// A refused file. `code` is shared with the JS decoders (`HeraldError.code`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FormatError {
    pub code: &'static str,
    pub detail: String,
}

pub const BAD_MAGIC: &str = "BadMagic";
pub const BAD_LENGTH: &str = "BadLength";
pub const BAD_RESERVED: &str = "BadReserved";
pub const BAD_SHAPE: &str = "BadShape";
pub const BAD_VALUE: &str = "BadValue";
pub const BAD_ORDER: &str = "BadOrder";
pub const NOT_CUMULATIVE: &str = "NotCumulative";
pub const TOO_MANY: &str = "TooMany";
pub const BAD_JSON: &str = "BadJson";
pub const BAD_SCHEMA: &str = "BadSchema";

fn err<T>(code: &'static str, detail: impl Into<String>) -> Result<T, FormatError> {
    Err(FormatError {
        code,
        detail: detail.into(),
    })
}

fn ensure(
    cond: bool,
    code: &'static str,
    detail: impl FnOnce() -> String,
) -> Result<(), FormatError> {
    if cond {
        Ok(())
    } else {
        err(code, detail())
    }
}

impl std::fmt::Display for FormatError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.detail)
    }
}

impl std::error::Error for FormatError {}

fn u16_at(b: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([b[o], b[o + 1]])
}
fn i16_at(b: &[u8], o: usize) -> i16 {
    i16::from_le_bytes([b[o], b[o + 1]])
}
fn u32_at(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}
fn u64_at(b: &[u8], o: usize) -> u64 {
    let mut a = [0u8; 8];
    a.copy_from_slice(&b[o..o + 8]);
    u64::from_le_bytes(a)
}

// ------------------------------------------------------------------ geometry of the control layer

/// The highest ring a control file may cover (CF-1: the March centres of
/// rings ≤ 127 stay within ring 128, where the dense index is defined).
pub const CONTROL_MAX_RING: u32 = 127;

/// R with `provinces_within(R) == n_prov`, if `n_prov` is whole rings.
pub fn rings_of(n_prov: u32) -> Option<u32> {
    (0..=CONTROL_MAX_RING).find(|&d| provinces_within(d) == n_prov)
}

/// The Marches of a control file covering rings 0..=`rings`, in file order
/// (CF-2): every March with a member in those rings, by centre index.
pub fn march_order(rings: u32) -> Vec<MarchCoord> {
    let mut set = BTreeSet::new();
    for i in 0..provinces_within(rings.min(CONTROL_MAX_RING)) {
        let m = march_of(ProvinceCoord::from_index(i));
        set.insert((march_members(m)[0].index(), m.m, m.n));
    }
    set.into_iter()
        .map(|(_, m, n)| MarchCoord { m, n })
        .collect()
}

// ------------------------------------------------------------------ PSFCT1

/// `magic "PSFCT1\0\0"`.
pub const CONTROL_MAGIC: &[u8; 8] = b"PSFCT1\0\0";
pub const CONTROL_HEADER: usize = 32;
pub const CONTROL_PROVINCE: usize = 8;
pub const CONTROL_MARCH: usize = 4;

/// Province `control`: 0–5 keep holder (a Seat: its faction), 6 neutral
/// (the Concord), 7 unopened. Also "none" in `contender`, `points_lead`
/// and a March's `banner` / `points_lead`.
///
/// The kernel's codes (`control::CODE_*`, `ProvinceControl::code`,
/// `Banner::code`), not copies (integ-W1, review CQ1-D; M1 §3.3).
pub const CONTROL_NEUTRAL: u8 = permutation_rules::frontier::control::CODE_NEUTRAL;
pub const CONTROL_NONE: u8 = permutation_rules::frontier::control::CODE_UNOPENED;
const _: () = assert!(permutation_rules::frontier::control::CODE_NO_BANNER == CONTROL_NONE);

/// Province flags (§8.4).
pub mod pflag {
    pub const CHANGED: u8 = 1;
    pub const CONSOLIDATING: u8 = 2;
    pub const HEARTLAND: u8 = 4;
    pub const SEAT: u8 = 8;
    pub const TAKEN: u8 = 16;
    pub const BROKEN: u8 = 32;
    pub const CLASH: u8 = 64;
    pub const RESERVED: u8 = 128;
}

/// March flags (§8.4).
pub mod mflag {
    pub const BANNER_CHANGED: u8 = 1;
    pub const DOMINION_CHANGED: u8 = 2;
    pub const CALL_TARGET: u8 = 4;
    /// M3; always 0 in MC (not refused by the decoder).
    pub const TRUCE: u8 = 8;
    /// M3; always 0 in MC (not refused by the decoder).
    pub const HOSTILITY: u8 = 16;
    pub const RESERVED: u8 = 0xE0;
}

/// One province's 8-byte record.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ControlProvince {
    pub control: u8,
    pub contender: u8,
    pub progress: u8,
    pub required: u8,
    pub flags: u8,
    /// Active holding sieges (saturating at 15).
    pub sieges: u8,
    /// Occupations (saturating at 15).
    pub occupations: u8,
    /// The side leading the province's strength weight (0–6; 7 none).
    /// Points only, never a map colour (R-15).
    pub points_lead: u8,
    /// That side's share × 255.
    pub points_share: u8,
}

impl ControlProvince {
    /// The nibble counts from raw counts (saturating at 15).
    pub fn with_counts(mut self, sieges: u32, occupations: u32) -> Self {
        self.sieges = sieges.min(15) as u8;
        self.occupations = occupations.min(15) as u8;
        self
    }

    pub fn encode(&self) -> [u8; CONTROL_PROVINCE] {
        [
            self.control,
            self.contender,
            self.progress,
            self.required,
            self.flags,
            (self.sieges & 15) | (self.occupations << 4),
            self.points_lead,
            self.points_share,
        ]
    }

    pub fn decode(r: &[u8]) -> Self {
        Self {
            control: r[0],
            contender: r[1],
            progress: r[2],
            required: r[3],
            flags: r[4],
            sieges: r[5] & 15,
            occupations: r[5] >> 4,
            points_lead: r[6],
            points_share: r[7],
        }
    }

    /// The record's own rules, at dense index `index` (ring from geometry).
    pub fn check(&self, index: u32) -> Result<(), FormatError> {
        let at = || format!("province {index}");
        ensure(self.flags & pflag::RESERVED == 0, BAD_RESERVED, || {
            format!("{}: flags bit 128", at())
        })?;
        ensure(
            self.sieges <= 15 && self.occupations <= 15,
            BAD_VALUE,
            || format!("{}: holdings nibble", at()),
        )?;
        ensure(self.control <= CONTROL_NONE, BAD_VALUE, || {
            format!("{}: control {}", at(), self.control)
        })?;
        ensure(
            (self.control == CONTROL_NEUTRAL) == (index == 0),
            BAD_VALUE,
            || format!("{}: control 6 is the Concord's alone", at()),
        )?;
        let ring = ProvinceCoord::checked_from_index(index)
            .ok_or_else(|| FormatError {
                code: BAD_VALUE,
                detail: format!("{}: index beyond ring 128", at()),
            })?
            .ring();
        ensure(
            (self.flags & pflag::SEAT != 0) == (ring <= 1),
            BAD_VALUE,
            || format!("{}: the seat flag marks rings 0–1 exactly", at()),
        )?;
        ensure(
            self.flags & pflag::HEARTLAND == 0 || ring >= 2,
            BAD_VALUE,
            || format!("{}: heartland in rings 0–1", at()),
        )?;
        ensure(
            self.contender <= 5 || self.contender == CONTROL_NONE,
            BAD_VALUE,
            || format!("{}: contender {}", at(), self.contender),
        )?;
        ensure(self.progress <= self.required, BAD_VALUE, || {
            format!(
                "{}: progress {} > required {}",
                at(),
                self.progress,
                self.required
            )
        })?;
        if self.contender == CONTROL_NONE {
            ensure(self.progress == 0, BAD_VALUE, || {
                format!("{}: progress without a contender", at())
            })?;
        } else {
            ensure(self.contender != self.control, BAD_VALUE, || {
                format!("{}: the holder contends its own keep", at())
            })?;
            ensure(self.progress >= 1, BAD_VALUE, || {
                format!("{}: a contender with progress 0", at())
            })?;
        }
        ensure(self.points_lead <= CONTROL_NONE, BAD_VALUE, || {
            format!("{}: points_lead {}", at(), self.points_lead)
        })
    }
}

/// One March's 4-byte record.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ControlMarch {
    /// 0–5, or 7 contested / none (keep majority, §3.3). The only March colour.
    pub banner: u8,
    /// Dominion lead at the last fold (0–6; 7 contested / none). Standings only.
    pub points_lead: u8,
    /// Keeps held by the banner faction (or the largest holder), ≤ 7.
    pub keeps: u8,
    pub flags: u8,
}

impl ControlMarch {
    pub fn encode(&self) -> [u8; CONTROL_MARCH] {
        [self.banner, self.points_lead, self.keeps, self.flags]
    }

    pub fn decode(r: &[u8]) -> Self {
        Self {
            banner: r[0],
            points_lead: r[1],
            keeps: r[2],
            flags: r[3],
        }
    }

    pub fn check(&self, i: usize) -> Result<(), FormatError> {
        ensure(self.flags & mflag::RESERVED == 0, BAD_RESERVED, || {
            format!("march {i}: flags bits 32-128")
        })?;
        ensure(
            self.banner <= 5 || self.banner == CONTROL_NONE,
            BAD_VALUE,
            || format!("march {i}: banner {}", self.banner),
        )?;
        ensure(self.points_lead <= CONTROL_NONE, BAD_VALUE, || {
            format!("march {i}: points_lead {}", self.points_lead)
        })?;
        ensure(self.keeps <= 7, BAD_VALUE, || {
            format!("march {i}: keeps {}", self.keeps)
        })
    }
}

/// A whole `PSFCT1` file: header 32 B (magic · season u64 · bell u32 ·
/// n_prov u16 · n_march u16 · reserved u64), `n_prov` × 8 B in dense
/// province order, `n_march` × 4 B in [`march_order`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ControlFile {
    pub season: u64,
    pub bell: u32,
    pub provinces: Vec<ControlProvince>,
    pub marches: Vec<ControlMarch>,
}

impl ControlFile {
    /// The rings the file covers (CF-1), if its province count is valid.
    pub fn rings(&self) -> Option<u32> {
        rings_of(u32::try_from(self.provinces.len()).ok()?)
    }

    fn check_shape(n_prov: usize, n_march: usize) -> Result<u32, FormatError> {
        let rings = u32::try_from(n_prov)
            .ok()
            .and_then(rings_of)
            .ok_or_else(|| FormatError {
                code: BAD_SHAPE,
                detail: format!("n_prov {n_prov} is not whole rings 0..=R (R ≤ 127)"),
            })?;
        let want = march_order(rings).len();
        ensure(n_march == want, BAD_SHAPE, || {
            format!("n_march {n_march}, rings 0..={rings} have {want} Marches")
        })?;
        Ok(rings)
    }

    /// The file's bytes; refuses a file the decoder would refuse.
    pub fn encode(&self) -> Result<Vec<u8>, FormatError> {
        Self::check_shape(self.provinces.len(), self.marches.len())?;
        for (i, p) in self.provinces.iter().enumerate() {
            p.check(i as u32)?;
        }
        for (i, m) in self.marches.iter().enumerate() {
            m.check(i)?;
        }
        let mut out = Vec::with_capacity(
            CONTROL_HEADER
                + self.provinces.len() * CONTROL_PROVINCE
                + self.marches.len() * CONTROL_MARCH,
        );
        out.extend_from_slice(CONTROL_MAGIC);
        out.extend_from_slice(&self.season.to_le_bytes());
        out.extend_from_slice(&self.bell.to_le_bytes());
        out.extend_from_slice(&(self.provinces.len() as u16).to_le_bytes());
        out.extend_from_slice(&(self.marches.len() as u16).to_le_bytes());
        out.extend_from_slice(&[0u8; 8]);
        for p in &self.provinces {
            out.extend_from_slice(&p.encode());
        }
        for m in &self.marches {
            out.extend_from_slice(&m.encode());
        }
        Ok(out)
    }

    /// Checks, in order (the JS decoder's order): header length, magic,
    /// reserved, shape (CF-1, CF-2), length, each province, each March.
    pub fn decode(b: &[u8]) -> Result<Self, FormatError> {
        ensure(b.len() >= CONTROL_HEADER, BAD_LENGTH, || {
            "short header".into()
        })?;
        ensure(&b[..8] == CONTROL_MAGIC, BAD_MAGIC, || "magic".into())?;
        ensure(b[24..32].iter().all(|&x| x == 0), BAD_RESERVED, || {
            "header reserved".into()
        })?;
        let (n_prov, n_march) = (u16_at(b, 20) as usize, u16_at(b, 22) as usize);
        Self::check_shape(n_prov, n_march)?;
        let want = CONTROL_HEADER + n_prov * CONTROL_PROVINCE + n_march * CONTROL_MARCH;
        ensure(b.len() == want, BAD_LENGTH, || {
            format!("{} B, want {want}", b.len())
        })?;
        let mut provinces = Vec::with_capacity(n_prov);
        for i in 0..n_prov {
            let o = CONTROL_HEADER + i * CONTROL_PROVINCE;
            let p = ControlProvince::decode(&b[o..o + CONTROL_PROVINCE]);
            p.check(i as u32)?;
            provinces.push(p);
        }
        let mut marches = Vec::with_capacity(n_march);
        let base = CONTROL_HEADER + n_prov * CONTROL_PROVINCE;
        for i in 0..n_march {
            let o = base + i * CONTROL_MARCH;
            let m = ControlMarch::decode(&b[o..o + CONTROL_MARCH]);
            m.check(i)?;
            marches.push(m);
        }
        Ok(Self {
            season: u64_at(b, 8),
            bell: u32_at(b, 16),
            provinces,
            marches,
        })
    }
}

// ------------------------------------------------------------------ WS control delta (CF-6)

pub const CONTROL_DELTA_ENTRY: usize = 2 + CONTROL_PROVINCE;
pub const CONTROL_DELTA_MAX: usize = 64;

/// `[index u16, record 8 B]…`, strictly increasing index, 1..=64 entries.
pub fn encode_control_delta(changes: &[(u16, ControlProvince)]) -> Result<Vec<u8>, FormatError> {
    ensure(!changes.is_empty(), BAD_LENGTH, || "an empty delta".into())?;
    ensure(changes.len() <= CONTROL_DELTA_MAX, TOO_MANY, || {
        format!("{} changes > 64: send a resync hint", changes.len())
    })?;
    let mut out = Vec::with_capacity(changes.len() * CONTROL_DELTA_ENTRY);
    let mut last: Option<u16> = None;
    for (i, p) in changes {
        ensure(last.is_none_or(|l| *i > l), BAD_ORDER, || {
            format!("index {i} after {last:?}")
        })?;
        p.check(u32::from(*i))?;
        last = Some(*i);
        out.extend_from_slice(&i.to_le_bytes());
        out.extend_from_slice(&p.encode());
    }
    Ok(out)
}

/// The inverse of [`encode_control_delta`]; checks length, count, each
/// record, then order.
pub fn decode_control_delta(b: &[u8]) -> Result<Vec<(u16, ControlProvince)>, FormatError> {
    ensure(
        !b.is_empty() && b.len().is_multiple_of(CONTROL_DELTA_ENTRY),
        BAD_LENGTH,
        || format!("{} B is not n × 10", b.len()),
    )?;
    let n = b.len() / CONTROL_DELTA_ENTRY;
    ensure(n <= CONTROL_DELTA_MAX, TOO_MANY, || {
        format!("{n} entries > 64")
    })?;
    let mut out: Vec<(u16, ControlProvince)> = Vec::with_capacity(n);
    for k in 0..n {
        let o = k * CONTROL_DELTA_ENTRY;
        let i = u16_at(b, o);
        let p = ControlProvince::decode(&b[o + 2..o + CONTROL_DELTA_ENTRY]);
        p.check(u32::from(i))?;
        out.push((i, p));
    }
    for w in out.windows(2) {
        ensure(w[0].0 < w[1].0, BAD_ORDER, || {
            format!("index {} after {}", w[1].0, w[0].0)
        })?;
    }
    Ok(out)
}

/// The WS delta from `prev` to `cur`: `None` = send a resync hint (the
/// shape changed, nothing changed is `Some(vec![])`, or > 64 changes).
pub fn control_delta(prev: &ControlFile, cur: &ControlFile) -> Option<Vec<(u16, ControlProvince)>> {
    if prev.provinces.len() != cur.provinces.len() || prev.marches.len() != cur.marches.len() {
        return None;
    }
    let v: Vec<(u16, ControlProvince)> = cur
        .provinces
        .iter()
        .zip(&prev.provinces)
        .enumerate()
        .filter(|(_, (a, b))| a != b)
        .map(|(i, (a, _))| (i as u16, *a))
        .collect();
    (v.len() <= CONTROL_DELTA_MAX).then_some(v)
}

// ------------------------------------------------------------------ PSFOV2

/// `magic "PSFOV2\0\0"`; the header is `PSFOV1`'s (CF-4).
pub const OVERVIEW2_MAGIC: &[u8; 8] = b"PSFOV2\0\0";
pub const OVERVIEW2_RECORD: usize = 40;

/// Occupier "none" (bytes 24–28).
pub const OCCUPIER_NONE: u8 = 7;
/// Siege state per site (bytes 29–31).
pub const SIEGE_NONE: u8 = 0;
pub const SIEGE_PROGRESSING: u8 = 1;
pub const SIEGE_PAUSED_VIGIL: u8 = 2;
pub const SIEGE_CAPTURE_DUE: u8 = 3;
/// Site kind (bytes 32–34).
pub const KIND_FIRST: u8 = 0;
pub const KIND_HOLDING: u8 = 1;
pub const KIND_FREE_CITY: u8 = 2;
pub const KIND_RESERVED_OR_FREE: u8 = 3;
/// Keep tile "none" (rings 0–1).
pub const KEEP_TILE_NONE: u8 = 0xFF;

/// One province's 40-byte record: the exact `PSFOV1` record, then MC's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Overview2Record {
    /// Bytes 0–23: exactly `overview::record` (owners are titles).
    pub v1: [u8; OVERVIEW_RECORD],
    /// 0–5 the occupier's faction, 7 none.
    pub occupier: [u8; 12],
    pub siege: [u8; 12],
    pub kind: [u8; 12],
    /// 0–60, or [`KEEP_TILE_NONE`].
    pub keep_tile: u8,
    pub keep_troops: u16,
    /// Bit i: site i immune (`immune_until > bell`); 12 bits.
    pub immune: u16,
}

impl Overview2Record {
    /// A record carrying only the v1 part (no occupier, siege, keep).
    pub fn from_v1(v1: [u8; OVERVIEW_RECORD]) -> Self {
        Self {
            v1,
            occupier: [OCCUPIER_NONE; 12],
            siege: [SIEGE_NONE; 12],
            kind: [KIND_RESERVED_OR_FREE; 12],
            keep_tile: KEEP_TILE_NONE,
            keep_troops: 0,
            immune: 0,
        }
    }

    pub fn p(&self) -> i16 {
        i16_at(&self.v1, 0)
    }
    pub fn q(&self) -> i16 {
        i16_at(&self.v1, 2)
    }

    /// Keep troops saturating at u16.
    pub fn keep_troops_sat(troops: u32) -> u16 {
        troops.min(u16::MAX as u32) as u16
    }

    pub fn encode(&self) -> [u8; OVERVIEW2_RECORD] {
        let mut r = [0u8; OVERVIEW2_RECORD];
        r[..OVERVIEW_RECORD].copy_from_slice(&self.v1);
        let (mut occ, mut sg, mut kd) = (0u64, 0u32, 0u32);
        for i in 0..12 {
            occ |= (self.occupier[i] as u64 & 7) << (3 * i);
            sg |= (self.siege[i] as u32 & 3) << (2 * i);
            kd |= (self.kind[i] as u32 & 3) << (2 * i);
        }
        r[24..29].copy_from_slice(&occ.to_le_bytes()[..5]);
        r[29..32].copy_from_slice(&sg.to_le_bytes()[..3]);
        r[32..35].copy_from_slice(&kd.to_le_bytes()[..3]);
        r[35] = self.keep_tile;
        r[36..38].copy_from_slice(&self.keep_troops.to_le_bytes());
        r[38] = self.immune as u8;
        r[39] = ((self.immune >> 8) & 15) as u8;
        r
    }

    pub fn decode(r: &[u8], i: usize) -> Result<Self, FormatError> {
        let mut v1 = [0u8; OVERVIEW_RECORD];
        v1.copy_from_slice(&r[..OVERVIEW_RECORD]);
        let mut occ = [0u8; 8];
        occ[..5].copy_from_slice(&r[24..29]);
        let occ = u64::from_le_bytes(occ);
        let sg = u32::from_le_bytes([r[29], r[30], r[31], 0]);
        let kd = u32::from_le_bytes([r[32], r[33], r[34], 0]);
        ensure(occ >> 36 == 0 && r[39] >> 4 == 0, BAD_RESERVED, || {
            format!("record {i}: reserved bits")
        })?;
        let mut out = Self {
            v1,
            occupier: [0; 12],
            siege: [0; 12],
            kind: [0; 12],
            keep_tile: r[35],
            keep_troops: u16_at(r, 36),
            immune: r[38] as u16 | ((r[39] as u16 & 15) << 8),
        };
        for s in 0..12 {
            out.occupier[s] = ((occ >> (3 * s)) & 7) as u8;
            out.siege[s] = ((sg >> (2 * s)) & 3) as u8;
            out.kind[s] = ((kd >> (2 * s)) & 3) as u8;
        }
        out.check(i)?;
        Ok(out)
    }

    pub fn check(&self, i: usize) -> Result<(), FormatError> {
        ensure(self.immune >> 12 == 0, BAD_RESERVED, || {
            format!("record {i}: immune bits 12-15")
        })?;
        for s in 0..12 {
            ensure(
                self.occupier[s] <= 5 || self.occupier[s] == OCCUPIER_NONE,
                BAD_VALUE,
                || format!("record {i}: site {s} occupier {}", self.occupier[s]),
            )?;
            ensure(self.siege[s] <= 3 && self.kind[s] <= 3, BAD_VALUE, || {
                format!("record {i}: site {s} siege/kind")
            })?;
        }
        ensure(
            (self.keep_tile as usize) < permutation_rules::frontier::geometry::PROVINCE_TILES
                || self.keep_tile == KEEP_TILE_NONE,
            BAD_VALUE,
            || format!("record {i}: keep tile {}", self.keep_tile),
        )?;
        ensure(
            self.keep_tile != KEEP_TILE_NONE || self.keep_troops == 0,
            BAD_VALUE,
            || format!("record {i}: keep troops without a keep"),
        )
    }
}

/// A whole `PSFOV2` file (records sorted by (P, Q), strictly).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Overview2File {
    pub season: u64,
    pub ring: u16,
    pub bell: u32,
    pub slot: u64,
    pub records: Vec<Overview2Record>,
}

impl Overview2File {
    fn check_order(records: &[Overview2Record]) -> Result<(), FormatError> {
        for (i, w) in records.windows(2).enumerate() {
            ensure(
                (w[0].p(), w[0].q()) < (w[1].p(), w[1].q()),
                BAD_ORDER,
                || format!("record {} not after record {i} in (P, Q)", i + 1),
            )?;
        }
        Ok(())
    }

    pub fn encode(&self) -> Result<Vec<u8>, FormatError> {
        ensure(self.records.len() <= u16::MAX as usize, TOO_MANY, || {
            "more than 65,535 records".into()
        })?;
        for (i, r) in self.records.iter().enumerate() {
            r.check(i)?;
        }
        Self::check_order(&self.records)?;
        let mut out = Vec::with_capacity(OVERVIEW_HEADER + self.records.len() * OVERVIEW2_RECORD);
        let mut h = crate::overview_header(
            self.season,
            self.ring,
            self.records.len() as u16,
            self.bell,
            self.slot,
        );
        h[..8].copy_from_slice(OVERVIEW2_MAGIC);
        out.extend_from_slice(&h);
        for r in &self.records {
            out.extend_from_slice(&r.encode());
        }
        Ok(out)
    }

    /// Checks: header length, magic, length, each record, order.
    pub fn decode(b: &[u8]) -> Result<Self, FormatError> {
        ensure(b.len() >= OVERVIEW_HEADER, BAD_LENGTH, || {
            "short header".into()
        })?;
        ensure(&b[..8] == OVERVIEW2_MAGIC, BAD_MAGIC, || "magic".into())?;
        let n = u16_at(b, 18) as usize;
        let want = OVERVIEW_HEADER + n * OVERVIEW2_RECORD;
        ensure(b.len() == want, BAD_LENGTH, || {
            format!("{} B, want {want}", b.len())
        })?;
        let mut records = Vec::with_capacity(n);
        for i in 0..n {
            let o = OVERVIEW_HEADER + i * OVERVIEW2_RECORD;
            records.push(Overview2Record::decode(&b[o..o + OVERVIEW2_RECORD], i)?);
        }
        Self::check_order(&records)?;
        Ok(Self {
            season: u64_at(b, 8),
            ring: u16_at(b, 16),
            bell: u32_at(b, 20),
            slot: u64_at(b, 24),
            records,
        })
    }
}

// ------------------------------------------------------------------ PSFSD1

/// `magic "PSFSD1\0\0"`.
pub const STANDINGS_MAGIC: &[u8; 8] = b"PSFSD1\0\0";
pub const STANDINGS_HEADER: usize = 32;
pub const STANDINGS_FACTION: usize = 32;
pub const STANDINGS_HOUR: usize = 6 * STANDINGS_FACTION;

/// One faction's figures for one hour (CF-5 offsets in brackets).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FactionHour {
    /// [0] provinces by keep control.
    pub provinces: u16,
    /// [2] March banners.
    pub banners: u16,
    /// [4] cumulative.
    pub keeps_taken: u16,
    /// [6] cumulative.
    pub keeps_lost: u16,
    /// [8] cumulative, from folds.
    pub dominion_bells: u32,
    /// [12] cumulative, credited captures.
    pub captures: u16,
    /// [14]
    pub occupations_active: u16,
    /// [16] cumulative.
    pub sieges_won: u16,
    /// [18] cumulative.
    pub sieges_lost: u16,
    /// [20] cumulative.
    pub liberations: u16,
    /// [22]
    pub holdings: u16,
    /// [24]
    pub members_active: u16,
    // [26..32] reserved 0
}

impl FactionHour {
    pub fn encode(&self) -> [u8; STANDINGS_FACTION] {
        let mut r = [0u8; STANDINGS_FACTION];
        let u16s = [
            (0, self.provinces),
            (2, self.banners),
            (4, self.keeps_taken),
            (6, self.keeps_lost),
            (12, self.captures),
            (14, self.occupations_active),
            (16, self.sieges_won),
            (18, self.sieges_lost),
            (20, self.liberations),
            (22, self.holdings),
            (24, self.members_active),
        ];
        for (o, v) in u16s {
            r[o..o + 2].copy_from_slice(&v.to_le_bytes());
        }
        r[8..12].copy_from_slice(&self.dominion_bells.to_le_bytes());
        r
    }

    pub fn decode(r: &[u8]) -> Result<Self, FormatError> {
        ensure(r[26..32].iter().all(|&x| x == 0), BAD_RESERVED, || {
            "record reserved tail".into()
        })?;
        Ok(Self {
            provinces: u16_at(r, 0),
            banners: u16_at(r, 2),
            keeps_taken: u16_at(r, 4),
            keeps_lost: u16_at(r, 6),
            dominion_bells: u32_at(r, 8),
            captures: u16_at(r, 12),
            occupations_active: u16_at(r, 14),
            sieges_won: u16_at(r, 16),
            sieges_lost: u16_at(r, 18),
            liberations: u16_at(r, 20),
            holdings: u16_at(r, 22),
            members_active: u16_at(r, 24),
        })
    }

    fn cumulative(&self) -> [u32; 7] {
        [
            self.keeps_taken as u32,
            self.keeps_lost as u32,
            self.dominion_bells,
            self.captures as u32,
            self.sieges_won as u32,
            self.sieges_lost as u32,
            self.liberations as u32,
        ]
    }
}

/// The standings series: header 32 B (magic · season u64 · first_hour u32
/// · n u32 · reserved 8), then `n` hours × 6 factions × 32 B.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StandingsSeries {
    pub season: u64,
    pub first_hour: u32,
    pub hours: Vec<[FactionHour; 6]>,
}

impl StandingsSeries {
    fn check_cumulative(hours: &[[FactionHour; 6]]) -> Result<(), FormatError> {
        for (h, w) in hours.windows(2).enumerate() {
            for (f, (x0, x1)) in w[0].iter().zip(&w[1]).enumerate() {
                let (a, b) = (x0.cumulative(), x1.cumulative());
                ensure(
                    a.iter().zip(&b).all(|(x, y)| y >= x),
                    NOT_CUMULATIVE,
                    || format!("hour index {}: faction {f} went down", h + 1),
                )?;
            }
        }
        Ok(())
    }

    pub fn encode(&self) -> Result<Vec<u8>, FormatError> {
        Self::check_cumulative(&self.hours)?;
        let mut out = Vec::with_capacity(STANDINGS_HEADER + self.hours.len() * STANDINGS_HOUR);
        out.extend_from_slice(STANDINGS_MAGIC);
        out.extend_from_slice(&self.season.to_le_bytes());
        out.extend_from_slice(&self.first_hour.to_le_bytes());
        out.extend_from_slice(&(self.hours.len() as u32).to_le_bytes());
        out.extend_from_slice(&[0u8; 8]);
        for h in &self.hours {
            for f in h {
                out.extend_from_slice(&f.encode());
            }
        }
        Ok(out)
    }

    /// Checks: header length, magic, reserved, length, each record, the
    /// cumulative fields.
    pub fn decode(b: &[u8]) -> Result<Self, FormatError> {
        ensure(b.len() >= STANDINGS_HEADER, BAD_LENGTH, || {
            "short header".into()
        })?;
        ensure(&b[..8] == STANDINGS_MAGIC, BAD_MAGIC, || "magic".into())?;
        ensure(b[24..32].iter().all(|&x| x == 0), BAD_RESERVED, || {
            "header reserved".into()
        })?;
        let n = u32_at(b, 20) as usize;
        let want = n
            .checked_mul(STANDINGS_HOUR)
            .and_then(|x| x.checked_add(STANDINGS_HEADER));
        ensure(want == Some(b.len()), BAD_LENGTH, || {
            format!("{} B for {n} hours", b.len())
        })?;
        let mut hours = Vec::with_capacity(n);
        for h in 0..n {
            let mut row = [FactionHour::default(); 6];
            for (f, slot) in row.iter_mut().enumerate() {
                let o = STANDINGS_HEADER + h * STANDINGS_HOUR + f * STANDINGS_FACTION;
                *slot = FactionHour::decode(&b[o..o + STANDINGS_FACTION])?;
            }
            hours.push(row);
        }
        Self::check_cumulative(&hours)?;
        Ok(Self {
            season: u64_at(b, 8),
            first_hour: u32_at(b, 16),
            hours,
        })
    }
}

// ------------------------------------------------------------------ JSON helpers

/// A JSON string literal (serde_json's escaping).
fn js(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

/// A citizen tag in JSON (CF-7): the tag's 8 bytes (u64 LE) as hex.
pub fn tag_hex(tag: u64) -> String {
    hex::encode(tag.to_le_bytes())
}

/// The inverse of [`tag_hex`].
pub fn parse_tag(s: &str) -> Option<u64> {
    if s.len() != 16
        || !s
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return None;
    }
    let mut a = [0u8; 8];
    hex::decode_to_slice(s, &mut a).ok()?;
    Some(u64::from_le_bytes(a))
}

fn opt<T: ToString>(v: &Option<T>) -> String {
    v.as_ref().map_or_else(|| "null".into(), |x| x.to_string())
}

fn field<'a>(
    o: &'a serde_json::Map<String, Value>,
    k: &str,
    at: &str,
) -> Result<&'a Value, FormatError> {
    o.get(k).ok_or_else(|| FormatError {
        code: BAD_SCHEMA,
        detail: format!("{at}: missing {k}"),
    })
}

fn obj<'a>(v: &'a Value, at: &str) -> Result<&'a serde_json::Map<String, Value>, FormatError> {
    v.as_object().ok_or_else(|| FormatError {
        code: BAD_SCHEMA,
        detail: format!("{at}: not an object"),
    })
}

fn arr<'a>(
    o: &'a serde_json::Map<String, Value>,
    k: &str,
    at: &str,
) -> Result<&'a Vec<Value>, FormatError> {
    field(o, k, at)?.as_array().ok_or_else(|| FormatError {
        code: BAD_SCHEMA,
        detail: format!("{at}: {k} is not an array"),
    })
}

/// An integer field (refuses floats and non-numbers with BadSchema), then
/// the range `lo..=hi` (BadValue).
fn int(
    o: &serde_json::Map<String, Value>,
    k: &str,
    lo: i64,
    hi: i64,
    at: &str,
) -> Result<i64, FormatError> {
    let v = field(o, k, at)?;
    let n = v.as_i64().ok_or_else(|| FormatError {
        code: BAD_SCHEMA,
        detail: format!("{at}: {k} is not an integer"),
    })?;
    ensure((lo..=hi).contains(&n), BAD_VALUE, || {
        format!("{at}: {k} {n} outside {lo}..={hi}")
    })?;
    Ok(n)
}

fn opt_int(
    o: &serde_json::Map<String, Value>,
    k: &str,
    lo: i64,
    hi: i64,
    at: &str,
) -> Result<Option<i64>, FormatError> {
    if field(o, k, at)?.is_null() {
        Ok(None)
    } else {
        int(o, k, lo, hi, at).map(Some)
    }
}

fn string<'a>(
    o: &'a serde_json::Map<String, Value>,
    k: &str,
    at: &str,
) -> Result<&'a str, FormatError> {
    field(o, k, at)?.as_str().ok_or_else(|| FormatError {
        code: BAD_SCHEMA,
        detail: format!("{at}: {k} is not a string"),
    })
}

fn tag(o: &serde_json::Map<String, Value>, k: &str, at: &str) -> Result<u64, FormatError> {
    let s = string(o, k, at)?;
    parse_tag(s).ok_or_else(|| FormatError {
        code: BAD_VALUE,
        detail: format!("{at}: {k} {s:?} is not 16 lowercase hex characters"),
    })
}

fn version(o: &serde_json::Map<String, Value>) -> Result<(), FormatError> {
    let v = field(o, "v", "file")?.as_i64().ok_or_else(|| FormatError {
        code: BAD_SCHEMA,
        detail: "v is not an integer".into(),
    })?;
    ensure(v == 1, BAD_VALUE, || format!("v {v}"))
}

fn parse_json(b: &[u8]) -> Result<Value, FormatError> {
    serde_json::from_slice(b).map_err(|e| FormatError {
        code: BAD_JSON,
        detail: e.to_string(),
    })
}

/// Province coordinates in JSON: within ring 128.
const COORD: i64 = 128;

// ------------------------------------------------------------------ /h/sieges/{latest,bell}.json

/// A siege target's kind (`"first" | "other" | "free"`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SiegeKind {
    First,
    Other,
    Free,
}

impl SiegeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::First => "first",
            Self::Other => "other",
            Self::Free => "free",
        }
    }
    fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "first" => Self::First,
            "other" => Self::Other,
            "free" => Self::Free,
            _ => return None,
        })
    }
}

/// Why a siege did not count this bell (`null` while progressing).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PauseReason {
    Vigil,
    Defender,
}

impl PauseReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Vigil => "vigil",
            Self::Defender => "defender",
        }
    }
}

/// One active holding siege.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SiegeEntry {
    pub p: i32,
    pub q: i32,
    pub site: u8,
    pub kind: SiegeKind,
    /// `None` for a Free City (CF-7).
    pub owner: Option<u64>,
    /// 0–5; 6 for a Free City.
    pub owner_faction: u8,
    pub attacker: u64,
    pub attacker_faction: u8,
    pub declared: u32,
    pub required: u8,
    pub progress: u8,
    /// `None` = progressing.
    pub pause: Option<PauseReason>,
    pub eta_bell: u32,
}

impl SiegeEntry {
    /// `sg:P,Q,site,declared`.
    pub fn key(&self) -> String {
        format!("sg:{},{},{},{}", self.p, self.q, self.site, self.declared)
    }

    fn check(&self, bell: u32, at: &str) -> Result<(), FormatError> {
        ensure(self.site < 12, BAD_VALUE, || format!("{at}: site"))?;
        let free = self.kind == SiegeKind::Free;
        ensure(free == self.owner.is_none(), BAD_VALUE, || {
            format!("{at}: owner is null exactly for a Free City")
        })?;
        ensure(
            free == (self.owner_faction == CONTROL_NEUTRAL),
            BAD_VALUE,
            || format!("{at}: ownerFaction 6 exactly for a Free City"),
        )?;
        ensure(
            self.owner_faction <= 6 && self.attacker_faction <= 5,
            BAD_VALUE,
            || format!("{at}: faction"),
        )?;
        ensure(
            self.attacker_faction != self.owner_faction,
            BAD_VALUE,
            || format!("{at}: a faction besieging its own holding"),
        )?;
        ensure((1..=60).contains(&self.required), BAD_VALUE, || {
            format!("{at}: required {}", self.required)
        })?;
        ensure(self.progress < self.required, BAD_VALUE, || {
            format!("{at}: progress {} of {}", self.progress, self.required)
        })?;
        ensure(self.declared <= bell, BAD_VALUE, || {
            format!("{at}: declared after the file's bell")
        })?;
        ensure(self.eta_bell > self.declared, BAD_VALUE, || {
            format!("{at}: etaBell not after declared")
        })
    }

    fn to_json(&self) -> String {
        let (status, reason) = match self.pause {
            None => ("progressing", "null".to_string()),
            Some(r) => ("paused", js(r.as_str())),
        };
        format!(
            "{{\"key\":{},\"p\":{},\"q\":{},\"site\":{},\"kind\":{},\"owner\":{},\"ownerFaction\":{},\"attacker\":{},\"attackerFaction\":{},\"declared\":{},\"required\":{},\"progress\":{},\"status\":{},\"pauseReason\":{},\"etaBell\":{}}}",
            js(&self.key()),
            self.p,
            self.q,
            self.site,
            js(self.kind.as_str()),
            self.owner.map_or_else(|| "null".into(), |t| js(&tag_hex(t))),
            self.owner_faction,
            js(&tag_hex(self.attacker)),
            self.attacker_faction,
            self.declared,
            self.required,
            self.progress,
            js(status),
            reason,
            self.eta_bell,
        )
    }

    fn from_json(v: &Value, bell: u32, at: &str) -> Result<Self, FormatError> {
        let o = obj(v, at)?;
        let key = string(o, "key", at)?.to_string();
        let kind_s = string(o, "kind", at)?;
        let status = string(o, "status", at)?;
        let reason = field(o, "pauseReason", at)?;
        let owner = field(o, "owner", at)?;
        let owner = if owner.is_null() {
            None
        } else {
            Some(tag(o, "owner", at)?)
        };
        let pause = match (status, reason) {
            ("progressing", Value::Null) => None,
            ("paused", Value::String(r)) if r == "vigil" => Some(PauseReason::Vigil),
            ("paused", Value::String(r)) if r == "defender" => Some(PauseReason::Defender),
            ("progressing" | "paused", Value::Null | Value::String(_)) => {
                return err(
                    BAD_VALUE,
                    format!("{at}: status {status} with pauseReason {reason}"),
                )
            }
            ("progressing" | "paused", _) => {
                return err(
                    BAD_SCHEMA,
                    format!("{at}: pauseReason is not a string or null"),
                )
            }
            _ => return err(BAD_VALUE, format!("{at}: status {status:?}")),
        };
        let s = Self {
            p: int(o, "p", -COORD, COORD, at)? as i32,
            q: int(o, "q", -COORD, COORD, at)? as i32,
            site: int(o, "site", 0, 255, at)? as u8,
            kind: SiegeKind::parse(kind_s).ok_or_else(|| FormatError {
                code: BAD_VALUE,
                detail: format!("{at}: kind {kind_s:?}"),
            })?,
            owner,
            owner_faction: int(o, "ownerFaction", 0, 255, at)? as u8,
            attacker: tag(o, "attacker", at)?,
            attacker_faction: int(o, "attackerFaction", 0, 255, at)? as u8,
            declared: int(o, "declared", 0, u32::MAX as i64, at)? as u32,
            required: int(o, "required", 0, 255, at)? as u8,
            progress: int(o, "progress", 0, 255, at)? as u8,
            pause,
            eta_bell: int(o, "etaBell", 0, u32::MAX as i64, at)? as u32,
        };
        ensure(key == s.key(), BAD_VALUE, || {
            format!("{at}: key {key:?} is not {:?}", s.key())
        })?;
        s.check(bell, at)?;
        Ok(s)
    }
}

/// One running keep contest.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeepContest {
    pub p: i32,
    pub q: i32,
    pub holder: u8,
    pub contender: u8,
    pub progress: u8,
    pub required: u8,
    /// `contest_from_bell` (the first counted bell).
    pub since: u32,
    pub eta_bell: u32,
}

impl KeepContest {
    fn check(&self, bell: u32, at: &str) -> Result<(), FormatError> {
        ensure(self.holder <= 5 && self.contender <= 5, BAD_VALUE, || {
            format!("{at}: faction")
        })?;
        ensure(self.holder != self.contender, BAD_VALUE, || {
            format!("{at}: the holder contends its own keep")
        })?;
        ensure(
            self.required >= 1 && (1..self.required).contains(&self.progress),
            BAD_VALUE,
            || format!("{at}: progress {} of {}", self.progress, self.required),
        )?;
        ensure(self.since <= bell, BAD_VALUE, || {
            format!("{at}: since after the file's bell")
        })?;
        ensure(self.eta_bell >= self.since, BAD_VALUE, || {
            format!("{at}: etaBell before since")
        })
    }

    fn to_json(&self) -> String {
        format!(
            "{{\"p\":{},\"q\":{},\"holder\":{},\"contender\":{},\"progress\":{},\"required\":{},\"since\":{},\"etaBell\":{}}}",
            self.p, self.q, self.holder, self.contender, self.progress, self.required, self.since, self.eta_bell
        )
    }

    fn from_json(v: &Value, bell: u32, at: &str) -> Result<Self, FormatError> {
        let o = obj(v, at)?;
        let k = Self {
            p: int(o, "p", -COORD, COORD, at)? as i32,
            q: int(o, "q", -COORD, COORD, at)? as i32,
            holder: int(o, "holder", 0, 255, at)? as u8,
            contender: int(o, "contender", 0, 255, at)? as u8,
            progress: int(o, "progress", 0, 255, at)? as u8,
            required: int(o, "required", 0, 255, at)? as u8,
            since: int(o, "since", 0, u32::MAX as i64, at)? as u32,
            eta_bell: int(o, "etaBell", 0, u32::MAX as i64, at)? as u32,
        };
        k.check(bell, at)?;
        Ok(k)
    }
}

/// `/h/sieges/latest.json` and `/h/sieges/{bell}.json` (`v` 1).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SiegesFile {
    pub bell: u32,
    pub sieges: Vec<SiegeEntry>,
    pub keeps: Vec<KeepContest>,
}

impl SiegesFile {
    fn check_order(&self) -> Result<(), FormatError> {
        for (i, w) in self.sieges.windows(2).enumerate() {
            ensure(
                (w[0].p, w[0].q, w[0].site) < (w[1].p, w[1].q, w[1].site),
                BAD_ORDER,
                || format!("sieges[{}] not after sieges[{i}] in (p, q, site)", i + 1),
            )?;
        }
        for (i, w) in self.keeps.windows(2).enumerate() {
            ensure((w[0].p, w[0].q) < (w[1].p, w[1].q), BAD_ORDER, || {
                format!("keeps[{}] not after keeps[{i}] in (p, q)", i + 1)
            })?;
        }
        Ok(())
    }

    /// The canonical bytes (compact, §8.4's field order); refuses a file the
    /// reader would refuse.
    pub fn to_json(&self) -> Result<String, FormatError> {
        for (i, s) in self.sieges.iter().enumerate() {
            s.check(self.bell, &format!("sieges[{i}]"))?;
        }
        for (i, k) in self.keeps.iter().enumerate() {
            k.check(self.bell, &format!("keeps[{i}]"))?;
        }
        self.check_order()?;
        let sieges: Vec<String> = self.sieges.iter().map(SiegeEntry::to_json).collect();
        let keeps: Vec<String> = self.keeps.iter().map(KeepContest::to_json).collect();
        Ok(format!(
            "{{\"v\":1,\"bell\":{},\"sieges\":[{}],\"keeps\":[{}]}}",
            self.bell,
            sieges.join(","),
            keeps.join(",")
        ))
    }

    /// Checks: JSON, `v`, each siege, each keep, order.
    pub fn parse(b: &[u8]) -> Result<Self, FormatError> {
        let v = parse_json(b)?;
        let o = obj(&v, "file")?;
        version(o)?;
        let bell = int(o, "bell", 0, u32::MAX as i64, "file")? as u32;
        let sieges = arr(o, "sieges", "file")?
            .iter()
            .enumerate()
            .map(|(i, s)| SiegeEntry::from_json(s, bell, &format!("sieges[{i}]")))
            .collect::<Result<Vec<_>, _>>()?;
        let keeps = arr(o, "keeps", "file")?
            .iter()
            .enumerate()
            .map(|(i, k)| KeepContest::from_json(k, bell, &format!("keeps[{i}]")))
            .collect::<Result<Vec<_>, _>>()?;
        let f = Self {
            bell,
            sieges,
            keeps,
        };
        f.check_order()?;
        Ok(f)
    }
}

// ------------------------------------------------------------------ /h/conquest/{day}.json

/// Bells per game day (the kernel's `travel::BELLS_PER_DAY`).
pub const BELLS_PER_DAY: u32 = permutation_rules::frontier::travel::BELLS_PER_DAY;

/// The event kinds of §8.4.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum EventKind {
    SiegeDeclared,
    SiegeFailed,
    Occupied,
    Liberated,
    OccupationExpired,
    CaptureDue,
    Captured,
    KeepContest,
    KeepBroken,
    KeepTaken,
    ProvinceControl,
    MarchBanner,
    MarchPointsLead,
    FreeCity,
    Outpost,
    Retired,
}

/// Which location fields an event carries (CF-8).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EventShape {
    /// `p`, `q`, `site` set; `march` null.
    Site,
    /// `p`, `q` set; `site`, `march` null.
    Province,
    /// `p`, `q` set; `site` optional; `march` null.
    ProvinceMaybeSite,
    /// `march` set; `p`, `q`, `site` null.
    March,
}

impl EventKind {
    pub const ALL: [EventKind; 16] = [
        Self::SiegeDeclared,
        Self::SiegeFailed,
        Self::Occupied,
        Self::Liberated,
        Self::OccupationExpired,
        Self::CaptureDue,
        Self::Captured,
        Self::KeepContest,
        Self::KeepBroken,
        Self::KeepTaken,
        Self::ProvinceControl,
        Self::MarchBanner,
        Self::MarchPointsLead,
        Self::FreeCity,
        Self::Outpost,
        Self::Retired,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::SiegeDeclared => "siege_declared",
            Self::SiegeFailed => "siege_failed",
            Self::Occupied => "occupied",
            Self::Liberated => "liberated",
            Self::OccupationExpired => "occupation_expired",
            Self::CaptureDue => "capture_due",
            Self::Captured => "captured",
            Self::KeepContest => "keep_contest",
            Self::KeepBroken => "keep_broken",
            Self::KeepTaken => "keep_taken",
            Self::ProvinceControl => "province_control",
            Self::MarchBanner => "march_banner",
            Self::MarchPointsLead => "march_points_lead",
            Self::FreeCity => "free_city",
            Self::Outpost => "outpost",
            Self::Retired => "retired",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|k| k.as_str() == s)
    }

    pub fn shape(self) -> EventShape {
        match self {
            Self::KeepContest | Self::KeepBroken | Self::KeepTaken | Self::ProvinceControl => {
                EventShape::Province
            }
            Self::MarchBanner | Self::MarchPointsLead => EventShape::March,
            Self::Retired => EventShape::ProvinceMaybeSite,
            _ => EventShape::Site,
        }
    }
}

/// One conquest event.
#[derive(Clone, Debug, PartialEq)]
pub struct ConquestEvent {
    pub seq: u64,
    pub bell: u32,
    /// The PS2 record's transaction signature (base58).
    pub sig: String,
    pub kind: EventKind,
    pub p: Option<i32>,
    pub q: Option<i32>,
    pub site: Option<u8>,
    pub march: Option<MarchCoord>,
    pub from: Option<u8>,
    pub to: Option<u8>,
    pub citizens: Vec<u64>,
    /// A JSON object (free-form per kind).
    pub detail: Value,
}

const B58: &str = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

impl ConquestEvent {
    fn check(&self, day: u32, at: &str) -> Result<(), FormatError> {
        let lo = day.saturating_mul(BELLS_PER_DAY);
        ensure(
            self.bell >= lo && self.bell - lo < BELLS_PER_DAY,
            BAD_VALUE,
            || format!("{at}: bell {} is not in day {day}", self.bell),
        )?;
        ensure(
            (1..=90).contains(&self.sig.len()) && self.sig.chars().all(|c| B58.contains(c)),
            BAD_VALUE,
            || format!("{at}: sig is not base58"),
        )?;
        let (pq, site, march) = (self.p.is_some() && self.q.is_some(), self.site, self.march);
        let none = self.p.is_none() && self.q.is_none();
        let ok = match self.kind.shape() {
            EventShape::Site => pq && site.is_some() && march.is_none(),
            EventShape::Province => pq && site.is_none() && march.is_none(),
            EventShape::ProvinceMaybeSite => pq && march.is_none(),
            EventShape::March => none && site.is_none() && march.is_some(),
        };
        ensure(ok, BAD_VALUE, || {
            format!(
                "{at}: p/q/site/march do not fit kind {}",
                self.kind.as_str()
            )
        })?;
        ensure(site.is_none_or(|s| s < 12), BAD_VALUE, || {
            format!("{at}: site")
        })?;
        ensure(
            self.from.is_none_or(|f| f <= 7) && self.to.is_none_or(|t| t <= 7),
            BAD_VALUE,
            || format!("{at}: from/to"),
        )?;
        ensure(self.detail.is_object(), BAD_SCHEMA, || {
            format!("{at}: detail is not an object")
        })
    }

    fn to_json(&self) -> String {
        let march = self.march.map_or_else(
            || "null".into(),
            |m| format!("{{\"m\":{},\"n\":{}}}", m.m, m.n),
        );
        let citizens: Vec<String> = self.citizens.iter().map(|t| js(&tag_hex(*t))).collect();
        format!(
            "{{\"seq\":{},\"bell\":{},\"sig\":{},\"kind\":{},\"p\":{},\"q\":{},\"site\":{},\"march\":{},\"from\":{},\"to\":{},\"citizens\":[{}],\"detail\":{}}}",
            js(&self.seq.to_string()),
            self.bell,
            js(&self.sig),
            js(self.kind.as_str()),
            opt(&self.p),
            opt(&self.q),
            opt(&self.site),
            march,
            opt(&self.from),
            opt(&self.to),
            citizens.join(","),
            serde_json::to_string(&self.detail).unwrap_or_else(|_| "{}".into()),
        )
    }

    fn from_json(v: &Value, day: u32, at: &str) -> Result<Self, FormatError> {
        let o = obj(v, at)?;
        let seq_s = string(o, "seq", at)?;
        let seq = (!seq_s.is_empty()
            && seq_s.bytes().all(|c| c.is_ascii_digit())
            && (seq_s == "0" || !seq_s.starts_with('0')))
        .then(|| seq_s.parse::<u64>().ok())
        .flatten()
        .ok_or_else(|| FormatError {
            code: BAD_VALUE,
            detail: format!("{at}: seq {seq_s:?} is not a decimal u64"),
        })?;
        let kind_s = string(o, "kind", at)?;
        let march = match field(o, "march", at)? {
            Value::Null => None,
            m => {
                let mo = obj(m, &format!("{at}.march"))?;
                Some(MarchCoord {
                    m: int(mo, "m", -COORD, COORD, at)? as i32,
                    n: int(mo, "n", -COORD, COORD, at)? as i32,
                })
            }
        };
        let citizens = arr(o, "citizens", at)?
            .iter()
            .map(|c| match c.as_str() {
                None => err(BAD_SCHEMA, format!("{at}: a citizen is not a string")),
                Some(s) => parse_tag(s).ok_or_else(|| FormatError {
                    code: BAD_VALUE,
                    detail: format!("{at}: citizen {s:?}"),
                }),
            })
            .collect::<Result<Vec<_>, _>>()?;
        let e = Self {
            seq,
            bell: int(o, "bell", 0, u32::MAX as i64, at)? as u32,
            sig: string(o, "sig", at)?.to_string(),
            kind: EventKind::parse(kind_s).ok_or_else(|| FormatError {
                code: BAD_VALUE,
                detail: format!("{at}: kind {kind_s:?}"),
            })?,
            p: opt_int(o, "p", -COORD, COORD, at)?.map(|x| x as i32),
            q: opt_int(o, "q", -COORD, COORD, at)?.map(|x| x as i32),
            site: opt_int(o, "site", 0, 255, at)?.map(|x| x as u8),
            march,
            from: opt_int(o, "from", 0, 255, at)?.map(|x| x as u8),
            to: opt_int(o, "to", 0, 255, at)?.map(|x| x as u8),
            citizens,
            detail: field(o, "detail", at)?.clone(),
        };
        e.check(day, at)?;
        Ok(e)
    }
}

/// `/h/conquest/{day}.json` (`v` 1).
#[derive(Clone, Debug, PartialEq)]
pub struct ConquestDay {
    pub day: u32,
    pub events: Vec<ConquestEvent>,
}

impl ConquestDay {
    fn check_order(&self) -> Result<(), FormatError> {
        for (i, w) in self.events.windows(2).enumerate() {
            ensure(w[0].seq <= w[1].seq, BAD_ORDER, || {
                format!("events[{}] seq before events[{i}]", i + 1)
            })?;
        }
        Ok(())
    }

    pub fn to_json(&self) -> Result<String, FormatError> {
        for (i, e) in self.events.iter().enumerate() {
            e.check(self.day, &format!("events[{i}]"))?;
        }
        self.check_order()?;
        let ev: Vec<String> = self.events.iter().map(ConquestEvent::to_json).collect();
        Ok(format!(
            "{{\"v\":1,\"day\":{},\"events\":[{}]}}",
            self.day,
            ev.join(",")
        ))
    }

    /// Checks: JSON, `v`, each event, order.
    pub fn parse(b: &[u8]) -> Result<Self, FormatError> {
        let v = parse_json(b)?;
        let o = obj(&v, "file")?;
        version(o)?;
        let day = int(o, "day", 0, (u32::MAX / BELLS_PER_DAY) as i64, "file")? as u32;
        let events = arr(o, "events", "file")?
            .iter()
            .enumerate()
            .map(|(i, e)| ConquestEvent::from_json(e, day, &format!("events[{i}]")))
            .collect::<Result<Vec<_>, _>>()?;
        let d = Self { day, events };
        d.check_order()?;
        Ok(d)
    }
}

// ------------------------------------------------------------------ shared vectors

/// The shared vectors (`frontier-node/fixtures/cq/formats/`): one producer.
/// `vectors.json` lists each file with its canonical decoded form (the JS
/// test compares its decoders against it) and each invalid file with the
/// code both decoders must refuse it with.
pub mod vectors {
    use super::*;
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    /// `frontier-node/fixtures/cq/formats`.
    pub fn dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/cq/formats")
    }

    /// A small deterministic generator (xorshift64*), so the vectors need no
    /// dependency and never change by accident.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 >> 12;
            self.0 ^= self.0 << 25;
            self.0 ^= self.0 >> 27;
            self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
        }
        fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }
    }

    /// A valid control file over rings 0..=`rings`.
    pub fn sample_control(season: u64, bell: u32, rings: u32, seed: u64) -> ControlFile {
        let mut rng = Rng(seed | 1);
        let n = provinces_within(rings);
        let provinces = (0..n)
            .map(|i| {
                let pc = ProvinceCoord::from_index(i);
                let ring = pc.ring();
                if i == 0 {
                    return ControlProvince {
                        control: CONTROL_NEUTRAL,
                        contender: CONTROL_NONE,
                        flags: pflag::SEAT | ((rng.below(2) as u8) * pflag::CLASH),
                        points_lead: CONTROL_NONE,
                        ..Default::default()
                    };
                }
                if ring <= 1 {
                    return ControlProvince {
                        control: pc.wedge().unwrap_or(0),
                        contender: CONTROL_NONE,
                        flags: pflag::SEAT,
                        points_lead: pc.wedge().unwrap_or(0),
                        points_share: 255,
                        ..Default::default()
                    }
                    .with_counts(0, 0);
                }
                if rng.below(9) == 0 {
                    // unopened inside the covered rings
                    return ControlProvince {
                        control: CONTROL_NONE,
                        contender: CONTROL_NONE,
                        points_lead: CONTROL_NONE,
                        ..Default::default()
                    };
                }
                let wedge = pc.wedge().unwrap_or(0);
                let heartland = ring <= 3;
                let control = if heartland { wedge } else { rng.below(6) as u8 };
                let required = 72u8;
                let (contender, progress) = if !heartland && rng.below(3) == 0 {
                    (
                        (control + 1 + rng.below(5) as u8) % 6,
                        1 + rng.below(71) as u8,
                    )
                } else {
                    (CONTROL_NONE, 0)
                };
                let mut flags = 0u8;
                if heartland {
                    flags |= pflag::HEARTLAND;
                }
                for f in [
                    pflag::CHANGED,
                    pflag::CONSOLIDATING,
                    pflag::TAKEN,
                    pflag::BROKEN,
                    pflag::CLASH,
                ] {
                    if rng.below(5) == 0 {
                        flags |= f;
                    }
                }
                ControlProvince {
                    control,
                    contender,
                    progress,
                    required,
                    flags,
                    points_lead: rng.below(8) as u8,
                    points_share: rng.below(256) as u8,
                    ..Default::default()
                }
                .with_counts(rng.below(20) as u32, rng.below(3) as u32)
            })
            .collect();
        let marches = march_order(rings)
            .iter()
            .map(|_| ControlMarch {
                banner: [0, 1, 2, 3, 4, 5, CONTROL_NONE][rng.below(7) as usize],
                points_lead: rng.below(8) as u8,
                keeps: rng.below(8) as u8,
                flags: rng.below(32) as u8 & !(mflag::TRUCE | mflag::HOSTILITY),
            })
            .collect();
        ControlFile {
            season,
            bell,
            provinces,
            marches,
        }
    }

    /// A valid overview v2 file for ring `ring`.
    pub fn sample_overview2(season: u64, ring: u16, bell: u32, seed: u64) -> Overview2File {
        let mut rng = Rng(seed | 1);
        let mut pcs = permutation_rules::frontier::geometry::ring_provinces(ring as u32);
        pcs.sort_by_key(|p| (p.p, p.q));
        let records = pcs
            .iter()
            .map(|pc| {
                let mut v1 = [0u8; OVERVIEW_RECORD];
                v1[0..2].copy_from_slice(&(pc.p as i16).to_le_bytes());
                v1[2..4].copy_from_slice(&(pc.q as i16).to_le_bytes());
                for b in v1[4..24].iter_mut() {
                    *b = rng.below(256) as u8;
                }
                let mut r = Overview2Record::from_v1(v1);
                for s in 0..12 {
                    r.occupier[s] =
                        [0, 1, 2, 3, 4, 5, OCCUPIER_NONE, OCCUPIER_NONE][rng.below(8) as usize];
                    r.siege[s] = rng.below(4) as u8;
                    r.kind[s] = rng.below(4) as u8;
                }
                if ring >= 2 {
                    r.keep_tile = rng.below(61) as u8;
                    r.keep_troops = Overview2Record::keep_troops_sat(rng.below(80_000) as u32);
                }
                r.immune = rng.below(1 << 12) as u16;
                r
            })
            .collect();
        Overview2File {
            season,
            ring,
            bell,
            slot: 1_000_000 + seed,
            records,
        }
    }

    /// A valid standings series of `n` hours.
    pub fn sample_standings(season: u64, first_hour: u32, n: usize, seed: u64) -> StandingsSeries {
        let mut rng = Rng(seed | 1);
        let mut cur = [FactionHour::default(); 6];
        let mut hours = Vec::with_capacity(n);
        for _ in 0..n {
            for f in cur.iter_mut() {
                f.provinces = rng.below(40) as u16;
                f.banners = rng.below(8) as u16;
                f.keeps_taken += rng.below(3) as u16;
                f.keeps_lost += rng.below(3) as u16;
                f.dominion_bells += rng.below(40) as u32 * 6;
                f.captures += rng.below(2) as u16;
                f.occupations_active = rng.below(4) as u16;
                f.sieges_won += rng.below(2) as u16;
                f.sieges_lost += rng.below(2) as u16;
                f.liberations += rng.below(2) as u16;
                f.holdings = 100 + rng.below(100) as u16;
                f.members_active = 90 + rng.below(80) as u16;
            }
            hours.push(cur);
        }
        StandingsSeries {
            season,
            first_hour,
            hours,
        }
    }

    const SIG: &str =
        "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYVCJjBRahnzqT5u6zQ2Yb8cXzWZkTtm8oJCqGmEsUpbxsk6tCYUBV";

    pub fn sample_sieges() -> SiegesFile {
        SiegesFile {
            bell: 400,
            sieges: vec![
                SiegeEntry {
                    p: -4,
                    q: 1,
                    site: 3,
                    kind: SiegeKind::Other,
                    owner: Some(0x0102_0304_0506_0708),
                    owner_faction: 2,
                    attacker: 0x1122_3344_5566_7788,
                    attacker_faction: 5,
                    declared: 380,
                    required: 38,
                    progress: 19,
                    pause: None,
                    eta_bell: 419,
                },
                SiegeEntry {
                    p: 4,
                    q: 0,
                    site: 7,
                    kind: SiegeKind::First,
                    owner: Some(0xA0A1_A2A3_A4A5_A6A7),
                    owner_faction: 0,
                    attacker: 0xB0B1_B2B3_B4B5_B6B7,
                    attacker_faction: 1,
                    declared: 390,
                    required: 40,
                    progress: 4,
                    pause: Some(PauseReason::Vigil),
                    eta_bell: 470,
                },
                SiegeEntry {
                    p: 4,
                    q: 0,
                    site: 11,
                    kind: SiegeKind::Free,
                    owner: None,
                    owner_faction: 6,
                    attacker: 0xC0C1_C2C3_C4C5_C6C7,
                    attacker_faction: 3,
                    declared: 399,
                    required: 36,
                    progress: 0,
                    pause: Some(PauseReason::Defender),
                    eta_bell: 436,
                },
            ],
            keeps: vec![
                KeepContest {
                    p: -4,
                    q: 2,
                    holder: 3,
                    contender: 4,
                    progress: 30,
                    required: 72,
                    since: 371,
                    eta_bell: 442,
                },
                KeepContest {
                    p: 5,
                    q: -1,
                    holder: 0,
                    contender: 1,
                    progress: 1,
                    required: 72,
                    since: 400,
                    eta_bell: 471,
                },
            ],
        }
    }

    pub fn sample_conquest_day() -> ConquestDay {
        let day = 2u32;
        let mut events = Vec::new();
        for (i, k) in EventKind::ALL.iter().enumerate() {
            let shape = k.shape();
            let (p, q, site, march) = match shape {
                EventShape::Site => (Some(4), Some(-1), Some((i % 12) as u8), None),
                EventShape::Province => (Some(-5), Some(2), None, None),
                EventShape::ProvinceMaybeSite => (Some(5), Some(0), Some(2), None),
                EventShape::March => (None, None, None, Some(MarchCoord { m: 1, n: -1 })),
            };
            let detail = match k {
                EventKind::SiegeFailed => serde_json::json!({"brokenByDefender": true}),
                EventKind::Liberated => serde_json::json!({"noRespite": true}),
                EventKind::CaptureDue => serde_json::json!({"credited": false}),
                EventKind::KeepTaken => serde_json::json!({"donor": "17", "garrison": 4200}),
                _ => serde_json::json!({}),
            };
            events.push(ConquestEvent {
                seq: 9_000 + (i as u64 / 2) * 3,
                bell: 288 + 5 * i as u32,
                sig: SIG.to_string(),
                kind: *k,
                p,
                q,
                site,
                march,
                from: if i % 3 == 0 {
                    None
                } else {
                    Some((i % 8) as u8)
                },
                to: if i % 4 == 0 {
                    None
                } else {
                    Some(((i + 1) % 8) as u8)
                },
                citizens: (0..(i % 3))
                    .map(|j| 0x0101_0101_0101_0101 * (j as u64 + 1))
                    .collect(),
                detail,
            });
        }
        ConquestDay { day, events }
    }

    fn canon_control(f: &ControlFile) -> Value {
        let rings = f.rings().unwrap_or(0);
        let order = march_order(rings);
        serde_json::json!({
            "season": f.season.to_string(),
            "bell": f.bell,
            "rings": rings,
            "provinces": f.provinces.iter().enumerate().map(|(i, p)| {
                let pc = ProvinceCoord::from_index(i as u32);
                serde_json::json!([i, pc.p, pc.q, p.control, p.contender, p.progress, p.required, p.flags, p.sieges, p.occupations, p.points_lead, p.points_share])
            }).collect::<Vec<_>>(),
            "marches": f.marches.iter().zip(&order).map(|(m, c)| {
                serde_json::json!([c.m, c.n, m.banner, m.points_lead, m.keeps, m.flags])
            }).collect::<Vec<_>>(),
        })
    }

    fn canon_delta(d: &[(u16, ControlProvince)]) -> Value {
        Value::Array(
            d.iter()
                .map(|(i, p)| {
                    serde_json::json!([
                        i,
                        p.control,
                        p.contender,
                        p.progress,
                        p.required,
                        p.flags,
                        p.sieges,
                        p.occupations,
                        p.points_lead,
                        p.points_share
                    ])
                })
                .collect(),
        )
    }

    fn canon_overview2(f: &Overview2File) -> Value {
        serde_json::json!({
            "season": f.season.to_string(),
            "ring": f.ring,
            "bell": f.bell,
            "slot": f.slot.to_string(),
            "provinces": f.records.iter().map(|r| serde_json::json!({
                "p": r.p(),
                "q": r.q(),
                "v1": hex::encode(r.v1),
                "occupiers": r.occupier,
                "sieges": r.siege,
                "kinds": r.kind,
                "keepTile": if r.keep_tile == KEEP_TILE_NONE { Value::Null } else { r.keep_tile.into() },
                "keepTroops": r.keep_troops,
                "immune": (0..12).map(|s| (r.immune >> s) & 1 == 1).collect::<Vec<_>>(),
            })).collect::<Vec<_>>(),
        })
    }

    fn canon_standings(s: &StandingsSeries) -> Value {
        serde_json::json!({
            "season": s.season.to_string(),
            "firstHour": s.first_hour,
            "hours": s.hours.iter().map(|h| h.iter().map(|f| serde_json::json!([
                f.provinces, f.banners, f.keeps_taken, f.keeps_lost, f.dominion_bells, f.captures,
                f.occupations_active, f.sieges_won, f.sieges_lost, f.liberations, f.holdings, f.members_active
            ])).collect::<Vec<_>>()).collect::<Vec<_>>(),
        })
    }

    /// Every vector file, by name (one producer).
    pub fn files() -> BTreeMap<String, Vec<u8>> {
        let mut files: BTreeMap<String, Vec<u8>> = BTreeMap::new();
        let mut valid: Vec<Value> = Vec::new();
        let mut invalid: Vec<Value> = Vec::new();
        let put = |files: &mut BTreeMap<String, Vec<u8>>, name: &str, b: Vec<u8>| {
            files.insert(name.to_string(), b);
        };

        // --- PSFCT1
        let c0 = sample_control(7, 0, 0, 1);
        let c4 = sample_control(7, 300, 4, 42);
        let c6 = sample_control(7, 1_000, 6, 7);
        for (name, f) in [
            ("control-r0-b0.bin", &c0),
            ("control-r4-b300.bin", &c4),
            ("control-r6-b1000.bin", &c6),
        ] {
            put(&mut files, name, f.encode().expect("valid sample control"));
            valid.push(
                serde_json::json!({"format": "control", "file": name, "decoded": canon_control(f)}),
            );
        }
        // --- WS delta: c4 → c4' with five changes
        let mut c4b = c4.clone();
        c4b.bell += 1;
        for i in [7usize, 19, 20, 33, 60] {
            let p = &mut c4b.provinces[i];
            p.flags ^= pflag::CLASH;
            p.points_share = p.points_share.wrapping_add(17);
        }
        let delta = control_delta(&c4, &c4b).expect("five changes");
        put(
            &mut files,
            "control-delta-r4.bin",
            encode_control_delta(&delta).expect("delta"),
        );
        valid.push(serde_json::json!({"format": "controlDelta", "file": "control-delta-r4.bin", "decoded": canon_delta(&delta)}));
        // --- PSFOV2
        let o4 = sample_overview2(7, 4, 300, 5);
        let o1 = sample_overview2(7, 1, 300, 6);
        for (name, f) in [
            ("overview2-r4-b300.bin", &o4),
            ("overview2-r1-b300.bin", &o1),
        ] {
            put(
                &mut files,
                name,
                f.encode().expect("valid sample overview2"),
            );
            valid.push(serde_json::json!({"format": "overview2", "file": name, "decoded": canon_overview2(f)}));
        }
        // --- PSFSD1
        let s = sample_standings(7, 48, 3, 9);
        put(
            &mut files,
            "standings-h48-n3.bin",
            s.encode().expect("valid sample standings"),
        );
        valid.push(serde_json::json!({"format": "standings", "file": "standings-h48-n3.bin", "decoded": canon_standings(&s)}));
        let s0 = StandingsSeries {
            season: 7,
            first_hour: 0,
            hours: vec![],
        };
        put(
            &mut files,
            "standings-empty.bin",
            s0.encode().expect("empty standings"),
        );
        valid.push(serde_json::json!({"format": "standings", "file": "standings-empty.bin", "decoded": canon_standings(&s0)}));
        // --- JSON
        let sg = sample_sieges();
        put(
            &mut files,
            "sieges-b400.json",
            sg.to_json().expect("valid sieges").into_bytes(),
        );
        valid.push(serde_json::json!({"format": "sieges", "file": "sieges-b400.json", "decoded": Value::Null}));
        let sge = SiegesFile {
            bell: 0,
            sieges: vec![],
            keeps: vec![],
        };
        put(
            &mut files,
            "sieges-empty.json",
            sge.to_json().expect("empty sieges").into_bytes(),
        );
        valid.push(serde_json::json!({"format": "sieges", "file": "sieges-empty.json", "decoded": Value::Null}));
        let cd = sample_conquest_day();
        put(
            &mut files,
            "conquest-d2.json",
            cd.to_json().expect("valid conquest day").into_bytes(),
        );
        valid.push(serde_json::json!({"format": "conquestDay", "file": "conquest-d2.json", "decoded": Value::Null}));

        // --- invalid files: exactly one defect each
        let mut bad = |files: &mut BTreeMap<String, Vec<u8>>,
                       format: &str,
                       name: &str,
                       code: &str,
                       b: Vec<u8>| {
            files.insert(name.to_string(), b);
            invalid.push(serde_json::json!({"format": format, "file": name, "code": code}));
        };
        let cb = c4.encode().expect("c4");
        let mut b = cb.clone();
        b[5] = b'X';
        bad(&mut files, "control", "bad-control-magic.bin", BAD_MAGIC, b);
        bad(
            &mut files,
            "control",
            "bad-control-short.bin",
            BAD_LENGTH,
            cb[..20].to_vec(),
        );
        bad(
            &mut files,
            "control",
            "bad-control-truncated.bin",
            BAD_LENGTH,
            cb[..cb.len() - 1].to_vec(),
        );
        let mut b = cb.clone();
        b[31] = 1;
        bad(
            &mut files,
            "control",
            "bad-control-reserved.bin",
            BAD_RESERVED,
            b,
        );
        let mut b = cb.clone();
        b[20..22].copy_from_slice(&60u16.to_le_bytes());
        bad(&mut files, "control", "bad-control-nprov.bin", BAD_SHAPE, b);
        let mut b = cb.clone();
        let nm = u16_at(&b, 22) + 1;
        b[22..24].copy_from_slice(&nm.to_le_bytes());
        b.extend_from_slice(&[7, 7, 0, 0]);
        bad(
            &mut files,
            "control",
            "bad-control-nmarch.bin",
            BAD_SHAPE,
            b,
        );
        // a contested province with progress > required
        let k = c4
            .provinces
            .iter()
            .position(|p| p.contender != CONTROL_NONE)
            .expect("a contest");
        let mut b = cb.clone();
        b[CONTROL_HEADER + k * CONTROL_PROVINCE + 2] = 73;
        bad(
            &mut files,
            "control",
            "bad-control-progress.bin",
            BAD_VALUE,
            b,
        );
        let mut b = cb.clone();
        b[CONTROL_HEADER + 10 * CONTROL_PROVINCE + 4] |= pflag::RESERVED;
        bad(
            &mut files,
            "control",
            "bad-control-flag128.bin",
            BAD_RESERVED,
            b,
        );
        let mut b = cb.clone();
        b[CONTROL_HEADER + 3 * CONTROL_PROVINCE + 4] &= !pflag::SEAT;
        bad(&mut files, "control", "bad-control-seat.bin", BAD_VALUE, b);
        let mut b = cb.clone();
        let mo = CONTROL_HEADER + c4.provinces.len() * CONTROL_PROVINCE;
        b[mo] = 6;
        bad(
            &mut files,
            "control",
            "bad-control-banner.bin",
            BAD_VALUE,
            b,
        );

        let db = encode_control_delta(&delta).expect("delta");
        bad(
            &mut files,
            "controlDelta",
            "bad-delta-length.bin",
            BAD_LENGTH,
            db[..db.len() - 3].to_vec(),
        );
        let mut b = db[10..20].to_vec();
        b.extend_from_slice(&db[..10]);
        bad(
            &mut files,
            "controlDelta",
            "bad-delta-order.bin",
            BAD_ORDER,
            b,
        );
        let many: Vec<u8> = (0..65u16)
            .flat_map(|i| {
                let mut e = i.to_le_bytes().to_vec();
                e.extend_from_slice(&c4.provinces[i as usize % c4.provinces.len()].encode());
                e
            })
            .collect();
        let mut far = 60_000u16.to_le_bytes().to_vec();
        far.extend_from_slice(
            &ControlProvince {
                control: 2,
                contender: CONTROL_NONE,
                points_lead: CONTROL_NONE,
                ..Default::default()
            }
            .encode(),
        );
        bad(
            &mut files,
            "controlDelta",
            "bad-delta-index.bin",
            BAD_VALUE,
            far,
        );
        bad(
            &mut files,
            "controlDelta",
            "bad-delta-many.bin",
            TOO_MANY,
            many,
        );

        let ob = o4.encode().expect("o4");
        let mut b = ob.clone();
        b[..8].copy_from_slice(crate::OVERVIEW_MAGIC);
        bad(
            &mut files,
            "overview2",
            "bad-overview2-magic.bin",
            BAD_MAGIC,
            b,
        );
        let mut b = ob.clone();
        let (r0, r1) = (OVERVIEW_HEADER, OVERVIEW_HEADER + OVERVIEW2_RECORD);
        let first = b[r0..r1].to_vec();
        let second = b[r1..r1 + OVERVIEW2_RECORD].to_vec();
        b[r0..r1].copy_from_slice(&second);
        b[r1..r1 + OVERVIEW2_RECORD].copy_from_slice(&first);
        bad(
            &mut files,
            "overview2",
            "bad-overview2-order.bin",
            BAD_ORDER,
            b,
        );
        let mut b = ob.clone();
        b[r0 + 24] = (b[r0 + 24] & !7) | 6; // site 0 occupier 6
        bad(
            &mut files,
            "overview2",
            "bad-overview2-occupier.bin",
            BAD_VALUE,
            b,
        );
        let mut b = ob.clone();
        b[r0 + 39] |= 0x10;
        bad(
            &mut files,
            "overview2",
            "bad-overview2-reserved.bin",
            BAD_RESERVED,
            b,
        );
        let mut b = ob.clone();
        b[r0 + 35] = 61;
        bad(
            &mut files,
            "overview2",
            "bad-overview2-keeptile.bin",
            BAD_VALUE,
            b,
        );

        let sb = s.encode().expect("s");
        let mut b = sb.clone();
        // hour 0 faction 2 keeps_taken 5, hour 1 the same field 0
        let o = STANDINGS_HEADER + STANDINGS_HOUR + 2 * STANDINGS_FACTION + 4;
        b[o..o + 2].copy_from_slice(&0u16.to_le_bytes());
        b[o - STANDINGS_HOUR..o - STANDINGS_HOUR + 2].copy_from_slice(&5u16.to_le_bytes());
        bad(
            &mut files,
            "standings",
            "bad-standings-cumulative.bin",
            NOT_CUMULATIVE,
            b,
        );
        let mut b = sb.clone();
        b[STANDINGS_HEADER + STANDINGS_FACTION - 1] = 1;
        bad(
            &mut files,
            "standings",
            "bad-standings-tail.bin",
            BAD_RESERVED,
            b,
        );
        let mut b = sb.clone();
        b[20..24].copy_from_slice(&4u32.to_le_bytes());
        bad(
            &mut files,
            "standings",
            "bad-standings-length.bin",
            BAD_LENGTH,
            b,
        );

        let sj: Value = serde_json::from_str(&sg.to_json().expect("sg")).expect("json");
        let edit = |f: &dyn Fn(&mut Value)| {
            let mut v = sj.clone();
            f(&mut v);
            serde_json::to_vec(&v).expect("json")
        };
        bad(
            &mut files,
            "sieges",
            "bad-sieges-json.json",
            BAD_JSON,
            b"{\"v\":1,".to_vec(),
        );
        bad(
            &mut files,
            "sieges",
            "bad-sieges-version.json",
            BAD_VALUE,
            edit(&|v| v["v"] = 2.into()),
        );
        bad(
            &mut files,
            "sieges",
            "bad-sieges-missing.json",
            BAD_SCHEMA,
            edit(&|v| {
                v["sieges"][0].as_object_mut().expect("o").remove("etaBell");
            }),
        );
        bad(
            &mut files,
            "sieges",
            "bad-sieges-pause.json",
            BAD_VALUE,
            edit(&|v| v["sieges"][0]["pauseReason"] = "vigil".into()),
        );
        bad(
            &mut files,
            "sieges",
            "bad-sieges-freeowner.json",
            BAD_VALUE,
            edit(&|v| v["sieges"][2]["owner"] = "0102030405060708".into()),
        );
        bad(
            &mut files,
            "sieges",
            "bad-sieges-key.json",
            BAD_VALUE,
            edit(&|v| v["sieges"][1]["key"] = "sg:4,0,7,391".into()),
        );
        bad(
            &mut files,
            "sieges",
            "bad-sieges-tag.json",
            BAD_VALUE,
            edit(&|v| v["sieges"][0]["attacker"] = "11223344556677GG".into()),
        );
        bad(
            &mut files,
            "sieges",
            "bad-sieges-order.json",
            BAD_ORDER,
            edit(&|v| {
                let a = v["keeps"].as_array_mut().expect("keeps");
                a.swap(0, 1);
            }),
        );
        bad(
            &mut files,
            "sieges",
            "bad-sieges-float.json",
            BAD_SCHEMA,
            edit(&|v| v["keeps"][0]["progress"] = 30.5.into()),
        );

        let cj: Value = serde_json::from_str(&cd.to_json().expect("cd")).expect("json");
        let edit = |f: &dyn Fn(&mut Value)| {
            let mut v = cj.clone();
            f(&mut v);
            serde_json::to_vec(&v).expect("json")
        };
        bad(
            &mut files,
            "conquestDay",
            "bad-conquest-bell.json",
            BAD_VALUE,
            edit(&|v| v["events"][0]["bell"] = 432.into()),
        );
        bad(
            &mut files,
            "conquestDay",
            "bad-conquest-kind.json",
            BAD_VALUE,
            edit(&|v| v["events"][0]["kind"] = "raid".into()),
        );
        bad(
            &mut files,
            "conquestDay",
            "bad-conquest-shape.json",
            BAD_VALUE,
            edit(&|v| v["events"][11]["site"] = 3.into()),
        );
        bad(
            &mut files,
            "conquestDay",
            "bad-conquest-seq.json",
            BAD_VALUE,
            edit(&|v| v["events"][0]["seq"] = "9e3".into()),
        );
        bad(
            &mut files,
            "conquestDay",
            "bad-conquest-order.json",
            BAD_ORDER,
            edit(&|v| v["events"][3]["seq"] = "1".into()),
        );
        bad(
            &mut files,
            "conquestDay",
            "bad-conquest-detail.json",
            BAD_SCHEMA,
            edit(&|v| v["events"][2]["detail"] = Value::Array(vec![])),
        );
        bad(
            &mut files,
            "conquestDay",
            "bad-conquest-sig.json",
            BAD_VALUE,
            edit(&|v| v["events"][1]["sig"] = "0OIl".into()),
        );

        let index = serde_json::json!({
            "v": 1,
            "producer": "frontier-node/crates/herald/src/cqfmt.rs (vectors::files); FRONTIER_WRITE_FIXTURES=1 cargo test -p herald cq_formats_vectors_fresh",
            "contract": "docs/frontier/conquest/CONQUEST-CONTRACT.md v1.1 §8.4; clarifications CF-1…CF-8 in cqfmt.rs",
            "canonical": {
                "control.provinces": "[index, p, q, control, contender, progress, required, flags, sieges, occupations, pointsLead, pointsShare]",
                "control.marches": "[m, n, banner, pointsLead, keeps, flags]",
                "controlDelta": "[index, control, contender, progress, required, flags, sieges, occupations, pointsLead, pointsShare]",
                "standings.hours": "per hour, per faction 0..5: [provinces, banners, keepsTaken, keepsLost, dominionBells, captures, occupationsActive, siegesWon, siegesLost, liberations, holdings, membersActive]",
                "json": "decoded null: the file must parse, and re-serialise to the same bytes in Rust"
            },
            "valid": valid,
            "invalid": invalid,
        });
        let mut idx = serde_json::to_vec(&index).expect("index");
        idx.push(b'\n');
        files.insert("vectors.json".into(), idx);
        files
    }
}

#[cfg(test)]
mod tests {
    /// PSFCT1's control and banner bytes are the kernel's codes: every
    /// `ProvinceControl` and `Banner` encodes through `code()` to the
    /// value the codec checks accept (integ-W1, review CQ1-D).
    #[test]
    fn cq_psfct1_codes_are_the_kernels() {
        use permutation_rules::frontier::control::{Banner, ProvinceControl};
        assert_eq!(super::CONTROL_NEUTRAL, ProvinceControl::Neutral.code());
        assert_eq!(super::CONTROL_NONE, ProvinceControl::Unopened.code());
        assert_eq!(super::CONTROL_NONE, Banner::None.code());
        assert_eq!(super::CONTROL_NONE, Banner::Contested.code());
        for f in 0..6u8 {
            assert_eq!(ProvinceControl::Keep(f).code(), f);
            assert_eq!(ProvinceControl::Seat(f).code(), f);
            assert_eq!(Banner::Faction(f).code(), f);
            assert!(ProvinceControl::Keep(f).code() <= super::CONTROL_NONE);
        }
        assert_eq!(
            super::BELLS_PER_DAY,
            permutation_rules::frontier::travel::BELLS_PER_DAY
        );
    }

    use super::vectors::*;
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn cq_formats_vectors_fresh() {
        let want = files();
        let dir = dir();
        if std::env::var("FRONTIER_WRITE_FIXTURES").is_ok() {
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("mkdir");
            for (k, v) in &want {
                std::fs::write(dir.join(k), v).expect("write");
            }
        }
        let mut have = BTreeMap::new();
        for e in std::fs::read_dir(&dir)
            .expect("fixtures/cq/formats (FRONTIER_WRITE_FIXTURES=1 writes it)")
        {
            let p = e.expect("entry").path();
            have.insert(
                p.file_name().unwrap().to_string_lossy().to_string(),
                std::fs::read(&p).expect("read"),
            );
        }
        assert_eq!(
            have.keys().collect::<Vec<_>>(),
            want.keys().collect::<Vec<_>>(),
            "stale file set: FRONTIER_WRITE_FIXTURES=1 cargo test -p herald cq_formats_vectors_fresh"
        );
        for (k, v) in &want {
            assert!(have[k] == *v, "{k} is stale: FRONTIER_WRITE_FIXTURES=1 cargo test -p herald cq_formats_vectors_fresh");
        }
    }

    #[test]
    fn cq_formats_vectors_decode_and_refuse() {
        let all = files();
        let index: Value = serde_json::from_slice(&all["vectors.json"]).expect("index");
        let mut n_valid = 0;
        for v in index["valid"].as_array().expect("valid") {
            let b = &all[v["file"].as_str().expect("file")];
            match v["format"].as_str().expect("format") {
                "control" => assert_eq!(
                    ControlFile::decode(b)
                        .expect("decode")
                        .encode()
                        .expect("encode"),
                    *b
                ),
                "controlDelta" => assert_eq!(
                    encode_control_delta(&decode_control_delta(b).expect("decode"))
                        .expect("encode"),
                    *b
                ),
                "overview2" => assert_eq!(
                    Overview2File::decode(b)
                        .expect("decode")
                        .encode()
                        .expect("encode"),
                    *b
                ),
                "standings" => assert_eq!(
                    StandingsSeries::decode(b)
                        .expect("decode")
                        .encode()
                        .expect("encode"),
                    *b
                ),
                "sieges" => assert_eq!(
                    SiegesFile::parse(b)
                        .expect("parse")
                        .to_json()
                        .expect("json")
                        .into_bytes(),
                    *b
                ),
                "conquestDay" => assert_eq!(
                    ConquestDay::parse(b)
                        .expect("parse")
                        .to_json()
                        .expect("json")
                        .into_bytes(),
                    *b
                ),
                f => panic!("format {f}"),
            }
            n_valid += 1;
        }
        let mut n_invalid = 0;
        for v in index["invalid"].as_array().expect("invalid") {
            let name = v["file"].as_str().expect("file");
            let b = &all[name];
            let got = match v["format"].as_str().expect("format") {
                "control" => ControlFile::decode(b).map(|_| ()),
                "controlDelta" => decode_control_delta(b).map(|_| ()),
                "overview2" => Overview2File::decode(b).map(|_| ()),
                "standings" => StandingsSeries::decode(b).map(|_| ()),
                "sieges" => SiegesFile::parse(b).map(|_| ()),
                "conquestDay" => ConquestDay::parse(b).map(|_| ()),
                f => panic!("format {f}"),
            };
            let e = got.expect_err(name);
            assert_eq!(e.code, v["code"].as_str().expect("code"), "{name}: {e}");
            n_invalid += 1;
        }
        assert!(
            n_valid >= 10 && n_invalid >= 30,
            "{n_valid} valid, {n_invalid} invalid"
        );
    }

    #[test]
    fn cq_control_layout_offsets() {
        let f = sample_control(0x0102_0304_0506_0708, 0x1122_3344, 2, 3);
        let b = f.encode().expect("encode");
        assert_eq!(&b[..8], b"PSFCT1\0\0");
        assert_eq!(u64_at(&b, 8), 0x0102_0304_0506_0708);
        assert_eq!(u32_at(&b, 16), 0x1122_3344);
        assert_eq!(u16_at(&b, 20) as u32, provinces_within(2));
        assert_eq!(u16_at(&b, 22) as usize, march_order(2).len());
        assert_eq!(b.len(), 32 + 19 * 8 + f.marches.len() * 4);
        // byte 5: low nibble sieges, high nibble occupations
        let p = ControlProvince::default().with_counts(40, 3);
        assert_eq!(p.encode()[5], 0x3F);
    }

    #[test]
    fn cq_march_order_matches_geometry() {
        for rings in 0..=8u32 {
            let order = march_order(rings);
            let mut seen = BTreeSet::new();
            for i in 0..provinces_within(rings) {
                seen.insert(march_of(ProvinceCoord::from_index(i)));
            }
            assert_eq!(order.len(), seen.len(), "rings {rings}");
            let centres: Vec<u32> = order.iter().map(|m| march_members(*m)[0].index()).collect();
            assert!(
                centres.windows(2).all(|w| w[0] < w[1]),
                "rings {rings}: centre order"
            );
            for m in &order {
                assert!(seen.contains(m));
            }
        }
        assert_eq!(march_order(0).len(), 1);
        assert_eq!(rings_of(1), Some(0));
        assert_eq!(rings_of(7), Some(1));
        assert_eq!(rings_of(8), None);
        assert_eq!(rings_of(provinces_within(127)), Some(127));
    }

    #[test]
    fn cq_control_round_trip_many() {
        for seed in 1..40u64 {
            let rings = (seed % 9) as u32;
            let f = sample_control(seed, seed as u32 * 7, rings, seed);
            let b = f.encode().expect("encode");
            assert_eq!(ControlFile::decode(&b).expect("decode"), f);
            let mut g = sample_control(seed, seed as u32 * 7 + 1, rings, seed + 1000);
            g.provinces[0] = f.provinces[0];
            match control_delta(&f, &g) {
                Some(d) if !d.is_empty() => {
                    let db = encode_control_delta(&d).expect("delta");
                    let back = decode_control_delta(&db).expect("decode delta");
                    let mut h = f.clone();
                    for (i, p) in back {
                        h.provinces[i as usize] = p;
                    }
                    assert_eq!(h.provinces, g.provinces);
                }
                Some(_) => assert_eq!(f.provinces, g.provinces),
                None => assert!(
                    f.provinces
                        .iter()
                        .zip(&g.provinces)
                        .filter(|(a, b)| a != b)
                        .count()
                        > CONTROL_DELTA_MAX
                ),
            }
        }
    }

    #[test]
    fn cq_control_encoder_refuses_what_the_decoder_refuses() {
        let mut f = sample_control(1, 1, 3, 11);
        f.marches.pop();
        assert_eq!(f.encode().unwrap_err().code, BAD_SHAPE);
        let mut f = sample_control(1, 1, 3, 11);
        f.provinces[0].control = 0;
        assert_eq!(f.encode().unwrap_err().code, BAD_VALUE);
        let mut f = sample_control(1, 1, 3, 11);
        f.provinces.push(ControlProvince::default());
        assert_eq!(f.encode().unwrap_err().code, BAD_SHAPE);
    }

    #[test]
    fn cq_overview2_round_trip_and_v1_prefix() {
        for ring in 0..=6u16 {
            let f = sample_overview2(3, ring, 77, ring as u64 + 1);
            let b = f.encode().expect("encode");
            assert_eq!(b.len(), 32 + f.records.len() * 40);
            assert_eq!(&b[..8], b"PSFOV2\0\0");
            for (i, r) in f.records.iter().enumerate() {
                assert_eq!(&b[32 + i * 40..32 + i * 40 + 24], &r.v1[..], "v1 prefix");
            }
            assert_eq!(Overview2File::decode(&b).expect("decode"), f);
        }
        assert_eq!(Overview2Record::keep_troops_sat(90_000), u16::MAX);
    }

    #[test]
    fn cq_standings_offsets() {
        let f = FactionHour {
            provinces: 1,
            banners: 2,
            keeps_taken: 3,
            keeps_lost: 4,
            dominion_bells: 0x0506_0708,
            captures: 9,
            occupations_active: 10,
            sieges_won: 11,
            sieges_lost: 12,
            liberations: 13,
            holdings: 14,
            members_active: 15,
        };
        let r = f.encode();
        assert_eq!(r.len(), 32);
        assert_eq!(u32_at(&r, 8), 0x0506_0708);
        assert_eq!(u16_at(&r, 24), 15);
        assert!(r[26..].iter().all(|&x| x == 0));
        assert_eq!(FactionHour::decode(&r).expect("decode"), f);
    }

    #[test]
    fn cq_json_round_trip() {
        let s = sample_sieges();
        let j = s.to_json().expect("json");
        assert_eq!(SiegesFile::parse(j.as_bytes()).expect("parse"), s);
        let d = sample_conquest_day();
        let j = d.to_json().expect("json");
        assert_eq!(ConquestDay::parse(j.as_bytes()).expect("parse"), d);
        // every kind appears once and its shape holds
        assert_eq!(d.events.len(), EventKind::ALL.len());
        assert_eq!(tag_hex(0x0102_0304_0506_0708), "0807060504030201");
        assert_eq!(parse_tag("0807060504030201"), Some(0x0102_0304_0506_0708));
        assert_eq!(parse_tag("0807060504030X01"), None);
        assert_eq!(parse_tag("08070605040302AB"), None);
    }
}

// ==================================================================== CQ2-E additions (v1.2, A-4)
//
// The JSON shapes §8.4 lists but does not pin, added by CQ2-E (the pinned
// codecs above and their vectors are unchanged, byte for byte):
//
// | path | here |
// |---|---|
// | `/h/standings/latest.json` | [`StandingsLatest`] |
// | `/h/standings/players.json` | [`PlayersFile`] |
// | `/h/call/{day}.json` | [`CallFile`] |
// | `/h/season/final.json` | [`FinalFile`] |
// | `/h/siege/{P},{Q},{site}/{declared}.json` | [`SiegeHistory`] |
// | `/h/keep/{P},{Q}.json` | [`KeepHistory`] |
// | WS `kind:"siege"` | [`SiegeDelta`] |
//
// Same conventions as CF-7: compact canonical JSON in the documented field
// order, citizen tags as 16 lowercase hex characters, `seq` as a decimal
// string, `sig` base58, no floats (ratios are basis points, `…Bps`).
// Their vectors live in `frontier-node/crates/herald/vectors/cq-json/`
// (one producer: [`cq2e_vectors::files`]; freshness:
// `cq_json_vectors_fresh`), beside the CQ1-D set, which stays untouched.

fn bool_field(o: &serde_json::Map<String, Value>, k: &str, at: &str) -> Result<bool, FormatError> {
    field(o, k, at)?.as_bool().ok_or_else(|| FormatError {
        code: BAD_SCHEMA,
        detail: format!("{at}: {k} is not a boolean"),
    })
}

fn u64_str(o: &serde_json::Map<String, Value>, k: &str, at: &str) -> Result<u64, FormatError> {
    let s = string(o, k, at)?;
    (!s.is_empty() && s.bytes().all(|c| c.is_ascii_digit()) && (s == "0" || !s.starts_with('0')))
        .then(|| s.parse::<u64>().ok())
        .flatten()
        .ok_or_else(|| FormatError {
            code: BAD_VALUE,
            detail: format!("{at}: {k} {s:?} is not a decimal u64"),
        })
}

fn sig_ok(s: &str) -> bool {
    (1..=90).contains(&s.len()) && s.chars().all(|c| B58.contains(c))
}

fn hex32(o: &serde_json::Map<String, Value>, k: &str, at: &str) -> Result<[u8; 32], FormatError> {
    let s = string(o, k, at)?;
    let mut a = [0u8; 32];
    let ok = s.len() == 64
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        && hex::decode_to_slice(s, &mut a).is_ok();
    ensure(ok, BAD_VALUE, || {
        format!("{at}: {k} is not 64 lowercase hex")
    })?;
    Ok(a)
}

fn march_json(m: &MarchCoord) -> String {
    format!("{{\"m\":{},\"n\":{}}}", m.m, m.n)
}

fn march_of_json(v: &Value, at: &str) -> Result<MarchCoord, FormatError> {
    let mo = obj(v, at)?;
    Ok(MarchCoord {
        m: int(mo, "m", -COORD, COORD, at)? as i32,
        n: int(mo, "n", -COORD, COORD, at)? as i32,
    })
}

const U16: i64 = u16::MAX as i64;
const U32: i64 = u32::MAX as i64;

// ------------------------------------------------------------------ /h/standings/latest.json

/// One faction's standing: its `PSFSD1` row plus the members and the
/// unofficial Dominion figures (§3.10: game points, `official: false`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FactionStanding {
    pub row: FactionHour,
    /// Citizens of the faction (JoinShards' `members`).
    pub members: u32,
    /// `dominion_bells + dominion_per_capture × captures` (§3.10).
    pub dominion: u64,
    /// The unofficial per-member index × 1,000,000 (`index::INDEX_ONE`):
    /// the clamped per-capita Dominion ratio times the herding damping.
    pub index: u64,
}

/// `/h/standings/latest.json` (and the `standings` of `final.json`): the
/// last hour of the series. `factions` are 0..=5 in order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StandingsLatest {
    pub hour: u32,
    /// The control bell the hour's map figures come from.
    pub bell: u32,
    pub factions: [FactionStanding; 6],
}

impl StandingsLatest {
    fn body(&self) -> String {
        let fs: Vec<String> = self
            .factions
            .iter()
            .enumerate()
            .map(|(f, s)| {
                let r = &s.row;
                format!(
                    "{{\"faction\":{f},\"provinces\":{},\"banners\":{},\"keepsTaken\":{},\"keepsLost\":{},\"dominionBells\":{},\"captures\":{},\"dominion\":{},\"occupationsActive\":{},\"siegesWon\":{},\"siegesLost\":{},\"liberations\":{},\"holdings\":{},\"membersActive\":{},\"members\":{},\"index\":{}}}",
                    r.provinces, r.banners, r.keeps_taken, r.keeps_lost, r.dominion_bells, r.captures,
                    s.dominion, r.occupations_active, r.sieges_won, r.sieges_lost, r.liberations,
                    r.holdings, r.members_active, s.members, s.index
                )
            })
            .collect();
        format!(
            "{{\"v\":1,\"official\":false,\"hour\":{},\"bell\":{},\"factions\":[{}]}}",
            self.hour,
            self.bell,
            fs.join(",")
        )
    }

    pub fn to_json(&self) -> Result<String, FormatError> {
        Ok(self.body())
    }

    fn from_value(v: &Value, at: &str) -> Result<Self, FormatError> {
        let o = obj(v, at)?;
        version(o)?;
        ensure(
            field(o, "official", at)?.as_bool() == Some(false),
            BAD_VALUE,
            || format!("{at}: official is not false"),
        )?;
        let hour = int(o, "hour", 0, U32, at)? as u32;
        let bell = int(o, "bell", 0, U32, at)? as u32;
        let a = arr(o, "factions", at)?;
        ensure(a.len() == 6, BAD_SHAPE, || {
            format!("{at}: {} factions", a.len())
        })?;
        let mut factions = [FactionStanding::default(); 6];
        for (i, x) in a.iter().enumerate() {
            let w = format!("{at}.factions[{i}]");
            let fo = obj(x, &w)?;
            ensure(int(fo, "faction", 0, 5, &w)? == i as i64, BAD_ORDER, || {
                format!("{w}: faction out of order")
            })?;
            let g = |k: &str| int(fo, k, 0, U16, &w).map(|x| x as u16);
            factions[i] = FactionStanding {
                row: FactionHour {
                    provinces: g("provinces")?,
                    banners: g("banners")?,
                    keeps_taken: g("keepsTaken")?,
                    keeps_lost: g("keepsLost")?,
                    dominion_bells: int(fo, "dominionBells", 0, U32, &w)? as u32,
                    captures: g("captures")?,
                    occupations_active: g("occupationsActive")?,
                    sieges_won: g("siegesWon")?,
                    sieges_lost: g("siegesLost")?,
                    liberations: g("liberations")?,
                    holdings: g("holdings")?,
                    members_active: g("membersActive")?,
                },
                members: int(fo, "members", 0, U32, &w)? as u32,
                dominion: int(fo, "dominion", 0, i64::MAX, &w)? as u64,
                index: int(fo, "index", 0, i64::MAX, &w)? as u64,
            };
        }
        Ok(Self {
            hour,
            bell,
            factions,
        })
    }

    /// Checks: JSON, `v`, `official`, six factions in order, ranges.
    pub fn parse(b: &[u8]) -> Result<Self, FormatError> {
        Self::from_value(&parse_json(b)?, "file")
    }
}

// ------------------------------------------------------------------ /h/standings/players.json

/// Most rows per faction in `players.json` (§8.4: top 100 per faction).
pub const PLAYERS_PER_FACTION: usize = 100;

/// One player's display-only recognition (R-10): no points, no goods.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PlayerRow {
    pub tag: u64,
    pub faction: u8,
    /// 1-based rank inside the faction.
    pub rank: u32,
    /// Keeps taken (a non-civilian host on the tile at the taking bell).
    pub keeps_taken: u32,
    /// Bells a host stood on a keep its faction held as the counting
    /// contender (CQ2-E-NOTES: the reading of §3.2's "keep-bells held").
    pub keep_bells: u32,
    /// Sieges completed as the declarer.
    pub sieges_won: u32,
    /// Credited captures as the declarer.
    pub captures: u32,
    /// Liberations with Respite won with a host on the hex.
    pub liberations: u32,
}

impl PlayerRow {
    /// The ranking key: more is better, then the lowest tag.
    pub fn rank_key(&self) -> (std::cmp::Reverse<[u32; 5]>, u64) {
        (
            std::cmp::Reverse([
                self.keeps_taken,
                self.keep_bells,
                self.sieges_won,
                self.captures,
                self.liberations,
            ]),
            self.tag,
        )
    }

    fn json(&self) -> String {
        format!(
            "{{\"tag\":{},\"faction\":{},\"rank\":{},\"keepsTaken\":{},\"keepBells\":{},\"siegesWon\":{},\"captures\":{},\"liberations\":{}}}",
            js(&tag_hex(self.tag)),
            self.faction,
            self.rank,
            self.keeps_taken,
            self.keep_bells,
            self.sieges_won,
            self.captures,
            self.liberations
        )
    }

    fn from_json(v: &Value, at: &str) -> Result<Self, FormatError> {
        let o = obj(v, at)?;
        Ok(Self {
            tag: tag(o, "tag", at)?,
            faction: int(o, "faction", 0, 5, at)? as u8,
            rank: int(o, "rank", 1, U32, at)? as u32,
            keeps_taken: int(o, "keepsTaken", 0, U32, at)? as u32,
            keep_bells: int(o, "keepBells", 0, U32, at)? as u32,
            sieges_won: int(o, "siegesWon", 0, U32, at)? as u32,
            captures: int(o, "captures", 0, U32, at)? as u32,
            liberations: int(o, "liberations", 0, U32, at)? as u32,
        })
    }
}

/// `/h/standings/players.json`: per faction (0..=5), its top
/// [`PLAYERS_PER_FACTION`] by [`PlayerRow::rank_key`], ranks 1, 2, … .
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlayersFile {
    pub bell: u32,
    pub players: Vec<PlayerRow>,
}

impl PlayersFile {
    /// The file from every player's row (any order): ranked and cut.
    pub fn ranked(bell: u32, rows: impl IntoIterator<Item = PlayerRow>) -> Self {
        let mut by: [Vec<PlayerRow>; 6] = Default::default();
        for r in rows {
            if let Some(v) = by.get_mut(r.faction as usize) {
                v.push(r);
            }
        }
        let mut players = Vec::new();
        for v in by.iter_mut() {
            v.sort_by_key(|r| r.rank_key());
            for (i, r) in v.iter().take(PLAYERS_PER_FACTION).enumerate() {
                players.push(PlayerRow {
                    rank: i as u32 + 1,
                    ..*r
                });
            }
        }
        Self { bell, players }
    }

    fn check(&self) -> Result<(), FormatError> {
        let mut seen = BTreeSet::new();
        let mut count = [0usize; 6];
        for (i, w) in self.players.iter().enumerate() {
            let at = format!("players[{i}]");
            ensure(w.faction <= 5, BAD_VALUE, || format!("{at}: faction"))?;
            ensure(seen.insert(w.tag), BAD_VALUE, || format!("{at}: tag twice"))?;
            count[w.faction as usize] += 1;
            ensure(
                w.rank as usize == count[w.faction as usize],
                BAD_ORDER,
                || format!("{at}: rank {} out of order", w.rank),
            )?;
            if i > 0 {
                let p = &self.players[i - 1];
                let ok = p.faction < w.faction
                    || (p.faction == w.faction && p.rank_key() < w.rank_key());
                ensure(ok, BAD_ORDER, || {
                    format!("{at}: not after players[{}]", i - 1)
                })?;
            }
        }
        ensure(
            count.iter().all(|&n| n <= PLAYERS_PER_FACTION),
            TOO_MANY,
            || "more than 100 players of a faction".into(),
        )
    }

    pub fn to_json(&self) -> Result<String, FormatError> {
        self.check()?;
        let ps: Vec<String> = self.players.iter().map(PlayerRow::json).collect();
        Ok(format!(
            "{{\"v\":1,\"official\":false,\"bell\":{},\"players\":[{}]}}",
            self.bell,
            ps.join(",")
        ))
    }

    /// Checks: JSON, `v`, each row, faction order, ranks, unique tags.
    pub fn parse(b: &[u8]) -> Result<Self, FormatError> {
        let v = parse_json(b)?;
        let o = obj(&v, "file")?;
        version(o)?;
        let bell = int(o, "bell", 0, U32, "file")? as u32;
        let players = arr(o, "players", "file")?
            .iter()
            .enumerate()
            .map(|(i, p)| PlayerRow::from_json(p, &format!("players[{i}]")))
            .collect::<Result<Vec<_>, _>>()?;
        let f = Self { bell, players };
        f.check()?;
        Ok(f)
    }
}

// ------------------------------------------------------------------ /h/call/{day}.json

/// Herald's Call of one day (§3.10; display only, no reward): one March
/// per faction (0..=5, `None` when the faction has no target), computed by
/// `control::herald_call_detail` over the control map of the day's first
/// bell, with the day seed of [`call_day_seed`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CallFile {
    pub day: u32,
    /// The control bell the map comes from (`144 × day`).
    pub bell: u32,
    pub day_seed: [u8; 32],
    /// `(March, rally)` per faction.
    pub calls: [Option<(MarchCoord, bool)>; 6],
}

/// Domain of the day seed (CQ2-E; §3.10 names a "day seed" without
/// defining it, CQ2-E-NOTES CF-9).
pub const CALL_DAY_DOMAIN: &[u8] = b"PSF-HERALD-CALL-DAY";

/// The Call's day seed: `sha256("PSF-HERALD-CALL-DAY" ‖ genesis_seed ‖ day
/// u32 LE)`, from the Season's `genesis_seed` (public from the start;
/// the Call is display data, so predictability is harmless).
pub fn call_day_seed(genesis_seed: &[u8; 32], day: u32) -> [u8; 32] {
    permutation_rules::hash::sha256(&[CALL_DAY_DOMAIN, genesis_seed, &day.to_le_bytes()])
}

impl CallFile {
    pub fn to_json(&self) -> Result<String, FormatError> {
        let cs: Vec<String> = self
            .calls
            .iter()
            .enumerate()
            .map(|(f, c)| match c {
                Some((m, rally)) => format!(
                    "{{\"faction\":{f},\"march\":{},\"rally\":{rally}}}",
                    march_json(m)
                ),
                None => format!("{{\"faction\":{f},\"march\":null,\"rally\":false}}"),
            })
            .collect();
        Ok(format!(
            "{{\"v\":1,\"day\":{},\"bell\":{},\"daySeed\":{},\"calls\":[{}]}}",
            self.day,
            self.bell,
            js(&hex::encode(self.day_seed)),
            cs.join(",")
        ))
    }

    /// Checks: JSON, `v`, six calls in faction order, `rally` false
    /// without a March.
    pub fn parse(b: &[u8]) -> Result<Self, FormatError> {
        let v = parse_json(b)?;
        let o = obj(&v, "file")?;
        version(o)?;
        let day = int(o, "day", 0, (u32::MAX / BELLS_PER_DAY) as i64, "file")? as u32;
        let bell = int(o, "bell", 0, U32, "file")? as u32;
        let day_seed = hex32(o, "daySeed", "file")?;
        let a = arr(o, "calls", "file")?;
        ensure(a.len() == 6, BAD_SHAPE, || format!("{} calls", a.len()))?;
        let mut calls = [None; 6];
        for (i, c) in a.iter().enumerate() {
            let at = format!("calls[{i}]");
            let co = obj(c, &at)?;
            ensure(
                int(co, "faction", 0, 5, &at)? == i as i64,
                BAD_ORDER,
                || format!("{at}: faction out of order"),
            )?;
            let rally = bool_field(co, "rally", &at)?;
            calls[i] = match field(co, "march", &at)? {
                Value::Null => {
                    ensure(!rally, BAD_VALUE, || {
                        format!("{at}: a rally without a March")
                    })?;
                    None
                }
                m => Some((march_of_json(m, &at)?, rally)),
            };
        }
        Ok(Self {
            day,
            bell,
            day_seed,
            calls,
        })
    }
}

// ------------------------------------------------------------------ /h/siege/{P},{Q},{site}/{declared}.json

/// One bell of a siege's series.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SiegeBell {
    pub bell: u32,
    /// The besieging faction held the hex.
    pub holds: bool,
    /// A defender of the owner's faction stood on the hex.
    pub defender: bool,
    /// `bell_start(bell)` lay inside the snapshotted vigil.
    pub vigil: bool,
    /// Progress after the bell.
    pub progress: u8,
}

/// How a siege ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SiegeOutcome {
    Failed,
    Occupied,
    CaptureDue,
    /// Still active at `end_bell` (lapsed, the stake returned).
    Lapsed,
}

impl SiegeOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Failed => "failed",
            Self::Occupied => "occupied",
            Self::CaptureDue => "capture_due",
            Self::Lapsed => "lapsed",
        }
    }
    fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "failed" => Self::Failed,
            "occupied" => Self::Occupied,
            "capture_due" => Self::CaptureDue,
            "lapsed" => Self::Lapsed,
            _ => return None,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SiegeEnd {
    pub bell: u32,
    pub outcome: SiegeOutcome,
    pub broken_by_defender: bool,
    /// `Some` for a capture.
    pub credited: Option<bool>,
}

/// A record that followed (or announced) a siege: its kind name, bell,
/// `/h/events` number and signature, and a free-form detail object.
#[derive(Clone, Debug, PartialEq)]
pub struct RecordRef {
    pub kind: String,
    pub bell: u32,
    pub seq: u64,
    pub sig: String,
    pub detail: Value,
}

impl RecordRef {
    fn to_json(&self) -> String {
        format!(
            "{{\"kind\":{},\"bell\":{},\"seq\":{},\"sig\":{},\"detail\":{}}}",
            js(&self.kind),
            self.bell,
            js(&self.seq.to_string()),
            js(&self.sig),
            serde_json::to_string(&self.detail).unwrap_or_else(|_| "{}".into())
        )
    }

    fn check(&self, at: &str) -> Result<(), FormatError> {
        ensure(
            !self.kind.is_empty()
                && self
                    .kind
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c == b'_'),
            BAD_VALUE,
            || format!("{at}: kind {:?}", self.kind),
        )?;
        ensure(sig_ok(&self.sig), BAD_VALUE, || format!("{at}: sig"))?;
        ensure(self.detail.is_object(), BAD_SCHEMA, || {
            format!("{at}: detail is not an object")
        })
    }

    fn from_json(v: &Value, at: &str) -> Result<Self, FormatError> {
        let o = obj(v, at)?;
        let r = Self {
            kind: string(o, "kind", at)?.to_string(),
            bell: int(o, "bell", 0, U32, at)? as u32,
            seq: u64_str(o, "seq", at)?,
            sig: string(o, "sig", at)?.to_string(),
            detail: field(o, "detail", at)?.clone(),
        };
        r.check(at)?;
        Ok(r)
    }
}

/// One holding siege's history (immutable once ended).
#[derive(Clone, Debug, PartialEq)]
pub struct SiegeHistory {
    pub p: i32,
    pub q: i32,
    pub site: u8,
    pub declared: u32,
    pub kind: SiegeKind,
    pub owner: Option<u64>,
    pub owner_faction: u8,
    pub attacker: u64,
    pub attacker_faction: u8,
    pub required: u8,
    /// The SIEGE_DECLARED record.
    pub horn: RecordRef,
    pub series: Vec<SiegeBell>,
    pub end: Option<SiegeEnd>,
    /// SIEGE_SETTLED, CAPTURE_SETTLED and the occupation's end, in order.
    pub followed: Vec<RecordRef>,
}

impl SiegeHistory {
    pub fn key(&self) -> String {
        format!("sg:{},{},{},{}", self.p, self.q, self.site, self.declared)
    }

    fn check(&self) -> Result<(), FormatError> {
        ensure(self.site < 12, BAD_VALUE, || "site".into())?;
        let free = self.kind == SiegeKind::Free;
        ensure(
            free == self.owner.is_none() && free == (self.owner_faction == CONTROL_NEUTRAL),
            BAD_VALUE,
            || "owner null and ownerFaction 6 exactly for a Free City".into(),
        )?;
        ensure(
            self.owner_faction <= 6
                && self.attacker_faction <= 5
                && self.attacker_faction != self.owner_faction,
            BAD_VALUE,
            || "faction".into(),
        )?;
        ensure((1..=60).contains(&self.required), BAD_VALUE, || {
            format!("required {}", self.required)
        })?;
        self.horn.check("horn")?;
        let mut last = self.declared;
        for (i, s) in self.series.iter().enumerate() {
            ensure(s.bell > last, BAD_ORDER, || {
                format!("series[{i}]: bell {} not after {last}", s.bell)
            })?;
            ensure(s.progress <= self.required, BAD_VALUE, || {
                format!("series[{i}]: progress")
            })?;
            last = s.bell;
        }
        if let Some(e) = &self.end {
            ensure(e.bell >= self.declared, BAD_VALUE, || {
                "end before declared".into()
            })?;
            ensure(
                e.credited.is_some() == (e.outcome == SiegeOutcome::CaptureDue),
                BAD_VALUE,
                || "credited exactly for a capture".into(),
            )?;
        }
        for (i, r) in self.followed.iter().enumerate() {
            r.check(&format!("followed[{i}]"))?;
        }
        Ok(())
    }

    pub fn to_json(&self) -> Result<String, FormatError> {
        self.check()?;
        let series: Vec<String> = self
            .series
            .iter()
            .map(|s| {
                format!(
                    "{{\"bell\":{},\"holds\":{},\"defender\":{},\"vigil\":{},\"progress\":{}}}",
                    s.bell, s.holds, s.defender, s.vigil, s.progress
                )
            })
            .collect();
        let end = match &self.end {
            None => "null".to_string(),
            Some(e) => format!(
                "{{\"bell\":{},\"outcome\":{},\"brokenByDefender\":{},\"credited\":{}}}",
                e.bell,
                js(e.outcome.as_str()),
                e.broken_by_defender,
                opt(&e.credited)
            ),
        };
        let followed: Vec<String> = self.followed.iter().map(RecordRef::to_json).collect();
        Ok(format!(
            "{{\"v\":1,\"key\":{},\"p\":{},\"q\":{},\"site\":{},\"declared\":{},\"kind\":{},\"owner\":{},\"ownerFaction\":{},\"attacker\":{},\"attackerFaction\":{},\"required\":{},\"horn\":{},\"series\":[{}],\"end\":{},\"followed\":[{}]}}",
            js(&self.key()),
            self.p,
            self.q,
            self.site,
            self.declared,
            js(self.kind.as_str()),
            self.owner.map_or_else(|| "null".into(), |t| js(&tag_hex(t))),
            self.owner_faction,
            js(&tag_hex(self.attacker)),
            self.attacker_faction,
            self.required,
            self.horn.to_json(),
            series.join(","),
            end,
            followed.join(",")
        ))
    }

    /// Checks: JSON, `v`, the key, factions, series order, the end.
    pub fn parse(b: &[u8]) -> Result<Self, FormatError> {
        let v = parse_json(b)?;
        let o = obj(&v, "file")?;
        version(o)?;
        let at = "file";
        let kind_s = string(o, "kind", at)?;
        let owner = match field(o, "owner", at)? {
            Value::Null => None,
            _ => Some(tag(o, "owner", at)?),
        };
        let series = arr(o, "series", at)?
            .iter()
            .enumerate()
            .map(|(i, s)| {
                let w = format!("series[{i}]");
                let so = obj(s, &w)?;
                Ok(SiegeBell {
                    bell: int(so, "bell", 0, U32, &w)? as u32,
                    holds: bool_field(so, "holds", &w)?,
                    defender: bool_field(so, "defender", &w)?,
                    vigil: bool_field(so, "vigil", &w)?,
                    progress: int(so, "progress", 0, 255, &w)? as u8,
                })
            })
            .collect::<Result<Vec<_>, FormatError>>()?;
        let end = match field(o, "end", at)? {
            Value::Null => None,
            e => {
                let eo = obj(e, "end")?;
                let os = string(eo, "outcome", "end")?;
                Some(SiegeEnd {
                    bell: int(eo, "bell", 0, U32, "end")? as u32,
                    outcome: SiegeOutcome::parse(os).ok_or_else(|| FormatError {
                        code: BAD_VALUE,
                        detail: format!("end: outcome {os:?}"),
                    })?,
                    broken_by_defender: bool_field(eo, "brokenByDefender", "end")?,
                    credited: match field(eo, "credited", "end")? {
                        Value::Null => None,
                        _ => Some(bool_field(eo, "credited", "end")?),
                    },
                })
            }
        };
        let followed = arr(o, "followed", at)?
            .iter()
            .enumerate()
            .map(|(i, r)| RecordRef::from_json(r, &format!("followed[{i}]")))
            .collect::<Result<Vec<_>, _>>()?;
        let h = Self {
            p: int(o, "p", -COORD, COORD, at)? as i32,
            q: int(o, "q", -COORD, COORD, at)? as i32,
            site: int(o, "site", 0, 255, at)? as u8,
            declared: int(o, "declared", 0, U32, at)? as u32,
            kind: SiegeKind::parse(kind_s).ok_or_else(|| FormatError {
                code: BAD_VALUE,
                detail: format!("kind {kind_s:?}"),
            })?,
            owner,
            owner_faction: int(o, "ownerFaction", 0, 255, at)? as u8,
            attacker: tag(o, "attacker", at)?,
            attacker_faction: int(o, "attackerFaction", 0, 255, at)? as u8,
            required: int(o, "required", 0, 255, at)? as u8,
            horn: RecordRef::from_json(field(o, "horn", at)?, "horn")?,
            series,
            end,
            followed,
        };
        let key = string(o, "key", at)?;
        ensure(key == h.key(), BAD_VALUE, || format!("key {key:?}"))?;
        h.check()?;
        Ok(h)
    }
}

// ------------------------------------------------------------------ /h/keep/{P},{Q}.json

/// How a keep contest ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ContestOutcome {
    Running,
    Broken,
    Taken,
    /// The season ended with the contest running (§3.11).
    Stopped,
}

impl ContestOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Broken => "broken",
            Self::Taken => "taken",
            Self::Stopped => "stopped",
        }
    }
    fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "running" => Self::Running,
            "broken" => Self::Broken,
            "taken" => Self::Taken,
            "stopped" => Self::Stopped,
            _ => return None,
        })
    }
}

/// One contest of a keep.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ContestRec {
    pub contender: u8,
    /// The first counted bell (`contest_from_bell`).
    pub from: u32,
    /// The bell it ended (`None` while running).
    pub to: Option<u32>,
    pub outcome: ContestOutcome,
    /// Progress at the end (or now).
    pub progress: u8,
}

/// One capture of a keep (the KEEP_TAKEN event's CONQUEST record).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeepCapture {
    pub bell: u32,
    pub from: u8,
    pub to: u8,
    /// The new garrison (whole troops).
    pub troops: u32,
    /// The donor's host id (0 without a donor).
    pub donor: u64,
    pub seq: u64,
    pub sig: String,
}

/// A keep's history (`max-age=5`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeepHistory {
    pub p: i32,
    pub q: i32,
    pub tile: u8,
    pub holder: u8,
    /// `since_bell` of the current holder.
    pub since: u32,
    pub troops: u32,
    pub gen: u32,
    pub heartland: bool,
    /// Every holder from the opening, `(faction, since bell)`.
    pub holders: Vec<(u8, u32)>,
    pub contests: Vec<ContestRec>,
    pub captures: Vec<KeepCapture>,
}

impl KeepHistory {
    fn check(&self) -> Result<(), FormatError> {
        ensure(
            (self.tile as usize) < permutation_rules::frontier::geometry::PROVINCE_TILES
                && self.holder <= 5,
            BAD_VALUE,
            || "tile or holder".into(),
        )?;
        for (i, w) in self.holders.windows(2).enumerate() {
            ensure(w[0].1 <= w[1].1, BAD_ORDER, || {
                format!("holders[{}] before holders[{i}]", i + 1)
            })?;
        }
        ensure(
            self.holders.iter().all(|h| h.0 <= 5)
                && self.holders.last().map(|h| h.0) == Some(self.holder),
            BAD_VALUE,
            || "holders do not end at the holder".into(),
        )?;
        for (i, c) in self.contests.iter().enumerate() {
            ensure(c.contender <= 5, BAD_VALUE, || {
                format!("contests[{i}]: contender")
            })?;
            ensure(
                c.to.is_none() == (c.outcome == ContestOutcome::Running)
                    && c.to.is_none_or(|t| t >= c.from),
                BAD_VALUE,
                || format!("contests[{i}]: to / outcome"),
            )?;
        }
        for (i, w) in self.contests.windows(2).enumerate() {
            ensure(w[0].from <= w[1].from, BAD_ORDER, || {
                format!("contests[{}] before contests[{i}]", i + 1)
            })?;
        }
        for (i, c) in self.captures.iter().enumerate() {
            ensure(
                c.from <= 5 && c.to <= 5 && c.from != c.to,
                BAD_VALUE,
                || format!("captures[{i}]: factions"),
            )?;
            ensure(sig_ok(&c.sig), BAD_VALUE, || format!("captures[{i}]: sig"))?;
        }
        for (i, w) in self.captures.windows(2).enumerate() {
            ensure(w[0].bell < w[1].bell, BAD_ORDER, || {
                format!("captures[{}] not after captures[{i}]", i + 1)
            })?;
        }
        Ok(())
    }

    pub fn to_json(&self) -> Result<String, FormatError> {
        self.check()?;
        let holders: Vec<String> = self
            .holders
            .iter()
            .map(|(f, s)| format!("{{\"holder\":{f},\"since\":{s}}}"))
            .collect();
        let contests: Vec<String> = self
            .contests
            .iter()
            .map(|c| {
                format!(
                    "{{\"contender\":{},\"from\":{},\"to\":{},\"outcome\":{},\"progress\":{}}}",
                    c.contender,
                    c.from,
                    opt(&c.to),
                    js(c.outcome.as_str()),
                    c.progress
                )
            })
            .collect();
        let captures: Vec<String> = self
            .captures
            .iter()
            .map(|c| {
                format!(
                    "{{\"bell\":{},\"from\":{},\"to\":{},\"troops\":{},\"donor\":{},\"seq\":{},\"sig\":{}}}",
                    c.bell,
                    c.from,
                    c.to,
                    c.troops,
                    js(&c.donor.to_string()),
                    js(&c.seq.to_string()),
                    js(&c.sig)
                )
            })
            .collect();
        Ok(format!(
            "{{\"v\":1,\"p\":{},\"q\":{},\"tile\":{},\"holder\":{},\"since\":{},\"troops\":{},\"gen\":{},\"heartland\":{},\"holders\":[{}],\"contests\":[{}],\"captures\":[{}]}}",
            self.p,
            self.q,
            self.tile,
            self.holder,
            self.since,
            self.troops,
            self.gen,
            self.heartland,
            holders.join(","),
            contests.join(","),
            captures.join(",")
        ))
    }

    /// Checks: JSON, `v`, ranges, orders, the holder list ends at `holder`.
    pub fn parse(b: &[u8]) -> Result<Self, FormatError> {
        let v = parse_json(b)?;
        let o = obj(&v, "file")?;
        version(o)?;
        let at = "file";
        let holders = arr(o, "holders", at)?
            .iter()
            .enumerate()
            .map(|(i, h)| {
                let w = format!("holders[{i}]");
                let ho = obj(h, &w)?;
                Ok((
                    int(ho, "holder", 0, 255, &w)? as u8,
                    int(ho, "since", 0, U32, &w)? as u32,
                ))
            })
            .collect::<Result<Vec<_>, FormatError>>()?;
        let contests = arr(o, "contests", at)?
            .iter()
            .enumerate()
            .map(|(i, c)| {
                let w = format!("contests[{i}]");
                let co = obj(c, &w)?;
                let os = string(co, "outcome", &w)?;
                Ok(ContestRec {
                    contender: int(co, "contender", 0, 255, &w)? as u8,
                    from: int(co, "from", 0, U32, &w)? as u32,
                    to: opt_int(co, "to", 0, U32, &w)?.map(|x| x as u32),
                    outcome: ContestOutcome::parse(os).ok_or_else(|| FormatError {
                        code: BAD_VALUE,
                        detail: format!("{w}: outcome {os:?}"),
                    })?,
                    progress: int(co, "progress", 0, 255, &w)? as u8,
                })
            })
            .collect::<Result<Vec<_>, FormatError>>()?;
        let captures = arr(o, "captures", at)?
            .iter()
            .enumerate()
            .map(|(i, c)| {
                let w = format!("captures[{i}]");
                let co = obj(c, &w)?;
                Ok(KeepCapture {
                    bell: int(co, "bell", 0, U32, &w)? as u32,
                    from: int(co, "from", 0, 255, &w)? as u8,
                    to: int(co, "to", 0, 255, &w)? as u8,
                    troops: int(co, "troops", 0, U32, &w)? as u32,
                    donor: u64_str(co, "donor", &w)?,
                    seq: u64_str(co, "seq", &w)?,
                    sig: string(co, "sig", &w)?.to_string(),
                })
            })
            .collect::<Result<Vec<_>, FormatError>>()?;
        let k = Self {
            p: int(o, "p", -COORD, COORD, at)? as i32,
            q: int(o, "q", -COORD, COORD, at)? as i32,
            tile: int(o, "tile", 0, 255, at)? as u8,
            holder: int(o, "holder", 0, 255, at)? as u8,
            since: int(o, "since", 0, U32, at)? as u32,
            troops: int(o, "troops", 0, U32, at)? as u32,
            gen: int(o, "gen", 0, U32, at)? as u32,
            heartland: bool_field(o, "heartland", at)?,
            holders,
            contests,
            captures,
        };
        k.check()?;
        Ok(k)
    }
}

// ------------------------------------------------------------------ /h/season/final.json

/// A ratio as counts and basis points (no floats in herald JSON).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Ratio {
    pub num: u32,
    pub den: u32,
}

impl Ratio {
    pub fn bps(&self) -> u32 {
        if self.den == 0 {
            0
        } else {
            ((self.num as u64 * 10_000) / self.den as u64) as u32
        }
    }
    fn json(self) -> String {
        format!(
            "{{\"num\":{},\"den\":{},\"bps\":{}}}",
            self.num,
            self.den,
            self.bps()
        )
    }
    fn from_json(v: &Value, at: &str) -> Result<Self, FormatError> {
        let o = obj(v, at)?;
        let r = Self {
            num: int(o, "num", 0, U32, at)? as u32,
            den: int(o, "den", 0, U32, at)? as u32,
        };
        ensure(r.num <= r.den || r.den == 0, BAD_VALUE, || {
            format!("{at}: num > den")
        })?;
        ensure(
            int(o, "bps", 0, 10_000, at)? == r.bps() as i64,
            BAD_VALUE,
            || format!("{at}: bps is not num/den"),
        )?;
        Ok(r)
    }
}

/// The holding contest of the season (§13.4 10h).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct HoldingContest {
    pub sieges_declared: u32,
    pub sieges_completed: u32,
    pub sieges_failed: u32,
    pub occupations: u32,
    pub liberations: u32,
    pub captures: u32,
    pub outposts: u32,
}

/// The movement summary of §13.4 (criterion 10's figures, from the
/// season's `PSFCT1` series with `control::lasting_changes` and
/// `march_banner`; CQ3-B's decider gates them, this file only reports).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Movement {
    /// 10a: lasting changes in the season.
    pub lasting_changes: u32,
    /// Lasting changes per game day (day 0 first).
    pub lasting_by_day: Vec<u32>,
    /// 10b: game days 2–7 (1-based) with ≥ 1 lasting change.
    pub days_with_change: u32,
    /// 10c: provinces of P with ≥ 2 distinct controllers.
    pub two_controllers: Ratio,
    /// 10d: March banner changes; Marches with ≥ 2 banners.
    pub banner_changes: u32,
    pub marches_two_banners: Ratio,
    /// 10e′ over P′ and v1.1's 10e over P₂ (reported).
    pub net_movement: Ratio,
    pub net_movement_10e: Ratio,
    /// 10f: factions with ≥ 1 lasting gain and ≥ 1 lasting loss.
    pub breadth: u32,
    /// 10g: largest and smallest faction share of controlled provinces.
    pub largest: Ratio,
    pub smallest: Ratio,
    pub holding_contest: HoldingContest,
    /// 10i: first holdings that changed owner (captures of an order-1 site).
    pub first_holdings_transferred: u32,
}

/// A Chronicle title (R-10, display only).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Title {
    pub title: String,
    pub tag: u64,
    pub faction: u8,
    pub value: u32,
}

/// `/h/season/final.json` (immutable, after EndSeason and the last fold).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FinalFile {
    pub season: u64,
    pub end_bell: u32,
    /// `sha256` of `/h/control/{end_bell − 1}.bin`.
    pub control_sha256: [u8; 32],
    pub standings: Option<StandingsLatest>,
    pub movement: Movement,
    pub titles: Vec<Title>,
}

impl FinalFile {
    pub fn to_json(&self) -> Result<String, FormatError> {
        ensure(self.end_bell >= 1, BAD_VALUE, || "endBell 0".into())?;
        let m = &self.movement;
        let hc = &m.holding_contest;
        let days: Vec<String> = m.lasting_by_day.iter().map(|d| d.to_string()).collect();
        let movement = format!(
            "{{\"lastingChanges\":{},\"lastingByDay\":[{}],\"daysWithChange\":{},\"twoControllers\":{},\"bannerChanges\":{},\"marchesTwoBanners\":{},\"netMovement\":{},\"netMovement10e\":{},\"breadth\":{},\"largest\":{},\"smallest\":{},\"holdingContest\":{{\"siegesDeclared\":{},\"siegesCompleted\":{},\"siegesFailed\":{},\"occupations\":{},\"liberations\":{},\"captures\":{},\"outposts\":{}}},\"firstHoldingsTransferred\":{}}}",
            m.lasting_changes,
            days.join(","),
            m.days_with_change,
            m.two_controllers.json(),
            m.banner_changes,
            m.marches_two_banners.json(),
            m.net_movement.json(),
            m.net_movement_10e.json(),
            m.breadth,
            m.largest.json(),
            m.smallest.json(),
            hc.sieges_declared,
            hc.sieges_completed,
            hc.sieges_failed,
            hc.occupations,
            hc.liberations,
            hc.captures,
            hc.outposts,
            m.first_holdings_transferred
        );
        let titles: Vec<String> = self
            .titles
            .iter()
            .map(|t| {
                format!(
                    "{{\"title\":{},\"tag\":{},\"faction\":{},\"value\":{}}}",
                    js(&t.title),
                    js(&tag_hex(t.tag)),
                    t.faction,
                    t.value
                )
            })
            .collect();
        let standings = match &self.standings {
            Some(s) => s.body(),
            None => "null".into(),
        };
        Ok(format!(
            "{{\"v\":1,\"official\":false,\"season\":{},\"endBell\":{},\"control\":{{\"bell\":{},\"file\":{},\"sha256\":{}}},\"standings\":{},\"movement\":{},\"titles\":[{}]}}",
            js(&self.season.to_string()),
            self.end_bell,
            self.end_bell - 1,
            js(&format!("/h/control/{}.bin", self.end_bell - 1)),
            js(&hex::encode(self.control_sha256)),
            standings,
            movement,
            titles.join(",")
        ))
    }

    /// Checks: JSON, `v`, the control reference, the standings, the ratios.
    pub fn parse(b: &[u8]) -> Result<Self, FormatError> {
        let v = parse_json(b)?;
        let o = obj(&v, "file")?;
        version(o)?;
        let at = "file";
        let end_bell = int(o, "endBell", 1, U32, at)? as u32;
        let c = obj(field(o, "control", at)?, "control")?;
        ensure(
            int(c, "bell", 0, U32, "control")? == end_bell as i64 - 1
                && string(c, "file", "control")? == format!("/h/control/{}.bin", end_bell - 1),
            BAD_VALUE,
            || "control: not the bell end_bell − 1".into(),
        )?;
        let standings = match field(o, "standings", at)? {
            Value::Null => None,
            s => Some(StandingsLatest::from_value(s, "standings")?),
        };
        let mo = obj(field(o, "movement", at)?, "movement")?;
        let w = "movement";
        let hc = obj(field(mo, "holdingContest", w)?, "holdingContest")?;
        let h = |k: &str| int(hc, k, 0, U32, "holdingContest").map(|x| x as u32);
        let r = |k: &str| Ratio::from_json(field(mo, k, w)?, k);
        let movement = Movement {
            lasting_changes: int(mo, "lastingChanges", 0, U32, w)? as u32,
            lasting_by_day: arr(mo, "lastingByDay", w)?
                .iter()
                .map(|d| {
                    d.as_u64()
                        .filter(|x| *x <= u32::MAX as u64)
                        .map(|x| x as u32)
                        .ok_or_else(|| FormatError {
                            code: BAD_SCHEMA,
                            detail: "lastingByDay: not an integer".into(),
                        })
                })
                .collect::<Result<Vec<_>, _>>()?,
            days_with_change: int(mo, "daysWithChange", 0, 6, w)? as u32,
            two_controllers: r("twoControllers")?,
            banner_changes: int(mo, "bannerChanges", 0, U32, w)? as u32,
            marches_two_banners: r("marchesTwoBanners")?,
            net_movement: r("netMovement")?,
            net_movement_10e: r("netMovement10e")?,
            breadth: int(mo, "breadth", 0, 6, w)? as u32,
            largest: r("largest")?,
            smallest: r("smallest")?,
            holding_contest: HoldingContest {
                sieges_declared: h("siegesDeclared")?,
                sieges_completed: h("siegesCompleted")?,
                sieges_failed: h("siegesFailed")?,
                occupations: h("occupations")?,
                liberations: h("liberations")?,
                captures: h("captures")?,
                outposts: h("outposts")?,
            },
            first_holdings_transferred: int(mo, "firstHoldingsTransferred", 0, U32, w)? as u32,
        };
        ensure(
            movement
                .lasting_by_day
                .iter()
                .map(|&x| x as u64)
                .sum::<u64>()
                == movement.lasting_changes as u64,
            BAD_VALUE,
            || "lastingByDay does not sum to lastingChanges".into(),
        )?;
        let titles = arr(o, "titles", at)?
            .iter()
            .enumerate()
            .map(|(i, t)| {
                let w = format!("titles[{i}]");
                let to = obj(t, &w)?;
                Ok(Title {
                    title: string(to, "title", &w)?.to_string(),
                    tag: tag(to, "tag", &w)?,
                    faction: int(to, "faction", 0, 5, &w)? as u8,
                    value: int(to, "value", 0, U32, &w)? as u32,
                })
            })
            .collect::<Result<Vec<_>, FormatError>>()?;
        let season = u64_str(o, "season", at)?;
        Ok(Self {
            season,
            end_bell,
            control_sha256: hex32(c, "sha256", "control")?,
            standings,
            movement,
            titles,
        })
    }
}

// ------------------------------------------------------------------ WS `kind:"siege"`

/// A WS `siege` message's body: the sieges and keep contests of `bell`
/// that are new or changed since the previous bell's file (`upsert`), the
/// siege keys and keep provinces that left it (`remove`, `keepsRemove`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SiegeDelta {
    pub bell: u32,
    pub upsert: Vec<SiegeEntry>,
    pub remove: Vec<String>,
    pub keeps: Vec<KeepContest>,
    pub keeps_remove: Vec<(i32, i32)>,
}

impl SiegeDelta {
    /// The delta from `prev` to `cur` (`None` when nothing changed).
    pub fn between(prev: Option<&SiegesFile>, cur: &SiegesFile) -> Option<SiegeDelta> {
        let empty = SiegesFile {
            bell: 0,
            sieges: vec![],
            keeps: vec![],
        };
        let prev = prev.unwrap_or(&empty);
        let upsert: Vec<SiegeEntry> = cur
            .sieges
            .iter()
            .filter(|s| !prev.sieges.contains(s))
            .cloned()
            .collect();
        let remove: Vec<String> = prev
            .sieges
            .iter()
            .filter(|s| !cur.sieges.iter().any(|c| c.key() == s.key()))
            .map(SiegeEntry::key)
            .collect();
        let keeps: Vec<KeepContest> = cur
            .keeps
            .iter()
            .filter(|k| !prev.keeps.contains(k))
            .cloned()
            .collect();
        let keeps_remove: Vec<(i32, i32)> = prev
            .keeps
            .iter()
            .filter(|k| !cur.keeps.iter().any(|c| (c.p, c.q) == (k.p, k.q)))
            .map(|k| (k.p, k.q))
            .collect();
        if upsert.is_empty() && remove.is_empty() && keeps.is_empty() && keeps_remove.is_empty() {
            return None;
        }
        Some(SiegeDelta {
            bell: cur.bell,
            upsert,
            remove,
            keeps,
            keeps_remove,
        })
    }

    pub fn to_json(&self) -> String {
        let up: Vec<String> = self.upsert.iter().map(SiegeEntry::to_json).collect();
        let rm: Vec<String> = self.remove.iter().map(|k| js(k)).collect();
        let ks: Vec<String> = self.keeps.iter().map(KeepContest::to_json).collect();
        let kr: Vec<String> = self
            .keeps_remove
            .iter()
            .map(|(p, q)| format!("[{p},{q}]"))
            .collect();
        format!(
            "{{\"v\":1,\"bell\":{},\"upsert\":[{}],\"remove\":[{}],\"keeps\":[{}],\"keepsRemove\":[{}]}}",
            self.bell,
            up.join(","),
            rm.join(","),
            ks.join(","),
            kr.join(",")
        )
    }
}

// ------------------------------------------------------------------ CQ2-E vectors

/// The CQ2-E JSON vectors (`frontier-node/crates/herald/vectors/cq-json/`):
/// one producer ([`cq2e_vectors::files`]), one freshness test
/// (`cq_json_vectors_fresh`; `FRONTIER_WRITE_FIXTURES=1 cargo test -p herald
/// cq_json_vectors_fresh` rewrites them). `index.json` names each valid
/// file and each invalid one with the code its reader refuses it with.
pub mod cq2e_vectors {
    use super::*;
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    pub fn dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("vectors/cq-json")
    }

    pub fn sample_latest() -> StandingsLatest {
        let mut factions = [FactionStanding::default(); 6];
        for (f, s) in factions.iter_mut().enumerate() {
            let f16 = f as u16;
            *s = FactionStanding {
                row: FactionHour {
                    provinces: 10 + f16,
                    banners: f16 % 3,
                    keeps_taken: 2 * f16,
                    keeps_lost: 5 - f16,
                    dominion_bells: 600 + 6 * f as u32,
                    captures: f16,
                    occupations_active: f16 % 2,
                    sieges_won: 3 + f16,
                    sieges_lost: 1,
                    liberations: f16 / 2,
                    holdings: 40 + f16,
                    members_active: 30 + f16,
                },
                members: 33 + f as u32,
                dominion: 600 + 6 * f as u64 + 36 * f as u64,
                index: 900_000 + 20_000 * f as u64,
            };
        }
        StandingsLatest {
            hour: 47,
            bell: 287,
            factions,
        }
    }

    pub fn sample_players() -> PlayersFile {
        let rows = (0..9u64).map(|i| PlayerRow {
            tag: 0x1000 + i * 0x0101_0101,
            faction: (i % 3) as u8,
            rank: 0,
            keeps_taken: (i % 4) as u32,
            keep_bells: (17 * i % 50) as u32,
            sieges_won: (i % 2) as u32,
            captures: (i / 4) as u32,
            liberations: 0,
        });
        PlayersFile::ranked(300, rows)
    }

    pub fn sample_call() -> CallFile {
        CallFile {
            day: 2,
            bell: 288,
            day_seed: call_day_seed(&[7u8; 32], 2),
            calls: [
                Some((MarchCoord { m: 1, n: 0 }, false)),
                None,
                Some((MarchCoord { m: -1, n: 2 }, false)),
                Some((MarchCoord { m: 0, n: -2 }, true)),
                None,
                Some((MarchCoord { m: 2, n: -1 }, false)),
            ],
        }
    }

    fn sig(n: u8) -> String {
        let mut s = [0u8; 64];
        s[0] = n;
        s[8] = 0xF1;
        solana_address::Address::new_from_array(s[..32].try_into().unwrap_or([0; 32])).to_string()
    }

    pub fn sample_siege() -> SiegeHistory {
        SiegeHistory {
            p: 3,
            q: -1,
            site: 2,
            declared: 100,
            kind: SiegeKind::First,
            owner: Some(0x0102_0304_0506_0708),
            owner_faction: 1,
            attacker: 0x1122_3344_5566_7788,
            attacker_faction: 4,
            required: 36,
            horn: RecordRef {
                kind: "siege_declared".into(),
                bell: 100,
                seq: 812,
                sig: sig(1),
                detail: serde_json::json!({"stake": 500, "required": 36}),
            },
            series: (101..106u32)
                .map(|b| SiegeBell {
                    bell: b,
                    holds: true,
                    defender: b == 104,
                    vigil: false,
                    progress: (b - 100).min(3) as u8,
                })
                .collect(),
            end: Some(SiegeEnd {
                bell: 105,
                outcome: SiegeOutcome::Failed,
                broken_by_defender: true,
                credited: None,
            }),
            followed: vec![RecordRef {
                kind: "siege_settled".into(),
                bell: 107,
                seq: 901,
                sig: sig(2),
                detail: serde_json::json!({"reason": 0, "amount": 500}),
            }],
        }
    }

    pub fn sample_keep() -> KeepHistory {
        KeepHistory {
            p: -2,
            q: 4,
            tile: 17,
            holder: 3,
            since: 141,
            troops: 2_500,
            gen: 1,
            heartland: false,
            holders: vec![(0, 0), (3, 141)],
            contests: vec![
                ContestRec {
                    contender: 5,
                    from: 30,
                    to: Some(40),
                    outcome: ContestOutcome::Broken,
                    progress: 10,
                },
                ContestRec {
                    contender: 3,
                    from: 69,
                    to: Some(140),
                    outcome: ContestOutcome::Taken,
                    progress: 72,
                },
                ContestRec {
                    contender: 0,
                    from: 200,
                    to: None,
                    outcome: ContestOutcome::Running,
                    progress: 4,
                },
            ],
            captures: vec![KeepCapture {
                bell: 140,
                from: 0,
                to: 3,
                troops: 2_500,
                donor: 0x0002_0003_0001_0007,
                seq: 777,
                sig: sig(3),
            }],
        }
    }

    pub fn sample_final() -> FinalFile {
        FinalFile {
            season: 5,
            end_bell: 1_008,
            control_sha256: [0xAB; 32],
            standings: Some(sample_latest()),
            movement: Movement {
                lasting_changes: 9,
                lasting_by_day: vec![0, 1, 2, 2, 1, 1, 2],
                days_with_change: 6,
                two_controllers: Ratio { num: 30, den: 120 },
                banner_changes: 7,
                marches_two_banners: Ratio { num: 5, den: 30 },
                net_movement: Ratio { num: 12, den: 100 },
                net_movement_10e: Ratio { num: 4, den: 40 },
                breadth: 5,
                largest: Ratio { num: 22, den: 120 },
                smallest: Ratio { num: 15, den: 120 },
                holding_contest: HoldingContest {
                    sieges_declared: 30,
                    sieges_completed: 14,
                    sieges_failed: 9,
                    occupations: 11,
                    liberations: 4,
                    captures: 6,
                    outposts: 12,
                },
                first_holdings_transferred: 0,
            },
            titles: vec![
                Title {
                    title: "Breaker of Keeps".into(),
                    tag: 0x1000,
                    faction: 0,
                    value: 3,
                },
                Title {
                    title: "Warden of the Marches".into(),
                    tag: 0x2000,
                    faction: 2,
                    value: 49,
                },
            ],
        }
    }

    /// Every vector file, by name (one producer).
    pub fn files() -> BTreeMap<String, Vec<u8>> {
        let mut files: BTreeMap<String, Vec<u8>> = BTreeMap::new();
        let mut index: Vec<Value> = Vec::new();
        let mut valid =
            |files: &mut BTreeMap<String, Vec<u8>>, format: &str, name: &str, b: String| {
                files.insert(name.into(), b.into_bytes());
                index
                    .push(serde_json::json!({"format": format, "file": name, "code": Value::Null}));
            };
        let l = sample_latest().to_json().expect("latest");
        let p = sample_players().to_json().expect("players");
        let c = sample_call().to_json().expect("call");
        let s = sample_siege().to_json().expect("siege");
        let k = sample_keep().to_json().expect("keep");
        let f = sample_final().to_json().expect("final");
        valid(
            &mut files,
            "standingsLatest",
            "standings-latest.json",
            l.clone(),
        );
        valid(&mut files, "players", "players.json", p.clone());
        valid(&mut files, "call", "call-d2.json", c.clone());
        valid(&mut files, "siege", "siege-3,-1,2-100.json", s.clone());
        valid(&mut files, "keep", "keep--2,4.json", k.clone());
        valid(&mut files, "final", "final.json", f.clone());
        let e = PlayersFile {
            bell: 0,
            players: vec![],
        };
        valid(
            &mut files,
            "players",
            "players-empty.json",
            e.to_json().expect("empty"),
        );
        let mut bad = |files: &mut BTreeMap<String, Vec<u8>>,
                       format: &str,
                       name: &str,
                       code: &str,
                       b: String| {
            files.insert(name.into(), b.into_bytes());
            index.push(serde_json::json!({"format": format, "file": name, "code": code}));
        };
        bad(
            &mut files,
            "standingsLatest",
            "bad-latest-official.json",
            BAD_VALUE,
            l.replacen("\"official\":false", "\"official\":true", 1),
        );
        bad(
            &mut files,
            "standingsLatest",
            "bad-latest-order.json",
            BAD_ORDER,
            l.replacen("{\"faction\":1,", "{\"faction\":2,", 1),
        );
        bad(
            &mut files,
            "players",
            "bad-players-rank.json",
            BAD_ORDER,
            p.replacen("\"rank\":2", "\"rank\":3", 1),
        );
        bad(
            &mut files,
            "players",
            "bad-players-tag.json",
            BAD_VALUE,
            p.replacen("\"tag\":\"", "\"tag\":\"X", 1),
        );
        bad(
            &mut files,
            "call",
            "bad-call-rally.json",
            BAD_VALUE,
            c.replacen(
                "\"march\":null,\"rally\":false",
                "\"march\":null,\"rally\":true",
                1,
            ),
        );
        bad(
            &mut files,
            "call",
            "bad-call-seed.json",
            BAD_VALUE,
            c.replacen("\"daySeed\":\"", "\"daySeed\":\"0", 1),
        );
        bad(
            &mut files,
            "siege",
            "bad-siege-key.json",
            BAD_VALUE,
            s.replacen("sg:3,-1,2,100", "sg:3,-1,2,101", 1),
        );
        bad(
            &mut files,
            "siege",
            "bad-siege-series.json",
            BAD_ORDER,
            s.replacen("{\"bell\":102,", "{\"bell\":101,", 1),
        );
        bad(
            &mut files,
            "keep",
            "bad-keep-holders.json",
            BAD_VALUE,
            k.replacen(
                "\"holder\":3,\"since\":141}",
                "\"holder\":4,\"since\":141}",
                1,
            ),
        );
        bad(
            &mut files,
            "keep",
            "bad-keep-running.json",
            BAD_VALUE,
            k.replacen("\"to\":null", "\"to\":201", 1),
        );
        bad(
            &mut files,
            "final",
            "bad-final-control.json",
            BAD_VALUE,
            f.replacen("\"bell\":1007,", "\"bell\":1006,", 1),
        );
        bad(
            &mut files,
            "final",
            "bad-final-bps.json",
            BAD_VALUE,
            f.replacen(
                "\"num\":30,\"den\":120,\"bps\":2500",
                "\"num\":30,\"den\":120,\"bps\":2501",
                1,
            ),
        );
        bad(
            &mut files,
            "final",
            "bad-final-days.json",
            BAD_VALUE,
            f.replacen("\"lastingByDay\":[0,", "\"lastingByDay\":[1,", 1),
        );
        bad(
            &mut files,
            "final",
            "bad-final-json.json",
            BAD_JSON,
            f[..f.len() - 1].to_string(),
        );
        let idx = serde_json::json!({
            "v": 1,
            "producer": "frontier-node/crates/herald/src/cqfmt.rs (cq2e_vectors::files); FRONTIER_WRITE_FIXTURES=1 cargo test -p herald cq_json_vectors_fresh",
            "files": index,
        });
        files.insert(
            "index.json".into(),
            (serde_json::to_string_pretty(&idx).unwrap_or_default() + "\n").into_bytes(),
        );
        files
    }

    /// Parses `b` as `format`; `Err(code)` on refusal.
    pub fn read(format: &str, b: &[u8]) -> Result<(), &'static str> {
        let r = match format {
            "standingsLatest" => StandingsLatest::parse(b).map(|_| ()),
            "players" => PlayersFile::parse(b).map(|_| ()),
            "call" => CallFile::parse(b).map(|_| ()),
            "siege" => SiegeHistory::parse(b).map(|_| ()),
            "keep" => KeepHistory::parse(b).map(|_| ()),
            "final" => FinalFile::parse(b).map(|_| ()),
            _ => return Err("UnknownFormat"),
        };
        r.map_err(|e| e.code)
    }
}

#[cfg(test)]
mod cq2e_tests {
    use super::cq2e_vectors::*;
    use super::*;

    #[test]
    fn cq_json_round_trips() {
        let l = sample_latest();
        assert_eq!(
            StandingsLatest::parse(l.to_json().unwrap().as_bytes()).unwrap(),
            l
        );
        let p = sample_players();
        assert_eq!(
            PlayersFile::parse(p.to_json().unwrap().as_bytes()).unwrap(),
            p
        );
        assert!(p.players.iter().all(|r| r.rank >= 1));
        let c = sample_call();
        assert_eq!(CallFile::parse(c.to_json().unwrap().as_bytes()).unwrap(), c);
        let s = sample_siege();
        assert_eq!(
            SiegeHistory::parse(s.to_json().unwrap().as_bytes()).unwrap(),
            s
        );
        let k = sample_keep();
        assert_eq!(
            KeepHistory::parse(k.to_json().unwrap().as_bytes()).unwrap(),
            k
        );
        let f = sample_final();
        assert_eq!(
            FinalFile::parse(f.to_json().unwrap().as_bytes()).unwrap(),
            f
        );
        assert_eq!(Ratio { num: 1, den: 3 }.bps(), 3_333);
        assert_eq!(Ratio { num: 0, den: 0 }.bps(), 0);
    }

    #[test]
    fn cq_players_ranked_cut_at_100() {
        let rows = (0..250u64).map(|i| PlayerRow {
            tag: i + 1,
            faction: (i % 2) as u8,
            keeps_taken: (i % 7) as u32,
            ..Default::default()
        });
        let f = PlayersFile::ranked(9, rows);
        assert_eq!(f.players.len(), 200);
        assert!(f.to_json().is_ok());
        assert_eq!(f.players[0].keeps_taken, 6);
        assert_eq!(f.players[0].rank, 1);
    }

    #[test]
    fn cq_siege_delta() {
        let a = vectors::sample_sieges();
        let mut b = a.clone();
        b.bell += 1;
        b.sieges[0].progress += 1;
        b.sieges.remove(2);
        b.keeps.remove(1);
        let d = SiegeDelta::between(Some(&a), &b).unwrap();
        assert_eq!(d.upsert.len(), 1);
        assert_eq!(d.remove, vec![a.sieges[2].key()]);
        assert_eq!(d.keeps_remove, vec![(5, -1)]);
        assert!(SiegeDelta::between(Some(&b), &b).is_none());
        let v: Value = serde_json::from_str(&d.to_json()).unwrap();
        assert_eq!(v["bell"], 401);
    }

    #[test]
    fn cq_json_vectors_fresh() {
        let want = files();
        let dir = dir();
        if std::env::var("FRONTIER_WRITE_FIXTURES").is_ok() {
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            for (k, v) in &want {
                std::fs::write(dir.join(k), v).unwrap();
            }
        }
        let mut have = std::collections::BTreeMap::new();
        for e in
            std::fs::read_dir(&dir).expect("vectors/cq-json (FRONTIER_WRITE_FIXTURES=1 writes it)")
        {
            let p = e.unwrap().path();
            have.insert(
                p.file_name().unwrap().to_string_lossy().to_string(),
                std::fs::read(&p).unwrap(),
            );
        }
        assert_eq!(
            have.keys().collect::<Vec<_>>(),
            want.keys().collect::<Vec<_>>(),
            "stale file set: FRONTIER_WRITE_FIXTURES=1 cargo test -p herald cq_json_vectors_fresh"
        );
        for (k, v) in &want {
            assert!(have[k] == *v, "{k} is stale: FRONTIER_WRITE_FIXTURES=1 cargo test -p herald cq_json_vectors_fresh");
        }
        // every valid file reads; every invalid one is refused with its code
        let idx: Value = serde_json::from_slice(&want["index.json"]).unwrap();
        for e in idx["files"].as_array().unwrap() {
            let (fmt, name) = (e["format"].as_str().unwrap(), e["file"].as_str().unwrap());
            let got = read(fmt, &want[name]);
            match e["code"].as_str() {
                None => assert_eq!(got, Ok(()), "{name}"),
                Some(c) => assert_eq!(got, Err(c), "{name}"),
            }
        }
    }
}
