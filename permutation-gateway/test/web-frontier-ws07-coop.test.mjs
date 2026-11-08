// Workstream 07: the way from the S1 village card to workstream 01's cooperation board, through the slot the card has
// (hud/coopentry.mjs), in place of 01's proposal 0003. The board is 01's; this checks only the connection: nothing on a
// server without a board, a board not read said as such, another Season's board not offered, and the page opened
// with this village as the destination. FIXTURE answers only (a fake fetch); no wallet, no key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as CB from '../../permutation-server/web/frontier/hud/coopboard.mjs';
import { renderCoopSlot, openCoop, coopEntry } from '../../permutation-server/web/frontier/hud/coopentry.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const answer = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const FS = (season = 7n) => ({ season: { seasonId: season }, pin: { programId: 'Frnt1111111111111111111111111111111111111111' }, holdings: [{ p: 2, q: -1, site: 3, gen: 4 }], activeHolding: 0 });
// 01's /coop/config as coop/board.mjs config() makes it (092079bf): season {programId, seasonId}, page
const PROGRAM = 'Frnt1111111111111111111111111111111111111111';
const cfg = (seasonId, programId = PROGRAM, page = '/ws01/repo/workstreams/01-national-strategy/coop/') => ({ season: { programId, seasonId }, contexts: [], page, goals: [], judges: [] });
const text = h => String(h).replace(/<[^>]+>/g, ' ');

test('reading the board: absent (404), not read (5xx, network, odd body), read', async () => {
  assert.deepEqual(await CB.probeBoard({ fetch: answer(404, {}) }), { read: 'absent' });
  assert.deepEqual(await CB.probeBoard({ fetch: answer(502, {}) }), { read: 'unread', code: 'HTTP502' });
  assert.deepEqual(await CB.probeBoard({ fetch: async () => { throw new TypeError('down'); } }), { read: 'unread', code: 'network' });
  assert.deepEqual(await CB.probeBoard({ fetch: answer(200, { nope: 1 }) }), { read: 'unread', code: 'BadConfig' });
  assert.deepEqual(await CB.probeBoard({ fetch: answer(200, { season: '7' }) }), { read: 'unread', code: 'BadConfig' }, '01 names its context as {programId, seasonId}');
  assert.equal((await CB.probeBoard({ fetch: answer(200, cfg('7')) })).read, 'ok');
});

test('the slot: nothing without a board; a board not read or of another Season is said, disabled; this village opens it', async () => {
  setLang('en');
  const opened = [];
  const timers = { setTimeout: () => null, clearTimeout: () => {} };
  for (const [fetch, expect] of [[answer(404, {}), 'hidden'], [answer(503, {}), 'unread'], [answer(200, cfg('8')), 'other'], [answer(200, cfg('7', 'Other1111111111111111111111111111111111111')), 'other'], [answer(200, cfg('7')), 'open']]) {
    let changed = 0;
    const off = CB.installCoopBoard({ fetch, timers, changed: () => { changed++; }, open: href => opened.push(href) });
    try {
      await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0));
      assert.equal(changed, 1, 'the card is drawn again once read');
      const h = String(renderCoopSlot(FS()));
      if (expect === 'hidden') { assert.equal(h, '', 'no board on this server: as before'); continue; }
      assert.match(h, /data-act="coop-open"/);
      assert.match(text(h), /Open requests across nations/);
      if (expect === 'unread') { assert.match(h, /disabled/); assert.match(text(h), /could not be loaded \(HTTP503\)/); }
      if (expect === 'other') { assert.match(h, /disabled/); assert.match(text(h), /another world \(season\)/); assert.equal(openCoop(FS(), 'ws01-coop'), false); }
      if (expect === 'open') {
        assert.doesNotMatch(h, /disabled/);
        assert.equal(openCoop(FS(), 'ws01-coop'), true);
        assert.equal(opened.at(-1), `${CB.BOARD_PAGE}?to=${encodeURIComponent('2,-1,3,4')}`, 'this village as the destination (p,q,site,gen)');
        assert.match(text(renderCoopSlot({ ...FS(), holdings: [] })), /Choose a village/);
      }
    } finally { off(); }
  }
  assert.equal(coopEntry(), null, 'removed when stopped');
  setLang('ja');
});

test('the board may name its page on this origin; another origin is not followed', () => {
  const b = page => ({ read: 'ok', config: cfg('7', undefined, page) });
  assert.match(CB.boardHref(FS(), b('/coop-ui/')), /^\/coop-ui\/\?to=/);
  assert.match(CB.boardHref(FS(), b('//evil.example/x')), new RegExp(`^${CB.BOARD_PAGE.replace(/[/.]/g, '\\$&')}`));
  assert.match(CB.boardHref(FS(), b('https://evil.example/x')), new RegExp(`^${CB.BOARD_PAGE.replace(/[/.]/g, '\\$&')}`));
});

// ---------------------------------------------------------------- against workstream 01's REAL board (coop/board.mjs)
import { createBoard, createServer as createBoardServer } from '../../workstreams/01-national-strategy/coop/board.mjs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test("01's real board: its /coop/config is read, its Season compared, and its page opened for this village", async () => {
  const PROG = 'Frnt1111111111111111111111111111111111111111';
  const board = createBoard({ herald: 'http://127.0.0.1:9', programId: PROG, seasonId: 7n, dataDir: await mkdtemp(join(tmpdir(), 'ws07-coop-')) });
  const hs = createBoardServer(board, { herald: 'http://127.0.0.1:9' });
  await new Promise(r => hs.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${hs.address().port}`;
    const b = await CB.probeBoard({ base });
    assert.equal(b.read, 'ok');
    assert.deepEqual(b.config.season, { programId: PROG, seasonId: '7' });
    const fs = { season: { seasonId: 7n }, pin: { programId: PROG }, holdings: [{ p: 2, q: -1, site: 3, gen: 4 }], activeHolding: 0 };
    assert.deepEqual(CB.boardState(fs, b), { available: true });
    assert.equal(CB.boardState({ ...fs, season: { seasonId: 8n } }, b).available, false, 'another Season');
    assert.equal(CB.boardState({ ...fs, pin: { programId: 'Othr1111111111111111111111111111111111111111' } }, b).available, false, 'another program');
    assert.equal(CB.boardHref(fs, b), `${b.config.page}?to=${encodeURIComponent('2,-1,3,4')}`);
    // the page is the board's own: served by it
    const page = await fetch(base + CB.boardHref(fs, b));
    assert.equal(page.status, 200);
  } finally { hs.close(); }
});
