// ⑦ the first village's place: the candidates read again (Lane C, 2026-11-17). The messages of a failed or empty reading
// of the candidate places said "update the candidates" and no control did it; pressing the confirm button again reads the
// same order again. This bundle adds the person's own re-read — reads only — and makes a candidates reading answer only
// for the world it began under, without putting an older choice back over the one the person picked meanwhile.
// WRITTEN, NOT RUN. KEY-FREE and import-free beyond node:test / node:assert / node:fs: controller.mjs, screens/join.mjs
// and the English dictionary are read as TEXT, not imported (they load fi18n.mjs and lang.mjs, the subjects of refused
// tests). A text check of the connections; it runs no page, herald, world or send.
//   Expected, case by case:
//   H1 the button is offered under a failed / empty reading on both join screens, in play only, and is off while a join /
//      placing or a reading is under way; a reading under way is said as such
//   H2 the action goes to rereadHomes, never to refresh, home-refresh or confirmHome
//   H3 rereadHomes: nothing while a join / placing / reading / order is under way; while the viewer's record fails, the
//      pure read (rereadVillage) first — still failing, or another context meanwhile: it stops and reads no candidates;
//      then the order number moves in memory and refreshHomes reads with force
//   H4 rereadHomes saves nothing on the device, clears no choice, sends nothing
//   H5 a slow answer: refreshHomes writes nothing when a newer reading began or the world changed (good and failed
//      answers alike)
//   H6 a candidate picked on the map while the reading waited is kept if it is among those read; the choice the reading
//      began with is not put back over it
//   H7 a change of world: readings under way answer nothing; the list is let go unless a join / placing is under way,
//      whose "reading" mark alone is taken off
//   H8 what was there is unchanged: home-refresh (still called from nowhere), home-pick, home-confirm, needsHomeChoice
//   H9 English for the new sentences; no banned word
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../../permutation-server/web/${f}`, import.meta.url), 'utf8');
const ctl = read('frontier/controller.mjs'), join = read('frontier/screens/join.mjs'), app = read('frontier/app.mjs'), en = read('lang/en-frontier-play.mjs');
const fnOf = (src, head) => { const at = src.indexOf(head); assert.ok(at >= 0, head); return src.slice(at, src.indexOf('\n}\n', at) + 2); };
const order = (body, ...parts) => { let at = -1; for (const p of parts) { const i = body.indexOf(p, at + 1); assert.ok(i > at, `in order: ${p}`); at = i; } };
const code = body => body.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/**')).join('\n');
const rr = code(fnOf(ctl, 'export async function rereadHomes() {')), rh = fnOf(ctl, 'export async function refreshHomes({ force = false } = {}) {');

test('H1 the button under a failed or empty reading, on both join screens', () => {
  const btn = join.split('\n').find(l => l.startsWith('const homeReread = (FS, busy) =>'));
  assert.ok(btn);
  order(btn, "FS.mode === 'play' ?", 'data-act="home-reread"', "raw(busy || FS.homeChoice?.loading ? 'disabled' : '')", 'L`土地の候補を読み直す`', ": '');");
  const nat = fnOf(join, 'export function renderNations(FS) {');
  order(nat, "const busy = !!FS.homeChoice?.busy || !!FS.homeChoice?.pending || FS.inFlight > 0;",
    'instant && FS.homeChoice?.error ? html`<p class="notice error" role="alert">${FS.homeChoice.error.text ?? failureText(FS.homeChoice.error)}</p>${homeReread(FS, busy)}`',
    'instant && FS.homeChoice?.loading ? html`<p class="muted" role="status" data-homes="loading">${L`土地の候補を読み込んでいます…`}</p>`');
  assert.equal(join.split('${homeReread(FS, busy)}').length - 1, 2, 'the nations screen and the placing screen');
  assert.ok(join.includes('${choice.error ? html`<p class="notice error" role="alert">${choice.error.text ?? failureText(choice.error)}</p>${homeReread(FS, busy)}` : \'\'}'));
  assert.ok(join.includes('${choice.loading ? html`<p class="muted" role="status" data-homes="loading">${L`土地の候補を読み込んでいます…`}</p>` : \'\'}'));
});

test('H2 the action is the pure re-read', () => {
  assert.ok(ctl.includes("  'home-reread': () => { rereadHomes().catch(e => console.error('frontier home reread:', e)); },"));
  assert.equal(ctl.split("'home-reread'").length - 1, 1);
  assert.doesNotMatch(app + join, /data-act="home-refresh"|ACTIONS\['home-refresh'\]/, 'home-refresh stays uncalled');
});

test('H3 rereadHomes: its guards and its order', () => {
  order(rr, "if (!herald || FS.mode !== 'play' || !instantHomeEnabled(FS.season)) return false;", 'const c0 = FS.homeChoice ?? null;',
    "if (c0?.busy || c0?.pending || c0?.loading || FS.inFlight > 0) return 'busy';", 'const ctx = contextSeq;',
    "if (FS.meStatus === 'error') {", 'await rereadVillage();', 'if (ctx !== contextSeq) return false;', "if (FS.meStatus === 'error') { failed({", 'return false; }',
    'if (!needsHomeChoice()) return false;', 'const c = FS.homeChoice ?? null;', "if (c?.busy || c?.pending || c?.loading) return 'busy';",
    'if (c) c.rotation = (c.rotation ?? 0) + 3;', 'await refreshHomes({ force: true });', 'return ctx === contextSeq && !FS.homeChoice?.error;');
  assert.equal(rr.split('await ').length - 1, 2, 'the pure viewer read and the candidates read, nothing else');
});

test('H4 rereadHomes saves nothing, clears no choice, sends nothing', () => {
  assert.doesNotMatch(rr, /\brefresh\(\)|waitForOwn|confirmHome|saveHomePatch|saveHome\(|\.selected = |tx\.|actOnce|localAct|sendOrder|reveal|ticket|prize|faucet|payAndJoin|paidJoin|claim/i);
  const rv = code(fnOf(ctl, 'export async function rereadVillage() {'));
  assert.doesNotMatch(rv, /\brefresh\(\)|tx\.|actOnce|sendOrder/, 'the viewer read it leans on is the pure one');
});

test('H5 a slow answer writes nothing for another reading or another world', () => {
  order(rh, 'const request = ++homesRefresh, world = providerWorld();', 'loading: true, error: null };', 'await refreshOverviews(nowBell());', 'const result = await planHomes({',
    'if (request !== homesRefresh || providerWorld() !== world) return;', 'FS.homeChoice = { ...old, ...result, selected, faction, loadedBell: nowBell(), loading: false,',
    '} catch (e) {', 'if (request !== homesRefresh || providerWorld() !== world) return;', "FS.homeChoice = { ...old, faction, loading: false, error: { code: e?.code ?? 'Unavailable',");
  assert.equal(rh.split('if (request !== homesRefresh || providerWorld() !== world) return;').length - 1, 2);
  assert.doesNotMatch(rh, /if \(request !== homesRefresh\) return;/);
});

test('H6 the choice picked meanwhile is the one weighed', () => {
  order(rh, 'if (request !== homesRefresh || providerWorld() !== world) return;', 'const picked = FS.homeChoice?.selected ?? null;',
    'const selected = picked && (faction === null || picked.faction === faction) && result.candidates.some(h => sameHome(h, picked)) ? picked : faction !== null ? result.candidates[0] ?? null : null;');
  assert.doesNotMatch(rh, /result\.candidates\.some\(h => sameHome\(h, old\.selected\)\)/);
  // (what makes it "the choice in hand": home-pick writes on FS.homeChoice itself)
  assert.ok(ctl.includes('FS.homeChoice.selected = h; FS.homeChoice.error = null; FS.homeFocus = h;'));
  // (unchanged: how candidates are found and ordered)
  assert.ok(rh.includes("seed: `${FS.wallet?.address ?? 'visitor'}|${old.rotation ?? 0}`, rotation: old.rotation ?? 0,"));
  assert.ok(rh.includes('read: async (p, q) => { const env = await loadEnvelope(p, q); return env?.province ?? null; } });'));
});

test('H7 a change of world lets the candidates go', () => {
  const ad = fnOf(ctl, 'export function adoptPinnedWorld() {');
  order(ad, 'if (readsWorld === undefined || readsWorld === world) { readsWorld = world; return false; }', 'FS.incoming = []; FS.incomingRead = null;',
    '++homesRefresh; if (FS.homeChoice) { if (FS.homeChoice.busy) FS.homeChoice.loading = false; else FS.homeChoice = null; }', 'FS.hostPlaces = null;', 'nextContext();');
  assert.doesNotMatch(ad, /saveHomePatch|saveHome\(/, 'what is saved on the device is not touched here');
});

test('H8 what was there is unchanged', () => {
  order(ctl, "  'home-refresh': async () => {", '    if (FS.homeChoice?.busy) return;', "    if (FS.meStatus === 'error') await refresh();",
    '    saveHomePatch({ selected: null }); return refreshHomes({ force: true });', "  'home-confirm': () => confirmHome(),");
  const nh = fnOf(ctl, 'function needsHomeChoice() {');
  order(nh, "if (!instantHomeEnabled(FS.season) || FS.holdings?.length || FS.meStatus === 'error') return false;", 'if (!FS.citizen) return true;',
    "return FS.land?.stage === 'joined' && !(FS.citizen.flags & (HOME_GRANTED | 4 | 16));");
  assert.ok(ctl.includes('if (!h || FS.homeChoice.busy) return;'));
  assert.ok(ctl.includes('if (old.busy || (!force && ((old.loading && old.faction === faction) || (old.loadedBell === nowBell() && old.faction === faction)))) return;'));
});

test('H9 English follows; no banned word', () => {
  for (const k of ['土地の候補を読み直す', '土地の候補を読み込んでいます…', 'あなたの記録をまだ読めていないので、土地の候補を読み直せませんでした。少し待って、もう一度お試しください。']) {
    const line = en.split('\n').find(l => l.startsWith(`  '${k}':`));
    assert.ok(line, k);
    assert.doesNotMatch(line.split("': ")[1], /\b(settle[ds]?|settling|keeper|beacon|seed)\b/i);
  }
});
