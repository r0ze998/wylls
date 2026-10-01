//! `abi-vectors`: writes `frontier-abi/vectors/*.json` from the ABI tables
//! (the only producer of these files, M1 contract §3.5).
//!
//! ```text
//! cargo run -p frontier-abi --bin abi-vectors              # (re)write
//! cargo run -p frontier-abi --bin abi-vectors -- --check   # exit 1 if stale
//! ```
//!
//! Consumers: `permutation-gateway/client/src/frontier/` (JS codec,
//! addresses, fees, budgets), `web-frontier-codec.test.mjs`,
//! `frontier-node` (`fclient`), the verifier.

use frontier_abi::addr::{self, AddrCtx, Seed};
use frontier_abi::budgets;
use frontier_abi::entry::{Entry, EntryOp};
use frontier_abi::error::FrontierError;
use frontier_abi::ix;
use frontier_abi::layout::{self, AccountKind, Field};
use frontier_abi::log::{self, Kind};
use frontier_abi::presets::{self, SeasonParams};
use frontier_abi::prologue::{self, Acc, Wr};
use frontier_abi::tags::{self, Ix};
use permutation_rules::hash::sha256;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

// ------------------------------------------------------------ tiny JSON

fn hex(b: &[u8]) -> String {
    let mut s = String::with_capacity(2 * b.len());
    for x in b {
        let _ = write!(s, "{x:02x}");
    }
    s
}

fn b58(b: &[u8]) -> String {
    const A: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let zeros = b.iter().take_while(|x| **x == 0).count();
    let mut digits: Vec<u8> = Vec::new();
    for &byte in b {
        let mut carry = byte as u32;
        for d in digits.iter_mut() {
            carry += (*d as u32) << 8;
            *d = (carry % 58) as u8;
            carry /= 58;
        }
        while carry > 0 {
            digits.push((carry % 58) as u8);
            carry /= 58;
        }
    }
    let mut s = "1".repeat(zeros);
    for d in digits.iter().rev() {
        s.push(A[*d as usize] as char);
    }
    s
}

