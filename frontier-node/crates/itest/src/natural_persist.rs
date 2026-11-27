//! TEST-ONLY persistence of the NATURAL local-play world (⑧ P1/P2, owner decision 2026-11-18: option B, "not for
//! production"). Two opt-in runner options, both off by default:
//!
//! * `--continuous local-continuous-v1`: the world's Season is `S1_LOCAL_CONTINUOUS` (no end bell, joins always open,
//!   `EndSeason` refused by the program) instead of the finite `S1_LOCAL_7D`.
//! * `--persist-dir <abs dir>`: the world lives in that directory and can be stopped and resumed. The directory is
//!   the world's **run dir**, kept private: the directory and every sub-directory mode `0700`, every file this module
//!   writes mode `0600`, and a start **refuses** a run dir, sub-directory or key file that any other user may read,
//!   write or enter (`mode & 0o077 != 0`) or that is a symbolic link.
//!
//!   - `chain/`: the local chain's write-ahead log and snapshots (`localnet::persist`, `Config.data_dir`);
//!   - `keys/upgrade.seed`, `keys/payer.seed`: the world's two operator keys (the program's upgrade authority, which
//!     is also the Season's authority, and the setup payer), as the 32-byte seed in hex. TEST keys of a disposable
//!     local chain: never a key of any public cluster;
//!   - `world.json`: what the world is (wallet, artefact sha256, continuous, program, Season, both public keys) and
//!     whether its setup finished.
//!
//!   The player's key is never here: it stays in the player's browser (a non-extractable WebCrypto key). The keeper's
//!   fee payer is a fresh one each run, funded by the node's faucet, and is not kept.
//!
//! **Resume** (the run dir already has `world.json`): the same wallet, artefact and continuous word, a finished setup,
//! both keys present and equal to the recorded public keys, the ledger present; then the chain is re-opened from its
//! own ledger (each re-executed transaction must repeat its recorded outcome, `localnet::Chain::open`), and the Season
//! on that chain must be this program's, with the recorded authority and continuous flag. Any difference refuses; nothing
//! is repaired or re-created. While a world is stopped its clock stands still: the resumed chain continues from the
//! game time of its last record.

use std::io::Write;
use std::path::{Path, PathBuf};

use fclient::{Address, Keypair, Signer};
use serde_json::{json, Value};

/// The runner's continuous-world option word (`--continuous`).
pub const CONTINUOUS_MODE: &str = "local-continuous-v1";
/// The persistence mode named in the runner's first line.
pub const PERSIST_MODE: &str = "local-persist-v1";
pub const WORLD_SCHEMA: &str = "frontier-localnet-natural-world-v1";
const WORLD_FILE: &str = "world.json";
const UPGRADE: &str = "keys/upgrade.seed";
const PAYER: &str = "keys/payer.seed";

/// The fresh-map mode named in the runner's first line (`--map-origin`).
pub const FRESH_MAP_MODE: &str = "local-fresh-map-v1";
/// The local chain's fixed clock origin (`localnet::Config::default().g0`, 2026-08-01T00:00:00Z): without
/// `--map-origin` every natural world starts there, so every world consumes the same genesis round.
pub const MAP_ORIGIN_DEFAULT: i64 = 1_785_542_400;
/// `--map-origin` may move the origin back by at most this (365 days: about 10.5 million genesis rounds).
pub const MAP_ORIGIN_SPAN_SECS: i64 = 365 * 86_400;

/// Whether `g0` is an origin `--map-origin` accepts: in the 365 days BEFORE the fixed origin, never after it. Every
/// round such a world needs is therefore older than the rounds a default world needs (published long ago), and later
/// than quicknet's own genesis (2023-08-23).
pub fn map_origin_ok(g0: i64) -> bool {
    (MAP_ORIGIN_DEFAULT - MAP_ORIGIN_SPAN_SECS..MAP_ORIGIN_DEFAULT).contains(&g0)
}

