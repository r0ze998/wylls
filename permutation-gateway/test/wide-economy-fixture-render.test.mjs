// Key-free Node smoke test of the production wide village card over the five recorded cases, both snapshots, JA and EN.
// It calls only the pure parser/renderer path (buildCase -> selectWide -> screens/holding.mjs render). Nothing is signed,
// sent, fetched or written; no controller, session or wallet module is imported.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASE_NAMES, FILE_KEYS, FIXTURE_DIR, buildCase } from '../screens/wide-economy-fixture/model.mjs';
import { selectWide } from '../../permutation-server/web/frontier/fwide.mjs';
import { setLang, lang } from '../../permutation-server/web/lang.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const FIXTURE = join(HERE, '..', 'screens', 'wide-economy-fixture');
const files = async name => Object.fromEntries(await Promise.all(Object.entries(FILE_KEYS)
  .map(async ([k, f]) => [k, Uint8Array.from(await readFile(join(ROOT, ...FIXTURE_DIR.split('/'), name, f)))])));

// Expected recorded vectors (the same independently decoded literals as the model test; milli-units as decimal strings).
const PRE_VALUES = Array(8).fill('1900000');
const POST_VALUES = {
  harvest: [2000000, 2000000, 2000000, 2000000, 1900000, 2000000, 2000000, 1900000],
  building: [2000000, 1920000, 1960000, 2000000, 1900000, 2000000, 2000000, 1900000],
  wall: [2000000, 2000000, 1700000, 2000000, 1900000, 2000000, 2000000, 1900000],
  tier: [2000000, 1000000, 1400000, 2000000, 1900000, 1700000, 2000000, 1900000],
  train: [3236000, 2810000, 2540000, 2520000, 1900000, 2376000, 2056000, 1900000],
};
const EMPTY_Q = ['0', '0', '0', '0'];
const Q0 = {
  harvest: { before: EMPTY_Q, after: EMPTY_Q },
  building: { before: EMPTY_Q, after: ['1', '0', '1800180000', '12000'] },
  wall: { before: ['1', '0', '1800180000', '12000'], after: ['4', '0', '1800275400', '100'] },
  tier: { before: ['4', '0', '1800275400', '100'], after: ['3', '0', '1800369000', '0'] },
  train: { before: ['3', '0', '1800369000', '0'], after: EMPTY_Q },
};
const RESERVE_AFTER_TRAIN = 10; // reserve[0]: every other case and snapshot records 0 troops

const milli = v => { const s = String(v); return `${s.slice(0, -3)}.${s.slice(-3)}`; }; // '1900000' -> '1900.000'
const utc = sec => new Date(Number(sec) * 1000).toISOString().replace('T', ' ').slice(0, 19);
const markup = out => (Array.isArray(out) ? out : [out]).map(x => String(x?.s ?? x)).join('');

const cases = Object.fromEntries(await Promise.all(CASE_NAMES.map(async n => [n, buildCase(n, await files(n))])));
const { render } = await import('../../permutation-server/web/frontier/screens/holding.mjs');

