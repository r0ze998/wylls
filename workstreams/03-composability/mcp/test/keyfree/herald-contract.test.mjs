// The key-free harness's herald answers as the real herald does, checked by the real herald client (permutation-server
// web/frontier/herald.mjs, whatever version the tree carries) — so that a stricter client (④ fa822453 requires the me
// record's v, holdings and slots) fails here, by name, and not later as a missing field in another test.
// KEY-FREE, PDA-FREE (fixed constant addresses).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHerald } from '../../../../../permutation-server/web/frontier/herald.mjs';
import { HERALD, OWNER, SEASON_ID, constantAddresses, keyfreeWorld, mcpServer } from './harness.mjs';

// frontier-node/crates/herald/src/views.rs me_json: the fields of /h/me/{wallet}.
const show = x => JSON.stringify(x, (k, v) => (typeof v === 'bigint' ? String(v) : v)).slice(0, 200);
const ME_FIELDS = ['v', 'wallet', 'citizen', 'holdings', 'hosts', 'transits', 'slots', 'seals', 'quota', 'latestSlot'];

test('the harness\'s /h/me record has every field of the real me_json', async () => {
  const w = await keyfreeWorld();
  assert.deepEqual(ME_FIELDS.filter(f => !(f in w.herald.me())), []);
});

test('the real herald client reads the harness\'s records: me (with its checks), and an events page', async () => {
  const w = await keyfreeWorld();
  const h = createHerald({ base: HERALD, fetch: w.fetch });
  h.pin(String(SEASON_ID), constantAddresses('p', String(SEASON_ID)));
  const me = await h.me(OWNER);
  assert.equal(me.ok, true, show(me));
  assert.deepEqual([me.holdings.length, me.slots.length], [1, 0]);
  const ev = await h.events('0');
  assert.equal(ev.ok, true, show(ev));
});

test('a tool error is reported as itself: the harness does not read past it', async () => {
  const w = await keyfreeWorld();
  const s = mcpServer(w);
  const { linkId } = await s.connectViaRelay();
  w.state.down = u => u.pathname.startsWith('/h/me/');
  await assert.rejects(s.plan(linkId), e => /get_village_status: /.test(e.message) && typeof e.code === 'string');
});
