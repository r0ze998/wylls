// fix-loop29 (loop-play29 BREAK-1, since 20adb0874 2026-11-14): a muster sent AT ONCE by the Form a host card's confirm
// ("Form N here" → `muster-send-wait` → controller.mjs armMusterWait, press 'send') and refused by the program
// (NotResident at the turn change) was told as the PREVIOUS send — "That did not work / Nothing has been trained yet." —
// and its "Try again" sent a TRAIN (live: 100 Spearmen joined the reserve). The confirm's press is not one of app.mjs SENDS,
// so FS.lastAct stayed the earlier Train; verify-pr98 had named the muster only on the WAITING send.
// The fix: (1) both of the muster's sends remember the muster (flocalplay-muster-wait.mjs musterLastAct), and so does the
// march card's immediate send (armMarchWait, the same gap); (2) the direct sends that were missing from SENDS are added
// (the scout's Train/Muster, ② rights, ⑨⑩ custody, the map's outpost, the test faucet); (3) the page's dispatcher: a
// refusal left by a press that is not a send and did not name itself names nothing and offers no retry
// (hud/status.mjs unownedRefusal) — it can never re-run another order again.
// These tests press through the page's own dispatcher (app.mjs delegate) with spies in place of the chain sends.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLang, L } from '../../permutation-server/web/lang.mjs';
import * as app from '../../permutation-server/web/frontier/app.mjs';
import { ACTIONS, FORMS } from '../../permutation-server/web/frontier/controller.mjs';
import { FS } from '../../permutation-server/web/frontier/fstate.mjs';
import { musterLastAct } from '../../permutation-server/web/frontier/flocalplay-muster-wait.mjs';
import * as status from '../../permutation-server/web/frontier/hud/status.mjs';

const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url);
const src = f => readFileSync(new URL(f, WEB), 'utf8');

const CJK = /[぀-ヿ㐀-鿿]/;
// (one dispatcher for the whole file: the page binds it once)
FS.mode = 'play';
const listeners = {};
app.delegate({ addEventListener: (t, f) => { (listeners[t] ??= []).push(f); } });
const settle = () => new Promise(r => setTimeout(r, 5));
async function press(act, data = {}) {
  const el = { dataset: { act, ...data }, disabled: false, tagName: 'BUTTON', getAttribute: () => null };
  for (const f of listeners.click) f({ target: { closest: () => el }, preventDefault() {} });
  await settle();
}
async function submit(form, values = {}) {
  const f = { dataset: { form }, elements: Object.entries(values).map(([name, value]) => ({ name, value, type: 'text' })), querySelector: () => null };
  for (const l of listeners.submit) l({ target: { closest: () => f }, preventDefault() {} });
  await settle();
}
const toast = () => String(status.renderStatus(status.statusOf(FS, { canRetry: !!FS.lastAct })));
const TRAIN = Object.freeze({ kind: 'act', name: 'train', data: { act: 'train', unit: '0', n: '100' } });
const REFUSED = Object.freeze({ ok: false, code: 'NotResident', programCode: 26 });

// spies in place of the page's sends; every test puts the real ones back
const real = new Map();
const calls = [];
function spy(table, name, impl = () => { FS.notice = { ...REFUSED }; }) {
  if (!real.has(`${table === ACTIONS ? 'A' : 'F'}:${name}`)) real.set(`${table === ACTIONS ? 'A' : 'F'}:${name}`, [table, name, table[name]]);
  table[name] = (...a) => { calls.push([name, a[0]]); return impl(...a); };
}
afterEach(() => {
  for (const [, [table, name, fn]] of real) table[name] = fn;
  real.clear(); calls.length = 0; FS.notice = null; FS.lastAct = null; setLang('ja');
});

