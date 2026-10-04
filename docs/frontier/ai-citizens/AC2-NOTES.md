# AC2 notes: personas and memory

Unit AC2 of wave A, branch `frontier/ai-ac2` (cut from `frontier/ai-integ` 73408a5). Contract: AI-CITIZENS-CONTRACT v1.2, §2, §5, §10.2 G15, §11.3 (AC2 row), §11.6. Everything here ran on this Mac against files only: **no stack, no llama-server, no Gemma, no chain, no port was started** (tests bind nothing; one test spawns a child `node` with the permission model). Nothing touches devnet or mainnet. No human played anything the tests read; the real herald data is from M1 rule bots on the owner's local test chain. Pacts and betrayal are not built (App. A.5): no route, store, record type, prompt block or card field names them, and a test greps the library, templates, ledger and card for the words.

## What was built

All new files; no existing file was edited (no hook file, no manifest).

| Path | What |
|---|---|
| `citizens/persona/library.json` | 6 personas (conqueror, guardian, diplomat, avenger, founder, opportunist): base temperaments of §2.2, **6 creed variants each in EN and JA**, 4 goals each (EN and JA), goal keys, the (M) flag. Pact-free; no creed or goal says capture, conquer (the persona name "Conqueror" aside), occupy, annex, promise, pact, alliance, betray, oath. |
| `citizens/persona/decks/deck-{1,2,3}.json` | deck-1 `[conqueror]`, deck-2 `[avenger, diplomat]`, deck-3 `[avenger, diplomat, conqueror]`. No deck-6; the opportunist is in no deck. |
| `citizens/persona/deal.mjs` | `deal(seed32, deck, slots)`, `personaOf`, `makeSlots`, `libraryHash`, vectors producer (`node citizens/persona/deal.mjs --vectors [--write]` -> `test/fixtures/ai-deal-v1.json`). |
| `citizens/persona/goals.mjs` | one pure function per goal (22 of them), `goalProgress`, `allProgress`. Input contract in the file header. |
| `citizens/persona/render.mjs` | `renderPersona(persona, lang)` (name, ambition, creed, temperament words, goals), `temperamentWord`. |
| `citizens/persona/names.mjs` | `nameOf(tag)` (identityOf + displayName with an explicit language; never `withProfile`), `nationName(f)` (from `memory/names.json`), `tagHex`, `tagFromDecimal`. |
| `citizens/memory/names.json` | the 6 nation names (EN, JA), copied from i18n.mjs `CIV_NAMES`; a test compares the two in both languages. |
| `citizens/memory/templates.{en,ja}.json` | the episode texts, goal-independent, filled only with numbers, `nameOf` names, nation names and places. |
| `citizens/memory/episodes.mjs` | **`episodes_from_events(batch, ctx) -> {episodes, deltas, collisions, unknown}`** (pure), `episodeId`, `compareEpisodes`, `observedFrom`. |
| `citizens/memory/herald-view.mjs` | decoders for the herald files (province envelope, ClashInputs, clash report), also accepting the shapes `watcher/feed.mjs` (AC6a) produces. |
| `citizens/memory/retrieve.mjs` | `retrieve(episodes, focus, bellNow, {grievances})`, `scoreOf`, `protectedIds`. |
| `citizens/memory/ledger.mjs` | `Ledger`: create/load/save, `apply(delta)`, `applyModelDeltas`, `decay`, `advanceDay`, `standing`, `nextSeq`, goal ops, grievances. |
| `citizens/memory/store.mjs` | `Episodes` (add/evict/retrieve/canonical/sha256/redact), `createMemoryStore({stateDir, pubDir})` (`ledger`, `episodes`, `ingest`, `ownState`, `save`, `publish`). |
| `citizens/memory/summary.mjs` | summary store (`STATE/summary/<tag>/<bell>.txt`), published label, `memoryHash`. |
| `citizens/memory/render.mjs` | `renderMemory(ownState, focus, budget) -> {block, handles, ids, chandles, tokens, cut}`. |
| `citizens/memory/cards.mjs` | `renderCard(state)`, `rememberedFor(episodes, ids, decisionBell)`, `CARD_LABEL`. |
| `citizens/memory/safe.mjs`, `config.mjs` | the sanitiser stand-in (below) and the constants. |
| tests | `test/citizens-persona.test.mjs`, `citizens-persona-goals`, `citizens-memory-{episodes,captured,ledger,retrieve,render,safety,props,cards,permission}.test.mjs`; fixtures `test/fixtures/ai-deal-v1.json`, `ai-ac2-synth.mjs` (synthetic builders), `ai-ac2-captured/` (real herald files, below). |

