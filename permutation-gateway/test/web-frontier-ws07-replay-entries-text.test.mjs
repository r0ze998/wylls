// ⑦ a replay asked for outside a report — a notice's 見る, the tracker's or the inspector's 戦いを再生 (Lane C,
// 2026-11-17): the press says how its read goes on the map's notice stack — being read; gone when the scene plays; "not
// read" with the same request to make again — and never nothing, never "no clash". It is not a record: the notices' list
// and its seen marks are untouched. WRITTEN, NOT RUN. KEY-FREE and import-free beyond node:test / node:assert /
// node:fs: app.mjs and the English dictionary are read as TEXT, not imported.
//   Expected, case by case:
//   N1 pressed with no report open: FS.replayAsk = loading, shown at once; the scene plays (true) → the notice goes
//   N2 the clash cannot be read (false, or a throw) and nothing changed since: FS.replayAsk = failed — "could not be
//      loaded; this does not mean there was no clash; the record is kept" — with a button that makes the same request
//   N3 called off (null: another world or herald, or a report the person opened meanwhile): the notice goes, no word
//   N4 an earlier press that answers after a later one: touches nothing (the later press's notice is its own: `req`)
//   N5 the person puts the notice away while it is read: the press is no longer the last → no scene, no flight
//   N6 a change of world: the notice of the world that was left goes with it; one asked in the new world stays
//   N7 pressed inside a report: the report's own line, no stack notice (as before)
//   N8 the stack: one item between the status and the toasts; no send, FS.notice or lastAct is used; the feed's records
//      are not written
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../../permutation-server/web/${f}`, import.meta.url), 'utf8');
const app = read('frontier/app.mjs'), en = read('lang/en-frontier-play.mjs');
const fnOf = head => { const at = app.indexOf(head); assert.ok(at >= 0, head); return app.slice(at, app.indexOf('\n}\n', at) + 2); };
const order = (body, ...parts) => { let at = -1; for (const p of parts) { const i = body.indexOf(p, at + 1); assert.ok(i > at, `in order: ${p}`); at = i; } };
const code = s => s.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
const ask = fnOf('async function playAsked(p, q, bell) {'), note = fnOf('function replayNotice(a) {');

test('N1 N2 N3 N4 N7 the press\'s own state, from the ask to the answer', () => {
  order(ask, 'const req = ++playAskSeq;', 'const rep = FS.report ?? null, world = reportWorld();', "FS.replayAsk = rep ? null : { p, q, bell, state: 'loading', req, world };", 'renderFeed();',
    'const asked = () => req === playAskSeq && (FS.report ?? null) === rep && reportWorld() === world;', 'try { ok = await playBattle(p, q, bell, { focus: true, asked }); }',
    'if (req !== playAskSeq) return;',
    "if (!rep && FS.replayAsk?.req === req) { FS.replayAsk = ok === false && asked() ? { p, q, bell, state: 'failed', req, world } : null; renderFeed(); }",
    'if (ok === true) { if (rep && FS.report === rep) leaveReport(); return; }');
  assert.equal(code(ask).split('await ').length - 1, 1);
});

test('N2 the notice: not read is not "no clash"; the same request again', () => {
  order(note, 'data-act="battle-play" data-p="${a.p}" data-q="${a.q}" data-bell="${a.bell}"', "a.state === 'failed' ? L`戦いを読み込めませんでした（ターン ${fmtNum(a.bell)}）。戦いがなかったという意味ではありません。記録はそのままです。` : L`戦いを読み込んでいます…`",
    "a.state === 'failed' ? html`<span class=\"toast-acts\">${again}</span>` : ''", 'data-act="replay-dismiss"');
  for (const k of ['戦いを読み込めませんでした（ターン {0}）。戦いがなかったという意味ではありません。記録はそのままです。', '戦いを読み込んでいます…', 'もう一度読み込む']) {
    const line = en.split('\n').find(l => l.startsWith(`  '${k}':`));
    assert.ok(line, k);
    assert.doesNotMatch(line.split("': ")[1], /\b(settle[ds]?|settling|keeper|beacon|seed)\b/i);
  }
});

test('N5 N6 put away, and another world', () => {
  assert.ok(app.includes("'replay-dismiss': () => { if (FS.replayAsk?.state === 'loading') playAskSeq += 1; FS.replayAsk = null; renderFeed(); },"));
  const sync = fnOf('function syncBattleWorld() {');
  // (corrected: only another world's notice goes — web-frontier-ws07-replay-world-text.test.mjs)
  order(sync, 'if (battleWorldNow === world) return world;', 'peopleCache.at = -1;', 'if (FS.replayAsk && FS.replayAsk.world !== world) { FS.replayAsk = null; renderFeed(); }', 'return world;');
});

test('N8 one item on the stack; not a send, not a record', () => {
  const rf = fnOf('function renderFeed() {');
  order(rf, "...(st ? [{ id: 'tx', markup: status.renderStatus(st) }] : []),", "...(FS.replayAsk ? [{ id: 'replay', markup: replayNotice(FS.replayAsk) }] : []),",
    '...feed.stackOrder(stripItem, toasts, { alarmsFirst: phone() })];', 'syncStack(el, items);');
  assert.doesNotMatch(code(ask) + code(note), /FS\.notice|lastAct|notice-retry|FS\.feed\b|feedDismissed|march-send|payAndJoin|faucet|claim/, 'no send status and no notices record is touched');
  assert.ok(app.includes("'battle-play': d => { playAsked(num(d.p), num(d.q), num(d.bell)); },"), 'every entry and the notice\'s own button make the same request');
});
