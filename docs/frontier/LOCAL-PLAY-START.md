# Playing Frontier locally: build and start from this repository

This page says how to build and start the local-play launcher from a clone of this branch. It also says what each of
the two modes shows on screen, and what is not done yet. Every step here comes from the sources in this repository.
A start from a fresh clone on a new machine has **not** been run end to end yet.

Two modes, never mixed:

| | (1) Natural world | (2) Capture demo (TEST-ONLY) |
|---|---|---|
| Clock | real time: a turn is 600 s | after your home, compressed ×10–×60 (`--demo-scale`) |
| Other villages | none; you are alone | test participants, each with its own in-memory key |
| Rules | the program's rules | the same rules; nothing is changed |
| On screen | always the session notice | also a fourth line: 「この世界は試験用の攻略デモです…」 |
| What it can show | home, economy, army, an ordinary march | also the next ring opening, the fort list, a march onto a fort and its hold count |

## 1. What you need (installed beforehand; nothing here installs anything)
- **Node.js** 20 (20.19 was used). The launcher and its relay use only Node's built-in modules, so no `npm install` is needed
  to start them.
- **Rust** through rustup. `frontier-node/rust-toolchain.toml` pins 1.95.0.
  - The builds below use `--locked`.
  - The first build needs network access to fetch crates, or a filled cargo cache.
- **For the program artefact:** `solana-cargo-build-sbf 3.1.9` and platform-tools v1.52, already installed.
  `scripts/build-frontier.sh` checks both and refuses to download anything.
- **A browser** on the same machine. Everything listens on 127.0.0.1 only.
- **Network during play:** the keeper reads public drand rounds over HTTPS.
- **No wallet, key or funds.** The page makes a memory-only key for each world. The local chain lives in memory and
  ends with the world.

## 2. Build (from the repository root)
Every binary goes into the usual cargo target directories. The launcher asks for absolute paths to them (§3).

```bash
# the program artefact (localnet test lane; never deployable): writes
#   permutation-frontier/target/deploy-localnet-conquest-sbf/permutation_frontier.so
scripts/build-frontier-localnet-conquest-sbf.sh
```

```bash
# the runners: localnet-natural-play (natural world and capture demo) and localnet-expedition-play
(cd frontier-node && cargo build --locked -p itest --features localnet-expedition-play --bin localnet-natural-play --bin localnet-expedition-play)
```

```bash
# the herald: default features are enough for the natural world and the demo
(cd frontier-node && cargo build --locked -p herald --bin frontier-herald)
```

```bash
# the depart / preview / resident command-line tools the relay calls
(cd frontier-node && cargo build --locked -p keeper --features expedition-dispatch-experimental --bin frontier-experimental-expedition-depart-prepare --bin frontier-original-expedition-preview --bin frontier-experimental-expedition-prepare)
```

- **Artefact hash:** `--artifact-sha` is the SHA-256 of your `.so`. The launcher refuses a file whose hash differs.
  - On 2026-11-13 this branch's program sources rebuilt to
    `b64a539afe066c59c6584ff7928f620647428f1a115df41f9289c772c4447f80` with the tools above.
  - Another toolchain may give another hash. Pass the hash of the file you built.
- **The herald's `local-play-bootstrap` feature** (named in the launcher's usage text) is used only by the
  launcher's non-natural presets. The two modes here do not pass `--local-play-metadata`, so they do not need it.

## 3. Start
Choose a new directory for the worlds' records (logs and the herald's fold files; nothing secret). Put each path in
a shell variable first, as absolute paths:
- `ROOT`: the repository root;
- `DATA`: the records directory;
- `T`: `ROOT/frontier-node/target/debug`;
- `SO`: the `.so` file built in §2;
- `SHA`: its SHA-256.

### (1) Natural world
```bash
node "$ROOT/permutation-gateway/src/frontier/local-play-launcher.mjs" --root "$ROOT" --data "$DATA" --runner "$T/localnet-expedition-play" --natural-runner "$T/localnet-natural-play" --world-preset local-natural-v1 --economy page-signed-v1 --march-trial local-march-trial-v1 --herald "$T/frontier-herald" --depart "$T/frontier-experimental-expedition-depart-prepare" --preview "$T/frontier-original-expedition-preview" --resident "$T/frontier-experimental-expedition-prepare" --artifact "$SO" --artifact-sha "$SHA"
```
- **Without `--march-trial`** the world is the same, but the ordinary march stays closed. Its live readiness is
  not proven yet.
- **`--world-ttl-minutes <n>`:** each world's life. The default is two hours.
- **`--port` / `--world-port`:** default 41920 / 41924. The ports must be within 41000–41999.

### (2) Capture demo (TEST-ONLY)
Add both words to the natural command above:
```bash
--capture-demo capture-demo-v1 --demo-scale 20
```
- The launcher refuses the demo words on anything but a natural world with `--march-trial`. It also refuses them if
  the runner's first line does not state the same demo.
- The page address gets `demo=capture` from the launcher only.

### Then
1. Open `http://localhost:41920/` and press 「新しい世界を開始」.
2. Choose a nation and press 「…で始める」 (Join, then PlaceHome).
3. Build, train (訓練), then muster (編成). The army can act once the keeper has resolved the turn, about 17 minutes
   later at 1×.
4. Use 進軍 to choose a destination, then press 「封をして出発する」. The keeper settles the march by itself.
5. On the demo only: once the next ring is open, the guide offers 「届く砦を見る」 and the fort list 「届く砦」.
   A march onto a fort starts its hold count, 「…争奪中 N/72ターン」.
6. To stop, press Ctrl-C in the launcher's terminal. It ends every world of that launcher.
7. Then close that world's browser tab. Ctrl-C alone does not remove the page's memory-only key from the browser;
   closing the tab discards it. Close only the tab you opened for this world and leave every other tab alone. A key
   in a tab left open is gone only when that tab closes, and that cannot be confirmed from outside it.

## 4. What is done, and what is not
- **Natural world, on screen:** nation, home, economy, army, the ordinary march sent by the page's own key, and its
  settlement.
- **Natural world, by the rules:** no area expansion or capture.
  - A ring past the heartland opens only at θ occupancy of one wedge, which one player cannot reach alone.
  - Every keep inside a heartland is safe and never counts.
- **Capture demo, on screen (×20):** the next ring opened; the fort list showed two forts; a march reached a fort and
  started its hold count.
  - **The 72-turn capture has NOT been completed on screen.**
  - **First run (2026-11-13):** while a fort is contested, each of its turns needs three keeper steps, and the keeper
    took one step per 10-second tick, so the hold advanced about one turn per minute. At that rate 72 turns could not
    fit in the world's 45-minute limit. So the world was stopped by hand (Ctrl-C) about 17 minutes after it started,
    at 4/72. It did not reach its limit.
  - **Second run (2026-11-14), with the demo pace:** on a demo world only, the keeper's next tick comes after 1 s while
    its steps land (at most 8 in a row); a natural world ticks as before. The fort's turns then resolved every 29.9 s
    on average, the ×20 clock's own rate. The hold started at turn 14. When the world reached its 45-minute limit
    (not extended), the chain's hold count was **71/72**, one turn short, and the world ended by itself. The page
    showed 65/72 at that moment and said its display was 180 seconds behind.
  - At ×20, a hold that starts at turn 14 cannot reach 72 inside 45 minutes, even at the clock's own rate.
- **The capture itself** (72 counted turns, the new holder, the return) is proven only by the in-process tests on
  the real program, on a compressed clock. It is not proven through the page.
- **Not run:** a build and start from a fresh clone on another machine.
