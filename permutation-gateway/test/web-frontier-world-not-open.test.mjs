// (page-not-open-yet) Before the world is created the herald answers /h/season with 503 {"ok":false,"code":"NoSeasonYet"}.
// The page said 「世界の記録を読めません（HTTP503）」 on its red line and "check your connection" on the plate. Now: a calm
// "the world is not open yet", with when it opens when the operator's file beside the page says so (else "soon"), and
// the real failures keep their words. KEY-FREE: no wallet, no signing; fetch is a function of this file.
//   H1 herald.season(): 503 NoSeasonYet comes back by its name; a 503 without that body, another code, another status,
//      and a failed connection are as before (HTTP503, HTTP500, NotFound, network)
//   W1 isNotOpen: only `{ok: false, code: 'NoSeasonYet'}`
//   W2 the operator's file: {v:1, opensAt: unix seconds}; anything else, a missing file or a failed read is "no time"
//   T1 the words, JA and EN: not open yet + the time (the reader's zone, named) or "soon" (no time, or a time past);
//      never "season"/「シーズン」, never the connection, never an HTTP status
//   T2 the banner view is the calm one (no re-read key); the code has its sentence (fi18n CLIENT_TEXT) in both languages
//   S1 the source: loadSeason answers "not open" before the season error, clears a standing season error, and only
//      while no world was read; the poll does not back off; the banner is the calm line; the status word; the plate
//      and the watcher's rail say it (hud.mjs, read as text)
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHerald } from '../../permutation-server/web/frontier/herald.mjs';
import { isNotOpen, parseWorldOpen, readWorldOpen, worldOpenUrl, notOpenText, notOpenBannerView, openTimeText, NOT_OPEN_CODE } from '../../permutation-server/web/frontier/world-not-open.mjs';
import { clientText } from '../../permutation-server/web/frontier/fi18n.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

afterEach(() => setLang('ja'));

const answer = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => { if (body === undefined) throw new Error('no json'); return body; } });
const heraldOf = f => createHerald({ base: 'http://h.test', fetch: f });
const OPENS = 1795662000;   // 2026-11-26 12:00:00 JST
const BEFORE = OPENS - 3600, AFTER = OPENS + 60;

test('H1 herald.season(): NoSeasonYet by its name; every other failure as before', async () => {
  const asked = [];
  const r = await heraldOf(async u => { asked.push(u); return answer(503, { ok: false, code: 'NoSeasonYet' }); }).season();
  assert.deepEqual(asked, ['http://h.test/h/season']);
  assert.deepEqual({ ok: r.ok, code: r.code, httpStatus: r.httpStatus }, { ok: false, code: 'NoSeasonYet', httpStatus: 503 });
  for (const [status, body, code] of [
    [503, undefined, 'HTTP503'],                                   // a proxy's own 503 (no JSON)
    [503, { ok: false, code: 'Unavailable' }, 'HTTP503'],          // another name is not taken
    [503, { code: 7 }, 'HTTP503'], [503, null, 'HTTP503'],
    [500, { ok: false, code: 'NoSeasonYet' }, 'NoSeasonYet'],      // the name is the herald's, whatever the status
    [500, undefined, 'HTTP500'], [502, 'Bad gateway', 'HTTP502'], [404, { ok: false, code: 'NotFound' }, 'NotFound'], [425, undefined, 'TooEarly'],
  ]) {
    const x = await heraldOf(async () => answer(status, body)).season();
    assert.equal(x.ok, false); assert.equal(x.code, code, `${status} ${JSON.stringify(body)}`);
  }
  // (an answer with no body reader at all — a stand-in of another test — fails by its status, never throws)
  assert.equal((await heraldOf(async () => ({ ok: false, status: 503 })).season()).code, 'HTTP503');
  const net = await heraldOf(async () => { throw new TypeError('fetch failed'); }).season();
  assert.deepEqual({ ok: net.ok, code: net.code }, { ok: false, code: 'network' });
  // a read that is not the season's does not take the name (only season() asked for it)
  const st = await heraldOf(async () => answer(503, { ok: false, code: 'NoSeasonYet' })).province(0, 0);
  assert.equal(st.code, 'HTTP503'); assert.equal(st.refusal, 'NoSeasonYet');
});

