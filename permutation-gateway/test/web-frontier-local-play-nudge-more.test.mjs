// The OTHER four places that offer the "bring this province up" button (`data-act="nudge"`) beside a province that
// is a turn behind — the hosts screen (screens/host.mjs), the march order card (hud/marchcard.mjs), the waits list
// and the keeps card of the conquest hand (hud/keephand.mjs ×2). (The village panel's own is in
// web-frontier-local-play-nudge.test.mjs.) In LOCAL PLAY the controller refuses that action, so none of them offers
// the button there; the reason / wait text is shown as before. In an ordinary session nothing changes.
// Pure rendering: no key, no process, no network. The fixtures are those of web-frontier-conquest-hand.test.mjs.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { baseProduction } from '../../permutation-server/web/frontier/fland.mjs';
import * as K from '../../permutation-server/web/frontier/hud/keephand.mjs';
import { KEEP_4_M1, STANDINGS_BEFORE, keepAt, recordAt } from '../../permutation-server/web/frontier/hud/handdemo-data.mjs';
import { render as marchCard } from '../../permutation-server/web/frontier/hud/marchcard.mjs';
import { render as hostsScreen } from '../../permutation-server/web/frontier/screens/host.mjs';
import { renderKeep } from '../../permutation-server/web/frontier/screens/conquest.mjs';
import { LOCAL_PLAY_REFUSED } from '../../permutation-server/web/frontier/controller.mjs';

afterEach(() => setLang('ja'));
const HOME = (extra = {}) => ({ p: 2, q: 0, site: 2, gen: 0, tile: 20, faction: 0, state: 2, order: 1, tier: 0, flags: 0, production: baseProduction(0), upkeep: Array(8).fill(0n), stores: [], reserve: Array(8).fill(0), queue: [],
  transit: [{ state: 0 }], explore: { state: 0 }, lastOwnerAction: 1000n, finalTs: 1n, shieldUntil: 0n, ...extra });
const entry = (extra = {}) => ({ id: hostId({ p: 2, q: 0, site: 2, gen: 0, seq: 1 }), unit: 0, state: 1, tile: 20, troops: 500000, staminaValue: 120, staminaBell: 10, readyBell: 10, pendOp: 0, fromBell: 10, ...extra });
const SEASON = { programVersion: 3, layoutVersion: 2, endBell: 96, bellSecs: 600, dormantAfterSecs: 86400, releaseAfterSecs: 172800, minLead: 2, maxLead: 72, conquestParams: { keepBells: 72 },
  minRevealPriorityMilli: 1000, revealCuLimit: 200000, revealLoadedLimit: 64000, marchFee: 0n, sealBond: 0n };
const fs = ({ bell = 10, entries = [entry()], resolvedNext = bell, extra = {} } = {}) => ({ mode: 'play', season: SEASON, citizen: { faction: 0 }, holdings: [HOME()], nowBell: bell, chain: { now: () => 1000 }, land: { stage: 'final' }, inFlight: 0,
  provinces: new Map([['2,0', { province: { p: 2, q: 0, resolvedNext, entries, ticketCohorts: [] } }]]),
  conquest: { status: 'ready', keeps: new Map([['4,-1', keepAt(KEEP_4_M1, bell)]]), history: new Map([['4,-1', recordAt(KEEP_4_M1, bell)]]), standings: STANDINGS_BEFORE, final: null, events: [] }, ...extra });
const hostRow = (s, i = 0) => { const pv = s.provinces.get('2,0').province, e = pv.entries[i]; return { ...e, id: String(e.id), troops: e.troops / 1000, stamina: 120, pending: e.pendOp, inTransit: false, p: 2, q: 0, province: pv, holding: s.holdings[0], holdingIndex: 0, home: true }; };
const route = (hexes, provinces, secs) => ({ hexes, provinces: Array.from({ length: provinces }, (_, i) => i), secs });
const LOCAL = Object.freeze({ address: 'W', programId: 'P', seasonAddress: 'S', cluster: 'localnet' });
// the province is at turn 10 while the world is at turn 12: behind
const LATE = { bell: 12, resolvedNext: 10 };
const BUTTON = / ?<button type="button" class="btn small" data-act="nudge"[^>]*>[^<]*<\/button>/g;
const buttons = markup => (String(markup).match(/data-act="nudge"/g) ?? []).length;
// the markup with every such button taken out, whitespace runs made one space (a button's own leading space or line indentation)
const without = markup => String(markup).replace(BUTTON, '').replace(/\s+/g, ' ');
const flat = markup => String(markup).replace(/\s+/g, ' ');

