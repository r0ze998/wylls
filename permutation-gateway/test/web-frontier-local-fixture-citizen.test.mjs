// The local-play fixture's SYNTHETIC Citizen (frontier-node/crates/itest/src/
// expedition_play.rs, Fixture::new) must read, through the browser's own
// decoder and land gate, as the resident poststate of the real Join +
// PlaceHome (proc/citizen.rs): a FINAL first holding, no open ticket.
// The bytes are laid out here by the v2 Citizen offsets (frontier-abi
// v2/layout/player.rs) mirroring what the Rust fixture writes; the Rust
// fixture's own assertions live in its unit test (NOT YET RUN: no build).
// No UI gate is bypassed: the gate is fed the bytes, not a stage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decode } from '../../permutation-server/web/frontier/fcodec.mjs';
import { LAYOUTS as V2 } from '../../permutation-server/web/sdk/frontier/abi-v2-layouts.mjs';
import { landState, CITIZEN, NO_TICKET } from '../../permutation-server/web/frontier/fland.mjs';
import { citizenBindings, EMPTY_GEN } from '../../permutation-server/web/frontier/fwide.mjs';

const L = V2.accounts.find(x => x.kind === 'Citizen');
const at = name => { const f = L.fields.find(x => x.name === name); assert.ok(f, name); return f.off; };
const HOME_GRANTED = 32;
// the JS layout's offsets are frontier-abi v2/layout/player.rs's
test('the v2 Citizen offsets are the Rust layout\'s', () => {
  assert.deepEqual([at('FACTION'), at('FLAGS'), at('HOLDINGS_N'), at('BUCKET_MILLI'), at('HOLDING'), at('TICKET_BELL')], [136, 137, 138, 160, 168, 188]);
  assert.equal(L.size, 384);
});

/** The v2 Citizen bytes: header (magic, chained profile 2), then `fill`. */
function citizenBytes(fill) {
  const b = new Uint8Array(L.size), v = new DataView(b.buffer);
  b.set(new TextEncoder().encode(L.magic), 0);
  b[16] = 2; b[17] = 0;
  b.fill(7, at('WALLET'), at('WALLET') + 32);
  v.setUint32(at('BUCKET_MILLI'), 5_000, true);
  fill(b, v);
  return b;
}
const slotOff = slot => at('HOLDING') + (slot - 1) * 6;
const firstHolding = (b, v) => { const o = slotOff(1); v.setInt16(o, 128, true); b[o + 4] = 1; b[o + 5] = 2; };

// what the fixture wrote before (zeroed apart from wallet, bucket and slot 1)
const before = citizenBytes(firstHolding);
// the resident poststate the fixture now writes
const after = citizenBytes((b, v) => {
  b[at('FACTION')] = 0;
  b[at('FLAGS')] = CITIZEN.JOINED | CITIZEN.FIRST_FINAL | HOME_GRANTED;
  b[at('HOLDINGS_N')] = 1;
  v.setUint32(at('TICKET_BELL'), NO_TICKET, true);
  for (const s of [2, 3]) b[slotOff(s) + 5] = EMPTY_GEN;
  firstHolding(b, v);
});

test('the old zeroed fixture Citizen reads as an open ticket (the stall)', () => {
  const c = decode('Citizen', before, { profile: 2 });
  assert.equal(c.ticketBell, 0);
  assert.equal(landState(c).stage, 'ticket', 'TICKET_BELL 0 is an OPEN ticket to the gate');
  assert.deepEqual(citizenBindings(c), ['legacy', 'malformed', 'malformed'], 'unused slots at gen 0 are not empty');
});

test('the resident poststate reads as a FINAL first holding with no ticket', () => {
  const c = decode('Citizen', after, { profile: 2 });
  assert.equal(c.flags, CITIZEN.JOINED | CITIZEN.FIRST_FINAL | HOME_GRANTED);
  assert.equal(c.holdingsN, 1);
  assert.equal(c.ticketBell, NO_TICKET);
  const s = landState(c);
  assert.equal(s.stage, 'final');
  assert.equal(s.ticket, null);
  assert.deepEqual(s.holding, { p: 128, q: 0, site: 1, gen: 2 });
  // slots 2 and 3 are EMPTY (gen 0xFF), as Join's clear leaves them
  assert.deepEqual([c.holding[1].gen, c.holding[2].gen], [EMPTY_GEN, EMPTY_GEN]);
  assert.deepEqual(citizenBindings(c), ['legacy', 'empty', 'empty'], 'the inventory bindings the herald derives');
});
