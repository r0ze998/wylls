// AC6a: citizens/watcher/owners.mjs against the captured herald rows (test/fixtures/ai-herald-*) and the
// pinned host-id vectors. Real rows unless a test says SYNTHETIC. No network except the loopback fake herald.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createOwners, parseHostId, tagHex, tagFromDecimal, isTagHex, citizenTagOfTag15 } from '../citizens/watcher/owners.mjs';
import { normalizeRow, shapeProvince } from '../citizens/watcher/feed.mjs';
import { decodeRoster } from '../../permutation-server/web/frontier/people/roster.mjs';
import { decode } from '../../permutation-server/web/frontier/fcodec.mjs';
import { parseEnvelope } from '../../permutation-server/web/frontier/herald.mjs';
import { hostParts } from '../../permutation-server/web/frontier/faddr.mjs';
import { loadEvents, loadMeta, readJson, FIXTURE_DIR } from './fixtures/ai-herald-fake.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const season = readJson('ai-herald-season.json');
const SEASON = { seasonAddress: season.seasonAddress, programId: season.programId };
const rows = loadEvents().events;
const meta = loadMeta();

function ownersFromFixture() {
  const o = createOwners(SEASON);
  for (const r of rows) { const ev = normalizeRow(r); if (ev) o.ingest(ev); }
  return o;
}

test('parseHostId matches the pinned frontier-abi host-id vectors and refuses ids no holding can issue', () => {
  const vec = JSON.parse(fs.readFileSync(path.join(here, '../../frontier-abi/vectors/addresses.json'), 'utf8')).host_ids;
  assert.ok(vec.length >= 4);
  for (const v of vec) assert.deepEqual(parseHostId(v.host_id), { p: v.p, q: v.q, site: v.site, gen: v.gen, seq: v.seq }, `host ${v.host_id}`);
  assert.equal(parseHostId('18446744073709551615'), null, 'HOST_ID_INVALID');
  assert.equal(parseHostId((0n << 44n | 12n << 40n).toString()), null, 'site 12');
  assert.equal(parseHostId('-1'), null);
  assert.equal(parseHostId('not a number'), null);
});

test('parseHostId agrees with the web client faddr.hostParts on every host id of the capture', () => {
  const ids = new Set();
  for (const r of rows) { const d = r.decoded; const h = d.key?.host_id ?? d.payload?.host_id; if (h && h !== '0') ids.add(h); }
  assert.ok(ids.size > 50);
  for (const id of ids) {
    const a = parseHostId(id), b = hostParts(id);
    assert.deepEqual([a.p, a.q, a.site, a.gen, a.seq], [b.p, b.q, b.site, b.gen, b.seq], id);
  }
});

test('tags: hex form, decimal form, and the refusal of ambiguous strings', () => {
  assert.equal(tagHex(0n), '0000000000000000');
  assert.equal(tagHex(255), '00000000000000ff');
  assert.equal(tagHex(0xffffffffffffffffn), 'ffffffffffffffff');
  assert.equal(tagFromDecimal('11898493505901884854'), 'a51ff0cd7d92f5b6'); // the defender of the village_attack case (me file, Holding owner bytes)
  assert.throws(() => tagHex('1234567890123456'), TypeError, 'a 16-digit decimal and a 16-digit hex tag look alike');
  assert.ok(isTagHex('a51ff0cd7d92f5b6') && !isTagHex('A51FF0CD7D92F5B6') && !isTagHex('a51f'));
});

test('every SETTLE holder of the capture resolves to a JOIN (tag derived from tag15 by the create_with_seed rule)', () => {
  const o = ownersFromFixture();
  const settles = rows.filter(r => r.decoded.name === 'SETTLE' && r.decoded.payload.outcome < 2);
  assert.ok(settles.length >= 40);
  for (const r of settles) {
    const tag = tagFromDecimal(r.decoded.payload.citizen_tag);
    assert.notEqual(o.factionOfTag(tag), null, `no JOIN for holder ${tag} of ${r.decoded.key.p},${r.decoded.key.q},${r.decoded.key.site}`);
    assert.ok(o.walletOf(tag), 'wallet of a JOIN');
  }
  // the derivation itself: the JOIN of the defender gives the tag the herald's own /h/me Holding names as owner
  const join = rows.find(r => r.decoded.name === 'JOIN' && citizenTagOfTag15(r.decoded.key.citizen_tag15, SEASON) === 'a51ff0cd7d92f5b6');
  assert.ok(join, 'the defender JOIN is in the excerpt');
  assert.equal(o.walletOf('a51ff0cd7d92f5b6'), meta.me.find(m => m.label === 'defender').wallet, 'wallet from the JOIN row = the wallet the /h/me capture asked for');
});

