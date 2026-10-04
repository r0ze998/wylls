// The optional seeded seat move (contract 9.2; unit AC9). Local test chain only.
//
// "In a run whose commitments name a seat script (seat_script_sha256), the seat may make ONE scripted hostile move against an AI's
// open-field army (a normal player march through the normal relay; no kernel, program or result is touched; the script is recorded
// in AI_DIR/seat-script.json). It gives that AI a real attacked_own episode and a grievance. The page captions it 'seeded by the
// operator seat'; it is never described as natural, and any claim that rests on it says so."
//
// WHAT IS BUILT HERE (designed and unit-tested, NOT run on a stack): the pure parts. (1) `selectTarget` picks the target from public
// data: an army of an AI of ANOTHER nation, standing on a NON-SITE tile, resident, that cannot leave before the seat's army arrives
// (its stamina is below the 74 a march costs until some bell: it is the one target the AI cannot dodge by the rules, so the clash does
// not become a "collision", contract 6.4); (2) `buildScript` makes the script file whose sha256 the registrar commits
// (`--seat-script FILE`, which also marks the seat "scripted" in the roster); (3) `writeScript` records it as AI_DIR/seat-script.json;
// (4) `executeScript` calls ONE injected `send(move)`.
// WHAT IS NOT BUILT: the sender. Sending a normal march from Node means the web client's flow (permutation-server/web/frontier/fmarch.mjs
// `sendMarch` with the wasm kernel for `plan_path`, the seal worker, the season beacon key, the relay and the seat's session key from
// KEYS/seat.txt). That wiring is a read-only import of web modules and could not be verified without a live stack, so it is the
// integrator's step (named in AC9-NOTES.md); `executeScript` refuses to run without a `send`.
//
// WHAT THE MOVE DOES AND DOES NOT GIVE. A hostile act H(A -> B) needs B's army on the tile at A's DEPARTURE bell and a clash that lists
// A's army engaged (6.4); the `attacked_own` episode needs B's own troops lost > 0. The stamina rule makes "B's army is still there"
// near certain; it does not make "B loses troops" certain (the kernel decides; a bounced or retreating fight may cost B nothing). If no
// episode appears the run says so; nothing is staged by writing a result.
//
//   node citizens/scenario/seat-script.mjs plan   --armies F --seat F --bell N [--roster F] [--write AI_DIR] [--min-troops 150]
//   node citizens/scenario/seat-script.mjs verify --script F [--commitments F]
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCRIPT_VERSION = 1;
export const DEPART_STAMINA = 74; // 10 + 2 x 32 (travel::march_stamina(MAX_PATH_STEPS))
export const STAMINA_CAP = 120;
export const MAX_PROVINCES = 4;
export const MILLI = 1000;
export const CAPTION = Object.freeze({ en: 'seeded by the operator seat', ja: '運営の席が仕込んだもの' });
export const NEVER_NATURAL = 'This move is scripted by the operator seat. It is never described as natural, and any claim that rests on it says so.';

const sha256 = (x) => createHash('sha256').update(x).digest('hex');
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
/** The bell from which a resident host can depart again: ready bell and stamina (value + 1 per bell, cap 120) of at least 74. */
export function departableFromBell(h) {
  const need = Math.max(0, DEPART_STAMINA - (h.stamina ?? 0));
  return Math.max(h.ready_bell ?? 0, (h.stamina_bell ?? 0) + need);
}
export const provinceDistance = (a, b) => (Math.abs(a.p - b.p) + Math.abs(a.q - b.q) + Math.abs(a.p + a.q - b.p - b.q)) / 2;

/**
 * Armies from shaped provinces (watcher/feed.mjs `shapeProvince` output): every resident host with its tile, owner and stamina, and
 * whether the tile is a site tile (a village stands there). `roster` = roster.json (AI tags, factions).
 */
export function armiesFromProvinces(provinces, roster) {
  const ai = new Map((roster?.ai ?? []).map((a) => [a.tag, a]));
  const out = [];
  for (const pv of provinces ?? []) {
    const siteTiles = new Set((pv.sites ?? []).filter((s) => s.state !== 0).map((s) => s.tile));
    for (const h of pv.hosts ?? []) {
      if (h.state !== 1) continue;
      out.push({ host_id: String(h.id), tag: h.owner ?? null, ai: h.owner != null && ai.has(h.owner), faction: h.faction, p: pv.p, q: pv.q, tile: h.tile, on_site_tile: siteTiles.has(h.tile), troops: Math.floor((h.troops ?? 0) / MILLI), stamina: h.stamina, stamina_bell: h.stamina_bell, ready_bell: h.ready_bell, unit: h.unit ?? null, bell: pv.bell });
    }
  }
  return out;
}

/**
 * selectTarget({armies, seat: {faction, hosts: [{host_id, p, q, tile, troops, stamina, stamina_bell, ready_bell}]}, bell, minTroops, minSeatTroops})
 *  -> {plan | null, considered, rejected: [{host_id, reason}]}. Pure and deterministic: the nearest target, then the smallest, then the lowest host id.
 * `bell` is the bell at which the script is planned; the plan's departure is no earlier than bell + 1.
 */
