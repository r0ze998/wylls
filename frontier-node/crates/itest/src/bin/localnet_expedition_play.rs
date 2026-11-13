//! Temporary local-play node for the isolated `localnet-expedition-sbf`
//! artifact (see `itest::expedition_play`). Prints one JSON line of public
//! metadata, serves on 127.0.0.1 until Ctrl-C, then stops. No key, no
//! persistence, no tamper RPC, no automatic send.
//!
//!   localnet-expedition-play --artifact <abs .so> --artifact-sha256 <hex> \
//!     --player-wallet <base58 public key> --rpc-port <41000-41999> --ws-port <41000-41999> \
//!     [--keeper public-quicknet]   (opt-in: keeps the home resident with verified public rounds)
//!     [--wide-destination public-quicknet]   (opt-in isolated test fixture: makes (129, 0) real; see itest::wide_destination)
//!     [--world-preset local-conquest-test-v1] (opt-in, conquest runner only: with --wide-destination and an artefact
//!                                              carrying both lane markers, (129, 0) is opened with the canonical
//!                                              Free City rule and one line states `conquest_world`; itest::conquest_world)
use itest::expedition_play as play;

fn main() {
    let result = (|| -> Result<(), String> {
        let args: Vec<String> = std::env::args().skip(1).collect();
        #[cfg(feature = "localnet-conquest-play")]
        let (preset, args) = itest::conquest_world::split_world_preset(args)?;
        #[cfg(not(feature = "localnet-conquest-play"))]
        let preset: Option<String> = if args.iter().any(|a| a == "--world-preset") {
            return Err("--world-preset needs a runner built with localnet-conquest-play".into());
        } else {
            None
        };
        let o = play::parse_args(args)?;
        let artifact = play::read_artifact(&o)?;
        #[cfg(feature = "localnet-conquest-play")]
        if preset.is_some() {
            if !o.wide_destination {
                return Err("--world-preset local-conquest-test-v1 needs --wide-destination public-quicknet".into());
            }
            let bytes = std::fs::read(artifact.path()).map_err(|e| format!("artefact: {e}"))?;
            itest::conquest_world::markers_ok(&bytes, artifact.sha256())?;
        }
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
            let this_start = (artifact.sha256().to_string(), p.metadata["program"].as_str().unwrap_or("").to_string(),
                p.metadata["season"].as_str().unwrap_or("").to_string(), p.metadata["rpc_url"].as_str().unwrap_or("").to_string());
            let _ = &this_start;
            let wide = p.wide.take().map(|plan| {
                let state = p.running.state.clone();
                let rx = wide_rx;
                let conquest = preset.is_some();
                tokio::spawn(async move {
                    if conquest {
                        #[cfg(feature = "localnet-conquest-play")]
                        {
                            let (sha, program, season, rpc) = this_start;
                            match itest::conquest_world::open(state, plan, &sha, &program, &season, &rpc, rx, |v| println!("{v}")).await {
                                Ok(cap) => println!("{}", serde_json::json!({"schema": play::SCHEMA, "conquest_world": cap})),
                                Err(e) => println!("{}", serde_json::json!({"schema": itest::wide_destination::SCHEMA, "stopped": e,
                                    "world_preset": itest::conquest_world::PRESET, "conquest_world_stated": false})),
                            }
                        }
                        return;
                    }
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
