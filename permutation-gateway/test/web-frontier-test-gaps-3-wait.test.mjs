// test-gaps-3 (#261 wait panel / first battle, #265 fighting camp, #267 wall-clock times + keep prediction): the
// invariants verify-pr261/265/267 checked on live pages, as properties.
//   W1 wall-clock words: for 4,000 random (now, due) pairs at ×1, a wandering 1.04, ×30, ×60 and an unknown pace, in
//      Japanese and English, the clock time said is the viewer's wall now + the chain seconds left / pace (local time,
//      a fixed time zone), it is said on a fast clock only from a one-minute real wait, never when the pace is unknown,
//      and a past time is "any moment now"; later chain times never come earlier on the wall
//   W2 arrivalStamina = a port of permutation-rules host.rs Stamina (at / spend of DEPART_STAMINA at depart + 1) for
//      20,000 random departable hosts; exhausted below ENGAGE_STAMINA
//   W3 campFights = the real clash kernel (frontier.wasm resolve_from_inputs) on the native clash-model vectors (a camp
//      fights ⇔ the kernel puts it among the garrisons, whenever the day's camp check does not run), and on the
//      "12 garrisons" vector with k of its holdings emptied (k = 0…12): the camp sits out exactly while 12 stand
//   W4 campChoice never picks a camp that sits out, for 3,000 random province sets (holdings and Free Cities 0…12,
//      camps standing or beaten, fog), and names every nearer camp that sits out
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import * as SH from '../../permutation-server/web/frontier/screens/shell.mjs';
import * as ST from '../../permutation-server/web/frontier/seasonterms.mjs';
import * as FB from '../../permutation-server/web/frontier/hud/firstbattle.mjs';
import * as W from '../../permutation-server/web/frontier/wasm.mjs';
import * as rep from '../../permutation-server/web/frontier/screens/report.mjs';
import { decode } from '../../permutation-server/web/frontier/fcodec.mjs';
import { arrivalStamina, staminaAt, DEPART_STAMINA, ENGAGE_STAMINA, RULES } from '../../permutation-server/web/frontier/fmarch.mjs';

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pick = (r, n) => Math.floor(r() * n);
const TZ = process.env.TZ;
afterEach(() => { setLang('ja'); ST.setTermsPace(() => 1); SH.setChainNow(null); if (TZ === undefined) delete process.env.TZ; else process.env.TZ = TZ; });

// ------------------------------------------------------------------ W1
test('W1 the wall clock said for a chain time: now + left / pace, local, only when it can be said; past → "any moment now"', () => {
  process.env.TZ = 'Asia/Tokyo';
  const r = rng(267);
  const realNow = Date.now;
  let saidWall = 0, saidNone = 0, past = 0;
  try {
    for (let i = 0; i < 4000; i++) {
      const lang = i % 2 ? 'en' : 'ja';
      setLang(lang);
      const pace = [1, 1.04, 30, 60, null][i % 5];
      ST.setTermsPace(() => pace);
      const wallMs = 1_795_000_000_000 + pick(r, 3e10);
      Date.now = () => wallMs;
      const now = 1_800_000_000 + pick(r, 1e8);
      const left = r() < 0.1 ? -pick(r, 5000) : 1 + pick(r, r() < 0.5 ? 600 : 200_000);
      const s = SH.dueText(now + left, now);
      const w = SH.wallOf(now + left, now, wallMs);
      if (left <= 0) { assert.equal(s, lang === 'ja' ? 'まもなく' : 'Any moment now', `${left}`); past++; continue; }
      if (pace === null) { assert.equal(w, null); assert.doesNotMatch(s, /\d\d:\d\d/, `unknown pace: ${s}`); saidNone++; continue; }
      assert.ok(Math.abs(w - (wallMs / 1000 + left / pace)) < 1e-6, 'wallOf = wall now + left / pace');
      const fast = pace > SH.NATURAL_MAX;
      const shown = !fast || left / pace >= 60;
      const hhmm = new Date(w * 1000).toLocaleTimeString(lang === 'en' ? 'en-GB' : 'ja-JP', { hour: '2-digit', minute: '2-digit' });
      if (shown) { assert.ok(s.includes(hhmm), `×${pace} left ${left}: "${s}" says ${hhmm}`); saidWall++; }
      else { assert.doesNotMatch(s, /\d\d:\d\d/, `×${pace} left ${left} (real ${left / pace} s): no clock time in "${s}"`); saidNone++; }
      if (fast) assert.match(s, lang === 'ja' ? /実時間/ : /real time/, `a fast clock says the real length: ${s}`);
      else assert.doesNotMatch(s, lang === 'ja' ? /実時間/ : /real time/, `the natural clock: ${s}`);
      // later chain times never come earlier on the wall
      assert.ok(SH.wallOf(now + left + 1 + pick(r, 1000), now, wallMs) > w);
    }
  } finally { Date.now = realNow; }
  // no chain "now" at all: said so, never a time
  ST.setTermsPace(() => 1);
  setLang('ja');
  assert.equal(SH.dueText(1_800_000_600), '時刻はまだ分かりません');
  assert.ok(saidWall > 1500 && saidNone > 800 && past > 200, `exercised: ${saidWall} with a clock time, ${saidNone} without, ${past} past`);
});