fn q(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

/// A JSON value with deterministic formatting.
enum J {
    N(i128),
    S(String),
    B(bool),
    A(Vec<J>),
    O(Vec<(String, J)>),
    Null,
}

fn n<T: Into<i128>>(x: T) -> J {
    J::N(x.into())
}
fn st(x: &str) -> J {
    J::S(x.to_string())
}
fn o(v: Vec<(&str, J)>) -> J {
    J::O(v.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
}

impl J {
    fn write(&self, out: &mut String, ind: usize) {
        let pad = |out: &mut String, i: usize| out.push_str(&"  ".repeat(i));
        match self {
            J::N(x) => {
                let _ = write!(out, "{x}");
            }
            J::S(s) => out.push_str(&q(s)),
            J::B(b) => out.push_str(if *b { "true" } else { "false" }),
            J::Null => out.push_str("null"),
            J::A(v) => {
                if v.iter().all(|x| matches!(x, J::N(_) | J::S(_) | J::B(_))) && v.len() <= 16 {
                    out.push('[');
                    for (i, x) in v.iter().enumerate() {
                        if i > 0 {
                            out.push_str(", ");
                        }
                        x.write(out, 0);
                    }
                    out.push(']');
                    return;
                }
                out.push_str("[\n");
                for (i, x) in v.iter().enumerate() {
                    pad(out, ind + 1);
                    x.write(out, ind + 1);
                    out.push_str(if i + 1 < v.len() { ",\n" } else { "\n" });
                }
                pad(out, ind);
                out.push(']');
            }
            J::O(v) => {
                if v.is_empty() {
                    out.push_str("{}");
                    return;
                }
                out.push_str("{\n");
                for (i, (k, x)) in v.iter().enumerate() {
                    pad(out, ind + 1);
                    out.push_str(&q(k));
                    out.push_str(": ");
                    x.write(out, ind + 1);
                    out.push_str(if i + 1 < v.len() { ",\n" } else { "\n" });
                }
                pad(out, ind);
                out.push('}');
            }
        }
    }
    fn render(&self) -> String {
        let mut s = String::new();
        self.write(&mut s, 0);
        s.push('\n');
        s
    }
}

fn header(what: &str) -> Vec<(&'static str, J)> {
    vec![
        ("generator", st("frontier-abi abi-vectors")),
        ("abi_version", n(frontier_abi::ABI_VERSION)),
        ("contract", st("docs/frontier/m1/M1-CONTRACT.md v1.9")),
        ("content", st(what)),
    ]
}

fn fields(f: &[Field]) -> J {
    J::A(
        f.iter()
            .map(|x| {
                o(vec![
                    ("name", st(x.name)),
                    ("off", n(x.off as u64)),
                    ("len", n(x.len as u64)),
                    ("ty", st(x.ty)),
                ])
            })
            .collect(),
    )
}

// ------------------------------------------------------------ files

fn layouts() -> J {
    let mut v = header("account layouts (§4.3, §5.3), sub-records, SeasonParams");
    v.push((
        "accounts",
        J::A(
            AccountKind::ALL
                .iter()
                .map(|k| {
                    o(vec![
                        ("kind", st(k.name())),
                        ("code", n(*k as u8)),
                        ("magic", st(std::str::from_utf8(&k.magic()).unwrap_or("?"))),
                        ("size", n(k.size() as u64)),
                        ("rent", n(k.rent())),
                        ("chained", J::B(k.chained())),
                        (
                            "seed_tag",
                            addr::tag_of(*k)
                                .map(|t| st(std::str::from_utf8(&t).unwrap_or("?")))
                                .unwrap_or(J::Null),
                        ),
                        ("raw_key_len", n(addr::raw_len(*k) as u64)),
                        ("fields", fields(k.fields())),
                    ])
                })
                .collect(),
        ),
    ));
    v.push((
        "records",
        J::A(
            layout::RECORDS
                .iter()
                .map(|(name, size, f)| {
                    o(vec![
                        ("name", st(name)),
                        ("size", n(*size as u64)),
                        ("fields", fields(f)),
                    ])
                })
                .collect(),
        ),
    ));
    v.push((
        "season_params",
        o(vec![
            ("size", n(presets::SEASON_PARAMS_LEN as u64)),
            ("fields", fields(presets::layout::FIELDS)),
        ]),
    ));
    v.push(("rent_per_byte", n(layout::RENT_PER_BYTE)));
    v.push((
        "season_tombstone_size",
        n(layout::world::season::TOMBSTONE_SIZE as u64),
    ));
    v.push(("reserved_magic", st("PSF1SVRD")));
    J::O(v.into_iter().map(|(k, x)| (k.to_string(), x)).collect())
}

fn acc_name(a: Acc) -> String {
    match a {
        Acc::Kind(k) => k.name().to_string(),
        Acc::Either(a, b) => format!("{}|{}", a.name(), b.name()),
        Acc::Wallet => "wallet".into(),
        Acc::System => "system".into(),
        Acc::IxSysvar => "instructions_sysvar".into(),
        Acc::ProgramAccount => "program".into(),
        Acc::ProgramData => "programdata".into(),
        Acc::Incinerator => "incinerator".into(),
        Acc::Any => "any".into(),
        Acc::KindV2(k) => k.name().to_string(),
    }
}

fn tags_file() -> J {
    let mut v = header("instruction tags, classes, data layouts and account lists (§5.5–§5.12)");
    v.push((
        "instructions",
        J::A(
            Ix::ALL
                .iter()
                .map(|i| {
                    let (lo, hi) = ix::data_len_range(*i);
                    let wire = ix::wire_of(*i)
                        .map(|w| {
                            J::A(
                                w.iter()
                                    .map(|(f, l)| o(vec![("name", st(f)), ("len", n(*l as u64))]))
                                    .collect(),
                            )
                        })
                        .unwrap_or(J::Null);
                    let groups = prologue::accounts_of(*i)
                        .iter()
                        .map(|g| {
                            o(vec![
                                ("min", n(g.min)),
                                ("max", n(g.max)),
                                (
                                    "accounts",
                                    J::A(
                                        g.specs
                                            .iter()
                                            .map(|s| {
                                                o(vec![
                                                    ("name", st(s.name)),
                                                    ("kind", J::S(acc_name(s.acc))),
                                                    ("signer", J::B(s.signer)),
                                                    (
                                                        "writable",
                                                        st(match s.wr {
                                                            Wr::R => "r",
                                                            Wr::W => "w",
                                                            Wr::Either => "r|w",
                                                        }),
                                                    ),
                                                ])
                                            })
                                            .collect(),
                                    ),
                                ),
                            ])
                        })
                        .collect();
                    o(vec![
                        ("name", st(i.name())),
                        ("tag", n(i.tag())),
                        ("class", st(i.class().name())),
                        ("top_level_only", J::B(i.top_level_only())),
                        ("relay_player_shape", J::B(tags::relay_player_shape(*i))),
                        ("relay_settle_shape", J::B(tags::relay_settle_shape(*i))),
                        ("data_len", J::A(vec![n(lo as u64), n(hi as u64)])),
                        ("data", wire),
                        ("account_groups", J::A(groups)),
                    ])
                })
                .collect(),
        ),
    ));
    v.push((
        "reserved_tags",
        J::A(
            (0u8..=255)
                .filter(|t| tags::is_reserved(*t))
                .map(n)
                .collect(),
        ),
    ));
    v.push((
        "constants",
        o(vec![
            ("sig48_len", n(ix::SIG48_LEN as u64)),
            ("hints_len", n(ix::HINTS_LEN as u64)),
            ("seal_len", n(ix::SEAL_LEN as u64)),
            ("plain_len", n(ix::PLAIN_LEN as u64)),
            ("multi_max_regions", n(budgets::MULTI_MAX_REGIONS as u64)),
        ]),
    ));
    J::O(v.into_iter().map(|(k, x)| (k.to_string(), x)).collect())
}

fn errors_file() -> J {
    let mut v = header("program error codes (§5.4), stable forever; keeper actions (offchain P8)");
    v.push((
        "errors",
        J::A(
            FrontierError::ALL
                .iter()
                .map(|e| {
                    o(vec![
                        ("code", n(e.code())),
                        ("name", st(e.name())),
                        ("program", J::B(e.program_code())),
                        (
                            "keeper",
                            st(match frontier_abi::error::keeper_action(*e) {
                                frontier_abi::error::KeeperAction::Success => "success",
                                frontier_abi::error::KeeperAction::RetrySlots => "retry-slots",
                                frontier_abi::error::KeeperAction::Stop => "stop",
                                frontier_abi::error::KeeperAction::Wait => "wait",
                                frontier_abi::error::KeeperAction::Refused => "refused",
                            }),
                        ),
                    ])
                })
                .collect(),
        ),
    ));
    J::O(v.into_iter().map(|(k, x)| (k.to_string(), x)).collect())
}

/// Deterministic sample bytes for one log field.
fn sample_field(kind: Kind, name: &str, width: usize, salt: u8) -> Vec<u8> {
    let host = addr::host_id(2, -1, 3, 1, 42).unwrap_or(0);
    match (name, width) {
        ("host_id" | "displaced_host", 8) => host.to_le_bytes().to_vec(),
        ("p" | "origin_p", 4) => 2i32.to_le_bytes().to_vec(),
        ("q" | "origin_q", 4) => (-1i32).to_le_bytes().to_vec(),
        ("site", 1) => vec![3],
        ("account_kind", 1) => vec![AccountKind::Province as u8],
        ("key", 15) if kind == Kind::CLOSE => {
            let mut k = vec![0u8; 15];
            k[..4].copy_from_slice(&2i32.to_le_bytes());
            k[4..8].copy_from_slice(&(-1i32).to_le_bytes());
            k
        }
        ("faction", 1) => vec![4],
        ("shard", 1) => vec![6],
        ("n", 1) if kind == Kind::TICKET => vec![2],
        ("sites", 15) => {
            let mut s = vec![0u8; 15];
            s[..2].copy_from_slice(&2i16.to_le_bytes());
            s[2..4].copy_from_slice(&(-1i16).to_le_bytes());
            s[4] = 3;
            s[5..7].copy_from_slice(&3i16.to_le_bytes());
            s[7..9].copy_from_slice(&(-2i16).to_le_bytes());
            s[9] = 0;
            s
        }
        ("outcome", 1) if kind == Kind::SETTLE => vec![log::settle_outcome::DISPLACE],
        ("outcome", 1) if kind == Kind::TRANSIT_SETTLED => vec![log::transit_outcome::STAYS],
        _ => (0..width)
            .map(|i| (i as u8).wrapping_mul(31).wrapping_add(salt))
            .collect(),
    }
}

fn logs_file() -> J {
    let mut v = header("PS2 log records (§6): kinds, field widths, one encoded vector per kind with its chain heads");
    v.push(("prefix", st("PS2")));
    v.push(("version", n(log::VERSION)));
    v.push((
        "tail_order",
        st("ascending entity_kind; entities of one kind in instruction account order"),
    ));
    v.push((
        "entity_kinds",
        J::A(
            [1u8, 2, 3, 4, 5, 6, 7]
                .iter()
                .filter_map(|e| log::EntityKind::from_u8(*e))
                .map(|e| {
                    o(vec![
                        ("code", n(e as u8)),
                        ("account", st(e.account_kind().name())),
                    ])
                })
                .collect(),
        ),
    ));
    let mut kinds = Vec::new();
    for spec in log::SPECS {
        let mut key = Vec::new();
        for (f, w) in spec.key {
            key.extend(sample_field(spec.kind, f, *w, 0x11));
        }
        let mut payload = Vec::new();
        for (f, w) in spec.payload {
            payload.extend(sample_field(spec.kind, f, *w, 0x5a));
        }
        let bell = 1_000 + spec.kind as u32;
        let mut buf = vec![0u8; 1024];
        let len = log::write_body(spec.kind, bell, &key, &payload, &mut buf).unwrap_or(0);
        let bwt = buf[..len].to_vec();
        let chains = log::chains_of(spec.kind, &key, &payload);
        let mut links = Vec::new();
        let mut chain_json = Vec::new();
        if let Some(c) = chains {
            for (i, ce) in c.iter().filter(|c| !c.optional).enumerate() {
                let prev_head = sha256(&[b"abi-vectors prev", &[spec.kind as u8, i as u8]]);
                let prev_seq = 5 + i as u64;
                if let Some(l) = log::advance(ce.entity, prev_seq, &prev_head, &bwt) {
                    links.push(l);
                    chain_json.push(o(vec![
                        ("entity", n(ce.entity as u8)),
                        ("who", J::S(format!("{:?}", ce.who))),
                        ("prev_seq", n(prev_seq)),
                        ("prev_head", J::S(hex(&prev_head))),
                        ("seq", n(l.seq)),
                        ("head", J::S(hex(&l.head))),
                    ]));
                }
            }
            for ce in c.iter().filter(|c| c.optional) {
                chain_json.push(o(vec![
                    ("entity", n(ce.entity as u8)),
                    ("who", J::S(format!("{:?}", ce.who))),
                    ("optional", J::B(true)),
                ]));
            }
        }
        let end = log::write_tail(&links, &mut buf, len).unwrap_or(len);
        let body = buf[..end].to_vec();
        let decoded_ok = log::decode(&body).is_ok();
        kinds.push(o(vec![
            ("kind", n(spec.kind as u8)),
            ("name", st(spec.name)),
            (
                "key",
                J::A(
                    spec.key
                        .iter()
                        .map(|(f, w)| o(vec![("name", st(f)), ("len", n(*w as u64))]))
                        .collect(),
                ),
            ),
            (
                "payload",
                J::A(
                    spec.payload
                        .iter()
                        .map(|(f, w)| o(vec![("name", st(f)), ("len", n(*w as u64))]))
                        .collect(),
                ),
            ),
            ("body_without_tail_len", n(spec.body_len() as u64)),
            (
                "vector",
                o(vec![
                    ("bell", n(bell)),
                    ("body_without_tail", J::S(hex(&bwt))),
                    ("body", J::S(hex(&body))),
                    ("decodes", J::B(decoded_ok)),
                    ("chains", J::A(chain_json)),
                ]),
            ),
        ]));
    }
    v.push(("kinds", J::A(kinds)));
    let fates: [u8; 24] = core::array::from_fn(|k| (k % 6) as u8);
    v.push((
        "fates_vector",
        o(vec![
            ("fates", J::A(fates.iter().map(|x| n(*x)).collect())),
            ("packed", J::S(hex(&log::pack_fates(&fates)))),
        ]),
    ));
    J::O(v.into_iter().map(|(k, x)| (k.to_string(), x)).collect())
}

fn budgets_file() -> J {
    let mut v = header(
        "budgets (§5.5, §10.1, §10.2): wave-1 placeholders; L(kind) from the worst account sets",
    );
    v.push((
        "constants",
        o(vec![
            ("heap_gate", n(budgets::HEAP_GATE)),
            ("heap_frame", n(budgets::HEAP_FRAME)),
            ("cu_ladder_max", n(budgets::CU_LADDER_MAX)),
            ("locks_max", n(budgets::LOCKS_MAX)),
            ("tx_max", n(budgets::TX_MAX)),
            (
                "loaded_limit_working_default",
                n(budgets::LOADED_LIMIT_WORKING_DEFAULT),
            ),
            ("placeholder_so_len", n(budgets::PLACEHOLDER_SO_LEN)),
            (
                "placeholder_programdata_len",
                n(budgets::PLACEHOLDER_PROGRAMDATA_LEN),
            ),
            ("account_overhead", n(budgets::ACCOUNT_OVERHEAD)),
            ("programdata_meta", n(budgets::PROGRAMDATA_META)),
            ("multi_max_regions", n(budgets::MULTI_MAX_REGIONS as u64)),
        ]),
    ));
    v.push((
        "instructions",
        J::A(
            Ix::ALL
                .iter()
                .map(|i| {
                    let b = budgets::budget(*i);
                    let (lo, hi) = prologue::count_bounds(*i);
                    o(vec![
                        ("name", st(i.name())),
                        ("tag", n(i.tag())),
                        ("class", st(i.class().name())),
                        ("cu_budget", n(b.cu_budget)),
                        ("cu_per_unit", n(b.cu_per_unit)),
                        ("cu_limit", n(b.cu_limit)),
                        ("tx_contract", n(b.tx_contract)),
                        ("tx_ceiling", n(budgets::tx_ceiling(*i))),
                        ("tx_worst_estimate", n(budgets::tx_worst_estimate(*i))),
                        ("builder_limited", J::B(budgets::builder_limited(*i))),
                        ("accounts", J::A(vec![n(lo as u64), n(hi as u64)])),
                        ("write_locks_worst", n(budgets::write_locks(*i))),
                        (
                            "loaded_need_placeholder",
                            n(budgets::loaded_need(
                                *i,
                                budgets::PLACEHOLDER_PROGRAMDATA_LEN,
                            )),
                        ),
                        ("loaded_limit", n(budgets::loaded_limit(*i))),
                        ("heap", n(budgets::HEAP_GATE)),
                    ])
                })
                .collect(),
        ),
    ));
    J::O(v.into_iter().map(|(k, x)| (k.to_string(), x)).collect())
}

fn test_ctx() -> AddrCtx {
    AddrCtx {
        season: sha256(&[b"frontier-abi vectors: season pda"]),
        program: sha256(&[b"frontier-abi vectors: program id"]),
    }
}

fn addr_entry(ctx: &AddrCtx, kind: &str, key: J, seed: &Seed) -> J {
    let a = ctx.of(seed);
    o(vec![
        ("kind", st(kind)),
        ("key", key),
        (
            "seed",
            st(std::str::from_utf8(seed.as_bytes()).unwrap_or("?")),
        ),
        ("address_hex", J::S(hex(&a))),
        ("address", J::S(b58(&a))),
    ])
}

fn addresses_file() -> J {
    let ctx = test_ctx();
    let mut v = header("full with-seed addresses (§4.1) for a fixed season PDA and program id");
    v.push((
        "season_pda",
        o(vec![
            ("hex", J::S(hex(&ctx.season))),
            ("b58", J::S(b58(&ctx.season))),
        ]),
    ));
    v.push((
        "program_id",
        o(vec![
            ("hex", J::S(hex(&ctx.program))),
            ("b58", J::S(b58(&ctx.program))),
        ]),
    ));
    let wallet = sha256(&[b"frontier-abi vectors: wallet"]);
    let keeper = sha256(&[b"frontier-abi vectors: keeper"]);
    let mut e = Vec::new();
    e.push(addr_entry(
        &ctx,
        "Frontier",
        J::Null,
        &addr::frontier_seed(),
    ));
    e.push(addr_entry(
        &ctx,
        "DefencePool",
        J::Null,
        &addr::defence_pool_seed(),
    ));
    for d in [0u16, 3, u16::MAX] {
        e.push(addr_entry(
            &ctx,
            "RingSeed",
            o(vec![("d", n(d))]),
            &addr::ring_seed_seed(d),
        ));
    }
    for w in [0u8, 5] {
        e.push(addr_entry(
            &ctx,
            "ProvinceFund",
            o(vec![("w", n(w))]),
            &addr::province_fund_seed(w),
        ));
    }
    for (f, s) in [(0u8, 0u8), (5, 7)] {
        e.push(addr_entry(
            &ctx,
            "JoinShard",
            o(vec![("faction", n(f)), ("shard", n(s))]),
            &addr::join_shard_seed(f, s),
        ));
    }
    for r in [0u8, 15] {
        e.push(addr_entry(
            &ctx,
            "BeaconLog",
            o(vec![("region", n(r))]),
            &addr::beacon_log_seed(r),
        ));
    }
    let t15 = addr::citizen_tag15(&wallet);
    e.push(addr_entry(
        &ctx,
        "Citizen",
        o(vec![
            ("wallet", J::S(b58(&wallet))),
            ("tag15", J::S(hex(&t15))),
        ]),
        &addr::citizen_seed(&t15),
    ));
    let pqs = [(0i32, 0i32), (2, -1), (-128, 64), (i32::MIN, i32::MAX)];
    for (p, q) in pqs {
        e.push(addr_entry(
            &ctx,
            "Province",
            o(vec![("p", n(p)), ("q", n(q))]),
            &addr::province_seed(p, q),
        ));
        e.push(addr_entry(
            &ctx,
            "Holding",
            o(vec![("p", n(p)), ("q", n(q)), ("site", n(11u8))]),
            &addr::holding_seed(p, q, 11),
        ));
    }
    for (p, q, b) in [(2i32, -1i32, 0u32), (i32::MIN, i32::MAX, u32::MAX)] {
        e.push(addr_entry(
            &ctx,
            "ArrivalSlot",
            o(vec![
                ("p", n(p)),
                ("q", n(q)),
                ("bell", n(b)),
                ("faction", n(5u8)),
                ("i", n(3u8)),
            ]),
            &addr::arrival_slot_seed(p, q, b, 5, 3),
        ));
        e.push(addr_entry(
            &ctx,
            "ArrivalDay",
            o(vec![("p", n(p)), ("q", n(q)), ("day", n(b))]),
            &addr::arrival_day_seed(p, q, b),
        ));
        e.push(addr_entry(
            &ctx,
            "ClashInputs",
            o(vec![("p", n(p)), ("q", n(q)), ("bell", n(b))]),
            &addr::clash_inputs_seed(p, q, b),
        ));
        e.push(addr_entry(
            &ctx,
            "PosturePDA (reserved, M3)",
            o(vec![
                ("p", n(p)),
                ("q", n(q)),
                ("bell", n(b)),
                ("pos", n(59u8)),
            ]),
            &addr::posture_seed(p, q, b, 59),
        ));
    }
    for (b, r) in [(0u32, 0u8), (u32::MAX, 15)] {
        e.push(addr_entry(
            &ctx,
            "BellAnchor",
            o(vec![("bell", n(b)), ("region", n(r))]),
            &addr::bell_anchor_seed(b, r),
        ));
        e.push(addr_entry(
            &ctx,
            "SeedCache",
            o(vec![("bell", n(b)), ("region", n(r)), ("nonce", n(255u8))]),
            &addr::seed_cache_seed(b, r, 255),
        ));
        e.push(addr_entry(
            &ctx,
            "AnchorArchive",
            o(vec![("region", n(r)), ("part", n(b))]),
            &addr::anchor_archive_seed(r, b),
        ));
    }
    e.push(addr_entry(
        &ctx,
        "SealVerdict (reserved, removed v1.1)",
        o(vec![
            ("host_id", J::S(u64::MAX.to_string())),
            ("arrive_bell", n(7u32)),
        ]),
        &addr::seal_verdict_seed(u64::MAX, 7),
    ));
    let kt = addr::keeper_tag8(&keeper);
    e.push(addr_entry(
        &ctx,
        "DefenceClaim",
        o(vec![
            ("beneficiary", J::S(b58(&keeper))),
            ("keeper_tag8", J::S(hex(&kt))),
            ("day", n(6u32)),
        ]),
        &addr::defence_claim_seed(&kt, 6),
    ));
    v.push(("accounts", J::A(e)));
    // host ids (u64 as decimal strings: JS numbers are 53-bit)
    let hosts = [
        (0i32, 0i32, 0u8, 0u8, 0u32),
        (2, -1, 3, 1, 42),
        (128, 0, 11, 255, u32::MAX),
        (-64, -64, 5, 7, 12_345),
    ];
    v.push((
        "host_ids",
        J::A(
            hosts
                .iter()
                .filter_map(|&(p, q, site, gen, seq)| {
                    let id = addr::host_id(p, q, site, gen, seq)?;
                    Some(o(vec![
                        ("p", n(p)),
                        ("q", n(q)),
                        ("site", n(site)),
                        ("gen", n(gen)),
                        ("seq", n(seq)),
                        ("host_id", J::S(id.to_string())),
                        ("holding_address", J::S(b58(&ctx.holding(p, q, site)))),
                    ]))
                })
                .collect(),
        ),
    ));
    let cit = ctx.citizen(&wallet);
    v.push((
        "tags",
        o(vec![
            ("wallet", J::S(b58(&wallet))),
            ("citizen_address", J::S(b58(&cit))),
            ("citizen_tag_u64", J::S(addr::citizen_tag(&cit).to_string())),
            ("join_shard", n(addr::join_shard_of(&wallet))),
        ]),
    ));
    J::O(v.into_iter().map(|(k, x)| (k.to_string(), x)).collect())
}

fn params_json(p: &SeasonParams) -> J {
    let b = p.to_bytes();
    let mut fields_v = Vec::new();
    for f in presets::layout::FIELDS {
        if f.ty == "rsv" {
            continue;
        }
        let bytes = &b[f.off..f.off + f.len];
        let val = match f.ty {
            "u8" => n(bytes[0]),
            "u16" => n(u16::from_le_bytes([bytes[0], bytes[1]])),
            "u32" => n(u32::from_le_bytes(bytes.try_into().unwrap_or([0; 4]))),
            "u64" => J::S(u64::from_le_bytes(bytes.try_into().unwrap_or([0; 8])).to_string()),
            "i64" => J::S(i64::from_le_bytes(bytes.try_into().unwrap_or([0; 8])).to_string()),
            _ => J::S(hex(bytes)),
        };
        fields_v.push((f.name.to_ascii_lowercase(), val));
    }
    J::O(fields_v)
}

/// Borsh of `PayoutParams` (plain integers: LE in field order).
/// The borsh derive's encoding (integ-W1 review: no hand copy, so a field
/// added or retyped in PayoutParams moves the vector).
fn payout_borsh(p: &permutation_rules::frontier::payout::PayoutParams) -> Vec<u8> {
    p.to_borsh()
}

fn presets_file() -> J {
    let mut v = header("SeasonParams presets (§5.7) and the announced params hash");
    let payout = payout_borsh(&permutation_rules::frontier::payout::PayoutParams::REV3);
    v.push((
        "quicknet",
        o(vec![
            ("genesis", n(presets::QUICKNET_GENESIS)),
            ("period", n(presets::QUICKNET_PERIOD)),
            ("public_key", J::S(hex(&presets::QUICKNET_PUBLIC_KEY))),
            ("pk_hash", J::S(hex(&presets::QUICKNET_PK_HASH))),
        ]),
    ));
    v.push(("ruleset_hash", J::S(hex(&presets::RULESET_HASH))));
    v.push(("payout_params_rev3_borsh", J::S(hex(&payout))));
    let mut ps = Vec::new();
    for (name, p) in [
        ("M1_LOCAL_7D", presets::M1_LOCAL_7D),
        ("M1_PLAYTEST", presets::M1_PLAYTEST),
    ] {
        let b = p.to_bytes();
        ps.push(o(vec![
            ("name", st(name)),
            ("valid", J::B(p.validate().is_ok())),
            ("fields", params_json(&p)),
            ("bytes", J::S(hex(&b))),
            (
                "params_hash_with_rev3_payout",
                J::S(hex(&presets::params_hash(&b, &payout))),
            ),
        ]));
    }
    v.push(("presets", J::A(ps)));
    J::O(v.into_iter().map(|(k, x)| (k.to_string(), x)).collect())
}

fn ix_file() -> J {
    let mut v = header("one encoded sample per instruction (data with the tag, hex)");
    let b32 = |x: u8| [x; 32];
    let sig = [0xA1u8; 48];
    let hints = [0x3Cu8; ix::HINTS_LEN];
    let seal = [0x5Eu8; ix::SEAL_LEN];
    let mut out: Vec<(Ix, Vec<u8>)> = vec![
        (
            Ix::AnnounceSeason,
            ix::AnnounceSeason {
                id: 7,
                params_hash: b32(1),
                t_create_min: 1_800_000_000,
                bond: 1_000_000_000,
            }
            .to_bytes()
            .to_vec(),
        ),
        (
            Ix::InitBeaconLogs,
            ix::InitBeaconLogs {}.to_bytes().to_vec(),
        ),
        (
            Ix::InitShards,
            ix::InitShards { faction: 5 }.to_bytes().to_vec(),
        ),
        (
            Ix::ConsumeGenesisSeed,
            ix::ConsumeGenesisSeed {
                round: 12_345_678,
                sig48: sig,
                hints,
            }
            .to_bytes()
            .to_vec(),
        ),
        (Ix::EndSeason, ix::EndSeason {}.to_bytes().to_vec()),
        (
            Ix::CloseSeason,
            ix::CloseSeason { part: 2 }.to_bytes().to_vec(),
        ),
        (Ix::AbortSeason, ix::AbortSeason {}.to_bytes().to_vec()),
        (
            Ix::SetWindowSchedule,
            ix::SetWindowSchedule {
                window: 900,
                from_bell: 300,
            }
            .to_bytes()
            .to_vec(),
        ),
        (
            Ix::PostAnchor,
            ix::PostAnchor {
                region: 15,
                bell: 1_000,
                round: 99,
                sig48: sig,
                hints,
                beneficiary: b32(2),
            }
            .to_bytes()
            .to_vec(),
        ),
        (
            Ix::PostAnchorMulti,
            ix::PostAnchorMulti {
                bell: 1_000,
                round: 99,
                sig48: sig,
                hints,
                mask: 0x007F,
                beneficiary: b32(2),
            }
            .to_bytes()
            .to_vec(),
        ),
        (
            Ix::PostSeed,
            ix::PostSeed {
                region: 15,
                bell: 1_000,
                nonce: 3,
                round: 330,
                sig48: sig,
                hints,
                beneficiary: b32(2),
            }
            .to_bytes()
            .to_vec(),
        ),
        (
            Ix::PostBeacon,
            ix::PostBeacon {
                region: 1,
                round: 400,
                sig48: sig,
                hints,
            }
            .to_bytes()
            .to_vec(),
        ),
        (
            Ix::CloseSeedCache,
            ix::CloseSeedCache {
                bell: 1_000,
                region: 15,
                nonce: 3,
            }
            .to_bytes()
            .to_vec(),
        ),
        (Ix::OpenRing, ix::OpenRing { d: 4 }.to_bytes().to_vec()),
        (
            Ix::ConsumeRingSeed,
            ix::ConsumeRingSeed {
                d: 4,
                round: 500,
                sig48: sig,
                hints,
            }
            .to_bytes()
            .to_vec(),
        ),
        (
            Ix::OpenProvince,
            ix::OpenProvince { p: 2, q: -1 }.to_bytes().to_vec(),
        ),
        (
            Ix::FoldOccupancy,
            ix::FoldOccupancy { part: 1 }.to_bytes().to_vec(),
        ),
        (
            Ix::CloseProvince,
            ix::CloseProvince { p: 2, q: -1 }.to_bytes().to_vec(),
        ),
        (
            Ix::Join,
            ix::Join {
                faction: 4,
                session: b32(9),
                session_expiry: 1_800_086_400,
            }
            .to_bytes()
            .to_vec(),
        ),
        (
            Ix::SetSession,
            ix::SetSession {
                session: b32(9),
                expiry: 1_800_086_400,
            }
            .to_bytes()
            .to_vec(),
        ),
        (
            Ix::SetVigil,
            ix::SetVigil { start_min: 1_380 }.to_bytes().to_vec(),
        ),
        (
            Ix::SettleTicket,
            ix::SettleTicket { k: 1 }.to_bytes().to_vec(),
        ),
        (
            Ix::ReleaseDormant,
            ix::ReleaseDormant {}.to_bytes().to_vec(),
        ),
        (Ix::CloseHolding, ix::CloseHolding {}.to_bytes().to_vec()),
        (Ix::CloseCitizen, ix::CloseCitizen {}.to_bytes().to_vec()),
        (Ix::Harvest, ix::Harvest {}.to_bytes().to_vec()),
        (Ix::Build, ix::Build { item: 2 }.to_bytes().to_vec()),
        (Ix::Train, ix::Train { unit: 5, n: 300 }.to_bytes().to_vec()),
        (
            Ix::Muster,
            ix::Muster {
                unit: 5,
                troops: 300,
                tile: 30,
            }
            .to_bytes()
            .to_vec(),
        ),
        (
            Ix::Dissolve,
            ix::Dissolve {
                host_id: addr::host_id(2, -1, 3, 1, 42).unwrap_or(0),
            }
            .to_bytes()
            .to_vec(),
        ),
        (
            Ix::Garrison,
            ix::Garrison { delta: -150 }.to_bytes().to_vec(),
        ),
        (
            Ix::Explore,
            ix::Explore {
                host_id: addr::host_id(2, -1, 3, 1, 43).unwrap_or(0),
                n: 1,
                tiles: [12, 0xFF],
            }
            .to_bytes()
            .to_vec(),
        ),
        (Ix::SettleExplore, ix::SettleExplore {}.to_bytes().to_vec()),
        (
            Ix::DisbandStranded,
            ix::DisbandStranded { entry: 55 }.to_bytes().to_vec(),
        ),
        (
            Ix::Depart,
            ix::Depart {
                host_id: addr::host_id(2, -1, 3, 1, 42).unwrap_or(0),
                commit: b32(3),
                seal,
                arrive_bell: 1_010,
                tip: 14_441,
                transit_slot: 3,
            }
            .to_bytes()
            .to_vec(),
        ),
        (
            Ix::Reveal,
            ix::Reveal {
                transit_slot: 3,
                target_i: 2,
                plain: [0x2D; ix::PLAIN_LEN],
                salt: b32(4),
                ct_hash: b32(5),
                beneficiary: b32(2),
            }
            .to_bytes()
            .to_vec(),
        ),
        (
            Ix::SettleDeparture,
            ix::SettleDeparture { transit_slot: 3 }.to_bytes().to_vec(),
        ),
        (
            Ix::SettleTransit,
            ix::SettleTransit {
                transit_slot: 3,
                commit: b32(3),
                seal,
                beneficiary: b32(2),
            }
            .to_bytes()
            .to_vec(),
        ),
        (Ix::SweepPoolOwed, ix::SweepPoolOwed {}.to_bytes().to_vec()),
        (
            Ix::GatherClash,
            ix::GatherClash {
                bell: 1_010,
                start: 0,
                n: 12,
                holdings_bitmap: 0x0000_0FFF,
                beneficiary: b32(2),
            }
            .to_bytes()
            .to_vec(),
        ),
        (
            Ix::ResolveFromInputs,
            ix::ResolveFromInputs {
                bell: 1_010,
                beneficiary: b32(2),
            }
            .to_bytes()
            .to_vec(),
        ),
        (
            Ix::ResolveClash,
            ix::ResolveClash {
                bell: 1_010,
                beneficiary: b32(2),
            }
            .to_bytes()
            .to_vec(),
        ),
        (
            Ix::SkipQuiet,
            ix::SkipQuiet { b0: 1_010, n: 24 }.to_bytes().to_vec(),
        ),
        (
            Ix::CloseClashInputs,
            ix::CloseClashInputs {
                p: 2,
                q: -1,
                bell: 1_010,
            }
            .to_bytes()
            .to_vec(),
        ),
        (
            Ix::CloseArrivalDay,
            ix::CloseArrivalDay {
                p: 2,
                q: -1,
                day: 7,
            }
            .to_bytes()
            .to_vec(),
        ),
        (
            Ix::CloseArrivalSlot,
            ix::CloseArrivalSlot {
                p: 2,
                q: -1,
                bell: 1_010,
                faction: 4,
                i: 3,
            }
            .to_bytes()
            .to_vec(),
        ),
        (
            Ix::ClaimDefence,
            ix::ClaimDefence { day: 7, n: 6 }.to_bytes().to_vec(),
        ),
    ];
    let mut buf = [0u8; 512];
    let ft = ix::FileTicket {
        n: 2,
        sites: [
            ix::TicketSite {
                p: 2,
                q: -1,
                site: 3,
            },
            ix::TicketSite {
                p: 3,
                q: -2,
                site: 0,
            },
            ix::TicketSite::default(),
        ],
    };
    if let Some(len) = ft.encode(&mut buf) {
        out.push((Ix::FileTicket, buf[..len].to_vec()));
    }
    let aa = ix::ArchiveAnchors {
        region: 15,
        part: 14,
        n: 3,
        bells: [1_008, 1_009, 1_010, 0, 0, 0, 0, 0],
    };
    if let Some(len) = aa.encode(&mut buf) {
        out.push((Ix::ArchiveAnchors, buf[..len].to_vec()));
    }
    let payout = payout_borsh(&permutation_rules::frontier::payout::PayoutParams::REV3);
    let cs = ix::CreateSeason {
        params: presets::M1_LOCAL_7D,
        payout: &payout,
    };
    if let Some(len) = cs.encode(&mut buf) {
        out.push((Ix::CreateSeason, buf[..len].to_vec()));
    }
    out.sort_by_key(|(i, _)| i.tag());
    v.push((
        "samples",
        J::A(
            out.iter()
                .map(|(i, d)| {
                    o(vec![
                        ("name", st(i.name())),
                        ("tag", n(i.tag())),
                        ("len", n(d.len() as u64)),
                        ("data", J::S(hex(d))),
                    ])
                })
                .collect(),
        ),
    ));
    J::O(v.into_iter().map(|(k, x)| (k.to_string(), x)).collect())
}

fn entries_file() -> J {
    use permutation_rules::frontier::host::{Host, Pending, PendingOp, Stamina};
    use permutation_rules::units::UnitType;
    let mut v = header("Province entry (48 B) <-> kernel Host codec samples (§5.3, I-55)");
    let id = addr::host_id(2, -1, 3, 1, 42).unwrap_or(0);
    let key = addr::holding_key_of_host(id);
    let base = Host {
        id,
        owner: key,
        faction: 4,
        unit: UnitType::Knight,
        troops: 12_345_678,
        stamina: Stamina {
            value: 77,
            bell: 1_234,
        },
        ready_bell: 1_236,
        pending: None,
    };
    let cases: Vec<(&str, Option<PendingOp>, Option<EntryOp>)> = vec![
        ("none", None, None),
        ("spend", Some(PendingOp::Spend { cost: 120 }), None),
        (
            "split",
            Some(PendingOp::Split {
                troops: 5_000_000,
                of: 12_345_678,
                new_id: key | 99,
            }),
            None,
        ),
        ("absorb", Some(PendingOp::Absorb { from: key | 7 }), None),
        (
            "absorbed_into",
            Some(PendingOp::AbsorbedInto { into: key | 8 }),
            None,
        ),
        ("leave", None, Some(EntryOp::Leave)),
        ("forfeit", None, Some(EntryOp::Forfeit)),
    ];
    let mut rows = Vec::new();
    for (name, op, prog) in cases {
        let mut h = base;
        h.pending = op.map(|op| Pending { bell: 1_235, op });
        let mut e = Entry::from_host(&h, 30, layout::province::entry::STATE_ROSTER, 11_000, 901);
        if let Some(p) = prog {
            e.op = p;
            e.pend_bell = 1_235;
        }
        let mut b = [0u8; 48];
        let ok = e.write(&mut b).is_ok();
        rows.push(o(vec![
            ("case", st(name)),
            ("host_id", J::S(id.to_string())),
            ("encodes", J::B(ok)),
            ("entry", J::S(hex(&b))),
            ("pend_op", n(e.op.code())),
        ]));
    }
    v.push(("entries", J::A(rows)));
    J::O(v.into_iter().map(|(k, x)| (k.to_string(), x)).collect())
}

fn files() -> Vec<(&'static str, String)> {
    vec![
        ("layouts.json", layouts().render()),
        ("tags.json", tags_file().render()),
        ("errors.json", errors_file().render()),
        ("logs.json", logs_file().render()),
        ("budgets.json", budgets_file().render()),
        ("addresses.json", addresses_file().render()),
        ("presets.json", presets_file().render()),
        ("ix.json", ix_file().render()),
        ("entries.json", entries_file().render()),
        ("v2/layouts.json", v2_layouts().render()),
        ("v2/tags.json", v2_tags().render()),
        ("v2/errors.json", v2_errors().render()),
        ("v2/logs.json", v2_logs().render()),
        ("v2/presets.json", v2_presets().render()),
        ("v2/budgets.json", v2_budgets().render()),
        ("v2/conquest.json", v2_conquest().render()),
    ]
}

fn vectors_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("vectors")
}

fn main() {
    let check = std::env::args().any(|a| a == "--check");
    let dir = vectors_dir();
    let mut stale = Vec::new();
    for (name, body) in files() {
        let path = dir.join(name);
        if check {
            match std::fs::read_to_string(&path) {
                Ok(cur) if cur == body => {}
                _ => stale.push(name),
            }
        } else if let Err(e) = std::fs::create_dir_all(path.parent().unwrap_or(&dir))
            .and_then(|_| std::fs::write(&path, body))
        {
            eprintln!("abi-vectors: cannot write {}: {e}", path.display());
            std::process::exit(2);
        }
    }
    if check {
        if stale.is_empty() {
            println!("abi-vectors: {} files fresh", files().len());
        } else {
            eprintln!("abi-vectors: stale or missing: {} (run `cargo run -p frontier-abi --bin abi-vectors`)", stale.join(", "));
            std::process::exit(1);
        }
    } else {
        println!(
            "abi-vectors: wrote {} files to {}",
            files().len(),
            dir.display()
        );
    }
}

// ================================================================ ABI v2
//
// `vectors/v2/*.json` (MC contract §5, §6, §3.12, §5.7): written beside
// the v1 files, which stay byte-identical (R-16). Consumers: CQ2-D's
// fclient twin tests, CQ3-C's JS SDK, CQ3-D's web data and WASM, CQ2-E's
// herald, CQ3-A's verifier.

mod v2vec {
    use super::*;
    use frontier_abi::v2;

    pub fn header_v2(what: &str) -> Vec<(&'static str, J)> {
        vec![
            ("generator", st("frontier-abi abi-vectors")),
            ("abi_version", n(v2::ABI_VERSION_V2)),
            (
                "contract",
                st("docs/frontier/conquest/CONQUEST-CONTRACT.md v1.1"),
            ),
            ("content", st(what)),
        ]
    }

    pub fn done(v: Vec<(&'static str, J)>) -> J {
        J::O(v.into_iter().map(|(k, x)| (k.to_string(), x)).collect())
    }
}
use v2vec::{done, header_v2};

fn v2_layouts() -> J {
    use frontier_abi::v2::layout::{self as l2, AccountKind as K2};
    let mut v =
        header_v2("ABI v2 account layouts (§5.2): 18 kinds, v2 sub-records, SeasonParams v2");
    v.push((
        "accounts",
        J::A(
            K2::ALL
                .iter()
                .map(|k| {
                    o(vec![
                        ("kind", st(k.name())),
                        ("code", n(*k as u8)),
                        ("magic", st(std::str::from_utf8(&k.magic()).unwrap_or("?"))),
                        ("size", n(k.size() as u64)),
                        ("rent", n(k.rent())),
                        ("chained", J::B(k.chained())),
                        ("changed_in_v2", J::B(k.changed_in_v2())),
                        (
                            "seed_tag",
                            frontier_abi::v2::addr::tag_of(*k)
                                .map(|t| st(std::str::from_utf8(&t).unwrap_or("?")))
                                .unwrap_or(J::Null),
                        ),
                        ("raw_key_len", n(frontier_abi::v2::addr::raw_len(*k) as u64)),
                        ("fields", fields(k.fields())),
                    ])
                })
                .collect(),
        ),
    ));
    v.push((
        "records",
        J::A(
            l2::RECORDS
                .iter()
                .map(|(name, size, f)| {
                    o(vec![
                        ("name", st(name)),
                        ("size", n(*size as u64)),
                        ("fields", fields(f)),
                    ])
                })
                .collect(),
        ),
    ));
    use frontier_abi::v2::layout::province::{conquest as CR, keep as KP, site as SM};
    v.push((
        "constants",
        o(vec![
            ("layout_version", n(l2::LAYOUT_VERSION_V2)),
            ("site_state_free_city", n(SM::STATE_FREE_CITY)),
            ("record_kind_siege", n(CR::KIND_SIEGE)),
            ("record_kind_occupation", n(CR::KIND_OCCUPATION)),
            ("record_kind_capture_due", n(CR::KIND_CAPTURE_DUE)),
            ("barred_all", n(CR::BARRED_ALL)),
            ("barred_none", n(CR::BARRED_NONE)),
            ("flag_held", n(CR::FLAG_HELD)),
            ("flag_stake_to_holding", n(CR::FLAG_STAKE_TO_HOLDING)),
            ("flag_stake_to_src", n(CR::FLAG_STAKE_TO_SRC)),
            ("flag_neutral", n(CR::FLAG_NEUTRAL)),
            ("flag_credited", n(CR::FLAG_CREDITED)),
            ("flag_slot_owed", n(CR::FLAG_SLOT_OWED)),
            ("target_first", n(CR::TARGET_FIRST)),
            ("target_other", n(CR::TARGET_OTHER)),
            ("target_free_city", n(CR::TARGET_FREE_CITY)),
            ("keep_no_tile", n(KP::NO_TILE)),
            ("keep_flag_heartland_safe", n(KP::FLAG_HEARTLAND_SAFE)),
            (
                "keep_garrison_id_base",
                J::S(frontier_abi::v2::kernel::keep::KEEP_GARRISON_ID_BASE.to_string()),
            ),
            (
                "conquest_params_size",
                n(frontier_abi::v2::presets::CONQUEST_PARAMS_LEN as u64),
            ),
            (
                "season_params_v2_size",
                n(frontier_abi::v2::presets::SEASON_PARAMS_V2_LEN as u64),
            ),
        ]),
    ));
    let ctx = test_ctx();
    let marches: Vec<J> = [(0, 0), (-3, 7), (2, -1)]
        .iter()
        .map(|(m, nn)| {
            addr_entry(
                &ctx,
                "MarchState",
                o(vec![("m", n(*m)), ("n", n(*nn))]),
                &frontier_abi::v2::addr::march_seed(*m, *nn),
            )
        })
        .collect();
    v.push(("march_addresses", J::A(marches)));
    done(v)
}

fn v2_tags() -> J {
    use frontier_abi::v2::{ix as ix2, prologue as p2, tags as t2};
    let mut v = header_v2("ABI v2 instruction tags, classes, data and account lists (§5.4–§5.6)");
    v.push((
        "instructions",
        J::A(
            t2::Ix::ALL
                .iter()
                .map(|i| {
                    let (lo, hi) = ix2::data_len_range(*i);
                    let wire = ix2::wire_of(*i)
                        .map(|w| {
                            J::A(
                                w.iter()
                                    .map(|(f, l)| o(vec![("name", st(f)), ("len", n(*l as u64))]))
                                    .collect(),
                            )
                        })
                        .unwrap_or(J::Null);
                    let groups = p2::accounts_of(*i)
                        .iter()
                        .map(|g| {
                            o(vec![
                                ("min", n(g.min)),
                                ("max", n(g.max)),
                                (
                                    "accounts",
                                    J::A(
                                        g.specs
                                            .iter()
                                            .map(|s| {
                                                o(vec![
                                                    ("name", st(s.name)),
                                                    ("kind", J::S(acc_name(s.acc))),
                                                    ("signer", J::B(s.signer)),
                                                    (
                                                        "writable",
                                                        st(match s.wr {
                                                            Wr::R => "r",
                                                            Wr::W => "w",
                                                            Wr::Either => "r|w",
                                                        }),
                                                    ),
                                                ])
                                            })
                                            .collect(),
                                    ),
                                ),
                            ])
                        })
                        .collect();
                    o(vec![
                        ("name", st(i.name())),
                        ("tag", n(i.tag())),
                        ("class", st(i.class().name())),
                        ("new_in_v2", J::B(i.is_new())),
                        ("changed_in_v2", J::B(i.changed_in_v2())),
                        ("top_level_only", J::B(i.top_level_only())),
                        ("relay_player_shape", J::B(t2::relay_player_shape(*i))),
                        ("relay_settle_shape", J::B(t2::relay_settle_shape(*i))),
                        ("data_len", J::A(vec![n(lo as u64), n(hi as u64)])),
                        ("data", wire),
                        ("account_groups", J::A(groups)),
                    ])
                })
                .collect(),
        ),
    ));
    v.push((
        "reserved_tags",
        J::A((0u8..=255).filter(|t| t2::is_reserved(*t)).map(n).collect()),
    ));
    // one encoded sample per new fixed instruction
    let mut samples = Vec::new();
    let fm = ix2::FoldMarch {
        m: -3,
        n: 7,
        hour: 120,
        count: 6,
        beneficiary: [0xBE; 32],
    };
    samples.push(("FoldMarch", fm.to_bytes().to_vec()));
    let ds = ix2::DeclareSiege {
        site: 4,
        entry: 17,
        nearby_site: 2,
    };
    samples.push(("DeclareSiege", ds.to_bytes().to_vec()));
    let sc = ix2::SettleCapture {
        site: 4,
        beneficiary: [0xCA; 32],
    };
    samples.push(("SettleCapture", sc.to_bytes().to_vec()));
    let fo = ix2::FileOutpost {
        n: 2,
        sites: [
            ix::TicketSite {
                p: 4,
                q: -1,
                site: 7,
            },
            ix::TicketSite {
                p: 5,
                q: -1,
                site: 0,
            },
            ix::TicketSite::default(),
        ],
        anchor_site_key: addr::host_id(2, -1, 3, 1, 0).unwrap_or(0),
    };
    let mut buf = [0u8; ix2::FileOutpost::MAX_LEN];
    let len = fo.encode(&mut buf).unwrap_or(0);
    samples.push(("FileOutpost", buf[..len].to_vec()));
    v.push((
        "samples",
        J::A(
            samples
                .into_iter()
                .map(|(name, d)| o(vec![("name", st(name)), ("data", J::S(hex(&d)))]))
                .collect(),
        ),
    ));
    done(v)
}

fn v2_errors() -> J {
    use frontier_abi::error::KeeperAction as KA;
    let mut v =
        header_v2("ABI v2 error codes (§5.3), stable forever: M1's 1–61 and 99, MC's 62–78");
    v.push((
        "errors",
        J::A(
            frontier_abi::v2::error::all_codes()
                .map(|c| {
                    o(vec![
                        ("code", n(c.code())),
                        ("name", st(c.name())),
                        ("program", J::B(c.program_code())),
                        ("mc", J::B(matches!(c, frontier_abi::v2::Code::Cq(_)))),
                        (
                            "keeper",
                            st(match c.keeper_action() {
                                KA::Success => "success",
                                KA::RetrySlots => "retry-slots",
                                KA::Stop => "stop",
                                KA::Wait => "wait",
                                KA::Refused => "refused",
                            }),
                        ),
                    ])
                })
                .collect(),
        ),
    ));
    done(v)
}

fn v2_logs() -> J {
    use frontier_abi::v2::log as l2;
    let mut v =
        header_v2("ABI v2 PS2 log records (§6): kinds 80–88, entity kind 8, CONQUEST events");
    v.push((
        "entity_kinds",
        J::A(
            l2::EntityKind::ALL
                .iter()
                .map(|e| {
                    o(vec![
                        ("code", n(*e as u8)),
                        ("account", st(e.account_kind().name())),
                    ])
                })
                .collect(),
        ),
    ));
    let mut kinds = Vec::new();
    for spec in l2::CQ_SPECS {
        let kind = l2::AnyKind::Cq(spec.kind);
        let sample = |f: &str, w: usize, salt: u8| -> Vec<u8> {
            match (f, w) {
                ("p", 4) => 5i32.to_le_bytes().to_vec(),
                ("q", 4) => (-1i32).to_le_bytes().to_vec(),
                ("site", 1) => vec![3],
                ("m" | "n", 4) => 2i32.to_le_bytes().to_vec(),
                ("host_id" | "src_key" | "recipient_key" | "home_key" | "anchor_key", 8) => {
                    addr::host_id(2, -1, 3, 1, 42)
                        .unwrap_or(0)
                        .to_le_bytes()
                        .to_vec()
                }
                ("n", 1) => vec![2],
                ("outcome", 1) => vec![0],
                ("reason", 1) => vec![0],
                _ => (0..w)
                    .map(|i| (i as u8).wrapping_mul(29).wrapping_add(salt))
                    .collect(),
            }
        };
        let key: Vec<u8> = spec
            .key
            .iter()
            .flat_map(|(f, w)| sample(f, *w, 0x21))
            .collect();
        let payload: Vec<u8> = spec
            .payload
            .iter()
            .flat_map(|(f, w)| sample(f, *w, 0x6b))
            .collect();
        let bell = 2_000 + spec.kind as u32;
        let mut buf = vec![0u8; 1024];
        let len = l2::write_body(kind, bell, &key, &payload, &mut buf).unwrap_or(0);
        let bwt = buf[..len].to_vec();
        let mut links = Vec::new();
        let mut chain_json = Vec::new();
        if let Some(c) = l2::chains_of(kind, &key, &payload) {
            for (i, ce) in c.iter().filter(|c| !c.optional).enumerate() {
                let prev_head = sha256(&[b"abi-vectors v2 prev", &[spec.kind as u8, i as u8]]);
                if let Some(l) = l2::advance(ce.entity, 3 + i as u64, &prev_head, &bwt) {
                    links.push(l);
                    chain_json.push(o(vec![
                        ("entity", n(ce.entity as u8)),
                        ("who", J::S(format!("{:?}", ce.who))),
                        ("prev_seq", n(3 + i as u64)),
                        ("prev_head", J::S(hex(&prev_head))),
                        ("seq", n(l.seq)),
                        ("head", J::S(hex(&l.head))),
                    ]));
                }
            }
            for ce in c.iter().filter(|c| c.optional) {
                chain_json.push(o(vec![
                    ("entity", n(ce.entity as u8)),
                    ("who", J::S(format!("{:?}", ce.who))),
                    ("optional", J::B(true)),
                ]));
            }
        }
        let end = l2::write_tail(&links, &mut buf, len).unwrap_or(len);
        let body = buf[..end].to_vec();
        kinds.push(o(vec![
            ("kind", n(spec.kind as u8)),
            ("name", st(spec.name)),
            (
                "key",
                J::A(
                    spec.key
                        .iter()
                        .map(|(f, w)| o(vec![("name", st(f)), ("len", n(*w as u64))]))
                        .collect(),
                ),
            ),
            (
                "payload",
                J::A(
                    spec.payload
                        .iter()
                        .map(|(f, w)| o(vec![("name", st(f)), ("len", n(*w as u64))]))
                        .collect(),
                ),
            ),
            ("body_without_tail_len", n(kind.body_len() as u64)),
            (
                "vector",
                o(vec![
                    ("bell", n(bell)),
                    ("body_without_tail", J::S(hex(&bwt))),
                    ("body", J::S(hex(&body))),
                    ("decodes", J::B(l2::decode(&body).is_ok())),
                    ("chains", J::A(chain_json)),
                ]),
            ),
        ]));
    }
    v.push(("kinds", J::A(kinds)));
    v.push(("reserved_kind", n(l2::RESERVED_KIND)));
    use l2::event as ev;
    v.push((
        "conquest_events",
        o(vec![
            ("detail_bit", n(ev::DETAIL)),
            ("keep_site", n(ev::KEEP_SITE)),
            ("siege_failed", n(ev::SIEGE_FAILED)),
            ("occupied", n(ev::OCCUPIED)),
            ("capture_due", n(ev::CAPTURE_DUE)),
            ("liberated", n(ev::LIBERATED)),
            ("occupation_expired", n(ev::OCCUPATION_EXPIRED)),
            ("reserved_6", n(ev::RESERVED_6)),
            ("keep_contest", n(ev::KEEP_CONTEST)),
            ("keep_broken", n(ev::KEEP_BROKEN)),
            ("keep_taken", n(ev::KEEP_TAKEN)),
            ("keep_paused_m3", n(ev::KEEP_PAUSED_M3)),
        ]),
    ));
    done(v)
}

fn v2_params_json(p: &frontier_abi::v2::presets::SeasonParamsV2) -> J {
    use frontier_abi::v2::presets::cq_layout;
    let b = p.cq.to_bytes();
    let mut f = Vec::new();
    for x in cq_layout::FIELDS {
        if x.ty == "rsv" {
            continue;
        }
        let bytes = &b[x.off..x.off + x.len];
        let val = match x.ty {
            "u8" => n(bytes[0]),
            "u16" => n(u16::from_le_bytes([bytes[0], bytes[1]])),
            "u32" => n(u32::from_le_bytes(bytes.try_into().unwrap_or([0; 4]))),
            _ => J::S(hex(bytes)),
        };
        f.push((x.name.to_ascii_lowercase(), val));
    }
    o(vec![("base", params_json(&p.base)), ("conquest", J::O(f))])
}

fn v2_presets() -> J {
    use frontier_abi::v2::presets as p2;
    let mut v = header_v2(
        "SeasonParams v2 presets (§3.12, §5.2.5), the v2 params hash and RULESET_HASH_V2",
    );
    let payout = payout_borsh(&permutation_rules::frontier::payout::PayoutParams::REV3);
    v.push(("ruleset_hash_v2", J::S(hex(&p2::RULESET_HASH_V2))));
    v.push((
        "ruleset_hash_v2_status",
        st("pinned: permutation_rules::frontier::ruleset_hash_v2() (CQ1-A kernels; integ-W1, CQ1-C notes R1)"),
    ));
    v.push(("ruleset_hash_m1", J::S(hex(&presets::RULESET_HASH))));
    v.push(("rules_version_v2", n(p2::RULES_VERSION_V2)));
    v.push(("program_version_v2", n(p2::PROGRAM_VERSION_V2)));
    v.push(("season_cq_offset", n(p2::SEASON_CQ_OFFSET as u64)));
    v.push(("params_domain_v2", st("PSF-PARAMS-v2")));
    v.push(("payout_params_rev3_borsh", J::S(hex(&payout))));
    let mut ps = Vec::new();
    for (name, p) in p2::PRESETS {
        let b = p.to_bytes();
        ps.push(o(vec![
            ("name", st(name)),
            ("valid", J::B(p.validate().is_ok())),
            ("fields", v2_params_json(&p)),
            ("bytes", J::S(hex(&b))),
            (
                "params_hash_with_rev3_payout",
                J::S(hex(&p2::params_hash_v2(&b, &payout))),
            ),
        ]));
    }
    v.push(("presets", J::A(ps)));
    done(v)
}

fn v2_budgets() -> J {
    use frontier_abi::v2::{budgets as b2, prologue as p2, tags::Ix as Ix2};
    let mut v = header_v2(
        "ABI v2 budget placeholders (§5.4) and L(kind) at the estimated MC .so (CQ4-A regenerates)",
    );
    v.push((
        "constants",
        o(vec![
            ("placeholder_so_len", n(b2::PLACEHOLDER_SO_LEN_V2)),
            (
                "placeholder_programdata_len",
                n(b2::PLACEHOLDER_PROGRAMDATA_LEN_V2),
            ),
            ("skip_per_active_bell", n(b2::SKIP_PER_ACTIVE_BELL)),
            ("skip_record_bells_max", n(b2::SKIP_RECORD_BELLS_MAX)),
            ("heap_gate", n(budgets::HEAP_GATE)),
            ("tx_max", n(budgets::TX_MAX)),
        ]),
    ));
    v.push((
        "instructions",
        J::A(
            Ix2::ALL
                .iter()
                .map(|i| {
                    let b = b2::budget(*i);
                    let (lo, hi) = p2::count_bounds(*i);
                    o(vec![
                        ("name", st(i.name())),
                        ("tag", n(i.tag())),
                        ("cu_budget", n(b.cu_budget)),
                        ("cu_per_unit", n(b.cu_per_unit)),
                        ("cu_limit", n(b.cu_limit)),
                        ("measured", n(b.measured)),
                        ("tx_contract", n(b.tx_contract)),
                        ("tx_ceiling", n(b2::tx_ceiling(*i))),
                        ("tx_worst_estimate", n(b2::tx_worst_estimate(*i))),
                        ("accounts", J::A(vec![n(lo as u64), n(hi as u64)])),
                        (
                            "loaded_need_placeholder",
                            n(b2::loaded_need(*i, b2::PLACEHOLDER_PROGRAMDATA_LEN_V2)),
                        ),
                        ("loaded_limit", n(b2::loaded_limit(*i))),
                    ])
                })
                .collect(),
        ),
    ));
    done(v)
}

/// `vectors/v2/conquest.json`: the conquest step over hand-built
/// Provinces (one case per rule family), each with the Province before,
/// the bell's report, the events and the state after (hashes and the
/// decoded records), for the herald, the verifier and the WASM twin.
fn v2_conquest() -> J {
    use frontier_abi::clash_model as cm;
    use frontier_abi::conquest_model::{self as qm, BellReport, Record, SiteReport, StepParams};
    use frontier_abi::v2::kernel::keep as kk;
    use frontier_abi::v2::layout::province::{conquest as CR, province as P, site as SM};
    use frontier_abi::v2::layout::{write_header, AccountKind as K2};
    use frontier_abi::v2::presets::MC_LOCAL_7D;
    use permutation_rules::frontier::geometry::ProvinceCoord;
    use permutation_rules::frontier::terrain::generate_province;

    let prm = StepParams {
        genesis_ts: 1_788_998_400,
        end_bell: 1_008,
        cq: MC_LOCAL_7D.cq,
    };
    let base = || -> Vec<u8> {
        let c = ProvinceCoord::new(5, -1);
        let t = generate_province(&[7u8; 32], c);
        let mut pd = vec![0u8; P::SIZE];
        write_header(&mut pd, K2::Province, 1);
        pd[P::P..P::P + 2].copy_from_slice(&5i16.to_le_bytes());
        pd[P::Q..P::Q + 2].copy_from_slice(&(-1i16).to_le_bytes());
        pd[P::RING..P::RING + 2].copy_from_slice(&(c.ring() as u16).to_le_bytes());
        pd[P::WEDGE] = c.wedge().unwrap_or(0);
        for i in 0..61 {
            pd[P::TERRAIN + i] = cm::TERRAINS
                .iter()
                .position(|x| *x == t.terrain[i])
                .unwrap_or(0) as u8;
        }
        pd[P::SITES..P::SITES + 12].copy_from_slice(&t.sites);
        pd[P::SITE_COUNT] = t.site_count;
        for s in 0..12 {
            let o_ = P::site(s);
            pd[o_ + SM::PEND0_BELL..o_ + SM::PEND0_BELL + 4]
                .copy_from_slice(&SM::NO_BELL.to_le_bytes());
            pd[o_ + SM::PEND1_BELL..o_ + SM::PEND1_BELL + 4]
                .copy_from_slice(&SM::NO_BELL.to_le_bytes());
        }
        let tile = kk::keep_tile(&t, &t.sites, t.site_count).unwrap_or(0);
        let k = kk::open(
            c,
            c.wedge().unwrap_or(0),
            3,
            tile,
            &MC_LOCAL_7D.cq.keep_params(),
            0,
        );
        if let Some(k) = k {
            let _ = qm::write_keep(&mut pd, &k);
        }
        pd
    };
    let site = |pd: &mut Vec<u8>, s: usize, state: u8, faction: u8, order: u8| {
        let o_ = P::site(s);
        pd[o_ + SM::STATE] = state;
        pd[o_ + SM::FACTION] = faction;
        pd[o_ + SM::ORDER] = order;
    };
    let src = addr::host_id(0, 4, 1, 0, 0).unwrap_or(0);
    let siege = |faction: u8, target: u8, progress: u8, required: u8, neutral: bool| Record {
        kind: CR::KIND_SIEGE,
        faction,
        flags: CR::FLAG_HELD | if neutral { CR::FLAG_NEUTRAL } else { 0 },
        progress,
        required,
        target,
        bell: 100,
        actor: 0xAC70,
        src,
        ..Record::ZERO
    };
    let hold = |f: u8| SiteReport {
        holders: 1 << f,
        defender_present: false,
    };
    let defended = SiteReport {
        holders: 0,
        defender_present: true,
    };
    let empty = SiteReport::default();
    type Case = (&'static str, Vec<u8>, u32, BellReport);
    let mut cases: Vec<Case> = Vec::new();
    // 1. siege progresses
    let mut pd = base();
    site(&mut pd, 2, SM::STATE_HOLDING, 4, 2);
    let _ = siege(1, CR::target(CR::TARGET_OTHER, 2), 5, 40, false).write(&mut pd, 2);
    let mut rep = BellReport::default();
    rep.sites[2] = hold(1);
    cases.push(("siege_progress", pd, 200, rep));
    // 2. capture due, credited (holding held 300 bells)
    let mut pd = base();
    site(&mut pd, 2, SM::STATE_HOLDING, 4, 2);
    let _ = siege(1, CR::target(CR::TARGET_OTHER, 3), 39, 40, false).write(&mut pd, 2);
    let mut rep = BellReport::default();
    rep.sites[2] = hold(1);
    cases.push(("capture_due_credited", pd, 300 + 48, rep));
    // 3. capture due, uncredited (held since hour 50)
    let mut pd = base();
    site(&mut pd, 2, SM::STATE_HOLDING, 4, 2);
    pd[P::site(2) + SM::HELD_SINCE_HOUR] = 50;
    let _ = siege(1, CR::target(CR::TARGET_OTHER, 2), 39, 40, false).write(&mut pd, 2);
    let mut rep = BellReport::default();
    rep.sites[2] = hold(1);
    cases.push(("capture_due_uncredited", pd, 300 + 48, rep));
    // 4. Free City capture
    let mut pd = base();
    site(&mut pd, 5, SM::STATE_FREE_CITY, 6, 0);
    let _ = siege(3, CR::target(CR::TARGET_FREE_CITY, 2), 35, 36, true).write(&mut pd, 5);
    let mut rep = BellReport::default();
    rep.sites[5] = hold(3);
    cases.push(("free_city_capture", pd, 120, rep));
    // 5. siege broken by a defender
    let mut pd = base();
    site(&mut pd, 2, SM::STATE_HOLDING, 4, 2);
    let _ = siege(1, CR::target(CR::TARGET_OTHER, 3), 9, 40, false).write(&mut pd, 2);
    let mut rep = BellReport::default();
    rep.sites[2] = defended;
    cases.push(("siege_broken_by_defender", pd, 150, rep));
    // 6. deserted siege
    let mut pd = base();
    site(&mut pd, 0, SM::STATE_HOLDING, 4, 1);
    let _ = siege(1, CR::target(CR::TARGET_FIRST, 0), 9, 40, false).write(&mut pd, 0);
    cases.push(("siege_deserted", pd, 150, BellReport::default()));
    // 7. occupation
    let mut pd = base();
    site(&mut pd, 0, SM::STATE_HOLDING, 4, 1);
    let _ = siege(1, CR::target(CR::TARGET_FIRST, 0), 39, 40, false).write(&mut pd, 0);
    let mut rep = BellReport::default();
    rep.sites[0] = hold(1);
    cases.push(("occupied", pd, 300 + 48, rep));
    // 8. liberated by the owner (Respite) and walked away (none)
    for (name, r0) in [
        ("liberated_by_owner", defended),
        ("liberated_walked_away", empty),
    ] {
        let mut pd = base();
        site(&mut pd, 0, SM::STATE_HOLDING, 4, 1);
        let _ = Record {
            kind: CR::KIND_OCCUPATION,
            faction: 1,
            target: CR::target(CR::TARGET_FIRST, 0),
            bell: 100,
            actor: 0xAC70,
            src,
            ..Record::ZERO
        }
        .write(&mut pd, 0);
        let mut rep = BellReport::default();
        rep.sites[0] = r0;
        cases.push((name, pd, 130, rep));
    }
    // 9. keep contest, broken, taken (with an hour snapshot)
    let mut pd = base();
    let holder = qm::read_keep(&pd).ok().flatten().map_or(0, |k| k.holder);
    let f = (holder + 1) % 6;
    let rep = BellReport {
        keep: hold(f),
        ..BellReport::default()
    };
    cases.push(("keep_contest", pd.clone(), 7, rep));
    if let Ok(Some(mut k)) = qm::read_keep(&pd) {
        k.contender = f;
        k.progress = 30;
        let _ = qm::write_keep(&mut pd, &k);
        let rep = BellReport {
            keep: defended,
            ..BellReport::default()
        };
        cases.push(("keep_broken", pd.clone(), 13, rep));
        k.progress = 71;
        let _ = qm::write_keep(&mut pd, &k);
        if let Ok(Some(k)) = qm::read_keep(&pd) {
            let id = addr::host_id(0, 4, 2, 0, 1).unwrap_or(0);
            let e = Entry {
                id,
                faction: f,
                unit: 0,
                tile: k.tile,
                state: layout::province::entry::STATE_ROSTER,
                troops: 24_000_000,
                stamina_value: 120,
                dealt_bps: 10_000,
                stamina_bell: 0,
                ready_bell: 0,
                from_bell: 0,
                pend_bell: 0,
                op: EntryOp::None,
            };
            let _ = frontier_abi::entry::write_entry(&mut pd, 0, &e);
        }
        let rep = BellReport {
            keep: hold(f),
            ..BellReport::default()
        };
        cases.push(("keep_taken_at_an_hour", pd, 18, rep));
    }
    let mut rows = Vec::new();
    for (name, before, b, rep) in cases {
        let mut after = before.clone();
        let res = qm::step(&mut after, b, &rep, &prm);
        let rep_j = o(vec![
            (
                "sites",
                J::A(
                    rep.sites
                        .iter()
                        .map(|s| {
                            o(vec![
                                ("holders", n(s.holders)),
                                ("defender_present", J::B(s.defender_present)),
                            ])
                        })
                        .collect(),
                ),
            ),
            (
                "keep",
                o(vec![
                    ("holders", n(rep.keep.holders)),
                    ("defender_present", J::B(rep.keep.defender_present)),
                ]),
            ),
        ]);
        let mut row = vec![
            ("case", st(name)),
            ("bell", n(b)),
            ("province_before", J::S(hex(&before))),
            ("report", rep_j),
        ];
        match res {
            Ok(out) => {
                let pl = qm::conquest_payload(&after, &out).ok();
                row.push((
                    "events",
                    J::A(
                        out.events()
                            .iter()
                            .map(|e| {
                                o(vec![
                                    ("site", n(e.site)),
                                    ("code", n(e.code)),
                                    ("faction", n(e.faction)),
                                    ("progress", n(e.progress)),
                                ])
                            })
                            .collect(),
                    ),
                ));
                row.push(("emits", J::B(out.emits())));
                row.push(("active", J::B(out.active)));
                row.push(("roster_changed", J::B(out.roster_changed)));
                row.push((
                    "conquest_payload",
                    J::S(pl.map(|p| hex(&p.to_bytes())).unwrap_or_default()),
                ));
                row.push(("conquest_block_after", J::S(hex(&after[P::CQ_BLOCK]))));
                row.push(("province_after_sha256", J::S(hex(&sha256(&[&after])))));
            }
            Err(e) => row.push(("error", J::S(format!("{e}")))),
        }
        rows.push(o(row));
    }
    let mut v =
        header_v2("the conquest step (§5.7) over hand-built Provinces: one case per rule family");
    v.push((
        "params",
        o(vec![
            ("genesis_ts", n(prm.genesis_ts)),
            ("end_bell", n(prm.end_bell)),
            ("preset", st("MC_LOCAL_7D")),
        ]),
    ));
    v.push(("cases", J::A(rows)));
    done(v)
}