test('citizenOfHost: owners derived from SETTLE history equal the arrival records of the clash inputs (raw bytes, independent path)', () => {
  const o = ownersFromFixture();
  let checked = 0;
  for (const c of meta.cases) for (const bell of [c.cb]) {
    const env = readJson(`ai-herald-province-${c.p},${c.q}-${bell}.json`);
    const parsed = parseEnvelope(env, { seasonId: season.season, p: c.p, q: c.q, bell });
    for (const a of parsed.inputs?.arrivals ?? []) {
      if (a.hostId === 0n) continue;
      assert.equal(o.citizenOfHost(String(a.hostId)), tagHex(a.citizenTag), `host ${a.hostId} in ${c.id}`);
      assert.equal(o.factionOfHost(String(a.hostId)), a.faction, `faction of host ${a.hostId}`);
      checked++;
    }
  }
  assert.ok(checked >= 6, `arrival records checked: ${checked}`);
});

test('citizenOfHost: every resident of every captured province file resolves to the holder whose site mirror says so', () => {
  const o = ownersFromFixture();
  let hosts = 0, homeHosts = 0;
  for (const name of fs.readdirSync(FIXTURE_DIR).filter(n => /^ai-herald-province-.*\.json$/.test(n))) {
    const env = readJson(name);
    const [, p, q, b] = /province-(-?\d+),(-?\d+)-(\d+)\.json/.exec(name).map(Number);
    const view = shapeProvince(parseEnvelope(env, { seasonId: season.season, p, q, bell: b }), o);
    for (const h of view.hosts) {
      assert.ok(h.owner, `host ${h.id} of ${name} has no owner`);
      assert.equal(o.factionOfTag(h.owner), h.faction, `entry faction = JOIN faction for ${h.id}`);
      // a host may stand in another province than its holding's: compare with the site mirror only when it is the same one
      if (h.host.p === view.p && h.host.q === view.q) {
        const site = view.sites.find(s => s.site === h.host.site);
        assert.equal(site.owner, h.owner, 'the site mirror (gen) and the host id (gen) name the same holder');
        assert.equal(site.gen, h.host.gen);
        homeHosts++;
      }
      hosts++;
    }
  }
  assert.ok(hosts > 100 && homeHosts > 50, `hosts checked: ${hosts}, at home: ${homeHosts}`);
});

test('holdingsOf / homeOf agree with the herald /h/me Holding bytes of the two captured citizens', () => {
  const o = ownersFromFixture();
  for (const m of meta.me) {
    const me = readJson(m.file);
    const tag = tagFromDecimal(m.tag);
    const mine = o.holdingsOf(tag);
    assert.equal(mine.length, me.holdings.length, `${m.label} holdings`);
    for (const hb of me.holdings) {
      const h = decode('Holding', Buffer.from(hb.bytes_b64, 'base64'));
      assert.equal(tagHex(Buffer.from(h.ownerCitizen).readBigUInt64LE(0)), tag);
      const got = mine.find(x => x.p === h.p && x.q === h.q && x.site === h.site);
      assert.ok(got, `${m.label} holds ${h.p},${h.q},${h.site}`);
      assert.equal(got.gen, h.gen);
    }
    assert.deepEqual(o.homeOf(tag), { p: mine[0].p, q: mine[0].q, site: mine[0].site });
    assert.equal(mine[0].final, true, 'HOLDING_FINAL seen for the home village');
  }
  assert.equal(o.homeOf('0000000000000001'), null);
  assert.deepEqual(o.holdingsOf('0000000000000001'), []);
});

test('citizenOfHost: a host id of another generation or an unsettled site has no owner', () => {
  const o = ownersFromFixture();
  const id = meta.me.find(m => m.label === 'defender').host; // 1150093457620992: (1,4) site 6 gen 1
  const p = parseHostId(id);
  assert.equal(o.citizenOfHost(id), 'a51ff0cd7d92f5b6');
  const other = (BigInt(id) & ~(0xffn << 32n)) | (BigInt((p.gen + 1) & 0xff) << 32n);
  assert.equal(o.citizenOfHost(String(other)), null, 'same site, other generation');
  assert.equal(o.citizenOfHost('0'), null, 'the Concord site 0 has no settled holder in the excerpt');
  assert.equal(o.citizenOfHost('18446744073709551615'), null);
});

test('ingestion is deterministic and order-stable', () => {
  const a = ownersFromFixture(), b = ownersFromFixture();
  const tags = [...new Set(rows.filter(r => r.decoded.name === 'SETTLE').map(r => tagFromDecimal(r.decoded.payload.citizen_tag)))];
  assert.deepEqual(tags.map(t => a.holdingsOf(t)), tags.map(t => b.holdingsOf(t)));
});