export function selectTarget({ armies, seat, bell, minTroops = 150, minSeatTroops = 100 }) {
  const rejected = [];
  const seatHosts = (seat?.hosts ?? []).filter((h) => (h.troops ?? 0) >= minSeatTroops && departableFromBell(h) <= bell + 1);
  if (!seatHosts.length) return { plan: null, considered: 0, rejected: [{ host_id: null, reason: 'the seat has no ready host of at least ' + minSeatTroops + ' troops' }] };
  const options = [];
  for (const a of armies ?? []) {
    const why = [];
    if (!a.ai) why.push('not an AI citizen of the roster');
    if (a.faction === seat.faction) why.push('the seat\'s own nation');
    if (a.on_site_tile) why.push('on a site tile (a village stands there)');
    if ((a.troops ?? 0) < minTroops) why.push(`under ${minTroops} troops`);
    if (why.length) { rejected.push({ host_id: a.host_id, reason: why.join('; ') }); continue; }
    const leaves = departableFromBell(a);
    const best = seatHosts
      .map((h) => ({ h, d: provinceDistance(h, a) }))
      .filter((x) => x.d <= MAX_PROVINCES - 1)
      .sort((x, y) => x.d - y.d || y.h.troops - x.h.troops || (x.h.host_id < y.h.host_id ? -1 : 1))[0];
    if (!best) { rejected.push({ host_id: a.host_id, reason: `farther than ${MAX_PROVINCES - 1} provinces from every ready seat host` }); continue; }
    // the march arrives at least 2 bells after it leaves; it must arrive BEFORE the target could depart
    const arriveBy = leaves - 1;
    if (arriveBy < bell + 3) { rejected.push({ host_id: a.host_id, reason: `could depart from bell ${leaves}: no arrival before it (earliest arrival ${bell + 3})` }); continue; }
    options.push({ a, seat: best.h, d: best.d, leaves, arriveBy });
  }
  options.sort((x, y) => x.d - y.d || x.a.troops - y.a.troops || (x.a.host_id < y.a.host_id ? -1 : 1));
  const o = options[0];
  if (!o) return { plan: null, considered: armies?.length ?? 0, rejected };
  return {
    considered: armies?.length ?? 0,
    rejected,
    plan: {
      target: { host_id: o.a.host_id, tag: o.a.tag, faction: o.a.faction, p: o.a.p, q: o.a.q, tile: o.a.tile, troops: o.a.troops, can_depart_from_bell: o.leaves },
      seat_host: { host_id: o.seat.host_id, p: o.seat.p, q: o.seat.q, tile: o.seat.tile, troops: o.seat.troops },
      distance_provinces: o.d,
      depart_not_before_bell: bell + 1,
      arrive_by_bell: o.arriveBy,
      stance: 'assault',
      retreat_bps: 0,
      conditions_for_an_episode: [
        'the target army is still on its tile at the seat host\'s departure bell (the stamina rule keeps it there)',
        'the clash lists the seat host with engaged: true',
        'the target loses troops (the kernel decides; a bounced or retreating fight can cost it nothing)',
      ],
    },
  };
}

/** The script file: deterministic from the plan. Its sha256 is what the commitments name (`--seat-script`). */
export function buildScript({ plan, runId = null, note = null }) {
  return {
    v: SCRIPT_VERSION, kind: 'seat-script', seeded_by: 'operator seat', run_id: runId,
    caption: { ...CAPTION }, not_natural: true, never_natural: NEVER_NATURAL,
    rules: 'a normal player march through the normal relay with the seat\'s own session key; no kernel, program or result is touched; ONE move',
    note,
    moves: [{ id: 'm1', type: 'hostile_march', window: { not_before_bell: plan.depart_not_before_bell, arrive_by_bell: plan.arrive_by_bell }, seat_host: plan.seat_host, target: plan.target, stance: plan.stance, retreat_bps: plan.retreat_bps, conditions_for_an_episode: plan.conditions_for_an_episode }],
    executed: null,
  };
}
export const scriptText = (script) => `${canonicalJson(script)}\n`;
export const scriptSha256 = (script) => sha256(scriptText(script));

