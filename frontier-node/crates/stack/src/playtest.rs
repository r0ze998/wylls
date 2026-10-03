//! PT-A: what the playtest adds to the stack (the gated season, the bots'
//! invites, the relay's JSONL event log). Local chain only; nothing here
//! prints a secret.
//!
//! * `playtest.secrets_dir` (mode 0700, outside git) holds `gate.key` (the
//!   relay's join-gate keypair: a Solana CLI JSON array of the 64 secret-key
//!   bytes, mode 0600) and `invite.secret` (32 random bytes as hex, mode
//!   0600). Both are created from the OS CSPRNG the first time and read
//!   after that; the stack passes their *paths* to the relay and puts the
//!   gate's **public** key into `CreateSeason` (`M1_PLAYTEST`, I-51).
//! * The bots join through the same gate: the stack asks the relay's operator
//!   route for one invite per bot (`bots/invites.txt`, mode 0600, kept across
//!   restarts), so the fleet's joins are told apart from the people's in the
//!   relay's event log by label.

use std::path::{Path, PathBuf};

use fclient::{Keypair, Signer};
use serde_json::{json, Value};

use crate::run;

pub const GATE_KEY_FILE: &str = "gate.key";
pub const INVITE_SECRET_FILE: &str = "invite.secret";
/// `relay/relay-events.jsonl` under the run directory.
pub const RELAY_EVENT_LOG: &str = "relay/relay-events.jsonl";
/// The bots' invites, one per line, in roster order.
pub const BOT_INVITES: &str = "bots/invites.txt";

/// `dir` with mode 0700 (created; an existing one is tightened).
pub fn ensure_secrets_dir(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    Ok(())
}

/// The relay's join-gate key in `dir`: created (64 secret-key bytes as a
/// JSON array, the format `solana-keygen` and the relay's `keys.mjs` use,
/// mode 0600) when absent. Returns the public key. A file that is not
/// owner-only is tightened to 0600.
pub fn ensure_gate_key(dir: &Path) -> Result<[u8; 32], String> {
    ensure_secrets_dir(dir)?;
    let p = dir.join(GATE_KEY_FILE);
    if !p.exists() {
        let mut seed = [0u8; 32];
        run::getrandom(&mut seed)?;
        let pk = Keypair::new_from_array(seed).pubkey().to_bytes();
        let bytes: Vec<u8> = seed.iter().chain(pk.iter()).copied().collect();
        write_new_0600(&p, &serde_json::to_string(&bytes).map_err(|e| e.to_string())?)?;
    }
    tighten(&p)?;
    gate_pubkey(&p)
}

/// The public half of a gate key file (the last 32 bytes of its array),
/// checked against the seed (the first 32).
pub fn gate_pubkey(p: &Path) -> Result<[u8; 32], String> {
    let t = std::fs::read_to_string(p).map_err(|e| format!("{}: {e}", p.display()))?;
    let v: Vec<u8> =
        serde_json::from_str(&t).map_err(|_| format!("{}: not a JSON array of bytes", p.display()))?;
    if v.len() != 64 {
        return Err(format!("{}: {} bytes, not 64", p.display(), v.len()));
    }
    let seed: [u8; 32] = v[..32].try_into().expect("32");
    let pk: [u8; 32] = v[32..].try_into().expect("32");
    if Keypair::new_from_array(seed).pubkey().to_bytes() != pk {
        return Err(format!(
            "{}: the public half does not match the seed",
            p.display()
        ));
    }
    Ok(pk)
}

/// The invite secret in `dir`, created when absent (`run::secret`: hex,
/// mode 0600). Returns its path.
pub fn ensure_invite_secret(dir: &Path) -> Result<PathBuf, String> {
    ensure_secrets_dir(dir)?;
    let p = dir.join(INVITE_SECRET_FILE);
    run::secret(&p)?;
    tighten(&p)?;
    Ok(p)
}

fn tighten(p: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let m = std::fs::metadata(p)
            .map_err(|e| format!("{}: {e}", p.display()))?
            .permissions()
            .mode();
        if m & 0o077 != 0 {
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o600))
                .map_err(|e| format!("{}: {e}", p.display()))?;
        }
    }
    let _ = p;
    Ok(())
}

fn write_new_0600(p: &Path, text: &str) -> Result<(), String> {
    use std::io::Write;
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    o.mode(0o600);
    let mut f = o.open(p).map_err(|e| format!("{}: {e}", p.display()))?;
    f.write_all(text.as_bytes())
        .and_then(|_| f.write_all(b"\n"))
        .map_err(|e| e.to_string())
}

