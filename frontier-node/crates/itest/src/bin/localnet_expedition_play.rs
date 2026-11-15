//! Temporary local-play node for the isolated `localnet-expedition-sbf`
//! artifact (see `itest::expedition_play`). Prints one JSON line of public
//! metadata, serves on 127.0.0.1 until Ctrl-C, then stops. No key, no
//! persistence, no tamper RPC, no automatic send.
//!
//!   localnet-expedition-play --artifact <abs .so> --artifact-sha256 <hex> \
//!     --player-wallet <base58 public key> --rpc-port <41000-41999> --ws-port <41000-41999> \
//!     [--keeper public-quicknet]   (opt-in: keeps the home resident with verified public rounds)
//!     [--wide-destination public-quicknet]   (opt-in isolated test fixture: makes (129, 0) real; see itest::wide_destination)
use itest::expedition_play as play;

fn main() {
    let result = (|| -> Result<(), String> {
        let o = play::parse_args(std::env::args().skip(1))?;
        let artifact = play::read_artifact(&o)?;
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().map_err(|e| e.to_string())?;
        rt.block_on(async {
            let mut p = play::launch_full(&artifact, o.player_wallet, o.rpc_port, o.ws_port, o.keeper, o.wide_destination).await?;
            println!("{}", p.metadata);
            let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
            let wide_rx = stop_rx.clone();
            let keeper = o.keeper.then(|| {
                let state = p.running.state.clone();
                let holding = Some(p.fixture.holding);
                tokio::spawn(itest::keeper_loop::run(state, itest::keeper_loop::public_quicknet(), holding, stop_rx, |s| println!("{}", s.json())))
            });
            let wide = p.wide.take().map(|plan| {
                let state = p.running.state.clone();
                let rx = wide_rx;
                tokio::spawn(async move {
                    let r = itest::wide_destination::run(state, plan, rx, |v| println!("{v}")).await;
                    if let Err(e) = r {
                        println!("{}", serde_json::json!({"schema": itest::wide_destination::SCHEMA, "stopped": e}));
                    }
                })
            });
            tokio::signal::ctrl_c().await.map_err(|e| e.to_string())?;
            let _ = stop_tx.send(true);
            if let Some(k) = keeper {
                let _ = k.await;
            }
            if let Some(w) = wide {
                let _ = w.await;
            }
            p.running.stop();
            println!("{}", serde_json::json!({"schema": play::SCHEMA, "stopped": true}));
            Ok(())
        })
    })();
    if let Err(e) = result {
        eprintln!("localnet-expedition-play: {e}");
        std::process::exit(2);
    }
}
