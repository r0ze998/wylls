//! The independent wide economy transition replay over the **recorded
//! fixtures** of `tests/fixtures/wide_economy/<case>/`: five synthetic
//! dispatch cases (harvest, building, wall, tier, train) the program's
//! key-free fixture generator exported from a real host dispatch — the
//! Season bytes, the three snapshots before and after, and the record the
//! handler logged. Nothing here signs, sends or runs the program; the
//! fixtures are the only link to it, and the verdicts are about **one
//! transition each**, never about a Season.
//!
//! Run with
//! `cargo test --locked --offline -p verify --features wide-economy-experimental --test wide_economy`.
#![cfg(feature = "wide-economy-experimental")]

use frontier_abi::layout::header as HDR;
use frontier_abi::v2::layout::player::{citizen as C2, holding as H2};
use frontier_abi::world_index::economy::{
    Action, Snapshots, BUILD_ITEM_TIER_UP, BUILD_ITEM_WALLS, RECEIPT_LEN,
};
use frontier_abi::world_index::event::{
    self, WideEntity, WideKind, WideLink, WideRecord, HEAD_LEN, HOLDING_KEY_LEN,
};
use frontier_abi::world_index::holding::wide_holding as WH;
use verify_core::wide_economy::{
    verify_transition, Refusal, Verified, FULL_SEASON_REPLAY_SUPPORTED, NOT_PROVEN,
};

struct Case {
    name: &'static str,
    season: &'static [u8],
    citizen_pre: &'static [u8],
    holding_pre: &'static [u8],
    province_pre: &'static [u8],
    citizen_post: &'static [u8],
    holding_post: &'static [u8],
    province_post: &'static [u8],
    record: &'static [u8],
}

macro_rules! case {
    ($name:literal) => {
        Case {
            name: $name,
            season: include_bytes!(concat!("fixtures/wide_economy/", $name, "/season.bin")),
            citizen_pre: include_bytes!(concat!(
                "fixtures/wide_economy/",
                $name,
                "/citizen_pre.bin"
            )),
            holding_pre: include_bytes!(concat!(
                "fixtures/wide_economy/",
                $name,
                "/holding_pre.bin"
            )),
            province_pre: include_bytes!(concat!(
                "fixtures/wide_economy/",
                $name,
                "/province_pre.bin"
            )),
            citizen_post: include_bytes!(concat!(
                "fixtures/wide_economy/",
                $name,
                "/citizen_post.bin"
            )),
            holding_post: include_bytes!(concat!(
                "fixtures/wide_economy/",
                $name,
                "/holding_post.bin"
            )),
            province_post: include_bytes!(concat!(
                "fixtures/wide_economy/",
                $name,
                "/province_post.bin"
            )),
            record: include_bytes!(concat!("fixtures/wide_economy/", $name, "/record.bin")),
        }
    };
}

fn cases() -> Vec<Case> {
    vec![
        case!("harvest"),
        case!("building"),
        case!("wall"),
        case!("tier"),
        case!("train"),
    ]
}

