// The JavaScript derivation of the twelve DeclareSiege accounts (permutation-server/web/frontier/fconquest-identity.mjs)
// against the RUST-PRODUCED vector frontier-node/crates/fclient/tests/fixtures/wide_conquest_declare_siege_v1.json
// (recorded from fclient's own test: frontier-abi address helpers, wide_ix::DECLARE_SIEGE, wide_ix::DeclareSiege).
// Public bytes only: no key, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonicalDeclareSiegeRoles, DECLARE_SIEGE_SHAPE } from '../../permutation-server/web/frontier/fconquest-identity.mjs';
import { canonicalExpeditionAccounts } from '../../permutation-server/web/frontier/fexpedition-identity.mjs';
import { withSeed, seedOf } from '../../permutation-server/web/frontier/faddr.mjs';
import { declareSiegeData } from '../src/frontier/conquest-prepare.mjs';

const V = JSON.parse(readFileSync(new URL('../../frontier-node/crates/fclient/tests/fixtures/wide_conquest_declare_siege_v1.json', import.meta.url), 'utf8'));
const request = c => ({ program: V.program, season: V.season, host: c.host, original_owner: withSeed(V.season, seedOf('Citizen', { wallet: c.wallet }), V.program),
  standing: c.standing, wallet: c.wallet, payer: c.wallet });

test('every Rust case: the same twelve addresses, names and order; the same standing key; the same inner command bytes', () => {
  assert.equal(V.schema, 'frontier-wide-conquest-declare-siege-vector-v1'); assert.equal(V.cases.length, 6);
  for (const c of V.cases) {
    const r = request(c), roles = canonicalDeclareSiegeRoles(r, c.site), label = `${c.standing.p},${c.standing.q} site ${c.site} ${c.wallet.slice(0, 6)}`;
    assert.deepEqual(roles.map(x => x.name), c.roles.map(x => x.name), label);
    assert.deepEqual(roles.map(x => x.address), c.roles.map(x => x.address), label);
    assert.deepEqual(roles.map(x => x.signer), c.roles.map(x => x.signer), label);
    // (the wallet named twice carries the payer's writable flag at both positions, on both sides; the ABI's own minimum
    // for actor alone is read-only)
    assert.deepEqual(roles.map(x => x.writable), c.roles.map(x => x.writable), label);
    assert.equal(roles[0].writable, true); assert.equal(DECLARE_SIEGE_SHAPE[0][2], false);
    assert.equal(canonicalExpeditionAccounts(r).standing_key, c.standing_key, label);
    // the ABI's inner command, as the gateway wraps it (the first four bytes are the outer wrapper of the pin given)
    assert.equal(declareSiegeData({ target: { site: c.site, entry: c.entry } }, { tag: 0xda, kind: 12 }).subarray(4).toString('hex'), c.inner_hex, label);
  }
  assert.deepEqual(DECLARE_SIEGE_SHAPE.map(x => x[0]), V.cases[0].roles.map(x => x.name));
});

test('the cases differ exactly where the handler binds them: site → position; province → province, roster, position, table; wallet → Citizen and escrow', () => {
  const [base, site4, , province130, , wallet8] = V.cases;
  const moved = c => c.roles.map((x, i) => (x.address !== base.roles[i].address ? i : -1)).filter(i => i >= 0);
  assert.deepEqual(moved(site4), [8]); assert.deepEqual(moved(province130), [5, 6, 8, 9]); assert.deepEqual(moved(wallet8), [0, 1, 3, 10]);
  // and the JavaScript side moves the same positions
  const js = c => canonicalDeclareSiegeRoles(request(c), c.site), movedJs = c => js(c).map((x, i) => (x.address !== js(base)[i].address ? i : -1)).filter(i => i >= 0);
  assert.deepEqual(movedJs(site4), [8]); assert.deepEqual(movedJs(province130), [5, 6, 8, 9]); assert.deepEqual(movedJs(wallet8), [0, 1, 3, 10]);
});