test('W1 isNotOpen: only the herald\'s "no world yet"', () => {
  assert.equal(NOT_OPEN_CODE, 'NoSeasonYet');
  assert.equal(isNotOpen({ ok: false, code: 'NoSeasonYet' }), true);
  for (const r of [null, undefined, {}, { ok: true, code: 'NoSeasonYet' }, { ok: false, code: 'HTTP503' }, { ok: false, code: 'network' }, { ok: false, code: 'Unavailable' }]) assert.equal(isNotOpen(r), false);
});

test('W2 the operator\'s file beside the page', async () => {
  assert.deepEqual(parseWorldOpen({ v: 1, opensAt: OPENS }), { opensAt: OPENS });
  for (const j of [null, 7, 'x', [], {}, { opensAt: OPENS }, { v: 2, opensAt: OPENS }, { v: 1 }, { v: 1, opensAt: String(OPENS) }, { v: 1, opensAt: OPENS * 1000 }, { v: 1, opensAt: 0 }, { v: 1, opensAt: -5 }, { v: 1, opensAt: 1.5 }, { v: 1, opensAt: NaN }]) {
    assert.deepEqual(parseWorldOpen(j), { opensAt: null }, JSON.stringify(j));
  }
  assert.equal(worldOpenUrl('http://h.test/frontier/frontier/world-not-open.mjs'), 'http://h.test/frontier/frontier/world-open.json');
  const asked = [];
  assert.deepEqual(await readWorldOpen(async (u, o) => { asked.push([u, o.cache]); return answer(200, { v: 1, opensAt: OPENS }); }, 'http://h.test/x/world-open.json'), { opensAt: OPENS });
  assert.deepEqual(asked, [['http://h.test/x/world-open.json', 'no-store']]);
  assert.deepEqual(await readWorldOpen(async () => answer(404, { ok: false, code: 'NotFound' }), 'u'), { opensAt: null });
  assert.deepEqual(await readWorldOpen(async () => answer(200, undefined), 'u'), { opensAt: null });
  assert.deepEqual(await readWorldOpen(async () => { throw new TypeError('fetch failed'); }, 'u'), { opensAt: null });
});

test('T1 the words, JA and EN: not open yet, with the time or "soon"', () => {
  const never = /season|シーズン|connection|通信|HTTP|503|error|エラー|読めません/i;
  setLang('en');
  const when = openTimeText(OPENS);
  assert.match(when, /Nov 2[56]/); assert.match(when, /\d{1,2}:00/); assert.match(when, /[A-Z]{2,}/, 'the time zone is named');
  assert.deepEqual(notOpenText({ opensAt: OPENS }, BEFORE), { title: 'The world is not open yet', sub: `It opens on or after ${when}. This page shows it automatically once it opens.` });
  const soon = { title: 'The world is not open yet', sub: 'It opens soon. This page shows it automatically once it opens.' };
  assert.deepEqual(notOpenText({ opensAt: null }, BEFORE), soon);
  assert.deepEqual(notOpenText({ opensAt: OPENS }, AFTER), soon, 'a time already past is not named again');
  assert.deepEqual(notOpenText(null, BEFORE), soon);
  assert.equal(notOpenBannerView({ opensAt: OPENS }, BEFORE).text, `The world is not open yet. It opens on or after ${when}. This page shows it automatically once it opens.`);
  for (const t of [notOpenBannerView({ opensAt: OPENS }, BEFORE).text, notOpenBannerView(null, BEFORE).text]) assert.doesNotMatch(t, never);
  setLang('ja');
  const ja = openTimeText(OPENS);
  assert.match(ja, /11月2[56]日/);
  assert.deepEqual(notOpenText({ opensAt: OPENS }, BEFORE), { title: '世界はまだ開いていません', sub: `${ja} 以降に開きます。開いたら、このページに自動で表示されます。` });
  assert.deepEqual(notOpenText({ opensAt: null }, BEFORE), { title: '世界はまだ開いていません', sub: 'まもなく開きます。開いたら、このページに自動で表示されます。' });
  assert.equal(notOpenBannerView(null, BEFORE).text, '世界はまだ開いていません。まもなく開きます。開いたら、このページに自動で表示されます。');
  for (const t of [notOpenBannerView({ opensAt: OPENS }, BEFORE).text, notOpenBannerView(null, BEFORE).text]) assert.doesNotMatch(t, never);
});