for (const lang of ['ja', 'en']) {
  test(`BREAK-1 (${lang}): a muster sent at once by the card's confirm and refused says the MUSTER, and "Try again" sends that muster — never the earlier Train`, async () => {
    setLang(lang);
    spy(ACTIONS, 'train', () => { FS.notice = { ok: true, text: 'trained' }; });
    spy(ACTIONS, 'muster');
    // the confirm's own press, as controller.mjs armMusterWait's 'send' branch does it (pinned below): remember, then send
    spy(ACTIONS, 'muster-send-wait', () => { FS.lastAct = musterLastAct({ unit: 0, troops: 200, tile: 41 }); return ACTIONS.muster({ unit: '0', troops: '200', tile: '41' }); });
    FS.lastAct = TRAIN;                               // the player trained before forming (world G: Train, then Form)
    await press('muster-send-wait');
    const out = toast();
    assert.match(out, /tx-refused/);
    assert.ok(out.includes(L`編成はまだ命じられていません。`), out);
    assert.ok(!out.includes(L`訓練はまだされていません。`), 'not the Train\'s line');
    if (lang === 'en') { assert.match(out, /The host has not been ordered to form up yet\./); assert.doesNotMatch(out, /Nothing has been trained yet/); assert.ok(!CJK.test(out.replace(/<[^>]+>/g, '')), out); assert.doesNotMatch(out, /season/i); }
    assert.match(out, /data-act="notice-retry"/, 'the muster can be tried again');
    calls.length = 0;
    await press('notice-retry');
    assert.deepEqual(calls, [['muster', { unit: '0', troops: '200', tile: '41' }]], 'the retry is the same muster, once, and no Train');
  });
}

test('BREAK-1: the real armMusterWait remembers the muster on BOTH of its sends, before the send (pins)', () => {
  const c = src('controller.mjs');
  const block = c.slice(c.indexOf('function armMusterWait() {'), c.indexOf('/** (tests) The muster\'s waiting send'));
  assert.match(block, /if \(press === 'send'\) \{ FS\.lastAct = musterLastAct\(n\.draft\); return musterOrder\(n\.draft\.unit, n\.draft\.troops, n\.draft\.tile, n\.holding\); \}/);
  assert.match(c, /FS\.lastAct = musterLastAct\(card\.draft\);\n    invalidate\('panel'\);\n    return musterOrder\(card\.draft\.unit, card\.draft\.troops, card\.draft\.tile, card\.holding\);/);
  // the remembered muster is exactly what was sent, as strings — the shape a button's dataset gives ACTIONS.muster
  assert.deepEqual(musterLastAct({ unit: 6, troops: 100, tile: 7 }), { kind: 'act', name: 'muster', data: { unit: '6', troops: '100', tile: '7' } });
  assert.match(c, /  muster: d => musterOrder\(num\(d\.unit\), num\(d\.troops\), d\.tile === undefined \|\| d\.tile === '' \? null : num\(d\.tile\)\),/);
});

for (const lang of ['ja', 'en']) {
  test(`audit, the march card's wait press (${lang}): a march sent at once and refused is the march's, and "Try again" sends the march`, async () => {
    setLang(lang);
    spy(ACTIONS, 'train');
    spy(ACTIONS, 'march-send');
    spy(ACTIONS, 'march-send-wait', () => { FS.lastAct = { kind: 'act', name: 'march-send', data: {} }; return ACTIONS['march-send'](); });
    FS.lastAct = TRAIN;
    await press('march-send-wait');
    const out = toast();
    assert.ok(out.includes(L`進軍は送られていません。`), out);
    assert.ok(!out.includes(L`訓練はまだされていません。`));
    if (lang === 'en') { assert.ok(!CJK.test(out.replace(/<[^>]+>/g, '')), out); assert.doesNotMatch(out, /season/i); }
    calls.length = 0;
    await press('notice-retry');
    assert.deepEqual(calls.map(x => x[0]), ['march-send']);
  });
}
test('audit, the march card\'s wait press: the real armMarchWait names the march before its immediate send (pin)', () => {
  const c = src('controller.mjs');
  assert.match(c, /const MARCH_LAST_ACT = \(\) => \(\{ kind: 'act', name: 'march-send', data: \{\} \}\);/);
  assert.match(c, /if \(problems\.length === 0 && !marchNearEnd\(\)\) \{ FS\.lastAct = MARCH_LAST_ACT\(\); return sendTheMarch\(\); \}/);
});

