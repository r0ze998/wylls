// AC9: the optional seeded seat move (contract 9.2). The planner, the script file and its hash, the validator, the one-shot executor
// with an INJECTED sender (no real sender exists: it is the integrator's step), the pinned wording. The armies below are SYNTHETIC
// shaped-province data (the same fields watcher/feed.mjs shapeProvince gives); no stack, no chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CAPTION, DEPART_STAMINA, armiesFromProvinces, buildScript, claimWording, departableFromBell, executeScript, provinceDistance, scriptSha256, scriptText, selectTarget, validateScript, writeScript,
} from '../citizens/scenario/seat-script.mjs';

const roster = { ai: [{ tag: 'a'.repeat(16), faction: 1 }, { tag: 'b'.repeat(16), faction: 2 }] };
const host = (over = {}) => ({ id: '1001', owner: 'a'.repeat(16), faction: 1, unit: 0, tile: 20, state: 1, troops: 300_000, stamina: 20, stamina_bell: 100, ready_bell: 90, ...over });
const province = (over = {}) => ({ p: 1, q: 1, bell: 100, sites: [{ site: 0, tile: 5, state: 1 }], hosts: [host()], ...over });
const seat = (over = {}) => ({ faction: 0, hosts: [{ host_id: '9001', p: 0, q: 0, tile: 3, troops: 400, stamina: 120, stamina_bell: 100, ready_bell: 0 }], ...over });

test('departableFromBell: the bell from which a resident host can leave again (stamina 74 and the ready bell)', () => {
  assert.equal(DEPART_STAMINA, 74);
  assert.equal(departableFromBell({ stamina: 20, stamina_bell: 100, ready_bell: 90 }), 154, '20 + 54 bells = 74');
  assert.equal(departableFromBell({ stamina: 120, stamina_bell: 100, ready_bell: 90 }), 100, 'already enough stamina');
  assert.equal(departableFromBell({ stamina: 120, stamina_bell: 100, ready_bell: 130 }), 130, 'a cooldown holds it');
  assert.equal(provinceDistance({ p: 0, q: 0 }, { p: 1, q: 1 }), 2);
  assert.equal(provinceDistance({ p: 0, q: 0 }, { p: 1, q: 0 }), 1);
});

test('armiesFromProvinces: resident hosts only, with their tile, owner, whether the tile is a site tile, troops in whole units', () => {
  const pv = province({ hosts: [host(), host({ id: '1002', state: 2 }), host({ id: '1003', tile: 5, owner: 'b'.repeat(16), faction: 2 })] });
  const a = armiesFromProvinces([pv], roster);
  assert.deepEqual(a.map((x) => [x.host_id, x.on_site_tile, x.ai, x.troops]), [['1001', false, true, 300], ['1003', true, true, 300]]);
  assert.equal(armiesFromProvinces([province({ hosts: [host({ owner: 'c'.repeat(16) })] })], roster)[0].ai, false, 'an owner outside the roster is not an AI');
});

test('selectTarget: an open-field army of another nation that cannot leave before the arrival, nearest first; every rejection says why', () => {
  const armies = armiesFromProvinces([
    province({ p: 1, q: 1, hosts: [host({ id: '1', stamina: 20 })] }), // can depart from bell 154: arrive by 153; nearest? distance 2
    province({ p: 0, q: 1, hosts: [host({ id: '2', stamina: 20, owner: 'b'.repeat(16), faction: 2 })], sites: [] }), // distance 1: nearer
    province({ p: 0, q: 1, hosts: [host({ id: '3', tile: 5 })], sites: [{ site: 0, tile: 5, state: 1 }] }), // on a site tile
    province({ p: 1, q: 0, hosts: [host({ id: '4', faction: 0 })] }), // the seat's own nation
    province({ p: 1, q: 0, hosts: [host({ id: '5', troops: 100_000 })] }), // 100 troops < 150
    province({ p: 3, q: 3, hosts: [host({ id: '6' })] }), // far
    province({ p: 0, q: 1, hosts: [host({ id: '7', stamina: 120, stamina_bell: 100, ready_bell: 0 })] }), // can leave at once
    province({ p: 0, q: 1, hosts: [host({ id: '8', owner: 'c'.repeat(16) })] }), // not an AI
  ], roster);
  const r = selectTarget({ armies, seat: seat(), bell: 100 });
  assert.equal(r.plan.target.host_id, '2');
  assert.equal(r.plan.target.can_depart_from_bell, 154);
  assert.equal(r.plan.arrive_by_bell, 153, 'it must arrive before the target could leave');
  assert.equal(r.plan.depart_not_before_bell, 101);
  assert.equal(r.plan.seat_host.host_id, '9001');
  assert.equal(r.plan.distance_provinces, 1);
  const why = Object.fromEntries(r.rejected.map((x) => [x.host_id, x.reason]));
  assert.match(why['3'], /site tile/);
  assert.match(why['4'], /own nation/);
  assert.match(why['5'], /under 150 troops/);
  assert.match(why['6'], /farther than/);
  assert.match(why['7'], /could depart from bell 100/);
  assert.match(why['8'], /not an AI citizen/);
  // deterministic: the same input twice gives the same plan; the lowest host id breaks a tie
  assert.deepEqual(selectTarget({ armies, seat: seat(), bell: 100 }), r);
  assert.equal(selectTarget({ armies: armies.filter((a) => a.host_id === '1' || a.host_id === '2').map((a) => ({ ...a, p: 1, q: 0 })), seat: seat(), bell: 100 }).plan.target.host_id, '1', 'same distance: the smaller army first, then the lower id');
});