test('T2 the banner is the calm one; the code has its sentence', () => {
  const v = notOpenBannerView({ opensAt: null }, BEFORE);
  assert.deepEqual({ hidden: v.hidden, reread: v.reread, notOpen: v.notOpen }, { hidden: false, reread: false, notOpen: true });
  assert.equal(clientText('NoSeasonYet'), '世界はまだ開いていません');
  setLang('en');
  assert.equal(clientText('NoSeasonYet'), 'The world is not open yet');
});

test('S1 the source: where the page says it', () => {
  const read = f => readFileSync(new URL(`../../permutation-server/web/frontier/${f}`, import.meta.url), 'utf8');
  const app = read('app.mjs'), hud = read('hud/hud.mjs'), herald = read('herald.mjs');
  const fnOf = (src, head) => { const at = src.indexOf(head); assert.ok(at >= 0, head); return src.slice(at, src.indexOf('\n}\n', at) + 2); };
  const order = (body, ...parts) => { let at = -1; for (const p of parts) { const i = body.indexOf(p, at + 1); assert.ok(i > at, `in order: ${p}`); at = i; } };
  const ls = fnOf(app, 'async function loadSeason(herald) {');
  // "not open" is answered after the stale check and the ended world, before the season error; a later answer of any
  // other kind (a record, or a real failure) ends it
  order(ls, 'const r = await herald.season();', 'if (seasonStale(seq)) return true;',
    "if (isNotOpen(r) && !FS.season && !FS.worldEnded) { seasonRecovered(); noteNotOpen(); invalidate('status', 'chip', 'rail', 'panel'); return false; }",
    "if (FS.notOpen) { FS.notOpen = null; invalidate('status', 'chip', 'rail', 'panel'); }",
    // (verify-pr226) "no world yet" under a world this page shows (a restarted herald) is a failure by its status on
    // the red line — never the words "not open yet" beside a running world
    "if (isNotOpen(r) && !FS.worldEnded) { const code = `HTTP${r.httpStatus || 503}`; clearInspection(FS); clearOutbound(FS); seasonError({ code, text: clientText(code) }); invalidate('status'); return false; }",
    'if (!r.ok && FS.worldEnded) {',
    'if (!r.ok) { clearInspection(FS); clearOutbound(FS); seasonError({ code: r.code, text: clientText(r.code) });');
  // the poll: an answer, not a failure — no back-off
  order(app, 'errors = ok ? 0 : errors + 1;', 'if (FS.notOpen) errors = 0;', 'if (ok) startWithSeason();');
  // the calm line, never the red one; not beside an ended world's or a lost launcher's banner
  assert.ok(app.includes('if (FS.notOpen && !FS.season && !FS.worldEnded && !FS.launcherLost) Object.assign(v, notOpenBannerView(FS.notOpen));'));
  assert.ok(app.includes("setText('season-status', !s && FS.notOpen ? L`まだ開いていません` : status);"));
  // the operator's file: at the first answer and every tenth
  const note = fnOf(app, 'function noteNotOpen() {');
  order(note, 'if (!FS.notOpen) FS.notOpen = { opensAt: worldOpensAt };', 'if (notOpenAsked++ % 10 !== 0) return;', 'readWorldOpen().then(w => { worldOpensAt = w.opensAt;');
  // the plate (before "reading…" and "could not load") and the watcher's rail
  const plate = fnOf(hud, 'export function renderPlate(FS) {');
  order(plate, 'if (FS.notOpen && !FS.season) {', 'plate-notopen', 'const known = viewerState(FS);', "if (known === 'unreachable') {");
  assert.ok(hud.includes('const notOpen = unread && FS.notOpen ? notOpenText(FS.notOpen) : null;'));
  order(herald, 'async season() {', 'const r = await get(f, `${root}/h/season`);', "if (!r.ok && r.refusal === 'NoSeasonYet') return { ...r, code: 'NoSeasonYet' };", 'if (!r.ok) return r;');
});