export function validateScript(s) {
  const errors = [];
  const bad = (m) => errors.push(m);
  if (!s || typeof s !== 'object') return { ok: false, errors: ['not an object'] };
  if (s.v !== SCRIPT_VERSION) bad('v must be 1');
  if (s.kind !== 'seat-script') bad('kind must be "seat-script"');
  if (s.seeded_by !== 'operator seat') bad('seeded_by must be "operator seat"');
  if (s.not_natural !== true) bad('not_natural must be true (the move is never described as natural)');
  if (s.caption?.en !== CAPTION.en || s.caption?.ja !== CAPTION.ja) bad('the caption must be the pinned one');
  if (!Array.isArray(s.moves) || s.moves.length !== 1) bad('exactly one move');
  else {
    const m = s.moves[0];
    if (m.type !== 'hostile_march') bad('the move must be a hostile_march (a normal player march)');
    if (!m.seat_host?.host_id || !m.target?.host_id) bad('seat_host and target need host ids');
    if (!Number.isInteger(m.window?.not_before_bell) || !Number.isInteger(m.window?.arrive_by_bell) || m.window.arrive_by_bell < m.window.not_before_bell + 2) bad('window: a march arrives at least 2 bells after it leaves');
    if (m.target && m.seat_host && m.target.p === m.seat_host.p && m.target.q === m.seat_host.q && m.target.tile === m.seat_host.tile) bad('the target is on the seat host\'s own tile');
  }
  for (const k of Object.keys(s)) if (/key|secret|seed(?!ed_by)|salt/i.test(k) && k !== 'seeded_by') bad(`field ${k}: no key material in a script`);
  return { ok: errors.length === 0, errors };
}

export function writeScript(aiDir, script) {
  const v = validateScript(script);
  if (!v.ok) throw new Error(`seat script invalid: ${v.errors.join('; ')}`);
  const file = path.join(aiDir, 'seat-script.json');
  fs.mkdirSync(aiDir, { recursive: true });
  const text = scriptText(script);
  fs.writeFileSync(file, text);
  return { file, sha256: sha256(text) };
}

/** What the page and the notes may say about a run that used the script. */
export function claimWording({ executed, episodeSeen }) {
  if (!executed) return 'a seat script was committed; its move was not executed in this run';
  if (!episodeSeen) return `the operator seat made a scripted march at an AI army (${CAPTION.en}); no attacked_own episode followed`;
  return `the operator seat made a scripted march at an AI army (${CAPTION.en}); the AI then had an attacked_own episode and a grievance. This is a seeded event, not a natural one`;
}

/**
 * Execute the script: ONE call of `send(move)` (the integrator's sender, see the header). `getBell()` gives the current bell; the move is
 * refused outside its window. The result is recorded in AI_DIR/seat-script.json (`executed`). Never retries, never sends a second move.
 */
export async function executeScript({ aiDir, script, send, getBell, now = () => Date.now() }) {
  if (typeof send !== 'function') throw new Error('seat script: no sender wired (the web march flow is the integrator\'s step); nothing was sent');
  const v = validateScript(script);
  if (!v.ok) throw new Error(`seat script invalid: ${v.errors.join('; ')}`);
  if (script.executed) return { ok: false, code: 'AlreadyExecuted', executed: script.executed };
  const move = script.moves[0];
  const bell = await getBell();
  if (bell == null || bell < move.window.not_before_bell) return { ok: false, code: 'TooEarly', bell };
  if (bell > move.window.arrive_by_bell - 2) return { ok: false, code: 'TooLate', bell, note: 'a march arrives at least 2 bells after it leaves, and the target may be able to leave by then' };
  const r = await send({ ...move, bell });
  script.executed = { at_bell: bell, unix_ms: now(), ok: Boolean(r?.ok), signature: r?.signature ?? null, error: r?.ok ? null : (r?.error ?? r?.code ?? 'failed') };
  fs.writeFileSync(path.join(aiDir, 'seat-script.json'), scriptText(script));
  return { ok: Boolean(r?.ok), executed: script.executed };
}

function isMain() {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (isMain()) {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = {};
  for (let i = 0; i < rest.length; i++) if (rest[i].startsWith('--')) a[rest[i].slice(2)] = rest[++i];
  const readJson = (f) => JSON.parse(fs.readFileSync(path.resolve(f), 'utf8'));
  if (cmd === 'plan') {
    for (const k of ['armies', 'seat', 'bell']) if (!a[k]) { console.error(`plan: --${k} is required`); process.exit(2); }
    const roster = a.roster ? readJson(a.roster) : null;
    const armies = readJson(a.armies);
    const sel = selectTarget({ armies: roster && !armies[0]?.ai ? armiesFromProvinces(armies, roster) : armies, seat: readJson(a.seat), bell: Number(a.bell), minTroops: Number(a['min-troops'] ?? 150) });
    const out = { plan: sel.plan, considered: sel.considered, rejected: sel.rejected };
    if (sel.plan && a.write) { const s = buildScript({ plan: sel.plan }); out.written = writeScript(path.resolve(a.write), s); }
    console.log(JSON.stringify(out, null, 2));
    process.exit(sel.plan ? 0 : 1);
  } else if (cmd === 'verify') {
    if (!a.script) { console.error('verify: --script F'); process.exit(2); }
    const s = readJson(a.script);
    const v = validateScript(s);
    const out = { ok: v.ok, errors: v.errors, sha256: sha256(fs.readFileSync(path.resolve(a.script))), canonical_sha256: scriptSha256(s) };
    if (a.commitments) out.matches_commitments = readJson(a.commitments)?.configs?.seat_script_sha256 === out.sha256;
    console.log(JSON.stringify(out, null, 2));
    process.exit(v.ok ? 0 : 1);
  } else { console.error('usage: seat-script.mjs plan|verify (see the header)'); process.exit(2); }
}