/// The options taken out of the runner's arguments before the shared parser sees them.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct NaturalOptions {
    pub continuous: bool,
    pub persist: Option<PathBuf>,
    /// TEST-ONLY `--map-origin <unix seconds>`: the NEW world's chain clock origin instead of the fixed one, so its
    /// Season fixes another genesis round and the program derives another genesis seed (terrain, sites, Free City,
    /// dispersed home offsets) by its unchanged rules. Ignored by a resumed world (its ledger's origin wins).
    pub map_origin: Option<i64>,
    /// TEST-ONLY `--wide-land local-wide-land-v1` (`wide_land`): the Season from `S1_DEVNET_WIDE_7D`, grown to the rim
    /// and into the wide land during the setup. Memory-only and finite: never with `continuous` or `persist`.
    pub wide: bool,
    /// TEST-ONLY `--pacing fast-v1` (world4-pacing-impl, only with `wide`): the wide world's Season takes the NEXT
    /// world's pacing bytes (`frontier_abi::v2::presets::pacing_fast`: first village at once on the settled rim,
    /// min arrival lead 1, reveal window 300 s, keep hold 36, Depart stamina 74, starter host 500) on top of the local
    /// rules, so the next world's pace can be measured locally. Without it every byte is today's.
    pub pacing: bool,
}

/// `--continuous local-continuous-v1` (exactly that word), `--persist-dir <absolute path>` and `--map-origin <unix
/// seconds, [`map_origin_ok`]>`, each at most once.
pub fn take_world_args(mut args: Vec<String>) -> Result<(Vec<String>, NaturalOptions), String> {
    let mut o = NaturalOptions::default();
    for flag in ["--continuous", "--persist-dir", "--map-origin"] {
        let Some(i) = args.iter().position(|a| a == flag) else {
            continue;
        };
        let Some(value) = args.get(i + 1).cloned() else {
            return Err(format!("{flag} needs a value"));
        };
        args.drain(i..i + 2);
        if args.iter().any(|a| a == flag) {
            return Err(format!("{flag} given twice"));
        }
        if flag == "--continuous" {
            if value != CONTINUOUS_MODE {
                return Err(format!("--continuous takes exactly `{CONTINUOUS_MODE}`"));
            }
            o.continuous = true;
        } else if flag == "--map-origin" {
            // (written plainly: digits only, no sign, no leading zero)
            let plain = !value.is_empty()
                && value.len() <= 12
                && value.bytes().all(|b| b.is_ascii_digit())
                && !value.starts_with('0');
            match value.parse::<i64>() {
                Ok(g0) if plain && map_origin_ok(g0) => o.map_origin = Some(g0),
                _ => {
                    return Err(format!(
                        "--map-origin takes unix seconds in {}..{} (the 365 days before the fixed origin)",
                        MAP_ORIGIN_DEFAULT - MAP_ORIGIN_SPAN_SECS,
                        MAP_ORIGIN_DEFAULT
                    ))
                }
            }
        } else {
            let p = PathBuf::from(&value);
            if !p.is_absolute() {
                return Err("--persist-dir must be an absolute path".into());
            }
            o.persist = Some(p);
        }
    }
    Ok((args, o))
}

// ------------------------------------------------------------------ private files

#[cfg(unix)]
fn mode_of(m: &std::fs::Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    m.permissions().mode() & 0o777
}
#[cfg(not(unix))]
fn mode_of(_: &std::fs::Metadata) -> u32 {
    0
}

/// Refuses a path that is a symbolic link, is not of the expected kind, or that any other user may use
/// (`mode & 0o077 != 0`). `what` names it in the refusal.
pub fn check_private(path: &Path, dir: bool, what: &str) -> Result<(), String> {
    let m = std::fs::symlink_metadata(path).map_err(|e| format!("{what}: {e}"))?;
    if m.file_type().is_symlink() {
        return Err(format!("{what} is a symbolic link; refusing"));
    }
    if dir != m.is_dir() || (!dir && !m.is_file()) {
        return Err(format!(
            "{what} is not a {}; refusing",
            if dir { "directory" } else { "file" }
        ));
    }
    let mode = mode_of(&m);
    if mode & 0o077 != 0 {
        return Err(format!(
            "{what} has mode {mode:03o}; the run dir must be private (directories 0700, files 0600); refusing"
        ));
    }
    Ok(())
}

