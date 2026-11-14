# Candidate lane: territory as 0xDD, movement as 0xE2 — minimal connection proposal (for review; not implemented)

LOCAL TEST CANDIDATE only ([0x4C; 32] / 0xC804). Nothing new is invented here: the program's existing entry points and checks decide everything. No commercial terms or production authority are decided.

## What the program already has (read at world branch, `permutation-frontier/src/proc/wide.rs`, `wide_conquest_exec.rs`)

- **0xDD WideResidentAct** (`resident_act`): `0xDD ‖ LE32 generation ‖ inner`, then four read-only proof accounts `[policy, link, asset, resident]`.
  - The inner must be a wide **player** command: ClaimSite, Depart, Muster, Dissolve, Economy, Garrison, or **DeclareSiege**.
  - It runs under `Auth::Resident`: the policy, the link, the asset's **current** Core owner (or its session) and the **signed holder generation** against the resident record.
  - So a previous holder, its session, and anything signed before a transfer are refused.
- **DeclareSiege for a resident** (`declare_siege_resident`):
  - `require_conquest_lifecycle()`;
  - exactly **16 accounts**: the canonical 12 DeclareSiege roles (`[actor, payer, season, citizen, source, province, roster, source_province, target, table, escrow, system]`) followed by the 4 proof accounts;
  - the exact signed outer bytes kept.
- **0xE2 ResidentAct** routes only ABI v2 tags, legacy Depart among them. The local NFT-lane worlds already sent "NFT players can march" as Depart inside 0xE2.

## What local play has today

- Territory: the page asks the relay's conquest route to prepare `DA FF 02 0C` (the host-only dispatch wrapper) around `DA FF 01 05 site entry`. It is signed by the wallet for the wallet's Citizen only (`conquest-prepare.mjs`, `flocalplay-conquest.mjs`).
- Movement: the ordinary march (`flocalplay-march.mjs`, legacy Depart 0x50) is closed by default (test-only trial); the sealed march is ExpeditionDepart (op 6, not a 0xDD player command).

## Minimal connection (candidate lane only; the conquest lane byte-identical)

1. **Territory = 0xDD DeclareSiege for the NFT Citizen.**
   - The relay's conquest prepare, on the candidate program with a resident named, emits `0xDD ‖ generation ‖ DA FF 01 05 site entry`. Its accounts are the same canonical 12 roles with `citizen` = the NFT Citizen and `actor`/`payer` = the wallet, plus the 4 proof accounts recomputed (as `flocalresident.mjs` does).
   - The relay's conquest submit accepts exactly that instruction (16 accounts) after the same one-read holder check as the act path: policy, current Core owner = wallet, record generation = signed, Citizen mark = asset.
   - The page's preparation report accepts the 0xDD form only on the candidate.
2. **Movement = legacy Depart inside 0xE2** through the local march route.
   - Only where the march itself is open (today: the test-only trial).
   - It uses the same resident act builder; the relay rebuilds and checks as for Build/Train/Muster.
3. **Evidence kept apart:** each world stage records its own instruction tag (`e2` for orders and movement, `dd` for territory) and the signed generation decoded from the data.

## Open for review (main CC / territory owner)

- The resident DeclareSiege needs the NFT's own host and source holding; the order of steps in a candidate world (Muster as the NFT, then the march, then the siege) depends on the conquest preset's free-city layout.
- Whether the ordinary march may open on a candidate world (it is closed by default outside the trial).
- Hunks to touch: `conquest-prepare.mjs`, `local-play-conquest*.mjs`, `flocalplay-conquest.mjs`, `controller.mjs` (the conquest send only). Hashes are sent before any write.