// ---- SYNTHETIC: the capture has no RELEASE, no displacing SETTLE (outcome 1) and no roster route; these rows are made up
// in the shape of normalizeRow's output for the kinds the capture lacks (labelled; the shapes are those of frontier-abi log.rs).

test('SYNTHETIC: RELEASE ends a holding; a displacing SETTLE moves it and the old generation stays with the old holder', () => {
  const o = createOwners(SEASON);
  const A = 'aaaaaaaaaaaaaaaa', B = 'bbbbbbbbbbbbbbbb';
  o.ingest({ kind: 'SETTLE', outcome: 0, p: 2, q: -1, site: 3, citizen: A, gen: 1, bell: 5 });
  o.ingest({ kind: 'HOLDING_FINAL', p: 2, q: -1, site: 3 });
  const hostGen1 = '319962178650154'; // pinned vector: p 2, q -1, site 3, gen 1, seq 42
  assert.equal(o.citizenOfHost(hostGen1), A);
  assert.equal(o.holdingsOf(A)[0].final, true);
  o.ingest({ kind: 'SETTLE', outcome: 2, p: 2, q: -1, site: 3, citizen: B, gen: 9, bell: 6 }); // taken: no change
  o.ingest({ kind: 'SETTLE', outcome: 3, p: 2, q: -1, site: 3, citizen: B, gen: 9, bell: 7 }); // expired: no change
  assert.equal(o.citizenOfHost(hostGen1), A);
  assert.deepEqual(o.holdingsOf(B), []);
  o.ingest({ kind: 'SETTLE', outcome: 1, p: 2, q: -1, site: 3, citizen: B, gen: 2, bell: 8, displaced: A });
  assert.deepEqual(o.holdingsOf(A), [], 'displaced');
  assert.equal(o.holdingsOf(B)[0].gen, 2);
  assert.equal(o.citizenOfHost(hostGen1), A, 'a gen-1 host id still names the holder of generation 1');
  assert.equal(o.holderOfSite(2, -1, 3).tag, B);
  o.ingest({ kind: 'RELEASE', p: 2, q: -1, site: 3, citizen: B });
  assert.deepEqual(o.holdingsOf(B), []);
  assert.equal(o.holderOfSite(2, -1, 3), null);
});

test('SYNTHETIC roster (built from the real SETTLE rows in roster.rs layout): decodes, agrees with the history, and fills only what the history lacks', () => {
  const ring = Number(Object.keys(meta.rosters).find(k => /synthetic-5\.bin$/.test(k)) ? 5 : 0);
  assert.equal(ring, 5);
  const note = meta.rosters['ai-herald-roster-synthetic-5.bin'];
  assert.equal(note.synthetic, true, 'the meta says it is synthetic');
  const dec = decodeRoster(Uint8Array.from(fs.readFileSync(path.join(FIXTURE_DIR, 'ai-herald-roster-synthetic-5.bin'))));
  assert.equal(dec.ring, 5);
  const full = ownersFromFixture();
  let agree = 0;
  for (const [k, sites] of dec.provinces) {
    const [p, q] = k.split(',').map(Number);
    sites.forEach((s, site) => {
      const h = full.holderOfSite(p, q, site);
      if (s && h) { assert.equal(tagHex(s.tag), h.tag, `roster = history at ${k}/${site}`); agree++; }
    });
  }
  assert.ok(agree >= 3, `sites where roster and history both know a holder: ${agree}`);
  // an owners store that saw no SETTLE learns the holders from the roster, once, and does not overwrite a known one
  const fresh = createOwners(SEASON);
  const added = fresh.useRoster(dec);
  const listed = [...dec.provinces.values()].reduce((n, sites) => n + sites.filter(Boolean).length, 0);
  assert.equal(added, listed);
  assert.ok(added >= agree);
  const before = full.holderOfSite(1, 4, 6);
  assert.equal(full.useRoster(dec) >= 0, true);
  assert.deepEqual(full.holderOfSite(1, 4, 6), before, 'a holder the history knows is not overwritten');
  assert.equal(fresh.useRoster(dec), 0, 'second fill adds nothing');
  const some = [...dec.provinces].map(([k, v]) => [k, v.findIndex(Boolean)]).find(([, i]) => i >= 0);
  const [p, q] = some[0].split(',').map(Number);
  assert.ok(fresh.holderOfSite(p, q, some[1]));
  assert.ok(fresh.holdersIn(p, q).length >= 1);
});
