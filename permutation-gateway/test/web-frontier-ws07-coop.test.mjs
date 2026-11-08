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
const FS = (season = 7n) => ({ season: { seasonId: season }, holdings: [{ p: 2, q: -1, site: 3, gen: 4 }], activeHolding: 0 });
const text = h => String(h).replace(/<[^>]+>/g, ' ');

test('reading the board: absent (404), not read (5xx, network, odd body), read', async () => {
  assert.deepEqual(await CB.probeBoard({ fetch: answer(404, {}) }), { read: 'absent' });
  assert.deepEqual(await CB.probeBoard({ fetch: answer(502, {}) }), { read: 'unread', code: 'HTTP502' });
  assert.deepEqual(await CB.probeBoard({ fetch: async () => { throw new TypeError('down'); } }), { read: 'unread', code: 'network' });
  assert.deepEqual(await CB.probeBoard({ fetch: answer(200, { nope: 1 }) }), { read: 'unread', code: 'BadConfig' });
  assert.equal((await CB.probeBoard({ fetch: answer(200, { season: '7' }) })).read, 'ok');
});

test('the slot: nothing without a board; a board not read or of another Season is said, disabled; this village opens it', async () => {
  setLang('en');
  const opened = [];
  const timers = { setTimeout: () => null, clearTimeout: () => {} };
  for (const [fetch, expect] of [[answer(404, {}), 'hidden'], [answer(503, {}), 'unread'], [answer(200, { season: '8' }), 'other'], [answer(200, { season: '7' }), 'open']]) {
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
  const b = page => ({ read: 'ok', config: { season: '7', page } });
  assert.match(CB.boardHref(FS(), b('/coop-ui/')), /^\/coop-ui\/\?to=/);
  assert.match(CB.boardHref(FS(), b('//evil.example/x')), new RegExp(`^${CB.BOARD_PAGE.replace(/[/.]/g, '\\$&')}`));
  assert.match(CB.boardHref(FS(), b('https://evil.example/x')), new RegExp(`^${CB.BOARD_PAGE.replace(/[/.]/g, '\\$&')}`));
});