impl Case {
    fn before(&self) -> Snapshots<'_> {
        Snapshots {
            citizen: self.citizen_pre,
            holding: self.holding_pre,
            province: self.province_pre,
        }
    }
    fn after(&self) -> Snapshots<'_> {
        Snapshots {
            citizen: self.citizen_post,
            holding: self.holding_post,
            province: self.province_post,
        }
    }
    fn verify(&self) -> Result<Verified, Refusal> {
        verify_transition(self.record, self.season, &self.before(), &self.after())
    }
    fn mirror(&self) -> bool {
        matches!(self.name, "wall" | "tier")
    }
    /// The verdict with one class of input replaced.
    fn verify_with(&self, class: Class, bytes: &[u8]) -> Result<Verified, Refusal> {
        let pick = |c: Class, own: &'static [u8]| -> &[u8] {
            if c == class {
                bytes
            } else {
                own
            }
        };
        let before = Snapshots {
            citizen: pick(Class::CitizenPre, self.citizen_pre),
            holding: pick(Class::HoldingPre, self.holding_pre),
            province: pick(Class::ProvincePre, self.province_pre),
        };
        let after = Snapshots {
            citizen: pick(Class::CitizenPost, self.citizen_post),
            holding: pick(Class::HoldingPost, self.holding_post),
            province: pick(Class::ProvincePost, self.province_post),
        };
        verify_transition(
            pick(Class::Record, self.record),
            pick(Class::Season, self.season),
            &before,
            &after,
        )
    }
    /// `body` with its tail re-sealed the way the chain rule defines it:
    /// each link of the record's kind recomputed by `event::advance` from
    /// the recorded pre-state header over the (possibly altered) body. A
    /// forger who controls the record can always do this, so a refusal of
    /// the result is never the chain's.
    fn resealed_tail(&self, body: &[u8]) -> Vec<u8> {
        let r = WideRecord::decode(body).unwrap();
        let links: Vec<WideLink> = r
            .kind
            .links()
            .iter()
            .map(|e| {
                let pre = match e {
                    WideEntity::Province => self.province_pre,
                    WideEntity::Holding => self.holding_pre,
                };
                let seq =
                    u64::from_le_bytes(pre[HDR::EVENT_SEQ..HDR::EVENT_SEQ + 8].try_into().unwrap());
                let head: [u8; 32] = pre[HDR::EVENT_HEAD..HDR::EVENT_HEAD + 32]
                    .try_into()
                    .unwrap();
                event::advance(*e, seq, &head, r.body_without_tail).unwrap()
            })
            .collect();
        event::encode(r.kind, r.bell, r.key, r.payload, &links).unwrap()
    }
    /// The verdict on `body` with its tail re-sealed ([`Self::resealed_tail`])
    /// **and** the recorded post-state headers advanced to the re-sealed
    /// links: each link's `seq` (LE) and `head` copied into the
    /// corresponding post snapshot's `EVENT_SEQ` / `EVENT_HEAD` ranges.
    /// This is the forger's complete move — a record over an altered body
    /// together with post-states that carry its chain — so the only layer
    /// left to refuse it is the receipt's digest, never the chain nor the
    /// post-state comparison against stale headers.
    fn verify_resealed_with_post(&self, body: &[u8]) -> Result<Verified, Refusal> {
        let sealed = self.resealed_tail(body);
        let r = WideRecord::decode(&sealed).unwrap();
        let mut holding_post = self.holding_post.to_vec();
        let mut province_post = self.province_post.to_vec();
        for l in r.links.iter().flatten() {
            let post: &mut Vec<u8> = match l.entity {
                WideEntity::Province => &mut province_post,
                WideEntity::Holding => &mut holding_post,
            };
            post[HDR::EVENT_SEQ..HDR::EVENT_SEQ + 8].copy_from_slice(&l.seq.to_le_bytes());
            post[HDR::EVENT_HEAD..HDR::EVENT_HEAD + 32].copy_from_slice(&l.head);
        }
        let after = Snapshots {
            citizen: self.citizen_post,
            holding: &holding_post,
            province: &province_post,
        };
        verify_transition(&sealed, self.season, &self.before(), &after)
    }
    fn bytes_of(&self, class: Class) -> &'static [u8] {
        match class {
            Class::Season => self.season,
            Class::CitizenPre => self.citizen_pre,
            Class::HoldingPre => self.holding_pre,
            Class::ProvincePre => self.province_pre,
            Class::CitizenPost => self.citizen_post,
            Class::HoldingPost => self.holding_post,
            Class::ProvincePost => self.province_post,
            Class::Record => self.record,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Class {
    Season,
    CitizenPre,
    HoldingPre,
    ProvincePre,
    CitizenPost,
    HoldingPost,
    ProvincePost,
    Record,
}

const CLASSES: [Class; 8] = [
    Class::Season,
    Class::CitizenPre,
    Class::HoldingPre,
    Class::ProvincePre,
    Class::CitizenPost,
    Class::HoldingPost,
    Class::ProvincePost,
    Class::Record,
];

/// The receipt payload's offset in the record body.
const PAYLOAD_AT: usize = HEAD_LEN + HOLDING_KEY_LEN;
const ACTION_AT: usize = PAYLOAD_AT + 1;
const NOW_AT: usize = ACTION_AT + 6;
const FINAL_AT: usize = NOW_AT + 8;
const INPUT_AT: usize = FINAL_AT + 1;
const OUTPUT_AT: usize = INPUT_AT + 32;
const TAIL_AT: usize = PAYLOAD_AT + RECEIPT_LEN;

fn flipped(bytes: &[u8], at: usize) -> Vec<u8> {
    let mut v = bytes.to_vec();
    v[at] ^= 1;
    v
}

/// Every recorded case verifies as the action its name says, under the
/// kind its action selects, with a province link exactly for the mirror
/// writes; and no verdict claims a Season.
#[test]
fn every_recorded_case_verifies_as_one_transition() {
    assert!(!FULL_SEASON_REPLAY_SUPPORTED);
    assert!(!NOT_PROVEN.is_empty());
    for c in cases() {
        let v = c.verify().unwrap_or_else(|e| panic!("{}: {e}", c.name));
        match (c.name, v.action) {
            ("harvest", Action::Harvest) => {}
            ("building", Action::Build { item }) if item < BUILD_ITEM_WALLS => {}
            ("wall", Action::Build { item }) if item == BUILD_ITEM_WALLS => {}
            ("tier", Action::Build { item }) if item == BUILD_ITEM_TIER_UP => {}
            ("train", Action::Train { n, .. }) if n >= 1 => {}
            (name, a) => panic!("{name}: unexpected action {a:?}"),
        }
        assert_eq!(v.kind, v.action.kind(), "{}", c.name);
        assert_eq!(
            v.kind == WideKind::EconomyMirror,
            c.mirror(),
            "{}: kind {:?}",
            c.name,
            v.kind
        );
        assert_eq!(v.province_link.is_some(), c.mirror(), "{}", c.name);
        assert_eq!(v.holding_ref.seq(), 0, "{}", c.name);
        assert_eq!(v.province_key, v.holding_ref.key(), "{}", c.name);
        assert!(!v.full_season(), "{}", c.name);
        assert_eq!(v.not_proven(), NOT_PROVEN);
        // the record's own fields agree with the verdict
        assert_eq!(c.record[1], v.kind as u8);
        assert_eq!(
            u32::from_le_bytes(c.record[2..6].try_into().unwrap()),
            v.bell
        );
        assert_eq!(
            i64::from_le_bytes(c.record[NOW_AT..NOW_AT + 8].try_into().unwrap()),
            v.now_ts
        );
        assert_eq!(c.record[FINAL_AT] == 1, v.became_final);
        // the post headers carry the links
        assert_eq!(
            u64::from_le_bytes(
                c.holding_post[HDR::EVENT_SEQ..HDR::EVENT_SEQ + 8]
                    .try_into()
                    .unwrap()
            ),
            v.holding_link.seq
        );
        assert_eq!(
            &c.holding_post[HDR::EVENT_HEAD..HDR::EVENT_HEAD + 32],
            &v.holding_link.head
        );
        if !c.mirror() {
            assert_eq!(
                c.province_pre, c.province_post,
                "{}: a holding-only action leaves the province byte for byte",
                c.name
            );
        } else {
            let l = v.province_link.unwrap();
            assert_eq!(
                &c.province_post[HDR::EVENT_HEAD..HDR::EVENT_HEAD + 32],
                &l.head
            );
            assert_ne!(
                &c.province_pre[HDR::EVENT_HEAD..HDR::EVENT_HEAD + 32],
                &c.province_post[HDR::EVENT_HEAD..HDR::EVENT_HEAD + 32]
            );
        }
        // the Citizen moved only by its bucket and last action
        assert_eq!(
            i64::from_le_bytes(
                c.citizen_post[C2::LAST_ACTION_TS..C2::LAST_ACTION_TS + 8]
                    .try_into()
                    .unwrap()
            ),
            v.now_ts
        );
        assert_eq!(
            &c.citizen_pre[..C2::BUCKET_MILLI],
            &c.citizen_post[..C2::BUCKET_MILLI],
            "{}: the Citizen before the bucket (its PS2 header, wallet, flags) is unchanged",
            c.name
        );
        assert_eq!(
            &c.citizen_pre[C2::BUCKET_T + 4..C2::LAST_ACTION_TS],
            &c.citizen_post[C2::BUCKET_T + 4..C2::LAST_ACTION_TS]
        );
        assert_eq!(
            &c.citizen_pre[C2::LAST_ACTION_TS + 8..],
            &c.citizen_post[C2::LAST_ACTION_TS + 8..]
        );
    }
}

/// Every byte of every input class matters: a flip anywhere — the Season,
/// a pre-state (the input digest), a post-state (the whole-byte
/// comparison), the record (its codec, bell, receipt or tail) — refuses.
/// The province is swept at a stride; every other class byte for byte.
#[test]
fn a_flip_anywhere_in_any_input_refuses() {
    for c in cases() {
        for class in CLASSES {
            let bytes = c.bytes_of(class);
            let stride = match class {
                Class::ProvincePre | Class::ProvincePost => 3,
                _ => 1,
            };
            let mut offsets: Vec<usize> = (0..bytes.len()).step_by(stride).collect();
            offsets.push(bytes.len() - 1);
            for at in offsets {
                assert!(
                    c.verify_with(class, &flipped(bytes, at)).is_err(),
                    "{}: {class:?} byte {at} flipped still verifies",
                    c.name
                );
            }
            // a byte short or a byte long
            assert!(
                c.verify_with(class, &bytes[..bytes.len() - 1]).is_err(),
                "{}: {class:?} truncated",
                c.name
            );
            let mut long = bytes.to_vec();
            long.push(0);
            assert!(
                c.verify_with(class, &long).is_err(),
                "{}: {class:?} extended",
                c.name
            );
            assert!(
                c.verify_with(class, &[]).is_err(),
                "{}: {class:?} empty",
                c.name
            );
        }
        // and the untouched inputs still verify after all that
        assert!(c.verify().is_ok(), "{}", c.name);
    }
}

/// The named record fields: the version, the kind (the other economy kind
/// and a non-economy one), the bell, the action, the time, the flip, both
/// digests, the tail's sequence and head.
#[test]
fn record_fields_are_each_checked() {
    for c in cases() {
        let r = c.record;
        let other_kind = if c.mirror() {
            WideKind::Economy
        } else {
            WideKind::EconomyMirror
        };
        let mut k = r.to_vec();
        k[1] = other_kind as u8;
        assert!(
            matches!(c.verify_with(Class::Record, &k), Err(Refusal::Record(_))),
            "{}: the other economy kind",
            c.name
        );
        let mut k = r.to_vec();
        k[1] = WideKind::Muster as u8;
        assert!(matches!(
            c.verify_with(Class::Record, &k),
            Err(Refusal::Record(_))
        ));
        let mut v = r.to_vec();
        v[0] = 0x81;
        assert!(matches!(
            c.verify_with(Class::Record, &v),
            Err(Refusal::Record(_))
        ));
        for at in 2..6 {
            assert!(
                matches!(
                    c.verify_with(Class::Record, &flipped(r, at)),
                    Err(Refusal::Record(_))
                ),
                "{}: bell byte {at}",
                c.name
            );
        }
        for at in ACTION_AT..NOW_AT {
            assert!(
                c.verify_with(Class::Record, &flipped(r, at)).is_err(),
                "{}: action byte {at}",
                c.name
            );
        }
        for at in NOW_AT..FINAL_AT {
            assert!(
                c.verify_with(Class::Record, &flipped(r, at)).is_err(),
                "{}: now_ts byte {at}",
                c.name
            );
        }
        // the flip byte: the other value is a finality refusal; 2 is not a bool
        let mut f = r.to_vec();
        f[FINAL_AT] ^= 1;
        assert!(
            matches!(c.verify_with(Class::Record, &f), Err(Refusal::Finality(_))),
            "{}: became_final toggled",
            c.name
        );
        let mut f = r.to_vec();
        f[FINAL_AT] = 2;
        assert!(matches!(
            c.verify_with(Class::Record, &f),
            Err(Refusal::Record(_))
        ));
        // the re-seal itself is sound: over the untouched body it gives the
        // recorded tail byte for byte
        assert_eq!(
            c.resealed_tail(r),
            r,
            "{}: re-sealing the recorded tail",
            c.name
        );
        // the input digest: judged before the staging, with the original
        // tail and with the tail re-sealed over the changed body alike
        let i = flipped(r, INPUT_AT + 5);
        assert!(
            matches!(c.verify_with(Class::Record, &i), Err(Refusal::Digest(_))),
            "{}: input digest, original tail",
            c.name
        );
        assert!(
            matches!(
                c.verify_with(Class::Record, &c.resealed_tail(&i)),
                Err(Refusal::Digest(_))
            ),
            "{}: input digest, tail re-sealed",
            c.name
        );
        // the output digest: every layer holds. With the original tail the
        // changed body no longer hashes to the recorded links (Chain). With
        // the tail re-sealed over it from the pre-state headers but the
        // recorded post-states left as they are, the expected post headers
        // (which carry the re-sealed links) differ from the supplied ones,
        // and the post-state comparison refuses first (Holding, or Province
        // for a mirror kind) — judged before the output digest. With the
        // post headers advanced to the re-sealed links too, the digest
        // itself is what does not recompute (Digest).
        let o = flipped(r, OUTPUT_AT + 5);
        assert!(
            matches!(c.verify_with(Class::Record, &o), Err(Refusal::Chain(_))),
            "{}: output digest, original tail",
            c.name
        );
        assert!(
            matches!(
                c.verify_with(Class::Record, &c.resealed_tail(&o)),
                Err(Refusal::Holding(_) | Refusal::Province(_))
            ),
            "{}: output digest, tail re-sealed, stale post headers",
            c.name
        );
        assert!(
            matches!(c.verify_resealed_with_post(&o), Err(Refusal::Digest(_))),
            "{}: output digest, tail re-sealed, post headers advanced",
            c.name
        );
        // the tail: `n_links ‖ (entity ‖ seq ‖ head)*`
        assert!(c.verify_with(Class::Record, &flipped(r, TAIL_AT)).is_err());
        let first_seq = TAIL_AT + 2;
        assert!(
            matches!(
                c.verify_with(Class::Record, &flipped(r, first_seq)),
                Err(Refusal::Chain(_))
            ),
            "{}: first link sequence",
            c.name
        );
        assert!(
            matches!(
                c.verify_with(Class::Record, &flipped(r, r.len() - 1)),
                Err(Refusal::Chain(_))
            ),
            "{}: last link head byte",
            c.name
        );
    }
}

/// Unaffected fields of the post-states are compared too: the holding's
/// shield and trailer, the Citizen's flags and its own PS2 header, and the
/// province's header — which a holding-only action must leave exactly as
/// it was (no link, no "missing" header), and a mirror write must advance.
#[test]
fn unaffected_fields_and_headers_are_part_of_the_verdict() {
    for c in cases() {
        // the shield: the replay's adapter keeps it; a rewrite is caught
        let mut h = c.holding_post.to_vec();
        h[H2::SHIELD_UNTIL] ^= 1;
        assert!(
            matches!(
                c.verify_with(Class::HoldingPost, &h),
                Err(Refusal::Holding(_))
            ),
            "{}: shield",
            c.name
        );
        // the trailer (world byte, reserved byte)
        for at in [WH::WORLD, WH::RSV, WH::SIZE - 1] {
            let mut h = c.holding_post.to_vec();
            h[at] ^= 1;
            assert!(
                matches!(
                    c.verify_with(Class::HoldingPost, &h),
                    Err(Refusal::Holding(_))
                ),
                "{}: trailer byte {at}",
                c.name
            );
        }
        // the holding's own header: a stale sequence or head
        let mut h = c.holding_post.to_vec();
        h[HDR::EVENT_SEQ..HDR::EVENT_SEQ + 8]
            .copy_from_slice(&c.holding_pre[HDR::EVENT_SEQ..HDR::EVENT_SEQ + 8]);
        assert!(matches!(
            c.verify_with(Class::HoldingPost, &h),
            Err(Refusal::Holding(_))
        ));
        // the Citizen: flags, the first-home finality flag, the PS2 header
        let mut z = c.citizen_post.to_vec();
        z[C2::FLAGS] ^= C2::FLAG_FIRST_HOLDING_FINAL;
        assert!(
            matches!(
                c.verify_with(Class::CitizenPost, &z),
                Err(Refusal::Citizen(_))
            ),
            "{}: citizen flag",
            c.name
        );
        let mut z = c.citizen_post.to_vec();
        z[HDR::EVENT_SEQ] ^= 1;
        assert!(matches!(
            c.verify_with(Class::CitizenPost, &z),
            Err(Refusal::Citizen(_))
        ));
        let mut z = c.citizen_post.to_vec();
        z[C2::BUCKET_MILLI] ^= 1;
        assert!(matches!(
            c.verify_with(Class::CitizenPost, &z),
            Err(Refusal::Citizen(_))
        ));
        let mut z = c.citizen_post.to_vec();
        z[C2::LAST_ACTION_TS] ^= 1;
        assert!(matches!(
            c.verify_with(Class::CitizenPost, &z),
            Err(Refusal::Citizen(_))
        ));
        // the province header
        let mut p = c.province_post.to_vec();
        let seq = u64::from_le_bytes(p[HDR::EVENT_SEQ..HDR::EVENT_SEQ + 8].try_into().unwrap());
        if c.mirror() {
            // a mirror write that did not advance the province chain
            p[HDR::EVENT_SEQ..HDR::EVENT_SEQ + 8].copy_from_slice(&(seq - 1).to_le_bytes());
        } else {
            // a holding-only action whose province "advanced"
            p[HDR::EVENT_SEQ..HDR::EVENT_SEQ + 8].copy_from_slice(&(seq + 1).to_le_bytes());
        }
        assert!(
            matches!(
                c.verify_with(Class::ProvincePost, &p),
                Err(Refusal::Province(_))
            ),
            "{}: province header",
            c.name
        );
        let mut p = c.province_post.to_vec();
        p[HDR::EVENT_HEAD] ^= 1;
        assert!(matches!(
            c.verify_with(Class::ProvincePost, &p),
            Err(Refusal::Province(_))
        ));
        if !c.mirror() {
            // the pre-state province in the post position is the right answer;
            // the mirror case's pre-state is not
            assert!(c.verify_with(Class::ProvincePost, c.province_pre).is_ok());
        } else {
            assert!(matches!(
                c.verify_with(Class::ProvincePost, c.province_pre),
                Err(Refusal::Province(_))
            ));
        }
    }
}

/// A pre-state the receipt does not commit to is refused by the **input
/// digest**, before any replay arithmetic — whatever numbers it carries.
/// The holding's terrain ore, last owner action, a store's settle instant
/// and a store's fraction at the ends of `i64` (each of which the kernel's
/// unchecked arithmetic would otherwise overflow) are `Digest` refusals
/// here, never panics; the untouched case still verifies after each.
#[test]
fn a_corrupted_pre_state_is_refused_by_the_receipt_before_any_arithmetic() {
    use frontier_abi::layout::player::accrual;
    for c in cases() {
        let at = |o: usize, v: i64| -> Vec<u8> {
            let mut h = c.holding_pre.to_vec();
            h[o..o + 8].copy_from_slice(&v.to_le_bytes());
            h
        };
        for (what, h) in [
            ("terrain ore", at(H2::TERRAIN_ORE, i64::MAX)),
            ("last owner action", at(H2::LAST_OWNER_ACTION, i64::MAX)),
            ("store 0 t0", at(H2::store(0) + accrual::T0, i64::MIN)),
            ("store 0 frac −1", at(H2::store(0) + accrual::FRAC, -1)),
            (
                "store 0 frac max",
                at(H2::store(0) + accrual::FRAC, i64::MAX),
            ),
        ] {
            assert!(
                matches!(
                    c.verify_with(Class::HoldingPre, &h),
                    Err(Refusal::Digest(_))
                ),
                "{}: {what}",
                c.name
            );
        }
        assert!(c.verify().is_ok(), "{}", c.name);
    }
}

/// A record over another case's snapshots, and another case's record over
/// these snapshots, both refuse: the verdict binds the record to exactly
/// the state it was logged over.
#[test]
fn records_and_snapshots_of_different_cases_do_not_mix() {
    let all = cases();
    for a in &all {
        for b in &all {
            if a.name == b.name {
                continue;
            }
            assert!(
                verify_transition(b.record, a.season, &a.before(), &a.after()).is_err(),
                "{} snapshots verify under {}'s record",
                a.name,
                b.name
            );
            assert!(
                verify_transition(a.record, a.season, &a.before(), &b.after()).is_err(),
                "{} record verifies into {}'s post-state",
                a.name,
                b.name
            );
        }
    }
}