test('holding.render shows the normal wide card with the recorded data for 5 cases x 2 snapshots x JA/EN', () => {
  const startLang = lang();
  try {
    for (const l of ['ja', 'en']) {
      setLang(l);
      assert.equal(lang(), l);
      for (const name of CASE_NAMES) for (const phase of ['before', 'after']) {
        const tag = `${name}/${phase}/${l}`;
        const snap = cases[name][phase];
        assert.equal(selectWide(snap.FS, snap.holding.inventorySlot) !== false, true, `${tag}: slot selected`);
        const m = markup(render(snap.FS));

        // the normal wide card, not the legacy village and not the not-captured / ambiguous stand-ins
        assert.ok(m.includes('class="vcard village-head wide-village"'), `${tag}: wide head`);
        assert.ok(m.includes('wide-noexec'), `${tag}: read-only note`);
        assert.ok(!m.includes('wide-inventory-status'), `${tag}: no inventory status`);

        // resources: 8 rows, exact recorded values
        const rows = [...m.matchAll(/<tr class="ledger-row">([\s\S]*?)<\/tr>/g)].map(x => x[1]);
        assert.equal(rows.length, 8, `${tag}: 8 resource rows`);
        const want = (phase === 'before' ? PRE_VALUES : POST_VALUES[name]).map(milli);
        assert.deepEqual(rows.map(r => /<td class="ledger-val">([^<]*)<\/td>/.exec(r)?.[1]), want, `${tag}: resource values`);

        // queue: one entry when the recorded kind is non-zero, with its recorded UTC completion time
        const q = Q0[name][phase];
        const queue = /<ul class="queue">([\s\S]*?)<\/ul>/.exec(m);
        if (q[0] === '0') assert.equal(queue, null, `${tag}: empty queue`);
        else {
          assert.ok(queue, `${tag}: queue list`);
          assert.equal((queue[1].match(/<li>/g) ?? []).length, 1, `${tag}: one queue entry`);
          assert.ok(queue[1].includes(utc(q[2])), `${tag}: recorded doneAt ${utc(q[2])}`);
        }

        // reserve: only the train/after snapshot records troops (10 in slot 0)
        const reserve = /<ul class="reserve-list">([\s\S]*?)<\/ul>/.exec(m);
        if (name === 'train' && phase === 'after') {
          assert.ok(reserve, `${tag}: reserve list`);
          assert.equal((reserve[1].match(/<li>/g) ?? []).length, 1);
          assert.ok(new RegExp(`\\b${RESERVE_AFTER_TRAIN}\\b`).test(reserve[1].replace(/<[^>]*>/g, '')), `${tag}: reserve ${RESERVE_AFTER_TRAIN}`);
        } else assert.equal(reserve, null, `${tag}: no reserve list`);

        // no legacy Harvest / Build / Train / Step controls: the only action in the markup is closing the card
        assert.deepEqual([...m.matchAll(/data-act="([^"]*)"/g)].map(x => x[1]), ['wide-close'], `${tag}: only wide-close`);
        assert.equal((m.match(/<button\b/g) ?? []).length, 1, `${tag}: one button`);
        assert.ok(!m.includes('class="btn primary"') && !m.includes('class="actions"><button type="button" class="btn primary"'), `${tag}: no primary action`);
        assert.ok(!/data-act="(harvest|build|train|step|step-set|nudge|muster|march|caravan)"/.test(m), `${tag}: no legacy action`);
      }
    }
  } finally { setLang(startLang); }
});

test('fixture.mjs imports only pure renderer/parser modules and never writes history', async () => {
  const full = await readFile(join(FIXTURE, 'fixture.mjs'), 'utf8');
  const src = full.split('\n').filter(l => !l.trim().startsWith('//')).join('\n'); // code only: comments may name what is avoided
  const specs = [...src.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)].map(m => m[1]).sort();
  assert.deepEqual(specs, [
    './model.mjs', '/permutation-server/web/frontier/fwide.mjs', '/permutation-server/web/frontier/screens/holding.mjs',
    '/permutation-server/web/lang.mjs', '/permutation-server/web/util.mjs',
  ].sort());
  assert.ok(!/\bimport\s*\(/.test(src), 'no dynamic import');
  assert.ok(!/\bhistory\s*(\.|\[)\s*(pushState|replaceState|go|back|forward)\b/.test(src), 'no history mutator call');
  assert.ok(!/\b(pushState|replaceState)\s*\(/.test(src), 'no bare history mutator call');
  assert.ok(!/\b(?:window|globalThis|self)\s*\.\s*history\b/.test(src), 'no window.history access');
  for (const bad of ['pushState', 'replaceState', 'location.', 'location=', 'window.open', 'innerHTML', 'eval(', 'new Function',
    'XMLHttpRequest', 'WebSocket', 'sendBeacon', 'Worker(', 'signMessage', 'sendTransaction', 'controller', 'session', 'wallet.mjs']) {
    assert.ok(!src.includes(bad), `fixture.mjs mentions ${bad}`);
  }
  const html = await readFile(join(FIXTURE, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map(m => m[0]);
  assert.equal(scripts.length, 1);
  assert.ok(scripts[0].includes('src="/permutation-gateway/screens/wide-economy-fixture/fixture.mjs"'));
});