/// Creates `path` as a `0700` directory when it is missing (its parent must exist), then checks it.
pub fn ensure_private_dir(path: &Path, what: &str) -> Result<(), String> {
    if std::fs::symlink_metadata(path).is_err() {
        let mut b = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            b.mode(0o700);
        }
        b.create(path).map_err(|e| format!("{what}: {e}"))?;
    }
    check_private(path, true, what)
}

/// Writes a NEW `0600` file (never over an existing one), flushed to disk.
pub fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    let mut f = o
        .open(path)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    f.write_all(bytes)
        .and_then(|_| f.sync_all())
        .map_err(|e| format!("{}: {e}", path.display()))
}

/// Replaces a `0600` file atomically (a new private file, then a rename over the old one).
fn replace_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    let _ = std::fs::remove_file(&tmp);
    write_private(&tmp, bytes)?;
    std::fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))
}

/// Reads a file only after [`check_private`] has accepted it.
pub fn read_private(path: &Path, what: &str) -> Result<Vec<u8>, String> {
    check_private(path, false, what)?;
    std::fs::read(path).map_err(|e| format!("{what}: {e}"))
}

fn seed_hex(kp: &Keypair) -> String {
    hex::encode(&kp.to_bytes()[..32])
}

fn keypair_from_seed_hex(text: &str, what: &str) -> Result<Keypair, String> {
    let raw = hex::decode(text.trim()).map_err(|_| format!("{what} is not hex; refusing"))?;
    let seed: [u8; 32] = raw
        .try_into()
        .map_err(|_| format!("{what} is not a 32-byte seed; refusing"))?;
    Ok(Keypair::new_from_array(seed))
}

// ------------------------------------------------------------------ the run dir

/// What the world in a run dir is (`world.json`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorldRecord {
    pub wallet: Address,
    pub artifact_sha256: String,
    pub continuous: bool,
    pub program: Address,
    pub season: Address,
    pub season_id: u64,
    pub upgrade: Address,
    pub payer: Address,
    pub setup_complete: bool,
}

impl WorldRecord {
    pub fn to_json(&self) -> Value {
        json!({"schema": WORLD_SCHEMA, "test_only": true, "not_for_production": true,
            "wallet": self.wallet.to_string(), "artifact_sha256": self.artifact_sha256, "continuous": self.continuous,
            "program": self.program.to_string(), "season": self.season.to_string(), "season_id": self.season_id,
            "upgrade": self.upgrade.to_string(), "payer": self.payer.to_string(), "setup_complete": self.setup_complete})
    }

    pub fn from_json(v: &Value) -> Result<WorldRecord, String> {
        let s = |k: &str| {
            v[k].as_str()
                .ok_or_else(|| format!("world.json: missing {k}; refusing"))
        };
        let a = |k: &str| -> Result<Address, String> {
            s(k)?
                .parse()
                .map_err(|_| format!("world.json: invalid {k}; refusing"))
        };
        if v["schema"].as_str() != Some(WORLD_SCHEMA) {
            return Err("world.json: another schema; refusing".into());
        }
        Ok(WorldRecord {
            wallet: a("wallet")?,
            artifact_sha256: s("artifact_sha256")?.to_owned(),
            continuous: v["continuous"]
                .as_bool()
                .ok_or("world.json: missing continuous; refusing")?,
            program: a("program")?,
            season: a("season")?,
            season_id: v["season_id"]
                .as_u64()
                .ok_or("world.json: missing season_id; refusing")?,
            upgrade: a("upgrade")?,
            payer: a("payer")?,
            setup_complete: v["setup_complete"]
                .as_bool()
                .ok_or("world.json: missing setup_complete; refusing")?,
        })
    }
}

/// A checked run dir.
pub struct RunDir {
    root: PathBuf,
}

/// What a start finds in a run dir.
pub enum Opened {
    /// No world yet: new keys, a new chain (its ledger in `chain/`).
    Fresh { upgrade: Keypair, payer: Keypair },
    /// A world to resume: its record and its two keys.
    Resume {
        record: WorldRecord,
        upgrade: Keypair,
        payer: Keypair,
    },
}