test('selectTarget: no plan when the seat has no ready host or no target qualifies', () => {
  assert.equal(selectTarget({ armies: [], seat: seat({ hosts: [{ host_id: '9', p: 0, q: 0, tile: 1, troops: 50, stamina: 120, stamina_bell: 0, ready_bell: 0 }] }), bell: 100 }).plan, null);
  assert.match(selectTarget({ armies: [], seat: seat({ hosts: [] }), bell: 100 }).rejected[0].reason, /no ready host/);
  assert.equal(selectTarget({ armies: [], seat: seat(), bell: 100 }).plan, null);
  // a target that can leave in 2 bells cannot be reached in time (the earliest arrival is bell + 3)
  const a = armiesFromProvinces([province({ hosts: [host({ stamina: 72, stamina_bell: 100 })] })], roster);
  const r = selectTarget({ armies: a, seat: seat(), bell: 100 });
  assert.equal(r.plan, null);
  assert.match(r.rejected[0].reason, /no arrival before it/);
});

function plan() {
  return selectTarget({ armies: armiesFromProvinces([province({ sites: [] })], roster), seat: seat(), bell: 100 }).plan;
}

test('the script: deterministic, caption and "never natural" pinned, one move, hash = sha256 of the file bytes the registrar commits; the roster marks the seat scripted by that hash', () => {
  const s = buildScript({ plan: plan(), runId: 'r1' });
  assert.deepEqual(validateScript(s), { ok: true, errors: [] });
  assert.deepEqual(s.caption, CAPTION);
  assert.equal(s.not_natural, true);
  assert.match(s.never_natural, /never described as natural/);
  assert.equal(s.moves.length, 1);
  assert.equal(s.moves[0].type, 'hostile_march');
  assert.equal(s.executed, null);
  assert.equal(scriptText(s), scriptText(JSON.parse(scriptText(s))), 'canonical text is stable under a round trip');
  const dir = mkdtempSync(join(tmpdir(), 'ai-seat-'));
  const w = writeScript(dir, s);
  assert.equal(w.file, join(dir, 'seat-script.json'));
  assert.equal(w.sha256, createHash('sha256').update(readFileSync(w.file)).digest('hex'));
  assert.equal(w.sha256, scriptSha256(s));
  assert.equal(JSON.stringify(s).includes('session_keypair'), false);
});

test('validateScript refuses every change that would make the move look natural, a second move, a bad window, or key material', () => {
  const good = () => JSON.parse(JSON.stringify(buildScript({ plan: plan() })));
  const bad = (f) => { const s = good(); f(s); return validateScript(s); };
  assert.equal(bad((s) => { s.not_natural = false; }).ok, false);
  assert.equal(bad((s) => { s.caption.en = 'a natural clash'; }).ok, false);
  assert.equal(bad((s) => { s.seeded_by = 'nobody'; }).ok, false);
  assert.equal(bad((s) => { s.moves.push(s.moves[0]); }).ok, false);
  assert.equal(bad((s) => { s.moves = []; }).ok, false);
  assert.equal(bad((s) => { s.moves[0].type = 'sneak'; }).ok, false);
  assert.equal(bad((s) => { s.moves[0].window.arrive_by_bell = s.moves[0].window.not_before_bell + 1; }).ok, false);
  assert.equal(bad((s) => { s.session_keypair_b58 = 'x'; }).ok, false);
  assert.equal(bad((s) => { s.v = 2; }).ok, false);
  assert.throws(() => writeScript(mkdtempSync(join(tmpdir(), 'ai-seat-')), { ...good(), not_natural: false }), /invalid/);
});