// ------------------------------------------------------------------ W2
/** permutation-rules host.rs `Stamina` (at, spend), ported line by line. */
class Stamina {
  constructor(value, bell) { this.value = value; this.bell = bell; }
  at(b) { if (b <= this.bell) return this.value; return Math.min(RULES.STAMINA_CAP, this.value + (b - this.bell)); }
  spend(b, cost) { const v = this.at(b); if (v < cost) throw new Error('NoStamina'); return new Stamina(v - cost, Math.max(b, this.bell)); }
}

test('W2 arrivalStamina = host.rs Stamina: spend DEPART_STAMINA at depart + 1, refill to the arrival (20,000 departable hosts)', () => {
  const r = rng(74);
  let exhausted = 0, capped = 0;
  for (let i = 0; i < 20_000; i++) {
    const depart = 10 + pick(r, 2000);
    const staminaBell = depart + 1 - (r() < 0.6 ? 0 : pick(r, 300));
    const staminaValue = r() < 0.6 ? DEPART_STAMINA + pick(r, RULES.STAMINA_CAP - DEPART_STAMINA + 1) : pick(r, RULES.STAMINA_CAP + 1);
    const h = { staminaValue, staminaBell };
    if (new Stamina(staminaValue, staminaBell).at(depart + 1) < DEPART_STAMINA) continue; // the chain refuses the Depart
    const arrive = depart + 2 + pick(r, r() < 0.5 ? 20 : 200);
    const want = new Stamina(staminaValue, staminaBell).spend(depart + 1, DEPART_STAMINA).at(arrive);
    assert.equal(arrivalStamina(h, depart, arrive), want, JSON.stringify({ h, depart, arrive }));
    assert.equal(staminaAt(h, depart + 1), new Stamina(staminaValue, staminaBell).at(depart + 1));
    exhausted += want < ENGAGE_STAMINA;
    capped += want === RULES.STAMINA_CAP;
  }
  assert.ok(exhausted > 500 && capped > 500, `exercised: ${exhausted} exhausted arrivals, ${capped} at the cap`);
  assert.equal(DEPART_STAMINA, 74);
  assert.equal(ENGAGE_STAMINA, 20);
});

// ------------------------------------------------------------------ W3
const WASM = new URL('../../permutation-server/web/frontier/wasm/frontier.wasm', import.meta.url);
let kernelPromise = null;
async function realKernel(t) {
  if (!existsSync(WASM)) { t.skip('frontier.wasm is not built'); return null; }
  const bytes = readFileSync(WASM);
  const sha = readFileSync(new URL('frontier.wasm.sha256', WASM), 'utf8').trim().split(/\s+/)[0];
  kernelPromise ??= W.loadKernel({ url: 'x/frontier.wasm', sha256Hex: sha, fetch: async () => ({ ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) }) });
  return kernelPromise;
}
const CM = JSON.parse(readFileSync(new URL('frontier-vectors.json', import.meta.url), 'utf8')).clash_model;
const hex = h => Uint8Array.from(Buffer.from(h, 'hex'));
const SITE_MIRROR = 296, SITE_SIZE = 64; // abi.mjs Province SITE_MIRROR (rec:SiteMirror x12), state at +0
const campInClash = (k, pb, c, pv = decode('Province', pb)) => {
  const r = k.call('resolve_from_inputs', rep.fromInputsRequest({ provinceBytes: pb, inputsBytes: Buffer.from(c.inputs_b64, 'base64'), bell: c.bell, seed: hex(c.seed) }));
  assert.ok(r.ok, JSON.stringify(r));
  const d = rep.decodeClashOut(r.value);
  return d.outcome.garrisons.some(g => String(g.id) === String(rep.campId(pv.camp.gen)));
};