// (2) the direct sends added to SENDS: each is remembered by its own press and "Try again" re-runs it with the same data
const ADDED = {
  'home-scout-train': {}, 'home-scout-muster': {},
  'rights-execute': { tag: '77', nonce: '3', fp: '1', fq: '0', site: '2', tile: '9', seq: '4' }, 'rights-release': { tag: '77', nonce: '3', fp: '1', fq: '0', site: '2', tile: '9' },
  'rights-revoke': { tag: '77', nonce: '3' }, 'rights-close': { tag: '77', nonce: '3' }, 'rights-deliver': { kind: 'vault', dp: '1', dq: '0', at: '9', gen: '0', seq: '5', path: '1_0' },
  'cap-reclaim': { fp: '1', fq: '0', site: '2', units: '3', seq: '1' }, 'cap-revoke': { fp: '1', fq: '0', site: '2', grant: '8' }, 'cap-settle': { grant: '8', job: '1' },
  'cap-cancel': { grant: '8', job: '1' }, 'cap-claim': { grant: '8', job: '1', p: '1', q: '0', vtile: '9', vgen: '0' }, 'cap-loss': { jobs: '1_2' },
  'lot-deliver': { seq: '2', owner: '77' }, 'lot-reconcile': { owner: '77', caravans: '1_2' }, 'lot-close': { owner: '77', rent: 'Rent111' },
  'cq-outpost': { p: '2', q: '1', site: '4' }, 'prize-faucet': {},
};
for (const [name, data] of Object.entries(ADDED)) {
  test(`audit, ${name}: one of the page's sends — a refusal of it offers "Try again", which re-runs ${name} with its own data (never the earlier Train)`, async () => {
    assert.ok(app.SENDS.has(name), `${name} is a send`);
    spy(ACTIONS, 'train');
    spy(ACTIONS, name);
    FS.lastAct = TRAIN;
    await press(name, data);
    assert.equal(FS.lastAct?.name, name);
    for (const lang of ['ja', 'en']) {
      setLang(lang);
      const out = toast();
      assert.match(out, /data-act="notice-retry"/);
      assert.ok(!out.includes(L`訓練はまだされていません。`) || name === 'home-scout-train', `${name}: not the Train's line`);
      if (lang === 'en') { assert.ok(!CJK.test(out.replace(/<[^>]+>/g, '')), out); assert.doesNotMatch(out, /season/i); }
    }
    calls.length = 0;
    await press('notice-retry');
    assert.deepEqual(calls, [[name, { act: name, ...data }]]);
  });
}
test('audit: the first village\'s scout names what it left undone (its own Train / Muster line), JA and EN', () => {
  for (const lang of ['ja', 'en']) {
    setLang(lang);
    const say = n => status.statusOf({ notice: { ...REFUSED }, lastAct: { kind: 'act', name: n, data: {} } }, { canRetry: true }).what;
    assert.equal(say('home-scout-train'), L`訓練はまだされていません。`);
    assert.equal(say('home-scout-muster'), L`編成はまだ命じられていません。`);
    if (lang === 'en') { assert.equal(say('home-scout-muster'), 'The host has not been ordered to form up yet.'); assert.equal(say('home-scout-train'), 'Nothing has been trained yet.'); }
  }
});