test('executeScript: one injected send, inside the window, recorded; refused without a sender, too early, too late, or twice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-seat-'));
  const s = buildScript({ plan: plan() });
  writeScript(dir, s);
  await assert.rejects(() => executeScript({ aiDir: dir, script: s, getBell: async () => 105 }), /no sender wired/);
  const sent = [];
  const send = async (m) => { sent.push(m); return { ok: true, signature: 'sig1' }; };
  assert.equal((await executeScript({ aiDir: dir, script: s, send, getBell: async () => 100 })).code, 'TooEarly');
  assert.equal((await executeScript({ aiDir: dir, script: s, send, getBell: async () => 152 })).code, 'TooLate', 'arrive_by 153 minus 2 bells of travel');
  assert.equal(sent.length, 0);
  const r = await executeScript({ aiDir: dir, script: s, send, getBell: async () => 105, now: () => 1234 });
  assert.equal(r.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'hostile_march');
  assert.equal(sent[0].bell, 105);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'seat-script.json'), 'utf8')).executed, { at_bell: 105, unix_ms: 1234, ok: true, signature: 'sig1', error: null });
  assert.equal((await executeScript({ aiDir: dir, script: s, send, getBell: async () => 106 })).code, 'AlreadyExecuted');
  assert.equal(sent.length, 1, 'never a second move');
  // a failed send is recorded as failed, and the script is then spent as well
  const s2 = buildScript({ plan: plan() });
  const r2 = await executeScript({ aiDir: dir, script: s2, send: async () => ({ ok: false, code: 'Cooldown' }), getBell: async () => 105 });
  assert.equal(r2.ok, false);
  assert.equal(r2.executed.error, 'Cooldown');
});

test('the wording: seeded, never natural, and honest when no episode followed', () => {
  assert.match(claimWording({ executed: null }), /not executed/);
  assert.match(claimWording({ executed: {}, episodeSeen: false }), /no attacked_own episode followed/);
  const w = claimWording({ executed: {}, episodeSeen: true });
  assert.match(w, /seeded event, not a natural one/);
  assert.ok(w.includes(CAPTION.en));
});

test('CLI: plan writes the script when a target exists and exits 1 with the rejections when none does; verify checks the hash against the commitments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-seat-cli-'));
  const armies = armiesFromProvinces([province({ sites: [] })], roster);
  writeFileSync(join(dir, 'armies.json'), JSON.stringify(armies));
  writeFileSync(join(dir, 'seat.json'), JSON.stringify(seat()));
  const cli = new URL('../citizens/scenario/seat-script.mjs', import.meta.url).pathname;
  const r = spawnSync(process.execPath, [cli, 'plan', '--armies', join(dir, 'armies.json'), '--seat', join(dir, 'seat.json'), '--bell', '100', '--write', join(dir, 'out')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.plan.target.host_id, '1001');
  const file = out.written.file;
  writeFileSync(join(dir, 'commit.json'), JSON.stringify({ configs: { seat_script_sha256: out.written.sha256 } }));
  const v = spawnSync(process.execPath, [cli, 'verify', '--script', file, '--commitments', join(dir, 'commit.json')], { encoding: 'utf8' });
  assert.equal(v.status, 0, v.stderr);
  assert.equal(JSON.parse(v.stdout).matches_commitments, true);
  writeFileSync(join(dir, 'commit.json'), JSON.stringify({ configs: { seat_script_sha256: 'f'.repeat(64) } }));
  assert.equal(JSON.parse(spawnSync(process.execPath, [cli, 'verify', '--script', file, '--commitments', join(dir, 'commit.json')], { encoding: 'utf8' }).stdout).matches_commitments, false);
  writeFileSync(join(dir, 'armies.json'), JSON.stringify([]));
  const none = spawnSync(process.execPath, [cli, 'plan', '--armies', join(dir, 'armies.json'), '--seat', join(dir, 'seat.json'), '--bell', '100'], { encoding: 'utf8' });
  assert.equal(none.status, 1);
  assert.equal(JSON.parse(none.stdout).plan, null);
});
