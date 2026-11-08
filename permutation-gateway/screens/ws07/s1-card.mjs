// The harness page of ws07-s1-card.screen.mjs: the page's own S1 village card (screens/s1.mjs renderS1Village) in a
// real browser, on S1 data in the shapes the herald serves (h/caravans.json, h/nations.json, h/structures.json) and
// decoded-Holding shapes. The data is made up for the screen, not recorded on a chain. With `?mock=1` the sources of
// workstreams 04, 05 and 01 are registered as MOCKS (their real ones were not received): a cancel waiting on a signed
// request, two costs, the switch back to manual play, and the cooperation entry.
import { setLang, lang } from '../../../permutation-server/web/lang.mjs';
import { setHtml } from '../../../permutation-server/web/util.mjs';
import { renderS1Village } from '../../../permutation-server/web/frontier/screens/s1.mjs';
import { setS1 } from '../../../permutation-server/web/frontier/fs1.mjs';
import { registerStatusSource } from '../../../permutation-server/web/frontier/hud/statussources.mjs';
import { registerCoopEntry } from '../../../permutation-server/web/frontier/hud/coopentry.mjs';

const q = new URLSearchParams(location.search);
setLang(q.get('lang') === 'en' ? 'en' : 'ja');
document.documentElement.lang = lang();
setS1({ layoutVersion: 2, programVersion: 4 });

const ALL = (1n << 61n) - 1n;
const store = units => ({ value: BigInt(units) * 1000n, rate: 0n, cap: 10n ** 12n, t0: 10n ** 12n, frac: 0n });
const tag5 = new Uint8Array([5, 0, 0, 0, 0, 0, 0, 0, ...Array(24).fill(0)]);
const holding = (p, q, site, tile) => ({ p, q, site, tile, gen: 1, state: 2, tier: 1, faction: 1, stores: Array.from({ length: 8 }, (_, i) => store([1200, 800, 300, 40, 0, 500, 60, 0][i])), reserve: [300, 0, 0, 0, 0, 0, 0, 0], queue: [], ownerCitizen: tag5 });
const prov = (p, q) => ({ p, q, layoutVersion: 2, passableMask: ALL, roughMask: 0n, roadMask: 0n, siteCount: 1, sites: [30], siteMirror: [{ state: 1, faction: 1 }], camp: { state: 1, tile: 7 }, keep: { tile: 8, holder: 1 }, resolvedNext: 10, structures: [], forts: [], caravans: [] });
const place = (kind, tile) => ({ kind, p: 0, q: 0, at: 2, gen: 1, tile });
const moving = [
  { ownerTag: '5', seq: 2, faction: 1, src: place(1, 30), dst: place(2, 40), steps: 7, cargo: [400, 0, 0, 0, 0, 0, 0, 0], arriveTs: 0, runs: [{ p: 0, q: 0, firstBell: 290, n: 2 }], raided: false, path: [], provinces: [[0, 0]] },
  { ownerTag: '5', seq: 3, faction: 1, src: place(1, 30), dst: place(2, 40), steps: 9, cargo: [0, 200, 0, 0, 0, 0, 0, 0], arriveTs: 0, runs: [{ p: 0, q: 0, firstBell: 300, n: 6 }], raided: false, path: [], provinces: [[0, 0]] },
];
const stances = Array.from({ length: 6 }, (_, n) => Array.from({ length: 6 }, (_, f) => (n === 1 && f === 3 ? 1 : 0)));
const FS = { mode: 'play', nowBell: 300, chain: { now: () => 1000 }, citizen: { faction: 1, joinBell: 10, vaults: 1, towers: 0, palisades: 0, forts: 0, caravans: 2, voted: [0, 0, 0, 0] },
  holdings: [holding(0, 0, 0, 30)], activeHolding: 0, provinces: new Map([['0,0', { province: prov(0, 0) }]]),
  s1: { caravans: { v: 1, moving, vaults: [{ p: 0, q: 0, tile: 40, ownerTag: '5', faction: 1, gen: 1 }] }, structures: { v: 1, structures: [], sightings: [] }, nations: { v: 1, stances, proposals: [], expelled: [], domesticRaids: [] } } };

if (q.get('mock') === '1') {
  registerStatusSource('caravanCancel', (fs, c) => (c.seq === 3 ? { stage: 'awaitSigned', signedPending: 1 } : null));
  registerStatusSource('villageCosts', () => ({ costs: [{ phase: 'reserved', amounts: [100, 0, 0, 0, 0, 0, 0, 0] }, { phase: 'committed', amounts: [0, 50, 0, 0, 0, 0, 0, 0] }, { phase: 'unsettled' }], committedInHave: true }));
  registerStatusSource('manualPlay', () => ({ signedPending: 2 }));
  let opened = 0;
  registerCoopEntry({ id: 'mock-coop', title: () => (lang() === 'en' ? 'Cooperate with nations (mock)' : '国と協力する（mock）'), state: () => (q.get('coop') === 'open' ? { available: true } : { available: false, why: lang() === 'en' ? 'The table opens at turn 700 (mock)' : '卓が開くのはターン 700 から（mock）' }), open: () => { opened++; document.body.dataset.coopOpened = String(opened); } });
}
const root = document.getElementById('card');
function render() { setHtml(root, renderS1Village(FS)); document.body.dataset.ready = '1'; }
// (as the page's HUD action `coop-open`: hud/coopentry.mjs openCoop)
import('../../../permutation-server/web/frontier/hud/coopentry.mjs').then(({ openCoop }) => {
  document.addEventListener('click', e => { const b = e.target.closest('[data-act="coop-open"]'); if (b && !b.disabled) openCoop(FS, b.dataset.id); });
  render();
});