/// Public keys only: a seed is never formatted.
impl std::fmt::Debug for Opened {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Opened::Fresh { upgrade, payer } => {
                write!(f, "Fresh({}, {})", upgrade.pubkey(), payer.pubkey())
            }
            Opened::Resume { record, .. } => write!(f, "Resume({record:?})"),
        }
    }
}

impl RunDir {
    /// Checks (or creates, private) the run dir and its `keys/` and `chain/` sub-directories.
    pub fn open(root: &Path) -> Result<RunDir, String> {
        ensure_private_dir(root, "the run dir")?;
        ensure_private_dir(&root.join("keys"), "the run dir's keys/")?;
        ensure_private_dir(&root.join("chain"), "the run dir's chain/")?;
        Ok(RunDir {
            root: root.to_path_buf(),
        })
    }

    pub fn chain_dir(&self) -> PathBuf {
        self.root.join("chain")
    }

    pub fn path(&self, rel: &str) -> PathBuf {
        self.root.join(rel)
    }

    /// Fresh or resume, with every refusal of the module doc. `want` is what this start was asked for.
    pub fn start(
        &self,
        wallet: &Address,
        artifact_sha256: &str,
        continuous: bool,
    ) -> Result<Opened, String> {
        let world = self.path(WORLD_FILE);
        let ledger = self.chain_dir().join(localnet::persist::WAL_FILE);
        if std::fs::symlink_metadata(&world).is_err() {
            // (a ledger or a key without a record is another start's remains: never adopted, never overwritten)
            for (p, what) in [
                (&ledger, "a ledger"),
                (&self.path(UPGRADE), "a key"),
                (&self.path(PAYER), "a key"),
            ] {
                if std::fs::symlink_metadata(p).is_ok() {
                    return Err(format!(
                        "the run dir has {what} but no world.json; refusing (use an empty directory)"
                    ));
                }
            }
            let (upgrade, payer) = (Keypair::new(), Keypair::new());
            write_private(&self.path(UPGRADE), seed_hex(&upgrade).as_bytes())?;
            write_private(&self.path(PAYER), seed_hex(&payer).as_bytes())?;
            return Ok(Opened::Fresh { upgrade, payer });
        }
        let raw = read_private(&world, "world.json")?;
        let v: Value = serde_json::from_slice(&raw)
            .map_err(|_| "world.json is not JSON; refusing".to_string())?;
        let record = WorldRecord::from_json(&v)?;
        if &record.wallet != wallet {
            return Err("this run dir is another wallet's world; refusing".into());
        }
        if record.artifact_sha256 != artifact_sha256 {
            return Err("this run dir's world was made with another artefact; refusing".into());
        }
        if record.continuous != continuous {
            return Err(format!(
                "this run dir's world is {}; the start asked for {}; refusing",
                if record.continuous {
                    "continuous"
                } else {
                    "finite"
                },
                if continuous { "continuous" } else { "finite" }
            ));
        }
        if !record.setup_complete {
            return Err(
                "this run dir's world never finished its setup; refusing (use an empty directory)"
                    .into(),
            );
        }
        {
            // (the ledger is localnet's own file, not a key: it must be a regular file, never a link; what keeps it
            //  private is its directory, `chain/`, checked 0700 by `RunDir::open`)
            let m = std::fs::symlink_metadata(&ledger).map_err(|_| {
                "the run dir has no ledger; the world cannot be resumed without it; refusing"
                    .to_string()
            })?;
            if m.file_type().is_symlink() || !m.is_file() {
                return Err("the run dir's ledger is not a regular file; refusing".into());
            }
        }
        let key = |rel: &str, want: &Address, what: &str| -> Result<Keypair, String> {
            let text = String::from_utf8(read_private(&self.path(rel), what)?)
                .map_err(|_| format!("{what} is not text; refusing"))?;
            let kp = keypair_from_seed_hex(&text, what)?;
            if &kp.pubkey() != want {
                return Err(format!("{what} is not the world's recorded key; refusing"));
            }
            Ok(kp)
        };
        let upgrade = key(UPGRADE, &record.upgrade, "keys/upgrade.seed")?;
        let payer = key(PAYER, &record.payer, "keys/payer.seed")?;
        Ok(Opened::Resume {
            record,
            upgrade,
            payer,
        })
    }

