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

// (wave 2, UX design 11.9: the banners are cloth — a rim, the cloth, a dyed field for the words — and the confirm line
// carries every nation's leader and creed in full, of which the stylesheet shows the looked-at one.
// The leaders' track, wave 3: the flat portrait in a frame is gone; the nation's leader stands lit before the cloth
// (a canvas the sprite player paints: breathing while the banner is looked at; the chosen one's flourish once), a
// phone's compact banner carries the leader's hexagon icon, and the confirm line carries the leader standing too.)
test('the nation choice: six standing banners of cloth with the leader and the doctrine, one choice, one confirm that says the creed in full, no site picker', () => {
  setLang('ja');
  const base = { mode: 'play', land: { stage: 'none' }, citizen: null, overviews: new Map(), season: { joinGate: new Uint8Array(32) }, wallet: { address: 'W' }, joinDraft: {}, playReady: true, tab: 'map' };
  const out = String(joinScreen.render(base));
  assert.match(out, /^<section class="nations" aria-labelledby="join-faction">/);
  const banners = [...out.matchAll(/<button type="button" class="banner-pick bn(\d)" data-act="pick-faction" data-f="(\d)" data-nation="(\d)" aria-pressed="(true|false)">/g)];
  assert.deepEqual(banners.map(m => [m[1], m[2], m[3], m[4]]), [0, 1, 2, 3, 4, 5].map(f => [String(f), String(f), String(f), 'false']), 'six banners, each names its nation for the map');
  const KEYS = ['aster', 'borealis', 'cinder', 'dunmar', 'ember', 'fjordal'];
  assert.equal((out.match(/<span class="bn-rim"><span class="bn-cloth"><span class="bn-face"><\/span>/g) ?? []).length, 6, 'a rim, the cloth, the lit field the leader stands before');
  // (the figure is the banner's neighbour in the list item, laid over it by the stylesheet: outside the banner's shadow filter)
  const figs = [...out.matchAll(/<\/button><span class="bn-figure"><canvas class="lfig" width="288" height="360" data-leader="([a-z]+)" data-motion="(\w+)" data-when="look" aria-hidden="true" focusable="false"><\/canvas><\/span><\/li>/g)];
  assert.deepEqual(figs.map(m => [m[1], m[2]]), KEYS.map(k => [k, 'idle']), 'each nation\'s leader standing before its cloth (a canvas the sprite player paints): breathing only while the banner is looked at');
  assert.deepEqual([...out.matchAll(/<span class="bn-hex"><svg[^>]*class="leader leader-hex" data-leader="([a-z]+)"/g)].map(m => m[1]), KEYS, 'and the leader\'s icon for a phone\'s compact banner');
  assert.deepEqual([...out.matchAll(/<span class="nc-fig"><canvas class="lfig" width="288" height="360" data-leader="([a-z]+)" data-motion="idle" aria-hidden/g)].map(m => m[1]), KEYS, 'the confirm line carries each leader standing');
  assert.deepEqual([...out.matchAll(/<span class="nc-face"><svg[^>]*class="leader leader-card-art" data-leader="([a-z]+)"/g)].map(m => m[1]), KEYS, 'and each leader\'s face, large (the portrait card), for the wide screen\'s confirm line');
  assert.doesNotMatch(out, /data-once=|data-motion="attack"/, 'no flourish before a choice');
  assert.doesNotMatch(out, /<ellipse cx="80"|class="leader"[ >]/, 'the flat vector portrait is gone');
  assert.equal((out.match(/<span class="bn-field"><strong class="bn-name">[^<]+<\/strong><span class="bn-leader"><span data-name>[^<]+<\/span><\/span><span class="bn-creed">教義：/g) ?? []).length, 6, 'name, leader and doctrine on the dyed field');
  // the confirm line: every nation's leader and creed, whole (no line is cut: the stylesheet shows the looked-at one); nothing is the default before a choice but the hint
  const says = [...out.matchAll(/<div class="nc-item( nc-def)?" data-n="(\d)" (aria-live="polite"|aria-hidden="true")>[\s\S]*?<span class="nc-pitch">([^<]+)<\/span>/g)];
  assert.deepEqual(says.map(m => [m[1] ?? '', m[2], m[3]]), [0, 1, 2, 3, 4, 5].map(f => ['', String(f), 'aria-hidden="true"']));
  for (const m of says) assert.ok(m[4].length > 12 && !/…|\.\.\.$/.test(m[4]), `the creed is whole: ${m[4]}`);
  assert.match(out, /<div class="nc-item nc-def"><span class="nc-hint">/, 'before a choice the line asks for one');
  assert.doesNotMatch(out, /bn-pitch|line-clamp/, 'no creed is squeezed into a banner');
  assert.doesNotMatch(out, /bn-mark/, 'no banner is marked before a choice');
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
  assert.match(picked, /<div class="nc-item nc-def" data-n="2" aria-live="polite">/, 'the chosen nation is the confirm line\'s default');
  assert.equal((picked.match(/class="bn-mark"/g) ?? []).length, 1, 'the chosen banner carries its mark (not colour alone)');
  // the chosen leader's flourish: once, under one name on the banner and in the confirm line (the sprite player plays a name once)
  assert.deepEqual([...picked.matchAll(/data-leader="(\w+)" data-motion="attack" data-once="([\w-]+)"/g)].map(m => [m[1], m[2]]), [['cinder', 'pick-2'], ['cinder', 'pick-2']]);
  assert.equal((picked.match(/data-motion="idle"/g) ?? []).length, 10, 'the other five stand as they did');
  assert.match(picked, /この国の土地には、村を置ける場所があと約 \d+ あります。/);
  assert.doesNotMatch(text(picked), /扇区|区画/, 'plain words on the play screen');
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

// Rewritten in wave 2 (UX design 11.10): the wait showed a countdown to the next turn in every state, the refusal as a
// red box with a small button, and the candidates as a plain list. Now: one state line and one clock — with a request
// in, how long until the village is decided and the turn whose bell decides it; a refusal is one clear state (the
// heading, a warning chip, one button, one line with the one countdown); each candidate row asks the map to go there.
test('the wait for the village: one state line and one clock; a refusal is one clear state with one retry; the candidates fly to their sites; practice offered', () => {
  setLang('ja');
  const clock = { genesisTs: 1_000, window: () => 60, margin: 6 };
  const base = { mode: 'play', tab: 'map', playReady: true, wallet: { address: 'W' }, session: { publicKey: 'S' }, citizen: { faction: 0 }, clock, chain: { now: () => 1_000 + 42 * 600 + 150 },
    overviews: new Map(), holdings: [], view: { fog: true }, ui: { dismissed: [] } };
  assert.deepEqual(joinScreen.turnLeft(base), { left: 450, share: 0.25 });
  assert.equal(joinScreen.turnLeft({ ...base, chain: { now: () => 5 } }), null, 'before the season runs');
  const clocks = m => (m.match(/data-wait-clock/g) ?? []).length;
  // joined, no request yet: this browser is sending it; the one clock is the time left in this turn
  const placing = String(joinScreen.render({ ...base, land: { stage: 'joined' }, autoTicket: { state: 'searching' } }));
  assert.match(placing, /<section class="vcard wait-card" aria-labelledby="join-sites">/);
  assert.match(placing, /アステルに加わりました/);
  assert.match(placing, /<h3 id="join-sites">村の申し込みを出しています<\/h3>/);
  assert.match(placing, /<span class="turn-wait-k">次のターンまで<\/span><strong class="turn-wait-v" data-wait-clock>7:30<\/strong>/, 'the time left in this turn');
  assert.match(placing, /data-wait-ring><svg class="ring"[^>]*>[\s\S]*?stroke-dasharray="25\.0 100"/);
  assert.equal(clocks(placing), 1, 'one clock');
  assert.match(placing, /data-act="practice-open"/, 'the practice battle is offered on the same screen');
  assert.doesNotMatch(placing, /data-act="(pick-province|toggle-site|file-ticket)"/);
  // a refusal: one clear state
  const failed = String(joinScreen.render({ ...base, land: { stage: 'joined' }, autoTicket: { state: 'failed', code: 'Unavailable' } }));
  assert.match(failed, /<section class="vcard wait-card wait-stuck"/);
  // (rewritten with wave 3: the state's title is short enough for one line of a phone's sheet)
  assert.match(failed, /<h3 id="join-sites">村の申し込みが通っていません<\/h3>/);
  assert.equal((failed.match(/role="alert"/g) ?? []).length, 1, 'said once');
  assert.match(failed, /<p class="wait-warn" role="alert"><span class="warn-chip"><svg[^>]*><use href="art\/ui\/icons\.svg#alert"\/><\/svg>受け付けられませんでした<\/span><span class="wait-why">[^<]+<\/span><\/p>/, 'a warning chip with its mark, then why');
  assert.equal((failed.match(/data-act="auto-ticket"/g) ?? []).length, 1, 'one retry button');
  assert.match(failed, /<button type="button" class="btn primary" data-act="auto-ticket"><svg[^>]*><use[^>]*\/><\/svg>いますぐやり直す<\/button>/);
  assert.match(failed, /次のターンに自動でやり直します（あと <span class="wait-left" data-wait-clock>7:30<\/span>）/, 'when it is tried again by itself, with the one countdown');
  assert.equal(clocks(failed), 1);
  assert.doesNotMatch(failed, /class="turn-wait"/, 'no second clock beside it');
  const nofree = String(joinScreen.render({ ...base, land: { stage: 'joined' }, autoTicket: { state: 'nofree' } }));
  assert.match(nofree, /近くに空いた場所がありません/);
  assert.equal((nofree.match(/data-act="auto-ticket"/g) ?? []).length, 1);
  // a request is in: the one clock counts to the bell that decides the village, second for second with the turn dial,
  // and says once that the village is decided a little after that toll. (Rewritten with the fix pass on the second
  // review: it read 「約 9 分（ターン 43 の鐘）」, a figure that counted on to the result, under a dial that said that
  // bell was 7:30 away.)
  const landT = { stage: 'ticket', ticket: { bell: 42, next: 1, sites: [{ p: 2, q: 0, site: 3 }, { p: 2, q: 1, site: 5 }] } };
  const wc = joinScreen.waitClock({ ...base, land: landT });
  // (filed in turn 42 at 2:30; the bell of turn 43 tolls in 450 s, the dial's own 7:30; the result comes 66 s after it)
  assert.deepEqual([wc.kind, wc.left, wc.turn, wc.after, wc.tolled, wc.text], ['result', 450, 43, 1, false, '7:30']);
  assert.equal(wc.left, joinScreen.turnLeft(base).left, 'the dial\'s own seconds');
  assert.ok(wc.share > 0.24 && wc.share < 0.26);
  assert.equal(joinScreen.waitNote(wc), 'ターン 43 の鐘です。鐘のあと約 1 分で決まります。');
  const tolled = joinScreen.waitClock({ ...base, land: landT, chain: { now: () => 1_000 + 43 * 600 + 20 } });
  assert.deepEqual([tolled.text, tolled.tolled, joinScreen.waitNote(tolled)], ['まもなく', true, '鐘が鳴りました。約 1 分で決まります。'], 'after the toll: any moment');
  assert.equal(joinScreen.waitNote(joinScreen.waitClock({ ...base, land: { stage: 'joined' } })), '');
  assert.equal(joinScreen.waitClock({ ...base, land: { stage: 'joined' } }).kind, 'turn');
  const ticket = String(joinScreen.render({ ...base, land: landT }));
  assert.match(ticket, /<h3 id="join-sites">村が決まるのを待っています<\/h3>/);
  assert.match(ticket, /<span class="turn-wait-k">村が決まる鐘まで<\/span><strong class="turn-wait-v" data-wait-clock>7:30<\/strong><span class="turn-wait-n" data-wait-note>ターン 43 の鐘です。鐘のあと約 1 分で決まります。<\/span>/);
  assert.equal(clocks(ticket), 1);
  // its candidate places by the name a village there would carry, numbered, each a press that asks the map to go there
  // (hud-4, UX design 11.13: the name alone; a row that flies to its site needs no coordinates)
  const rows = [...ticket.matchAll(/<li (class="done")?><button type="button" class="doc-row site-row" data-act="site-go" data-i="(\d)" data-p="(\d)" data-q="(\d)" data-site="(\d)" aria-label="[^"]+を地図で見る"><span class="site-n" aria-hidden="true">(\d)<\/span><span class="doc-row-t">([^<]+)/g)];
  assert.deepEqual(rows.map(m => [m[1] ?? '', m[2], m[3], m[4], m[5], m[6], m[7].trim()]), [['class="done"', '0', '2', '0', '3', '1', 'ラマール'], ['', '1', '2', '1', '5', '2', rows[1]?.[7].trim()]]);
  assert.doesNotMatch(text(ticket), /州 -?\d/, 'no coordinates in the wait view');
  assert.match(ticket, /（ふさがっていた）/);
  assert.doesNotMatch(text(ticket) + text(placing) + text(failed), /区画 ?\d|ランポート|キーパー|M1|入植希望|乱数|第\d+鐘/, 'plain words: no machinery, no bell numbers');
  assert.match(ticket, /data-act="practice-open"/);
  // nothing pretends the village exists: the waiting screens never name a village of the viewer's
  for (const m of [placing, failed, ticket]) assert.doesNotMatch(m, /holding-title|data-act="harvest"|の(集落|町|都市|城塞)/);
  assert.equal(drawerOf({ ...base, land: { stage: 'ticket' } }).kind, 'wait');
  // while the title scene stands nothing of this opens behind it
  assert.equal(drawerOf({ ...base, land: { stage: 'ticket' }, titleUp: true }), null);
  assert.equal(drawerOf({ ...base, land: { stage: 'none' }, citizen: null, titleUp: true }), null);
  setLang('en');
  const en = text(joinScreen.render({ ...base, land: { stage: 'ticket', ticket: { bell: 42, next: 0, sites: [{ p: 2, q: 0, site: 3 }] } } }));
  assert.doesNotMatch(en.replace(/Ramar|Lamar/g, ''), JP, en);
  assert.match(en, /Until the deciding bell\s+7:30\s+That is turn 43&#39;s bell\. Your village is decided about 1 min after it\./);
  assert.match(en, /You joined Aster/);
  const enFailed = text(joinScreen.render({ ...base, land: { stage: 'joined' }, autoTicket: { state: 'failed', code: 'Unavailable' } }));
  assert.doesNotMatch(enFailed, JP, enFailed);
  assert.match(enFailed, /Your village request has not gone through /);
  assert.match(enFailed, /Try again now/);
  assert.match(enFailed, /It will be retried automatically next turn \(in\s+7:30\s*\)/);
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
  // (hud-4: the button that goes to a place reads "View": "See" alone was not English a player would press)
  assert.match(String(feed.renderToast(items[1])), />View</);
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