## Fixtures: which records the tests used (real or synthetic)

AC6a's captured fixtures **did appear** while I was building (`ai-ac6a` commits 880bc62..a8bf2c1: real events excerpt, province envelopes and clash reports from the paused m1-exit herald). I did **not** copy `ai-herald-*` (the same paths would collide at the merge of AC6a); `test/fixtures/ai-ac2-captured/` holds a **cut-out** of those real files (`extract.mjs` there is the provenance script; it needs the AC6a worktree and is not a test):

- verbatim herald JSON: `events.json` (24 raw `/h/events` rows), `clash-1,-3-43 / 1,4-304 / 1,4-387 / 1,4-388.json`, 12 `province-*.json`;
- derived by AC6a code: `owners.json` (host id -> citizen tag, nation, holdings) and `feed-shapes.json` (what `feed.prepare()` hands over).

`citizens-memory-captured.test.mjs` (10 tests) runs `episodes_from_events` on these two ways, (a) the raw files decoded by `herald-view.mjs`, (b) AC6a's shaped objects, and asserts **identical episodes, deltas and collisions for every AI of the capture**. Real-data results: the defender's village attack at bell 387 (130 troops lost from the consecutive garrison values, grievance, trust -15), the second attack at 388, own wins and losses with real losses, a lone camp clear, the camp race of two nations (a **collision**, not a hostile act), `camp_taken_by`, `threat` from real DEPART rows, `build_done` from a real BUILD row.

**Synthetic** (labelled "synthetic" in every test title; `test/fixtures/ai-ac2-synth.mjs` builds them in the real shapes): the hostile-act corner cases the capture lacks (an own army, the staging collision, no-loss attack, nation-mate rule at distance, `strike` with an own army and a mover, the 14-bell wait, answered grievances), `dm`, `motion`, `council_result` (talk and council records exist only from AC4/AC6, which are not built yet), and the property tests. Real recorded files of M1 era (`test/fixtures/frontier/recorded`) are used in three more tests (`recorded:` titles).

## Interfaces as built (§11.6) and what the callers must pass

- `deal(seed32, deck, slots) -> [{index, faction, persona, creed_variant, temperament}]`; `slots` is the `slots` array of `ai-slots.json` (or the file object); a nation whose AI slots differ in number from the deck is an error.
- `Ledger.load/save/apply/applyModelDeltas/decay/standing` as in the header comments; `advanceDay(day, {temperament, ownNation, nationOf})` does the daily decay (at most 10 missed days) and resets the daily model deltas and counters.
- `Episodes.add/retrieve(focus, bellNow, {grievances}) -> ids`. **The ledger's grievances are a third argument** (the interface names two); `store.ownState`/`renderMemory` pass them. `renderMemory(ownState, focus, budget)`: `ownState = {tag, bell, ledger (snapshot), episodes, summary, persona, progress}`, `budget = {tokens=750, count?, handleOf?}`; it also returns `ids` (what survived the cut), `chandles` (C- and N-handles used by RELATIONS) and `cut`.
- `renderPersona(persona, lang)`, `renderCard(state)`, `nameOf(tag) -> {en, ja}` as pinned.
- **`episodes_from_events(batch, ctx)`**: `batch = {events, talk, council}`; `ctx = {ai:{tag, wallet, faction, home, holdings[{p,q,site}], observed?}, bellNow, owners:{citizenOfHost, holdingsOf, factionOfHost?}, province(p,q,b), clash(p,q,b), clashDetail?(p,q,b), config:{genesis_ts, redactions?, openGrievances?}, names?}`. Events: raw `/h/events` rows **or** AC6a's normalised events; `province`/`clash`: the herald JSON, a decoded account, **or** AC6a's `shapeProvince`/`shapeClash`/`clashDetail` objects. With AC6a: `const c = await feed.prepare(batch.events)` then pass `c.province`, `c.clash`, `c.clashDetail`, `feed.owners`. Tags are 16 lowercase hex digits.
- Read-only web imports, for the AC1/AC5 permission-model list (verified by `citizens-memory-permission.test.mjs`, which loads store, render, cards, episodes, goals, deal and renderPersona with exactly this list and checks that a read outside it throws `ERR_ACCESS_DENIED`): `permutation-gateway/citizens/{memory,persona}`, `permutation-server/web/frontier/{fcodec.mjs, abi.mjs, people/identity.mjs}`, `permutation-server/web/{lang.mjs, lang/, util.mjs}`. The tests additionally import `web/i18n.mjs` (names equality) and `fixtures`.