// (3) the dispatcher's net
for (const lang of ['ja', 'en']) {
  test(`audit, the net (${lang}): a refusal left by a press that is not a send (outpost-send, wide-act-send, a thrown error, the dest form) names nothing and offers no retry`, async () => {
    setLang(lang);
    spy(ACTIONS, 'train');
    for (const name of ['outpost-send', 'wide-act-send', 'cq-march']) {
      assert.ok(!app.SENDS.has(name));
      spy(ACTIONS, name);
      FS.lastAct = TRAIN; FS.notice = null;
      await press(name, { p: '1', q: '0', site: '2' });
      const out = toast();
      assert.match(out, /tx-refused/, name);
      assert.doesNotMatch(out, /data-act="notice-retry"/, `${name}: no retry`);
      assert.ok(!out.includes(L`訓練はまだされていません。`), `${name}: not the Train's line`);
      assert.equal(FS.notice.unsent, status.UNSENT_UNNAMED);
      if (lang === 'en') { assert.ok(!CJK.test(out.replace(/<[^>]+>/g, '')), out); assert.doesNotMatch(out, /season/i); }
    }
    // a press that throws (the dispatcher's own catch)
    spy(ACTIONS, 'outpost-send', () => Promise.reject(Object.assign(new Error('boom'), { code: 'Error' })));
    FS.lastAct = TRAIN; FS.notice = null;
    await press('outpost-send');
    assert.doesNotMatch(toast(), /data-act="notice-retry"/);
    // a form that is not a send (dest)
    spy(FORMS, 'dest');
    FS.lastAct = TRAIN; FS.notice = null;
    await submit('dest', { p: '1' });
    assert.doesNotMatch(toast(), /data-act="notice-retry"/);
    assert.ok(!toast().includes(L`訓練はまだされていません。`));
    // and nothing was ever trained
    assert.ok(!calls.some(c => c[0] === 'train'));
  });
}
test('audit, the net leaves alone: a press that named itself, a notice that says what it concerns, a waiting send, and the retry\'s own refusal', async () => {
  // a notice with its own `unsent` (wide-host-step, the withdrawn waits)
  spy(ACTIONS, 'wide-host-step', () => { FS.notice = { ...REFUSED, unsent: 'wide-host-step', retry: false }; });
  FS.lastAct = TRAIN;
  await press('wide-host-step');
  assert.equal(FS.notice.unsent, 'wide-host-step');
  // a waiting send (not a refusal)
  spy(ACTIONS, 'muster-send-wait', () => { FS.notice = { busy: false, waiting: true, text: 'waiting' }; });
  await press('muster-send-wait');
  assert.equal(FS.notice.waiting, true); assert.equal(FS.notice.unsent, undefined);
  // "Try again" refused again: still the same send, still retryable
  spy(ACTIONS, 'muster');
  FS.lastAct = musterLastAct({ unit: 0, troops: 200, tile: 41 }); FS.notice = { ...REFUSED };
  await press('notice-retry');
  assert.equal(FS.notice.unsent, undefined);
  assert.match(toast(), /data-act="notice-retry"/);
  // the pure rule
  const n = { ...REFUSED };
  assert.equal(status.unownedRefusal({ noticeBefore: null, notice: n, lastActBefore: TRAIN, lastAct: musterLastAct({ unit: 0, troops: 1, tile: 1 }) }), null, 'named itself');
  assert.equal(status.unownedRefusal({ noticeBefore: n, notice: n, lastActBefore: TRAIN, lastAct: TRAIN }), null, 'an older notice');
  assert.equal(status.unownedRefusal({ noticeBefore: null, notice: { ok: true }, lastActBefore: TRAIN, lastAct: TRAIN }), null, 'a success');
  assert.deepEqual(status.unownedRefusal({ noticeBefore: null, notice: n, lastActBefore: TRAIN, lastAct: TRAIN }), { ...n, unsent: 'unnamed', retry: false });
});

