# Lane B — March block reasons on a map tap (2026-11-16)

Branch `claude/lane-b-block-reasons-20261116`, cut from round 49 (`68e8548d`, the last checked canonical commit).
Owned paths: `permutation-gateway/screens/march-block-reasons.screen.mjs` (new) and this note. No page, fixture, test or
dictionary file was changed.

## What was asked

Rounds 35–38 and 49 made a map tap with the March card open say why the selected host cannot set out — once, on its
tag, in sight. They were checked on the keyless fixture for `NotResident` only. This lane checks every other reason.

## The reasons the page can give

From `permutation-server/web/frontier/hud/subject.mjs:50` `marchCheck` (and `fland.mjs` `actionBlocks('Depart')`, which
it calls):

| code | when | tap note (marchCheck → `hud/orderparts.mjs` whyText) | host tag (`map/actions.mjs:163` blockText → `fi18n.mjs` errorText) |
|---|---|---|---|
| NotResident | province behind the turn | errorText (same words) | NotResident (same words) |
| HostBusy | host has a pending order (`pendOp ≠ 0`) | errorText (same words) | HostBusy (same words) |
| Forming | host `state === 2` | 「編成中です。次のターンから動かせます」 | — (no actor: `actions.mjs:111`) |
| HostInTransit | host in a transit record | 「進軍の結果を受け取るまで動かせません」 | 「この軍勢は、進軍の結果を受け取るまで動かせません」 |
| NotFinal | village not final | 「村が確定してからです」 | 「村がまだ確定していません」 |
| Stamina | stamina < 74 | 「体力 10/74 — ターン 106 から」 | Cooldown 「軍勢が休息中か、体力が足りません」 |
| Resting | `nowBell < readyBell` | 「ターン 45 まで休息です」 | Cooldown (as above) |
| MarchSlots | no free transit slot | 「進軍は同時に 4 つまでです」 | TransitState 「進軍の状態が合いません」 |
| NoTicket | host without a village | — | — |
| HostBusy (no host) | `r` null | — | — |

## The test

`march-block-reasons.screen.mjs` — keyless fixture (`startServer({ keyless: true })`, port 0), PC 1440×900, English
(`en-GB`) and Japanese, 16 tests. Modelled on `local-march-maptap.screen.mjs`: select the home village's Spear host,
press March (card open), then, test-only and in the page's memory only, put the host's own records in the state that
gives the reason (its province entry, its province, or its village record; a getter holds it for the tap), check that
`marchCheck` gives that code, tap an in-sight tile, then read every `fillText` on the map's canvases for 450 ms, by
animation frame, with a hit test of each place. Each test asserts:

- the page's march check gives the expected code, and the March card is still open;
- the sentence is in the viewer's language (Japanese has kana/kanji; English has none and no banned word);
- no order drafted; the host stays in hand; the tap's note is the march check's own sentence;
- in every frame that sentence is drawn at exactly one place in sight;
- in no frame does a second refusal sentence (any of the codes above, in either wording) stand in sight beside it;
- no POST (NotResident only: the page's own `/f/nudge` catch-up, as in the model file);
- no page error.

The defect cases stop at their first failing assertion, so for them the later checks (no POST, no page error) are not
reached.

## Results (round 49, `68e8548d`)

Base check: `node --test local-march-maptap.screen.mjs` alone — 5/5 pass (61 s).

New file: `node --test march-block-reasons.screen.mjs` — exit 0; tests 16, **pass 4, fail 0, todo 12** (≈60 s).
`STRICT=1` runs the 12 todo tests as ordinary tests (they fail until the page is fixed). File sha256
`26da756864b8e1af3774bd4575008a39212de47207f358efb4757d88fc8c0d8e`.

| reason | en | ja | verdict |
|---|---|---|---|
| NotResident | pass | pass | **covered** (the round 35–37 baseline, again) |
| HostBusy | pass | pass | **covered** |
| Stamina | todo | todo | **defect D1** — two sentences in sight |
| Resting | todo | todo | **defect D1** |
| MarchSlots | todo | todo | **defect D1** |
| HostInTransit | todo | todo | **defect D1** |
| NotFinal | todo | todo | **defect D1** |
| Forming | todo | todo | **defect D2** — the tap says nothing and drops the host |
| NoTicket | — | — | **not covered** — unreachable for a host in hand (every host row carries its village) |
| HostBusy (no host) | — | — | **not covered** — no host, no tag, no tap |
| local play read-only | — | — | not in this file: covered by round 28 in `local-march-maptap.screen.mjs` (a different path, `localMarchFor`) |

What was seen in the canvas (in-sight texts, one frame):

- Stamina, en: "The host is resting or short of stamina." + "A march needs 74 stamina (it has 10): from turn 106"
- Resting, ja: 「軍勢が休息中か、体力が足りません」 + 「ターン 45 まで休息です」
- MarchSlots, en: "The march is not in the right state." + "At most 4 marches out at once"
- HostInTransit, en: "This host cannot move until its march is resolved." + "It cannot be ordered until its march's result is collected"
- NotFinal, en: "The village is not confirmed yet." + "Once your village is confirmed"
- Forming: after the tap `{note: null, compose: false, hand: null}` — no word, the host is out of the hand.

## Defects and proposed patches (not applied: page files are not this lane's)

### D1 — one block, two sentences in sight

The tapped tile's note says `marchCheck(...).text` (`app.mjs:1163`). The host's tag says `blockText(A.actor)`
(`map/fmap.mjs:3320`), which is `errorText` of the first code `actorsAt` collected (`map/actions.mjs:163`; the generic
`Cooldown` / `TransitState` pushed at `map/actions.mjs:114–115`; the program's order NotFinal → NotResident → HostBusy →
HostInTransit). The round 37 de-duplication (`map/fmap.mjs:3170–3171` hostEcho, `:3343` note skip) only fires when the
two strings are equal, which holds for NotResident and HostBusy only (whyText falls through to errorText). For the other
five both are drawn.

Proposed patch — make the tag say the march check's own sentence, so the existing equality check de-duplicates:

```diff
--- a/permutation-server/web/frontier/map/actions.mjs
+++ b/permutation-server/web/frontier/map/actions.mjs
@@ imports
+import { marchCheck } from '../hud/subject.mjs';
@@ actorsAt, at :123
-      out.push({ id: String(row.id), unit: row.unit, troops: row.troops, stamina: row.stamina, p, q, tile: idx, holding, holdingIndex, row, march: { ok: !mb.length, blocks: mb }, explore });
+      // (the same sentence the tap's refusal says — hud/subject.mjs marchCheck —, so the map says one block once)
+      const why = mb.length ? marchCheck({ nowBell, chain: { now: () => now } }, { ...row, id: String(row.id), holding, province: prov }).text : '';
+      out.push({ id: String(row.id), unit: row.unit, troops: row.troops, stamina: row.stamina, p, q, tile: idx, holding, holdingIndex, row, march: { ok: !mb.length, blocks: mb, why }, explore });
@@ :163
-export const blockText = a => { const c = a?.march?.ok || a?.explore?.ok ? null : a?.march?.blocks?.[0] ?? null; return c ? errorText(c) : ''; };
+export const blockText = a => { const c = a?.march?.ok || a?.explore?.ok ? null : a?.march?.blocks?.[0] ?? null; return c ? (a.march.why || errorText(c)) : ''; };
```

Check before applying: `hud/subject.mjs` imports `fland`, `fmarch`, `orderparts` — not `map/actions.mjs` — so no import
cycle is expected, but confirm with the app's own module graph. `marchCheck` reads only `FS.nowBell` and
`FS.chain.now()` (`hud/subject.mjs:12–13`). The tag becomes the precise sentence (stamina numbers, rest turn) rather than
the generic "resting or short of stamina"; if the owner prefers the opposite (the note says the tag's words), patch
`app.mjs:1163` instead to say `blockText(actor)` when the selected host's tag has one.

### D2 — a forming host: the tap falls through silently

`actorsAt` skips rows with `state !== 1` (`map/actions.mjs:111`), so a forming host is no actor; `mapTap` returns false
at `app.mjs:1156` (`if (!A || !sub.host) return false;`) before the round 35 branch at `:1157–1163`; the tap becomes a
plain tile selection, the host leaves the hand, and nothing is said — the same fall-through round 35 fixed for
NotResident.

Proposed patch — ask the march check before the actor test:

```diff
--- a/permutation-server/web/frontier/app.mjs
+++ b/permutation-server/web/frontier/app.mjs
@@ mapTap, :1156
-  if (!A || !sub.host) return false;
-  const mcNow = hand.marchCheck(FS, sub.host);
+  if (!sub.host) return false;
+  const mcNow = hand.marchCheck(FS, sub.host);
+  // (a forming host is no actor on the map — map/actions.mjs actorsAt —, so the March card's answer comes first)
+  if (!mcNow.ok && hand.popOf(FS, sub) === 'march') { mapNote(hit, () => mcNow.text); return true; }
+  if (!A) return false;
   if (!mcNow.ok) {
```

(The existing branch inside `if (!mcNow.ok)` then only keeps its `return false`.) With no actor there is no host tag, so
the note alone says the reason: once.

After either fix, remove the code from `KNOWN` in the test (or run with `STRICT=1`) and the test must pass.

## How it was run

Scratch worktree of this branch with symlinked installs (no downloads): `permutation-gateway/node_modules` →
`wylls-normal-home-error-20261115/permutation-gateway/node_modules`; `permutation-gateway/screens/node_modules`
(playwright-core, axe-core) → `wylls-nft-candidate-world-20261115/permutation-gateway/screens/node_modules`. Only the
model file and the new file were run; the phone width (390) is deferred by the owner.