test('W3 campFights = the clash kernel: a camp fights exactly when the kernel puts it in the clash (native vectors, 12 → 0 holdings)', async t => {
  const k = await realKernel(t);
  if (!k) return;
  let certain = 0;
  for (const c of CM.cases) {
    const pb = Buffer.from(c.province_b64, 'base64');
    const pv = decode('Province', pb);
    if (!c.certain) {
      // the day's camp check runs at this bell: a beaten camp can be placed again first (I-56) — the page does not model
      // it and campChoice skips a beaten camp (the careful side): never a camp the guide offers that the kernel leaves out
      assert.equal(FB.campFights(pv), false, `${c.name}: a beaten camp is not offered`);
      continue;
    }
    assert.equal(campInClash(k, pb, c), FB.campFights(pv), `${c.name}: the kernel and campFights`);
    certain++;
  }
  assert.ok(certain >= 3);
  // the 12-holdings vector, k holdings emptied: the camp joins once fewer than 12 stand (MAX_GARRISONS = 12)
  const twelve = CM.cases.find(c => c.name === 'twelve_garrisons_leave_no_camp_slot');
  assert.ok(twelve, 'the native twelve-garrisons vector');
  const base = Buffer.from(twelve.province_b64, 'base64');
  assert.equal(FB.garrisonsIn(decode('Province', base)), 12);
  for (let emptied = 0; emptied <= 12; emptied++) {
    const pb = Buffer.from(base);
    for (let i = 0; i < emptied; i++) pb[SITE_MIRROR + i * SITE_SIZE] = 0; // state 0: no holding
    const pv = decode('Province', pb);
    assert.equal(FB.garrisonsIn(pv), 12 - emptied);
    assert.equal(FB.campFights(pv), emptied > 0, `${12 - emptied} holdings: the page`);
    assert.equal(campInClash(k, pb, twelve), emptied > 0, `${12 - emptied} holdings: the kernel`);
  }
  assert.equal(FB.CAMP_GARRISON_CAP, rep.MAX_GARRISONS);
});

// ------------------------------------------------------------------ W4
test('W4 campChoice never picks a camp that sits out; every nearer camp that sits out is named (3,000 random sets)', () => {
  const r = rng(265);
  let picks = 0, passedSeen = 0, none = 0;
  for (let i = 0; i < 3000; i++) {
    const provinces = new Map();
    for (let n = 1 + pick(r, 6); n > 0; n--) {
      const p = pick(r, 9) - 4, q = pick(r, 9) - 4;
      const holdings = pick(r, 13), free = r() < 0.4 ? pick(r, 13 - holdings) : 0;
      const siteMirror = Array.from({ length: 12 }, (_, s) => ({ state: s < holdings ? 1 : s < holdings + free ? 5 : r() < 0.3 ? oneOf(r, [0, 2, 3, 4]) : 0 }));
      provinces.set(`${p},${q}`, { province: { p, q, siteCount: 12, siteMirror, camp: { state: r() < 0.85 ? 1 : 0, tile: pick(r, 61), troops: 50 + pick(r, 400), gen: 1 } } });
    }
    const FS = { provinces };
    const host = { unit: 0, troops: 100 + pick(r, 600), p: 0, q: 0 };
    const hidden = new Set([...provinces.keys()].filter(() => r() < 0.15));
    const seen = (p, q) => !hidden.has(`${p},${q}`);
    const got = FB.campChoice(FS, host, { seen, rough: () => r() < 0.5 });
    // the rule's own count, not the page's (clash_model.rs v2_garrison_state: a holding or a Free City; MAX_GARRISONS 12)
    const garrisons = pr => pr.siteMirror.slice(0, pr.siteCount).filter(s => s.state === 1 || s.state === 5).length;
    const ruleFights = pr => pr.camp.state === 1 && garrisons(pr) < 12;
    // (fix-camp-reach, Q-PM2-1 (c): a camp beyond a march's reach — more than 3 provinces away, MAX_ROUTE_PROVINCES 4 —
    //  is never picked either; the deliberate change of that PR, so "no pick" now means none in sight, fighting AND in reach)
    const inReach = x => (Math.abs(x.p - host.p) + Math.abs(x.q - host.q) + Math.abs(x.p + x.q - host.p - host.q)) / 2 <= 3;
    const fights = [...provinces.values()].map(e => e.province).filter(pr => seen(pr.p, pr.q) && ruleFights(pr) && inReach(pr));
    if (!got) { assert.equal(fights.length, 0, 'no pick only when no camp in sight and in reach fights'); none++; continue; }
    const pr = provinces.get(`${got.camp.p},${got.camp.q}`).province;
    assert.ok(ruleFights(pr), `the pick fights (${garrisons(pr)} garrisons by the rule)`);
    assert.ok(seen(pr.p, pr.q), 'the pick is in sight');
    assert.ok(inReach(pr), 'the pick is within a march\'s reach');
    const d = x => (Math.abs(x.p) + Math.abs(x.q) + Math.abs(x.p + x.q)) / 2;
    const want = [...provinces.values()].map(e => e.province).filter(x => seen(x.p, x.q) && x.camp.state === 1 && !ruleFights(x) && d(x) < d(pr));
    assert.deepEqual(got.passed.map(x => `${x.p},${x.q}`).sort(), want.map(x => `${x.p},${x.q}`).sort(), 'the nearer camps that sit out');
    for (const x of got.passed) assert.equal(x.garrisons, garrisons(provinces.get(`${x.p},${x.q}`).province));
    picks++; passedSeen += got.passed.length;
  }
  // (fix-camp-reach: picks are now within reach, so fewer nearer sitting-out camps exist: 81 on this seed, was > 200)
  assert.ok(picks > 1500 && passedSeen > 50 && none > 20, `exercised: ${picks} picks, ${passedSeen} camps passed, ${none} none`);
});
const oneOf = (r, a) => a[pick(r, a.length)];