test('the wiring: the dispatcher hands the net the state before every press that is not a send (clicks and forms); the retry is one helper', () => {
  const a = readFileSync(new URL('app.mjs', WEB), 'utf8');
  assert.match(a, /const own = play && !sends && !NOT_OWNERS\.includes\(el\.dataset\.act\) \? before\(\) : null;\n    run\(fn\(el\.dataset, el\), sends \? \{ act: el\.dataset\.act, data: \{ \.\.\.el\.dataset \} \} : null, own\);/);
  assert.match(a, /const own = play && !sends \? before\(\) : null;   \/\/ \(taken BEFORE the press runs: fn may set its refusal synchronously\)\n    run\(fn\(f\), sends \? \{ form: f\.dataset\.form \} : null, own\);/);
  assert.match(a, /const NOT_OWNERS = Object\.freeze\(\['notice-retry', 'notice-close'\]\);/);
  assert.match(a, /return status\.retryAction\(a, \{ actions: ACTIONS, forms: FORMS \}\);/);
  // every send is an action of the controller (the retry runs ACTIONS[name])
  for (const s of app.SENDS) assert.equal(typeof ACTIONS[s], 'function', s);
});

// (verify-pr303) The net and a slow press: a send's refusal that lands while a press that is NOT a send is still running
// (a read, a re-read) stays the send's — its line and its "Try again" — when that press settles; a new refusal the slow
// press leaves after it is still its own (named nothing, no retry).
for (const lang of ['ja', 'en']) {
  test(`verify-pr303 (${lang}): an earlier send's refusal landing during a slow non-send press keeps its line and its retry`, async () => {
    setLang(lang);
    spy(ACTIONS, 'train', async () => { FS.notice = { busy: true }; await new Promise(r => setTimeout(r, 15)); FS.notice = { ...REFUSED }; });
    spy(ACTIONS, 'me-retry', () => new Promise(r => setTimeout(r, 40)));
    const el = { dataset: { act: 'train', unit: '0', n: '100' }, disabled: false, tagName: 'BUTTON', getAttribute: () => null };
    for (const f of listeners.click) f({ target: { closest: () => el }, preventDefault() {} });
    await press('me-retry');                          // pressed while the Train is in flight
    await new Promise(r => setTimeout(r, 60));        // the Train refused (15 ms), then the read settles (40 ms)
    assert.equal(FS.notice.unsent, undefined, 'the net left the Train\'s refusal alone');
    const out = toast();
    assert.ok(out.includes(L`訓練はまだされていません。`), out);
    if (lang === 'en') { assert.match(out, /Nothing has been trained yet\./); assert.doesNotMatch(out, /season/i); }
    calls.length = 0;
    await press('notice-retry');
    assert.deepEqual(calls.map(c => c[0]), ['train'], 'the retry is the Train');
  });
}
test('verify-pr303: a slow non-send press that leaves its OWN refusal after an earlier send was refused is still caught by the net', async () => {
  spy(ACTIONS, 'train');                                         // refused at once
  spy(ACTIONS, 'outpost-send', async () => { await new Promise(r => setTimeout(r, 15)); FS.notice = { ok: false, code: 'NotResident', programCode: 26 }; });
  const el = { dataset: { act: 'train', unit: '0', n: '100' }, disabled: false, tagName: 'BUTTON', getAttribute: () => null };
  for (const f of listeners.click) f({ target: { closest: () => el }, preventDefault() {} });
  await settle();
  await press('outpost-send'); await new Promise(r => setTimeout(r, 30));
  assert.equal(FS.notice.unsent, status.UNSENT_UNNAMED);
  assert.doesNotMatch(toast(), /data-act="notice-retry"/);
  // the pure rule
  const n = { ...REFUSED };
  assert.equal(status.unownedRefusal({ noticeBefore: { busy: true }, notice: n, lastActBefore: TRAIN, lastAct: TRAIN, sendLeft: n }), null, 'the send left it');
  assert.deepEqual(status.unownedRefusal({ noticeBefore: null, notice: n, lastActBefore: TRAIN, lastAct: TRAIN, sendLeft: { ...REFUSED } }), { ...n, unsent: 'unnamed', retry: false });
});
