// The first minute and the feedback at the map (UX design sections 7 and 8.2):
// the nation choice as six standing banners (one choice, one confirm, no site
// picker), the wait for the village with the countdown to the next turn and
// the practice battle offered; the status of the action in hand as a chip
// with a ring, a refusal as a toast with "try again"; what happened this
// turn as at most three cards, each with "see".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLang } from '../../permutation-server/web/lang.mjs';
import * as joinScreen from '../../permutation-server/web/frontier/screens/join.mjs';
import * as status from '../../permutation-server/web/frontier/hud/status.mjs';
import * as feed from '../../permutation-server/web/frontier/hud/feed.mjs';
import { drawerOf, joinKind } from '../../permutation-server/web/frontier/hud/drawer.mjs';
import { hudInsets } from '../../permutation-server/web/frontier/hud/insets.mjs';
import { panelMarkup, SENDS } from '../../permutation-server/web/frontier/app.mjs';
import { ACTIONS } from '../../permutation-server/web/frontier/controller.mjs';

const flat = x => [x].flat(Infinity).map(String).join('');
const text = x => flat(x).replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]*>/g, ' ');
const JP = /[぀-ヿ㐀-鿿]/;
const NAMES = /data-name>[^<]*</g;

test('the nation choice: six standing banners with the leader and the creed, one choice, one confirm, no site picker', () => {
  setLang('ja');
  const base = { mode: 'play', land: { stage: 'none' }, citizen: null, overviews: new Map(), season: { joinGate: new Uint8Array(32) }, wallet: { address: 'W' }, joinDraft: {}, playReady: true, tab: 'map' };
  const out = String(joinScreen.render(base));
  assert.match(out, /^<section class="nations" aria-labelledby="join-faction">/);
  const banners = [...out.matchAll(/<button type="button" class="banner-pick bn(\d)" data-act="pick-faction" data-f="(\d)" data-nation="(\d)" aria-pressed="(true|false)">/g)];
  assert.deepEqual(banners.map(m => [m[1], m[2], m[3], m[4]]), [0, 1, 2, 3, 4, 5].map(f => [String(f), String(f), String(f), 'false']), 'six banners, each names its nation for the map');
  assert.equal((out.match(/<svg[^>]*class="leader"/g) ?? []).length, 6, 'the leader\'s portrait on each');
  assert.equal((out.match(/class="bn-creed">教義：/g) ?? []).length, 6, 'the creed in one line');
  assert.match(out, /data-act="join" disabled>/, 'nothing to confirm before a banner is chosen');
  assert.equal((out.match(/data-act="join"/g) ?? []).length, 1, 'one confirm');
  assert.doesNotMatch(out, /data-act="(pick-province|toggle-site|file-ticket)"|<select|type="number"/, 'no site picker (owner decision V2)');
  assert.doesNotMatch(out, /\sstyle=/);
  assert.doesNotMatch(text(out), /M1|区画 ?\d|キーパー|ランポート/);
  // one choice: the banner is pressed, the confirm names the nation and says its creed in a line
  const picked = String(joinScreen.render({ ...base, joinDraft: { faction: 2 } }));
  assert.match(picked, /data-f="2" data-nation="2" aria-pressed="true"/);
  assert.equal((picked.match(/aria-pressed="true"/g) ?? []).length, 1);
  assert.match(picked, /<button type="button" class="btn primary nc-btn" data-act="join" ><svg[^>]*><use href="art\/ui\/icons\.svg#banner"\/><\/svg>シンダーで始める<\/button>/);
  assert.match(picked, /class="nc-pitch">[^<]+</);
  // without a wallet the banners still stand; the confirm offers to connect one
  const noWallet = String(joinScreen.render({ ...base, wallet: null, walletList: [{ name: 'Dev wallet' }], joinDraft: { faction: 2 } }));
  assert.equal((noWallet.match(/class="banner-pick/g) ?? []).length, 6);
  assert.match(noWallet, /data-act="connect" data-i="0"/);
  assert.doesNotMatch(noWallet, /data-act="join"/);
  // a gated season asks for the invite in the confirm line
  assert.match(String(joinScreen.render({ ...base, season: { joinGate: new Uint8Array(32).fill(9) } })), /data-bind="invite"/);
  // the drawer: the banners are a stage of their own, wallet or not
  assert.equal(joinKind(base), 'nation');
  assert.equal(drawerOf({ ...base, wallet: null }).kind, 'nation');
  assert.match(flat(panelMarkup({ ...base, view: { fog: true }, ui: { dismissed: [] } })), /class="nations"/);
  assert.doesNotMatch(flat(panelMarkup({ ...base, view: { fog: true }, ui: { dismissed: [] } })), /class="checklist"/, 'the guide\'s list does not stand under the banners');
  setLang('en');
  const en = String(joinScreen.render({ ...base, joinDraft: { faction: 2 } }));
  assert.doesNotMatch(text(en.replace(NAMES, '<')), JP);
  assert.match(text(en), /Join Cinder/);
  assert.match(text(en), /Choose a nation/);
  setLang('ja');
});

test('the wait for the village: who was joined, the countdown to the next turn, practice offered, the candidates by name', () => {
  setLang('ja');
  const clock = { genesisTs: 1_000, window: () => 60, margin: 6 };
  const base = { mode: 'play', tab: 'map', playReady: true, wallet: { address: 'W' }, session: { publicKey: 'S' }, citizen: { faction: 0 }, clock, chain: { now: () => 1_000 + 42 * 600 + 150 },
    overviews: new Map(), holdings: [], view: { fog: true }, ui: { dismissed: [] } };
  assert.deepEqual(joinScreen.turnLeft(base), { left: 450, share: 0.25 });
  assert.equal(joinScreen.turnLeft({ ...base, chain: { now: () => 5 } }), null, 'before the season runs');
  // joined, no ticket yet: this browser is placing it
  const placing = String(joinScreen.render({ ...base, land: { stage: 'joined' }, autoTicket: { state: 'searching' } }));
  assert.match(placing, /<section class="vcard wait-card" aria-labelledby="join-sites">/);
  assert.match(placing, /アステルに加わりました/);
  assert.match(placing, /<h3 id="join-sites">最初の村を置いています<\/h3>/);
  assert.match(placing, /<strong class="turn-wait-v" data-turn-left>7:30<\/strong>/, 'the time left in this turn');
  assert.match(placing, /data-turn-ring><svg class="ring"[^>]*>[\s\S]*?stroke-dasharray="25\.0 100"/);
  assert.match(placing, /data-act="practice-open"/, 'the practice battle is offered on the same screen');
  assert.doesNotMatch(placing, /data-act="(pick-province|toggle-site|file-ticket)"/);
  // a refusal shows once, on the card, with the retry
  const failed = String(joinScreen.render({ ...base, land: { stage: 'joined' }, autoTicket: { state: 'failed', code: 'Unavailable' } }));
  assert.equal((failed.match(/role="alert"/g) ?? []).length, 1);
  assert.match(failed, /data-act="auto-ticket"/);
  // a ticket: its candidate places by the name a village there would carry, never by a site's number
  const ticket = String(joinScreen.render({ ...base, land: { stage: 'ticket', ticket: { bell: 42, next: 1, sites: [{ p: 2, q: 0, site: 3 }, { p: 2, q: 1, site: 5 }] } } }));
  assert.match(ticket, /<h3 id="join-sites">最初の村を待っています<\/h3>/);
  assert.match(ticket, /<li class="done">ラマール（州 2,0）/);
  assert.match(ticket, /約11〜21分/);
  assert.doesNotMatch(text(ticket), /区画 ?\d|ランポート|キーパー|M1/);
  assert.match(ticket, /data-act="practice-open"/);
  // nothing pretends the village exists: the waiting screens never name a village of the viewer's
  for (const m of [placing, failed, ticket]) assert.doesNotMatch(m, /holding-title|data-act="harvest"|の(集落|町|都市|城塞)/);
  assert.equal(drawerOf({ ...base, land: { stage: 'ticket' } }).kind, 'wait');
  setLang('en');
  const en = text(joinScreen.render({ ...base, land: { stage: 'ticket', ticket: { bell: 42, next: 0, sites: [{ p: 2, q: 0, site: 3 }] } } }));
  assert.doesNotMatch(en.replace(/Ramar|Lamar/g, ''), JP, en);
  assert.match(en, /Until the next turn/);
  assert.match(en, /You joined Aster/);
  setLang('ja');
});

test('the status at the map: a ring while it is tracked, a check when it landed, a refusal with "try again"', () => {
  setLang('ja');
  assert.equal(status.statusOf({}), null);
  const busy = status.statusOf({ notice: { busy: true, text: () => '送信中…' } });
  assert.deepEqual([busy.state, busy.share, busy.text], ['busy', null, '送信中…']);
  assert.match(String(status.renderStatus(busy)), /^<div class="toast tx tx-busy" role="status">\s*<span class="tx-ring"><svg class="ring ring-wait"/);
  // a march being sent: its four steps are the ring's share
  const sending = status.statusOf({ compose: { sending: true, step: 'sent' }, notice: null });
  assert.deepEqual([sending.state, sending.step, sending.steps, sending.share], ['busy', 3, 4, 0.625]);
  assert.match(String(status.renderStatus(sending)), /stroke-dasharray="62\.5 100"[\s\S]*<span class="toast-stamp">3\/4<\/span>/);
  // landed: the check, for a few seconds
  const done = status.statusOf({ notice: { ok: true, text: 'チェーンに記録されました' } }, { age: 0 });
  assert.equal(done.state, 'done');
  assert.match(String(status.renderStatus(done)), /class="toast tx tx-done" role="status"[\s\S]*icons\.svg#check/);
  assert.equal(status.statusOf({ notice: { ok: true } }, { age: status.DONE_MS + 1 }), null, 'it leaves by itself');
  // refused: an alert at the map that stays, names the reason and offers the action again
  const refused = status.statusOf({ notice: { ok: false, code: 'Unavailable' } }, { age: 60_000, canRetry: true });
  assert.deepEqual([refused.state, refused.retry], ['refused', true]);
  const toast = String(status.renderStatus(refused));
  assert.match(toast, /^<div class="toast tx tx-refused" role="alert">/);
  assert.match(toast, /data-act="notice-retry"/);
  assert.match(toast, /data-act="notice-close"/);
  assert.doesNotMatch(String(status.renderStatus(status.statusOf({ notice: { ok: false, code: 'Unavailable' } }))), /notice-retry/, 'nothing to send again: no button');
  assert.equal(String(status.renderStatus(null)), '');
  // the drawer no longer carries the outcome: it is said once, at the map
  assert.doesNotMatch(flat(panelMarkup({ mode: 'play', tab: 'more', land: { stage: 'final' }, notice: { ok: false, code: 'Unavailable' }, view: { fog: true }, ui: { dismissed: ['onboarding'] }, holdings: [], chronicle: [], feed: [] })), /class="notice error" role="alert"/);
  // what can be sent again is a play action that sends
  for (const a of SENDS) assert.equal(typeof ACTIONS[a], 'function', a);
  assert.ok(!SENDS.has('tab') && !SENDS.has('compose'));
  setLang('en');
  const enRefused = status.renderStatus(status.statusOf({ notice: { ok: false, code: 'Unavailable' } }, { canRetry: true }));
  assert.match(text(enRefused), /Try again/);
  assert.doesNotMatch(text(enRefused), JP);
  setLang('ja');
});

test('what happened this turn: at most three cards over the map, each with "see"', () => {
  setLang('ja');
  const now = 10_000;
  const items = [
    { id: 'a', kind: 'battle', bell: 42, at: now, p: 2, q: 0, battle: { p: 2, q: 0, bell: 41 }, text: 'b' },
    { id: 'b', kind: 'march', bell: 42, at: now, p: 3, q: 0, text: 'm' },
    { id: 'c', kind: 'build', bell: 42, at: now, p: 2, q: 0, text: 'c' },
    { id: 'd', kind: 'holding', bell: 42, at: now, p: 2, q: 0, text: 'h' },
    { id: 'e', kind: 'summary', bell: 42, at: now, text: 's' },
  ];
  const live = feed.liveToasts(items, { now });
  assert.equal(live.length, feed.TOAST_MAX);
  assert.equal(feed.TOAST_MAX, 3);
  assert.deepEqual(feed.liveToasts(items, { now, dismissed: new Set(['a']) }).map(x => x.id), ['b', 'c', 'd']);
  const battle = String(feed.renderToast(items[0]));
  assert.match(battle, /data-act="battle-play" data-p="2" data-q="0" data-bell="41">見る</, 'a battle is seen where it happened');
  assert.match(battle, /data-act="report-open" data-p="2" data-q="0" data-bell="41">報告</);
  assert.match(String(feed.renderToast(items[1])), /data-act="feed-go" data-id="b">見る</);
  assert.doesNotMatch(String(feed.renderToast(items[4])), /見る/, 'a summary has no place to go');
  setLang('en');
  assert.match(String(feed.renderToast(items[1])), />See</);
  setLang('ja');
});

test('what the HUD covers: a document over the map is not an edge; the nation choice covers the foot of the map', () => {
  const rect = (x, y, w, h) => ({ left: x, top: y, right: x + w, bottom: y + h, width: w, height: h });
  const page = ({ panel, drawer = 'open', doc = '', dock = rect(480, 826, 480, 62) }) => {
    const els = {
      'frontier-map': { getBoundingClientRect: () => rect(0, 0, 1440, 900) },
      topbar: { getBoundingClientRect: () => rect(0, 0, 1440, 48) },
      panel: { getBoundingClientRect: () => panel, dataset: { drawer, doc }, hidden: false },
    };
    return { getElementById: id => els[id] ?? null, querySelector: () => ({ getBoundingClientRect: () => dock, hidden: false }), defaultView: { getComputedStyle: () => ({ position: 'fixed', display: 'block', visibility: 'visible' }) } };
  };
  assert.deepEqual(hudInsets(page({ panel: rect(1044, 60, 384, 828) })), { top: 48, right: 396, bottom: 74, left: 0 }, 'the side drawer');
  assert.deepEqual(hudInsets(page({ panel: rect(270, 106, 900, 500), doc: 'wide' })), { top: 48, right: 0, bottom: 74, left: 0 }, 'a report or a practice battle');
  assert.deepEqual(hudInsets(page({ panel: rect(12, 440, 1416, 374), doc: 'stage' })), { top: 48, right: 0, bottom: 460, left: 0 }, 'the six banners');
});
