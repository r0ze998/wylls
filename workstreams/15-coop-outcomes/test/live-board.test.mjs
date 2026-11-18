// Integration: ①'s board serves ⑮'s titles and chronicle at /coop/outcomes (ruleset B), reading a herald's /h/season
// and /h/events (a stand-in answering from PS2 bodies laid out from the ABI's tables); the game page's reader
// (hud/coopoutcomes.mjs) accepts the answer and draws the titles in Japanese and English. No chain, no key: the board's
// signature check is replaced (no record is submitted here) and it has no RPC.
// Port: 127.0.0.1:41251 (WS15_TEST_PORT overrides).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBoard, createServer } from '../../01-national-strategy/coop/board.mjs';
import { probeOutcomes, render, outcomeRows, NO_EFFECT } from '../../../permutation-server/web/frontier/hud/coopoutcomes.mjs';
import { setLang } from '../../../permutation-server/web/lang.mjs';
import { RULESETS } from '../src/rulesets.mjs';
import { heraldRows, sampleWorld } from './ps2.mjs';

const PORT = Number(process.env.WS15_TEST_PORT ?? 41251);
const PROGRAM = 'Frnt1111111111111111111111111111111111111111';
const GENESIS = 1_800_000_000, BELL = 600;
const text = h => String(h).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

/** A herald stand-in: `/h/season` and `/h/events` paged `per` rows at a time (`full` while more follow). */
function fakeHerald(rows, { per = 3, season = true } = {}) {
  const asked = [];
  const fetchHerald = async p => {
    asked.push(p);
    if (p === '/h/season') return season ? { status: 200, json: { v: 1, programId: PROGRAM, season: '7', genesisTs: GENESIS, bellSecs: BELL } } : { status: 503, json: { code: 'NoSeasonYet' } };
    const m = /^\/h\/events\?after=(\d+)$/.exec(p);
    if (!m) return { status: 404, json: null };
    const after = BigInt(m[1]);
    const page = rows.filter(r => BigInt(r.seq) > after).slice(0, per);
    return { status: 200, json: { v: 1, events: page, next: page.length ? page[page.length - 1].seq : m[1], full: page.length === per } };
  };
  return { fetchHerald, asked };
}

const mk = (rows, opts = {}) => {
  const h = fakeHerald(rows, opts);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws15-live-board-'));
  const board = createBoard({ herald: 'http://127.0.0.1:1', programId: PROGRAM, seasonId: '7', dataDir, fetchHerald: h.fetchHerald, verify: async () => false, now: () => GENESIS + 50 * BELL + 7 });
  return { board, ...h };
};

const servers = [];
after(() => { for (const s of servers) s.close(); });

test('the board judges the herald\'s records with ruleset B and answers titles and chronicle, with no effect', async () => {
  const { board, asked } = mk(heraldRows(sampleWorld()));
  const o = await board.outcomes();
  assert.equal(o.ok, true);
  assert.equal(o.complete, true);
  assert.equal(o.nowBell, 50);
  assert.deepEqual(o.season, { programId: PROGRAM, seasonId: '7' });
  assert.equal(o.ruleset.id, RULESETS.B.id);
  assert.equal(o.ruleset.carryInputs, true);
  assert.deepEqual(o.effects, { ...NO_EFFECT });
  assert.deepEqual(o.entries.map(e => [e.goal, e.subject.id, e.at]), [['P-raider', 'tag:52', 44], ['P-raider', 'tag:21', 14]]);
  // read in pages from the start, and on the next answer only from where it stopped
  const n = sampleWorld().length;   // 11 rows, 3 a page: 0 → 3 → 6 → 9 (the last, not full)
  assert.equal(n, 11);
  assert.deepEqual(asked.filter(p => p.startsWith('/h/events')), ['/h/events?after=0', '/h/events?after=3', '/h/events?after=6', '/h/events?after=9']);
  const again = await board.outcomes();
  assert.equal(again.verdictHash, o.verdictHash);
  assert.deepEqual(asked.filter(p => p.startsWith('/h/events')).slice(4), ['/h/events?after=11']);
});