    /// Writes (or replaces) `world.json`.
    pub fn record(&self, r: &WorldRecord) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(&r.to_json()).map_err(|e| e.to_string())?;
        let p = self.path(WORLD_FILE);
        if std::fs::symlink_metadata(&p).is_ok() {
            check_private(&p, false, "world.json")?;
            replace_private(&p, &bytes)
        } else {
            write_private(&p, &bytes)
        }
    }
}

/// The resumed chain's Season must be the recorded one: this program's, the recorded authority, the asked-for
/// continuous flag with the matching end and join-close bells.
pub fn check_resumed_season(season_data: &[u8], record: &WorldRecord) -> Result<(), String> {
    let s = fclient::decode::Season::decode(season_data)
        .map_err(|e| format!("the resumed chain's Season cannot be read ({e:?}); refusing"))?;
    if s.authority != record.upgrade || s.h.season_id != record.season_id {
        return Err("the resumed chain's Season is not the recorded one; refusing".into());
    }
    let cq = s
        .conquest
        .as_ref()
        .ok_or("the resumed chain's Season has no conquest parameters; refusing")?;
    let flagged = cq.continuous == 1;
    let no_end = s.end_bell == u32::MAX && s.join_close_bell == u32::MAX;
    if flagged != record.continuous || flagged != no_end {
        return Err(
            "the resumed chain's Season does not have the recorded continuous shape; refusing"
                .into(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "psf-natural-persist-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    /// TEST-ONLY `--map-origin`: plain unix seconds inside the 365 days before the fixed origin, at most once; the
    /// fixed origin itself, a later one, an earlier one and anything not written plainly are refused. Without the
    /// option nothing changes (`map_origin: None`).
    #[test]
    fn the_map_origin_option_is_bounded_and_optional() {
        let a = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(MAP_ORIGIN_DEFAULT, localnet::Config::default().g0);
        assert_eq!(take_world_args(a(&["--x"])).unwrap().1.map_origin, None);
        let lo = MAP_ORIGIN_DEFAULT - MAP_ORIGIN_SPAN_SECS;
        for ok in [lo, lo + 1, MAP_ORIGIN_DEFAULT - 1] {
            let (rest, o) =
                take_world_args(a(&["--map-origin", &ok.to_string(), "--x", "1"])).unwrap();
            assert_eq!((rest, o.map_origin), (a(&["--x", "1"]), Some(ok)));
            assert!(!o.continuous && o.persist.is_none());
        }
        let near = (MAP_ORIGIN_DEFAULT - 5).to_string();
        for bad in [
            (lo - 1).to_string(),
            MAP_ORIGIN_DEFAULT.to_string(),
            (MAP_ORIGIN_DEFAULT + 1).to_string(),
            "0".into(),
            "-1".into(),
            String::new(),
            format!("+{near}"),
            format!("0{near}"),
            format!("{near}.0"),
            format!(" {near}"),
            "99999999999999999999".into(),
            "now".into(),
        ] {
            assert!(
                take_world_args(a(&["--map-origin", &bad])).is_err(),
                "{bad:?}"
            );
        }
        assert!(take_world_args(a(&["--map-origin"])).is_err());
        assert!(take_world_args(a(&["--map-origin", &near, "--map-origin", &near])).is_err());
    }

    #[test]
    fn the_two_options_are_exact_and_optional() {
        let a = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let (rest, o) = take_world_args(a(&["--x", "1"])).unwrap();
        assert_eq!((rest, o), (a(&["--x", "1"]), NaturalOptions::default()));
        let (rest, o) = take_world_args(a(&[
            "--continuous",
            CONTINUOUS_MODE,
            "--x",
            "1",
            "--persist-dir",
            "/abs/w",
        ]))
        .unwrap();
        assert_eq!(rest, a(&["--x", "1"]));
        assert!(o.continuous);
        assert_eq!(o.persist, Some(PathBuf::from("/abs/w")));
        assert!(take_world_args(a(&["--continuous", "yes"])).is_err());
        assert!(take_world_args(a(&["--continuous"])).is_err());
        assert!(take_world_args(a(&["--persist-dir", "rel/w"])).is_err());
        assert!(take_world_args(a(&["--persist-dir", "/a", "--persist-dir", "/b"])).is_err());
        assert!(take_world_args(a(&[
            "--continuous",
            CONTINUOUS_MODE,
            "--continuous",
            CONTINUOUS_MODE
        ]))
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_run_dir_is_private_and_a_looser_one_is_refused() {
        use std::os::unix::fs::PermissionsExt;
        let d = tmp("perm");
        let rd = RunDir::open(&d).unwrap();
        for sub in ["", "keys", "chain"] {
            let m = std::fs::metadata(d.join(sub)).unwrap().permissions().mode() & 0o777;
            assert_eq!(m, 0o700, "{sub}");
        }
        let w = Address::new_from_array([7; 32]);
        let Opened::Fresh { upgrade, payer } = rd.start(&w, &"a".repeat(64), true).unwrap() else {
            panic!("fresh")
        };
        for f in [UPGRADE, PAYER] {
            let m = std::fs::metadata(d.join(f)).unwrap().permissions().mode() & 0o777;
            assert_eq!(m, 0o600, "{f}");
        }
        // a second start before setup finished: the keys are there without a record → refused, nothing overwritten
        assert!(rd.start(&w, &"a".repeat(64), true).is_err());
        assert_eq!(
            keypair_from_seed_hex(&std::fs::read_to_string(d.join(UPGRADE)).unwrap(), "k")
                .unwrap()
                .pubkey(),
            upgrade.pubkey()
        );
        let rec = WorldRecord {
            wallet: w,
            artifact_sha256: "a".repeat(64),
            continuous: true,
            program: Address::new_from_array([0x45; 32]),
            season: Address::new_from_array([9; 32]),
            season_id: 1,
            upgrade: upgrade.pubkey(),
            payer: payer.pubkey(),
            setup_complete: true,
        };
        rd.record(&rec).unwrap();
        // no ledger: refused
        assert!(rd
            .start(&w, &"a".repeat(64), true)
            .unwrap_err()
            .contains("ledger"));
        write_private(&d.join("chain").join(localnet::persist::WAL_FILE), b"x").unwrap();
        let Opened::Resume {
            record,
            upgrade: u2,
            ..
        } = rd.start(&w, &"a".repeat(64), true).unwrap()
        else {
            panic!("resume")
        };
        assert_eq!((record, u2.pubkey()), (rec.clone(), upgrade.pubkey()));
        // another wallet, artefact or continuous word: refused
        assert!(rd
            .start(&Address::new_from_array([8; 32]), &"a".repeat(64), true)
            .unwrap_err()
            .contains("another wallet"));
        assert!(rd
            .start(&w, &"b".repeat(64), true)
            .unwrap_err()
            .contains("another artefact"));
        assert!(rd
            .start(&w, &"a".repeat(64), false)
            .unwrap_err()
            .contains("continuous"));
        // looser modes: the key file, the keys dir, the run dir itself
        std::fs::set_permissions(d.join(UPGRADE), std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(rd
            .start(&w, &"a".repeat(64), true)
            .unwrap_err()
            .contains("mode 644"));
        std::fs::set_permissions(d.join(UPGRADE), std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::set_permissions(d.join("keys"), std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(RunDir::open(&d).err().unwrap().contains("mode 755"));
        std::fs::set_permissions(d.join("keys"), std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o750)).unwrap();
        assert!(RunDir::open(&d).err().unwrap().contains("mode 750"));
        std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o700)).unwrap();
        // a key replaced by another key: refused
        std::fs::remove_file(d.join(PAYER)).unwrap();
        write_private(&d.join(PAYER), seed_hex(&Keypair::new()).as_bytes()).unwrap();
        assert!(rd
            .start(&w, &"a".repeat(64), true)
            .unwrap_err()
            .contains("recorded key"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_run_dir_is_refused() {
        let d = tmp("link");
        std::fs::create_dir_all(&d).unwrap();
        let real = d.join("real");
        ensure_private_dir(&real, "real").unwrap();
        let link = d.join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(RunDir::open(&link).err().unwrap().contains("symbolic link"));
        let _ = std::fs::remove_dir_all(&d);
    }
}