// each place, as a function of the page's state → its markup
const withCompose = s => { const k = s.conquest.keeps.get('4,-1');
  s.compose = { holding: s.holdings[0], host: { ...entry(), troops: 500, tile: 20, unit: 0 }, origin: { p: 2, q: 0 }, stance: 1, retreat: 'never', ratio: null, tip: '0', quick: [], dest: { p: 4, q: -1, tile: k.tile }, route: { ...route(13, 3, 1800), dirs: [] }, arriveBell: s.nowBell + 2 }; return s; };
const withReach = s => { s.conquest.hostReach = { key: 'k', host: String(entry().id), ok: true, unreachable: [], rows: [{ p: 4, q: -1, tile: 10, holder: 5, troops: 100, route: route(13, 3, 1800) }] }; return s; };
const PLACES = {
  'the hosts screen (screens/host.mjs)': s => hostsScreen(s),
  'the march order card (hud/marchcard.mjs)': s => marchCard(withCompose(s)),
  'the waits list (hud/keephand.mjs renderWaits)': s => K.renderWaits(s),
  'the keep panel\'s waits (screens/conquest.mjs → renderWaits)': s => renderKeep(s, s.conquest.keeps.get('4,-1')),
  // (the card itself, for the viewer's host of that province — as hud/hand.mjs hands it one; `head` is the hand's own frame)
  'the keeps card of the hand (hud/keephand.mjs renderKeepsPop)': s => { withReach(s); return K.renderKeepsPop(s, { host: hostRow(s), name: 'host' }, { head: (title, sub) => `[${String(title)}|${String(sub)}]` }); },
};

test('the premise: local play refuses the nudge action (the button could only be refused there)', () => {
  assert.ok(LOCAL_PLAY_REFUSED.includes('nudge'));
});

for (const [place, render] of Object.entries(PLACES)) {
  test(`${place}, a province a turn behind: an ordinary session is offered the button as before; local play shows the same thing WITHOUT it — and nothing else differs`, () => {
    for (const lang of ['ja', 'en']) {
      setLang(lang);
      const ordinary = String(render(fs(LATE))), local = String(render(fs({ ...LATE, extra: { localPlay: LOCAL } })));
      assert.ok(buttons(ordinary) >= 1, `${lang}: an ordinary session is offered the button`);
      assert.equal(buttons(local), 0, `${lang}: local play is not`);
      assert.equal(flat(local), without(ordinary), `${lang}: only the button is gone — every reason, wait and other control is as it was`);
      // every falsy / absent `localPlay` is an ordinary session
      for (const localPlay of [undefined, null, false, 0, '']) assert.equal(String(render(fs({ ...LATE, extra: { localPlay } }))), ordinary);
    }
  });
  test(`${place}, a province in step: identical in an ordinary session and in local play`, () => {
    const ordinary = String(render(fs())), local = String(render(fs({ extra: { localPlay: LOCAL } })));
    assert.equal(buttons(ordinary), 0); assert.equal(local, ordinary);
  });
}

test('NO PLACE LEFT: every `data-act="nudge"` button in the page\'s sources is one that local play does not offer', () => {
  const root = new URL('../../permutation-server/web/frontier/', import.meta.url), found = [];
  const walk = dir => { for (const e of readdirSync(new URL(dir, root), { withFileTypes: true })) { if (e.isDirectory()) walk(`${dir}${e.name}/`); else if (e.name.endsWith('.mjs')) {
    const lines = readFileSync(new URL(`${dir}${e.name}`, root), 'utf8').split('\n'); lines.forEach((l, i) => { if (l.includes('data-act="nudge"')) found.push([`${dir}${e.name}`, i + 1, l]); }); } } };
  walk('');
  assert.deepEqual(found.map(f => f[0]).sort(), ['hud/keephand.mjs', 'hud/keephand.mjs', 'hud/marchcard.mjs', 'screens/holding.mjs', 'screens/host.mjs']);
  for (const [file, line, text] of found) {
    // the village panel's line takes it through `lag` (blockedLine's `nudge` option); the others name the mode in their own condition
    if (file === 'screens/holding.mjs') assert.match(text, /\$\{lag \? html` <button/, `${file}:${line}`);
    else assert.match(text, /&& !FS\.localPlay \? html`\s?<button type="button" class="btn small" data-act="nudge"/, `${file}:${line}`);
  }
});
