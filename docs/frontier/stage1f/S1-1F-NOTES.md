# S1 stage 1f — the screens and the AI

Plan: `docs/design/redesign/30-stage1-build-plan.ja.md` §2 (1f) and §5.

## What was built

### Web client (`permutation-server/web/frontier/`)

- **Arms and the workshop** (`fs1.mjs`): on an S1 season (layout 2,
  program_version ≥ 4) the Horses slot is named 兵器 / Arms with the swords
  icon. The strong units' arms cost shows in both training quotes. The
  workshop (build item 8) is offered and named in the queue. The numbers
  are pinned against `arms.rs`.
- **The S1 feeds** (`herald.mjs`): strict readers for `h/caravans.json`,
  `h/structures.json` and `h/nations.json`. `controller.mjs` refreshes them
  into `FS.s1` with the conquest data.
- **The map** (`map/s1marks.mjs`):
  - a strongbox for a storehouse;
  - a watchtower, palisade or fort on its tile; a tower of the viewer's
    nation rims the tiles it watches;
  - a cart for each caravan on the road. Its position is estimated from
    the bells of its runs, and its tag gives the arrival turn.
- **The orders** (`fplay.mjs`, `fcaravan.mjs`, `faddr.mjs`):
  - shapes: BuildVault, SendCaravan, RaidCaravan (take and burn),
    BuildStructure, FortGarrison, Propose, Vote;
  - the fastest-road planner;
  - the S1 account addresses.

  All of it is pinned against fclient by Rust-written vectors
  (`frontier-node/crates/fclient/tests/caravan_path_vectors.rs` writes
  `permutation-gateway/test/fixtures/{caravan-path,s1-addresses,s1-ix}-v1.json`).
  The vectors are checked key for key and byte for byte, and must pass the
  relay's classifier and the page's pre-signing check under an S1 pin.
- **The panels** (`screens/s1.mjs`):
  - On a chosen tile: what stands there, and what may be built there.
    The program's site, limit and cost rules apply.
  - On a chosen tile: a raid the viewer's host has won, to take home or
    to burn.
  - In the village: its caravans, storehouses and structures.
  - In the village: sending a caravan to another of its own places.
  - In the village: manning its fort.
  - In the village: the nation's stances, its open proposals (with votes)
    and a stance proposal.
- **Words**: a vault is 貯蔵庫 / storehouse, because 蔵 stays the
  village's stores. A fort is 要塞, because 砦 stays the conquest keep.

### Herald

- The caravan feed carries each caravan's packed `path` and the
  `provinces` of its route, i.e. the Caravan's `PROVINCES`, which a raid's
  take must name.

### AI (`frontier-node/crates/bots`)

- `fclient` decodes a Province v2's caravan slots, structure list and
  forts, and a Citizen v2's storehouse and caravan counters.
- `ai/s1.rs` adds three candidates on an S1 season only:
  - **ambush**: march onto another nation's caravan road, arriving before
    the caravan's last stand there. A waiting host raids it (1c).
  - **escort**: the same onto the bot's own caravan's road.
  - **caravan**: a store over 80 % of its cap sends what is over 50 %, as
    much as another of the bot's holdings takes below 50 %, at most 1,000
    a good. It goes along `caravan::fastest_path`.

  Each is re-planned when chosen (V6): an ambush or escort that would
  arrive too late, or whose caravan is gone, is dropped. A caravan becomes
  `Intent::SendCaravan`. Tests: `bots/tests/ai_s1.rs`, on the MC fixture
  world played as an S1 season.
- The workshop was already offered (stage 1a).
- `frontier-bots --s1` plays an S1 season: the conquest layer with the S1
  budgets (fclient's `Budgets::canonical_for`), which the relay asks of a
  profile-3 season. Before this, every sponsored send of a bot on an S1
  season carried MC loaded limits and would have been refused.

## Still open

- **Whether the AI actually marches** (plan §5). This needs a run with the
  mind service; the offline tests only show the candidates are offered and
  planned. To check, run a localnet S1 season with
  `frontier-bots --s1` and the mind, then count `depart` sends by
  `target_kind`.
- **The S1 WASM module**: `scripts/build-wasm.sh --s1` →
  `frontier-v3.wasm`, loaded when `programVersion >= 4`. It must be built
  on the reference Mac.
- **Projecting a converting holding past its dry time** in the page (the
  workshop stops when ore or wood runs out).
- **Not offered yet**:
  - on the page: caravans from a storehouse (its stores are not in a
    feed), sends to another player (they need the wallet), and
    expulsion/readmission proposals (they need the target's Citizen
    address);
  - to the AI: the raid decision. DefaultRaid takes the caravan to the
    raider's holding after the window.
- **The fort rule** (S1-1E-CONTRACT §2.6 / §10 item 3): still the owner's
  decision.
