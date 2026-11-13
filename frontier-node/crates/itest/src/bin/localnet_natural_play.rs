//! Temporary NATURAL local-play node (launcher preset `local-natural-v1`; see `itest::natural_play`): a new Season by
//! its own instructions, the player's real Join and PlaceHome from the page, then the keeper on that home. Prints
//! public JSON lines, serves on 127.0.0.1 until Ctrl-C, then stops. No key of the player's, no persistence, no tamper
//! RPC; the only sends are the world's own setup and the keeper's.
//!
//!   localnet-natural-play --artifact <abs .so> --artifact-sha256 <hex> --player-wallet <base58 public key> \
//!     --rpc-port <41000-41999> --ws-port <41000-41999> --keeper public-quicknet
use itest::expedition_play as play;
use itest::natural_play as natural;

fn main() {
    let result = (|| -> Result<(), String> {
        let o = play::parse_args(std::env::args().skip(1))?;
        if !o.keeper {
            return Err("the natural world needs --keeper public-quicknet (its turns are resolved by the keeper)".into());
        }
        if o.wide_destination {
            return Err("the natural world has no wide-destination fixture".into());
        }
        let artifact = play::read_artifact(&o)?;
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().map_err(|e| e.to_string())?;
        rt.block_on(async {
            let world = natural::prepare(&artifact, o.player_wallet, o.rpc_port, o.ws_port).await?;
            println!("{}", world.metadata);
            let (stop_tx, mut stop_rx) = tokio::sync::watch::channel(false);
            let keeper_rx = stop_rx.clone();
            let mut hold_rx = stop_rx.clone();
            let state = world.state.clone();
            let wallet = o.player_wallet;
            let task = tokio::spawn(async move {
                match natural::await_home(&world, &wallet, &mut stop_rx).await {
                    Ok((home, _sig)) => {
                        itest::keeper_loop::run_at(state, itest::keeper_loop::public_quicknet(), Some(home.holding), home.home, keeper_rx, |s| println!("{}", s.json())).await;
                    }
                    Err(e) => println!("{}", serde_json::json!({"schema": natural::NATURAL_SCHEMA, "natural_step": "stopped", "why": e, "keeper_started": false})),
                }
                // the node keeps serving until the launcher ends the world, whatever the keeper did
                while !*hold_rx.borrow() {
                    if hold_rx.changed().await.is_err() {
                        break;
                    }
                }
                drop(world);
            });
            tokio::signal::ctrl_c().await.map_err(|e| e.to_string())?;
            let _ = stop_tx.send(true);
            let _ = task.await;
            Ok(())
        })
    })();
    if let Err(e) = result {
        eprintln!("localnet-natural-play: {e}");
        std::process::exit(2);
    }
}