## Rules I had to decide (the contract is silent or ambiguous); please read

1. **Idempotent producer instead of a cursor protocol.** The function returns every episode derivable from the batch with `created_bell < ctx.bellNow` (use `Infinity` for an audit replay). Calling it again over a larger batch gives a superset with the same ids; stores dedupe by episode id, ledger deltas by delta id (`trust.citizens[tag].episodes`, `trust.applied`, grievance ids). The caller keeps a **lookback window** of rows (a DEPART can precede its REVEAL by up to 72 bells). Live emission bell by bell and one full replay give the same episode list (tested in `citizens-memory-retrieve.test.mjs`).
2. **Bells.** The record's `bell` (the herald row's `bell`, the chain bell that contains its slot) is the "bell of the chain slot"; `created_bell` = max over the rows used, and for a hostile act at least b + 2. Rows with `bell > ref + 14` (12-bell wait + 2 evaluation lag) are ignored, so a late row cannot change a replay. `build_done`: `bell` = `floor((done_at - genesis_ts) / 600)`, `created_bell` = that bell (the episode exists only when the build is done).
3. **A `strike` episode with no CLASH row** is created at S + 14 (not S + 2): the row could still arrive; with a CLASH row at `max(S + 2, row bell)`. The +2 trust toward the citizens who moved the adopted option is applied at S + 2 (the opening), never at the close (it would leak the option).
4. **Losses.** Troops are milli-troops in the clash report and Province entries (1000 per troop); camps are whole troops. Own loss = Sigma(pre - post) of the AI's own engaged armies plus own garrison drop between province file b-1 and b; pre-troops of an arrival come from the ClashInputs record, of a resident from the report's `province_before_b64` (exact) or file b-1. The camp and the villages are garrisons, not report fighters (kernel: camp id `u64::MAX - gen`), so the camp's loss is read from the Province camp record (394 -> 376 in the real clash at (0,2) bell 10, partial damage persists) or is its whole troops when a `CAMP` row with troops 0 shares the CLASH row's `sig`. "Enemy lost" of a camp fight includes other nations' armies that fought there too (camp race), the text says "the camp".
5. **Ownership** of an arrival comes from the public ClashInputs record (`citizen_tag`), of a resident from `owners.citizenOfHost`. A hostile act needs the attacker's army `engaged: true` and the victim's village or resident army on the destination tile **in the province file of the DEPARTURE bell** (§6.4); if the AI is only there at the clash, it is a collision (counted, no episode, no delta).
6. **Nation-mate trust (-5)** also requires the victim's loss > 0 (like `attacked_own`) and a village within 2 provinces of the AI's home; for an army victim the victim's village comes from `owners.holdingsOf`.
7. **`answered`** (grievance answered by the AI's own march) follows §5.1 literally: the AI's own REVEAL destination is on the wrongdoer's village tile or on a tile where the wrongdoer had a resident army at the AI's departure bell, with no `engaged` requirement; the caller (`store.ingest`) passes the open grievances.
8. **`dm`:** fixed 6-bell windows `floor(bell / 6)` per sender; at most 6 per game day (144 bells), in (bell, id) order. `motion` includes the AI's own motions and the option kind from the council record; with no council options the kind word is "target".
9. **Episode id:** `sha256("wylls-ai-episode/v1" ‖ UTF-8 of the 16 hex digits of the tag ‖ kind ‖ u32le bell ‖ u32le created_bell ‖ canonical(sorted src))[0..8]`. `src` entries: `event:<seq>`, `talk:<inner>`, `council:<f>:<period>:<close|open>`, `host:<id>`. **AC8's M11 replay must use `episodeId` from `episodes.mjs`.**
10. **Eviction** is a pure function of the list: drop lowest importance, then oldest (bell), then smallest id. "Never an importance >= 5 episode or a grievance source while a lower one exists" holds by construction (every grievance source is `attacked_own`, importance 8).
11. **Retrieval scores** are compared after rounding to 1e-9, so a last-bit difference between machines cannot reorder a tie.
12. **Sanitiser.** `mind/sanitize.mjs` (AC1b) does not exist yet. `memory/safe.mjs` implements the pinned §4.6 steps for code text and for model-written summaries (same signature `(text, {kind, limit})`); the integrator may swap the import. Because step 1 is NFKC, the fullwidth parentheses and colons in the JA templates become ASCII ones in the stored text (tests expect this).
13. **Sentinel test and the card.** The card publishes the model's `why` by contract (§2.4 `revealed_reasons`). The sentinel test therefore asserts that markers in events, talk text, talk names, profile names and extra record fields appear in **no** episode, card, ledger or prompt block, and that a marker in the model's `why` appears **only** in `card.revealed_reasons[].why`, never in an episode or the MEMORY block.

## Additive deviations from the contract's shapes

- Episodes carry `facts` (the numbers used by the text and by the (M) goal functions: arrival bell of a threat, nation, losses...). Redacted episodes blank it. The (M) goals need structure; parsing text would be fragile.
- Ledger: `decay_day`, `trust.applied` (dedupe ids of nation deltas), grievance `nation` and `answered_bell`, `nations[f].model_today`.
- Card: `memory.summary.label` ({en, ja}: written by the model, not verified, not replayed), `remembered[].age_bells`, relationships also for nations.
- `renderMemory` returns `ids`, `chandles`, `cut`; `retrieve` takes the grievances as a third argument.
- Goal inputs (`facts`) are defined in the header of `goals.mjs`; the mind (AC1a) must fill them. "No obligation yet" scores 100 for the obligation-counting (M) goals; `army_home_every_bell` with 0 elapsed bells scores 100.

## Commands run and results (this Mac, load averages 2.3-2.7 at the time: `uptime` 9:04 and 9:09)

- `cd permutation-gateway && node --test test/citizens-*.test.mjs`: **114 tests, 114 pass, 0 fail** (episodes 28, captured 10, persona 15, goals 9, ledger 15, retrieve 11, render 6, safety 6, props 4, cards 8, permission 2).
- `cd permutation-gateway && nice -n 5 npm test` (`node --test test/*.test.mjs screens/logic.screen.mjs`) after all files were written: **688 tests, 688 pass, 0 fail** (the 114 citizens tests included; 674 existing tests unchanged), about 23 s, `uptime` load averages 2.04 2.45 2.59.
- `node citizens/persona/deal.mjs --vectors --write`: wrote `test/fixtures/ai-deal-v1.json` (9 cases); the freshness test regenerates it in memory and compares.
- Under `node --experimental-permission` with the read list above, the modules load and an outside read is refused (the permission test).
- Not run: `cargo`, `rustfmt`, `clippy` (JS only unit; no Rust file touched), llama-server, Gemma, any stack or script. No process was left running.

## Open points

- **AC1a:** the `facts` for goals; the C-handle map for RELATIONS (pass `budget.handleOf`); the real token counter (`budget.count`); `ledger.advanceDay` call at each game day; `memoryHash` is here (`summary.mjs`).
- **AC6 / AC4:** the talk rows the producer reads are the §8.2 `GET /f/ai/talk` shape (`id, bell, tag, channel, target, kind, ref, inner`; channel as 0/1/3 or "world/nation/direct", `target` = the AI's wallet for a direct message and the faction number for the nation channel); the council files need `faction, period, close_bell, adopted, strike_bell, open{option,p,q,tile}, options[{option,kind}]`. If AC4/AC6 name them differently the adapter is `toRow`/the talk and council reads in `episodes.mjs` (about 40 lines).
- **AC8 (M11):** replay with `bellNow = Infinity` over the whole log (or bell by bell), apply `Episodes` for the 200 cap and eviction, compare `sha256()` with `PUB/memory/<tag>/episodes.json` (`sha256` field); `redactedForm` is the blanked shape.
- **Integrator:** `names.json` must be refreshed if `CIV_NAMES` changes (the test fails then); the persona library, decks and templates are what the commitments hash (`libraryHash()`, `fileSha256`).
- Not exercised on real data: `dm`, `motion`, `council_result`, `strike` (no social or council records exist before AC4/AC6), a CAMP spawned and cleared in the same bell, a village attack with an own army present at the departure bell on real files (the real capture has the village case from the defender's side only).