test('HTTP: GET /coop/outcomes (200), the page\'s reader accepts it and draws the titles in Japanese and English', async () => {
  const { board } = mk(heraldRows(sampleWorld()));
  const srv = createServer(board, { herald: null });
  servers.push(srv);
  await new Promise((ok, no) => { srv.once('error', no); srv.listen(PORT, '127.0.0.1', ok); });
  const base = `http://127.0.0.1:${PORT}`;
  const r = await fetch(`${base}/coop/outcomes`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const b = await probeOutcomes({ base });
  assert.equal(b.read, 'ok');
  const FS = { season: { seasonId: 7n }, pin: { programId: PROGRAM }, citizen: { faction: 5 } };
  setLang('ja');
  const ja = text(render(FS, b));
  assert.match(ja, /称号と記録/);
  assert.match(ja, /の領主が称号「他国の隊商を襲った者」を得た （あなたの国）/, 'nation 5\'s lord (known from its storehouse), the viewer\'s nation');
  assert.match(ja, /所属の分からない領主が称号「他国の隊商を襲った者」を得た/, 'tag 21: its JOIN wallet is not this test\'s Citizen, so its nation is not known');
  assert.match(ja, /理由：ほかの国の隊商から、一つの資源で最小量以上を奪った/);
  assert.match(ja, /ターン 44/);
  assert.match(ja, /勝敗・得点・賞金・シーズンの終わりには何も加えません/);
  assert.deepEqual(outcomeRows(b.outcomes, FS).map(x => x.mine), [true, false], 'the viewer\'s nation (5) is marked');
  setLang('en');
  const en = text(render(FS, b));
  assert.match(en, /Titles and records/);
  assert.match(en, /A lord of .+ earned the title “Raider of foreign caravans” \(your nation\)/);
  assert.match(en, /A lord of an unknown nation earned the title “Raider of foreign caravans”/);
  assert.match(en, /Why: Took at least the minimum of one resource from another nation(&#39;|')s caravans/, 'escaped where drawn');
  assert.match(en, /turn 44/i);
  assert.doesNotMatch(en, /[ぁ-んァ-ヶ一-龯]/, 'no Japanese left in the English card');
  setLang('ja');
  // another world's answer is not shown; a server without the evaluator draws nothing
  assert.equal(render({ ...FS, season: { seasonId: 8n } }, b), '');
  assert.equal(render(FS, { read: 'absent' }), '');
});

test('the page refuses an answer that claims an effect, or a ruleset other than B', async () => {
  const { board } = mk(heraldRows(sampleWorld()));
  const good = await board.outcomes();
  const answer = body => async () => ({ ok: true, status: 200, json: async () => body });
  assert.equal((await probeOutcomes({ fetch: answer(good) })).read, 'ok');
  for (const bad of [{ ...good, effects: { ...good.effects, prize: 'winner' } }, { ...good, effects: { ...good.effects, extra: 'none' } }, { ...good, ruleset: { ...good.ruleset, variant: 'C' } }, { ...good, ruleset: { ...good.ruleset, carryInputs: false } }]) {
    assert.deepEqual(await probeOutcomes({ fetch: answer(bad) }), { read: 'unread', code: 'BadOutcomes' });
  }
  assert.deepEqual(await probeOutcomes({ fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }) }), { read: 'absent' });
});

test('no season on the herald: 503 with a code, never an empty list of titles', async () => {
  const { board } = mk(heraldRows(sampleWorld()), { season: false });
  assert.deepEqual(await board.outcomes(), { ok: false, code: 'NoSeason' });
  const b = await probeOutcomes({ fetch: async () => ({ ok: false, status: 503, json: async () => ({ ok: false, code: 'NoSeason' }) }) });
  assert.deepEqual(b, { read: 'unread', code: 'NoSeason' });
  setLang('ja');
  assert.match(text(render({ season: { seasonId: 7n } }, b)), /読み込めませんでした（NoSeason）。記録が空という意味ではありません/);
});
