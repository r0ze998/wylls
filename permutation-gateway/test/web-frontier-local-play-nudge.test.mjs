// The village panel's blocked lines (screens/holding.mjs `blockedLine`) and the "catch up" button (追いつかせる,
// `data-act="nudge"`) offered beside a `NotResident` reason — the province is a turn behind.
// In LOCAL PLAY the controller refuses that action (the keeper is not asked for anything there), so the panel does
// not offer the button; the reason itself is shown as before. Everywhere else nothing changes.
// Pure rendering: no key, no process, no network.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render as holdingScreen, blockedLine, holdingModel } from '../../permutation-server/web/frontier/screens/holding.mjs';
import { LOCAL_PLAY_REFUSED } from '../../permutation-server/web/frontier/controller.mjs';
import { baseProduction } from '../../permutation-server/web/frontier/fland.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

afterEach(() => setLang('ja'));
const stores = (values = [300, 300, 200, 100, 0, 100, 0, 0]) => values.map((n, i) => ({ value: BigInt(n * 1000), rate: baseProduction(0)[i], cap: 2000000n, t0: 1000n, frac: 0n }));
const h = (extra = {}) => ({ p: 2, q: 0, site: 2, gen: 0, tile: 20, faction: 0, state: 2, tier: 0, flags: 0, production: baseProduction(0), upkeep: Array(8).fill(0n), stores: stores(), reserve: [0, 0, 0, 0, 0, 0, 100, 0], queue: [], transit: [], explore: { state: 0 }, lastOwnerAction: 1000n, finalTs: 1n, shieldUntil: 0n, ...extra });
// `resolvedNext` 10 at bell 10: in step. `resolvedNext` 7 at bell 10: a turn (and more) behind → NotResident.
const fs = ({ resolvedNext = 10, ...extra } = {}) => ({ mode: 'play', season: { programVersion: 3, endBell: 2016, bellSecs: 600, dormantAfterSecs: 86400, releaseAfterSecs: 172800 }, citizen: { faction: 0 }, holdings: [h()], nowBell: 10,
  chain: { now: () => 1000 }, land: { stage: 'final' }, provinces: new Map([['2,0', { province: { p: 2, q: 0, resolvedNext, entries: [], ticketCohorts: [] } }]]), ...extra });
const LOCAL = Object.freeze({ address: 'W', programId: 'P', seasonAddress: 'S', cluster: 'localnet' });
const buttons = markup => (String(markup).match(/data-act="nudge"/g) ?? []).length;
const blockedLines = markup => String(markup).match(/<p class="blocked">.*?<\/p>/gs) ?? [];

test('the premise: the controller refuses the nudge action in local play — the button could only be refused there', () => {
  assert.ok(LOCAL_PLAY_REFUSED.includes('nudge'));
});

test('`blockedLine`: by default exactly as it always was (the button beside NotResident, and only there); with `nudge: false` the same reasons without the button', () => {
  assert.equal(blockedLine([]), ''); assert.equal(blockedLine([], { nudge: false }), '');
  const lag = String(blockedLine(['NotResident'])), other = String(blockedLine(['NotFinal']));
  assert.equal(buttons(lag), 1); assert.match(lag, /追いつかせる/); assert.equal(buttons(other), 0);
  // every way of not asking for the change is the old behaviour
  for (const o of [undefined, {}, { nudge: true }, { nudge: undefined }]) assert.equal(String(blockedLine(['NotResident'], o)), lag);
  assert.equal(String(blockedLine(['NotFinal', 'NotResident'])), String(blockedLine(['NotFinal', 'NotResident'], { nudge: true })));
  // `nudge: false`: the reasons are the same text, the button and its word are gone, nothing else
  const quiet = String(blockedLine(['NotResident'], { nudge: false }));
  assert.equal(buttons(quiet), 0); assert.doesNotMatch(quiet, /追いつかせる|<button/);
  assert.equal(quiet, lag.replace(/ <button[^>]*data-act="nudge"[^>]*>.*?<\/button>/, ''), 'only the button was removed');
  assert.equal(String(blockedLine(['NotFinal'], { nudge: false })), other, 'a line that never had the button is unchanged');
  assert.equal(String(blockedLine(['NotFinal', 'NotResident'], { nudge: false })), String(blockedLine(['NotFinal', 'NotResident'])).replace(/ <button[^>]*data-act="nudge"[^>]*>.*?<\/button>/, ''));
});

test('THE VILLAGE PANEL, a province a turn behind: an ordinary session still offers the button on each blocked line; local play shows the same lines with the same reasons and NO button', () => {
  const behind = { resolvedNext: 7 };
  // the model is the same in both: the blocks are the program's conditions, not the page's mode
  assert.deepEqual(holdingModel(fs(behind)).blocks, holdingModel(fs({ ...behind, localPlay: LOCAL })).blocks);
  assert.ok(holdingModel(fs(behind)).blocks.Muster.includes('NotResident')); assert.ok(holdingModel(fs(behind)).blocks.Garrison.includes('NotResident'));
  assert.deepEqual(holdingModel(fs(behind)).blocks.Train, [], 'Train is not a resident action: not blocked by the lag');
  const ordinary = String(holdingScreen(fs(behind))), local = String(holdingScreen(fs({ ...behind, localPlay: LOCAL })));
  const n = buttons(ordinary);
  assert.ok(n >= 1, 'an ordinary session is offered the button'); assert.equal(buttons(local), 0, 'local play is not');
  // the blocked lines: the same number, and each is the ordinary one minus its button — the reason text is untouched
  const a = blockedLines(ordinary), b = blockedLines(local);
  assert.ok(a.length >= 1); assert.equal(b.length, a.length);
  assert.deepEqual(b, a.map(x => x.replace(/ <button[^>]*data-act="nudge"[^>]*>.*?<\/button>/, '')));
  assert.equal(a.filter(x => /data-act="nudge"/.test(x)).length, n, 'every button of the panel stands in a blocked line');
  // and the WHOLE panel differs in nothing but those buttons
  assert.equal(local, ordinary.replace(/ <button[^>]*data-act="nudge"[^>]*>.*?<\/button>/g, ''));
  // the blocked actions stay disabled in both (hiding the button unlocks nothing)
  for (const markup of [ordinary, local]) assert.match(markup, /<form class="vform" id="hp-muster"[\s\S]*?<button type="submit" class="btn primary" disabled>/);
});

test('NOT behind: the panel is identical in an ordinary session and in local play (the change touches nothing else); other falsy / absent `localPlay` values are an ordinary session', () => {
  const ordinary = String(holdingScreen(fs()));
  assert.equal(buttons(ordinary), 0);
  assert.equal(String(holdingScreen(fs({ localPlay: LOCAL }))), ordinary);
  const behind = String(holdingScreen(fs({ resolvedNext: 7 })));
  for (const localPlay of [undefined, null, false, 0, '']) assert.equal(String(holdingScreen(fs({ resolvedNext: 7, localPlay }))), behind);
});

test('in English too: the local-play panel has no "catch up" button and keeps its reasons', () => {
  setLang('en');
  const ordinary = String(holdingScreen(fs({ resolvedNext: 7 }))), local = String(holdingScreen(fs({ resolvedNext: 7, localPlay: LOCAL })));
  assert.ok(buttons(ordinary) >= 1); assert.equal(buttons(local), 0);
  assert.equal(local, ordinary.replace(/ <button[^>]*data-act="nudge"[^>]*>.*?<\/button>/g, ''));
});