/// `count` invites from the relay's operator route (`POST
/// /f/operator/invites`, bearer token, at most 1,000 a call), tagged
/// `label` in the relay's event log.
pub async fn issue_invites(
    operator_port: u16,
    token: &str,
    count: usize,
    label: &str,
) -> Result<Vec<String>, String> {
    let url = format!("http://127.0.0.1:{operator_port}/f/operator/invites");
    let auth = format!("Bearer {token}");
    let mut out = Vec::with_capacity(count);
    while out.len() < count {
        let n = (count - out.len()).min(1_000);
        let body = serde_json::to_vec(&json!({"count": n, "label": label}))
            .map_err(|e| e.to_string())?;
        let r = fclient::http::request_with_headers(
            "POST",
            &url,
            Some(body),
            &[("authorization", &auth)],
        )
        .await
        .map_err(|e| format!("POST {url}: {e}"))?;
        if r.status != 200 {
            return Err(format!("POST {url}: HTTP {}", r.status));
        }
        let v: Value = serde_json::from_slice(&r.body).map_err(|e| format!("invites: {e}"))?;
        let list = v["invites"].as_array().ok_or("invites: no `invites` array")?;
        if list.len() != n {
            return Err(format!("invites: asked for {n}, got {}", list.len()));
        }
        out.extend(list.iter().filter_map(|x| x.as_str().map(String::from)));
    }
    Ok(out)
}

/// The bots' invites file of a run: kept when it already holds `count`
/// invites (a restart must give each bot the invite it joined with),
/// else issued (label `bots`) and written, mode 0600. Returns the path.
pub async fn ensure_bot_invites(
    rd: &run::RunDir,
    operator_port: u16,
    token: &str,
    count: usize,
) -> Result<PathBuf, String> {
    let p = rd.path(BOT_INVITES);
    let have = std::fs::read_to_string(&p)
        .map(|t| t.lines().filter(|l| !l.trim().is_empty()).count())
        .unwrap_or(0);
    if have >= count {
        return Ok(p);
    }
    let list = issue_invites(operator_port, token, count, "bots").await?;
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    // Replaced whole (an earlier, shorter file's invites were issued and
    // are simply not used again).
    let _ = std::fs::remove_file(&p);
    write_new_0600(&p, &list.join("\n"))?;
    Ok(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("psf-playtest-{name}-{}", run::wall_ms()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn the_gate_key_and_invite_secret_are_made_once_and_owner_only() {
        let d = tmp("secrets");
        let pk = ensure_gate_key(&d).unwrap();
        assert_eq!(ensure_gate_key(&d).unwrap(), pk, "stable");
        let sec = ensure_invite_secret(&d).unwrap();
        let s1 = std::fs::read_to_string(&sec).unwrap();
        assert_eq!(s1.trim().len(), 64);
        ensure_invite_secret(&d).unwrap();
        assert_eq!(std::fs::read_to_string(&sec).unwrap(), s1, "stable");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&d), 0o700);
            assert_eq!(mode(&d.join(GATE_KEY_FILE)), 0o600);
            assert_eq!(mode(&sec), 0o600);
            // A loosened file is tightened on the next start.
            std::fs::set_permissions(
                d.join(GATE_KEY_FILE),
                std::fs::Permissions::from_mode(0o644),
            )
            .unwrap();
            ensure_gate_key(&d).unwrap();
            assert_eq!(mode(&d.join(GATE_KEY_FILE)), 0o600);
        }
        // The file is the JSON array of 64 bytes the relay's keys.mjs reads,
        // seed then public key.
        let v: Vec<u8> =
            serde_json::from_str(&std::fs::read_to_string(d.join(GATE_KEY_FILE)).unwrap())
                .unwrap();
        assert_eq!(v.len(), 64);
        assert_eq!(&v[32..], &pk);
        // A key whose public half does not match its seed is refused.
        let mut bad = v.clone();
        bad[40] ^= 1;
        let p = d.join("bad.key");
        std::fs::write(&p, serde_json::to_string(&bad).unwrap()).unwrap();
        assert!(gate_pubkey(&p).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_gated_season_names_the_gate_in_its_params() {
        let g = [9u8; 32];
        let open = crate::setup::season_params(crate::config::Beacon::Archive, None);
        let gated = crate::setup::season_params_gated(crate::config::Beacon::Archive, None, Some(g));
        assert_eq!(open.join_gate, [0u8; 32], "every other run is ungated");
        assert_eq!(gated.join_gate, g);
        assert_eq!(
            crate::setup::season_params_gated(crate::config::Beacon::Archive, None, None).to_bytes(),
            open.to_bytes()
        );
        assert_ne!(gated.to_bytes(), open.to_bytes());
        assert!(gated.validate().is_ok());
        // Nothing else of the preset moves.
        assert_eq!(
            (gated.end_bell, gated.join_close_bell, gated.r_max),
            (open.end_bell, open.join_close_bell, open.r_max)
        );
    }
}
